/**
 * lib/tools/computer.mjs —— kimi_cu_* 工具（Windows 桌面）
 * ============================================================================
 * 全部走 lib/kimicu.mjs 的租约客户端。
 *
 * 防错是这里的重点，因为桌面输入是真的会点错东西：
 *   - window 参数支持 id / 精确标题 / 子串；0 或多命中都报错并列出候选，
 *     绝不默默取第一个。
 *   - click 必须二选一：element_index 或 x/y；两个都给、都不给都报错。
 *   - get_window_state 的 screenshot/text 不能同时 false。
 *   - scroll 的 scrollY>0 是**向下**（旧 MCP 的 dy 语义相反，最容易错）。
 *   - 动作参数先校验完再碰运行时 —— 参数错了不该去拉 Agent。
 *   - 输入类调用一律提示「已派发 ≠ 已生效，用 observe 复核」。
 * ============================================================================
 */
import { defineTool, objectSchema, stringField, boolField, intField, objField, arrayField, textBlock, truncate } from '../tool.mjs'
import { CU_METHODS, withLease, resolveWindow, validateCall } from '../kimicu.mjs'
import { attachDataUrl } from '../images.mjs'
import { argsError } from '../errors.mjs'
import { t } from '../i18n.mjs'

/** kimi_cu_act 支持的动作。 */
export const CU_ACTIONS = Object.freeze([
  'click',
  'type',
  'key',
  'scroll',
  'set_value',
  'drag',
  'drag_path',
  'secondary',
  'activate',
])

/** Agent 侧会话标识：每个 agent 一个稳定前缀，便于归因。 */
function sessionIdFor(agent) {
  const id = String(agent?.id ?? 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
  return `dsh/${id || 'default'}`
}

/** 把无障碍树按关键词过滤（保留原始行与 [index] 标签）。 */
function filterTree(tree, filter) {
  const text = String(tree ?? '')
  if (!filter) return { text, matched: null }
  const terms = String(filter)
    .split(/[|\s]+/)
    .map((term) => term.trim())
    .filter(Boolean)
  if (terms.length === 0) return { text, matched: null }
  const lines = text.split('\n')
  const matched = lines.filter((line) => terms.some((term) => line.toLowerCase().includes(term.toLowerCase())))
  return { text: matched.join('\n'), matched: matched.length, total: lines.length }
}

/**
 * 纯函数：把 kimi_cu_act 的参数编译成 Agent 请求。任何不合法都抛 KIMI_ARGS，
 * 不产生副作用，也不依赖运行时。
 * @param {Record<string, any>} args
 */
export function planAction(args) {
  const action = String(args.action ?? '')
  if (!CU_ACTIONS.includes(action)) {
    throw argsError(t('err.unknownAction', { action, available: CU_ACTIONS.join(', ') }))
  }

  if (action === 'click') {
    const hasIndex = args.element_index !== undefined
    const hasPoint = args.x !== undefined || args.y !== undefined
    if (hasIndex === hasPoint) {
      throw argsError(t('err.clickTarget'))
    }
    const request = {}
    if (hasIndex) request.element_index = args.element_index
    else {
      if (args.x === undefined || args.y === undefined) throw argsError(t('err.clickXY'))
      request.x = args.x
      request.y = args.y
    }
    if (args.button) request.mouse_button = args.button
    if (args.click_count) request.click_count = args.click_count
    return { action, request, target: hasIndex ? { element_index: args.element_index } : { x: args.x, y: args.y } }
  }

  if (action === 'type') {
    if (typeof args.text !== 'string' || args.text.length === 0) throw argsError(t('err.typeNeedsText'))
    return { action, text: args.text }
  }

  if (action === 'key') {
    const key = String(args.key ?? '').trim()
    if (!key) throw argsError(t('err.keyNeedsChord'))
    return { action, key }
  }

  if (action === 'scroll') {
    const hasPoint = args.x !== undefined || args.y !== undefined
    if (!hasPoint) throw argsError(t('err.scrollNeedsPoint'))
    if (args.x === undefined || args.y === undefined) throw argsError(t('err.clickXY'))
    const scrollX = args.scroll_x ?? 0
    const scrollY = args.scroll_y ?? 0
    if (scrollX === 0 && scrollY === 0) throw argsError(t('err.scrollNeedsDelta'))
    return { action, request: { x: args.x, y: args.y, scrollX, scrollY }, summary: { scrollX, scrollY } }
  }

  if (action === 'set_value') {
    if (args.element_index === undefined) throw argsError(t('err.setValueNeedsIndex'))
    if (typeof args.value !== 'string') throw argsError(t('err.setValueNeedsValue'))
    return { action, element_index: args.element_index, value: args.value }
  }

  if (action === 'drag') {
    for (const key of ['from_x', 'from_y', 'to_x', 'to_y']) {
      if (args[key] === undefined) throw argsError(t('err.dragMissingField', { field: key }))
    }
    return {
      action,
      request: { from_x: args.from_x, from_y: args.from_y, to_x: args.to_x, to_y: args.to_y },
      from: [args.from_x, args.from_y],
      to: [args.to_x, args.to_y],
    }
  }

  if (action === 'drag_path') {
    const points = args.points
    if (!Array.isArray(points) || points.length < 2) throw argsError(t('err.dragPathNeedsPoints'))
    if (points.length > 1024) throw argsError(t('err.tooManyPoints', { max: 1024 }))
    const normalized = []
    for (const point of points) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every((item) => Number.isInteger(item))) {
        throw argsError(t('err.pointShape'))
      }
      normalized.push([point[0], point[1]])
    }
    return { action, points: normalized }
  }

  if (action === 'secondary') {
    if (args.element_index === undefined) throw argsError(t('err.secondaryNeedsIndex'))
    if (!args.uia_action) {
      throw argsError(t('err.secondaryNeedsUia'))
    }
    return { action, element_index: args.element_index, uia: args.uia_action }
  }

  return { action: 'activate' }
}

