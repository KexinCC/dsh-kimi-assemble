/**
 * test/bench.mjs —— 延迟基准（只读，不发任何桌面输入）
 * ============================================================================
 * 跑法：node test/bench.mjs
 *
 * 拆开量每一层的耗时，回答「慢在哪」：
 *   HTTP: /status、command 往返、aria 读取、截图
 *   CU  : ping、list_windows、get_window、get_window_state(文本/带图)
 *   租约: 一次 begin+call+end 的固定开销
 *   工具层: 现在的 observe 路径 vs 优化后的 observe 路径
 *   附件: dataURL → saveImage 的本地开销
 * ============================================================================
 */
import { resolveConfig } from '../lib/config.mjs'
import * as wb from '../lib/webbridge.mjs'
import * as cu from '../lib/kimicu.mjs'

const config = resolveConfig({})
const rows = []

/** 跑 n 次取中位数与 min/max。 */
async function bench(label, fn, n = 5) {
  const times = []
  let last
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    try {
      last = await fn(i)
    } catch (error) {
      rows.push({ label, error: error.message.slice(0, 80) })
      return
    }
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  rows.push({
    label,
    median: times[Math.floor(times.length / 2)],
    min: times[0],
    max: times[times.length - 1],
    n: times.length,
    sample: last,
  })
}

function print() {
  console.log('\n标签'.padEnd(46) + '中位'.padStart(9) + 'min'.padStart(9) + 'max'.padStart(9))
  console.log('-'.repeat(74))
  for (const row of rows) {
    if (row.error) {
      console.log(`${row.label.padEnd(46)}   FAILED: ${row.error}`)
      continue
    }
    console.log(
      row.label.padEnd(46) + `${row.median.toFixed(1)}ms`.padStart(9) + `${row.min.toFixed(1)}`.padStart(9) + `${row.max.toFixed(1)}`.padStart(9),
    )
  }
}

// ---------------------------------------------------------------- HTTP 层
wb.resetAddrCache()
await bench('HTTP /status（强制刷新）', () => wb.status(config, { force: true }), 5)
await bench('HTTP /status（命中 2s 缓存）', () => wb.status(config), 20)

const session = 'kimi-bench'
await wb.call(config, 'navigate', { url: 'https://example.com', newTab: true, group_title: '基准测试' }, { session })

await bench('HTTP POST snapshot(aria, 4000)', () => wb.call(config, 'snapshot', { format: 'aria', max_chars: 4000 }, { session }), 5)
await bench('HTTP POST screenshot(png)', () => wb.call(config, 'screenshot', { format: 'png' }, { session }), 5)
await bench('HTTP POST evaluate', () => wb.call(config, 'evaluate', { code: '(() => 1 + 1)()' }, { session }), 5)
await bench('HTTP POST navigate(同页)', () => wb.call(config, 'navigate', { url: 'https://example.com', newTab: false }, { session }), 3)
await bench('HTTP POST list_tabs', () => wb.call(config, 'list_tabs', {}, { session }), 5)

// 工具层：open = navigate + list_tabs
await bench('工具路径 kimi_browser_open 等价（navigate+list_tabs）', async () => {
  const opened = await wb.call(config, 'navigate', { url: 'https://example.com', newTab: true, group_title: '基准测试' }, { session })
  await wb.call(config, 'list_tabs', {}, { session })
  return opened
}, 3)

// 工具层：read = status(缓存) + snapshot
await bench('工具路径 kimi_browser_read 等价', async () => {
  await wb.status(config)
  return wb.call(config, 'snapshot', { format: 'aria', max_chars: 4000 }, { session })
}, 5)

await wb.call(config, 'close_session', {}, { session }).catch(() => {})

// ---------------------------------------------------------------- CU 层
cu.resetState()
await bench('CU 首次 ensureAgent（start-agent 冷启动）', () => cu.probe(config, { autoStart: true }), 1)
await bench('CU ping（每次 new 连接）', async (index) => {
  const p = await cu.resolveExe(config)
  void p
  const probe = await cu.probe(config, { autoStart: false })
  return cu.ping(probe.pipe, config)
}, 5)

const probe = await cu.probe(config, { autoStart: true })
const pipe = probe.pipe
const windows = await cu.withLease(config, 'dsh/bench', (call) => call('list_windows'), {})

