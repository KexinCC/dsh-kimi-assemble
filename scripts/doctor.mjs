#!/usr/bin/env node
/**
 * scripts/doctor.mjs —— 环境预检 + 可自动化的那部分安装
 * ============================================================================
 * 跑法：
 *   node scripts/doctor.mjs                 # 人看的报告
 *   node scripts/doctor.mjs --json          # 机器读的结论（给 AI 用）
 *   node scripts/doctor.mjs --install-desktop   # 明确同意后才下载并运行 KimiCU 安装器
 *
 * 设计前提（都是实测结论，不是猜测）：
 *   - KimiCU 有公开安装脚本：https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd
 *     → 可以自动下载，但是否运行必须由人/代理显式同意（这里要求 --install-desktop）。
 *   - WebBridge **没有**公开安装地址（cdn 上那些猜测路径都是 403）：本地服务只能由浏览器扩展
 *     侧边栏「设置 → 本地 Agent 远程控制 → 去连接」给出的安装命令来装。
 *     → 这一步脚本做不了，只能把「去点哪里」讲清楚，并把命令留给用户执行或粘贴给代理。
 *   - 永远不静默下载并执行远程安装器：一个插件在用户机器上自动跑安装脚本是供应链事故的标准形态。
 *
 * 退出码：0 = 两条桥都可用了；2 = 还缺东西，需要人操作；3 = 只缺桌面组件，可自动安装
 * ============================================================================
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const lib = (name) => new URL(`../lib/${name}`, import.meta.url).href

const args = process.argv.slice(2)
const wantsJson = args.includes('--json')
const wantInstallDesktop = args.includes('--install-desktop')
const autoStart = args.includes('--start') || wantInstallDesktop
const addrArg = (args.find((a) => a.startsWith('--addr=')) ?? '').slice('--addr='.length)
/** 允许检查非默认 daemon 地址（也便于在测试里模拟「连不上」）。 */
const configOverrides = addrArg ? { webbridgeAddr: addrArg } : {}

const KIMI_CU_SETUP = 'https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd'
const EXTENSION_PAGE = 'https://www.kimi.com/products/kimi-browser-extension'
const FAQ_PAGE = 'https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-faq'

/** 每一项检查都产出同一种形状，好让上游（人或代理）统一处理。 */
function check(id, title, status, detail, nextActions = []) {
  return { id, title, status, detail, nextActions }
}

async function checkBrowser() {
  let webbridge
  try {
    webbridge = await import(lib('webbridge.mjs'))
  } catch (error) {
    return check('browser', 'Kimi 浏览器扩展（WebBridge）', 'unknown', `无法加载 lib/webbridge.mjs：${error.message}`)
  }
  const { resolveConfig } = await import(lib('config.mjs'))
  const config = resolveConfig(configOverrides)

  const binary = webbridge.webbridgeBinary()
  const installed = existsSync(binary)
  let daemon = null
  let error = null
  try {
    daemon = await webbridge.status(config, { force: true })
  } catch (e) {
    error = String(e?.message ?? e)
  }

  if (daemon && daemon.running && daemon.extension_connected) {
    return check('browser', 'Kimi 浏览器扩展（WebBridge）', 'ready', `daemon=${daemon.version ?? '?'} extension=${daemon.extension_version ?? '?'}`)
  }

  const actions = []
  if (!installed) {
    actions.push({
      kind: 'user',
      why: '本地服务（daemon）没装。它没有公开安装地址，只能由扩展侧边栏生成安装命令。',
      steps: [
        `在 Chrome 或 Edge 安装「Kimi」扩展：${EXTENSION_PAGE}`,
        '打开扩展侧边栏 → 设置 → 「本地 Agent 远程控制」→ 点「去连接」',
        '把弹窗里给出的安装命令复制到终端执行（macOS/Linux 与 Windows 各一条，会自动下载本地服务）',
        '回到「连接状态」确认已连接',
      ],
      url: EXTENSION_PAGE,
      help: FAQ_PAGE,
    })
  } else if (!daemon?.running) {
    actions.push({
      kind: 'run',
      why: '本地服务已安装但没在运行。',
      command: `"${binary}" start`,
      retry: true,
    })
  } else if (!daemon?.extension_connected) {
    actions.push({
      kind: 'user',
      why: 'daemon 在跑，但浏览器扩展没连上。',
      steps: [
        '确认装了扩展的 Chrome/Edge 正在运行',
        '打开扩展侧边栏 → 设置 → 「本地 Agent 远程控制」→ 看「连接状态」，未连接就点「去连接」',
        `连接地址必须是 ws://<daemon 地址>/ws，默认 ${config.webbridgeAddr || '127.0.0.1:10086'}`,
      ],
      help: FAQ_PAGE,
    })
  }

  return check(
    'browser',
    'Kimi 浏览器扩展（WebBridge）',
    installed ? 'partial' : 'missing',
    installed ? `daemon 已安装${daemon?.running ? '、在运行' : '、未运行'}${error ? `（${error.slice(0, 120)}）` : ''}` : `未找到 ${binary}`,
    actions,
  )
}