export function createComputerTools({ config, ctx }) {
  const tools = []

  // ---------------------------------------------------------------- windows
  tools.push(
    defineTool({
      name: 'kimi_cu_windows',
      description:
        'List open Windows desktop windows that KimiCU can observe and control (app path, window id, title). ' +
        'Start here: pick the target window, then call kimi_cu_observe before any input.',
      parameters: objectSchema({
        filter: stringField('Keep only windows whose title or app path contains this keyword (case-insensitive).'),
        limit: intField('Maximum number of windows to return (1-500, default 50).'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const limit = args.limit ?? 50
        const filter = String(args.filter ?? '').toLowerCase()
        const windows = await withLease(config, sessionIdFor(exec.agent), async (call) => call('list_windows'), {
          signal: exec.signal,
        })
        const list = (Array.isArray(windows) ? windows : []).filter(
          (item) => !filter || `${item.title} ${item.app}`.toLowerCase().includes(filter),
        )
        return {
          total: list.length,
          windows: list.slice(0, limit).map((item) => ({ id: item.id, title: item.title, app: item.app })),
          truncated: list.length > limit,
        }
      },
      render(value) {
        if (value.total === 0) return [textBlock(t('cu.noWindows'))]
        const lines = value.windows.map((item) => `- id=${item.id}  "${item.title}"  ${item.app}`)
        if (value.truncated) lines.push(t('cu.windowsTruncated', { total: value.total }))
        return [textBlock(t('cu.windowsHeader', { lines: lines.join('\n') }))]
      },
    }),
  )

  // ---------------------------------------------------------------- observe
  tools.push(
    defineTool({
      name: 'kimi_cu_observe',
      description:
        'Observe one desktop window: accessibility tree text with [index] labels, focused element, and optionally a screenshot. ' +
        'This does not activate the window. Read it before choosing a target; re-observe after any state change instead of reusing old indexes.',
      parameters: objectSchema({
        window: {
          schema: {
            oneOf: [{ type: 'integer' }, { type: 'string' }],
            description: 'Window id from kimi_cu_windows, or a title (exact match first, then substring; zero or multiple matches fail and list candidates).',
          },
          required: true,
        },
        screenshot: boolField('Attach a screenshot (default true).', { default: true }),
        text: boolField('Attach the accessibility text (default true).', { default: true }),
        filter: stringField('Show only tree lines containing these keywords (space or | separated); original [index] values are preserved.'),
        max_chars: intField(`Maximum characters of accessibility text. Default ${config.cuMaxTreeChars} (200-60000).`),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const includeScreenshot = args.screenshot !== false
        const includeText = args.text !== false
        if (!includeScreenshot && !includeText) {
          throw argsError(t('err.observeBothFalse'))
        }
        const maxChars = args.max_chars ?? config.cuMaxTreeChars
        return withLease(
          config,
          sessionIdFor(exec.agent),
          async (call) => {
            const window = await resolveWindow(call, args.window)
            let state
            let captureNote = ''
            try {
              state = await call('get_window_state', {
                window,
                include_screenshot: includeScreenshot,
                include_text: includeText,
              })
            } catch (error) {
              // 某些窗口（受保护/被遮挡/最小化/接近全黑）WGC 抓不到图，Agent 会让整次调用失败。
              // 只要用户还要文本，就降级成纯文本观察 —— 观察失败比「看不到图」严重得多。
              if (!includeScreenshot || !includeText) throw error
              state = await call('get_window_state', { window, include_screenshot: false, include_text: true })
              captureNote = t('cu.captureDegraded', { reason: error?.message ?? error })
            }
            const tree = String(state?.accessibility?.tree ?? '')
            const filtered = filterTree(tree, args.filter)
            const cut = truncate(filtered.text, maxChars)
            const shot = includeScreenshot ? state?.screenshots?.[0] : undefined
            let attached = { block: null, reason: '' }
            if (shot?.url) {
              attached = await attachDataUrl(ctx, exec, shot.url, `kimi-cu-${window.id}.png`)
              if (!attached.block) captureNote = attached.reason ?? t('cu.captureRejected')
            } else if (includeScreenshot && !captureNote) {
              captureNote = state?.accessibility_status?.reason ?? t('cu.noScreenshot')
              attached = { block: null, reason: captureNote }
            }
            return {
              window: { id: window.id, title: window.title, app: window.app },
              text: cut.text,
              truncated: cut.truncated,
              note: cut.note ?? '',
              captureNote,
              filteredLines: filtered.matched,
              totalLines: filtered.total ?? null,
              focused: state?.accessibility?.focused_element ?? null,
              selected: state?.accessibility?.selected_elements ?? [],
              coordinateSpace: state?.coordinate_space ?? null,
              screenshot: includeScreenshot
                ? {
                    id: shot?.id ?? '',
                    width: shot?.width ?? 0,
                    height: shot?.height ?? 0,
                    attached: attached.block !== null,
                    note: captureNote,
                  }
                : null,
              accessibilityStatus: state?.accessibility_status ?? null,
              imageBlock: attached.block,
            }
          },
          { signal: exec.signal },
        )
      },
      render(value) {
        const lines = [t('render.window', { title: value.window.title, id: value.window.id })]
        if (value.focused) lines.push(t('render.focused', { value: value.focused }))
        if (value.screenshot) {
          lines.push(
            value.screenshot.attached
              ? t('render.screenshotOk', {
                width: value.screenshot.width,
                height: value.screenshot.height,
                attached: t('render.attached'),
              })
              : t('render.screenshotUnavailable', {
                  reason: value.screenshot.note || value.captureNote || t('cu.noScreenshot'),
                }),
          )
        }
        if (value.filteredLines !== null)
          lines.push(t('render.treeFilter', { matched: value.filteredLines, total: value.totalLines ?? '?' }))
        if (value.text) lines.push('', value.text)
        else lines.push('', t('render.noTree'))
        if (value.truncated) lines.push('', value.note)
        const blocks = [textBlock(lines.join('\n'))]
        if (value.imageBlock) blocks.push(value.imageBlock)
        return blocks
      },
    }),
  )

  // ---------------------------------------------------------------- act
  tools.push(
    defineTool({
      name: 'kimi_cu_act',
      description:
        'Send one input action to a desktop window. action=click (needs element_index OR x/y), type (types into current focus), ' +
        'key (one chord like "Control_L+a" or "Enter"), scroll (scrollY>0 scrolls DOWN), set_value (UIA value pattern), ' +
        'drag / drag_path, secondary (UIA invoke/toggle/expand/select), activate (bring window forward). ' +
        'A successful call means dispatched, NOT accepted — verify with kimi_cu_observe.',
      parameters: objectSchema({
        action: {
          schema: {
            type: 'string',
            enum: CU_ACTIONS,
            description: 'click / type / key / scroll / set_value / drag / drag_path / secondary / activate',
          },
          required: true,
        },
        window: {
          schema: {
            oneOf: [{ type: 'integer' }, { type: 'string' }],
            description: 'Window id from kimi_cu_windows / kimi_cu_observe, or a title.',
          },
          required: true,
        },
        element_index: intField('Target element [index] (for click / set_value / secondary).'),
        x: intField('Screenshot-space x (for click / scroll; mutually exclusive with element_index).'),
        y: intField('Screenshot-space y (for click / scroll; mutually exclusive with element_index).'),
        screenshot_id: stringField('Screenshot id from kimi_cu_observe (recommended when using coordinates).'),
        button: { schema: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; default left.' } },
        click_count: intField('Number of clicks (1-3, default 1).'),
        text: stringField('Text for type; this overwrites the system clipboard.'),
        key: stringField('Key chord for key, e.g. Enter / Escape / Control_L+a / Shift_L+Tab.'),
        scroll_x: intField('Horizontal wheel amount for scroll (positive scrolls right).'),
        scroll_y: intField('Vertical wheel amount for scroll (positive scrolls DOWN).'),
        value: stringField('Value written by set_value.'),
        from_x: intField('Drag start x.'),
        from_y: intField('Drag start y.'),
        to_x: intField('Drag end x.'),
        to_y: intField('Drag end y.'),
        points: arrayField('Coordinate path for drag_path: [[x,y],...] with 2-1024 points.', { type: 'array', items: { type: 'integer' } }),
        uia_action: {
          schema: {
            type: 'string',
            enum: ['invoke', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view'],
            description: 'UIA pattern used by secondary.',
          },
        },
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        // 先把动作参数校验完，再碰运行时 —— 参数错了不该去拉 Agent。
        const plan = planAction(args)
        return withLease(
          config,
          sessionIdFor(exec.agent),
          async (call) => {
            const window = await resolveWindow(call, args.window)
            const base = { window }
            if (args.screenshot_id) base.screenshotId = String(args.screenshot_id)

            if (plan.action === 'click') {
              await call('click', { ...base, ...plan.request })
              return { action: 'click', window: window.title, target: plan.target, dispatched: true }
            }
            if (plan.action === 'type') {
              await call('type_text', { ...base, text: plan.text })
              return {
                action: 'type',
                window: window.title,
                chars: plan.text.length,
                dispatched: true,
                note: t('cu.typeNote'),
              }
            }
            if (plan.action === 'key') {
              await call('press_key', { ...base, key: plan.key })
              return { action: 'key', window: window.title, key: plan.key, dispatched: true }
            }
            if (plan.action === 'scroll') {
              await call('scroll', { ...base, ...plan.request })
              return { action: 'scroll', window: window.title, ...plan.summary, dispatched: true }
            }
            if (plan.action === 'set_value') {
              await call('set_value', { ...base, element_index: plan.element_index, value: plan.value })
              return { action: 'set_value', window: window.title, element_index: plan.element_index, dispatched: true }
            }
            if (plan.action === 'drag') {
              await call('drag', { ...base, ...plan.request })
              return { action: 'drag', window: window.title, from: plan.from, to: plan.to, dispatched: true }
            }
            if (plan.action === 'drag_path') {
              await call('drag_path', { ...base, points: plan.points })
              return { action: 'drag_path', window: window.title, points: plan.points.length, dispatched: true }
            }
            if (plan.action === 'secondary') {
              await call('perform_secondary_action', { ...base, element_index: plan.element_index, action: plan.uia })
              return {
                action: 'secondary',
                window: window.title,
                element_index: plan.element_index,
                uia: plan.uia,
                dispatched: true,
              }
            }
            await call('activate_window', base)
            return { action: 'activate', window: window.title, activated: true }
          },
          { signal: exec.signal },
        )
      },
      render(value) {
        if (value.action === 'activate') return [textBlock(t('cu.activatedWindow', { window: value.window }))]
        const detail = JSON.stringify({ ...value, window: undefined, action: undefined, dispatched: undefined }).slice(0, 300)
        return [
          textBlock(
            t('cu.dispatched', { action: value.action, window: value.window, detail }),
          ),
        ]
      },
    }),
  )

  // ---------------------------------------------------------------- launch
  tools.push(
    defineTool({
      name: 'kimi_cu_launch',
      description:
        'Launch a desktop app by display name, StartApps appId, or executable path. Returns no window: call kimi_cu_windows afterwards. ' +
        'Prefer a known name/path; use kimi_cu_cmd with list_available_apps only when the identifier is uncertain.',
      parameters: objectSchema({
        app: { ...stringField('Application name, StartApps appId, or executable path.'), required: true },
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      async execute(args, exec) {
        const app = String(args.app ?? '').trim()
        if (!app) throw argsError(t('err.appRequired'))
        return withLease(
          config,
          sessionIdFor(exec.agent),
          async (call) => {
            await call('launch_app', { app })
            return { launched: true, app, hint: t('cu.launchHint') }
          },
          { signal: exec.signal },
        )
      },
      render(value) {
        return [textBlock(t('cu.launchedRender', { app: value.app, hint: value.hint }))]
      },
    }),
  )

  // ---------------------------------------------------------------- script（批量 + 逃生口）
  const SCRIPT_ACTIONS = [...CU_ACTIONS, 'windows', 'observe', 'launch', 'call', 'sleep', 'wait_window']
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * 进入租约之前先做纯校验：动作名、必填字段、互斥字段、UIA 方法白名单。
   * 这样「参数写错」不会白拉一次 Agent，也不会占着真实输入。
   * @param {Array<{action?: string, args?: object}>} steps
   */
  function preflightSteps(steps) {
    steps.forEach((step, index) => {
      const action = String(step?.action ?? '').trim()
      const raw = step?.args && typeof step.args === 'object' ? step.args : {}
      const where = index + 1
      if (!SCRIPT_ACTIONS.includes(action)) {
        throw argsError(t('script.unknownAction', { index: where, action, available: SCRIPT_ACTIONS.join(', '), extra: '' }))
      }
      if (action === 'call') {
        const method = String(raw.method ?? '').trim()
        validateCall(method, raw.args && typeof raw.args === 'object' ? raw.args : {})
        return
      }
      if (action === 'observe') {
        if (raw.screenshot === false && raw.text === false) throw argsError(t('script.observeBothFalse', { index: where }))
        if (raw.window === undefined || raw.window === null) throw argsError(t('script.observeNeedsWindow', { index: where }))
        return
      }
      if (action === 'wait_window') {
        if (!String(raw.title ?? '').trim()) throw argsError(t('script.waitWindowNeedsTitle', { index: where }))
        return
      }
      if (action === 'launch') {
        if (!String(raw.app ?? '').trim()) throw argsError(t('script.launchNeedsApp', { index: where }))
        return
      }
      if (action === 'windows' || action === 'sleep') return
      // 输入类动作：复用同一套规划器（element_index/x-y 互斥等）
      if (raw.window === undefined || raw.window === null) throw argsError(t('script.stepNeedsWindow', { index: where, action }))
      planAction({ ...raw, action })
    })
  }

  /**
   * 执行一步桌面动作（在租约内）。
   * @returns {Promise<{summary: string, text?: string, note?: string, cacheWindows?: object[]}>}
   */
  async function runCuStep({ call, action, raw, resolveCached, shots }) {
    if (action === 'windows') {
      const list = await call('list_windows')
      const windows = Array.isArray(list) ? list : []
      const needle = String(raw.filter ?? '').toLowerCase()
      const kept = windows.filter((w) => !needle || `${w.title} ${w.app}`.toLowerCase().includes(needle))
      const limit = Number.isInteger(raw.limit) ? Math.max(1, Math.min(500, raw.limit)) : 50
      const shown = kept.slice(0, limit)
      const lines = shown.map((w) => `- id=${w.id}  "${w.title}"  ${w.app}`)
      return {
        summary:
          kept.length > shown.length
            ? t('cu.windowsCapped', { count: kept.length, shown: shown.length })
            : t('cu.windows', { count: kept.length }),
        text: lines.length ? lines.join('\n') : t('cu.noWindows'),
        // @n 指向「过滤并截断后」这一份，和模型看到的一致；
        // 全部窗口另外按 id/title 进缓存，避免重复解析。
        atList: shown,
        cacheWindows: windows,
      }
    }

    if (action === 'sleep') {
      const ms = Math.max(0, Math.min(10_000, Number(raw.ms ?? 300)))
      await sleep(ms)
      return { summary: t('cu.slept', { ms }) }
    }

    if (action === 'wait_window') {
      const needle = String(raw.title ?? '').trim().toLowerCase()
      if (!needle) throw argsError(t('script.waitWindowTitleOnly'))
      const timeoutMs = Math.max(500, Math.min(30_000, Number(raw.timeout_ms ?? 8000)))
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const list = await call('list_windows')
        const hit = (Array.isArray(list) ? list : []).find((w) => String(w.title ?? '').toLowerCase().includes(needle))
        if (hit) {
          return {
            summary: t('cu.waitedWindow', { id: hit.id, title: hit.title }),
            text: `- id=${hit.id}  "${hit.title}"  ${hit.app}`,
            atList: [hit],
            cacheWindows: [hit],
          }
        }
        await sleep(250)
      }
      throw argsError(t('script.waitTimeout', { timeout: timeoutMs, title: raw.title }))
    }

    if (action === 'launch') {
      const app = String(raw.app ?? '').trim()
      if (!app) throw argsError(t('err.appRequired'))
      await call('launch_app', { app })
      return { summary: t('cu.launched', { app }) }
    }

    if (action === 'observe') {
      const includeScreenshot = raw.screenshot !== false
      const includeText = raw.text !== false
      if (!includeScreenshot && !includeText) throw argsError(t('err.observeBothFalse'))
      const window = await resolveCached(raw.window)
      let state
      let captureNote = ''
      try {
        state = await call('get_window_state', {
          window,
          include_screenshot: includeScreenshot,
          include_text: includeText,
        })
      } catch (error) {
        // 抓不到图（受保护/被遮挡/输入法宿主）不该让整步失败：降级成纯文本
        if (!includeScreenshot || !includeText) throw error
        state = await call('get_window_state', { window, include_screenshot: false, include_text: true })
        captureNote = t('cu.captureDegraded', { reason: String(error?.message ?? error).slice(0, 240) })
      }
      const tree = String(state?.accessibility?.tree ?? '')
      const filtered = filterTree(tree, raw.filter)
      const cap = Number.isInteger(raw.max_chars) ? Math.max(200, Math.min(60_000, raw.max_chars)) : 3000
      const cut = truncate(filtered.text, cap)
      const shot = includeScreenshot ? state?.screenshots?.[0] : undefined
      if (shot?.url) shots.push({ dataUrl: shot.url, name: `kimi-cu-${window.id}.png` })
      return {
        summary: t('cu.observed', {
          title: window.title,
          summary: `${cut.text ? t('cu.observeText', { lines: cut.text.split('\n').length }) : t('cu.observeNoText')}${
            shot?.url ? t('cu.observeShot') : captureNote ? t('cu.observeNoShot') : ''}`,
        }),
        text: cut.text,
        ...(captureNote ? { note: captureNote } : {}),
      }
    }

    if (action === 'call') {
      const method = String(raw.method ?? '').trim()
      const methodArgs = raw.args && typeof raw.args === 'object' ? { ...raw.args } : {}
      validateCall(method, methodArgs)
      if (methodArgs.window !== undefined && (typeof methodArgs.window === 'number' || typeof methodArgs.window === 'string')) {
        methodArgs.window = await resolveCached(methodArgs.window)
      }
      const result = await call(method, methodArgs)
      return { summary: t('cu.callResult', { method, value: JSON.stringify(result).slice(0, 300) }) }
    }

    // 输入类动作：沿用 kimi_cu_act 的同一套规划器（互斥字段等校验完全一致）
    const plan = planAction({ ...raw, action })
    if (raw.window === undefined || raw.window === null) throw argsError(t('err.cuStepNeedsWindow', { action }))
    const window = await resolveCached(raw.window)
    const base = { window }
    if (raw.screenshot_id) base.screenshotId = String(raw.screenshot_id)

    switch (plan.action) {
      case 'click':
        await call('click', { ...base, ...plan.request })
        return { summary: t('cu.clicked', { target: JSON.stringify(plan.target) }) }
      case 'type':
        await call('type_text', { ...base, text: plan.text })
        return { summary: t('cu.typed', { count: plan.text.length }) }
      case 'key':
        await call('press_key', { ...base, key: plan.key })
        return { summary: t('cu.pressed', { key: plan.key }) }
      case 'scroll':
        await call('scroll', { ...base, ...plan.request })
        return { summary: t('cu.scrolled', { x: plan.summary.scrollX, y: plan.summary.scrollY }) }
      case 'set_value':
        await call('set_value', { ...base, element_index: plan.element_index, value: plan.value })
        return { summary: `set_value #${plan.element_index}` }
      case 'drag':
        await call('drag', { ...base, ...plan.request })
        return { summary: t('cu.dragged', { from: JSON.stringify(plan.from), to: JSON.stringify(plan.to) }) }
      case 'drag_path':
        await call('drag_path', { ...base, points: plan.points })
        return { summary: t('cu.dragPath', { count: plan.points.length }) }
      case 'secondary':
        await call('perform_secondary_action', { ...base, element_index: plan.element_index, action: plan.uia })
        return { summary: `UIA ${plan.uia} #${plan.element_index}` }
      default:
        await call('activate_window', base)
        return { summary: t('cu.activated') }
    }
  }

  tools.push(
    defineTool({
      name: 'kimi_cu_script',
      description:
        'Run 1–30 desktop actions in ONE call (single input lease), instead of one model round per action. Accepts a single {action, ...} or a {steps:[...]} array. ' +
        `Step actions: ${SCRIPT_ACTIONS.join(', ')}, plus "call" {method,args} for any of ${CU_METHODS.join('/')}. ` +
        'Point each input step at a window: id, title substring, or "@n" = the n-th entry from the last windows/wait_window step. ' +
        'Prefer short scripts ending with "observe"; a failing step returns ok:false plus the steps that already ran.',
      parameters: objectSchema({
        action: { schema: { type: 'string', enum: SCRIPT_ACTIONS, description: 'Single-step mode: the action name.' } },
        window: {
          schema: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: 'Single-step mode: the window (id or title).' },
        },
        args: objField('Single-step mode arguments (same shape as a step args object).'),
        steps: {
          schema: {
            type: 'array',
            description:
              'Batch mode: run [{action, args?, capture?}] in order, 1-30 steps. observe steps attach a screenshot and return text by default (budgeted).',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['action'],
              properties: {
                action: { type: 'string', description: `Action name: ${SCRIPT_ACTIONS.join(' / ')}` },
                args: { type: 'object', additionalProperties: true, properties: {} },
                capture: { type: 'boolean', description: 'Include this step full text in the result' },
              },
            },
          },
        },
        stop_on_error: boolField('Stop at the first failing step (default true).'),
        settle_ms: intField('Default wait between steps in milliseconds (0-5000, default 120).'),
        max_result_chars: intField('Total text budget for the aggregated result (500-60000, default 8000).'),
      }),
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
      timeoutMs: Math.max(config.kimicuTimeoutMs, 180_000),
      async execute(args, exec) {
        const single = args.action !== undefined
        const steps = single
          ? [{ action: args.action, args: { ...(args.args ?? {}), ...(args.window !== undefined ? { window: args.window } : {}) } }]
          : args.steps
        if (!Array.isArray(steps) || steps.length === 0) {
          throw argsError(t('script.needActionOrSteps'))
        }
        if (steps.length > 30) throw argsError(t('script.tooManySteps', { max: 30 }))
        preflightSteps(steps)

        const stopOnError = args.stop_on_error !== false
        const settleMs = Number.isInteger(args.settle_ms) ? Math.max(0, Math.min(5000, args.settle_ms)) : 120
        const maxChars = Number.isInteger(args.max_result_chars) ? args.max_result_chars : 8000
        let remaining = maxChars
        const shots = []
        const results = []
        const windowCache = new Map()
        let stoppedAt = null
        let ok = true
        const startedAt = Date.now()

        await withLease(
          config,
          sessionIdFor(exec.agent),
          async (call) => {
            const resolveCached = async (ref) => {
              if (ref === undefined || ref === null) throw argsError(t('script.needWindow'))
              const key = String(ref)
              if (windowCache.has(key)) return windowCache.get(key)
              const win = await resolveWindow(call, ref)
              windowCache.set(key, win)
              windowCache.set(String(win.id), win)
              if (win.title) windowCache.set(win.title, win)
              return win
            }

            for (let index = 0; index < steps.length; index += 1) {
              const step = steps[index] ?? {}
              const action = String(step.action ?? '').trim()
              const raw = step.args && typeof step.args === 'object' ? { ...step.args } : {}
              const stepStarted = Date.now()
              try {
                const out = await runCuStep({ call, action, raw, resolveCached, shots })
                // 全部窗口按 id/title 缓存（省重复解析）；@n 只指向「上一步列出来的那份」
                for (const win of out.cacheWindows ?? []) {
                  windowCache.set(String(win.id), win)
                  if (win.title) windowCache.set(win.title, win)
                }
                for (let pos = 0; pos < (out.atList?.length ?? 0); pos += 1) windowCache.set(`@${pos}`, out.atList[pos])
                let includeText
                if (out.text && remaining > 0) {
                  const cap = Math.min(out.text.length, step.capture === true ? 4000 : 2000, remaining)
                  includeText = out.text.slice(0, cap)
                  remaining -= includeText.length
                  if (cap < out.text.length) includeText += `\n…${t('script.stepTruncated', { length: out.text.length })}`
                }
                results.push({
                  index,
                  action,
                  ok: true,
                  ms: Date.now() - stepStarted,
                  summary: out.summary,
                  ...(includeText !== undefined ? { text: includeText } : {}),
                  ...(out.note ? { note: out.note } : {}),
                })
              } catch (error) {
                ok = false
                results.push({
                  index,
                  action: action || '?',
                  ok: false,
                  ms: Date.now() - stepStarted,
                  error: String(error?.message ?? error).slice(0, 500),
                })
                if (stopOnError) {
                  stoppedAt = index
                  break
                }
              }
              if (settleMs > 0 && index < steps.length - 1) await sleep(settleMs)
            }
          },
          { signal: exec.signal },
        )

        // 租约释放后再附加截图：不占着真实输入去等附件落盘
        const imageBlocks = []
        for (const shot of shots.slice(0, 3)) {
          const attached = await attachDataUrl(ctx, exec, shot.dataUrl, shot.name)
          if (attached.block) imageBlocks.push(attached.block)
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
          if (r.note) lines.push(`(${r.note})`)
        }
        const failedIndex = stoppedAt ?? (ok ? -1 : results.length - 1)
        return {
          ok,
          totalMs,
          stepCount: steps.length,
          ranSteps: results.length,
          stoppedAt,
          steps: results,
          images: imageBlocks,
          summary: `${ok ? t('script.allDone') : t('script.failedAt', { index: failedIndex + 1 })}${t('render.colon')}${t('script.progress', {
            ran: results.length,
            total: steps.length,
            ms: totalMs,
          })}${
            imageBlocks.length ? t('script.attachedShots', { count: imageBlocks.length }) : ''
          }\n${lines.join('\n')}`,
        }
      },
      render(value) {
        const blocks = [textBlock(value.summary)]
        for (const image of value.images ?? []) blocks.push(image)
        return blocks
      },
    }),
  )

  return tools
}

export { sessionIdFor, filterTree }
