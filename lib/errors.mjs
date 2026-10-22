/**
 * lib/errors.mjs —— 统一错误形态
 * ============================================================================
 * 所有对外错误都带一个稳定 code（KIMI_*），message 里写「发生了什么 + 下一步
 * 该做什么」。宿主只把 message 给模型看（HarnessError 的 code 也进 error.info），
 * 所以 message 必须自解释，不能只写 "request failed"。
 *
 * 设计约束（来自本机实测）：
 *   - WebBridge daemon 的 ok:false 里自带 code/message，转达时要保留原文案，
 *     因为它的文案就是给用户的操作指引（扫码、升级扩展、先 navigate…）。
 *   - KimiCU Agent 的错误只有 message（有时带 error_code），同样保留原文。
 *   - 任何连接类失败都要给出「下一步」，并且不要自动重试有副作用的动作。
 *
 * 文案语言：错误码恒定不变（测试与用户的契约在 code 上），message 走
 * lib/i18n.mjs 的当前语言。
 * ============================================================================
 */
import { t } from './i18n.mjs'

/** 本插件产生的所有错误码。加新码时同步 references/troubleshooting.md。 */
export const CODES = Object.freeze({
  ARGS: 'KIMI_ARGS',
  CONFIG: 'KIMI_CONFIG',
  UNSUPPORTED_PLATFORM: 'KIMI_UNSUPPORTED_PLATFORM',

  WEBRIDGE_DOWN: 'KIMI_WEBRIDGE_DOWN',
  WEBRIDGE_PORT_BUSY: 'KIMI_WEBRIDGE_PORT_BUSY',
  WEBRIDGE_EXTENSION: 'KIMI_WEBRIDGE_EXTENSION',
  WEBRIDGE_VERSION: 'KIMI_WEBRIDGE_VERSION',
  WEBRIDGE_TOOL: 'KIMI_WEBRIDGE_TOOL',
  WEBRIDGE_TIMEOUT: 'KIMI_WEBRIDGE_TIMEOUT',
  WEBRIDGE_BAD_ENVELOPE: 'KIMI_WEBRIDGE_BAD_ENVELOPE',

  CU_NOT_INSTALLED: 'KIMI_CU_NOT_INSTALLED',
  CU_AGENT_START_FAILED: 'KIMI_CU_AGENT_START_FAILED',
  CU_AGENT_DOWN: 'KIMI_CU_AGENT_DOWN',
  CU_RUNTIME_TOO_OLD: 'KIMI_CU_RUNTIME_TOO_OLD',
  CU_BUSY: 'KIMI_CU_BUSY',
  CU_TIMEOUT: 'KIMI_CU_TIMEOUT',
  CU_PROTOCOL: 'KIMI_CU_PROTOCOL',
  CU_TOOL: 'KIMI_CU_TOOL',
})

/** 一个带稳定 code 的工具错误。宿主会把它渲染成 "Error: <message>"。 */
export class KimiError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'KimiError'
    this.code = code
  }
}

/** 参数错误：message 里必须点名是哪个字段、允许什么。 */
export function argsError(message) {
  return new KimiError(CODES.ARGS, message)
}

/**
 * 用 i18n 目录里的一条文案建参数错误。
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
export function argsErrorT(key, params) {
  return new KimiError(CODES.ARGS, t(key, params))
}

/**
 * 用 i18n 目录里的一条文案建配置错误。
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
export function configError(key, params) {
  return new KimiError(CODES.CONFIG, t(key, params))
}

/**
 * 把任意 thrown 值收敛成 { code, message }，用于状态汇总与测试。
 * @param {unknown} error
 */
export function describeError(error) {
  if (error instanceof KimiError) return { code: error.code, message: error.message }
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return { code: 'KIMI_UNKNOWN', message: error instanceof Error ? error.message : String(error) }
}

/** 取错误文案，用于把底层异常塞进上层 message。 */
export function errText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
