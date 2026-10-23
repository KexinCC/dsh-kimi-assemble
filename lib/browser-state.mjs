/**
 * lib/browser-state.mjs —— 页面状态探针：元信息、签名、变更等待、快照 diff
 * ============================================================================
 * 为什么单独一层：
 *   - 「动作到底生效了吗」和「页面上现在有什么」是两件事，daemon 的 action 只保证
 *     dispatch，不保证 effect。这一层用一次轻量 evaluate 拿到页面指纹，让工具层能
 *     判断「改了 / 没改 / 不知道」，而不是把 dispatch 成功当成成功。
 *   - 指纹只读文档级廉价字段（url / title / readyState / 节点数 / 文本长度 / 滚动位），
 *     一次 evaluate 通常 <10ms，比再取一次 aria 树便宜一个量级。
 *   - 纯函数（signature / diffLines / normalizeMeta / formatMetaLines）不依赖网络，
 *     单测可以直接跑。
 * ============================================================================
 */
import { call } from './webbridge.mjs'

/** 在页面里跑的元信息探测。必须包 IIFE：evaluate 的 realm 是共享的，重复 const 会撞名。 */
export const META_CODE = `(() => {
  const d = document
  const tag = (el) => {
    if (!el || !el.tagName) return ''
    let s = el.tagName.toLowerCase()
    if (el.id) s += '#' + el.id
    const label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder'))
    if (label) s += '[' + String(label).slice(0, 40) + ']'
    else if (el.innerText) s += ' "' + String(el.innerText).trim().slice(0, 40) + '"'
    return s
  }
  const body = d.body
  return {
    url: location.href,
    title: d.title,
    ready: d.readyState,
    lang: (d.documentElement && d.documentElement.lang) || '',
    viewportW: innerWidth,
    viewportH: innerHeight,
    scrollX: Math.round(scrollX),
    scrollY: Math.round(scrollY),
    scrollH: Math.max(body ? body.scrollHeight : 0, d.documentElement ? d.documentElement.scrollHeight : 0),
    nodes: d.getElementsByTagName('*').length,
    textLen: body ? (body.textContent || '').length : 0,
    focus: tag(d.activeElement),
    selection: String(d.getSelection ? d.getSelection() : '').slice(0, 80),
    frames: d.querySelectorAll('iframe,frame').length,
    forms: d.forms ? d.forms.length : 0,
    links: d.querySelectorAll('a[href]').length,
    buttons: d.querySelectorAll('button,[role=button],input[type=button],input[type=submit]').length,
    inputs: d.querySelectorAll('input,textarea,select,[contenteditable=""],[contenteditable=true]').length,
  }
})()`

const SESSIONS_MAX = 16
const states = new Map()

/** 每个 session 记住最近一次的元信息与快照文本（用于 diff / 变更判定）。 */
export function sessionState(name) {
  const key = String(name ?? 'default')
  let state = states.get(key)
  if (!state) {
    if (states.size >= SESSIONS_MAX) {
      const oldest = states.keys().next().value
      states.delete(oldest)
    }
    state = { meta: null, metaAt: 0, snapshot: '', snapshotAt: 0 }
    states.set(key, state)
  }
  return state
}

/** 仅供测试：清空所有 session 记忆。 */
export function resetSessionState() {
  states.clear()
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/** 把页面返回的原始值收敛成固定形状（字段缺了就是缺了，不猜）。 */
export function normalizeMeta(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    url: String(value.url ?? ''),
    title: String(value.title ?? ''),
    ready: String(value.ready ?? ''),
    lang: String(value.lang ?? ''),
    viewportW: num(value.viewportW),
    viewportH: num(value.viewportH),
    scrollX: num(value.scrollX),
    scrollY: num(value.scrollY),
    scrollH: num(value.scrollH),
    nodes: num(value.nodes),
    textLen: num(value.textLen),
    focus: String(value.focus ?? ''),
    selection: String(value.selection ?? ''),
    frames: num(value.frames),
    forms: num(value.forms),
    links: num(value.links),
    buttons: num(value.buttons),
    inputs: num(value.inputs),
  }
}

