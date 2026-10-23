/**
 * bench/run.mjs —— A/B 对照实验驱动器
 * ============================================================================
 * 跑法：
 *   node bench/run.mjs --label=A --tree=<v1.0.1 checkout> --reps=5
 *   node bench/run.mjs --label=B --tree=. --reps=5
 *   node bench/run.mjs --label=A --micro        # 只跑原语微基准
 *   输出末尾一行 JSON，供 bench/compare.mjs 汇总。
 *
 * 设计要点（决定了结论可不可信）：
 *   1. 策略固定：两臂跑同一套「称职模型大概会做的事」，差异只来自工具面，不是采样运气。
 *   2. oracle 判定：看服务端记录/页面标记，不看工具自述 —— 静默失败正是要抓的对象。
 *   3. oracle 静置：导航是异步的，点完立刻查会误判成失败；统一轮询到 2s 再说。
 *   4. 预热丢弃：首轮丢掉（冷启动、JIT、daemon 首次连接）。
 *   5. 每轮独立 session + 先 reset oracle，避免上一轮串味。
 * ============================================================================
 */
import { startServer } from './server.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = { reps: 5, warmup: 1, tree: resolve(HERE, '..'), label: 'A', micro: false }
  for (const arg of argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match) out[match[1]] = match[2]
    else if (arg.startsWith('--')) out[arg.slice(2)] = true
  }
  out.reps = Number(out.reps) || 5
  out.warmup = Number(out.warmup) || 0
  out.tree = resolve(out.tree)
  return out
}

const args = parseArgs(process.argv)

async function loadArm(tree) {
  const { createBrowserTools } = await import(pathToFileURL(join(tree, 'lib', 'tools', 'browser.mjs')).href)
  const { resolveConfig } = await import(pathToFileURL(join(tree, 'lib', 'config.mjs')).href)
  const { setLanguage } = await import(pathToFileURL(join(tree, 'lib', 'i18n.mjs')).href)
  setLanguage('en')
  const config = resolveConfig({})
  const tools = createBrowserTools({ config, ctx: { get: () => undefined } })
  return { tools, config, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

/** 模型看到的那段文本（render 的正确入口是 tool.output.render(args, value)）。 */
function rendered(arm, name, value) {
  const tool = arm.byName.get(name)
  if (!tool?.output?.render) return ''
  try {
    return (tool.output.render({}, value) ?? []).map((block) => String(block?.text ?? '')).join('\n')
  } catch {
    return ''
  }
}

/** 调一次工具，记录毫秒数与返回文本字节数。 */
async function invoke(arm, name, toolArgs, session) {
  const tool = arm.byName.get(name)
  if (!tool) return { missing: true, ms: 0, bytes: 0, error: `tool ${name} not present in this arm` }
  const started = process.hrtime.bigint()
  try {
    const value = await tool.execute({ ...toolArgs, session }, { agent: { id: session }, signal: undefined })
    const text = rendered(arm, name, value)
    return { value, text, ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: text.length }
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 300), ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: 0 }
  }
}

/** 导航类 oracle 要等异步请求落地；轮询到 2s 再判负。 */
async function settle(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 80))
  }
}