/** 挑一个真的能截图的窗口（输入法宿主等窗口 WGC 抓不到）。 */
async function pickCapturableWindow() {
  const candidates = windows.filter((w) => w.title && w.id && !/Text Input|ApplicationFrameHost/i.test(`${w.title} ${w.app}`))
  for (const candidate of candidates.slice(0, 6)) {
    try {
      const state = await cu.withLease(config, 'dsh/bench', (call) =>
        call('get_window_state', { window: candidate, include_screenshot: true, include_text: false }), {})
      if (state?.screenshots?.[0]?.url) return candidate
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('没有可截图的窗口，基准无法进行（请打开一个普通应用窗口）')
}
const target = await pickCapturableWindow()
console.log(`基准窗口：${target.title}（id=${target.id}）`)

await bench('CU list_windows（一次租约内）', () => cu.withLease(config, 'dsh/bench', (call) => call('list_windows'), {}), 5)
await bench('CU get_window({id})（一次租约内）', () => cu.withLease(config, 'dsh/bench', (call) => call('get_window', { id: target.id }), {}), 5)
await bench('CU get_window_state 纯文本（一次租约内）', () =>
  cu.withLease(config, 'dsh/bench', (call) => call('get_window_state', { window: target, include_screenshot: false, include_text: true }), {}), 5)
await bench('CU get_window_state 带截图（一次租约内）', () =>
  cu.withLease(config, 'dsh/bench', (call) => call('get_window_state', { window: target, include_screenshot: true, include_text: true }), {}), 5)

// 租约固定开销：空 body（只有 begin+end）
await bench('CU 租约固定开销（begin+end，无调用）', () => cu.withLease(config, 'dsh/bench', async () => true, {}), 8)

// 当前 observe 路径：list_windows + get_window_state(带图)，同租约
await bench('当前 kimi_cu_observe 路径（list_windows+gws+图）', () =>
  cu.withLease(config, 'dsh/bench', async (call) => {
    const list = await call('list_windows')
    const win = list.find((w) => w.id === target.id) ?? list[0]
    return call('get_window_state', { window: win, include_screenshot: true, include_text: true })
  }, {}), 3)

// 优化路径：get_window(id) + get_window_state(带图)，同租约
await bench('优化后 observe 路径（get_window+gws+图）', () =>
  cu.withLease(config, 'dsh/bench', async (call) => {
    const win = await call('get_window', { id: target.id })
    return call('get_window_state', { window: win, include_screenshot: true, include_text: true })
  }, {}), 3)

// ---------------------------------------------------------------- 附件层
const state = await cu.withLease(config, 'dsh/bench', (call) =>
  call('get_window_state', { window: target, include_screenshot: true, include_text: false }), {})
const dataUrl = state?.screenshots?.[0]?.url ?? ''

await bench('附件 dataURL 解码（base64 → Buffer）', async () => {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
  return Buffer.from(m[2], 'base64').length
}, 5)

print()

// ---------------------------------------------------------------- 结论摘要
const get = (label) => rows.find((r) => r.label === label)
const lease = get('CU 租约固定开销（begin+end，无调用）')?.median ?? 0
const listWin = get('CU list_windows（一次租约内）')?.median ?? 0
const getWin = get('CU get_window({id})（一次租约内）')?.median ?? 0
const gwsText = get('CU get_window_state 纯文本（一次租约内）')?.median ?? 0
const gwsShot = get('CU get_window_state 带截图（一次租约内）')?.median ?? 0

console.log('\n== 拆解 ==')
console.log(`租约固定开销（begin+end）            ≈ ${lease.toFixed(0)} ms —— 每次 CU 工具调用都要付`)
console.log(`list_windows（含租约）               ≈ ${listWin.toFixed(0)} ms  → 净 ≈ ${(listWin - lease).toFixed(0)} ms`)
console.log(`get_window（含租约）                 ≈ ${getWin.toFixed(0)} ms  → 净 ≈ ${(getWin - lease).toFixed(0)} ms`)
console.log(`get_window_state 纯文本（含租约）     ≈ ${gwsText.toFixed(0)} ms  → 净 ≈ ${(gwsText - lease).toFixed(0)} ms`)
console.log(`get_window_state 带截图（含租约）     ≈ ${gwsShot.toFixed(0)} ms  → 净 ≈ ${(gwsShot - lease).toFixed(0)} ms`)
console.log(`\n当前 observe = list_windows + gws带图 + 租约`)
console.log(`可省：用 id 直查（get_window）替代 list_windows ≈ 省 ${Math.max(0, listWin - getWin).toFixed(0)} ms`)
console.log(`可省：跨调用复用租约 ≈ 省 ${lease.toFixed(0)} ms/次`)
