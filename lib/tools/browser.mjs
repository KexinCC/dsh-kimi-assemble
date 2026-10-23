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
import { argsError } from '../errors.mjs'
import { t } from '../i18n.mjs'

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

export function createBrowserTools({ config, ctx }) {
  const tools = []

  const makeSession = (agent, args) => sessionNameFor(agent, args?.session)

  // ---------------------------------------------------------------- open
  tools.push(
    defineTool({
      name: 'kimi_browser_open',
      description:
        "Open a URL in the user's real browser (their logged-in Chrome, through the Kimi extension). " +
        'Returns the final URL, title and tab id. Pages opened during one task are grouped into one tab group; ' +
        'close them with kimi_browser_tabs only when the user asks.',
      parameters: objectSchema({
        url: { ...stringField('URL to open; a bare domain gets https:// prepended'), required: true },
        new_tab: boolField('true = open in a new tab (default, keeps existing pages); false = navigate the current tab', { default: true }),
        group_title: stringField('Tab group title, visible in the user browser. Defaults to the plugin config browserGroupTitle.'),
        session: stringField('Session name shared by every action of one task; defaults to a name derived from the agent.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const url = assertHttpUrl(args.url)
        const session = makeSession(exec.agent, args)
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
        let title = ''
        try {
          const tabs = await call(config, 'list_tabs', {}, { session, signal: exec.signal, timeoutMs: 15_000 })
          title = String(tabs?.tabs?.find((tab) => tab.tabId === data?.tabId)?.title ?? '')
        } catch {
          /* 标题是装饰，拿不到不影响 */
        }
        return {
          url: String(data?.url ?? url),
          tabId: data?.tabId ?? null,
          title,
          session,
          hint: t('render.hintReadFirst'),
        }
      },
      render(value) {
        return [
          textBlock(
            t('render.opened', {
              url: value.url,
              title: value.title || t('render.loading'),
              tabId: value.tabId ?? '?',
              session: value.session,
            }),
          ),
        ]
      },
    }),
  )

  // ---------------------------------------------------------------- read
  tools.push(
    defineTool({
      name: 'kimi_browser_read',
      description:
        'Read the current page through the Kimi extension. mode=read returns the accessibility tree as text with [ref=eNNN] markers ' +
        '(pass those refs to click/fill), mode=find searches the full tree for a query, mode=frame reads an embedded document. ' +
        'Always read before acting, and re-read after a state change instead of reusing stale refs.',
      parameters: objectSchema({
        mode: {
          schema: {
            type: 'string',
            enum: ['read', 'find', 'frame'],
            description: 'read = full accessibility tree (default); find = search by keyword; frame = read an iframe/embedded document',
          },
        },
        query: stringField('Search term for mode=find.'),
        frame: stringField('Frame handle for mode=frame, from the frames list of a previous snapshot (e.g. #f1).'),
        ref: stringField('Read only the subtree of one ref (e.g. @e12).'),
        max_chars: intField(`Maximum characters to return. Default ${config.browserReadMaxChars}.`, { minimum: 1, maximum: 60_000 }),
        cursor: stringField('next_cursor from the previous result, to continue reading the same observation.'),
        session: stringField('Session name; defaults to a name derived from the agent.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const maxChars = args.max_chars ?? config.browserReadMaxChars
        const mode = args.mode ?? 'read'
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
        if (args.ref) {
          const data = await call(config, 'snapshot', { ref: normalizeSelector(args.ref) }, { session, signal: exec.signal })
          return { mode: 'ref', ref: normalizeSelector(args.ref), text: formatSnapshot(data, maxChars), url: data?.url ?? '', title: data?.title ?? '' }
        }
        const request = { format: 'aria', max_chars: maxChars }
        if (args.cursor) request.cursor = String(args.cursor)
        const data = await call(config, 'snapshot', request, { session, signal: exec.signal })
        return {
          mode: 'read',
          url: data?.url ?? '',
          title: data?.title ?? '',
          text: formatSnapshot(data, maxChars),
          truncated: data?.truncated === true,
          next_cursor: data?.next_cursor ?? null,
          note: data?.note ?? '',
        }
      },
      render(value) {
        const lines = [`[${value.mode}] ${value.title || ''} ${value.url || ''}`.trim()]
        lines.push(value.text || '')
        if (value.next_cursor) lines.push(`next_cursor: ${value.next_cursor}`)
        return [textBlock(lines.filter(Boolean).join('\n'))]
      },
    }),
  )

  // ---------------------------------------------------------------- click
  tools.push(
    defineTool({
      name: 'kimi_browser_click',
      description:
        'Click an element in the current page. Pass the ref from kimi_browser_read (e.g. @e12) or a CSS selector. ' +
        'Uses a DOM-level synthetic click; sites that require trusted input will not react — then tell the user instead of retrying in a loop.',
      parameters: objectSchema({
        selector: { ...stringField('CSS selector or aria ref (@e12 / e12 / [ref=e12] are all accepted)'), required: true },
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const data = await call(config, 'click', { selector: normalizeSelector(args.selector) }, { session, signal: exec.signal })
        return { clicked: true, selector: normalizeSelector(args.selector), ...data }
      },
      render(value) {
        return [
          textBlock(
            t('render.clicked', {
              selector: value.selector,
              tag: value.tag ? t('render.clickedTag', { tag: value.tag }) : '',
              text: value.text ? t('render.clickedText', { text: String(value.text).trim().slice(0, 200) }) : '',
            }),
          ),
        ]
      },
    }),
  )

  // ---------------------------------------------------------------- fill
  tools.push(
    defineTool({
      name: 'kimi_browser_fill',
      description:
        'Replace the value of an input/textarea/contenteditable with text (clear-and-insert). Set submit=true to press Enter afterwards. ' +
        'Works on rich editors (ProseMirror/Lexical/Slate). UTF-8 safe. submit=true only presses Enter: a suggestion dropdown can swallow it (search pages), so read back after submitting and click the real submit button if the page did not navigate.',
      parameters: objectSchema({
        selector: { ...stringField('CSS selector or aria ref'), required: true },
        value: { ...stringField('Text to fill in; replaces the current value.'), required: true },
        submit: boolField('Press Enter after filling (default false).', { default: false }),
        session: stringField('Session name.'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const session = makeSession(exec.agent, args)
        const selector = normalizeSelector(args.selector)
        const data = await call(config, 'fill', { selector, value: String(args.value) }, { session, signal: exec.signal })
        if (args.submit) {
          await call(config, 'send_keys', { keys: 'Enter' }, { session, signal: exec.signal })
        }
        return { filled: true, selector, mode: data?.mode ?? 'value', submitted: args.submit === true, length: String(args.value).length }
      },
      render(value) {
        const lines = [
          textBlock(
            t('render.filled', {
              selector: value.selector,
              length: value.length,
              mode: value.mode === 'contenteditable' ? t('render.richEditor') : '',
              submitted: value.submitted ? t('render.submitted') : '',
            }),
          ),
        ]
        if (value.submitted) lines.push(textBlock(t('render.dispatchOnly')))
        return lines
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