/**
 * 页面指纹：只包含「动作可能改变」的廉价字段。
 * 导航改 url/title；DOM 更新改 nodes/textLen；滚动改 scrollY；异步渲染改 nodes/textLen。
 */
export function signature(meta) {
  const m = normalizeMeta(meta)
  return [m.url, m.title, m.ready, m.scrollY, m.nodes, m.textLen].join('|')
}

/** 读一次元信息（默认 5 秒超时；调用方按需覆盖）。 */
export async function readMeta(config, session, options = {}) {
  const data = await call(config, 'evaluate', { code: META_CODE }, {
    session,
    timeoutMs: options.timeoutMs ?? 5_000,
    signal: options.signal,
  })
  const state = sessionState(session)
  const meta = normalizeMeta(data?.value ?? data)
  state.meta = meta
  state.metaAt = Date.now()
  return meta
}

/** 读元信息但永不抛错：验证是加分项，不能因为它把主操作搞失败。 */
export async function tryReadMeta(config, session, options = {}) {
  try {
    return { ok: true, meta: await readMeta(config, session, options) }
  } catch (error) {
    return { ok: false, meta: null, error }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 动作之后等页面出现变化。
 * 返回 changed=true/false，或 checked=false（探针不可用，例如原生弹窗把 JS 冻住了）。
 *
 * 退避是几何的：第一次探测很早（导航类动作通常 ~100ms 内就能看到 url/ready 变化），
 * 之后逐步拉长。总预算等于 verifyMs，所以「确实没变」的结论仍然可靠，而「变了」的
 * 动作不必等满整个窗口。
 */
export async function waitForChange(config, session, beforeSignature, options = {}) {
  const budget = options.budgetMs ?? 700
  const attempts = options.attempts ?? 3
  // 首探 ~budget/7，之后翻倍：700ms → 100 / 200 / 400
  const gaps = []
  let remaining = budget
  let gap = Math.max(60, Math.round(budget / 7))
  for (let i = 0; i < attempts; i += 1) {
    const use = Math.min(gap, remaining)
    if (use <= 0) break
    gaps.push(use)
    remaining -= use
    gap *= 2
  }
  let lastMeta = null
  let probeFailures = 0
  for (let attempt = 0; attempt < gaps.length; attempt += 1) {
    await sleep(gaps[attempt])
    const probe = await tryReadMeta(config, session, { timeoutMs: options.timeoutMs ?? 3_000, signal: options.signal })
    if (!probe.ok) {
      // 导航过程中页面会在"卸载"和"新文档"之间，evaluate 可能短暂失败 —— 不能就此判定「没变化」
      probeFailures += 1
      continue
    }
    lastMeta = probe.meta
    if (signature(probe.meta) !== beforeSignature) {
      return { checked: true, changed: true, meta: probe.meta, attempts: attempt + 1, elapsedMs: gaps.slice(0, attempt + 1).reduce((a, b) => a + b, 0) }
    }
  }
  // 全部探针都失败 = 页面没法观察（原生弹窗、极端加载态）：如实说「没校验成」
  if (probeFailures >= gaps.length) return { checked: false, changed: false, meta: null, attempts: gaps.length }
  return { checked: true, changed: false, meta: lastMeta, attempts: gaps.length, elapsedMs: budget }
}

/** 把字符串安全地塞进页面里的 JS 字面量。 */
function jsString(value) {
  return JSON.stringify(String(value))
}

/**
 * 在页面里等文本出现/消失。
 *
 * 实现方式是客户端轮询 + 页面里的同步判断（每次往返 ~12ms），不是靠 daemon 的 wait，
 * 也不是靠 evaluate 的 await Promise。三者都实测过（fixture 页面、本机 daemon）：
 *   - daemon 的 wait 等一个 1.2s 后才渲染的文本用了 2993ms（轮询粒度太粗）；
 *   - evaluate 的 await Promise 有约 1s 的固定开销：等 200ms 的 Promise 也要 1008ms，
 *     等 1200ms 的是 1474ms —— 不可用于等待；
 *   - 用 innerText 做判断会触发重排，长页面上单次 ~50ms；
 *   - 用 textContent 虽然快，但会把内联 <script> 里的字面量也算进去（实测 slow 页面上
 *     'LATE_OK' 只存在于脚本源码里，却会被判成「已出现」——假阳性）。
 * 折中：自己遍历 DOM 拼文本并跳过 SCRIPT/STYLE 等不可见节点，约 1–3ms 且语义正确。
 */
export async function waitForPageText(config, session, options = {}) {
  const { text, gone = false, timeoutMs = 8_000, gapMs = 100, signal } = options
  const needle = jsString(text)
  const code = `(() => {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME'])
    let buf = ''
    const walk = (parent) => {
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 3) { buf += node.nodeValue; continue }
        if (node.nodeType !== 1 || skip.has(node.tagName)) continue
        walk(node)
      }
    }
    if (document.body) walk(document.body)
    return ${gone ? '!buf.includes(needle)' : 'buf.includes(needle)'}
  })()`.replace('needle', needle)
  const started = Date.now()
  const deadline = started + Math.max(100, timeoutMs)
  for (;;) {
    let matched = false
    try {
      const data = await call(config, 'evaluate', { code }, { session, timeoutMs: 3_000, signal })
      const value = data?.value ?? data
      matched = value === true
    } catch {
      return { ok: false, elapsedMs: Date.now() - started, degraded: true }
    }
    if (matched) return { ok: true, elapsedMs: Date.now() - started }
    if (Date.now() >= deadline) return { ok: false, elapsedMs: Date.now() - started }
    await sleep(gapMs)
  }
}

/** 等文档进入目标 readyState（默认 complete）；返回是否达成。 */
export async function waitForReady(config, session, target = 'complete', options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000)
  const gapMs = options.gapMs ?? 120
  let meta = null
  for (;;) {
    const probe = await tryReadMeta(config, session, { timeoutMs: 3_000, signal: options.signal })
    if (!probe.ok) return { ok: false, meta: null }
    meta = probe.meta
    if (meta.ready === target) return { ok: true, meta }
    if (Date.now() >= deadline) return { ok: false, meta }
    await sleep(gapMs)
  }
}

/**
 * 行级 diff：只回「变了的行」，让模型看到状态变化而不必重读整棵树。
 * 先剥公共前缀/后缀；中间部分小就直接 +/- 全列，大了就只列增删集合（各有上限）。
 */
export function diffLines(beforeText, afterText, options = {}) {
  const limit = options.limit ?? 40
  const before = String(beforeText ?? '').split('\n')
  const after = String(afterText ?? '').split('\n')
  if (!beforeText) return { added: after.slice(0, limit), removed: [], truncated: after.length > limit, changed: after.length > 0 }
  if (before.join('\n') === after.join('\n')) return { added: [], removed: [], truncated: false, changed: false }

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const oldMiddle = before.slice(prefix, before.length - suffix)
  const newMiddle = after.slice(prefix, after.length - suffix)
  const small = oldMiddle.length <= 60 && newMiddle.length <= 60
  let added = newMiddle
  let removed = oldMiddle
  if (!small) {
    const oldSet = new Map()
    for (const line of oldMiddle) oldSet.set(line, (oldSet.get(line) ?? 0) + 1)
    added = []
    for (const line of newMiddle) {
      const count = oldSet.get(line) ?? 0
      if (count > 0) oldSet.set(line, count - 1)
      else added.push(line)
    }
    const newSet = new Map()
    for (const line of newMiddle) newSet.set(line, (newSet.get(line) ?? 0) + 1)
    removed = []
    for (const line of oldMiddle) {
      const count = newSet.get(line) ?? 0
      if (count > 0) newSet.set(line, count - 1)
      else removed.push(line)
    }
  }
  const truncated = added.length > limit || removed.length > limit
  return { added: added.slice(0, limit), removed: removed.slice(0, limit), truncated, changed: true, prefix }
}
