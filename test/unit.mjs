/**
 * test/unit.mjs —— 离线单测（不碰真实浏览器/桌面）
 * ============================================================================
 * 跑法：node test/unit.mjs
 * 覆盖：帧编解码、参数校验、selector/window 归一化、配置、错误映射、内容渲染。
 * 全部用内置 node:assert，不装依赖。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { encodeFrame, FrameReader, defaultPipePath, CU_METHODS, CU_METHOD_ARGS } from '../lib/kimicu.mjs'
import { resolveConfig, DEFAULTS } from '../lib/config.mjs'
import { defineTool, objectSchema, stringField, intField, truncate } from '../lib/tool.mjs'
import { normalizeSelector, sessionNameFor, BROWSER_ACTIONS } from '../lib/tools/browser.mjs'
import { CU_ACTIONS } from '../lib/tools/computer.mjs'
import { KimiError, CODES } from '../lib/errors.mjs'
import { buildTools } from '../lib/tools/index.mjs'
import { clearStalePidFile } from '../lib/webbridge.mjs'
import { diffLines, normalizeMeta, sessionState, signature } from '../lib/browser-state.mjs'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.then(
        () => {
          passed += 1
        },
        (error) => {
          failed += 1
          failures.push({ name, error })
        },
      )
    }
    passed += 1
  } catch (error) {
    failed += 1
    failures.push({ name, error })
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failed += 1
    failures.push({ name, error })
  }
}

// ---------------------------------------------------------------------------
// 1. 帧编解码
// ---------------------------------------------------------------------------

/** 造一个带 ~/.kimi-webbridge/daemon.pid 的临时 home（webbridgeHome 会拼 .kimi-webbridge 子目录）。 */
function fakeWebbridgeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-pid-'))
  const home = join(dir, '.kimi-webbridge')
  mkdirSync(home, { recursive: true })
  return { dir, home, env: { USERPROFILE: dir, HOME: dir }, pidFile: join(home, 'daemon.pid') }
}

