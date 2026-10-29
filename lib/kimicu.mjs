/**
 * lib/kimicu.mjs —— KimiCU native Agent 管道客户端
 * ============================================================================
 * 与 Kimi Code 的 kimi-cu-win 插件等价，但**不经过 node-repl.exe 的 JS cell**，
 * 直接在 Host 进程里说管道协议。本机 0.3.10 实测：
 *
 *   管道：\\.\pipe\kimi-cu-win-<USER>（可由 KIMI_CU_WIN_AGENT_PIPE 覆盖）
 *   帧：  8 字节小端 uint64 长度 + UTF-8 JSON
 *   方法：__agent_ping
 *         __lifecycle_v1 {action:"begin"|"end", nonce}
 *         __computer_use_call_v1 {method, arguments} + lifecycle:{nonce}
 *   请求：{id, session_id, method, params, telemetry_tool?, lifecycle?}
 *   响应：{id, ok, result?, error_code?, error?}
 *
 * 租约语义（实测出来的，写错就会失败）：
 *   - 每个 CU 调用必须带 lifecycle.nonce；
 *   - begin 与 end 必须**在同一条连接**上、session_id 与 nonce 都要对上，
 *     否则 Agent 回 "Agent lifecycle end does not match its begin"；
 *   - 没有 active 租约时调用回 "Agent lifecycle lease is not active"。
 * 所以这里每次工具调用 = 一次租约：begin → N 次调用 → end（finally 保证）。
 * 全局串行，避免两条输入流抢真实鼠标键盘。
 * ============================================================================
 */
import { formatNextActions } from './next-actions.mjs'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { KimiError, CODES, errText } from './errors.mjs'
import { t } from './i18n.mjs'

const execFileAsync = promisify(execFile)

const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MIN_RUNTIME = [0, 3, 0]

/** CU 允许的方法（与 kimi-cu-win 0.3.10 的 trusted-service schema 对齐）。 */
export const CU_METHODS = Object.freeze([
  'open_panel',
  'list_windows',
  'get_window',
  'list_apps',
  'list_available_apps',
  'launch_app',
  'get_window_state',
  'click',
  'press_key',
  'type_text',
  'scroll',
  'set_value',
  'drag',
  'drag_path',
  'perform_secondary_action',
  'activate_window',
])

/** 各方法的允许参数（未知字段会让 Agent 直接拒绝，所以提前挡掉）。 */
export const CU_METHOD_ARGS = Object.freeze({
  open_panel: [],
  list_windows: [],
  get_window: ['id', 'app'],
  list_apps: [],
  list_available_apps: [],
  launch_app: ['app'],
  get_window_state: ['window', 'include_screenshot', 'include_text'],
  click: ['window', 'click_count', 'element_index', 'mouse_button', 'screenshotId', 'timing', 'x', 'y'],
  press_key: ['window', 'key'],
  type_text: ['window', 'text'],
  scroll: ['window', 'screenshotId', 'scrollX', 'scrollY', 'x', 'y'],
  set_value: ['window', 'element_index', 'value'],
  drag: ['window', 'screenshotId', 'from_x', 'from_y', 'to_x', 'to_y', 'timing'],
  drag_path: ['window', 'screenshotId', 'points', 'timing'],
  perform_secondary_action: ['window', 'element_index', 'action'],
  activate_window: ['window'],
})

/** 进程内状态：解析出的 exe / 管道 / 版本。 */
const state = {
  exe: '',
  pipe: '',
  runtimeVersion: '',
  permissions: null,
  agentPid: null,
}

/** 仅供测试/排障：清缓存。 */
export function resetState() {
  state.exe = ''
  state.pipe = ''
  state.runtimeVersion = ''
  state.permissions = null
  state.agentPid = null
}

/** 平台闸门：KimiCU 只有 Windows 版。 */
export function assertPlatform() {
  if (process.platform !== 'win32') {
    throw new KimiError(CODES.UNSUPPORTED_PLATFORM, t('err.unsupportedPlatform') + "\n" + formatNextActions("KIMI_UNSUPPORTED_PLATFORM"))
  }
}

/**
 * 解析 kimi-cu.exe：配置 > 环境变量 > %LOCALAPPDATA%\Kimi Computer Use > 旧 %LOCALAPPDATA%\KimiCU。
 * @param {object} config
 */
