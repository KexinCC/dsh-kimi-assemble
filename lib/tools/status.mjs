/**
 * lib/tools/status.mjs —— kimi_status
 * ============================================================================
 * 所有连接类失败后的第一站：一次调用同时报告两条桥的实况，并把「下一步」写
 * 在同一个返回值里，避免模型拿着一个错误码去猜。
 * ============================================================================
 */
import { defineTool, objectSchema, boolField, textBlock } from '../tool.mjs'
import { status as webbridgeStatus, webbridgeBinary, webbridgeHome, resolveAddr } from '../webbridge.mjs'
import { probe as cuProbe } from '../kimicu.mjs'
import { describeError } from '../errors.mjs'
import { t } from '../i18n.mjs'
import { existsSync } from 'node:fs'

export function createStatusTool({ config }) {
  return defineTool({
    name: 'kimi_status',
    description:
      'Report the live state of both local Kimi bridges: the browser extension daemon (WebBridge) and the Windows desktop agent (KimiCU). ' +
      'Call this first whenever a kimi_browser_* or kimi_cu_* call fails with a connection/readiness error, instead of retrying the same call.',
    parameters: objectSchema({
      deep: boolField('Also probe the desktop agent end-to-end (starts it if needed). Default false: only reads the last known state cheaply.', {
        default: false,
      }),
    }),
    outputSchema: { type: 'object', additionalProperties: true, properties: {} },
    async execute(args) {
      // 三态判定用的「装没装」探针：
      //   browser.installed  —— 官方安装器会落地 ~/.kimi-webbridge/bin/kimi-webbridge(.exe)
      //   desktop.installed  —— probe 已经按候选路径找过 kimi-cu.exe，error.code 即答案
      const browser = {
        enabled: config.webbridgeEnabled,
        installed: existsSync(webbridgeBinary()),
        addr: '',
        running: false,
        extensionConnected: false,
        extensionVersion: '',
        daemonVersion: '',
        binary: webbridgeBinary(),
        error: null,
      }
      if (config.webbridgeEnabled) {
        try {
          browser.addr = await resolveAddr(config)
          const live = await webbridgeStatus(config, { force: true })
          browser.running = live.running === true
          browser.extensionConnected = live.extension_connected === true
          browser.extensionVersion = String(live.extension_version ?? '')
          browser.daemonVersion = String(live.version ?? '')
        } catch (error) {
          browser.error = describeError(error)
          browser.addr = browser.addr || (await resolveAddr(config))
        }
      }

      const desktop = config.kimicuEnabled
        ? await cuProbe(config, { autoStart: args.deep === true })
        : { enabled: false, supported: process.platform === 'win32', error: null }
      desktop.installed = desktop.error ? desktop.error.code !== 'KIMI_CU_NOT_INSTALLED' : true

      const hints = []
      if (config.webbridgeEnabled) {
        if (!browser.installed) {
          // 真正的 missing：连二进制都没有 —— 给的是安装三步，不是排障步骤
          hints.push(t('status.browserNotInstalled', { page: t('err.helpWebbridge'), faq: t('err.helpWebbridgeFaq') }))
        } else if (browser.error) {
          hints.push(t('status.hintBrowserDown', { binary: webbridgeBinary(), addrFile: `${webbridgeHome()}\\daemon.addr` }))
        } else if (!browser.extensionConnected) {
          hints.push(t('status.hintBrowserExtension'))
        }
      }
      if (config.kimicuEnabled && desktop.error) {
        const code = desktop.error.code
        if (code === 'KIMI_CU_NOT_INSTALLED') {
          hints.push(t('status.desktopNotInstalled', { url: t('err.helpCuSetup') }))
        } else if (code === 'KIMI_CU_AGENT_START_FAILED') {
          hints.push(t('status.hintCuAgent', { exe: desktop.exe || 'kimi-cu.exe' }))
        } else if (code === 'KIMI_CU_RUNTIME_TOO_OLD') {
          hints.push(t('status.hintCuOld'))
        } else if (code === 'KIMI_UNSUPPORTED_PLATFORM') {
          hints.push(t('status.hintCuPlatform'))
        } else {
          hints.push(t('status.hintCuOther', { message: desktop.error.message }))
        }
      }

      const browserLabel = !browser.installed
        ? t('status.browserLabelNotInstalled')
        : browser.error
          ? t('status.browserDown')
          : browser.running
            ? browser.extensionConnected
              ? t('status.browserReady')
              : t('status.browserNoExtension')
            : t('status.browserDown')
      const desktopLabel = desktop.enabled === false
        ? t('status.desktopOff')
        : desktop.error?.code === 'KIMI_CU_NOT_INSTALLED'
          ? t('status.desktopLabelNotInstalled')
          : desktop.error
            ? t('status.desktopDown')
            : t('status.desktopReady')
      const summary = `${browserLabel}${t('status.join')}${desktopLabel}`

      return { summary, browser, desktop, hints }
    },
    render(value) {
      const lines = [value.summary]
      const b = value.browser
      lines.push(
        t('status.browserLine', {
          enabled: b.enabled,
          installed: b.installed,
          addr: b.addr || t('status.unresolved'),
          running: b.running,
          extensionConnected: b.extensionConnected,
          daemonVersion: b.daemonVersion ? ` daemon=${b.daemonVersion}` : '',
          extensionVersion: b.extensionVersion ? ` extension=${b.extensionVersion}` : '',
          error: b.error ? ` error=${b.error.code}: ${b.error.message}` : '',
        }),
      )
      const d = value.desktop
      lines.push(
        t('status.desktopLine', {
          enabled: d.enabled ?? true,
          installed: d.installed ?? true,
          supported: d.supported,
          exe: d.exe || t('status.notFound'),
          runtimeVersion: d.runtimeVersion || t('status.unknown'),
          agentPid: d.agentPid ?? t('status.unknown'),
          pipe: d.pipe || t('status.unknown'),
          permissions: d.permissions ? ` permissions=${JSON.stringify(d.permissions)}` : '',
          error: d.error ? ` error=${d.error.code}: ${d.error.message}` : '',
        }),
      )
      for (const hint of value.hints) lines.push(t('status.next', { hint }))
      return [textBlock(lines.join('\n'))]
    },
  })
}
