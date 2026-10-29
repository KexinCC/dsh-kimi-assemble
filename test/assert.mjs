/**
 * test/assert.mjs —— 批量脚本的 assert / commit 边界（离线，假 daemon）
 * ============================================================================
 * 为什么单独一个文件：这两条语义属于「脚本引擎自己」，不需要真浏览器。
 * 用一个假 daemon 控制 evaluate 的返回值，就能确定性地验证：
 *   1. assert 通过时不打扰后续步骤
 *   2. assert 不满足时**中止整批**并指出第几步
 *   3. not: true 的取反断言
 *   4. commit 之后的失败会标注「已越过 commit」
 * ============================================================================
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.mjs'
import { setLanguage } from '../lib/i18n.mjs'
import { createBrowserTools } from '../lib/tools/browser.mjs'
import { resetAddrCache } from '../lib/webbridge.mjs'

setLanguage('en')

let passed = 0
const failures = []
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`✗ ${name}\n    ${error.message}`)
  }
}

/** 假 daemon：evaluate 返回 scen.state，其余动作按 scen.failAction 决定成败 */
async function fakeDaemon(scen) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        /* 非 JSON：当空 */
      }
      const action = payload.action ?? payload.params?.action ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (scen.failAction && action === scen.failAction) {
        res.end(JSON.stringify({ ok: false, error: { code: 'tool_error', message: 'boom from fake daemon' } }))
        return
      }
      if (action === 'evaluate') {
        res.end(JSON.stringify({ ok: true, data: { json: scen.state } }))
        return
      }
      res.end(JSON.stringify({ ok: true, data: {} }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { addr: `127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

function toolsFor(addr) {
  resetAddrCache()
  const config = resolveConfig({ webbridgeAddr: addr, webbridgeAutoStart: false, language: 'en' })
  const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
  const tools = createBrowserTools({ config, ctx })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return (name, args) => byName.get(name).execute({ ...args, session: 'assert-test' }, { agent: { id: 'assert-test' } })
}

// 1) assert 通过：不打扰后续
await check('assert 通过时后续步骤照常执行', async () => {
  const daemon = await fakeDaemon({
    state: { url: 'https://example.test/list.html', textFound: true, selectorFound: true, selectorVisible: true },
  })
  try {
    const call = toolsFor(daemon.addr)
    const out = await call('kimi_browser_script', {
      steps: [
        { action: 'assert', args: { url: 'list.html', text: 'Row' } },
        { action: 'assert', args: { selector: '#row-1', visible: true } },
        { action: 'commit', args: { note: 'prechecks done' } },
      ],
    })
    assert.equal(out.ok, true, `应当成功，实际：${out.summary}`)
    assert.equal(out.ranSteps, 3)
    assert.equal(out.committed.length, 1)
    assert.equal(out.committed[0].note, 'prechecks done')
  } finally {
    await daemon.close()
  }
})

// 2) assert 不满足：中止整批
await check('assert 不满足时中止整批，并指出第几步', async () => {
  const daemon = await fakeDaemon({
    state: { url: 'https://example.test/list.html', textFound: false, selectorFound: false, selectorVisible: false },
  })
  try {
    const call = toolsFor(daemon.addr)
    const out = await call('kimi_browser_script', {
      steps: [
        { action: 'assert', args: { url: 'list.html' } },
        { action: 'assert', args: { selector: '#missing' } },
        { action: 'click', args: { selector: '#row-1' } },
      ],
    })
    assert.equal(out.ok, false)
    assert.equal(out.stoppedAt, 1, '应停在第 2 步')
    assert.equal(out.ranSteps, 2, '第 3 步不应执行')
    assert.match(out.summary, /#missing/)
    assert.match(out.summary, /step 2|第 2 步/)
  } finally {
    await daemon.close()
  }
})

// 3) not: true 取反
await check('assert 的 not 取反语义正确', async () => {
  const daemon = await fakeDaemon({
    state: { url: 'https://example.test/x', textFound: true, selectorFound: true, selectorVisible: true },
  })
  try {
    const call = toolsFor(daemon.addr)
    const out = await call('kimi_browser_script', {
      steps: [{ action: 'assert', args: { text: 'SOMETHING', not: true } }],
    })
    assert.equal(out.ok, false, '文本存在却要求"不存在"，应当失败')
  } finally {
    await daemon.close()
  }
})

// 4) commit 之后的失败要标注
await check('commit 之后的失败标注「已越过边界」', async () => {
  const daemon = await fakeDaemon({
    state: { url: 'https://example.test/x', textFound: true, selectorFound: true, selectorVisible: true },
    failAction: 'click',
  })
  try {
    const call = toolsFor(daemon.addr)
    const out = await call('kimi_browser_script', {
      steps: [
        { action: 'commit', args: { note: 'about to submit' } },
        { action: 'click', args: { selector: '#submit' } },
      ],
    })
    assert.equal(out.ok, false)
    assert.equal(out.committed.length, 1)
    assert.match(out.summary, /AFTER commit|commit 之后/)
  } finally {
    await daemon.close()
  }
})

// 5) assert 缺目标参数要报错
await check('assert 缺少判定目标时明确报错', async () => {
  const daemon = await fakeDaemon({ state: {} })
  try {
    const call = toolsFor(daemon.addr)
    const out = await call('kimi_browser_script', { steps: [{ action: 'assert', args: {} }] })
    assert.equal(out.ok, false)
    assert.match(out.summary, /url|selector|text/)
  } finally {
    await daemon.close()
  }
})

console.log(`\nassert/commit 语义：${passed} 项通过，${failures.length} 项失败`)
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.error.message}`)
  process.exitCode = 1
}