// ---------------------------------------------------------------------------
// 任务定义
//   policy 返回 { calls, reported, detected? }
//   check(server, result) → 是否达成（由 oracle 判定）
// ---------------------------------------------------------------------------
const TASKS = [
  {
    id: 'click-nav',
    start: '/click-nav.html',
    check: (server) => server.hits.includes('/done.html'),
    baseline: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/click-nav.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#go' }, s)
      calls.push(click)
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      return { calls, reported: Boolean(click.value?.clicked) }
    },
    newarm: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/click-nav.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#go' }, s)
      calls.push(click)
      return { calls, reported: Boolean(click.value?.clicked) }
    },
  },
  {
    id: 'silent',
    start: '/silent.html',
    /** 成功 = 工具明确指出「点了没生效」 */
    check: (_server, result) => result.detected === true,
    baseline: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/silent.html` }, s))
      const read = await invoke(arm, 'kimi_browser_read', {}, s)
      calls.push(read)
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#noop' }, s)
      calls.push(click)
      const after = await invoke(arm, 'kimi_browser_read', {}, s)
      calls.push(after)
      const detected = Boolean(read.text) && read.text !== after.text
      return { calls, reported: Boolean(click.value?.clicked), detected }
    },
    newarm: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/silent.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#noop' }, s)
      calls.push(click)
      const detected = click.value?.changed === false
      return { calls, reported: click.value?.changed === true, detected }
    },
  },
  {
    id: 'slow',
    start: '/slow.html',
    check: (_server, result) => result.detected === true,
    baseline: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/slow.html` }, s))
      const read1 = await invoke(arm, 'kimi_browser_read', {}, s)
      calls.push(read1)
      let ok = read1.text.includes('LATE_OK')
      if (!ok) {
        const read2 = await invoke(arm, 'kimi_browser_read', {}, s)
        calls.push(read2)
        ok = read2.text.includes('LATE_OK')
      }
      return { calls, reported: ok, detected: ok }
    },
    newarm: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/slow.html` }, s))
      const wait = await invoke(arm, 'kimi_browser_wait', { text: 'LATE_OK', timeout_ms: 5_000 }, s)
      calls.push(wait)
      const read = await invoke(arm, 'kimi_browser_read', {}, s)
      calls.push(read)
      const ok = wait.value?.ok === true && read.text.includes('LATE_OK')
      return { calls, reported: wait.value?.ok === true, detected: ok }
    },
  },
  {
    id: 'list',
    start: '/list.html',
    check: (server) => server.hits.includes('/row.html'),
    baseline: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/list.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#row-42' }, s)
      calls.push(click)
      return { calls, reported: Boolean(click.value?.clicked) }
    },
    newarm: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/list.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#row-42' }, s)
      calls.push(click)
      return { calls, reported: Boolean(click.value?.clicked) }
    },
  },
  {
    id: 'form',
    start: '/form.html',
    check: (server) => server.hits.includes('/form-done.html'),
    baseline: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/form.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const fill = await invoke(arm, 'kimi_browser_fill', { selector: '#q', value: 'kimi', submit: true }, s)
      calls.push(fill)
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      return { calls, reported: Boolean(fill.value?.filled) }
    },
    newarm: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/form.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const fill = await invoke(arm, 'kimi_browser_fill', { selector: '#q', value: 'kimi', submit: true }, s)
      calls.push(fill)
      // 工具说「回车没带来变化」→ 改点真正的提交按钮（一次，不循环）
      if (fill.value?.changed === false) {
        const submit = await invoke(arm, 'kimi_browser_click', { selector: '#submit' }, s)
        calls.push(submit)
      }
      return { calls, reported: Boolean(fill.value?.filled) }
    },
  },
  {
    id: 'dialog',
    start: '/dialog.html',
    check: (server) => server.hits.includes('/dialog-done.html'),
    baseline: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/dialog.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#confirm' }, s)
      calls.push(click)
      // 基线没有 dialog 工具，只能再读一次（会被弹窗挡住）
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      return { calls, reported: Boolean(click.value?.clicked) }
    },
    newarm: async (arm, base, s) => {
      const calls = []
      calls.push(await invoke(arm, 'kimi_browser_open', { url: `${base}/dialog.html` }, s))
      calls.push(await invoke(arm, 'kimi_browser_read', {}, s))
      const click = await invoke(arm, 'kimi_browser_click', { selector: '#confirm' }, s)
      calls.push(click)
      const accept = await invoke(arm, 'kimi_browser_dialog', { action: 'accept' }, s)
      calls.push(accept)
      return { calls, reported: Boolean(accept.value?.ok ?? true) }
    },
  },
]

const median = (values) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const p95 = (values) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.round(0.95 * (sorted.length - 1)))]
}

async function runMicro(arm, server) {
  const cases = [
    ['open', 'kimi_browser_open', () => ({ url: `${server.url}/list.html` })],
    ['read', 'kimi_browser_read', () => ({})],
    ['read+meta', 'kimi_browser_read', () => ({ include_meta: true })],
  ]
  const out = []
  for (const [label, name, makeArgs] of cases) {
    if (!arm.byName.has(name)) continue
    const ms = []
    const bytes = []
    for (let i = 0; i < args.reps; i += 1) {
      const session = `micro-${label}-${i}`
      const result = await invoke(arm, name, makeArgs(), session)
      if (!result.error) {
        ms.push(result.ms)
        bytes.push(result.bytes)
      }
      try {
        await arm.byName.get('kimi_browser_tabs')?.execute({ action: 'close_session', session }, { agent: { id: session } })
      } catch {
        /* ignore */
      }
    }
    out.push({ primitive: label, p50Ms: Math.round(median(ms)), p95Ms: Math.round(p95(ms)), bytes: Math.round(median(bytes)) })
  }
  return out
}

async function main() {
  const arm = await loadArm(args.tree)
  const hasNewTools = arm.byName.has('kimi_browser_wait')
  const policy = hasNewTools ? 'newarm' : 'baseline'
  const server = await startServer()

  console.log(`label=${args.label} tree=${args.tree}`)
  console.log(`policy=${policy} reps=${args.reps} warmup=${args.warmup}`)
  console.log(`fixtures=${server.url}\n`)

  // 预热（丢弃）
  for (let i = 0; i < args.warmup; i += 1) {
    const session = `warm-${i}`
    try {
      await arm.byName.get('kimi_browser_open')?.execute({ url: `${server.url}/click-nav.html`, session }, { agent: { id: session } })
      await arm.byName.get('kimi_browser_read')?.execute({ session }, { agent: { id: session } })
    } catch {
      /* 预热失败不记 */
    }
    try {
      await arm.byName.get('kimi_browser_tabs')?.execute({ action: 'close_session', session }, { agent: { id: session } })
    } catch {
      /* ignore */
    }
  }

  let micro = []
  if (args.micro) {
    micro = await runMicro(arm, server)
    console.table(micro)
  }

  const rows = []
  for (const task of TASKS) {
    const runs = []
    for (let rep = 0; rep < args.reps; rep += 1) {
      const session = `${args.label}-${task.id}-${rep}`
      server.resetHits()
      const started = process.hrtime.bigint()
      const result = await task[policy](arm, server.url, session)
      // 策略自身的耗时（不含 oracle 静置）：延迟指标只能用这个，否则失败任务会被 2s 轮询污染
      const policyMs = Number(process.hrtime.bigint() - started) / 1e6
      const ok = await settle(() => task.check(server, result))
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6
      const calls = result.calls.filter(Boolean)
      runs.push({
        ok,
        wallMs,
        policyMs,
        reported: result.reported === true,
        callCount: calls.length,
        bytes: calls.reduce((sum, call) => sum + (call.bytes ?? 0), 0),
        errors: calls.filter((call) => call.error).map((call) => call.error),
      })
      try {
        await arm.byName.get('kimi_browser_tabs')?.execute({ action: 'close_session', session }, { agent: { id: session } })
      } catch {
        /* ignore */
      }
    }
    const okCount = runs.filter((run) => run.ok).length
    rows.push({
      task: task.id,
      success: `${okCount}/${runs.length}`,
      successRate: okCount / runs.length,
      // 静默失败：自称成功但 oracle 没达成
      silentFail: runs.filter((run) => run.reported && !run.ok).length,
      p50Ms: Math.round(median(runs.map((run) => run.policyMs))),
      p95Ms: Math.round(p95(runs.map((run) => run.policyMs))),
      calls: median(runs.map((run) => run.callCount)),
      bytes: Math.round(median(runs.map((run) => run.bytes))),
      sampleError: runs.flatMap((run) => run.errors)[0]?.slice(0, 160) ?? '',
    })
  }

  await server.close()

  console.table(
    rows.map((row) => ({
      task: row.task,
      success: row.success,
      silentFail: row.silentFail,
      p50Ms: row.p50Ms,
      p95Ms: row.p95Ms,
      calls: row.calls,
      bytes: row.bytes,
    })),
  )
  for (const row of rows) {
    if (row.sampleError) console.log(`  [${row.task}] ${row.sampleError}`)
  }

  const summary = {
    label: args.label,
    tree: args.tree,
    policy,
    reps: args.reps,
    totalSuccess: rows.reduce((sum, row) => sum + row.successRate, 0) / rows.length,
    totalSilentFail: rows.reduce((sum, row) => sum + row.silentFail, 0),
    totalCalls: rows.reduce((sum, row) => sum + row.calls, 0),
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    micro,
    rows,
  }
  console.log(`\nRESULT ${JSON.stringify(summary)}`)
}

await main()
