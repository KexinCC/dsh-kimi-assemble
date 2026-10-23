/**
 * bench/semantics.mjs —— 语义正确性检查（在拿数字之前先证明工具不会说谎）
 * ============================================================================
 * 跑法：node bench/semantics.mjs
 *
 * 这些东西比快慢更重要：一个把「没生效」报成「生效」的工具，越快越有害。
 * 所以先钉死语义，再谈 A/B 数字。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { startServer } from './server.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const tree = process.env.KIMI_TREE ? process.env.KIMI_TREE : join(HERE, '..')

const { createBrowserTools } = await import(pathToFileURL(join(tree, 'lib/tools/browser.mjs')).href)
const { resolveConfig } = await import(pathToFileURL(join(tree, 'lib/config.mjs')).href)
const { setLanguage } = await import(pathToFileURL(join(tree, 'lib/i18n.mjs')).href)
setLanguage('en')

const server = await startServer()
let counter = 0
let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`✗ ${name} — ${error.message}`)
  }
}

function makeArm(overrides = {}) {
  const config = resolveConfig(overrides)
  const tools = createBrowserTools({ config, ctx: { get: () => undefined } })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const run = async (name, args = {}) => {
    const session = `sem-${++counter}`
    return byName.get(name).execute({ ...args, session }, { agent: { id: session }, signal: undefined })
  }
  /** 同一 session 里连续动作 */
  const chain = (session) => async (name, args = {}) => byName.get(name).execute({ ...args, session }, { agent: { id: session }, signal: undefined })
  return { config, byName, run, chain, session: (tag) => `sem-${tag}-${++counter}` }
}

const arm = makeArm()

await check('wait(text) 不会把 <script> 里的字面量当成页面文本', async () => {
  const s = arm.session('script-text')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/slow.html`, wait_until: 'none' })
  const t0 = Date.now()
  const result = await call('kimi_browser_wait', { text: 'LATE_OK', timeout_ms: 4000 })
  const elapsed = Date.now() - t0
  assert.equal(result.ok, true, '应当等到真实渲染（1.2s 后）')
  assert.ok(elapsed >= 1100, `不能在脚本字面量上提前命中，实际 ${elapsed}ms`)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('wait(text) 超时如实报告，不谎报成功', async () => {
  const s = arm.session('wait-timeout')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/click-nav.html` })
  const result = await call('kimi_browser_wait', { text: 'NEVER_APPEARS_XYZ', timeout_ms: 600 })
  assert.equal(result.ok, false)
  assert.ok(result.meta?.url, '超时时要带回当时页面状态，方便决定下一步')
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('click 在无变化页面上报告 changed=false（不再静默成功）', async () => {
  const s = arm.session('silent-click')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/silent.html` })
  const result = await call('kimi_browser_click', { selector: '#noop' })
  assert.equal(result.clicked, true)
  assert.equal(result.verified, true, '校验应当真的跑过')
  assert.equal(result.changed, false)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('click 在导航页面上报告 changed=true 并说明变化', async () => {
  const s = arm.session('nav-click')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/click-nav.html` })
  const result = await call('kimi_browser_click', { selector: '#go' })
  assert.equal(result.changed, true)
  assert.match(String(result.changeDetail), /url|title/i)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('browserVerify=off 时退回「派发即成功」（回滚开关有效）', async () => {
  const offArm = makeArm({ browserVerify: 'off' })
  const s = offArm.session('verify-off')
  const call = offArm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/silent.html` })
  const result = await call('kimi_browser_click', { selector: '#noop' })
  assert.equal(result.verified, false, 'off 时不应做校验')
  assert.equal(result.changed, null)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('fill(submit) 报告回车被吞（changed=false），便于改点按钮', async () => {
  const s = arm.session('form-enter')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/form.html` })
  const result = await call('kimi_browser_fill', { selector: '#q', value: 'kimi', submit: true })
  assert.equal(result.filled, true)
  assert.equal(result.changed, false, 'Enter 被 preventDefault，页面不该变化')
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('dialog accept 能解除阻塞并让页面继续', async () => {
  server.resetHits()
  const s = arm.session('dialog')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/dialog.html` })
  const click = await call('kimi_browser_click', { selector: '#confirm' })
  assert.ok(click.changed === false || click.verified === false, '弹窗期间不应谎报成功')
  const accept = await call('kimi_browser_dialog', { action: 'accept' })
  assert.equal(accept.action, 'accept')
  await new Promise((r) => setTimeout(r, 400))
  assert.ok(server.hits.includes('/dialog-done.html'), '接受后应当继续导航')
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('read(mode=diff) 在无变化时只回「没变化」且字节数很小', async () => {
  const s = arm.session('diff')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/list.html` })
  const full = await call('kimi_browser_read')
  const diff = await call('kimi_browser_read', { mode: 'diff' })
  assert.equal(diff.changed, false)
  const fullBytes = (arm.byName.get('kimi_browser_read').output.render({}, full) ?? []).map((b) => b.text ?? '').join('').length
  const diffBytes = (arm.byName.get('kimi_browser_read').output.render({}, diff) ?? []).map((b) => b.text ?? '').join('').length
  assert.ok(diffBytes < fullBytes / 5, `diff 应当显著更小：${diffBytes} vs ${fullBytes}`)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('read 附带页面状态：url/焦点/元素计数', async () => {
  const s = arm.session('meta')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/form.html` })
  const read = await call('kimi_browser_read')
  const text = (arm.byName.get('kimi_browser_read').output.render({}, read) ?? []).map((b) => b.text ?? '').join('')
  assert.match(text, /page:/)
  assert.match(text, /state:/)
  assert.match(text, /elements:/)
  assert.equal(read.meta?.forms, 1)
  assert.ok(read.meta.inputs >= 1)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('eval 返回结构化结果', async () => {
  const s = arm.session('eval')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/list.html` })
  const result = await call('kimi_browser_eval', { code: '(() => ({ buttons: document.querySelectorAll("button").length }))()' })
  assert.match(String(result.json), /"buttons":\s*60/)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await check('act(select/check) 走 schema 校验并回报变化', async () => {
  const s = arm.session('act')
  const call = arm.chain(s)
  await call('kimi_browser_open', { url: `${server.url}/form.html` })
  const typed = await call('kimi_browser_act', { verb: 'type', selector: '#q', value: 'hello' })
  assert.equal(typed.verb, 'type')
  // 未知 verb 应当被点名拒绝
  await assert.rejects(() => call('kimi_browser_act', { verb: 'teleport' }), /teleport|unknown/i)
  // 缺参数也应当被点名
  await assert.rejects(() => call('kimi_browser_act', { verb: 'select' }), /selector/i)
  await call('kimi_browser_tabs', { action: 'close_session' })
})

await server.close()
console.log(`\n语义检查：${passed} 项通过，${failures.length} 项失败`)
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.error.message}`)
  process.exitCode = 1
}
