/**
 * lib/tools/index.mjs —— 汇总注册所有工具
 * ============================================================================
 * 注册顺序决定模型看到的顺序：先 status（诊断），再浏览器，再桌面。
 * 每条桥按配置开关；关掉就不注册，也不留提示词。
 * 另外按 `disabledTools` 精确下线个别工具（例如只想用浏览器、不想让模型碰桌面）。
 * ============================================================================
 */
import { createStatusTool } from './status.mjs'
import { createBrowserTools } from './browser.mjs'
import { createComputerTools } from './computer.mjs'
import { t } from '../i18n.mjs'

/**
 * 构造工具列表（不注册）。
 * @param {{config: object, ctx: import('@deepseek-ai/cordis').Context}} options
 * @returns {Array<object>} 工具定义
 */
export function buildTools({ config, ctx }) {
  const tools = [createStatusTool({ config })]
  if (config.webbridgeEnabled) tools.push(...createBrowserTools({ config, ctx }))
  if (config.kimicuEnabled) tools.push(...createComputerTools({ config, ctx }))

  const disabled = Array.isArray(config.disabledTools) ? config.disabledTools : []
  if (disabled.length === 0) return tools

  const available = tools.map((tool) => tool.name)
  const unknown = disabled.filter((name) => !available.includes(name))
  if (unknown.length > 0) {
    ctx.logger?.warn?.(
      unknown.map((name) => t('log.unknownDisabledTool', { name, available: available.join(', ') })).join('; '),
    )
  }
  const kept = tools.filter((tool) => !disabled.includes(tool.name))
  if (ctx.logger?.info) {
    const removed = tools.length - kept.length
    if (removed > 0) {
      ctx.logger.info(
        t('log.disabledTools', {
          names: tools.filter((tool) => disabled.includes(tool.name)).map((tool) => tool.name).join(', '),
        }),
      )
    }
  }
  return kept
}

/**
 * 注册工具并返回 disposers。
 * @param {{config: object, ctx: import('@deepseek-ai/cordis').Context}} options
 */
export function registerTools({ config, ctx }) {
  const disposers = []
  for (const tool of buildTools({ config, ctx })) {
    disposers.push(ctx.tools.register(tool))
  }
  return disposers
}

export { createStatusTool, createBrowserTools, createComputerTools }
