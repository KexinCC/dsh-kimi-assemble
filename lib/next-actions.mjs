/**
 * lib/next-actions.mjs —— 失败时把「下一步」直接塞进错误体
 * ============================================================================
 * 为什么：首次安装失败时，用户（或代理）看到的是 "daemon unreachable" 这种
 * 判决书，而不是动作。再让他们去读 README、再跑一个 doctor 工具，中间就掉人了。
 *
 * 做法：错误体尾部追加一段**人可读 + 机可读**的下一步：
 *   [next] start the WebBridge service, then reload the Kimi extension
 *     run: node "…/scripts/doctor.mjs" --json
 *     {"next_actions":[{"kind":"run","label":"…","cmd":"…"}],"doc":"…"}
 *
 * 关键约定（与 doctor.mjs 一致）：
 *   kind="run"  → 代理/脚本可以直接执行
 *   kind="user" → 只有人能做（装扩展、点授权、重启浏览器）
 * ============================================================================
 */
import { fileURLToPath } from 'node:url'
import { t } from './i18n.mjs'

/** doctor 脚本的绝对路径（本包自带，发布包里也有） */
export function doctorPath() {
  return fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url))
}

/** 可以直接粘进终端的 doctor 调用 */
export function doctorCommand(json = true) {
  const flag = json ? ' --json' : ''
  return process.platform === 'win32'
    ? `node "${doctorPath()}"${flag}`
    : `node '${doctorPath()}'${flag}`
}

const DOC_URL = 'https://github.com/KexinCC/dsh-kimi-assemble#install'

/**
 * 按错误码给出下一步。
 * @param {string} code KIMI_* 错误码
 * @returns {{summary: string, actions: Array<{kind: 'run'|'user', label: string, cmd?: string}>}}
 */
export function nextActionsFor(code) {
  const doctor = { kind: 'run', label: t('next.runDoctor'), cmd: doctorCommand(true) }
  switch (code) {
    case 'KIMI_WEBRIDGE_DOWN':
      return {
        summary: t('next.browserDown'),
        actions: [
          doctor,
          { kind: 'user', label: t('next.startDaemon') },
          { kind: 'user', label: t('next.reloadExtension') },
        ],
      }
    case 'KIMI_WEBRIDGE_EXTENSION':
    case 'KIMI_WEBRIDGE_VERSION':
      return {
        summary: t('next.extensionMissing'),
        actions: [doctor, { kind: 'user', label: t('next.installExtension') }, { kind: 'user', label: t('next.reloadExtension') }],
      }
    case 'KIMI_WEBRIDGE_PORT_BUSY':
      return {
        summary: t('next.portBusy'),
        actions: [doctor, { kind: 'user', label: t('next.freePort') }],
      }
    case 'KIMI_CU_NOT_INSTALLED':
      return {
        summary: t('next.desktopMissing'),
        actions: [
          { kind: 'run', label: t('next.installDesktop'), cmd: `${doctorCommand(true)} --install-desktop` },
          doctor,
        ],
      }
    case 'KIMI_CU_BUSY':
    case 'KIMI_CU_TIMEOUT':
      return {
        summary: t('next.desktopBusy'),
        actions: [doctor, { kind: 'user', label: t('next.unlockDesktop') }],
      }
    case 'KIMI_UNSUPPORTED_PLATFORM':
      return {
        summary: t('next.unsupported'),
        actions: [{ kind: 'user', label: t('next.needWindows') }],
      }
    default:
      return { summary: '', actions: [] }
  }
}

/**
 * 把下一步渲染成一段可追加到错误消息尾部的文本（含机可读 JSON 行）。
 * 没有对应建议时返回空字符串 —— 不要给错误加噪音。
 */
export function formatNextActions(code) {
  const { summary, actions } = nextActionsFor(code)
  if (actions.length === 0) return ''
  const lines = []
  if (summary) lines.push(`[next] ${summary}`)
  for (const action of actions) {
    if (action.kind === 'run' && action.cmd) {
      lines.push(`  run:  ${action.cmd}`)
    } else {
      lines.push(`  user: ${action.label}`)
    }
  }
  // 机可读的一行：代理可以直接解析，不用猜自然语言
  lines.push(
    `  ${JSON.stringify({
      next_actions: actions.map((a) => (a.kind === 'run' ? { kind: 'run', label: a.label, cmd: a.cmd } : { kind: 'user', label: a.label })),
      doc: DOC_URL,
    })}`,
  )
  return lines.join('\n')
}
