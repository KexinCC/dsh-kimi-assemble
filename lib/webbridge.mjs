/**
 * lib/webbridge.mjs —— Kimi 浏览器扩展（WebBridge）daemon 客户端
 * ============================================================================
 * daemon 协议（本机 v2.0.26 实测）：
 *   POST http://<addr>/command   body {action, args, session}
 *     → {ok:true, data:{...}} | {ok:false, error:{code, message}}
 *   GET  http://<addr>/status    → 与 `kimi-webbridge status` 同形的 JSON
 *
 * 为什么不用 curl（重要，别改回去）：
 *   Windows PowerShell 会把内联参数里的非 ASCII 打坏（实测中文 body 变成
 *   `?`/BOM，daemon 直接回 invalid JSON）。这里全程在 Node 进程内用
 *   http.request + Buffer，UTF-8 无损，也不存在引号转义问题。
 *
 * 自动启动：连不上时跑 `kimi-webbridge start`（幂等），再轮询 /status。
 * 绝不 stop/restart/uninstall —— 那会杀掉用户正在用的 daemon。
 * ============================================================================
 */
const nl = String.fromCharCode(10)
import { formatNextActions } from './next-actions.mjs'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { KimiError, CODES, errText } from './errors.mjs'
import { t } from './i18n.mjs'

const execFileAsync = promisify(execFile)

const DEFAULT_ADDR = '127.0.0.1:10086'
const START_POLL_MS = 250
const START_TIMEOUT_MS = 15_000

/** daemon 状态缓存（只缓存 /status 的连接态，不缓存命令结果）。 */
let cachedAddr = ''
let lastStatus = null
let lastStatusAt = 0

/** ~/.kimi-webbridge 目录（Windows 用 USERPROFILE，其它平台 HOME）。 */
export function webbridgeHome(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir()
  return join(home, '.kimi-webbridge')
}

/** daemon 可执行文件路径（不在 PATH 上，必须显式定位）。 */
export function webbridgeBinary(env = process.env) {
  return join(webbridgeHome(env), 'bin', process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge')
}

/**
 * 解析 daemon 地址：配置 > ~/.kimi-webbridge/daemon.addr > 默认。
 * @param {{webbridgeAddr?: string}} config
 */
export async function resolveAddr(config) {
  if (config?.webbridgeAddr) return config.webbridgeAddr
  if (cachedAddr) return cachedAddr
  try {
    const raw = (await readFile(join(webbridgeHome(), 'daemon.addr'), 'utf8')).trim()
    if (/^[^\s/:]+:\d{1,5}$/.test(raw)) {
      cachedAddr = raw
      return raw
    }
  } catch {
    /* 没有就退默认 */
  }
  cachedAddr = DEFAULT_ADDR
  return cachedAddr
}

/** 仅供测试：清掉地址缓存。 */
export function resetAddrCache() {
  cachedAddr = ''
  lastStatus = null
  lastStatusAt = 0
}

/**
 * 一次原始 HTTP 请求。超时/取消都会销毁 socket。
 * @param {string} addr
 * @param {'GET'|'POST'} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{status: number, text: string}>}
 */
function request(addr, method, path, body, signal) {
  return new Promise((resolve, reject) => {
    const [host, portText] = addr.split(':')
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host,
        port: Number(portText),
        method,
        path,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
            : {}),
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'))
        return
      }
      const onAbort = () => req.destroy(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    if (payload) req.write(payload)
    req.end()
  })
}

/** 连不上时的判定：ECONNREFUSED / ENOENT / EHOSTUNREACH / 自建 aborted。 */
function isConnectionFailure(error) {
  const code = error?.code
  if (['ECONNREFUSED', 'ENOENT', 'EHOSTUNREACH', 'ECONNRESET', 'EADDRNOTAVAIL'].includes(code)) return true
  return /aborted/i.test(errText(error)) && code === undefined
}

/** 调 `kimi-webbridge start`（幂等；daemon 已在跑时无副作用）。 */
async function startDaemon(binary) {
  try {
    await execFileAsync(binary, ['start'], { windowsHide: true, timeout: 20_000 })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: errText(error) }
  }
}

