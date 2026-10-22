/**
 * lib/guidance.mjs —— 系统提示段
 * ============================================================================
 * 只在对应工具真的可见时输出（`ctx.tools.get(name, scope)`），否则会在关掉某条
 * 桥的 profile 里留下一段说「用 kimi_browser_*」但工具不存在的提示。
 *
 * 内容遵守 agent-experience：先说能做什么、再给最关键的三条约束（读后动、
 * 派发≠生效、不要走 shell），细节留给工具描述和 skill。
 *
 * 语言：文案走 lib/i18n.mjs 的当前语言；工具名与 daemon action 名不翻译。
 * ============================================================================
 */
import { t } from './i18n.mjs'

export function registerGuidance(ctx, config) {
  if (!config.promptSection) return () => {}

  // 用 ctx.get 而不是 ctx.systemPrompt：后者要求把 systemPrompt 写进 inject，
  // 而它是可选服务（缺了不该让整条插件不激活）。
  const systemPrompt = ctx.get('systemPrompt')
  if (!systemPrompt) return () => {}

  const visible = (scope) => {
    const hasBrowser = ctx.tools.get('kimi_browser_open', scope) !== undefined
    const hasDesktop = ctx.tools.get('kimi_cu_windows', scope) !== undefined
    return { hasBrowser, hasDesktop }
  }

  const disposer = systemPrompt.section({
    name: 'tool:kimi-bridges',
    order: systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
    text: ({ scope }) => {
      const { hasBrowser, hasDesktop } = visible(scope)
      if (!hasBrowser && !hasDesktop) return ''
      const lines = [t('guidance.header')]
      if (hasBrowser) lines.push(`- ${t('guidance.browser')}`)
      if (hasDesktop) lines.push(`- ${t('guidance.desktop')}`)
      lines.push(`- ${t('guidance.batch')}`, `- ${t('guidance.onlyTools')}`, `- ${t('guidance.statusFirst')}`)
      if (hasDesktop) lines.push(`- ${t('guidance.desktopNeedsUnlocked')}`)
      return lines.join('\n')
    },
  })
  return disposer
}