await testAsync('pid 自愈：死进程的 pid 文件被清掉', async () => {
  const { dir, env, pidFile } = fakeWebbridgeHome()
  try {
    // 起一个立即退出的子进程，拿一个「确定已死」的 pid
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const deadPid = child.pid
    await new Promise((resolve) => child.on('exit', resolve))
    writeFileSync(pidFile, String(deadPid), 'utf8')

    assert.equal(await clearStalePidFile(env), true, '死进程的 pid 文件应当被清掉')
    assert.equal(existsSync(pidFile), false, '文件应当已删除')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('pid 自愈：活进程的 pid 文件绝不动', async () => {
  const { dir, env, pidFile } = fakeWebbridgeHome()
  try {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise((resolve) => child.on('spawn', resolve))
      writeFileSync(pidFile, String(child.pid), 'utf8')

      assert.equal(await clearStalePidFile(env), false, '活进程时绝不能动文件')
      assert.equal(existsSync(pidFile), true, '文件必须原样保留')
      assert.equal(readFileSync(pidFile, 'utf8'), String(child.pid), '内容必须未改')
    } finally {
      child.kill()
      await new Promise((resolve) => child.on('exit', resolve))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('pid 自愈：损坏的 pid 文件被清掉', async () => {
  const { dir, env, pidFile } = fakeWebbridgeHome()
  try {
    writeFileSync(pidFile, 'not-a-pid', 'utf8')
    assert.equal(await clearStalePidFile(env), true)
    assert.equal(existsSync(pidFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('pid 自愈：没有 pid 文件时安全返回', async () => {
  const { dir, env } = fakeWebbridgeHome()
  try {
    assert.equal(await clearStalePidFile(env), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('帧：整帧往返', async () => {
  const frame = encodeFrame({ id: 1, ok: true, text: '中文 ✓' })
  const reader = new FrameReader()
  const decoded = reader.push(frame)
  assert.deepEqual(decoded, { id: 1, ok: true, text: '中文 ✓' })
  assert.equal(reader.done, true)
})

await testAsync('帧：逐字节分片', async () => {
  const payload = { id: 7, method: '__agent_ping', params: {}, note: '多字节中文测试' }
  const frame = encodeFrame(payload)
  const reader = new FrameReader()
  let decoded = null
  for (const byte of frame) {
    const result = reader.push(Buffer.from([byte]))
    if (result !== null) decoded = result
  }
  assert.deepEqual(decoded, payload)
})

await testAsync('帧：尾随字节被拒绝', async () => {
  const frame = Buffer.concat([encodeFrame({ id: 1 }), Buffer.from([1, 2, 3])])
  const reader = new FrameReader()
  assert.throws(() => reader.push(frame), /trailing|KIMI_CU_PROTOCOL/i)
})

await testAsync('帧：非法 JSON 被拒绝', async () => {
  const body = Buffer.from('{not json', 'utf8')
  const header = Buffer.alloc(8)
  header.writeBigUInt64LE(BigInt(body.length))
  const reader = new FrameReader()
  assert.throws(() => reader.push(Buffer.concat([header, body])), /JSON/i)
})

await testAsync('帧：超大长度被拒绝', async () => {
  const header = Buffer.alloc(8)
  header.writeBigUInt64LE(BigInt(200 * 1024 * 1024))
  const reader = new FrameReader()
  assert.throws(() => reader.push(header), /length|KIMI_CU_PROTOCOL/i)
})

// ---------------------------------------------------------------------------
// 2. 配置
// ---------------------------------------------------------------------------
test('配置：空配置等于默认值', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.webbridgeEnabled, DEFAULTS.webbridgeEnabled)
  assert.equal(config.kimicuEnabled, DEFAULTS.kimicuEnabled)
  assert.equal(config.cuMaxTreeChars, DEFAULTS.cuMaxTreeChars)
})

test('配置：字符串布尔与数字被归一化', () => {
  const config = resolveConfig({ webbridgeEnabled: 'off', kimicuTimeoutMs: '30000', cuMaxTreeChars: 5000 })
  assert.equal(config.webbridgeEnabled, false)
  assert.equal(config.kimicuTimeoutMs, 30000)
  assert.equal(config.cuMaxTreeChars, 5000)
})

test('配置：地址剥掉协议前缀', () => {
  const config = resolveConfig({ webbridgeAddr: 'http://127.0.0.1:10086/' })
  assert.equal(config.webbridgeAddr, '127.0.0.1:10086')
})

test('配置：非法地址报 KIMI_CONFIG', () => {
  assert.throws(() => resolveConfig({ webbridgeAddr: '不是地址' }), (error) => error instanceof KimiError && error.code === CODES.CONFIG)
})

test('配置：超范围数值报错', () => {
  assert.throws(() => resolveConfig({ kimicuTimeoutMs: 10 }), (error) => error.code === CODES.CONFIG)
})

// ---------------------------------------------------------------------------
// 3. 工具定义与参数校验
// ---------------------------------------------------------------------------
test('tool：必填缺失 → KIMI_ARGS 且点名到字段', () => {
  const tool = defineTool({
    name: 'demo',
    description: 'demo',
    parameters: objectSchema({ a: { ...stringField('a'), required: true } }),
    execute: async () => ({}),
    render: () => [],
  })
  return tool.execute({}, {}).then(
    () => assert.fail('should have failed'),
    (error) => {
      assert.equal(error.code, CODES.ARGS)
      // 错误码是稳定契约；文案随语言变，只断言字段名出现
      assert.match(error.message, /\ba\b/)
    },
  )
})

await testAsync('tool：未知参数被拒绝（additionalProperties:false）', async () => {
  const tool = defineTool({
    name: 'demo2',
    description: 'demo2',
    parameters: objectSchema({ a: stringField('a') }),
    execute: async () => ({}),
    render: () => [],
  })
  await assert.rejects(tool.execute({ a: 'x', nope: 1 }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /nope/)
    return true
  })
})

await testAsync('tool：类型错误点名到字段与类型', async () => {
  const tool = defineTool({
    name: 'demo3',
    description: 'demo3',
    parameters: objectSchema({ n: intField('n') }),
    execute: async () => ({}),
    render: () => [],
  })
  await assert.rejects(tool.execute({ n: 'x' }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /integer/)
    return true
  })
})

await testAsync('tool：enum 越界被拒绝', async () => {
  const tool = defineTool({
    name: 'demo4',
    description: 'demo4',
    parameters: objectSchema({ mode: { schema: { type: 'string', enum: ['a', 'b'] } } }),
    execute: async () => ({}),
    render: () => [],
  })
  await assert.rejects(tool.execute({ mode: 'c' }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /mode/)
    assert.match(error.message, /"a"/)
    return true
  })
})

await testAsync('tool：normalize 在校验后执行', async () => {
  const tool = defineTool({
    name: 'demo5',
    description: 'demo5',
    parameters: objectSchema({ ref: stringField('ref') }),
    normalize: (args) => ({ ref: `@${args.ref}` }),
    execute: async (args) => ({ got: args.ref }),
    render: () => [],
  })
  const value = await tool.execute({ ref: 'e12' }, {})
  assert.deepEqual(value, { got: '@e12' })
})

// ---------------------------------------------------------------------------
// 4. selector / session / window 归一化
// ---------------------------------------------------------------------------
test('selector：四种 ref 写法收敛到 @eNNN', () => {
  assert.equal(normalizeSelector('e2000356'), '@e2000356')
  assert.equal(normalizeSelector('@e2000356'), '@e2000356')
  assert.equal(normalizeSelector('ref=e2000356'), '@e2000356')
  assert.equal(normalizeSelector('[ref=e2000356]'), '@e2000356')
  assert.equal(normalizeSelector('  @E12  '), '@E12')
})

test('selector：CSS 原样保留', () => {
  assert.equal(normalizeSelector('#submit'), '#submit')
  assert.equal(normalizeSelector('input[name="q"]'), 'input[name="q"]')
})

test('selector：空值报 KIMI_ARGS', () => {
  assert.throws(() => normalizeSelector('  '), (error) => error.code === CODES.ARGS)
})

test('session：按 agent 派生且稳定', () => {
  const first = sessionNameFor({ id: 'session-47c06161-2f91-411b' })
  const second = sessionNameFor({ id: 'session-47c06161-2f91-411b' })
  assert.equal(first, second)
  assert.match(first, /^dsh-[A-Za-z0-9_-]+$/)
  assert.equal(sessionNameFor({ id: 'x' }, 'my-task'), 'my-task')
})

test('pipe：默认管道名包含用户名', () => {
  const pipe = defaultPipePath({ USERNAME: 'TestUser' })
  assert.equal(pipe, '\\\\.\\pipe\\kimi-cu-win-TestUser')
  assert.equal(defaultPipePath({ KIMI_CU_WIN_AGENT_PIPE: '\\\\.\\pipe\\custom' }), '\\\\.\\pipe\\custom')
})

// ---------------------------------------------------------------------------
// 5. 方法/动作表完整性
// ---------------------------------------------------------------------------
test('CU：16 个方法且每个都有参数白名单', () => {
  assert.equal(CU_METHODS.length, 16)
  for (const method of CU_METHODS) {
    assert.ok(Array.isArray(CU_METHOD_ARGS[method]), `${method} 缺少参数白名单`)
  }
})

test('浏览器：35 个 action', () => {
  assert.equal(BROWSER_ACTIONS.length, 35)
  for (const required of ['navigate', 'snapshot', 'click', 'fill', 'screenshot', 'close_session', 'evaluate', 'cdp']) {
    assert.ok(BROWSER_ACTIONS.includes(required), `缺少 ${required}`)
  }
})

test('CU：9 个 act 动作', () => {
  assert.deepEqual([...CU_ACTIONS], ['click', 'type', 'key', 'scroll', 'set_value', 'drag', 'drag_path', 'secondary', 'activate'])
})

// ---------------------------------------------------------------------------
// 6. 工具清单（名字、唯一性、schema 合法性）
// ---------------------------------------------------------------------------
const config = resolveConfig({})
const ctxStub = {
  get: () => undefined,
  logger: { info() {}, warn() {} },
  tools: { get: () => undefined, register: () => () => {} },
  systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
}
const tools = buildTools({ config, ctx: ctxStub })

test('工具：17 个且名字唯一', () => {
  const names = tools.map((tool) => tool.name)
  assert.equal(names.length, 17, `实际：${names.join(', ')}`)
  assert.equal(new Set(names).size, names.length)
  for (const name of ['kimi_status', 'kimi_browser_open', 'kimi_browser_read', 'kimi_browser_click', 'kimi_browser_fill', 'kimi_browser_act', 'kimi_browser_wait', 'kimi_browser_eval', 'kimi_browser_dialog', 'kimi_browser_screenshot', 'kimi_browser_tabs', 'kimi_browser_script', 'kimi_cu_windows', 'kimi_cu_observe', 'kimi_cu_act', 'kimi_cu_launch', 'kimi_cu_script']) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
  }
})

test('工具：schema 只用宿主支持的 JSON Schema 子集', () => {
  const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    for (const key of Object.keys(node)) {
      assert.ok(ALLOWED.has(key), `${path} 用了不支持的 key "${key}"`)
    }
    if (node.properties) {
      assert.equal(node.type, 'object', `${path}.properties 需要 type:object`)
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${key}`)
    }
    if (node.items) walk(node.items, `${path}.items`)
    if (node.oneOf) node.oneOf.forEach((child, index) => walk(child, `${path}.oneOf[${index}]`))
  }
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} 的参数根必须是 object`)
    walk(tool.parameters, `${tool.name}.parameters`)
    walk(tool.output.schema, `${tool.name}.output`)
  }
})

test('工具：每个都有非空描述与 render', () => {
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} 描述太短`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 render`)
  }
})

await testAsync('工具：kimi_cu_act click 互斥校验', async () => {
  const act = tools.find((tool) => tool.name === 'kimi_cu_act')
  // 参数本身缺失时被 schema 拦下
  await assert.rejects(act.execute({ action: 'click', window: 1 }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    return true
  })
  // 同时给 element_index 和 x/y → 互斥错误
  await assert.rejects(act.execute({ action: 'click', window: 1, element_index: 3, x: 10, y: 10 }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /element_index/)
    return true
  })
  // 只给 x 不给 y
  await assert.rejects(act.execute({ action: 'click', window: 1, x: 10 }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /x .*y|y .*x/)
    return true
  })
})

await testAsync('工具：kimi_cu_observe 不能两者都 false', async () => {
  const observe = tools.find((tool) => tool.name === 'kimi_cu_observe')
  await assert.rejects(observe.execute({ window: 1, screenshot: false, text: false }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /screenshot and text/)
    return true
  })
})

await testAsync('工具：kimi_browser_script 未知 action 拒绝并列出可用值', async () => {
  const script = tools.find((tool) => tool.name === 'kimi_browser_script')
  await assert.rejects(script.execute({ steps: [{ action: 'nope' }] }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /navigate/)
    return true
  })
})

await testAsync('工具：kimi_browser_script 缺 action/steps → KIMI_ARGS', async () => {
  const script = tools.find((tool) => tool.name === 'kimi_browser_script')
  await assert.rejects(script.execute({}, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /action|steps/)
    return true
  })
})

