/**
 * dsh-kimi-assemble —— 把 Kimi 浏览器扩展（WebBridge）与 KimiCU 桌面控制
 * ============================================================================
 * 干什么：在 DSH Host 进程里直连两条本地能力，注册成原生工具
 *   - kimi_browser_*  → http://127.0.0.1:10086（Kimi 扩展 daemon）
 *   - kimi_cu_*       → \\.\pipe\kimi-cu-win-<user>（KimiCU native Agent）
 *   - kimi_status     → 一次说清两条桥的实况与下一步
 *
 * 为什么是 Host 插件而不是 MCP：
 *   1. 能直接用 ctx.attachments 把截图变成对话里的图片块；
 *   2. 能按当前模型路由判断是否支持图片，避免适配器炸；
 *   3. 能注册系统提示段与同名 skill，把「不要走 curl」这条规则钉死在上下文里；
 *   4. 工具名不带 mcp__ 前缀，参数校验与错误文案完全自己掌控。
 *
 * 不碰的东西：daemon 与 CU Agent 是共享资源，插件卸载只关自己的 socket，
 * 绝不 stop/restart/uninstall 它们。
 * ============================================================================
 */
import { resolveConfig } from './lib/config.mjs'
import { configureI18n, t } from './lib/i18n.mjs'
import { registerGuidance } from './lib/guidance.mjs'
import { installSkillRegistrations } from './lib/skills.mjs'
import { registerTools } from './lib/tools/index.mjs'
import { resetAddrCache } from './lib/webbridge.mjs'
import { resetState as resetCuState } from './lib/kimicu.mjs'

export const name = 'kimi-assemble'

/** 版本标记：写进日志，方便确认 HMR 是否加载到新代码。 */
export const VERSION = '1.0.0'

/**
 * 缺 tools 就没法注册工具；其余服务（attachments/llm/skills/systemPrompt）都是可选的，
 * 但通过 ctx.get(...) 访问 —— 写进 inject 会在缺服务时让整条插件不激活。
 */
export const inject = ['tools']

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // 语言必须先定：后面所有注册（工具渲染、提示段、skill 正文）都会用到
  const language = configureI18n(config)
  const log = (message) => {
    try {
      ctx.logger?.info?.(`kimi-assemble: ${message}`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  log(
    t('log.loaded', {
      version: VERSION,
      browser: config.webbridgeEnabled ? 'on' : 'off',
      desktop: config.kimicuEnabled ? 'on' : 'off',
      lang: language,
    }),
  )

  // 工具注册
  ctx.effect(() => {
    const disposers = registerTools({ config, ctx })
    log(t('log.tools', { count: disposers.length }))
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* 单个工具卸载失败不阻断其它 */
        }
      }
    }
  }, 'kimi-assemble.tools')

  // 系统提示段（只在工具可见时输出内容）
  ctx.effect(() => registerGuidance(ctx, config), 'kimi-assemble.guidance')

  // 同名 runtime skill：顶掉教模型用 curl / js cell 的旧 skill。
  // 必须挂在 agent scope 上（preset 层），全局注册会被 preset 层的用户级同名 skill 盖掉。
  ctx.effect(() => installSkillRegistrations(ctx, config), 'kimi-assemble.skills')

  // 卸载时清掉进程内缓存（地址/管道），避免下次重载用到过期值
  ctx.effect(() => () => {
    resetAddrCache()
    resetCuState()
  }, 'kimi-assemble.cache')
}
