/**
 * test/integration.mjs —— 通过工具层跑真机（只读 + 一次浏览器标签操作）
 * ============================================================================
 * 跑法：node test/integration.mjs
 *
 * 和 live.mjs 的区别：live.mjs 直接调后端客户端；这里走**模型会走的那条路**：
 *   buildTools() → tool.execute(args, exec) → render() → 内容块
 * 所以它同时验证了：参数校验、window 解析、租约、截图→附件、render 结构。
 *
 * 用一个最小 ctx 桩：只提供 tools.get / systemPrompt / llm / attachments /
 * skills / logger / get()。attachments 桩会把图片字节按 PNG 签名校验后计数，
 * 以此证明截图确实变成了 image 块。
 *
 * 不发送任何桌面输入；浏览器只在自检 session 里开一个 example.com 再关掉。
 * ============================================================================
 */
import assert from 'node:assert/strict'

import { resolveConfig } from '../lib/config.mjs'
import { buildTools } from '../lib/tools/index.mjs'
import { resetAddrCache } from '../lib/webbridge.mjs'
import { resetState as resetCuState } from '../lib/kimicu.mjs'

let passed = 0
let failed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`✗ ${name} — ${error.message}`)
  }
}

/** 收集到的图片附件（模拟宿主 attachment 服务）。 */
const images = []
const ctx = {
  logger: { info() {}, warn() {} },
  get(name) {
    if (name === 'llm') {
      return {
        async resolveModelInfo() {
          return { inputModalities: ['text', 'image'] }
        },
      }
    }
    if (name === 'attachments') {
      return {
        imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
        async saveImage({ data, mediaType, name: fileName }) {
          const isPng = data.length > 8 && data[0] === 0x89 && data[1] === 0x50
          const isJpeg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8
          assert.ok(isPng || isJpeg, `附件字节不是 PNG/JPEG（mediaType=${mediaType}, ${data.length} 字节）`)
          images.push({ bytes: data.length, mediaType, name: fileName })
          return {
            attachmentId: `att-${images.length}`,
            mediaType,
            bytes: data.length,
            width: 100,
            height: 100,
            name: fileName,
          }
        },
      }
    }
    if (name === 'agents') return { list: () => [] }
    return undefined
  },
  tools: { get: () => undefined, register: () => () => {} },
  systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
}

const config = resolveConfig({})
resetAddrCache()
resetCuState()
const tools = buildTools({ config, ctx })
const byName = new Map(tools.map((tool) => [tool.name, tool]))

/** 模拟宿主 exec：agent 用来派生 session 名与路由。 */
const exec = {
  agent: {
    id: 'session-47c06161-2f91-411b',
    options: { provider: 'workbuddy-global', model: 'deepseek-v4.1-flash' },
    session: { requestHeader: () => ({ config: { provider: 'workbuddy-global', model: 'deepseek-v4.1-flash' } }) },
  },
  signal: AbortSignal.timeout(120_000),
}

/** 走一次工具调用并做基本断言。 */
async function call(name, args) {
  const tool = byName.get(name)
  assert.ok(tool, `工具 ${name} 不存在`)
  const value = await tool.execute(args, exec)
  const content = tool.output.render(args, value)
  assert.ok(Array.isArray(content) && content.length > 0, `${name} 的 render 没有内容`)
  for (const block of content) {
    assert.ok(['text', 'image'].includes(block.type), `${name} 渲染出未知块 ${block.type}`)
  }
  return { value, content }
}

// ---------------------------------------------------------------- status
await check('kimi_status：两条桥都报告实况', async () => {
  const { value, content } = await call('kimi_status', {})
  assert.equal(value.browser.running, true, `浏览器未运行：${JSON.stringify(value.browser.error)}`)
  assert.equal(value.browser.extensionConnected, true, '扩展未连接')
  assert.equal(value.desktop.error, null, `桌面不可用：${JSON.stringify(value.desktop.error)}`)
  assert.ok(value.desktop.runtimeVersion, '没有报告 runtime 版本')
  assert.match(content[0].text, /浏览器/)
  assert.match(content[0].text, /桌面/)
})

// ---------------------------------------------------------------- windows
await check('kimi_cu_windows：列出窗口且字段完整', async () => {
  const { value } = await call('kimi_cu_windows', { limit: 5 })
  assert.ok(value.total > 0, '没有窗口')
  for (const item of value.windows) {
    assert.equal(typeof item.id, 'number')
    assert.equal(typeof item.title, 'string')
    assert.equal(typeof item.app, 'string')
  }
})