await testAsync('工具：kimi_browser_script 步数超限 → KIMI_ARGS', async () => {
  const script = tools.find((tool) => tool.name === 'kimi_browser_script')
  const steps = Array.from({ length: 26 }, () => ({ action: 'list_tabs' }))
  await assert.rejects(script.execute({ steps }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /25/)
    return true
  })
})

await testAsync('工具：kimi_cu_script 未知 action 拒绝并列出可用值', async () => {
  const script = tools.find((tool) => tool.name === 'kimi_cu_script')
  await assert.rejects(script.execute({ steps: [{ action: 'sky_dance' }] }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /observe/)
    return true
  })
})

await testAsync('工具：kimi_cu_script 未知 CU 方法（call 步）→ KIMI_ARGS', async () => {
  const script = tools.find((tool) => tool.name === 'kimi_cu_script')
  await assert.rejects(script.execute({ steps: [{ action: 'call', args: { method: 'sky_dance' } }] }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /list_windows/)
    return true
  })
})

await testAsync('工具：kimi_cu_script 输入步缺 window → KIMI_ARGS（preflight 不拉 Agent）', async () => {
  const script = tools.find((tool) => tool.name === 'kimi_cu_script')
  await assert.rejects(script.execute({ steps: [{ action: 'click', args: { element_index: 3 } }] }, {}), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /window/)
    return true
  })
})

