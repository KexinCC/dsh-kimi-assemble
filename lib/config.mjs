/**
 * lib/config.mjs —— 插件配置：默认值 + 手写校验
 * ============================================================================
 * 为什么不直接用 schemastery：桌面版 profile 是 `autoInstallPeers: false`，
 * `@deepseek-ai/schemastery` 不一定在 profile 树里；裸 import 会让整条插件
 * 不激活（dsh-bili-scroll 踩过这个坑，见它的 lib/hostdeps.mjs）。所以这里手写
 * 归一化 + 校验，导出 Config 只为让设置页知道字段（拿不到 schemastery 就不导出）。
 *
 * 语义：patch 里的 config 是整段替换，不是深合并 —— 用户只写想改的键，其余
 * 走这里的默认值。
 * ============================================================================
 */
import { LANGUAGES } from './i18n.mjs'
import { configError } from './errors.mjs'

export const DEFAULTS = Object.freeze({
  // ---- 浏览器（Kimi 扩展 / WebBridge）----
  webbridgeEnabled: true,
  /** 空 = 自动发现：~/.kimi-webbridge/daemon.addr，再退 127.0.0.1:10086 */
  webbridgeAddr: '',
  /** 连不上时自动 `kimi-webbridge start` */
  webbridgeAutoStart: true,
  webbridgeTimeoutMs: 60_000,
  /** 打开标签时的分组标题（用户浏览器里可见） */
  browserGroupTitle: 'DSH',
  /** 单次读取默认返回多少字符 */
  browserReadMaxChars: 20_000,
  /**
   * 动作后要不要校验「页面真的变了」：auto = 校验（默认），off = 退回 1.0.x 的「派发即成功」。
   * off 是给用户的回滚开关，也是 A/B 实验里的等效对照。
   */
  browserVerify: 'auto',
  /** 校验时观察多久（毫秒）；越大越不容易漏掉慢渲染，越小越快 */
  browserVerifyMs: 600,
  /** light 级的观察预算（默认 0 = 完全不等，用于滚动/悬停这类可逆动作） */
  browserVerifyLightMs: 0,
  /** read 默认附带页面状态行（url/滚动/焦点/元素计数） */
  browserReadIncludeMeta: true,

  // ---- 桌面（KimiCU）----
  kimicuEnabled: true,
  /** 空 = 自动发现 %LOCALAPPDATA%\Kimi Computer Use\kimi-cu.exe（兼容旧 KimiCU 目录） */
  kimicuExePath: '',
  kimicuAutoStart: true,
  kimicuTimeoutMs: 120_000,
  /** 无障碍树默认截断长度 */
  cuMaxTreeChars: 12_000,

  // ---- 提示词与技能 ----
  promptSection: true,
  registerSkills: true,

  // ---- 语言与工具开关 ----
  /** auto = 按系统区域（zh* → 中文，其余英文）；en / zh = 强制 */
  language: 'auto',
  /**
   * 诊断日志（默认关）。开启后每次工具调用写一行 JSONL 到
   * ~/.dsh/kimi-assemble/diag.log；只记工具名/耗时/错误码/错误首行，不记参数与页面内容。
   */
  diagnostics: false,
  /** 诊断日志轮转阈值（KB） */
  diagnosticsMaxKb: 512,
  /** 按名字停用个别工具（例如只想用浏览器不想用桌面） */
  disabledTools: [],
})

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return fallback
}

function asInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw configError('config.notNumber', { value: JSON.stringify(value) })
  }
  const i = Math.round(n)
  if (i < min || i > max) {
    throw configError('config.outOfRange', { min, max, value: i })
  }
  return i
}

function asText(value, fallback) {
  if (value === undefined || value === null) return fallback
  return String(value).trim()
}

/** 字符串数组：接受数组或逗号分隔的字符串（YAML 里两种都好写）。 */
function asNameList(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const names = []
  for (const item of raw) {
    const name = String(item ?? '').trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * 归一化并校验插件配置。
 * @param {unknown} raw cordis.patch.yml 里这一行的 config
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = {
    webbridgeEnabled: asBool(input.webbridgeEnabled, DEFAULTS.webbridgeEnabled),
    webbridgeAddr: asText(input.webbridgeAddr, DEFAULTS.webbridgeAddr),
    webbridgeAutoStart: asBool(input.webbridgeAutoStart, DEFAULTS.webbridgeAutoStart),
    webbridgeTimeoutMs: asInt(input.webbridgeTimeoutMs, DEFAULTS.webbridgeTimeoutMs, 1_000, 660_000),
    browserGroupTitle: asText(input.browserGroupTitle, DEFAULTS.browserGroupTitle) || DEFAULTS.browserGroupTitle,
    browserReadMaxChars: asInt(input.browserReadMaxChars, DEFAULTS.browserReadMaxChars, 500, 60_000),
    browserVerify: (() => {
      const raw = asText(input.browserVerify, DEFAULTS.browserVerify).toLowerCase() || DEFAULTS.browserVerify
      if (!['auto', 'off'].includes(raw)) throw configError('config.verifyValue', { value: JSON.stringify(input.browserVerify) })
      return raw
    })(),
    browserVerifyMs: asInt(input.browserVerifyMs, DEFAULTS.browserVerifyMs, 0, 10_000),
    browserVerifyLightMs: asInt(input.browserVerifyLightMs, DEFAULTS.browserVerifyLightMs, 0, 10_000),
    browserReadIncludeMeta: asBool(input.browserReadIncludeMeta, DEFAULTS.browserReadIncludeMeta),

    kimicuEnabled: asBool(input.kimicuEnabled, DEFAULTS.kimicuEnabled),
    kimicuExePath: asText(input.kimicuExePath, DEFAULTS.kimicuExePath),
    kimicuAutoStart: asBool(input.kimicuAutoStart, DEFAULTS.kimicuAutoStart),
    kimicuTimeoutMs: asInt(input.kimicuTimeoutMs, DEFAULTS.kimicuTimeoutMs, 1_000, 660_000),
    cuMaxTreeChars: asInt(input.cuMaxTreeChars, DEFAULTS.cuMaxTreeChars, 500, 60_000),

    promptSection: asBool(input.promptSection, DEFAULTS.promptSection),
    registerSkills: asBool(input.registerSkills, DEFAULTS.registerSkills),

    language: (() => {
      const raw = asText(input.language, DEFAULTS.language).toLowerCase() || DEFAULTS.language
      if (!LANGUAGES.includes(raw)) throw configError('config.languageValue', { value: JSON.stringify(input.language) })
      return raw
    })(),
    diagnostics: asBool(input.diagnostics, DEFAULTS.diagnostics),
    diagnosticsMaxKb: asInt(input.diagnosticsMaxKb, DEFAULTS.diagnosticsMaxKb, 16, 65_536),
    disabledTools: asNameList(input.disabledTools, DEFAULTS.disabledTools),
  }
  // 地址只接受 host:port；带协议前缀时剥掉，避免拼出 http://http://...
  if (config.webbridgeAddr) {
    config.webbridgeAddr = config.webbridgeAddr.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    if (!/^[^\s/:]+:\d{1,5}$/.test(config.webbridgeAddr)) {
      throw configError('config.addrShape', { value: config.webbridgeAddr })
    }
  }
  return config
}