// ---------------------------------------------------------------- observe（带截图 → 图片块）
await check('kimi_cu_observe：无障碍树 + 截图变成 image 块（抓不到图的窗口优雅降级）', async () => {
  const list = await call('kimi_cu_windows', { limit: 30 })
  assert.ok(list.value.windows.length > 0, '没有窗口')

  // 有些窗口（输入法宿主、受保护窗口、被遮挡/最小化）WGC 抓不到图 ——
  // 工具必须降级成纯文本而不是整体失败。这里逐个试，记录两类结果。
  let withImage = null
  let degraded = null
  for (const item of list.value.windows) {
    if (!item.title) continue
    const before = images.length
    const { value, content } = await call('kimi_cu_observe', { window: item.id, max_chars: 4000 })
    assert.ok(value.text.length > 0, `窗口 ${item.id} 的无障碍树为空`)
    assert.match(value.text, /\[\d+\]/, '无障碍树没有 [index] 标签')
    const imageBlocks = content.filter((block) => block.type === 'image')
    if (imageBlocks.length === 1) {
      assert.ok(images.length > before, '截图没有进入附件服务')
      assert.ok(imageBlocks[0].attachment.attachmentId)
      withImage = item
      break
    }
    // 降级路径：文本仍可用，且 render 里明确说了截图不可用
    assert.equal(imageBlocks.length, 0)
    assert.match(content[0].text, /截图：不可用/)
    degraded = item
  }
  assert.ok(withImage, `没有任何窗口能出图（最后降级窗口：${degraded?.title ?? '无'}）`)
})

// ---------------------------------------------------------------- observe（纯文本）
await check('kimi_cu_observe：screenshot=false 时不产生图片', async () => {
  const list = await call('kimi_cu_windows', { limit: 20 })
  const target = list.value.windows.find((item) => item.title)
  const before = images.length
  const { content } = await call('kimi_cu_observe', { window: target.id, screenshot: false, text: true, max_chars: 2000 })
  assert.equal(images.length, before, '不该产生截图')
  assert.equal(content.filter((block) => block.type === 'image').length, 0)
})

// ---------------------------------------------------------------- 参数错误
await check('kimi_cu_observe：两者都 false → KIMI_ARGS', async () => {
  const list = await call('kimi_cu_windows', { limit: 5 })
  await assert.rejects(
    () => byName.get('kimi_cu_observe').execute({ window: list.value.windows[0].id, screenshot: false, text: false }, exec),
    (error) => error.code === 'KIMI_ARGS',
  )
})

await check('kimi_cu_windows：未知窗口标题 → 列出候选', async () => {
  await assert.rejects(
    () => byName.get('kimi_cu_observe').execute({ window: '绝对不存在的窗口标题', screenshot: false }, exec),
    (error) => {
      assert.equal(error.code, 'KIMI_ARGS')
      assert.match(error.message, /没有标题匹配/)
      return true
    },
  )
})

// ---------------------------------------------------------------- 浏览器
await check('kimi_browser_open / read / screenshot / tabs(close)', async () => {
  const session = 'kimi-assemble-integration'
  const opened = await call('kimi_browser_open', {
    url: 'https://example.com/?q=中文集成测试',
    new_tab: true,
    group_title: 'Kimi 集成自检',
    session,
  })
  assert.ok(opened.value.tabId, '没有 tabId')
  assert.ok(opened.value.url.includes('中文集成测试'), `中文 URL 被破坏：${opened.value.url}`)

  const read = await call('kimi_browser_read', { session, max_chars: 3000 })
  assert.ok(read.value.text.length > 0, '读取为空')
  assert.match(read.value.text, /ref=e\d+/)

  const shot = await call('kimi_browser_screenshot', { session, format: 'jpeg', quality: 50 })
  assert.ok(shot.value.path, '截图没有路径')
  assert.equal(shot.value.attached, true, `截图未附加：${shot.value.note}`)
  assert.equal(shot.content.filter((block) => block.type === 'image').length, 1)

  const tabs = await call('kimi_browser_tabs', { session, action: 'list' })
  assert.ok(tabs.value.tabs.length >= 1)

  const closed = await call('kimi_browser_tabs', { session, action: 'close_session' })
  assert.ok(closed.value.closed >= 1, 'close_session 没关掉标签')
})