/** 轮询 /status 直到 daemon 起来或超时。 */
async function waitForDaemon(addr, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await request(addr, 'GET', '/status')
      if (res.status === 200 && res.text.includes('"running"')) return true
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS))
  }
  return false
}

/**
 * 清掉「死进程残留的 pid 文件」，让 `kimi-webbridge start` 能重新拉起。
 *
 * 背景（实测）：daemon 被强杀/断电后，~/.kimi-webbridge/daemon.pid 会留下旧 pid；
 * 下一次 `start` 检查该 pid 时若认为它还活着就直接拒绝启动，于是端口空闲却永远连不上。
 *
 * 安全边界：只有当 pid 文件里的进程**确认已死**（kill(pid,0) 报 ESRCH）或内容损坏时才删；
 * 进程活着（含 EPERM = 存在但无权限）绝不动文件，也绝不杀进程。
 *
 * @param {Record<string, string | undefined>} [env] 便于测试注入 HOME
 * @returns {Promise<boolean>} 是否清掉了一个 stale pid 文件
 */
export async function clearStalePidFile(env = process.env) {
  const pidPath = join(webbridgeHome(env), 'daemon.pid')
  let raw
  try {
    raw = (await readFile(pidPath, 'utf8')).trim()
  } catch {
    return false // 没有文件（ENOENT）或读不了：都不是我们能修的
  }
  const pid = Number(raw)
  if (!Number.isInteger(pid) || pid <= 0) {
    // 内容损坏（空/非数字）：这个文件挡不了任何人，直接清
    try {
      await unlink(pidPath)
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0) // 不发信号，只探测存在性
    return false // 进程活着 → 绝不碰
  } catch (error) {
    if (error?.code === 'ESRCH') {
      // 进程已死 → 这是残留文件，删掉是安全的
      try {
        await unlink(pidPath)
        return true
      } catch {
        return false
      }
    }
    return false // EPERM 等 = 进程存在但无权限 → 当活着处理
  }
}

/**
 * 启动 daemon；若 `start` 因「pid 文件被死进程占用」而拒绝，清掉残留后重试一次。
 * @param {string} binary
 * @returns {Promise<{ok: boolean, message?: string, recovered?: boolean}>}
 */
async function startDaemonWithRecovery(binary) {
  let started = await startDaemon(binary)
  if (started.ok) return started
  if (!/pid file .* exists and process .* is alive|another .* daemon .* is already running/i.test(started.message ?? '')) {
    return started
  }
  const recovered = await clearStalePidFile()
  if (!recovered) return started
  started = await startDaemon(binary)
  return { ...started, recovered: true }
}

/**
 * 读 /status（带 2 秒 TTL 缓存，避免每个工具调用都打一次）。
 * @param {object} config
 * @param {{force?: boolean}} [options]
 */
export async function status(config, options = {}) {
  const addr = await resolveAddr(config)
  const now = Date.now()
  if (!options.force && lastStatus && now - lastStatusAt < 2_000) {
    return { ...lastStatus, addr }
  }
  let res
  try {
    res = await request(addr, 'GET', '/status')
  } catch (error) {
    throw new KimiError(
      CODES.WEBRIDGE_DOWN,
      t('err.webbridgeDown', { addr, binary: webbridgeBinary() }) + '\n' + formatNextActions('KIMI_WEBRIDGE_DOWN'),
      { cause: error },
    )
  }
  let parsed
  try {
    parsed = JSON.parse(res.text)
  } catch {
    // 端口上有 HTTP 服务但不是 daemon —— 这是「被占用」，不是「没起来」
    throw new KimiError(CODES.WEBRIDGE_PORT_BUSY, t('err.portBusy', { addr, status: res.status }) + '\n' + formatNextActions('KIMI_WEBRIDGE_PORT_BUSY'))
  }
  lastStatus = parsed
  lastStatusAt = now
  return { ...parsed, addr }
}

/**
 * 确保 daemon 可达；连不上时按配置自动启动一次。
 * @returns {Promise<{addr: string, status: object}>}
 */