export async function resolveExe(config, env = process.env) {
  if (state.exe) return state.exe
  const candidates = []
  if (config?.kimicuExePath) candidates.push(config.kimicuExePath)
  if (env.KIMI_CU_WINDOWS_EXE) candidates.push(env.KIMI_CU_WINDOWS_EXE)
  if (env.KIMI_CU_WINDOWS_HOME) candidates.push(join(env.KIMI_CU_WINDOWS_HOME, 'kimi-cu.exe'))
  const localAppData = env.LOCALAPPDATA || ''
  if (localAppData) {
    candidates.push(join(localAppData, 'Kimi Computer Use', 'kimi-cu.exe'))
    candidates.push(join(localAppData, 'KimiCU', 'kimi-cu.exe'))
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK)
      state.exe = candidate
      return candidate
    } catch {
      /* 试下一个 */
    }
  }
  throw new KimiError(CODES.CU_NOT_INSTALLED, t('err.cuNotInstalled', { candidates: candidates.join(', ') || t('err.noCandidates') }) + "\n" + formatNextActions("KIMI_CU_NOT_INSTALLED"))
}

/** 把窗口清单压成一行，用于「没找到 / 匹配到多个」的报错。 */
function describeWindowList(list) {
  const shown = list.slice(0, 15).map((item) => `"${item.title}"(id=${item.id})`)
  return shown.join(', ') || t('err.noCandidates')
}

/** 默认管道名（与 kimi-cu-win 的 agent-readiness.mjs 一致）。 */
export function defaultPipePath(env = process.env) {
  if (env.KIMI_CU_WIN_AGENT_PIPE?.trim()) return env.KIMI_CU_WIN_AGENT_PIPE
  const user = [...(env.USERNAME ?? env.USER ?? 'user')]
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : '_'))
    .join('')
  return `\\\\.\\pipe\\kimi-cu-win-${user}`
}

/** 8 字节小端长度头 + UTF-8 JSON。 */
export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.length > MAX_FRAME_BYTES) {
    throw new KimiError(CODES.CU_PROTOCOL, t('err.frameTooLarge', { size: payload.length, max: MAX_FRAME_BYTES }))
  }
  const header = Buffer.alloc(8)
  header.writeBigUInt64LE(BigInt(payload.length))
  return Buffer.concat([header, payload])
}

/** 一个连接的帧解码器：分片累积、拒绝尾随字节。 */
export class FrameReader {
  #header = Buffer.alloc(8)
  #headerBytes = 0
  #expected = null
  #chunks = []
  #payloadBytes = 0
  done = false

