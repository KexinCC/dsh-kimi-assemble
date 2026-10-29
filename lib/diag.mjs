/**
 * lib/diag.mjs —— 可选的诊断日志（默认关闭）
 * ============================================================================
 * 为什么要它：
 *   插件的失败率其实很低（实测 10909 次调用里 51 次失败 ≈ 0.5%），但代价是
 *   **出事时没有现场** —— 只能靠人回忆"当时点了什么、报了什么"。开了诊断日志，
 *   每次工具调用都会留一行 JSONL：工具名、会话、耗时、成功与否、错误码、错误首行。
 *
 * 设计约束：
 *   - 默认关闭（配置 diagnostics: true 才写），不给自己和别人制造无谓的写盘。
 *   - 零依赖、不抛错：日志失败绝不影响工具调用（所有写入包在 try 里）。
 *   - 自动轮转：超过 maxBytes 就把旧文件改名成 .1（只留一个历史文件）。
 *   - 不记录参数内容：只记字段名与错误码，避免把密码/页面内容写进磁盘。
 *
 * 位置：`~/.dsh/kimi-assemble/diag.log`（Windows 用 USERPROFILE，其它用 HOME）
 * ============================================================================
 */
import { appendFileSync, mkdirSync, renameSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const state = {
  enabled: false,
  dir: '',
  file: '',
  maxBytes: 512 * 1024,
  /** 本进程写过多少行（用于自检与测试） */
  written: 0,
  lastError: '',
}

/** 日志目录：默认 ~/.dsh/kimi-assemble */
export function diagDir(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir()
  return join(home, '.dsh', 'kimi-assemble')
}

/** 日志文件路径 */
export function diagPath(env = process.env) {
  return join(diagDir(env), 'diag.log')
}

/**
 * 配置诊断日志。
 * @param {{enabled?: boolean, maxBytes?: number, env?: Record<string,string|undefined>}} options
 */
export function configureDiag(options = {}) {
  const env = options.env ?? process.env
  state.enabled = options.enabled === true
  state.dir = diagDir(env)
  state.file = join(state.dir, 'diag.log')
  state.maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 512 * 1024
  return { enabled: state.enabled, file: state.file, maxBytes: state.maxBytes }
}

/** 当前状态（供测试/自检） */
export function diagState() {
  return { ...state }
}

/** 超过阈值就轮转；轮转失败不影响写入。 */
function rotateIfNeeded() {
  try {
    const size = statSync(state.file).size
    if (size >= state.maxBytes) renameSync(state.file, `${state.file}.1`)
  } catch {
    /* 文件不存在或改名失败：直接追加 */
  }
}

/**
 * 记一条诊断事件。字段刻意保持小：不写参数值、不写页面内容。
 * @param {{event: string, tool?: string, session?: string, ok?: boolean, ms?: number, code?: string, detail?: string, extra?: object}} entry
 */
export function recordDiag(entry) {
  if (!state.enabled) return false
  try {
    mkdirSync(state.dir, { recursive: true })
    rotateIfNeeded()
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: entry.event,
      ...(entry.tool ? { tool: entry.tool } : {}),
      ...(entry.session ? { session: entry.session } : {}),
      ...(entry.ok !== undefined ? { ok: entry.ok } : {}),
      ...(Number.isFinite(entry.ms) ? { ms: Math.round(entry.ms) } : {}),
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.detail ? { detail: String(entry.detail).slice(0, 300) } : {}),
      ...(entry.extra ? { extra: entry.extra } : {}),
    })
    appendFileSync(state.file, `${line}\n`, 'utf8')
    state.written += 1
    return true
  } catch (error) {
    state.lastError = String(error?.message ?? error)
    return false
  }
}

/** 读最近 n 行（供 kimi_status 或人肉排查用；文件不存在返回空数组）。 */
export function readDiagTail(n = 20) {
  try {
    const text = readFileSync(state.file || diagPath(), 'utf8')
    const lines = text.trim().split('\n')
    return lines.slice(-Math.max(1, n))
  } catch {
    return []
  }
}
