/**
 * test/live.mjs —— 真机连通性自检（不经过宿主，也不发任何桌面输入）
 * ============================================================================
 * 跑法：node test/live.mjs
 *
 * 做什么：
 *   1. WebBridge：读 /status → 打开 example.com → aria 读取 → 截图 → 关闭会话。
 *      顺带验证中文往返（用带中文 query 的 URL）。
 *   2. KimiCU：start-agent → ping → 租约 begin → list_windows →
 *      get_window_state(text only) → end → 再 ping（证明租约释放干净）。
 *      全程只读，不点击、不输入、不激活任何窗口。
 *
 * 失败时打印可操作的下一步，退出码 1。
 * ============================================================================
 */
import { resolveConfig } from '../lib/config.mjs'
import * as wb from '../lib/webbridge.mjs'
import * as cu from '../lib/kimicu.mjs'
import { describeError } from '../lib/errors.mjs'

const config = resolveConfig({})
let failed = 0
const log = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

async function testBrowser() {
  console.log('\n== 浏览器（WebBridge）==')
  const session = 'kimi-assemble-selftest'
  try {
    const live = await wb.status(config, { force: true })
    log(live.running === true, 'daemon 在跑', `addr=${live.addr} version=${live.version ?? '?'}`)
    log(live.extension_connected === true, '扩展已连接', `extension=${live.extension_version ?? '?'}`)
    if (!live.extension_connected) return

    const opened = await wb.call(config, 'navigate', { url: 'https://example.com/?q=中文测试', newTab: true, group_title: 'Kimi 集成自检' }, { session })
    log(Boolean(opened?.tabId), 'navigate', `url=${opened?.url}`)
    // 中文往返：daemon 回显的 url 里应包含未损坏的中文
    log(String(opened?.url ?? '').includes('中文测试'), '中文 URL 往返无损', String(opened?.url ?? ''))

    const snap = await wb.call(config, 'snapshot', { format: 'aria', max_chars: 2000 }, { session })
    log(String(snap?.tree_text ?? '').length > 0, 'aria 读取', `${String(snap?.tree_text ?? '').length} 字符`)
    log(String(snap?.tree_text ?? '').includes('ref='), 'aria 带 ref 标记')

    const shot = await wb.call(config, 'screenshot', { format: 'jpeg', quality: 50 }, { session })
    log(Boolean(shot?.path), '截图落盘', `${shot?.path} (${shot?.sizeBytes ?? '?'} 字节)`)

    const closed = await wb.call(config, 'close_session', {}, { session })
    log(true, 'close_session', `closed=${closed?.closed ?? 0}`)
  } catch (error) {
    const info = describeError(error)
    log(false, '浏览器自检失败', `${info.code}: ${info.message}`)
  }
}

async function testDesktop() {
  console.log('\n== 桌面（KimiCU）==')
  try {
    const probe = await cu.probe(config)
    if (probe.error) {
      log(false, 'KimiCU 不可用', `${probe.error.code}: ${probe.error.message}`)
      return
    }
    log(true, '运行时', `${probe.exe} v${probe.runtimeVersion} pid=${probe.agentPid}`)
    log(Boolean(probe.pipe), '管道', probe.pipe)
    log(Boolean(probe.permissions), '权限', JSON.stringify(probe.permissions))

    // 只读观察：list_windows + 取第一个可读窗口的文本树
    const result = await cu.withLease(
      config,
      'dsh/selftest',
      async (call) => {
        const windows = await call('list_windows')
        const list = Array.isArray(windows) ? windows : []
        const target = list.find((item) => item.title && item.title.length > 0) ?? list[0]
        if (!target) return { list, state: null, target: null }
        const state = await call('get_window_state', { window: target, include_screenshot: false, include_text: true })
        return { list, state, target }
      },
      {},
    )
    log(result.list.length > 0, 'list_windows', `${result.list.length} 个窗口`)
    if (result.state) {
      const tree = String(result.state?.accessibility?.tree ?? '')
      log(tree.length > 0, 'get_window_state 文本', `"${result.target.title}" ${tree.length} 字符`)
      log(/\[\d+\]/.test(tree), '无障碍树带 [index] 标签')
    }

    // 租约释放：再 ping 一次应当正常（若租约没结束，Agent 会拒绝新的 begin）
    const after = await cu.ping(probe.pipe, config)
    log(Boolean(after?.version), '租约释放后可再次 ping', `v${after?.version}`)
  } catch (error) {
    const info = describeError(error)
    log(false, '桌面自检失败', `${info.code}: ${info.message}`)
  }
}

await testBrowser()
await testDesktop()

console.log(`\n真机自检：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
if (failed > 0) process.exitCode = 1