  /** @returns {any|null} 完整的一帧 JSON，或 null（还没收全） */
  push(chunk) {
    if (this.done) {
      throw new KimiError(CODES.CU_PROTOCOL, t('err.trailingData'))
    }
    let offset = 0
    if (this.#expected === null) {
      const take = Math.min(8 - this.#headerBytes, chunk.length)
      chunk.copy(this.#header, this.#headerBytes, 0, take)
      this.#headerBytes += take
      offset = take
      if (this.#headerBytes < 8) return null
      const length = Number(this.#header.readBigUInt64LE(0))
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
        throw new KimiError(CODES.CU_PROTOCOL, t('err.badFrameLength', { length }))
      }
      this.#expected = length
    }
    const rest = chunk.length - offset
    if (this.#payloadBytes + rest > this.#expected) {
      throw new KimiError(CODES.CU_PROTOCOL, t('err.trailingBytes'))
    }
    if (rest > 0) {
      this.#chunks.push(chunk.subarray(offset))
      this.#payloadBytes += rest
    }
    if (this.#payloadBytes < this.#expected) return null
    this.done = true
    const payload = Buffer.concat(this.#chunks, this.#expected)
    try {
      return JSON.parse(payload.toString('utf8'))
    } catch (error) {
      throw new KimiError(CODES.CU_PROTOCOL, t('err.badJson', { detail: errText(error) }))
    }
  }
}

/** 连上管道。 */
function connect(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe)
    const onError = (error) => {
      socket.destroy()
      reject(error)
    }
    socket.once('connect', () => {
      socket.off('error', onError)
      resolve(socket)
    })
    socket.once('error', onError)
  })
}

/** 在一条已连接的 socket 上读一帧。 */
function readFrame(socket, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader()
    let settled = false
    const timer = setTimeout(() => settle(reject, new KimiError(CODES.CU_TIMEOUT, t('err.cuTimeout', { ms: timeoutMs }) + "\n" + formatNextActions("KIMI_CU_TIMEOUT"))), timeoutMs)
    const onAbort = () => settle(reject, new KimiError(CODES.CU_TIMEOUT, t('err.cuAborted') + "\n" + formatNextActions("KIMI_CU_TIMEOUT")))
    function settle(fn, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      fn(value)
    }
    function onData(chunk) {
      try {
        const frame = reader.push(chunk)
        if (frame !== null) settle(resolve, frame)
      } catch (error) {
        settle(reject, error)
      }
    }
    function onError(error) {
      settle(reject, error)
    }
    function onClose() {
      if (!reader.done) settle(reject, new KimiError(CODES.CU_PROTOCOL, t('err.cuClosedEarly')))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** 一次性请求（开连接 → 写一帧 → 读一帧 → 关）。 */
async function exchange(pipe, request, { signal, timeoutMs }) {
  const socket = await connect(pipe)
  try {
    const pending = readFrame(socket, signal, timeoutMs)
    socket.write(encodeFrame(request))
    return await pending
  } finally {
    socket.destroy()
  }
}

let nextId = 1

/** 校验 Agent 响应信封。 */
function unwrap(response, expectedId) {
  if (!response || typeof response !== 'object') {
    throw new KimiError(CODES.CU_PROTOCOL, t('err.cuNotObject'))
  }
  if (response.id !== expectedId) {
    throw new KimiError(CODES.CU_PROTOCOL, t('err.cuIdMismatch', { expected: expectedId, actual: String(response.id) }))
  }
  if (response.ok === true) return response.result
  const message = String(response.error ?? t('err.cuRequestFailed'))
  const code = String(response.error_code ?? '')
  if (code === 'computer_use_busy' || /computer_use_busy/.test(message)) {
    throw new KimiError(CODES.CU_BUSY, t('err.cuBusy') + "\n" + formatNextActions("KIMI_CU_BUSY"))
  }
  if (/lifecycle lease is not active|lifecycle end does not match/i.test(message)) {
    throw new KimiError(
      CODES.CU_PROTOCOL,
      t('err.leaseMismatch', { detail: message }),
    )
  }
  throw new KimiError(CODES.CU_TOOL, `KimiCU ${code ? `[${code}] ` : ''}${message}`)
}

/** 解析版本号（容忍 -N 测试后缀与 +build）。 */
function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(String(value ?? ''))
  if (!match) return null
  return match.slice(1, 4).map(Number)
}

function versionAtLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true
    if (version[index] < minimum[index]) return false
  }
  return true
}

/**
 * 解析 exe 并确保 Agent 在跑：跑 `kimi-cu.exe start-agent`（幂等）。
 * @returns {Promise<{pipe: string, version: string, permissions: any, pid: number|null}>}
 */
export async function ensureAgent(config, env = process.env) {
  assertPlatform()
  if (state.pipe) {
    return { pipe: state.pipe, version: state.runtimeVersion, permissions: state.permissions, pid: state.agentPid }
  }
  const exe = await resolveExe(config, env)
  if (!config.kimicuAutoStart) {
    // 不自动拉 Agent 时，直接用默认管道试 ping
    const pipe = defaultPipePath(env)
    const pinged = await ping(pipe, config)
    applyPing(pipe, pinged)
    return { pipe: state.pipe, version: state.runtimeVersion, permissions: state.permissions, pid: state.agentPid }
  }
  try {
    const { stdout } = await execFileAsync(exe, ['start-agent'], { windowsHide: true, timeout: 20_000 })
    const parsed = JSON.parse(stdout)
    // start-agent 的形状（0.3.10 实测）：
    //   { agent: {ok,pid,version,permissions,...}, reason, started, status: { agent: {running, pipe, live:{...}} } }
    // 管道与 running 在 status.agent 里；版本/权限在 agent（或 status.agent.live）里。
    const statusAgent = parsed?.status?.agent ?? parsed?.agent ?? parsed
    const liveAgent = parsed?.agent ?? statusAgent?.live ?? statusAgent
    const pipe = statusAgent?.pipe
    const running = statusAgent?.running === true || liveAgent?.ok === true
    if (!running || typeof pipe !== 'string' || !pipe.trim()) {
      throw new Error(t('err.agentNoPid', { stdout: String(stdout).slice(0, 400) }))
    }
    state.pipe = pipe
    state.agentPid = Number.isFinite(liveAgent?.pid) ? liveAgent.pid : null
    const pinged = await ping(pipe, config)
    applyPing(pipe, pinged)
    return { pipe: state.pipe, version: state.runtimeVersion, permissions: state.permissions, pid: state.agentPid }
  } catch (error) {
    if (error instanceof KimiError) throw error
    throw new KimiError(
      CODES.CU_AGENT_START_FAILED,
      t('err.agentStartFailed', { reason: errText(error), exe }),
      { cause: error },
    )
  }
}

function applyPing(pipe, result) {
  state.pipe = pipe
  state.runtimeVersion = String(result?.version ?? '')
  state.permissions = result?.permissions ?? null
  state.agentPid = Number.isFinite(result?.pid) ? result.pid : state.agentPid
  const version = parseVersion(state.runtimeVersion)
  if (!version) {
    throw new KimiError(CODES.CU_RUNTIME_TOO_OLD, t('err.noVersion', { found: state.runtimeVersion }))
  }
  if (!versionAtLeast(version, MIN_RUNTIME)) {
    throw new KimiError(
      CODES.CU_RUNTIME_TOO_OLD,
      t('err.runtimeTooOld', { found: state.runtimeVersion, minimum: MIN_RUNTIME.join('.') }),
    )
  }
}

/** ping 一次（不建立租约）。 */
export async function ping(pipe, config) {
  const id = nextId++
  const response = await exchange(
    pipe,
    { id, session_id: 'dsh/ping', method: '__agent_ping', params: {} },
    { timeoutMs: Math.min(config.kimicuTimeoutMs, 20_000) },
  )
  return unwrap(response, id)
}

/**
 * 全局串行队列：桌面输入不能并行，否则两条流会互相打断。
 * 用 Promise 链实现一个最小 mutex。
 */
let queue = Promise.resolve()
function withLock(task) {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 校验一个 CU 调用（方法名 + 参数白名单）。纯函数，不碰运行时 ——
 * 工具层应当在建立租约/拉起 Agent **之前**调用它，这样参数错误不会白拉一次 Agent。
 * @param {string} method
 * @param {Record<string, unknown>} args
 */
export function validateCall(method, args = {}) {
  if (!CU_METHODS.includes(method)) {
    throw new KimiError(CODES.ARGS, t('err.methodUnknown', { method, available: CU_METHODS.join(', ') }))
  }
  const allowed = CU_METHOD_ARGS[method] ?? []
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new KimiError(
        CODES.ARGS,
        t('err.methodArgs', { method, field: key, allowed: allowed.join(', ') || t('err.noArgs') }),
      )
    }
  }
}

