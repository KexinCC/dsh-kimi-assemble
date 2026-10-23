/**
 * lib/tools/browser.mjs —— kimi_browser_* 工具
 * ============================================================================
 * 全部走 lib/webbridge.mjs 的 call()，不经过 shell。
 *
 * 设计取舍（agent-experience）：
 *   - 常用动作给精确 schema（open / read / click / fill / screenshot / tabs），
 *     参数写错时错误能点到字段；
 *   - 其余 30 个 daemon action 收进 kimi_browser_cmd 一个逃生口，避免 35 个
 *     工具撑爆上下文，同时保证「没有做不到的动作」。
 *   - selector 统一归一化：e2000356 / ref=e2000356 / [ref=e2000356] / @e2000356
 *     都收敛成 @e2000356 —— 模型从 aria 文本里抄 ref 时形态不固定。
 * ============================================================================
 */
import { defineTool, objectSchema, stringField, boolField, intField, objField, textBlock, truncate } from '../tool.mjs'
import { call, assertHttpUrl } from '../webbridge.mjs'
import { attachScreenshotFile } from '../images.mjs'
import { argsError, KimiError } from '../errors.mjs'
import { t } from '../i18n.mjs'
import {
  diffLines,
  readMeta,
  sessionState,
  signature,
  tryReadMeta,
  waitForChange,
  waitForPageText,
  waitForReady,
} from '../browser-state.mjs'

/** daemon 支持的完整 action 列表（从 v2.0.26 实测拿到）。 */
export const BROWSER_ACTIONS = Object.freeze([
  'navigate', 'find_tab', 'find', 'evaluate', 'network', 'snapshot', 'read_page',
  'click', 'fill', 'mouse_click', 'cdp', 'key_type', 'send_keys', 'screenshot',
  'scroll', 'save_as_pdf', 'upload', 'close_tab', 'list_tabs', 'list_browser_tabs',
  'attach_tab', 'activate_tab', 'close_session', 'wait', 'dialog', 'select_option',
  'hover', 'set_checked', 'drag', 'go_back', 'go_forward', 'reload',
  'inspect_region', 'highlight_region', 'clear_highlight',
])

/**
 * 归一化 selector / ref 写法。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSelector(raw) {
  const value = String(raw ?? '').trim()
  if (!value) throw argsError(t('err.selectorRequired'))
  // [ref=e12] / ref=e12 / @e12 / e12
  let match = /^\[?ref=["']?(e\d+)["']?\]?$/i.exec(value)
  if (match) return `@${match[1]}`
  match = /^@?(e\d+)$/i.exec(value)
  if (match) return `@${match[1]}`
  return value
}

/** 派生本会话的 session 名：同一 agent 的所有浏览器动作落进同一个标签组。 */
export function sessionNameFor(agent, override) {
  const raw = String(override ?? '').trim()
  if (raw) return raw.slice(0, 64)
  const id = String(agent?.id ?? 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12)
  return `dsh-${id || 'default'}`
}

