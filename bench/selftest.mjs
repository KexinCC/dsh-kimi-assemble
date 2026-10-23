/**
 * bench/selftest.mjs —— 实验台自检：fixture 服务与 oracle 是否可信
 * ============================================================================
 * 跑法：node bench/selftest.mjs
 *
 * 在拿它做 A/B 之前，先证明仪器本身没坏：每个 fixture 都要能打开、要有约定的标记、
 * oracle 要能记录到导航请求。仪器不可信，后面的数字就都没有意义。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { startServer } from './server.mjs'

const server = await startServer()
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

const get = async (path) => {
  const res = await fetch(`${server.url}${path}`)
  return { status: res.status, text: await res.text() }
}

await check('fixture 首页列出六个场景', async () => {
  const { status, text } = await get('/')
  assert.equal(status, 200)
  for (const name of ['click-nav', 'silent', 'slow', 'list', 'form', 'dialog']) {
    assert.ok(text.includes(name), `index 缺少 ${name}`)
  }
})

await check('click-nav：唯一按钮 + 点击后跳 /done.html', async () => {
  const { text } = await get('/click-nav.html')
  assert.ok(text.includes('id="go"'))
  assert.ok(text.includes("/done.html"))
})

await check('silent：按钮存在且 handler 明确不改变页面', async () => {
  const { text } = await get('/silent.html')
  assert.ok(text.includes('id="noop"'))
  assert.ok(text.includes('intentionally does nothing'))
})

await check('slow：初始为 loading，1.2s 后出现 LATE_OK', async () => {
  const { text } = await get('/slow.html')
  assert.ok(text.includes('loading'))
  assert.ok(text.includes('LATE_OK'))
  assert.ok(/1200/.test(text))
})

await check('list：60 行按钮都带 id', async () => {
  const { text } = await get('/list.html')
  assert.ok(text.includes('id="row-1"'))
  assert.ok(text.includes('id="row-42"'))
  assert.ok(text.includes('id="row-60"'))
  assert.ok(!text.includes('id="row-61"'))
})

await check('form：Enter 被 preventDefault，只有 submit 才跳转', async () => {
  const { text } = await get('/form.html')
  assert.ok(text.includes('id="q"'))
  assert.ok(text.includes('id="submit"'))
  assert.ok(/preventDefault\(\)/.test(text))
  assert.ok(text.includes('/form-done.html'))
})

await check('dialog：点击弹 confirm，接受后跳转', async () => {
  const { text } = await get('/dialog.html')
  assert.ok(text.includes('id="confirm"'))
  assert.ok(text.includes('window.confirm'))
  assert.ok(text.includes('/dialog-done.html'))
})

await check('oracle：只记录 .html 请求，reset 可清空', async () => {
  server.resetHits()
  await get('/done.html')
  await get('/row.html?n=42')
  const htmlHits = server.hits.filter((hit) => hit.endsWith('.html'))
  assert.deepEqual(htmlHits, ['/done.html', '/row.html'])
  server.resetHits()
  assert.equal(server.hits.length, 0)
})

await check('oracle 能区分「去了哪一页」', async () => {
  server.resetHits()
  await get('/form-done.html')
  assert.ok(server.hits.includes('/form-done.html'))
  assert.ok(!server.hits.includes('/done.html'))
})

await server.close()
console.log(`\n实验台自检：${passed} 项通过，${failures.length} 项失败`)
if (failures.length) process.exitCode = 1