/**
 * 在**一次租约**里执行一组 CU 调用。
 * @param {object} config
 * @param {string} sessionId 稳定会话标识（用于 Agent 侧归因）
 * @param {(call: (method: string, args?: object) => Promise<any>) => Promise<any>} body
 * @param {{signal?: AbortSignal}} [options]
 */
export async function withLease(config, sessionId, body, options = {}) {
  return withLock(async () => {
    const agent = await ensureAgent(config)
    const pipe = agent.pipe
    const nonce = `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const timeoutMs = config.kimicuTimeoutMs

    // begin 与 end 必须共用同一条连接
    const life = await connect(pipe)
    let begun = false
    try {
      const beginId = nextId++
      const beginPending = readFrame(life, options.signal, timeoutMs)
      life.write(
        encodeFrame({
          id: beginId,
          session_id: sessionId,
          method: '__lifecycle_v1',
          params: { action: 'begin', nonce },
        }),
      )
      unwrap(await beginPending, beginId)
      begun = true

      const call = async (method, args = {}) => {
        validateCall(method, args)
        const id = nextId++
        const response = await exchange(
          pipe,
          {
            id,
            session_id: sessionId,
            method: '__computer_use_call_v1',
            params: { method, arguments: args },
            telemetry_tool: method,
            lifecycle: { nonce },
          },
          { signal: options.signal, timeoutMs },
        )
        return unwrap(response, id)
      }

      return await body(wrapWindowRecovery(call))
    } finally {
      if (begun) {
        try {
          const endId = nextId++
          const endPending = readFrame(life, undefined, 10_000)
          life.write(
            encodeFrame({
              id: endId,
              session_id: sessionId,
              method: '__lifecycle_v1',
              params: { action: 'end', nonce },
            }),
          )
          await endPending
        } catch {
          /* 释放失败不覆盖业务结果；下一次 begin 会重新拿租约 */
        }
      }
      life.destroy()
    }
  })
}

/**
 * 当前状态摘要（kimi_status 用；不抛错，把失败写进 error 字段）。
 * @param {object} config
 * @param {{autoStart?: boolean}} [options] autoStart=false 时只对现有管道 ping，不拉起 Agent
 */
export async function probe(config, options = {}) {
  const result = {
    platform: process.platform,
    supported: process.platform === 'win32',
    exe: '',
    runtimeVersion: '',
    agentPid: null,
    pipe: '',
    permissions: null,
    error: null,
  }
  if (process.platform !== 'win32') {
    result.error = { code: CODES.UNSUPPORTED_PLATFORM, message: t('err.unsupportedPlatformShort') }
    return result
  }
  try {
    result.exe = await resolveExe(config)
    if (options.autoStart === false) {
      // 便宜路径：只对已知/默认管道 ping，不启动任何东西
      const pipe = state.pipe || defaultPipePath()
      const pinged = await ping(pipe, config)
      applyPing(pipe, pinged)
      result.runtimeVersion = state.runtimeVersion
      result.agentPid = state.agentPid
      result.pipe = state.pipe
      result.permissions = state.permissions
      return result
    }
    const agent = await ensureAgent(config)
    result.runtimeVersion = agent.version
    result.agentPid = agent.pid
    result.pipe = agent.pipe
    result.permissions = agent.permissions
  } catch (error) {
    result.error = { code: error?.code ?? 'KIMI_UNKNOWN', message: errText(error) }
    result.exe = state.exe || result.exe
    result.pipe = state.pipe || result.pipe
    result.runtimeVersion = state.runtimeVersion || result.runtimeVersion
    result.permissions = state.permissions || result.permissions
  }
  return result
}

/** 运行时在窗口消失/重建后抛的错：这类错误重试一次是有意义的（动作并没有落下去）。 */
const WINDOW_INVALID_RE = /window is no longer valid|window no longer exists|invalid window|窗口.{0,6}(失效|不存在|已关闭)/i

/** 是不是「窗口句柄失效」类错误。 */
export function isWindowInvalidError(error) {
  return WINDOW_INVALID_RE.test(String(error?.message ?? error))
}

/**
 * 包一层 call：遇到窗口句柄失效时，按原引用重新解析窗口并重试一次。
 *
 * 为什么安全：这类错误意味着动作没有落到任何窗口上，重试不会造成重复输入。
 * 为什么必要：实测这是桌面侧最常见的失败（10909 次调用里 7 次），而窗口重建
 * （用户关掉再打开、应用重启）是很日常的操作。
 */
function wrapWindowRecovery(call) {
  return async function callWithWindowRecovery(method, args = {}) {
    try {
      return await call(method, args)
    } catch (error) {
      if (!isWindowInvalidError(error)) throw error
      const stale = args?.window
      if (!stale) throw error
      const ref = stale.id != null ? { id: stale.id, ...(stale.app ? { app: stale.app } : {}) } : stale.title
      if (!ref) throw error
      let fresh
      try {
        fresh = await resolveWindow(call, ref)
      } catch {
        throw error // 窗口真的没了：把原错误抛回去，比换成一个「找不到」更有用
      }
      return call(method, { ...args, window: fresh })
    }
  }
}

/** 把 window 参数解析成真实窗口对象；0/多命中都报错并给候选。 */
export async function resolveWindow(call, windowRef) {
  if (windowRef && typeof windowRef === 'object' && Number.isInteger(windowRef.id)) {
    return call('get_window', { id: windowRef.id, ...(windowRef.app ? { app: windowRef.app } : {}) })
  }
  const windows = await call('list_windows')
  const list = Array.isArray(windows) ? windows : []
  if (typeof windowRef === 'number' || /^\d+$/.test(String(windowRef ?? ''))) {
    const id = Number(windowRef)
    const found = list.find((item) => item.id === id)
    if (found) return found
    return call('get_window', { id })
  }
  const needle = String(windowRef ?? '').trim().toLowerCase()
  if (!needle) {
    throw new KimiError(
      CODES.ARGS,
      t('err.windowEmpty', { candidates: describeWindowList(list) }),
    )
  }
  const exact = list.filter((item) => String(item.title ?? '').toLowerCase() === needle)
  const partial = exact.length > 0 ? exact : list.filter((item) => String(item.title ?? '').toLowerCase().includes(needle))
  if (partial.length === 1) return partial[0]
  if (partial.length === 0) {
    throw new KimiError(
      CODES.ARGS,
      t('err.windowNoMatch', { value: windowRef, candidates: describeWindowList(list) }),
    )
  }
  throw new KimiError(
    CODES.ARGS,
    t('err.windowAmbiguous', {
      value: windowRef,
      count: partial.length,
      candidates: describeWindowList(partial),
    }),
  )
}