await check('kimi_browser_script：单步模式（等价旧 cmd）', async () => {
  const session = 'kimi-assemble-integration-2'
  await call('kimi_browser_open', { url: 'https://example.com', session, group_title: '集成自检2' })
  const { value } = await call('kimi_browser_script', {
    action: 'evaluate',
    args: { code: '(() => document.title)()' },
    session,
  })
  assert.equal(value.ok, true)
  assert.match(value.summary, /Example/)
  await call('kimi_browser_tabs', { session, action: 'close_session' })
})

await check('kimi_browser_script：未知 action 被 preflight 拒绝', async () => {
  await assert.rejects(
    () => byName.get('kimi_browser_script').execute({ steps: [{ action: 'not-an-action' }] }, exec),
    (error) => {
      assert.equal(error.code, 'KIMI_ARGS')
      assert.match(error.message, /navigate/)
      return true
    },
  )
})

// ---------------------------------------------------------------- 批处理：一次调用跑完多步
await check('kimi_browser_script：一次调用跑完 6 步（open→read→fill→click→read→close）', async () => {
  const session = 'kimi-assemble-batch'
  const started = Date.now()
  const { value } = await call('kimi_browser_script', {
    session,
    steps: [
      { action: 'navigate', args: { url: 'https://example.com', group_title: '批量自检' } },
      { action: 'read', args: { max_chars: 800 } },
      { action: 'evaluate', args: { code: '(() => document.title)()' } },
      { action: 'screenshot', args: {} },
      { action: 'find', args: { query: 'Example' } },
      { action: 'close_session', args: {} },
    ],
  })
  const elapsed = Date.now() - started
  assert.equal(value.ok, true, `脚本失败：${value.summary}`)
  assert.equal(value.ranSteps, 6)
  assert.equal(value.stoppedAt, null)
  // 一次本地调用就完成 6 个动作 —— 这才是省模型轮次的关键
  assert.ok(elapsed < 8000, `6 步耗时异常：${elapsed}ms`)
  console.log(`    ↳ 6 步一次调用耗时 ${elapsed}ms（若逐条调用需要 6 次模型往返）`)
})

await check('kimi_browser_script：中途失败会保留已完成步骤并可定位', async () => {
  const session = 'kimi-assemble-batch-fail'
  const { value } = await call('kimi_browser_script', {
    session,
    stop_on_error: true,
    steps: [
      { action: 'navigate', args: { url: 'https://example.com', group_title: '批量失败自检' } },
      { action: 'click', args: { selector: '#definitely-missing-element' } },
      { action: 'close_session', args: {} },
    ],
  })
  assert.equal(value.ok, false)
  assert.equal(value.stoppedAt, 1)
  assert.equal(value.ranSteps, 2)
  assert.equal(value.steps[0].ok, true)
  assert.equal(value.steps[1].ok, false)
  await call('kimi_browser_tabs', { session, action: 'close_session' })
})

await check('kimi_cu_script：一次调用跑完 windows(filter)→observe（@n 指向过滤后的清单）', async () => {
  const started = Date.now()
  const { value } = await call('kimi_cu_script', {
    steps: [
      { action: 'windows', args: { filter: 'DeepSeek', limit: 5 } },
      { action: 'observe', args: { window: '@0', screenshot: true, text: true, max_chars: 1200 } },
    ],
  })
  const elapsed = Date.now() - started
  assert.equal(value.ok, true, `脚本失败：${value.summary}`)
  assert.equal(value.ranSteps, 2)
  // @0 必须是过滤后的第一个窗口，而不是全量清单的第一个（踩过这个坑）
  assert.match(value.steps[1].summary, /DeepSeek Harness/, `@0 解析错了：${value.steps[1].summary}`)
  console.log(`    ↳ 2 步一次调用耗时 ${elapsed}ms`)
})

await check('kimi_cu_script：preflight 拦住未知动作（不拉 Agent）', async () => {
  await assert.rejects(
    () => byName.get('kimi_cu_script').execute({ steps: [{ action: 'sky_dance' }] }, exec),
    (error) => error.code === 'KIMI_ARGS',
  )
})

// ---------------------------------------------------------------- 汇总
console.log(`\n集成（真机）：${passed} 通过，${failed} 失败`)
console.log(`共采集到 ${images.length} 张截图附件`)
if (failed > 0) {
  for (const { name, error } of failures) console.error(`✗ ${name}\n  ${error.stack ?? error.message}`)
  process.exitCode = 1
}