/** 把 daemon 的 snapshot 结果转成紧凑文本。 */
function formatSnapshot(data, maxChars) {
  const header = [`url: ${data?.url ?? ''}`, `title: ${data?.title ?? ''}`]
  if (Array.isArray(data?.tree)) {
    // 默认（非 aria）形态：树节点数组
    const lines = []
    const walk = (nodes, depth) => {
      for (const node of nodes ?? []) {
        const name = node?.name ? ` "${node.name}"` : ''
        const ref = node?.ref ? ` [${node.ref}]` : ''
        lines.push(`${'  '.repeat(depth)}- ${node?.role ?? 'node'}${name}${ref}`)
        if (Array.isArray(node?.children)) walk(node.children, depth + 1)
      }
    }
    walk(data.tree, 0)
    const joined = lines.join('\n')
    const cut = truncate(joined, maxChars)
    return [...header, cut.text, cut.truncated ? cut.note : '', data?.note ?? ''].filter(Boolean).join('\n')
  }
  const body = String(data?.tree_text ?? '')
  const cut = truncate(body, maxChars)
  return [
    ...header,
    cut.text,
    cut.truncated ? cut.note : '',
    data?.next_cursor ? t('render.nextCursor', { cursor: data.next_cursor }) : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 一行页面状态（标题/URL/滚动/焦点/元素计数）。
 * 读页面时默认附在快照前面：模型不用再额外调一次就知道「我在哪、页面什么状态」。
 */
function formatMeta(meta) {
  if (!meta) return ''
  const focus = meta.focus || t('meta.focusNone')
  const lines = [
    t('meta.line', { title: meta.title || '—', url: meta.url }),
    t('meta.state', { ready: meta.ready, scrollY: meta.scrollY, scrollH: meta.scrollH, nodes: meta.nodes, focus }),
    t('meta.counts', { links: meta.links, buttons: meta.buttons, inputs: meta.inputs, forms: meta.forms, frames: meta.frames }),
  ]
  if (meta.selection) lines[1] += t('meta.focusSelection', { text: meta.selection })
  return lines.join('\n')
}

/** 把动作前后两份页面指纹翻译成「变了什么」。 */
function describeChange(before, after) {
  if (!before || !after) return ''
  const parts = []
  if (before.url !== after.url) parts.push(t('verify.url', { url: after.url }))
  if (before.title !== after.title) parts.push(t('verify.title', { title: after.title }))
  if (before.ready !== after.ready) parts.push(t('verify.ready', { ready: after.ready }))
  if (before.nodes !== after.nodes) parts.push(t('verify.nodes', { nodes: after.nodes }))
  if (before.scrollY !== after.scrollY) parts.push(t('verify.scroll', { scrollY: after.scrollY, scrollH: after.scrollH }))
  return parts.join(' · ')
}

/** 扩展侧对「ref 过期 / 元素找不到」的几种说法。 */
const STALE_PATTERN = /stale|no such element|not found|does not exist|detached|invalid selector|no element|element.*(gone|missing)|referenced node/i
function isStaleError(error) {
  return STALE_PATTERN.test(String(error?.message ?? error))
}

/**
 * 页面被原生弹窗冻住时，探测动作本身也会挂住 —— 这时主动问 daemon 有没有弹窗。
 * @returns {Promise<string|null>} 描述文字；没有弹窗时返回 null
 */
async function probeDialog(config, session, exec) {
  try {
    const data = await call(config, 'dialog', { action: 'status' }, { session, signal: exec.signal, timeoutMs: 4_000 })
    if (data?.open === false) return null
    const type = String(data?.type ?? '').trim()
    const message = String(data?.message ?? '').trim()
    if (!type && !message) return null
    return [type || 'dialog', message ? JSON.stringify(message) : ''].filter(Boolean).join(' ')
  } catch {
    return null
  }
}

/**
 * 执行一个「会改变页面」的动作，并把它做成可验证的：
 *   1. 先取页面指纹；
 *   2. 失败且看起来是 ref/元素失效 → 重新读一次快照后重试一次（同时把新快照写进错误里，
 *      模型可以在同一轮挑新 ref，不必再来一轮）；
 *   3. 成功后短暂观察页面是否真的变了，把「变了什么 / 没变」一起返回。
 * 验证失败绝不让主操作报错：探针不可用（例如原生弹窗冻结 JS）时标记 checked=false。
 *
 * @param {{config: object, session: string, exec: object, run: () => Promise<any>, verifyMs?: number}} input
 */
async function runVerified({ config, session, exec, run, verifyMs = 600 }) {
  const beforeProbe = await tryReadMeta(config, session, { signal: exec.signal, timeoutMs: 4_000 })
  const before = beforeProbe.meta

  let data
  let retried = false
  let staleDetail = ''
  let dialogBlocked = null
  try {
    data = await run()
  } catch (error) {
    const message = String(error?.message ?? error)
    // 原生弹窗会冻结页面 JS：这不是「动作失败」，而是一个需要先处理的状态
    if (/confirm dialog|alert dialog|prompt dialog|JavaScript dialog|is now blocked/i.test(message)) {
      // 优先用 daemon 报的干净描述（例如 confirm "Delete this item?"），拿不到才退回错误首行
      dialogBlocked = (await probeDialog(config, session, exec)) ?? message.split(String.fromCharCode(10))[0].slice(0, 160)
      data = { dialogBlocked: true }
    } else if (!isStaleError(error)) {
      throw error
    } else {
      staleDetail = String(error?.message ?? error).slice(0, 240)
      let freshSnapshot = ''
      try {
        const snap = await call(
          config,
          'snapshot',
          { format: 'aria', max_chars: Math.min(3_000, config.browserReadMaxChars) },
          { session, signal: exec.signal },
        )
        freshSnapshot = formatSnapshot(snap, 3_000)
      } catch {
        /* 快照拿不到就算了，错误本身仍然有意义 */
      }
      try {
        data = await run()
        retried = true
      } catch (second) {
        const lines = [
          t('verify.staleRetried', { detail: staleDetail }),
          t('verify.freshFail', { detail: String(second?.message ?? second).slice(0, 400) }),
        ]
        if (freshSnapshot) lines.push('', t('verify.staleHint'), freshSnapshot)
        throw new KimiError(second?.code ?? 'KIMI_WEBRIDGE_TOOL', lines.join('\n'), { cause: second })
      }
    }
  }

  let verify = { checked: false, changed: null, meta: null }
  // 前置探测失败通常意味着页面已经被弹窗冻住 —— 问一次，别让模型只看到「已点击」
  if (!dialogBlocked && !before) {
    dialogBlocked = await probeDialog(config, session, exec)
    if (dialogBlocked) data = { dialogBlocked: true }
  }
  if (!dialogBlocked && before && verifyMs > 0) {
    verify = await waitForChange(config, session, signature(before), {
      budgetMs: verifyMs,
      signal: exec.signal,
    })
  }

  if (!dialogBlocked && before && !verify.checked) {
    dialogBlocked = await probeDialog(config, session, exec)
  }

  return {
    data,
    before,
    after: verify.meta ?? before,
    retried,
    checked: verify.checked,
    changed: verify.changed,
    changeDetail: verify.changed ? describeChange(before, verify.meta) : '',
    dialogBlocked,
  }
}

/** URL 是否匹配：先比子串，失败再当正则试一次（写错正则就当不匹配）。 */
function urlMatches(current, expected) {
  if (!expected) return true
  if (String(current).includes(expected)) return true
  try {
    return new RegExp(expected).test(String(current))
  } catch {
    return false
  }
}

/** 校验窗口：显式参数 > 配置；配置关掉时一律 0。 */
function resolveVerifyMs(config, explicit) {
  if (config.browserVerify === 'off') return 0
  if (explicit === false) return 0
  if (explicit === true) return Math.max(config.browserVerifyMs, 100)
  return config.browserVerifyMs
}

export function createBrowserTools({ config, ctx }) {
  const tools = []

  const makeSession = (agent, args) => sessionNameFor(agent, args?.session)

  // ---------------------------------------------------------------- open
  tools.push(
    defineTool({
      name: 'kimi_browser_open',
      description:
        "Open a URL in the user's real browser (their logged-in Chrome, through the Kimi extension). " +
        'Waits for the document to finish loading by default, so the next action does not race the page. ' +
        'Returns the final URL, title, tab id and page state; pages opened during one task are grouped into one tab group. ' +
        'Close them with kimi_browser_tabs only when the user asks.',
      parameters: objectSchema({
        url: { ...stringField('URL to open; a bare domain gets https:// prepended'), required: true },
        new_tab: boolField('true = open in a new tab (default, keeps existing pages); false = navigate the current tab', { default: true }),
        wait_until: {
          schema: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'none'],
            description:
              'load (default) = wait for readyState complete; domcontentloaded = wait until parsing is done; none = return immediately',
          },
        },
        group_title: stringField('Tab group title, visible in the user browser. Defaults to the plugin config browserGroupTitle.'),
        session: stringField('Session name shared by every action of one task; defaults to a name derived from the agent.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const url = assertHttpUrl(args.url)
        const session = makeSession(exec.agent, args)
        const waitUntil = args.wait_until ?? 'load'
        const data = await call(
          config,
          'navigate',
          {
            url,
            newTab: args.new_tab !== false,
            group_title: args.group_title || config.browserGroupTitle,
          },
          { session, signal: exec.signal },
        )

        // 标题与页面状态都从一次 meta 里拿，省掉原来那次 list_tabs 往返。
        let meta = null
        if (waitUntil === 'none') {
          meta = (await tryReadMeta(config, session, { signal: exec.signal })).meta
        } else {
          const target = waitUntil === 'domcontentloaded' ? 'interactive' : 'complete'
          const probe = await waitForReady(config, session, target, {
            timeoutMs: waitUntil === 'domcontentloaded' ? 6_000 : 10_000,
            signal: exec.signal,
          })
          meta = probe.meta ?? (await tryReadMeta(config, session, { signal: exec.signal })).meta
        }

        return {
          url: meta?.url || String(data?.url ?? url),
          tabId: data?.tabId ?? null,
          title: meta?.title ?? '',
          ready: meta?.ready ?? '',
          waitUntil,
          session,
          meta,
          hint: t('render.hintReadFirst'),
        }
      },
      render(value) {
        const lines = [
          t('render.opened', {
            url: value.url,
            title: value.title || t('render.loading'),
            tabId: value.tabId ?? '?',
            session: value.session,
          }),
        ]
        if (value.meta) lines.push(formatMeta(value.meta))
        return [textBlock(lines.join('\n'))]
      },
    }),
  )

  // ---------------------------------------------------------------- read
  tools.push(
    defineTool({
      name: 'kimi_browser_read',
      description:
        'Read the current page through the Kimi extension. mode=read returns the accessibility tree as text with [ref=eNNN] markers ' +
        '(pass those refs to click/fill) plus a page-state line (url, load state, scroll, focused element, element counts); ' +
        'mode=find searches the full tree for a query; mode=frame reads an embedded document; mode=diff returns only what changed ' +
        'since the previous read, which is much cheaper after an action. Set include_screenshot=true to get the image in the same call. ' +
        'Always read before acting, and re-read after a state change instead of reusing stale refs.',
      parameters: objectSchema({
        mode: {
          schema: {
            type: 'string',
            enum: ['read', 'find', 'frame', 'diff'],
            description:
              'read = full accessibility tree (default); find = search by keyword; frame = read an iframe/embedded document; diff = only changes since the previous read',
          },
        },
        query: stringField('Search term for mode=find.'),
        frame: stringField('Frame handle for mode=frame, from the frames list of a previous snapshot (e.g. #f1).'),
        ref: stringField('Read only the subtree of one ref (e.g. @e12).'),
        max_chars: intField(`Maximum characters to return. Default ${config.browserReadMaxChars}.`, { minimum: 1, maximum: 60_000 }),
        cursor: stringField('next_cursor from the previous result, to continue reading the same observation.'),
        include_meta: boolField(
          `Attach the page-state line (url, load state, scroll, focus, element counts). Default ${config.browserReadIncludeMeta}.`,
        ),
        include_screenshot: boolField('Also capture a screenshot and attach it to the conversation (default false).', { default: false }),
        session: stringField('Session name; defaults to a name derived from the agent.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const maxChars = args.max_chars ?? config.browserReadMaxChars
        const mode = args.mode ?? 'read'
        const wantMeta = args.include_meta ?? config.browserReadIncludeMeta
        const state = sessionState(session)

        // 需要截图时，snapshot / meta / screenshot 并行发，墙钟时间只付最慢那一个
        const shotPromise = args.include_screenshot
          ? call(config, 'screenshot', { format: 'png' }, { session, signal: exec.signal }).catch(() => null)
          : Promise.resolve(null)

        if (mode === 'find') {
          if (!String(args.query ?? '').trim()) throw argsError(t('err.findNeedsQuery'))
          const data = await call(config, 'find', { query: String(args.query) }, { session, signal: exec.signal })
          return { mode, query: String(args.query), ...data, text: JSON.stringify(data?.matches ?? data, null, 1) }
        }
        if (mode === 'frame') {
          if (!String(args.frame ?? '').trim()) throw argsError(t('err.frameNeedsHandle'))
          const data = await call(config, 'read_page', { frame: String(args.frame) }, { session, signal: exec.signal })
          const cut = truncate(String(data?.text ?? ''), maxChars)
          return { mode, frame: String(args.frame), url: data?.url ?? '', title: data?.title ?? '', text: cut.text, truncated: cut.truncated }
        }

        const wantFullSnapshot = mode === 'diff' || !args.ref
        const snapshotPromise = wantFullSnapshot
          ? call(
              config,
              'snapshot',
              { format: 'aria', max_chars: maxChars, ...(args.cursor ? { cursor: String(args.cursor) } : {}) },
              { session, signal: exec.signal },
            )
          : call(config, 'snapshot', { ref: normalizeSelector(args.ref) }, { session, signal: exec.signal })

        const [data, metaProbe, shot] = await Promise.all([
          snapshotPromise,
          wantMeta ? tryReadMeta(config, session, { signal: exec.signal }) : Promise.resolve({ ok: false, meta: null }),
          shotPromise,
        ])

        const metaText = wantMeta ? formatMeta(metaProbe.meta) : ''
        const shotValue = shot ? await attachScreenshotFile(ctx, exec, shot, 'browser-screenshot') : null

        // mode=diff：与上一次读取比，只回变化的行
        if (mode === 'diff') {
          const current = formatSnapshot(data, maxChars)
          const diff = diffLines(state.snapshot, current)
          state.snapshot = current
          const body = diff.changed
            ? [
                t('diff.header'),
                ...diff.removed.map((line) => `- ${line}`),
                ...diff.added.map((line) => `+ ${line}`),
                diff.truncated ? t('diff.truncated', { total: diff.added.length + diff.removed.length }) : '',
              ]
                .filter(Boolean)
                .join('\n')
            : t('diff.none')
          return {
            mode,
            url: data?.url ?? '',
            title: data?.title ?? '',
            text: [metaText, body].filter(Boolean).join('\n'),
            changed: diff.changed,
            added: diff.added.length,
            removed: diff.removed.length,
            imageBlock: shotValue?.block ?? null,
            shotNote: shotValue && !shotValue.block ? shotValue.reason ?? '' : '',
          }
        }

        const text = args.ref ? formatSnapshot(data, maxChars) : formatSnapshot(data, maxChars)
        state.snapshot = text
        return {
          mode: args.ref ? 'ref' : 'read',
          ref: args.ref ? normalizeSelector(args.ref) : '',
          url: data?.url ?? '',
          title: data?.title ?? '',
          text: [metaText, text].filter(Boolean).join('\n'),
          truncated: data?.truncated === true,
          next_cursor: data?.next_cursor ?? null,
          note: data?.note ?? '',
          meta: metaProbe.meta,
          imageBlock: shotValue?.block ?? null,
          shotNote: shotValue && !shotValue.block ? shotValue.reason ?? '' : '',
        }
      },
      render(value) {
        const lines = [`[${value.mode}] ${value.title || ''} ${value.url || ''}`.trim()]
        lines.push(value.text || '')
        if (value.next_cursor) lines.push(`next_cursor: ${value.next_cursor}`)
        if (value.shotNote) lines.push(t('render.notAttachedLine', { note: value.shotNote }))
        const blocks = [textBlock(lines.filter(Boolean).join('\n'))]
        if (value.imageBlock) blocks.push(value.imageBlock)
        return blocks
      },
    }),
  )

  // ---------------------------------------------------------------- click
  tools.push(
    defineTool({
      name: 'kimi_browser_click',
      description:
        'Click an element in the current page. Pass the ref from kimi_browser_read (e.g. @e12) or a CSS selector. ' +
        'After clicking it checks whether the page actually changed and reports changed/unchanged — "unchanged" usually means the ' +
        'click did not take effect (wrong element, overlay, or a site that requires trusted input: tell the user instead of retrying in a loop). ' +
        'If the ref went stale it re-reads the page and retries once, attaching a fresh snapshot when it still fails.',
      parameters: objectSchema({
        selector: { ...stringField('CSS selector or aria ref (@e12 / e12 / [ref=e12] are all accepted)'), required: true },
        verify: boolField('Check afterwards whether the page changed (default: the browserVerify config).'),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const selector = normalizeSelector(args.selector)
        const verifyMs = resolveVerifyMs(config, args.verify)
        const verified = await runVerified({
          config,
          session,
          exec,
          verifyMs,
          run: () => call(config, 'click', { selector }, { session, signal: exec.signal }),
        })
        return {
          clicked: true,
          selector,
          ...verified.data,
          changed: verified.changed,
          changeDetail: verified.changeDetail,
          verified: verified.checked,
          retried: verified.retried,
          verifyMs,
          dialogOpen: Boolean(verified.dialogBlocked),
          dialogMessage: verified.dialogBlocked ?? '',
          before: verified.before,
          after: verified.after,
        }
      },
      render(value) {
        const lines = [
          t('render.clicked', {
            selector: value.selector,
            tag: value.tag ? t('render.clickedTag', { tag: value.tag }) : '',
            text: value.text ? t('render.clickedText', { text: String(value.text).trim().slice(0, 200) }) : '',
          }),
        ]
        if (value.retried) lines.push(t('verify.staleRetried', { detail: '' }).trim())
        if (value.dialogOpen) lines.push(t('verify.dialogBlocked', { message: value.dialogMessage }))
        if (value.verified && value.changed) lines.push(t('verify.changed', { detail: value.changeDetail }))
        else if (value.verified && value.changed === false) lines.push(t('verify.unchanged', { ms: value.verifyMs }))
        return [textBlock(lines.filter(Boolean).join('\n'))]
      },
    }),
  )

  // ---------------------------------------------------------------- fill
  tools.push(
    defineTool({
      name: 'kimi_browser_fill',
      description:
        'Replace the value of an input/textarea/contenteditable with text (clear-and-insert). Set submit=true to press Enter afterwards. ' +
        'Works on rich editors (ProseMirror/Lexical/Slate). UTF-8 safe. With submit=true the tool reports whether the page actually ' +
        'changed: submit=true only presses Enter, and a suggestion dropdown on a search page can swallow it, so "unchanged" means ' +
        'you should click the real submit button instead of filling again.',
      parameters: objectSchema({
        selector: { ...stringField('CSS selector or aria ref'), required: true },
        value: { ...stringField('Text to fill in; replaces the current value.'), required: true },
        submit: boolField('Press Enter after filling (default false).', { default: false }),
        verify: boolField('Check afterwards whether the page changed (default: the browserVerify config).'),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const selector = normalizeSelector(args.selector)
        const submitted = args.submit === true
        const verifyMs = resolveVerifyMs(config, submitted ? args.verify : false)
        const verified = await runVerified({
          config,
          session,
          exec,
          verifyMs,
          run: async () => {
            const filled = await call(config, 'fill', { selector, value: String(args.value) }, { session, signal: exec.signal })
            if (submitted) await call(config, 'send_keys', { keys: 'Enter' }, { session, signal: exec.signal })
            return filled
          },
        })
        return {
          filled: true,
          selector,
          mode: verified.data?.mode ?? 'value',
          submitted,
          length: String(args.value).length,
          changed: verified.changed,
          changeDetail: verified.changeDetail,
          verified: verified.checked,
          retried: verified.retried,
          verifyMs,
          dialogOpen: Boolean(verified.dialogBlocked),
          dialogMessage: verified.dialogBlocked ?? '',
        }
      },
      render(value) {
        const lines = [
          t('render.filled', {
            selector: value.selector,
            length: value.length,
            mode: value.mode === 'contenteditable' ? t('render.richEditor') : '',
            submitted: value.submitted ? t('render.submitted') : '',
          }),
        ]
        if (value.submitted && value.verified) {
          if (value.changed) lines.push(t('verify.changed', { detail: value.changeDetail }))
          else lines.push(t('verify.unchanged', { ms: value.verifyMs }))
        } else if (value.submitted) {
          lines.push(t('render.dispatchOnly'))
        }
        return [textBlock(lines.filter(Boolean).join('\n'))]
      },
    }),
  )

  // ---------------------------------------------------------------- act
  /** verb → daemon action + 必填参数 + 参数构造。集中在一处，错误信息才能点名到 verb。 */
  const ACT_VERBS = {
    press: { action: 'send_keys', needs: 'keys', build: (a) => ({ keys: String(a.keys) }) },
    type: {
      action: 'key_type',
      needs: 'value',
      build: (a) => ({ text: String(a.value ?? a.text ?? ''), ...(a.selector ? { selector: normalizeSelector(a.selector) } : {}) }),
    },
    clear: { action: 'fill', needs: 'selector', build: (a) => ({ selector: normalizeSelector(a.selector), value: '' }) },
    select: {
      action: 'select_option',
      needs: 'selector',
      build: (a) => ({
        selector: normalizeSelector(a.selector),
        ...(a.value !== undefined ? { value: String(a.value) } : {}),
        ...(a.label ? { label: String(a.label) } : {}),
      }),
    },
    check: { action: 'set_checked', needs: 'selector', build: (a) => ({ selector: normalizeSelector(a.selector), checked: true }) },
    uncheck: { action: 'set_checked', needs: 'selector', build: (a) => ({ selector: normalizeSelector(a.selector), checked: false }) },
    hover: { action: 'hover', needs: 'selector', build: (a) => ({ selector: normalizeSelector(a.selector) }) },
    scroll: {
      action: 'scroll',
      needs: null,
      build: (a) => ({
        ...(a.selector ? { selector: normalizeSelector(a.selector) } : {}),
        ...(a.dy !== undefined ? { dy: Number(a.dy) } : {}),
        ...(a.dx !== undefined ? { dx: Number(a.dx) } : {}),
      }),
    },
    drag: {
      action: 'drag',
      needs: 'selector',
      build: (a) => ({ from: normalizeSelector(a.selector), to: normalizeSelector(a.to) }),
    },
    mouse_click: { action: 'mouse_click', needs: 'selector', build: (a) => ({ selector: normalizeSelector(a.selector) }) },
    upload: {
      action: 'upload',
      needs: 'files',
      build: (a) => ({
        selector: normalizeSelector(a.selector),
        ...(Array.isArray(a.files) ? { files: a.files.map(String) } : {}),
        ...(Array.isArray(a.attachments) ? { attachments: a.attachments.map(String) } : {}),
      }),
    },
  }

  tools.push(
    defineTool({
      name: 'kimi_browser_act',
      description:
        'Do one non-click interaction on the page and report whether it took effect: press (key chords), type (character by character), ' +
        'clear, select (dropdown option), check/uncheck (checkbox or switch), hover, scroll, drag, mouse_click (real CDP mouse events, needs a layout box), ' +
        'upload (file paths). Use kimi_browser_click for ordinary clicks and kimi_browser_fill for text inputs. ' +
        'Unlike raw dispatch, this verifies the page afterwards and says changed/unchanged, and it can wait for a condition with wait_for.',
      parameters: objectSchema({
        verb: {
          schema: { type: 'string', enum: Object.keys(ACT_VERBS), description: 'Which interaction to perform' },
          required: true,
        },
        selector: stringField('Target element: CSS selector or aria ref (@e12). Required for most verbs.'),
        value: stringField('Text for type, or the option value for select.'),
        keys: stringField('Key chord(s) for press, e.g. "Enter", "Mod+A", "Shift+Tab", "Enter Escape".'),
        label: stringField('Select by visible option label instead of value.'),
        to: stringField('Drag target (CSS selector or ref) for verb=drag.'),
        dy: { schema: { type: 'number', description: 'Vertical scroll amount for verb=scroll (positive scrolls down)' } },
        dx: { schema: { type: 'number', description: 'Horizontal scroll amount for verb=scroll' } },
        files: { schema: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths for verb=upload' } },
        attachments: { schema: { type: 'array', items: { type: 'string' }, description: 'Attachment ids for verb=upload (alternative to files)' } },
        wait_for: stringField('After the action, wait until this text appears (up to wait_ms) before returning.'),
        wait_ms: intField('Timeout for wait_for in milliseconds (default 4000).', { minimum: 100, maximum: 60_000 }),
        verify: boolField('Check afterwards whether the page changed (default: the browserVerify config).'),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const verb = String(args.verb ?? '').trim()
        const spec = ACT_VERBS[verb]
        if (!spec) throw argsError(t('err.actUnknownVerb', { verb, available: Object.keys(ACT_VERBS).join(', ') }))
        if (spec.needs === 'selector' && !args.selector) throw argsError(t('err.actNeedsSelector', { verb }))
        if (spec.needs === 'keys' && !args.keys) throw argsError(t('err.actNeedsKeys', { verb }))
        if (spec.needs === 'value' && !String(args.value ?? args.text ?? '')) throw argsError(t('err.actNeedsValue', { verb }))
        if (spec.needs === 'files' && !args.files?.length && !args.attachments?.length) throw argsError(t('err.actNeedsFiles', { verb }))
        if (verb === 'drag' && !args.to) throw argsError(t('err.actNeedsSelector', { verb }))

        const request = spec.build(args)
        const verifyMs = resolveVerifyMs(config, args.verify)
        const verified = await runVerified({
          config,
          session,
          exec,
          verifyMs,
          run: () => call(config, spec.action, request, { session, signal: exec.signal }),
        })

        // 可选：动作后等一个条件（例如等异步渲染完成）
        let waited = null
        if (args.wait_for) {
          try {
            const fast = await waitForPageText(config, session, {
              text: String(args.wait_for),
              timeoutMs: Number(args.wait_ms ?? 4_000),
              signal: exec.signal,
            })
            waited = { ok: fast.ok, text: String(args.wait_for), ms: fast.elapsedMs }
          } catch (error) {
            waited = { ok: false, text: String(args.wait_for), error: String(error?.message ?? error).slice(0, 200) }
          }
        }

        return {
          verb,
          action: spec.action,
          changed: verified.changed,
          changeDetail: verified.changeDetail,
          verified: verified.checked,
          retried: verified.retried,
          verifyMs,
          dialogOpen: Boolean(verified.dialogBlocked),
          dialogMessage: verified.dialogBlocked ?? '',
          waited,
          data: verified.data,
          summary: summariseStep(spec.action, verified.data),
        }
      },
      render(value) {
        const lines = [t('act.done', { verb: value.verb, detail: value.summary || '' })]
        if (value.retried) lines.push(t('verify.staleRetried', { detail: '' }).trim())
        if (value.dialogOpen) lines.push(t('verify.dialogBlocked', { message: value.dialogMessage }))
        if (value.verified && value.changed) lines.push(t('verify.changed', { detail: value.changeDetail }))
        else if (value.verified && value.changed === false) lines.push(t('verify.unchanged', { ms: value.verifyMs }))
        if (value.waited) {
          lines.push(
            value.waited.ok
              ? t('wait.matchedText', { text: value.waited.text })
              : t('wait.timeout', { ms: value.waited.ms ?? '?', detail: value.waited.error ?? value.waited.text }),
          )
        }
        return [textBlock(lines.filter(Boolean).join('\n'))]
      },
    }),
  )

  // ---------------------------------------------------------------- wait
  tools.push(
    defineTool({
      name: 'kimi_browser_wait',
      description:
        'Wait for a condition instead of re-reading the page in a loop: text appears, text disappears, a selector appears, the URL matches, ' +
        'the document reaches a readyState, or simply a fixed delay. Returns ok plus what matched; on timeout it reports what the page looks ' +
        'like now, so you can decide the next step without another read.',
      parameters: objectSchema({
        text: stringField('Wait until this text appears in the page.'),
        text_gone: stringField('Wait until this text is no longer present.'),
        selector: stringField('Wait until this CSS selector matches and is visible.'),
        url: stringField('Wait until the URL contains this substring (or matches it as a RegExp).'),
        ready: { schema: { type: 'string', enum: ['interactive', 'complete'], description: 'Wait until document.readyState reaches this state' } },
        ms: intField('Just wait this many milliseconds (100-60000).', { minimum: 100, maximum: 60_000 }),
        timeout_ms: intField('Overall timeout (default 8000, max 120000).', { minimum: 100, maximum: 120_000 }),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      timeoutMs: Math.max(config.webbridgeTimeoutMs, 130_000),
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const timeoutMs = args.timeout_ms ?? 8_000
        const started = Date.now()

        if (!args.text && !args.text_gone && !args.selector && !args.url && !args.ready && !args.ms) {
          throw argsError(t('err.waitNeedsCondition'))
        }

        // 纯延时
        if (!args.text && !args.text_gone && !args.selector && !args.url && !args.ready && args.ms) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(Number(args.ms), timeoutMs)))
          return { ok: true, kind: 'delay', waitedMs: Date.now() - started, detail: `${args.ms}ms` }
        }

        // 页面条件：文本类用页面内精确等待（一次往返，页面侧 100ms 轮询）；
        // selector 交给 daemon（它还会判断可见性）
        if (args.text || args.text_gone) {
          const needle = args.text ? String(args.text) : String(args.text_gone)
          let pageWait
          try {
            pageWait = await waitForPageText(config, session, {
              text: needle,
              gone: Boolean(args.text_gone),
              timeoutMs,
              signal: exec.signal,
            })
          } catch (error) {
            const meta = (await tryReadMeta(config, session, { signal: exec.signal })).meta
            return {
              ok: false,
              kind: args.text ? 'text' : 'text_gone',
              waitedMs: Date.now() - started,
              detail: String(error?.message ?? error).slice(0, 300),
              meta,
            }
          }
          return {
            ok: pageWait.ok,
            kind: args.text ? 'text' : 'text_gone',
            waitedMs: pageWait.elapsedMs,
            detail: pageWait.ok
              ? args.text
                ? t('wait.matchedText', { text: needle })
                : t('wait.goneText', { text: needle })
              : needle,
            meta: (await tryReadMeta(config, session, { signal: exec.signal })).meta,
          }
        }

        if (args.selector) {
          let data
          try {
            data = await call(
              config,
              'wait',
              { selector: normalizeSelector(args.selector), timeout_ms: Math.min(timeoutMs, 120_000) },
              { session, signal: exec.signal, timeoutMs: Math.min(timeoutMs, 120_000) + 5_000 },
            )
          } catch (error) {
            const meta = (await tryReadMeta(config, session, { signal: exec.signal })).meta
            return {
              ok: false,
              kind: 'selector',
              waitedMs: Date.now() - started,
              detail: String(error?.message ?? error).slice(0, 300),
              meta,
            }
          }
          const ok = data?.ok !== false
          return {
            ok,
            kind: 'selector',
            waitedMs: data?.waitedMs ?? Date.now() - started,
            detail: ok ? t('wait.matchedSelector', { selector: args.selector }) : String(args.selector),
            meta: (await tryReadMeta(config, session, { signal: exec.signal })).meta,
          }
        }

        // readyState / url：轮询 meta
        const deadline = started + timeoutMs
        for (;;) {
          const probe = await tryReadMeta(config, session, { signal: exec.signal })
          if (probe.ok) {
            const meta = probe.meta
            const readyOk = args.ready ? meta.ready === args.ready || (args.ready === 'interactive' && meta.ready === 'complete') : true
            const urlOk = args.url ? urlMatches(meta.url, String(args.url)) : true
            if (readyOk && urlOk) {
              return {
                ok: true,
                kind: args.ready ? 'ready' : 'url',
                waitedMs: Date.now() - started,
                detail: args.ready ? t('wait.readyMatched', { ready: meta.ready }) : t('wait.urlMatched', { url: meta.url }),
                meta,
              }
            }
          }
          if (Date.now() >= deadline) {
            return {
              ok: false,
              kind: args.ready ? 'ready' : 'url',
              waitedMs: Date.now() - started,
              detail: args.ready ? String(args.ready) : String(args.url),
              meta: probe.meta ?? null,
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 120))
        }
      },
      render(value) {
        const lines = [
          value.ok
            ? t('wait.done', { ms: Math.round(value.waitedMs ?? 0), detail: value.detail ?? '' })
            : t('wait.timeout', { ms: Math.round(value.waitedMs ?? 0), detail: value.detail ?? '' }),
        ]
        if (value.meta) lines.push(formatMeta(value.meta))
        return [textBlock(lines.filter(Boolean).join('\n'))]
      },
    }),
  )

  // ---------------------------------------------------------------- eval
  tools.push(
    defineTool({
      name: 'kimi_browser_eval',
      description:
        'Evaluate JavaScript in the page and return the result as JSON. Use it to read data the accessibility tree only summarises ' +
        '(counts, attributes, table contents, links) or to build one compact object instead of many reads. The realm is shared, so wrap ' +
        'repeated const declarations in an IIFE. Results are size-capped; return a small object rather than a whole DOM subtree.',
      parameters: objectSchema({
        code: { ...stringField('JavaScript expression or IIFE to evaluate, e.g. "(() => ({ n: document.links.length }))()"'), required: true },
        max_chars: intField('Maximum characters of the JSON result to return (default 4000).', { minimum: 100, maximum: 60_000 }),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const code = String(args.code ?? '').trim()
        if (!code) throw argsError(t('err.evalNeedsCode'))
        const maxChars = args.max_chars ?? 4_000
        let data
        try {
          data = await call(config, 'evaluate', { code }, { session, signal: exec.signal })
        } catch (error) {
          throw new KimiError(error?.code ?? 'KIMI_WEBRIDGE_TOOL', t('eval.failed', { detail: String(error?.message ?? error).slice(0, 400) }), {
            cause: error,
          })
        }
        const value = data?.value !== undefined ? data.value : data
        const json = typeof value === 'string' ? value : JSON.stringify(value)
        const cut = truncate(String(json ?? ''), maxChars)
        return { ok: true, type: data?.type ?? typeof value, json: cut.text, truncated: cut.truncated, maxChars }
      },
      render(value) {
        const lines = [t('eval.result', { value: value.json || 'undefined' })]
        if (value.truncated) lines.push(t('eval.truncated', { chars: value.maxChars }))
        return [textBlock(lines.join('\n'))]
      },
    }),
  )

  // ---------------------------------------------------------------- dialog
  tools.push(
    defineTool({
      name: 'kimi_browser_dialog',
      description:
        'Handle a native JavaScript dialog (alert / confirm / prompt). While such a dialog is open the page is blocked and every other ' +
        'command fails or hangs, so check status and then accept or dismiss. Call this when a click reports that a dialog is open.',
      parameters: objectSchema({
        action: { schema: { type: 'string', enum: ['status', 'accept', 'dismiss'], description: 'status = is one open; accept / dismiss = answer it' }, required: true },
        text: stringField('Response text for a prompt() dialog (accept only).'),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const action = String(args.action ?? '').trim()
        if (!['status', 'accept', 'dismiss'].includes(action)) throw argsError(t('err.dialogNeedsAction'))
        const request = { action }
        if (action === 'accept' && args.text) request.text = String(args.text)
        const data = await call(config, 'dialog', request, { session, signal: exec.signal })
        return { action, data, open: data?.open !== false, type: data?.type ?? '', message: data?.message ?? '' }
      },
      render(value) {
        if (value.action === 'status') {
          return [textBlock(value.open ? t('dialog.open', { type: value.type || '?', message: value.message || '?' }) : t('dialog.none'))]
        }
        return [textBlock(t('dialog.handled', { action: value.action, detail: value.open ? t('dialog.open', { type: value.type || '?', message: value.message || '?' }) : t('dialog.none') }))]
      },
    }),
  )

  // ---------------------------------------------------------------- screenshot
  tools.push(
    defineTool({
      name: 'kimi_browser_screenshot',
      description:
        'Capture the current page (or one element) as a PNG/JPEG image and attach it to the conversation. ' +
        'The image is only attached when the current model route accepts image input; otherwise the local file path is returned.',
      parameters: objectSchema({
        selector: stringField('Capture only one element (CSS or ref); omit for the visible viewport.'),
        full_page: boolField('Capture the full page (default false).', { default: false }),
        format: { schema: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format; default png.' } },
        quality: intField('JPEG quality 0-100 (jpeg only).', { minimum: 0, maximum: 100 }),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const request = { format: args.format ?? 'png' }
        if (args.selector) request.selector = normalizeSelector(args.selector)
        if (args.full_page) request.full_page = true
        if (args.quality !== undefined) request.quality = args.quality
        const data = await call(config, 'screenshot', request, { session, signal: exec.signal })
        const attached = await attachScreenshotFile(ctx, exec, data, 'browser-screenshot')
        return {
          path: data?.path ?? '',
          format: data?.format ?? request.format,
          sizeBytes: data?.sizeBytes ?? null,
          attached: attached.block !== null,
          note: attached.block ? '' : attached.reason ?? '',
          imageBlock: attached.block,
        }
      },
      render(value) {
        const lines = [t('render.screenshotSaved', { path: value.path || t('render.noPath'), bytes: value.sizeBytes ?? '?' })]
        if (!value.attached) lines.push(t('render.notAttachedLine', { note: value.note }))
        const blocks = [textBlock(lines.join('\n'))]
        if (value.imageBlock) blocks.push(value.imageBlock)
        return blocks
      },
    }),
  )

  // ---------------------------------------------------------------- tabs
  tools.push(
    defineTool({
      name: 'kimi_browser_tabs',
      description:
        'Inspect or manage browser tabs for this session. action=list = tabs opened by this task; list_all = every tab the extension can see ' +
        '(use it to attach to a page the user already has open); attach = make an existing tab current by tabId; close = close the current tab; ' +
        'close_session = close every tab this task opened (only when the user asks).',
      parameters: objectSchema({
        action: { schema: { type: 'string', enum: ['list', 'list_all', 'attach', 'close', 'close_session'], description: 'list / list_all / attach / close / close_session' }, required: true },
        tab_id: intField('tabId for attach, from list_all.'),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        if (args.action === 'list') {
          const data = await call(config, 'list_tabs', {}, { session, signal: exec.signal })
          return { action: 'list', tabs: data?.tabs ?? [] }
        }
        if (args.action === 'list_all') {
          const data = await call(config, 'list_browser_tabs', {}, { session, signal: exec.signal })
          return { action: 'list_all', tabs: data?.tabs ?? [] }
        }
        if (args.action === 'attach') {
          if (!Number.isInteger(args.tab_id)) throw argsError(t('err.attachNeedsTabId'))
          const data = await call(config, 'attach_tab', { tabId: args.tab_id }, { session, signal: exec.signal })
          return { action: 'attach', ...data }
        }
        if (args.action === 'close') {
          const data = await call(config, 'close_tab', {}, { session, signal: exec.signal })
          return { action: 'close', ...data }
        }
        const data = await call(config, 'close_session', {}, { session, signal: exec.signal })
        return { action: 'close_session', closed: data?.closed ?? 0 }
      },
      render(value) {
        if (Array.isArray(value.tabs)) {
          if (value.tabs.length === 0) return [textBlock(t('render.noTabs'))]
          const lines = value.tabs.map(
            (tab) => `- tabId=${tab.tabId}${tab.active ? ' [active]' : ''} ${tab.title || ''} — ${tab.url}`,
          )
          return [
            textBlock(
              t('render.tabList', {
                scope: value.action === 'list_all' ? t('render.tabsAll') : t('render.tabsSession'),
                lines: lines.join('\n'),
              }),
            ),
          ]
        }
        return [textBlock(`${value.action}：${JSON.stringify(value).slice(0, 400)}`)]
      },
    }),
  )

  // ---------------------------------------------------------------- script（批量 + 逃生口）
  /** 这些 action 的返回里文本才是重点，默认带上（受预算限制）。 */
  const TEXT_ACTIONS = new Set(['snapshot', 'read_page', 'find'])

  /** 单步摘要：默认不返回大段 JSON，省 token。 */
  function summariseStep(action, data) {
    if (data === undefined || data === null) return t('render.noResult')
    if (typeof data !== 'object') return String(data).slice(0, 200)
    switch (action) {
      case 'navigate':
        return `→ ${data.url ?? ''}${data.tabId ? `  (tab ${data.tabId})` : ''}`
      case 'find_tab':
      case 'attach_tab':
      case 'activate_tab':
        return `tab ${data.tabId ?? '?'}  ${data.url ?? ''}`.trim()
      case 'find':
        return t('act.found', {
          count: data.totalMatches ?? 0,
          names: (data.matches ?? []).slice(0, 3).map((m) => m.name ?? m.role ?? '?').join(' / ') || t('render.noMatches'),
        })
      case 'click':
        return t('act.clicked', { tag: data.tag ?? '', text: String(data.text ?? '').trim().slice(0, 100) }).trim()
      case 'mouse_click':
        return t('act.realClick', { result: data.success ? t('render.dispatched') : t('render.ineffective') })
      case 'fill':
        return t('act.filled', { mode: data.mode ?? 'value' })
      case 'evaluate':
        return `= ${JSON.stringify(data.value ?? data).slice(0, 300)}`
      case 'screenshot':
        return t('act.screenshot', { path: data.path ?? '' })
      case 'save_as_pdf':
        return `PDF ${data.path ?? ''}`
      case 'close_session':
        return t('act.closedSession', { count: data.closed ?? 0 })
      case 'close_tab':
        return t('act.closedTab', { result: data.closed ? t('render.closed') : t('render.none') })
      case 'scroll':
        return t('act.scrolled', { y: data.scrollY ?? '?' })
      case 'wait':
        return data.ok === false
          ? t('act.waitTimeout', { ms: data.waitedMs ?? '?' })
          : t('act.waited', { ms: data.waitedMs ?? 0 })
      case 'network':
        return t('act.network', { value: data.count !== undefined ? String(data.count) : (data.message ?? t('render.done')) })
      case 'dialog':
        return data.open === false ? t('act.noDialog') : t('act.dialog', { value: JSON.stringify(data).slice(0, 160) })
      default:
        return JSON.stringify(data).slice(0, 240)
    }
  }

  /** 进入执行前先做纯校验：动作名、navigate 的 url。写错就报 KIMI_ARGS，不当成「第 N 步失败」。 */
  function preflightSteps(steps) {
    steps.forEach((step, index) => {
      const action = String(step?.action ?? '').trim()
      const raw = step?.args && typeof step.args === 'object' ? step.args : {}
      const where = index + 1
      if (action !== 'read' && !BROWSER_ACTIONS.includes(action)) {
        throw argsError(
          t('script.unknownAction', {
            index: where,
            action,
            available: BROWSER_ACTIONS.join(', '),
            extra: t('script.plusRead'),
          }),
        )
      }
      if (action === 'navigate' && !raw.url) throw argsError(t('script.navigateNeedsUrl', { index: where }))
    })
  }

  /**
   * 执行一步；返回 { action, data, text? }。
   */
  async function runStep(session, index, step, exec) {
    const action = String(step?.action ?? '').trim()
    const raw = step?.args && typeof step.args === 'object' ? { ...step.args } : {}

    // 便捷动作：read = snapshot(aria) + 格式化，省得自己拼 format/max_chars
    if (action === 'read') {
      const maxChars = Number.isInteger(raw.max_chars) ? raw.max_chars : 4000
      const request = { format: 'aria', max_chars: maxChars }
      if (raw.cursor) request.cursor = String(raw.cursor)
      const data = await call(config, 'snapshot', request, { session, signal: exec.signal })
      return { action, data, text: formatSnapshot(data, maxChars) }
    }
    if (!BROWSER_ACTIONS.includes(action)) {
      throw argsError(
        t('script.unknownAction', {
          index: index + 1,
          action,
          available: BROWSER_ACTIONS.join(', '),
          extra: t('script.plusRead'),
        }),
      )
    }
    if (action === 'navigate') {
      if (!raw.url) throw argsError(t('script.navigateNeedsUrl', { index: index + 1 }))
      raw.url = assertHttpUrl(raw.url)
      if (raw.group_title === undefined) raw.group_title = config.browserGroupTitle
    }
    if (raw.selector !== undefined) raw.selector = normalizeSelector(raw.selector)
    const data = await call(config, action, raw, { session, signal: exec.signal })
    const text = TEXT_ACTIONS.has(action) ? formatSnapshot(data, raw.max_chars ?? 3000) : undefined
    return { action, data, text }
  }

  tools.push(
    defineTool({
      name: 'kimi_browser_script',
      description:
        'Run 1–25 browser actions in ONE call instead of one model round per action. Accepts either a single {action, args} or a {steps:[...]} array. ' +
        `Actions: ${BROWSER_ACTIONS.join(', ')}, plus shortcut "read" (= aria snapshot formatted). ` +
        'Prefer short scripts (2–6 steps) ending with "read". A failing step returns ok:false plus the steps that already ran, so you can resume from there.',
      parameters: objectSchema({
        action: stringField(`Single-step mode: a daemon action, one of ${BROWSER_ACTIONS.join(' / ')}`),
        args: objField('Raw argument object for single-step mode (see references/browser-actions.md).'),
        steps: {
          schema: {
            type: 'array',
            description: 'Batch mode: run [{action, args?, capture?}] in order, 1-25 steps. capture=true includes that step text (default is a summary only).',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['action'],
              properties: {
                action: { type: 'string', description: 'A daemon action name, or read' },
                args: { type: 'object', additionalProperties: true, properties: {} },
                capture: { type: 'boolean', description: 'Include this step full text in the result' },
              },
            },
          },
        },
        stop_on_error: boolField('Stop at the first failing step (default true); set false to keep going and record each step.'),
        max_result_chars: intField('Total text budget for the aggregated result (500-60000, default 6000).'),
        session: stringField('Session name; one script shares one tab group.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      timeoutMs: Math.max(config.webbridgeTimeoutMs, 120_000),
      async execute(args, exec) {
        const single = args.action !== undefined
        const steps = single ? [{ action: args.action, args: args.args ?? {} }] : args.steps
        if (!Array.isArray(steps) || steps.length === 0) {
          throw argsError(t('script.needActionOrSteps'))
        }
        if (steps.length > 25) throw argsError(t('script.tooManySteps', { max: 25 }))
        preflightSteps(steps)
        const session = makeSession(exec.agent, args)
        const stopOnError = args.stop_on_error !== false
        const maxChars = Number.isInteger(args.max_result_chars) ? args.max_result_chars : 6000
        let remaining = maxChars
        const startedAt = Date.now()
        const results = []
        let stoppedAt = null
        let ok = true

        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index] ?? {}
          const started = Date.now()
          try {
            const { action, data, text } = await runStep(session, index, step, exec)
            let includeText
            if (text !== undefined && remaining > 0) {
              const cap = Math.min(text.length, step.capture === true ? 4000 : 2000, remaining)
              includeText = text.slice(0, cap)
              remaining -= includeText.length
              if (cap < text.length) includeText += `\n…${t('script.stepTruncated', { length: text.length })}`
            }
            results.push({
              index,
              action,
              ok: true,
              ms: Date.now() - started,
              summary: summariseStep(action, data),
              ...(includeText !== undefined ? { text: includeText } : {}),
            })
          } catch (error) {
            ok = false
            results.push({
              index,
              action: String(step?.action ?? '?'),
              ok: false,
              ms: Date.now() - started,
              error: String(error?.message ?? error).slice(0, 500),
            })
            if (stopOnError) {
              stoppedAt = index
              break
            }
          }
        }

        const totalMs = Date.now() - startedAt
        const lines = results.map(
          (r) =>
            t('script.stepLine', {
              mark: r.ok ? '✓' : '✗',
              index: r.index + 1,
              action: r.action,
              ms: r.ms,
              detail: r.ok ? r.summary : r.error,
            }),
        )
        for (const r of results) {
          if (!r.text) continue
          lines.push('', t('script.stepContent', { index: r.index + 1, action: r.action }), r.text)
        }
        const failedIndex = stoppedAt ?? (ok ? -1 : results.length - 1)
        return {
          ok,
          totalMs,
          stepCount: steps.length,
          ranSteps: results.length,
          stoppedAt,
          session,
          steps: results,
          summary: `${ok ? t('script.allDone') : t('script.failedAt', { index: failedIndex + 1 })}${t('render.colon')}${t('script.progress', {
            ran: results.length,
            total: steps.length,
            ms: totalMs,
          })}\n${lines.join('\n')}`,
        }
      },
      render(value) {
        return [textBlock(value.summary)]
      },
    }),
  )

  return tools
}
