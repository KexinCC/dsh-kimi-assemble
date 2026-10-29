/**
 * lib/verify.mjs —— 动作校验的分级与统一状态语义
 * ============================================================================
 * 两个问题，一个模块解决：
 *
 * 1) **校验不分级太贵。** 实测：click 带校验 674ms、不带 18ms（差 37 倍），而 600ms 的观察
 *    窗口对「滚动一下」「悬停一下」毫无意义。所以按**动作的可逆性**分级：
 *      strict  —— 不可逆或高风险（提交/删除/付款）：完整观察窗口 + 失败重读
 *      normal  —— 可能改变页面（普通点击、填表、导航）：完整窗口
 *      light   —— 可逆、几乎必然「没有变化」的动作（滚动/悬停/设置复选框）：不观察
 *      off     —— 明确关闭
 *    分级只看动作性质，不看快慢 —— 分类错了会拿静默失败换速度，那是赔本买卖。
 *
 * 2) **两个桥的返回语义不一致。** 浏览器返回 changed:true/false，桌面只能返回
 *    dispatched:true（KimiCU 没法确认），模型于是把「发出去了」当成「做完了」。统一成：
 *      verified   —— 已确认生效
 *      unchanged  —— 确认没变化（不是失败，是「点了没反应」）
 *      dispatched —— 已发出，无法确认（桌面侧的诚实说法）
 *      blocked    —— 被阻断（原生弹窗 / 权限 / 窗口失效）
 * ============================================================================
 */

/** 统一状态语义 */
export const STATUS = Object.freeze({
  VERIFIED: 'verified',
  UNCHANGED: 'unchanged',
  DISPATCHED: 'dispatched',
  BLOCKED: 'blocked',
})

/** 校验分级 */
export const TIERS = Object.freeze({
  STRICT: 'strict',
  NORMAL: 'normal',
  LIGHT: 'light',
  OFF: 'off',
})

/**
 * 不需要观察变化的动作：可逆、幂等或本来就只是「输入一个值」。
 * 注意 evaluate / snapshot 这类读操作走的是另一条路径（runVerified 不参与）。
 */
const LIGHT_ACTIONS = new Set([
  'scroll',
  'hover',
  'mouse_click',
  'key_type',
  'send_keys',
  'set_checked',
  'select_option',
  'upload',
  'highlight_region',
  'clear_highlight',
  'inspect_region',
  'go_back',
  'go_forward',
  'reload',
  'cdp',
])

/** 高风险目标的特征词：命中就升级成 strict（中英都覆盖） */
const RISKY_TARGET = /submit|delete|remove|destroy|send|publish|pay|purchase|buy|order|confirm|save|apply|reset|logout|transfer|cancel|提交|保存|删除|移除|发送|发布|支付|付款|购买|下单|确认|注销|退出|重置|转账|取消/i

/**
 * 判定一次动作该用哪一级校验。
 *
 * @param {string} action 动作名（click / fill / scroll …）
 * @param {object} args 动作参数
 * @param {{browserVerify?: string, browserVerifyMs?: number, browserVerifyLightMs?: number}} config
 * @returns {{tier: string, budgetMs: number, reason: string}}
 */
export function classifyVerify(action, args, config = {}) {
  const normalBudget = Number.isFinite(config.browserVerifyMs) ? config.browserVerifyMs : 600
  const lightBudget = Number.isFinite(config.browserVerifyLightMs) ? config.browserVerifyLightMs : 0

  if (config.browserVerify === 'off') return { tier: TIERS.OFF, budgetMs: 0, reason: 'config-off' }

  // 显式覆盖优先：true / false / 'strict' / 'light' / 'normal' / 'off'
  const explicit = args?.verify
  if (explicit === false || explicit === 'off') return { tier: TIERS.OFF, budgetMs: 0, reason: 'explicit-off' }
  if (explicit === true || explicit === 'strict' || explicit === 'normal') {
    return { tier: TIERS.STRICT, budgetMs: Math.max(normalBudget, 100), reason: 'explicit-strict' }
  }
  if (explicit === 'light') return { tier: TIERS.LIGHT, budgetMs: lightBudget, reason: 'explicit-light' }

  if (LIGHT_ACTIONS.has(action)) return { tier: TIERS.LIGHT, budgetMs: lightBudget, reason: 'action-reversible' }

  // 表单提交、命中风险词的目标 → 严格
  const hint = String(args?.selector ?? args?.text ?? args?.name ?? '') + (args?.submit ? ' submit' : '')
  if (args?.submit === true || RISKY_TARGET.test(hint)) {
    return { tier: TIERS.STRICT, budgetMs: Math.max(normalBudget, 100), reason: 'risky-target' }
  }

  return { tier: TIERS.NORMAL, budgetMs: normalBudget, reason: 'default' }
}

/**
 * 把各条桥的原始结果折算成统一状态。
 *
 * @param {{dialogBlocked?: string|null, dispatched?: boolean, checked?: boolean, changed?: boolean|null}} input
 * @returns {string} STATUS.* 之一
 */
export function statusFor({ dialogBlocked, dispatched, checked, changed } = {}) {
  if (dialogBlocked) return STATUS.BLOCKED
  if (checked === true) return changed === true ? STATUS.VERIFIED : STATUS.UNCHANGED
  if (dispatched) return STATUS.DISPATCHED
  return STATUS.DISPATCHED
}

/** 给人/模型看的一句话（由 i18n 提供文案，这里只做映射键） */
export function statusKey(status) {
  switch (status) {
    case STATUS.VERIFIED:
      return 'status.verified'
    case STATUS.UNCHANGED:
      return 'status.unchanged'
    case STATUS.BLOCKED:
      return 'status.blocked'
    default:
      return 'status.dispatched'
  }
}