export async function ensureDaemon(config) {
  const addr = await resolveAddr(config)
  try {
    const live = await status(config, { force: true })
    return { addr, status: live }
  } catch (error) {
    // 端口被别的程序占用：拉起 daemon 也没用，直接报出去，别做无谓的重试
    if (error instanceof KimiError && error.code === CODES.WEBRIDGE_PORT_BUSY) throw error
    if (!config.webbridgeAutoStart) throw error
    const started = await startDaemonWithRecovery(webbridgeBinary())
    const up = await waitForDaemon(addr)
    if (!up) {
      throw new KimiError(
        CODES.WEBRIDGE_DOWN,
        t('err.webbridgeStartFailed', {
          addr,
          binary: webbridgeBinary(),
          help: t('err.helpWebbridge'),
          detail: started.ok ? '' : t('err.webbridgeStartDetail', { message: started.message }),
        }),
      )
    }
    const live = await status(config, { force: true })
    return { addr, status: live }
  }
}

/**
 * 执行一个 daemon action。
 * @param {object} config
 * @param {string} action 35 个 action 之一
 * @param {Record<string, unknown>} args
 * @param {{session: string, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<any>} daemon 的 data 字段
 */
export async function call(config, action, args = {}, options) {
  const { addr } = await ensureDaemon(config)
  const timeoutMs = options.timeoutMs ?? config.webbridgeTimeoutMs
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (options.signal) signals.push(options.signal)
  const signal = AbortSignal.any(signals)

  let res
  try {
    res = await request(addr, 'POST', '/command', { action, args, session: options.session }, signal)
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (isConnectionFailure(error) || /aborted/i.test(errText(error))) {
      throw new KimiError(
        CODES.WEBRIDGE_TIMEOUT,
        t('err.webbridgeTimeout', { action, seconds: Math.round(timeoutMs / 1000), addr }),
        { cause: error },
      )
    }
    throw new KimiError(
      CODES.WEBRIDGE_DOWN,
      t('err.webbridgeCallFailed', { action, detail: errText(error) }) + '\n' + formatNextActions('KIMI_WEBRIDGE_DOWN'),
      { cause: error },
    )
  }

  // 端口上可能是别的程序：200 但不是信封
  let envelope
  try {
    envelope = JSON.parse(res.text)
  } catch {
    throw new KimiError(CODES.WEBRIDGE_PORT_BUSY, t('err.portBusy', { addr, status: res.status }) + '\n' + formatNextActions('KIMI_WEBRIDGE_PORT_BUSY'))
  }
  if (res.status !== 200 && envelope?.ok !== false) {
    throw new KimiError(CODES.WEBRIDGE_BAD_ENVELOPE, t('err.badEnvelope', { status: res.status, detail: res.text.slice(0, 400) }))
  }
  if (envelope?.ok === true) return envelope.data

  const error = envelope?.error ?? {}
  const code = String(error.code ?? '')
  const message = String(error.message ?? t('err.unknownError'))

  if (code === 'extension_not_connected') {
    throw new KimiError(
      CODES.WEBRIDGE_EXTENSION,
      t('err.extensionOffline', { detail: message, help: t('err.helpWebbridge') }) + '\n' + formatNextActions('KIMI_WEBRIDGE_EXTENSION'),
    )
  }
  if (/update the Kimi Browser Extension/i.test(message)) {
    throw new KimiError(
      CODES.WEBRIDGE_VERSION,
      t('err.versionMismatch', { detail: message, help: t('err.helpWebbridge') }) + '\n' + formatNextActions('KIMI_WEBRIDGE_VERSION'),
    )
  }
  // 第三方扩展（密码管理器、翻译、录屏等）会在页面里插自己的面板，aria 快照会被搅乱。
  // 这不是我们或 Kimi 扩展的问题，但要让人知道该关掉谁。
  if (/Another browser extension has opened its own panel/i.test(message)) {
    throw new KimiError(CODES.WEBRIDGE_TOOL, `${action}${code ? ` [${code}]` : ''}: ${message}${nl}${t('err.panelConflict')}`)
  }
  throw new KimiError(CODES.WEBRIDGE_TOOL, `${action}${code ? ` [${code}]` : ''}: ${message}`)
}

/** 打开页面前先确保地址可用（供工具层做 URL 校验用，不发起请求）。 */
export function assertHttpUrl(url) {
  const value = String(url ?? '').trim()
  if (!value) throw new KimiError(CODES.ARGS, t('err.urlRequired'))
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value
  // 裸域名补 https://（用户输入 example.com 这种）
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(value)) return `https://${value}`
  return value
}