async function checkDesktop() {
  if (process.platform !== 'win32') {
    return check('desktop', 'KimiCU（Windows 桌面）', 'skipped', '非 Windows 平台，桌面工具不会注册')
  }
  let kimicu
  let config
  try {
    kimicu = await import(lib('kimicu.mjs'))
    const { resolveConfig } = await import(lib('config.mjs'))
    config = resolveConfig(configOverrides)
  } catch (error) {
    return check('desktop', 'KimiCU（Windows 桌面）', 'unknown', `无法加载 lib/kimicu.mjs：${error.message}`)
  }

  let exe = ''
  try {
    exe = await kimicu.resolveExe(config)
  } catch {
    exe = ''
  }
  if (!exe) {
    return check('desktop', 'KimiCU（Windows 桌面）', 'missing', '没有找到 kimi-cu.exe', [
      {
        kind: 'run',
        why: 'KimiCU 有公开安装脚本，可以在用户同意后自动下载并运行。',
        command: `node scripts/doctor.mjs --install-desktop`,
        manual: `下载 ${KIMI_CU_SETUP} 并运行`,
        consent: '会从 cdn.kimi.com 下载一个 .cmd 并执行它；安装过程可能有 GUI 弹窗',
        url: KIMI_CU_SETUP,
      },
    ])
  }

  let probe
  try {
    probe = await kimicu.probe(config, { autoStart })
  } catch (error) {
    return check('desktop', 'KimiCU（Windows 桌面）', 'partial', `已安装 ${exe}，但探测失败：${String(error?.message ?? error).slice(0, 160)}`, [
      { kind: 'run', why: '尝试幂等启动 agent。', command: `"${exe}" start-agent` },
    ])
  }

  if (probe?.error) {
    const code = probe.error.code ?? ''
    return check('desktop', 'KimiCU（Windows 桌面）', 'partial', `已安装 ${probe.exe || exe}，agent 未就绪（${code || probe.error.message}）`, [
      { kind: 'run', why: '幂等启动 agent，不会影响其他会话。', command: `"${probe.exe || exe}" start-agent` },
    ])
  }

  return check('desktop', 'KimiCU（Windows 桌面）', 'ready', `runtime=${probe.runtimeVersion ?? '?'} agentPid=${probe.agentPid ?? '?'}`)
}

async function installDesktop() {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-cu-setup-'))
  const file = join(dir, 'setup_windows.cmd')
  console.log(`下载 ${KIMI_CU_SETUP} …`)
  const res = await fetch(KIMI_CU_SETUP)
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(file, buf)
  console.log(`已保存 ${file}（${buf.length} 字节），开始执行…`)
  try {
    const { stdout, stderr } = await execFileAsync('cmd.exe', ['/c', file], { timeout: 10 * 60_000, windowsHide: false })
    if (stdout?.trim()) console.log(stdout.trim())
    if (stderr?.trim()) console.error(stderr.trim())
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  console.log('安装器已退出。重新跑一次 doctor 确认状态。')
}

function render(report) {
  const icon = { ready: '✓', partial: '!', missing: '✗', skipped: '-', unknown: '?' }
  const lines = ['Kimi 组件预检', '']
  for (const item of report.checks) {
    lines.push(`${icon[item.status] ?? '?'} ${item.title} —— ${item.status}`)
    if (item.detail) lines.push(`    ${item.detail}`)
    for (const action of item.nextActions) {
      lines.push(`    → [${action.kind}] ${action.why}`)
      if (action.command) lines.push(`      ${action.command}`)
      if (action.manual) lines.push(`      ${action.manual}`)
      for (const step of action.steps ?? []) lines.push(`      · ${step}`)
      if (action.url) lines.push(`      ${action.url}`)
      if (action.help) lines.push(`      帮助：${action.help}`)
    }
  }
  lines.push('')
  lines.push(report.ready ? '两条桥都可用，可以开始用 kimi_* 工具了。' : '还有东西没就绪，按上面的 → 处理，处理完再跑一次。')
  return lines.join('\n')
}

async function main() {
  const checks = []
  checks.push(await checkBrowser())
  checks.push(await checkDesktop())

  const ready = checks.every((c) => c.status === 'ready' || c.status === 'skipped')
  const needsInstall = checks.some((c) => c.nextActions.some((a) => a.command?.includes('--install-desktop')))

  if (wantInstallDesktop && checks.find((c) => c.id === 'desktop')?.status === 'missing') {
    await installDesktop()
    const after = await checkDesktop()
    checks[checks.indexOf(checks.find((c) => c.id === 'desktop'))] = after
  }

  const report = {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ready,
    checks,
    installers: { desktop: KIMI_CU_SETUP, extension: EXTENSION_PAGE, help: FAQ_PAGE },
  }

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(render(report))
  }

  if (ready) process.exitCode = 0
  else process.exitCode = needsInstall ? 3 : 2
}

await main()