await testAsync('工具：kimi_cu_script observe 两者都 false → KIMI_ARGS', async () => {
  const script = tools.find((tool) => tool.name === 'kimi_cu_script')
  await assert.rejects(
    script.execute({ steps: [{ action: 'observe', args: { window: 1, screenshot: false, text: false } }] }, {}),
    (error) => {
      assert.equal(error.code, CODES.ARGS)
      assert.match(error.message, /screenshot and text/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 7. 文本工具
// ---------------------------------------------------------------------------
test('truncate：短文本原样，长文本标记截断', () => {
  const short = truncate('abc', 10)
  assert.equal(short.text, 'abc')
  assert.equal(short.truncated, false)
  const long = truncate('a'.repeat(20), 5)
  assert.equal(long.text, 'aaaaa')
  assert.equal(long.truncated, true)
  assert.match(long.note, /truncat/i)
})

// ---------------------------------------------------------------------------
// 页面状态层（browser-state）：纯函数，离线可测
// ---------------------------------------------------------------------------
await testAsync('状态：normalizeMeta 收敛成固定形状并补默认值', async () => {
  const meta = normalizeMeta({ url: 'https://x/', title: 'T', nodes: '12' })
  assert.equal(meta.url, 'https://x/')
  assert.equal(meta.nodes, 12, '数字字符串应转成数字')
  assert.equal(meta.scrollY, 0, '缺失字段补 0')
  assert.equal(meta.focus, '')
})

await testAsync('状态：signature 只随 url/title/ready/滚动/节点/文本长度变化', async () => {
  const base = normalizeMeta({ url: 'a', title: 't', ready: 'complete', scrollY: 0, nodes: 10, textLen: 100 })
  assert.equal(signature(base), signature({ ...base }), '同样输入必须同签名')
  assert.notEqual(signature(base), signature({ ...base, scrollY: 1 }), '滚动位置变化应改变签名')
  assert.notEqual(signature(base), signature({ ...base, nodes: 11 }), 'DOM 变化应改变签名')
  assert.notEqual(signature(base), signature({ ...base, url: 'b' }), '导航应改变签名')
})

await testAsync('状态：diffLines 首次读取返回全部行', async () => {
  const diff = diffLines('', 'a\nb')
  assert.deepEqual(diff.added, ['a', 'b'])
  assert.equal(diff.changed, true)
})

await testAsync('状态：diffLines 无变化时明确回空', async () => {
  const diff = diffLines('a\nb\nc', 'a\nb\nc')
  assert.equal(diff.changed, false)
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.removed, [])
})

await testAsync('状态：diffLines 只报中间段的变化', async () => {
  const before = 'head\nold1\nold2\ntail'
  const after = 'head\nnew1\ntail'
  const diff = diffLines(before, after)
  assert.equal(diff.changed, true)
  assert.deepEqual(diff.removed, ['old1', 'old2'])
  assert.deepEqual(diff.added, ['new1'])
})

await testAsync('状态：diffLines 大段变化时收敛到上限并标记截断', async () => {
  const before = Array.from({ length: 200 }, (_, i) => `old-${i}`).join('\n')
  const after = Array.from({ length: 200 }, (_, i) => `new-${i}`).join('\n')
  const diff = diffLines(before, after, { limit: 5 })
  assert.equal(diff.truncated, true)
  assert.equal(diff.added.length, 5)
  assert.equal(diff.removed.length, 5)
})

await testAsync('状态：sessionState 按 session 隔离且可重置', async () => {
  const a = sessionState('one')
  a.snapshot = 'x'
  assert.equal(sessionState('one').snapshot, 'x', '同一 session 应保留状态')
  assert.equal(sessionState('two').snapshot, '', '不同 session 不应互相污染')
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 0))
for (const { name, error } of failures) {
  console.error(`✗ ${name}\n  ${error?.message ?? error}`)
}
console.log(`\n单测：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
