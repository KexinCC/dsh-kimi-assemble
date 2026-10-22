/**
 * test/faults.mjs —— 故障注入（离线，不碰真实 daemon/Agent）
 * ============================================================================
 * 跑法：node test/faults.mjs
 *
 * 覆盖三类必须「明确报错而不是猜」的路径：
 *   1. WebBridge 地址指到死端口 → KIMI_WEBRIDGE_DOWN，且 message 含可执行下一步
 *   2. 端口上回了非 JSON（模拟被别的程序占） → KIMI_WEBRIDGE_PORT_BUSY
 *   3. KimiCU exe 不存在 → KIMI_CU_NOT_INSTALLED + 安装链接
 *   4. 窗口解析 0 命中 / 多命中 → KIMI_ARGS 且列出候选
 *   5. daemon 错误信封 → extension_not_connected / 版本提示 各自的错误码
 * ============================================================================
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { resolveConfig } from '../lib/config.mjs'
import * as wb from '../lib/webbridge.mjs'
import * as cu from '../lib/kimicu.mjs'
import { KimiError, CODES } from '../lib/errors.mjs'

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

/** 起一个假服务器，按 handler 回包。 */
async function fakeDaemon(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { addr: `127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

// 1. 死端口
await check('死端口 → KIMI_WEBRIDGE_DOWN，且给出可执行下一步', async () => {
  wb.resetAddrCache()
  const config = resolveConfig({ webbridgeAddr: '127.0.0.1:1', webbridgeAutoStart: false })
  await assert.rejects(
    () => wb.status(config, { force: true }),
    (error) => {
      assert.ok(error instanceof KimiError)
      assert.equal(error.code, CODES.WEBRIDGE_DOWN)
      assert.match(error.message, /kimi-webbridge/)
      return true
    },
  )
})

// 2. 端口被非 daemon 程序占用
await check('非 JSON 回包 → KIMI_WEBRIDGE_PORT_BUSY', async () => {
  wb.resetAddrCache()
  const daemon = await fakeDaemon((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html>not a daemon</html>')
  })
  try {
    const config = resolveConfig({ webbridgeAddr: daemon.addr, webbridgeAutoStart: false })
    await assert.rejects(
      () => wb.call(config, 'list_tabs', {}, { session: 'fault-test' }),
      (error) => {
        assert.equal(error.code, CODES.WEBRIDGE_PORT_BUSY)
        assert.match(error.message, /daemon\.addr/)
        return true
      },
    )
  } finally {
    await daemon.close()
  }
})

// 3. 扩展未连接
await check('extension_not_connected → KIMI_WEBRIDGE_EXTENSION + 操作指引', async () => {
  wb.resetAddrCache()
  const daemon = await fakeDaemon((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'extension_not_connected', message: 'the extension is not connected' } }))
  })
  try {
    const config = resolveConfig({ webbridgeAddr: daemon.addr, webbridgeAutoStart: false })
    await assert.rejects(
      () => wb.call(config, 'list_tabs', {}, { session: 'fault-test' }),
      (error) => {
        assert.equal(error.code, CODES.WEBRIDGE_EXTENSION)
        assert.match(error.message, /extension/i)
        return true
      },
    )
  } finally {
    await daemon.close()
  }
})

// 4. 扩展版本过旧
await check('版本提示 → KIMI_WEBRIDGE_VERSION + 升级链接', async () => {
  wb.resetAddrCache()
  const daemon = await fakeDaemon((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'extension_error', message: 'Please update the Kimi Browser Extension: https://example.invalid' },
      }),
    )
  })
  try {
    const config = resolveConfig({ webbridgeAddr: daemon.addr, webbridgeAutoStart: false })
    await assert.rejects(
      () => wb.call(config, 'snapshot', {}, { session: 'fault-test' }),
      (error) => {
        assert.equal(error.code, CODES.WEBRIDGE_VERSION)
        assert.match(error.message, /kimi-webbridge/)
        return true
      },
    )
  } finally {
    await daemon.close()
  }
})

// 5. 普通工具错误透传
await check('普通 daemon 错误 → KIMI_WEBRIDGE_TOOL 且保留原文', async () => {
  wb.resetAddrCache()
  const daemon = await fakeDaemon((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'tool_error', message: 'session "x" has no tab' } }))
  })
  try {
    const config = resolveConfig({ webbridgeAddr: daemon.addr, webbridgeAutoStart: false })
    await assert.rejects(
      () => wb.call(config, 'click', { selector: '#a' }, { session: 'fault-test' }),
      (error) => {
        assert.equal(error.code, CODES.WEBRIDGE_TOOL)
        assert.match(error.message, /has no tab/)
        return true
      },
    )
  } finally {
    await daemon.close()
  }
})

// 6. KimiCU exe 不存在
await check('KimiCU exe 不存在 → KIMI_CU_NOT_INSTALLED + 安装链接', async () => {
  cu.resetState()
  const config = resolveConfig({ kimicuExePath: 'C:/definitely/not/here/kimi-cu.exe' })
  await assert.rejects(
    () => cu.resolveExe(config, { LOCALAPPDATA: 'C:/also/not/here' }),
    (error) => {
      assert.equal(error.code, CODES.CU_NOT_INSTALLED)
      assert.match(error.message, /setup_windows\.cmd/)
      return true
    },
  )
})

// 7. 窗口解析：0 命中
await check('窗口 0 命中 → KIMI_ARGS 且列出候选', async () => {
  const fakeCall = async (method) => {
    if (method === 'list_windows') return [{ id: 1, title: '记事本', app: 'notepad.exe' }]
    throw new Error('unexpected call')
  }
  await assert.rejects(
    () => cu.resolveWindow(fakeCall, '不存在的窗口'),
    (error) => {
      assert.equal(error.code, CODES.ARGS)
      assert.match(error.message, /记事本/)
      return true
    },
  )
})

// 8. 窗口解析：多命中
await check('窗口多命中 → 拒绝替你猜并列出 id', async () => {
  const fakeCall = async (method) => {
    if (method === 'list_windows') {
      return [
        { id: 11, title: '设置 - 显示', app: 'SystemSettings.exe' },
        { id: 12, title: '设置 - 声音', app: 'SystemSettings.exe' },
      ]
    }
    throw new Error('unexpected call')
  }
  await assert.rejects(
    () => cu.resolveWindow(fakeCall, '设置'),
    (error) => {
      assert.equal(error.code, CODES.ARGS)
      assert.match(error.message, /11/)
      assert.match(error.message, /12/)
      return true
    },
  )
})

// 9. 窗口解析：精确命中唯一
await check('窗口唯一命中 → 返回该窗口', async () => {
  const fakeCall = async (method) => {
    if (method === 'list_windows') {
      return [
        { id: 21, title: '设置', app: 'SystemSettings.exe' },
        { id: 22, title: '设置 - 显示', app: 'SystemSettings.exe' },
      ]
    }
    throw new Error('unexpected call')
  }
  const window = await cu.resolveWindow(fakeCall, '设置')
  assert.equal(window.id, 21)
})

// 10. 工具层：未知参数在「碰运行时之前」就被挡住
// 判据：把 exe 指到不存在的路径 —— 若它先去拉运行时，会得到 KIMI_CU_NOT_INSTALLED；
// 正确行为是直接 KIMI_ARGS。
await check('kimi_cu_script 未知参数 → KIMI_ARGS（不接触运行时）', async () => {
  cu.resetState()
  const config = resolveConfig({ kimicuExePath: 'C:/definitely/not/here/kimi-cu.exe' })
  const { createComputerTools } = await import('../lib/tools/computer.mjs')
  const tools = createComputerTools({ config, ctx: { get: () => undefined } })
  const script = tools.find((tool) => tool.name === 'kimi_cu_script')
  await assert.rejects(
    () => script.execute({ steps: [{ action: 'call', args: { method: 'list_windows', args: { bogus: 1 } } }] }, {}),
    (error) => {
      assert.equal(error.code, CODES.ARGS, `actual: ${error.code}: ${error.message}`)
      assert.match(error.message, /bogus/)
      return true
    },
  )
})

// 10b. validateCall 是纯函数，完全不碰运行时
await check('validateCall：方法/参数白名单（纯函数）', async () => {
  assert.throws(() => cu.validateCall('sky_dance', {}), (error) => error.code === CODES.ARGS)
  assert.throws(() => cu.validateCall('list_windows', { bogus: 1 }), (error) => {
    assert.equal(error.code, CODES.ARGS)
    assert.match(error.message, /bogus/)
    return true
  })
  cu.validateCall('list_windows', {})
  cu.validateCall('click', { window: { app: 'a', id: 1 }, x: 1, y: 2 })
})

// 11. 非 Windows 平台
await check('非 Windows → KIMI_UNSUPPORTED_PLATFORM', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    assert.throws(() => cu.assertPlatform(), (error) => error.code === CODES.UNSUPPORTED_PLATFORM)
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
})

console.log(`\n故障注入：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  for (const { name, error } of failures) console.error(`✗ ${name}\n  ${error.stack ?? error.message}`)
  process.exitCode = 1
}
