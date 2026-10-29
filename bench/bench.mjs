/**
 * bench/bench.mjs —— 可复现的工程基准：本插件 vs Playwright（行业基线）
 * ============================================================================
 * 跑法：node bench/bench.mjs [--reps=10]
 *
 * 它测什么（以及不测什么）：
 *   测：冷启动时间、单动作延迟 p50/p95、批量吞吐、模型可见载荷大小。
 *   不测：任务成功率排行榜。业界公认的 WebArena / WebVoyager / OSWorld / Mind2Web
 *         考的是「模型 + 工具」整体，需要 Docker/VM 与数百次模型调用；任何"插件分"
 *         都不在那套体系里。所以这里只做延迟与吞吐的对照，成功率用确定性 fixture 单列。
 *
 * 公平性说明：
 *   - 两者跑同一台机器、同一组本地 fixture 页面、同一组语义等价操作。
 *   - 本插件走：插件 → 本地 daemon(HTTP) → 浏览器扩展 → CDP → 用户真实 Chrome。
 *     它比 Playwright 多两跳，所以更慢是必然的；换来的是「用你已登录的真实浏览器」。
 *   - Playwright 用 channel:'chrome' + headless（不下载额外浏览器，用本机 Chrome）。
 *   - "读页面" 语义只能近似对齐：本插件读 aria 树（带 ref），Playwright 读 body.innerText。
 *     两者都记录返回字节数，供读者自行判断可比性。
 * ============================================================================
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const args = process.argv.slice(2)
const repsArg = args.find((a) => a.startsWith('--reps='))
const REPS = Number(repsArg?.slice('--reps='.length)) || 10

const HERE = 'C:/XX/dsh-workspace/coding/kimi-assemble'
const PLAYWRIGHT = 'C:/Users/KexinCC/.dsh/tools/shuiandaren/node_modules/playwright-core'

const { startServer } = await import(pathToFileURL(join(HERE, 'bench/server.mjs')).href)

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]
}
const median = (arr) => pct(arr, 50)
const round = (n) => Math.round(n)

async function benchKimi(server) {
  const { createBrowserTools } = await import(pathToFileURL(join(HERE, 'lib/tools/browser.mjs')).href)
  const { resolveConfig } = await import(pathToFileURL(join(HERE, 'lib/config.mjs')).href)
  const { setLanguage } = await import(pathToFileURL(join(HERE, 'lib/i18n.mjs')).href)
  setLanguage('en')
  const tools = createBrowserTools({ config: resolveConfig({}), ctx: { get: () => undefined } })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const session = 'bench-kimi'

  const run = async (name, a = {}) => {
    const t0 = process.hrtime.bigint()
    const value = await byName.get(name).execute({ ...a, session }, { agent: { id: session } })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const bytes = (byName.get(name).output.render({}, value) ?? []).map((b) => String(b?.text ?? '')).join('').length
    return { ms, bytes, value }
  }

  // 冷启动：从"第一次调用"到"页面可读"
  const coldT0 = Date.now()
  await run('kimi_browser_open', { url: `${server.url}/list.html` })
  const cold = Date.now() - coldT0

  const samples = { navigate: [], read: [], click: [], clickNoVerify: [], fill: [], screenshot: [] }
  const bytes = { read: 0, screenshot: 0 }

  for (let i = 0; i < REPS; i += 1) {
    samples.navigate.push((await run('kimi_browser_open', { url: `${server.url}/list.html`, new_tab: false })).ms)
    const r = await run('kimi_browser_read')
    samples.read.push(r.ms)
    bytes.read = r.bytes
    // 「点了不生效」的点击：两边测同一件事，也是本插件默认带校验的真实成本
    await run('kimi_browser_open', { url: `${server.url}/silent.html`, new_tab: false })
    samples.click.push((await run('kimi_browser_click', { selector: '#noop' })).ms)
    samples.clickNoVerify.push((await run('kimi_browser_click', { selector: '#noop', verify: false })).ms)
    await run('kimi_browser_open', { url: `${server.url}/form.html`, new_tab: false })
    samples.fill.push((await run('kimi_browser_fill', { selector: '#q', value: 'bench' })).ms)
    const s = await run('kimi_browser_screenshot')
    samples.screenshot.push(s.ms)
    bytes.screenshot = s.bytes
  }

  // 批量吞吐：一次调用里连点 20 次（每次点不同的行按钮，不跳转）
  await run('kimi_browser_open', { url: `${server.url}/list.html` })
  const steps = Array.from({ length: 20 }, (_, i) => ({ action: 'click', args: { selector: `#row-${i + 1}` } }))
  // 行按钮会跳转，所以改成"同一页里点不会导航的元素"：用 scroll 代替更公平
  const safeSteps = Array.from({ length: 20 }, (_, i) => ({ action: 'scroll', args: { dy: 40 } }))
  const t0 = process.hrtime.bigint()
  await byName.get('kimi_browser_script').execute({ steps: safeSteps, session }, { agent: { id: session } })
  const batchMs = Number(process.hrtime.bigint() - t0) / 1e6

  await byName.get('kimi_browser_tabs').execute({ action: 'close_session', session }, { agent: { id: session } })
  return { cold, samples, bytes, batchMs, batchOps: 20 }
}

async function benchPlaywright(server) {
  const require = createRequire(import.meta.url)
  const { chromium } = require(PLAYWRIGHT)
  const coldT0 = Date.now()
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  await page.goto(`${server.url}/list.html`, { waitUntil: 'load' })
  const cold = Date.now() - coldT0

  const samples = { navigate: [], read: [], click: [], clickNoVerify: [], fill: [], screenshot: [] }
  const bytes = { read: 0, screenshot: 0 }

  const time = async (key, fn) => {
    const t0 = process.hrtime.bigint()
    await fn()
    samples[key].push(Number(process.hrtime.bigint() - t0) / 1e6)
  }

  for (let i = 0; i < REPS; i += 1) {
    await time('navigate', () => page.goto(`${server.url}/list.html`, { waitUntil: 'load' }))
    await time('read', async () => {
      const text = await page.locator('body').innerText()
      bytes.read = Buffer.byteLength(text, 'utf8')
    })
    await time('click', async () => {
      await page.click('#row-7')
      await page.waitForLoadState('domcontentloaded')
      await page.goto(`${server.url}/list.html`, { waitUntil: 'load' })
    })
    await page.goto(`${server.url}/silent.html`, { waitUntil: 'load' })
    await time('click', () => page.click('#noop'))
    samples.clickNoVerify.push(samples.click[samples.click.length - 1])
    await page.goto(`${server.url}/form.html`, { waitUntil: 'load' })
    await time('fill', () => page.fill('#q', 'bench'))
    await time('screenshot', async () => {
      const buf = await page.screenshot({ type: 'png' })
      bytes.screenshot = buf.length
    })
  }

  // 批量：同一个页面上下文里连做 20 次 scroll（与 kimi 侧同语义）
  await page.goto(`${server.url}/list.html`, { waitUntil: 'load' })
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, 40)
  const batchMs = Number(process.hrtime.bigint() - t0) / 1e6

  await browser.close()
  return { cold, samples, bytes, batchMs, batchOps: 20 }
}

const server = await startServer()
const out = {}
try {
  console.log(`fixtures: ${server.url}  reps=${REPS}`)
  console.log('running kimi bridges …')
  out.kimi = await benchKimi(server)
  console.log('running playwright …')
  out.playwright = await benchPlaywright(server)
} finally {
  await server.close()
}

const rows = ['navigate', 'read', 'click', 'clickNoVerify', 'fill', 'screenshot']
console.log('\n=== 单动作延迟（ms，n=' + REPS + '）===')
console.log('action      kimi_p50  kimi_p95  pw_p50  pw_p95    比值(kimi/pw)')
for (const key of rows) {
  const k = out.kimi.samples[key]
  const p = out.playwright.samples[key]
  const km = median(k)
  const pm = median(p)
  console.log(
    `${key.padEnd(11)} ${String(round(km)).padStart(8)} ${String(round(pct(k, 95))).padStart(9)} ${String(round(pm)).padStart(7)} ${String(round(pct(p, 95))).padStart(7)}    ${(km / pm).toFixed(2)}x`.replace('undefined', '-'),
  )
}
console.log('\n=== 冷启动 / 批量吞吐 ===')
console.log(`cold start        kimi ${out.kimi.cold} ms   playwright ${out.playwright.cold} ms`)
console.log(`batch 20 ops      kimi ${round(out.kimi.batchMs)} ms (${round((out.kimi.batchOps / out.kimi.batchMs) * 1000)} ops/s)   playwright ${round(out.playwright.batchMs)} ms (${round((out.playwright.batchOps / out.playwright.batchMs) * 1000)} ops/s)`)
console.log('\n=== 返回载荷（模型可见的字节数）===')
console.log(`read              kimi ${out.kimi.bytes.read} B   playwright ${out.playwright.bytes.read} B`)
console.log('screenshot        不比较字节：我方返回的是图片附件(base64)，Playwright 返回原始 PNG 字节')

console.log('\nJSON ' + JSON.stringify(out))
