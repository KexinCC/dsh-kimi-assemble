/**
 * lib/i18n.mjs —— 用户可见文案的双语目录
 * ============================================================================
 * 为什么内联在 JS 里而不是读 locale/*.json：
 *   1. locale/*.json 是给 Plugin Manager / 设置页看「显示元数据」用的，插件
 *      运行时不该依赖打包后的相对路径去读它们；
 *   2. 零 IO 才能在激活瞬间同步建好 translator，不用 async。
 *
 * 分工（重要，别混）：
 *   - **工具 description 恒为英文**：模型侧一致，避免同一工具两种描述造成
 *     提示缓存与行为差异。
 *   - 本文件管**用户/模型都能看到的过程文案**：错误信息、render 文本、下一步
 *     提示、系统提示段、skill 正文。语言由 config.language 决定。
 *
 * 缺失键不会抛错：返回键名本身并在 __DEBUG 时告警，避免一条文案缺失让工具
 * 直接失效。
 *
 * 依赖约定：本文件 **不 import 任何 lib 模块**，这样 errors.mjs / config.mjs
 * 可以放心 import 它而不形成循环。
 * ============================================================================
 */

export const LANGUAGES = /** @type {const} */ (['auto', 'en', 'zh'])

/**
 * 语言判定：显式配置优先；auto 时看环境变量与系统区域。
 * 非法取值按 auto 处理（config.mjs 负责报错，这样这里不依赖 KimiError）。
 * @param {string} configured `auto` | `en` | `zh`
 * @param {Record<string, string | undefined>} [env]
 * @returns {'en' | 'zh'}
 */
export function resolveLanguage(configured = 'auto', env = process.env) {
  const pick = String(configured ?? 'auto').trim().toLowerCase()
  if (pick === 'en' || pick === 'zh') return pick

  // 1) 显式覆盖（CI 与测试用）
  const forced = String(env.KIMI_LANG ?? '').trim().toLowerCase()
  if (forced === 'zh' || forced === 'en') return forced

  // 2) POSIX 区域变量
  const locale = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase()
  if (locale.startsWith('zh')) return 'zh'
  if (locale) return 'en'

  // 3) Windows / 桌面：用 ICU 的默认区域
  try {
    const intl = new Intl.DateTimeFormat().resolvedOptions().locale ?? ''
    if (intl.toLowerCase().startsWith('zh')) return 'zh'
  } catch {
    /* 极端环境下拿不到就退 en */
  }
  return 'en'
}

/**
 * 目录。扁平键，`{name}` 占位符，`params` 里同名键替换。
 * 命名约定：`<area>.<thing>`，例如 `err.windowRequired`、`render.truncated`。
 */
const CATALOG = {
  en: {
    // ---- 通用参数校验 ----
    'args.invalid': 'Invalid arguments: {problems}',
    'args.required': '{field} is required',
    'args.unknownField': '{field} is not a known parameter (available: {available})',
    'args.wrongType': '{field} must be {expected}, got {actual}',
    'args.notAnyOf': '{field} matches none of the allowed shapes',
    'args.enum': '{field} must be one of {allowed}, got {actual}',
    'args.range': '{range}',

    // ---- 配置 ----
    'config.verifyValue': 'browserVerify must be auto or off (got {value})',
    'config.notNumber': 'must be a number, got {value}',
    'config.outOfRange': 'must be within [{min}, {max}], got {value}',
    'config.addrShape': 'webbridgeAddr must look like host:port (for example 127.0.0.1:10086), got "{value}"',
    'config.languageValue': 'language must be auto / en / zh, got {value}',

    // ---- 渲染与截断 ----
    'render.truncated': 'Content exceeds {max} characters and was truncated; raise max_chars or narrow the filter to see more.',
    'render.fileSuffix': '{count} file(s)',
    'render.attached': 'attached to the conversation',
    'render.notAttached': 'not attached: {reason}',
    'render.screenshotUnavailable': 'Screenshot: unavailable ({reason}); the text below is still usable.',
    'render.screenshotOk': 'Screenshot: {width}x{height} ({attached})',
    'render.focused': 'Focus: {value}',
    'render.window': 'Window: {title} (id={id})',
    'render.treeFilter': 'Tree filter: matched {matched} of {total} lines',
    'render.noTree': '(no accessibility text; use the screenshot to locate elements)',
    'render.empty': '(empty)',
    'render.noResult': '(no result)',
    'render.noMatches': '(none)',
    'render.noPath': '(no path)',
    'render.noTabs': 'No tabs.',
    'render.loading': '(loading)',
    'render.done': 'done',
    'render.closed': 'closed',
    'render.none': 'none',
    'render.dispatched': 'dispatched',
    'render.ineffective': 'no effect',
    'render.colon': ': ',
    'render.nextCursor': 'next_cursor: {cursor} (pass it back as cursor to read on)',
    'render.hintReadFirst': 'Next: read the page with kimi_browser_read, then decide where to click.',
    'render.opened': 'Opened {url}\nTitle: {title}\ntabId: {tabId}  session: {session}',
    'render.clicked': 'Clicked {selector}{tag}{text}',
    'render.clickedTag': ' ({tag})',
    'render.clickedText': '\nText: {text}',
    'render.filled': 'Filled {selector} ({length} characters{mode}){submitted}',
    'render.richEditor': ', rich text editor',
    'render.submitted': ', submitted',
    'render.screenshotSaved': 'Screenshot saved: {path} ({bytes} bytes)',
    'render.notAttachedLine': 'Not attached to the conversation: {note}',
    'render.tabList': '{scope}:\n{lines}',
    'render.tabsAll': 'All tabs visible to the extension',
    'render.tabsSession': 'Tabs opened by this task',
    'render.preview': 'Preview',
    'submit.enter': 'submitted with Enter (last resort)',
    'submit.escapeClick': 'a dropdown or overlay was in the way — closed it with Esc and clicked submit again',
    'submit.clicked': 'clicked the form submit button ({how})',
    'submit.failed':
      'the text was filled in, but submitting had no visible effect after three attempts (submit button, Esc → submit button, then Enter). This extension cannot produce real key events, so implicit Enter submission does not work here — if the page needs a trusted click, ask the user. Note: some pages submit without visibly changing the current page.',
    'submit.requestSubmit': 'submitted with form.requestSubmit() (no clickable submit button)',
    'render.dispatchOnly': 'dispatched (this does not prove it took effect — observe again to confirm)',
    'render.tabClosed': 'closed {count} tab(s)',
    'render.doneAt': 'done in {ms}ms',
    'render.untitled': '(untitled)',

    // ---- 脚本（批量） ----
    'script.allDone': 'All done',
    'script.failedAt': 'Step {index} failed, stopped',
    'script.progress': 'ran {ran}/{total} steps in {ms}ms',
    'script.attachedShots': ', {count} screenshot(s) attached',
    'script.stepLine': '{mark} {index}. {action} ({ms}ms): {detail}',
    'script.stepContent': '--- step {index} content ({action}) ---',
    'script.stepTruncated': 'step text truncated (was {length} characters)',
    'script.steps': 'steps',
    'script.needActionOrSteps': 'Provide action (single step) or steps (batch, at least 1)',
    'script.tooManySteps': 'At most {max} steps; split the work into several calls',
        'script.unknownActionHint': ' — did you mean "{guess}"?',
    'script.assertNote': 'assert / commit are script-engine actions: assert aborts the whole batch when a precondition fails, commit marks an irreversible boundary.',
    'script.assertNeedsTarget': 'assert (step {index}) needs at least one of: url, selector, text',
    'script.assertFailed': 'assert failed at step {index}: {problems}',
    'script.assertUrl': 'url should contain \"{want}\" but is \"{actual}\"',
    'script.assertSelector': 'selector {selector} {negated}should {mode}',
    'script.assertExists': 'exist',
    'script.assertVisible': 'be visible',
    'script.assertNegated': 'NOT ',
    'script.assertText': 'page text {negated}should contain \"{text}\"',
    'script.assertPassed': 'precondition holds (url {url})',
    'script.committed': 'committed{note}',
    'script.commitNote': ' (commits at: {count})',
    'script.afterCommit': ' — this happened AFTER commit at step {index}; do not blindly retry the committed steps.',
    'next.browserDown': 'the Kimi WebBridge daemon is not reachable, so browser tools cannot work yet.',
    'next.startDaemon': 'start the WebBridge service (the Kimi browser-extension helper), then retry',
    'next.reloadExtension': 'make sure the Kimi browser extension is installed and enabled, then reload it',
    'next.extensionMissing': 'the WebBridge daemon is running but the Kimi browser extension is not connected (or is too old).',
    'next.installExtension': 'install the Kimi browser extension in Chrome/Edge from the official store',
    'next.portBusy': 'the WebBridge port is held by another process.',
    'next.freePort': 'close whatever else is using the WebBridge port, or set webbridgeAddr to the right one',
    'next.desktopMissing': 'the KimiCU desktop runtime is not installed, so kimi_cu_* tools cannot work yet.',
    'next.installDesktop': 'download and run the official KimiCU installer, then retry',
    'next.desktopBusy': 'the KimiCU agent is busy or not answering.',
    'next.unlockDesktop': 'make sure the desktop is unlocked and the target window is not minimised',
    'next.unsupported': 'this bridge only works on Windows.',
    'next.needWindows': 'run the desktop tools on Windows (browser tools also work elsewhere, but the extension daemon must be local)',
    'next.runDoctor': 'preflight both bridges and print machine-readable next steps',
    'err.panelConflict':
      'Another browser extension has injected its own panel into this page (a password manager, translator, recorder…). Close that extension panel or switch that extension off for this site, then read again. Reading specific data with kimi_browser_eval also works while the panel is open.',
'script.unknownAction': 'step {index}: unknown action "{action}"; available: {available}{extra}',
    'script.plusRead': ', plus read',
    'script.navigateNeedsUrl': 'step {index}: navigate requires url in args',
    'script.stepNeedsWindow': 'step {index}: {action} requires window (id, title, or @n)',
    'script.observeNeedsWindow': 'step {index}: observe requires window (id or title)',
    'script.observeBothFalse': 'step {index}: observe cannot have screenshot and text both false',
    'script.waitWindowNeedsTitle': 'step {index}: wait_window requires title',
    'script.launchNeedsApp': 'step {index}: launch requires app',
    'script.needWindow': 'A window is required (id, title, or @n referring to the latest windows step)',
    'script.waitTimeout': 'wait_window: no window whose title contains "{title}" appeared within {timeout}ms',

    // ---- 浏览器动作摘要 ----
    'act.navigate': '→ {url} (tab {tabId})',
    'act.tab': 'tab {tabId} {url}',
    'act.found': '{count} match(es): {names}',
    'act.clicked': 'clicked {tag} {text}',
    'act.realClick': 'real mouse click ({result})',
    'act.filled': 'filled ({mode})',
    'act.eval': '= {value}',
    'act.screenshot': 'screenshot {path}',
    'act.pdf': 'PDF {path}',
    'act.closedSession': 'closed {count} tab(s)',
    'act.closedTab': 'tab closed ({result})',
    'act.scrolled': 'scrolled → scrollY={y}',
    'act.waited': 'condition met ({ms}ms)',
    'act.waitTimeout': 'wait timed out ({ms}ms)',
    'act.network': 'network: {value}',
    'act.dialog': 'dialog: {value}',
    'act.noDialog': 'no dialog',
    'act.read': '{title} {url}',

    // ---- 桌面动作摘要 ----
    'cu.clicked': 'clicked {target}',
    'cu.typed': 'typed {count} character(s) into the focused element',
    'cu.pressed': 'pressed {key}',
    'cu.scrolled': 'scrolled dx={x} dy={y} (positive = down/right)',
    'cu.setValue': 'set_value #{index}',
    'cu.dragged': 'dragged {from} → {to}',
    'cu.dragPath': 'dragged along {count} points',
    'cu.uia': 'UIA {action} #{index}',
    'cu.activated': 'brought window forward',
    'cu.windows': '{count} window(s)',
    'cu.windowsCapped': '{count} window(s) (first {shown} listed)',
    'cu.noWindows': '(no matching window)',
    'cu.slept': 'waited {ms}ms',
    'cu.waitedWindow': 'window id={id} "{title}" appeared',
    'cu.launched': 'launched {app} (locate the window with wait_window or windows)',
    'cu.observed': 'observed "{title}": {summary}',
    'cu.observeText': '{lines} line(s) of text',
    'cu.observeNoText': 'no text',
    'cu.observeShot': ' + screenshot',
    'cu.observeNoShot': ' (screenshot unavailable)',
    'cu.captureDegraded': 'screenshot failed, degraded to text: {reason}',
    'cu.callResult': '{method} → {value}',
    'cu.windowsHeader': 'Observable and controllable windows:\n{lines}',
    'cu.windowsTruncated': '… ({total} total, truncated)',
    'cu.captureRejected': 'screenshot was not accepted',
    'cu.noScreenshot': 'this window returned no screenshot',
    'cu.typeNote': 'The text went to the focused element and overwrote the clipboard; send action=key with Enter to submit.',
    'cu.activatedWindow': 'Brought window forward: {window}',
    'cu.dispatched': '{action} dispatched to "{window}": {detail}\nNote: a successful dispatch does not mean the app accepted it — observe again with kimi_cu_observe for anything that matters.',
    'cu.launchHint': 'Next: find the new window with kimi_cu_windows (it may take a few seconds).',
    'cu.launchedRender': 'Launch requested: {app}\n{hint}',
    'script.waitWindowTitleOnly': 'wait_window needs title (a substring of the window title to wait for)',

    // ---- 提示段（系统提示） ----
    'guidance.header': 'Kimi local bridges (running on the user machine):',
    'guidance.browser': 'Browser: `kimi_browser_*` drives the user\'s already-logged-in Chrome through the Kimi extension. Read with `kimi_browser_read` first (its first lines are page state), then act with the `@e` refs it returns. Click/fill report `changed`: false means the dispatch did not take effect — do not retry the same element blindly. Prefer `kimi_browser_read {mode:"diff"}` over a full re-read, and `kimi_browser_wait` over polling. A native dialog freezes the page: answer it with `kimi_browser_dialog`.',
    'guidance.desktop': 'Desktop: `kimi_cu_*` observes and operates real Windows windows. Order is `kimi_cu_windows` → `kimi_cu_observe` → input; a successful input call only means "dispatched", so observe again to confirm anything that matters.',
    'guidance.batch': 'For several consecutive actions prefer one `kimi_browser_script` / `kimi_cu_script` call (each model round is expensive); when the page or UI may change in an unpredictable way, split it into two calls: run the first half, read the result, then run the second half.',
    'guidance.onlyTools': 'These two bridges are reachable only through the tools above; do not go around them with pwsh/curl or a JS cell (that corrupts non-ASCII text and bypasses argument validation).',
    'guidance.statusFirst': 'On a connection/readiness failure call `kimi_status` once for a diagnosis instead of repeating the same call.',
    'guidance.desktopNeedsUnlocked': 'Desktop input requires an unlocked interactive desktop; the runtime refuses terminal windows and Win/Meta chords — do not work around those refusals.',

    // ---- status ----
    'status.summaryOk': 'Browser (WebBridge): ready; Desktop (KimiCU): ready',
    'status.browserReady': 'Browser (WebBridge): ready',
    'status.browserNoExtension': 'Browser (WebBridge): daemon up, extension not connected',
    'status.browserDown': 'Browser (WebBridge): unavailable',
    'status.desktopReady': 'Desktop (KimiCU): ready',
    'status.desktopOff': 'Desktop (KimiCU): disabled',
    'status.desktopDown': 'Desktop (KimiCU): unavailable',
    'status.next': 'Next: {hint}',
    'status.join': '; ',
    'status.unresolved': '(unresolved)',
    'status.notFound': '(not found)',
    'status.unknown': '(unknown)',
    'status.browserLine': '- Browser: enabled={enabled} installed={installed} addr={addr} running={running} extensionConnected={extensionConnected}{daemonVersion}{extensionVersion}{error}',
    'status.desktopLine': '- Desktop: enabled={enabled} installed={installed} supported={supported} exe={exe} runtime={runtimeVersion} agentPid={agentPid} pipe={pipe}{permissions}{error}',
    'status.hintBrowserDown': 'Browser: the daemon is unreachable → run "{binary} start"; if the port is busy, change {addrFile} and set the same address in the extension.',
    'status.hintBrowserExtension': 'Browser: the daemon is up but the extension is not connected → open the Kimi side panel in Chrome and enable local agent remote control, with an address matching the daemon port.',
    'status.hintCuMissing': 'Desktop: the KimiCU runtime is not installed → run https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd , or set kimicuExePath in the config.',
    'status.hintCuAgent': 'Desktop: the runtime is present but its agent will not start → run "{exe} doctor" for a diagnosis.',
    'status.hintCuOld': 'Desktop: the runtime is too old → upgrade with setup_windows.cmd.',
    'status.hintCuPlatform': 'Desktop: KimiCU is Windows-only.',
    'status.hintCuOther': 'Desktop: {message}',

    // ---- 未安装时的引导（三态里的 missing） ----
    'status.browserNotInstalled': 'Browser: the Kimi browser extension is not installed on this machine. Install it (no Kimi account needed): 1) add the "Kimi" extension from the Chrome Web Store or Edge Add-ons (or the manual install at {page}); 2) open the extension sidebar → Settings → "本地 Agent 远程控制" → click 去连接/Connect; 3) copy the install command from that dialog into a terminal and run it (this installs the local daemon at ~/.kimi-webbridge). FAQ: {faq}',
    'status.desktopNotInstalled': 'Desktop: the KimiCU runtime is not installed. Download and run {url} in a terminal (Windows only), or set kimicuExePath in the plugin config to an existing kimi-cu.exe.',
    'status.browserLabelNotInstalled': 'Browser (WebBridge): not installed',
    'status.desktopLabelNotInstalled': 'Desktop (KimiCU): not installed',

    // ---- 错误：平台与运行时 ----
    'err.unsupportedPlatform': 'KimiCU is Windows-only; this platform has no desktop control.',
    'err.cuNotInstalled': 'KimiCU runtime not found (kimi-cu.exe). Tried: {candidates}. Next: run https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd , or set kimicuExePath to an existing executable.',
    'err.runtimeTooOld': 'KimiCU runtime {found} is older than the required {minimum}. Upgrade with setup_windows.cmd.',
    'err.agentStartFailed': 'The KimiCU runtime is present but its agent would not start: {reason}',
    'err.noCandidates': '(none)',

    // ---- 错误：连接与协议 ----
    'err.webbridgeDown': 'No daemon is reachable at {addr}. Create it with "{binary} start". If something else occupies that port, change webbridgeAddr (or ~/.kimi-webbridge/daemon.addr) and set the same address in the extension.',
    'err.webbridgeStartFailed': 'The daemon did not start ({addr}). {detail}Next: run "{binary} start" yourself and read its output, or point webbridgeAddr (or ~/.kimi-webbridge/daemon.addr) at a free port. Help: {help}',
    'err.webbridgeStartDetail': 'Startup command failed: {message}. ',
    'err.portBusy': 'The program on {addr} answered with non-JSON (HTTP {status}); it is not the WebBridge daemon. Point webbridgeAddr (or ~/.kimi-webbridge/daemon.addr) at a free port and set the same address in the extension.',
    'err.webbridgeTimeout': 'Browser action "{action}" got no response within {seconds}s ({addr}). The daemon may be stuck or a page script is blocking; call kimi_status for the current state.',
    'err.webbridgeCallFailed': 'Browser action "{action}" failed: {detail}',
    'err.badEnvelope': 'The daemon returned HTTP {status}: {detail}',
    'err.extensionOffline': 'The local daemon is fine but the browser extension is not connected: {detail}. Open the Kimi side panel in Chrome (Settings → local agent remote control), check that the address matches the daemon port, or update the extension: {help}',
    'err.versionMismatch': 'The browser extension is older than this bridge expects: {detail}. Update the extension and retry (no daemon restart needed): {help}',
    'err.urlRequired': 'url must not be empty',
    'err.helpWebbridge': 'https://www.kimi.com/products/kimi-browser-extension',
    'err.helpWebbridgeFaq': 'https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-faq',
    'err.helpCuSetup': 'https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd',
    'err.unknownError': 'unknown error',
    'err.selectorRequired': 'selector must not be empty: pass a CSS selector (e.g. "#submit") or an aria ref (e.g. @e12)',
    'err.findNeedsQuery': 'mode=find requires query (the search term)',
    'err.frameNeedsHandle': 'mode=frame requires frame (e.g. #f1); use mode=read first to see the frames list',
    'err.attachNeedsTabId': 'action=attach requires tab_id (an integer); find it with action=list_all first',
    'err.timeout': 'The operation did not finish within {ms}ms.',
    'err.aborted': 'The operation was cancelled.',

    // ---- 页面状态探针（lib/browser-state.mjs）----
    'meta.line': 'page: {title} — {url}',
    'meta.state': 'state: ready={ready} scroll={scrollY}/{scrollH} nodes={nodes} focus={focus}',
    'meta.counts': 'elements: {links} links, {buttons} buttons, {inputs} inputs, {forms} forms, {frames} frames',
    'meta.focusNone': '(none)',
    'meta.focusSelection': ' focus selection "{text}"',

    // ---- 动作生效校验 ----
    'verify.changed': 'page changed: {detail}',
    'verify.unchanged': 'dispatched, but nothing on the page changed within {ms}ms — it may not have taken effect. Re-read the page and check you are hitting the right element.',
    'verify.skipped': 'change check skipped: {reason}',
    'verify.url': 'url → {url}',
    'verify.title': 'title → {title}',
    'verify.nodes': 'dom {nodes} nodes',
    'verify.scroll': 'scroll {scrollY}/{scrollH}',
    'verify.ready': 'readyState {ready}',
    'verify.dialogBlocked':
      'a JavaScript dialog is open and blocks the page. Answer it with kimi_browser_dialog (status / accept / dismiss) before anything else. Dialog: {message}',
    'verify.staleRetried': 'the ref was stale; re-read the page and retried once ({detail})',
    'verify.staleHint': 'still failing after a fresh read — this ref no longer exists. Pick a new ref from the snapshot below.',
    'verify.freshFail': 'the original action failed: {detail}',

    // ---- 快照 diff ----
    'diff.header': 'changes since the previous read:',
    'diff.none': 'no changes since the previous read',
    'diff.truncated': '…diff truncated ({total} changed lines)',

    // ---- wait ----
    'err.waitNeedsCondition': 'wait needs at least one of: text, text_gone, selector, url, ready, ms',
    'wait.done': 'waited {ms}ms; {detail}',
    'wait.timeout': 'condition did not hold within {ms}ms ({detail})',
    'wait.matchedText': 'text appeared: "{text}"',
    'wait.goneText': 'text disappeared: "{text}"',
    'wait.matchedSelector': 'selector appeared: {selector}',
    'wait.urlMatched': 'url matched: {url}',
    'wait.readyMatched': 'readyState = {ready}',

    // ---- evaluate ----
    'err.evalNeedsCode': 'code must not be empty',
    'eval.result': 'result: {value}',
    'eval.truncated': '…result truncated at {chars} chars',
    'eval.failed': 'evaluate failed: {detail}',

    // ---- act ----
    'err.actUnknownVerb': 'unknown verb "{verb}"; available: {available}',
    'err.actNeedsSelector': 'verb "{verb}" needs selector (CSS or @eNNN ref)',
    'err.actNeedsValue': 'verb "{verb}" needs value',
    'err.actNeedsKeys': 'verb "{verb}" needs keys (e.g. "Enter", "Mod+A", "Shift+Tab")',
    'err.actNeedsFiles': 'verb "{verb}" needs files (absolute paths) or attachments',
        'act.realKey': 'sent a real {keys} key event through CDP',
    'submit.cdpEnter': 'Enter was sent as a real key event through CDP (the extension cannot produce key events)',
'act.done': '{verb} done: {detail}',

    // ---- dialog ----
    'err.dialogNeedsAction': 'action must be status / accept / dismiss',
    'dialog.none': 'no JavaScript dialog is open',
    'dialog.open': 'dialog open: {type} "{message}" — accept it or dismiss it',
    'dialog.handled': 'dialog {action}: {detail}',


    // ---- 错误：窗口解析 ----
    'err.windowNoMatch': 'No window title matches "{value}". Current windows: {candidates}. Run kimi_cu_windows for the list.',
    'err.windowAmbiguous': '"{value}" matches {count} windows: {candidates}. Pass the numeric id to pick one.',
    'err.windowNotFound': 'Window id={id} is not open any more.',
    'err.windowNeedsIdOrTitle': 'window must be an id, a title, or @n',
    'err.cuBusy': 'Another session holds real desktop input right now. Stop sending input; read-only observation usually still works. Do not kill the other session.',
    'err.cuTool': 'KimiCU {code} {message}',

    // ---- 错误：动作规划 ----
    'err.actionRequired': 'action is required',
    'err.unknownAction': 'Unknown action "{action}"; available: {available}',
    'err.clickTarget': 'click needs element_index OR x and y (exactly one)',
    'err.clickBoth': 'give element_index or x/y, not both',
    'err.clickXY': 'x and y must be given together',
    'err.secondaryNeedsIndex': 'secondary needs element_index',
    'err.dragNeedsCoords': 'drag needs from_x/from_y and to_x/to_y',
    'err.dragPathNeedsPoints': 'drag_path needs at least 2 points',
    'err.scrollNeedsDelta': 'scroll needs scroll_x or scroll_y',
    'err.typeNeedsText': 'type needs text',
    'err.keyNeedsChord': 'key needs a chord such as "Control_L+a"',
    'err.setValueNeedsIndex': 'set_value needs element_index and value',
    'err.tooManyPoints': 'drag_path allows at most {max} points',
    'err.valueTooLong': '{field} is too long ({length} > {max})',
    'err.selectorRequired': 'selector must not be empty: pass a CSS selector (e.g. "#submit") or an aria ref (e.g. @e12)',
    'err.findNeedsQuery': 'mode=find requires query (the search term)',
    'err.frameNeedsHandle': 'mode=frame requires frame (e.g. #f1); use mode=read first to see the frames list',
    'err.attachNeedsTabId': 'action=attach requires tab_id (an integer); find it with action=list_all first',
    'err.scrollNeedsPoint': 'scroll needs screenshot coordinates x/y (where in the window to scroll)',
    'err.setValueNeedsValue': 'set_value needs value (a string)',
    'err.dragMissingField': 'drag needs {field}',
    'err.pointShape': 'every drag_path point must be [x, y] with two integers',
    'err.secondaryNeedsUia': 'secondary needs uia_action (invoke / toggle / expand / collapse / select / scroll_into_view)',
    'err.observeBothFalse': 'screenshot and text cannot both be false: at least one must be read',
    'err.appRequired': 'app must not be empty',
    'err.cuStepNeedsWindow': '{action} needs a window (id or title)',

    // ---- 错误：CU 协议 ----
    'err.frameTooLarge': 'Request frame is {size} bytes, above the {max} byte limit',
    'err.pipeTimeout': 'No frame arrived within {ms}ms',
    'err.cuTimeout': 'Timed out waiting for the KimiCU agent ({ms}ms)',
    'err.cuAborted': 'The KimiCU request was cancelled',
    'err.cuClosedEarly': 'The KimiCU agent closed the connection before sending a complete frame',
    'err.cuNotObject': 'The KimiCU agent returned a non-object response',
    'err.cuIdMismatch': 'Response id mismatch: expected {expected}, got {actual}',
    'err.cuRequestFailed': 'the KimiCU agent request failed',
    'err.trailingData': 'The agent sent data after the response frame',
    'err.trailingBytes': 'The single-request connection returned trailing bytes',
    'err.badFrameLength': 'Invalid response frame length {length}',
    'err.badJson': 'Response was not valid JSON: {detail}',
    'err.agentNoPid': 'start-agent did not report a running agent (stdout: {stdout})',
    'err.noVersion': 'The KimiCU agent reported no valid version (got "{found}"); upgrade the runtime.',
    'err.agentStartFailed': 'The KimiCU runtime is installed but its agent would not start: {reason} Next: run "{exe} doctor" for a diagnosis, or "{exe} start-agent" to start it manually.',
    'err.noArgs': '(no arguments)',
    'err.unsupportedPlatformShort': 'KimiCU is Windows-only',
    'err.methodUnknown': 'Unknown KimiCU method "{method}"; available: {available}',
    'err.methodArgs': 'KimiCU method "{method}" does not accept parameter "{field}" (it accepts: {allowed})',
    'err.windowEmpty': 'window must not be empty; available windows: {candidates}',
    'err.leaseMismatch': 'The desktop agent rejected the lease: {detail} This usually means the agent restarted; retry once, and run "kimi-cu.exe doctor" if it persists.',

    // ---- skill 正文标题（供 skills.mjs 拼装） ----
    'skill.whenToUse.browser': 'when the user needs to drive a browser, read a page, fill a form or take a screenshot',
    'skill.whenToUse.desktop': 'when the user needs to operate a Windows desktop app, click/type, or inspect a window',

    // ---- 日志 ----
    'log.loaded': 'v{version} loaded: browser={browser} desktop={desktop} lang={lang}',
    'log.tools': 'registered {count} tool(s)',
    'log.skills': 'registered {count} runtime skill(s)',
    'log.skillFailed': 'failed to register skill "{name}": {reason}',
    'log.agentSkillFailed': 'failed to register skills for an agent: {reason}',
    'log.disabledTools': 'disabled tools by config: {names}',
    'log.unknownDisabledTool': 'disabledTools names an unknown tool "{name}" (available: {available})',

    // ---- 图片附件 ----
    'img.noRoute': 'the current model route could not be resolved',
    'img.noLlm': 'no llm service is mounted',
    'img.modelNoImage': 'model "{model}" does not declare image input support',
    'img.probeFailed': 'could not confirm image support: {detail}',
    'img.noAttachments': 'no attachment service is mounted',
    'img.routeNoImage': 'the current route does not support images',
    'img.rejected': 'the image was not accepted: {detail}',
    'img.noPath': 'the screenshot returned no file path',
    'img.unreadable': 'the screenshot file could not be read: {detail}',
    'img.badFormat': 'the screenshot is not a recognizable image format',
    'img.badDataUrl': 'the screenshot is not a standard base64 data URL',
    'img.empty': 'the screenshot content is empty',
  },

  zh: {
    'args.invalid': '参数不合法：{problems}',
    'args.required': '{field} 是必填项',
    'args.unknownField': '{field} 不是已知参数（可用：{available}）',
    'args.wrongType': '{field} 应为 {expected}，实际是 {actual}',
    'args.notAnyOf': '{field} 不符合任何一个允许的形态',
    'args.enum': '{field} 只能是 {allowed} 之一，收到 {actual}',
    'args.range': '（范围 {range}）',

    'config.verifyValue': 'browserVerify 只能是 auto 或 off（收到 {value}）',
    'config.notNumber': '配置项必须是数字，收到 {value}',
    'config.outOfRange': '配置项超出范围 [{min}, {max}]，收到 {value}',
    'config.addrShape': 'webbridgeAddr 必须是 host:port 形式（如 127.0.0.1:10086），收到 "{value}"',
    'config.languageValue': 'language 只能是 auto / en / zh，收到 {value}',

    'render.truncated': '内容超过 {max} 字符，已截断；用更大的 max_chars 或更窄的 filter 取更多。',
    'render.fileSuffix': '{count} 个文件',
    'render.attached': '已附到对话',
    'render.notAttached': '未附：{reason}',
    'render.screenshotUnavailable': '截图：不可用（{reason}）；下面的文本仍然可用。',
    'render.screenshotOk': '截图：{width}x{height}（{attached}）',
    'render.focused': '焦点：{value}',
    'render.window': '窗口：{title}（id={id}）',
    'render.treeFilter': '树行过滤：命中 {matched} / 共 {total} 行',
    'render.noTree': '（无无障碍文本；可改用截图定位）',
    'render.empty': '（空）',
    'render.noResult': '（无返回）',
    'render.noMatches': '（无）',
    'render.noPath': '（无路径）',
    'render.noTabs': '没有标签页。',
    'render.loading': '（读取中）',
    'render.done': '完成',
    'render.closed': '已关',
    'render.none': '无',
    'render.dispatched': '已派发',
    'render.ineffective': '未生效',
    'render.colon': '：',
    'render.nextCursor': 'next_cursor: {cursor}（用 cursor 参数继续读）',
    'render.hintReadFirst': '接下来用 kimi_browser_read 读页面，再决定点哪里。',
    'render.opened': '已打开 {url}\n标题：{title}\ntabId: {tabId}  session: {session}',
    'render.clicked': '已点击 {selector}{tag}{text}',
    'render.clickedTag': '（{tag}）',
    'render.clickedText': '\n文本：{text}',
    'render.filled': '已填入 {selector}（{length} 字符{mode}）{submitted}',
    'render.richEditor': '，富文本编辑器',
    'render.submitted': '，并已提交',
    'render.screenshotSaved': '截图已保存：{path}（{bytes} 字节）',
    'render.notAttachedLine': '未附到对话：{note}',
    'render.tabList': '{scope}：\n{lines}',
    'render.tabsAll': '扩展可见的全部标签页',
    'render.tabsSession': '本任务打开的标签页',
    'render.preview': '预览',
    'submit.enter': '用回车提交成功（兜底手段）',
    'submit.escapeClick': '有下拉或浮层挡住按钮 —— 先按 Esc 关掉，再点提交按钮，成功',
    'submit.clicked': '已点击表单提交按钮（{how}）',
    'submit.failed':
      '文字已经填进去了，但提交在三次尝试后仍没有可见效果（点提交按钮 → Esc 后再点 → 回车兜底）。本扩展无法产生真实的键盘事件，所以「输入框里按回车提交」在这里不会发生；如果页面需要可信点击，请让用户手动操作。另外有些页面提交后并不改变当前页。',
    'submit.requestSubmit': '没有可点的提交按钮，用 form.requestSubmit() 提交',
    'render.dispatchOnly': '已派发（这不代表已生效 —— 再 observe 一次复核）',
    'render.tabClosed': '关闭 {count} 个标签',
    'render.doneAt': '耗时 {ms}ms',
    'render.untitled': '（无标题）',

    'script.allDone': '全部完成',
    'script.failedAt': '第 {index} 步失败，已停止',
    'script.progress': '执行 {ran}/{total} 步，共 {ms}ms',
    'script.attachedShots': '，附 {count} 张截图',
    'script.stepLine': '{mark} {index}. {action}（{ms}ms）：{detail}',
    'script.stepContent': '── 第 {index} 步内容（{action}）──',
    'script.stepTruncated': '该步文本已截断（原长 {length} 字符）',
    'script.steps': '步骤',
    'script.needActionOrSteps': '需要 action（单步）或 steps（批量，至少 1 步）',
    'script.tooManySteps': '最多 {max} 步；拆成几段更稳',
    'script.assertNote': 'assert / commit 是脚本引擎自带动作：assert 前置条件不满足就中止整批，commit 标记不可逆边界。',
    'script.assertNeedsTarget': '第 {index} 步的 assert 至少要给一个：url / selector / text',
    'script.assertFailed': '第 {index} 步断言失败：{problems}',
    'script.assertUrl': '网址应包含 \"{want}\"，实际是 \"{actual}\"',
    'script.assertSelector': '选择器 {selector} {negated}应当{mode}',
    'script.assertExists': '存在',
    'script.assertVisible': '可见',
    'script.assertNegated': '不',
    'script.assertText': '页面文本{negated}应包含 \"{text}\"',
    'script.assertPassed': '前置条件成立（网址 {url}）',
    'script.committed': '已标记边界{note}',
    'script.commitNote': '（commit 点：{count} 处）',
    'script.afterCommit': ' —— 该失败发生在第 {index} 步的 commit 之后，不要盲目重试已提交的步骤。',
        'script.unknownActionHint': ' —— 你是不是想用 "{guess}"？',
    'next.browserDown': '连不上 Kimi WebBridge 服务，浏览器工具暂时用不了。',
    'next.startDaemon': '启动 WebBridge 服务（Kimi 浏览器扩展的本地助手），然后重试',
    'next.reloadExtension': '确认 Kimi 浏览器扩展已安装并启用，然后重新加载它',
    'next.extensionMissing': 'WebBridge 服务在跑，但 Kimi 浏览器扩展没连上（或版本太旧）。',
    'next.installExtension': '在 Chrome/Edge 里从官方商店安装 Kimi 浏览器扩展',
    'next.portBusy': 'WebBridge 的端口被别的进程占了。',
    'next.freePort': '关掉占用该端口的程序，或把 webbridgeAddr 指到正确的地址',
    'next.desktopMissing': 'KimiCU 桌面运行时没装，kimi_cu_* 工具暂时用不了。',
    'next.installDesktop': '下载并运行官方 KimiCU 安装包，然后重试',
    'next.desktopBusy': 'KimiCU 代理忙或没响应。',
    'next.unlockDesktop': '确认桌面未锁屏、目标窗口没被最小化',
    'next.unsupported': '桌面桥只能在 Windows 上用。',
    'next.needWindows': '在 Windows 上使用桌面工具（浏览器工具跨平台，但扩展服务必须在本机）',
    'next.runDoctor': '预检两条桥并输出机器可读的下一步',
    'err.panelConflict':
      '另一个浏览器扩展往这个页面里插了自己的面板（密码管理器、翻译、录屏之类），把无障碍树搅乱了。关掉那个扩展的面板、或对本站停用该扩展，然后再读一次。面板开着时也可以用 kimi_browser_eval 直接取数据。',
'script.unknownAction': '第 {index} 步：未知 action "{action}"；可用：{available}{extra}',
    'script.plusRead': '，外加 read',
    'script.navigateNeedsUrl': '第 {index} 步：navigate 需要在 args 里给 url',
    'script.stepNeedsWindow': '第 {index} 步：{action} 需要 window（id、标题或 @n）',
    'script.observeNeedsWindow': '第 {index} 步：observe 需要 window（id 或标题）',
    'script.observeBothFalse': '第 {index} 步：observe 的 screenshot 与 text 不能同时为 false',
    'script.waitWindowNeedsTitle': '第 {index} 步：wait_window 需要 title',
    'script.launchNeedsApp': '第 {index} 步：launch 需要 app',
    'script.needWindow': '需要一个 window（id、标题，或 @n 指向最近一次 windows 结果）',
    'script.waitTimeout': 'wait_window：{timeout}ms 内没有等到标题含 "{title}" 的窗口',

    'act.navigate': '→ {url}（tab {tabId}）',
    'act.tab': 'tab {tabId} {url}',
    'act.found': '{count} 处匹配：{names}',
    'act.clicked': '点击 {tag} {text}',
    'act.realClick': '真实鼠标点击（{result}）',
    'act.filled': '填入（{mode}）',
    'act.eval': '= {value}',
    'act.screenshot': '截图 {path}',
    'act.pdf': 'PDF {path}',
    'act.closedSession': '关闭 {count} 个标签',
    'act.closedTab': '关闭标签（{result}）',
    'act.scrolled': '滚动 → scrollY={y}',
    'act.waited': '条件满足（{ms}ms）',
    'act.waitTimeout': '等待超时（{ms}ms）',
    'act.network': '网络：{value}',
    'act.dialog': '对话框：{value}',
    'act.noDialog': '没有对话框',
    'act.read': '{title} {url}',

    'cu.clicked': '点击 {target}',
    'cu.typed': '输入 {count} 字符（进当前焦点）',
    'cu.pressed': '按键 {key}',
    'cu.scrolled': '滚动 dx={x} dy={y}（正=下/右）',
    'cu.setValue': 'set_value #{index}',
    'cu.dragged': '拖拽 {from} → {to}',
    'cu.dragPath': '拖拽路径 {count} 点',
    'cu.uia': 'UIA {action} #{index}',
    'cu.activated': '前置窗口',
    'cu.windows': '{count} 个窗口',
    'cu.windowsCapped': '{count} 个窗口（只列前 {shown} 个）',
    'cu.noWindows': '（没有匹配的窗口）',
    'cu.slept': '等待 {ms}ms',
    'cu.waitedWindow': '等到窗口 id={id}「{title}」',
    'cu.launched': '请求启动 {app}（随后可用 wait_window / windows 定位窗口）',
    'cu.observed': '观察「{title}」：{summary}',
    'cu.observeText': '{lines} 行文本',
    'cu.observeNoText': '无文本',
    'cu.observeShot': ' + 截图',
    'cu.observeNoShot': '（截图不可用）',
    'cu.captureDegraded': '截图失败已降级为纯文本：{reason}',
    'cu.callResult': '{method} → {value}',
    'cu.windowsHeader': '可观察/可控制的窗口：\n{lines}',
    'cu.windowsTruncated': '…（共 {total} 个，已截断）',
    'cu.captureRejected': '截图未被接收',
    'cu.noScreenshot': '该窗口没有返回截图',
    'cu.typeNote': '文字进了当前焦点，且覆盖了剪贴板；需要提交请再用 action=key 发 Enter。',
    'cu.activatedWindow': '已前置窗口：{window}',
    'cu.dispatched': '{action} 已派发到「{window}」：{detail}\n注意：派发成功不等于应用已接受 —— 重要结果请用 kimi_cu_observe 复核。',
    'cu.launchHint': '随后用 kimi_cu_windows 找到新窗口（可能延迟几秒）。',
    'cu.launchedRender': '已请求启动：{app}\n{hint}',
    'script.waitWindowTitleOnly': 'wait_window 需要 title（要等的窗口标题子串）',

    'guidance.header': 'Kimi 本地桥（跑在用户真实机器上）：',
    'guidance.browser': '浏览器：`kimi_browser_*` 通过 Kimi 扩展操作用户已登录的 Chrome。先用 `kimi_browser_read` 读页面（开头几行是页面状态），再用它返回的 `@e` ref 动作。click/fill 会回 `changed`：false 表示派发了但没生效，别盲目重试同一个元素。确认变化优先用 `kimi_browser_read {mode:"diff"}`，等异步渲染用 `kimi_browser_wait` 而不是自己轮询。原生弹窗会冻结页面：用 `kimi_browser_dialog` 放行。',
    'guidance.desktop': '桌面：`kimi_cu_*` 观察与操作真实 Windows 窗口。顺序是 `kimi_cu_windows` → `kimi_cu_observe` → 输入；输入返回成功只表示「已派发」，重要结果必须再 observe 一次复核。',
    'guidance.batch': '多个连续动作优先用 `kimi_browser_script` / `kimi_cu_script` 一次跑完（一步一轮推理很贵）；不确定页面/界面会变成什么样时拆成两段：先跑前半段，读到结果再跑后半段。',
    'guidance.onlyTools': '这两条桥只能通过上述工具使用；不要用 pwsh/curl 或 JS cell 绕过（那会打坏中文并绕过参数校验）。',
    'guidance.statusFirst': '连接/就绪类失败：先调一次 `kimi_status` 看诊断，不要重复同一个调用。',
    'guidance.desktopNeedsUnlocked': '桌面输入要求未锁屏的交互式桌面；运行时会拒绝终端窗口与 Win/Meta 组合键，不要绕过这些拒绝。',

    'status.summaryOk': '浏览器（WebBridge）：✓ 就绪；桌面（KimiCU）：✓ 就绪',
    'status.browserReady': '浏览器（WebBridge）：✓ 就绪',
    'status.browserNoExtension': '浏览器（WebBridge）：△ daemon 在、扩展未连',
    'status.browserDown': '浏览器（WebBridge）：✗ 不可用',
    'status.desktopReady': '桌面（KimiCU）：✓ 就绪',
    'status.desktopOff': '桌面（KimiCU）：— 已关闭',
    'status.desktopDown': '桌面（KimiCU）：✗ 不可用',
    'status.next': '下一步：{hint}',
    'status.join': '；',
    'status.unresolved': '（未解析）',
    'status.notFound': '（未找到）',
    'status.unknown': '（未知）',
    'status.browserLine': '- 浏览器：enabled={enabled} installed={installed} addr={addr} running={running} extensionConnected={extensionConnected}{daemonVersion}{extensionVersion}{error}',
    'status.desktopLine': '- 桌面：enabled={enabled} installed={installed} supported={supported} exe={exe} runtime={runtimeVersion} agentPid={agentPid} pipe={pipe}{permissions}{error}',
    'status.hintBrowserDown': '浏览器：daemon 连不上 → 先运行 "{binary} start"；若端口被占用，改 {addrFile} 并在扩展设置里同步连接地址。',
    'status.hintBrowserExtension': '浏览器：daemon 正常但扩展未连接 → 打开 Chrome 的 Kimi 扩展侧边栏，确认「本地 agent 远程控制」已开启且地址与 daemon 端口一致。',
    'status.hintCuMissing': '桌面：未安装 KimiCU 运行时 → 运行 https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd ，或在配置里用 kimicuExePath 指定 exe。',
    'status.hintCuAgent': '桌面：运行时在但 Agent 起不来 → 运行 "{exe} doctor" 看诊断。',
    'status.hintCuOld': '桌面：运行时版本过旧 → 用 setup_windows.cmd 升级。',
    'status.hintCuPlatform': '桌面：KimiCU 只有 Windows 版。',
    'status.hintCuOther': '桌面：{message}',

    'status.browserNotInstalled': '浏览器：这台机器还没装 Kimi 浏览器扩展。安装步骤（不需要 Kimi 账号）：1) 在 Chrome Web Store 或 Edge Add-ons 搜 "Kimi" 装扩展（也可用官网手动安装：{page}）；2) 打开扩展侧边栏 → 设置 → 「本地 Agent 远程控制」→ 点「去连接」；3) 把弹窗里给出的安装命令复制到终端执行（这会装上 ~/.kimi-webbridge 下的本地服务）。常见问题：{faq}',
    'status.desktopNotInstalled': '桌面：未安装 KimiCU 运行时。在终端下载并运行 {url}（仅 Windows），或在插件配置里用 kimicuExePath 指定现有 kimi-cu.exe。',
    'status.browserLabelNotInstalled': '浏览器（WebBridge）：未安装',
    'status.desktopLabelNotInstalled': '桌面（KimiCU）：未安装',

    'err.unsupportedPlatform': 'KimiCU 只支持 Windows；当前平台没有桌面控制能力。',
    'err.cuNotInstalled': '找不到 KimiCU 运行时（kimi-cu.exe）。已尝试：{candidates}。下一步：运行 https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd ，或在插件配置里用 kimicuExePath 指定现有 exe。',
    'err.runtimeTooOld': 'KimiCU 运行时版本过旧（{found} < {minimum}）；用 setup_windows.cmd 升级。',
    'err.agentStartFailed': '运行时在但 Agent 起不来：{reason}',
    'err.noCandidates': '（无候选路径）',

    'err.webbridgeDown': '连不上本地 daemon（{addr}）。先把它起起来："{binary} start"。若端口被别的程序占用，改 webbridgeAddr（或 ~/.kimi-webbridge/daemon.addr），并在扩展设置里同步同一个地址。',
    'err.webbridgeStartFailed': 'daemon 没能启动（{addr}）。{detail}下一步：手动运行 "{binary} start" 看输出里的端口与错误；若提示端口被占用，改 webbridgeAddr（或 ~/.kimi-webbridge/daemon.addr）后换一个空闲端口。帮助：{help}',
    'err.webbridgeStartDetail': '启动命令报错：{message}。',
    'err.portBusy': '{addr} 上的程序回了非 JSON（HTTP {status}），它不是 WebBridge daemon。改 webbridgeAddr（或 ~/.kimi-webbridge/daemon.addr）换一个空闲端口，并在扩展设置里同步同一个地址。',
    'err.webbridgeTimeout': '浏览器动作 "{action}" 在 {seconds} 秒内没有回应（{addr}）。daemon 可能卡住或页面脚本阻塞；先用 kimi_status 看连接态。',
    'err.webbridgeCallFailed': '浏览器动作 "{action}" 失败：{detail}',
    'err.badEnvelope': 'daemon 返回 HTTP {status}：{detail}',
    'err.extensionOffline': '本地 daemon 正常，但浏览器扩展没连上：{detail}。打开 Chrome 的 Kimi 扩展侧边栏（设置 → 本地 agent 远程控制），确认连接地址与 daemon 端口一致；若版本过旧请更新：{help}',
    'err.versionMismatch': '浏览器扩展版本比本地桥期望的旧：{detail}。更新扩展后重试（不需要重启 daemon）：{help}',
    'err.urlRequired': 'url 不能为空',
    'err.helpWebbridge': 'https://www.kimi.com/products/kimi-browser-extension',
    'err.helpWebbridgeFaq': 'https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-faq',
    'err.helpCuSetup': 'https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd',
    'err.unknownError': '未知错误',
    'err.selectorRequired': 'selector 不能为空：传 CSS 选择器（如 "#submit"）或 aria 里的 ref（如 @e12）',
    'err.findNeedsQuery': 'mode=find 需要 query（搜索词）',
    'err.frameNeedsHandle': 'mode=frame 需要 frame（例如 #f1）；先用 mode=read 看 frames 列表',
    'err.attachNeedsTabId': 'action=attach 需要 tab_id（整数）；先用 action=list_all 找到它',
    'err.timeout': '操作在 {ms}ms 内没有完成。',
    'err.aborted': '操作已被取消。',

    // ---- 页面状态探针（lib/browser-state.mjs）----
    'meta.line': '页面：{title} — {url}',
    'meta.state': '状态：ready={ready} 滚动={scrollY}/{scrollH} 节点={nodes} 焦点={focus}',
    'meta.counts': '元素：{links} 链接 / {buttons} 按钮 / {inputs} 输入框 / {forms} 表单 / {frames} iframe',
    'meta.focusNone': '（无）',
    'meta.focusSelection': ' 已选中 "{text}"',

    // ---- 动作生效校验 ----
    'verify.changed': '页面已变化：{detail}',
    'verify.unchanged': '已派发，但 {ms}ms 内页面没有任何变化 —— 可能没生效。重新读一遍页面，确认点的是不是目标元素。',
    'verify.skipped': '跳过变化校验：{reason}',
    'verify.url': 'url → {url}',
    'verify.title': '标题 → {title}',
    'verify.nodes': 'DOM {nodes} 个节点',
    'verify.scroll': '滚动 {scrollY}/{scrollH}',
    'verify.ready': 'readyState {ready}',
    'verify.dialogBlocked': '页面被 JavaScript 弹窗阻塞了：先用 kimi_browser_dialog（status / accept / dismiss）处理，再做别的。弹窗：{message}',
    'verify.staleRetried': 'ref 已过期；重新读取页面后重试了一次（{detail}）',
    'verify.staleHint': '重新读取后仍然失败 —— 这个 ref 已经不存在。请从下面的新快照里挑新的 ref。',
    'verify.freshFail': '原动作失败：{detail}',

    // ---- 快照 diff ----
    'diff.header': '相对上一次读取的变化：',
    'diff.none': '相对上一次读取没有变化',
    'diff.truncated': '…diff 已截断（共 {total} 行变化）',

    // ---- wait ----
    'err.waitNeedsCondition': 'wait 至少要给一个条件：text / text_gone / selector / url / ready / ms',
    'wait.done': '等待 {ms}ms 完成；{detail}',
    'wait.timeout': '{ms}ms 内条件未满足（{detail}）',
    'wait.matchedText': '文本出现了："{text}"',
    'wait.goneText': '文本消失了："{text}"',
    'wait.matchedSelector': '选择器出现了：{selector}',
    'wait.urlMatched': 'url 匹配：{url}',
    'wait.readyMatched': 'readyState = {ready}',

    // ---- evaluate ----
    'err.evalNeedsCode': 'code 不能为空',
    'eval.result': '结果：{value}',
    'eval.truncated': '…结果已截断到 {chars} 字符',
    'eval.failed': 'evaluate 失败：{detail}',

    // ---- act ----
    'err.actUnknownVerb': '未知动作 "{verb}"；可用：{available}',
    'err.actNeedsSelector': '动作 "{verb}" 需要 selector（CSS 或 @eNNN ref）',
    'err.actNeedsValue': '动作 "{verb}" 需要 value',
    'err.actNeedsKeys': '动作 "{verb}" 需要 keys（例如 "Enter"、"Mod+A"、"Shift+Tab"）',
    'err.actNeedsFiles': '动作 "{verb}" 需要 files（绝对路径）或 attachments',
        'act.realKey': '已通过 CDP 发送真实的 {keys} 按键事件',
    'submit.cdpEnter': '已通过 CDP 发送真实回车事件完成提交（扩展本身产生不了键盘事件）',
'act.done': '{verb} 完成：{detail}',

    // ---- dialog ----
    'err.dialogNeedsAction': 'action 必须是 status / accept / dismiss',
    'dialog.none': '当前没有 JavaScript 弹窗',
    'dialog.open': '弹窗：{type} "{message}" —— 需要 accept 或 dismiss',
    'dialog.handled': '弹窗 {action}：{detail}',


    'err.windowNoMatch': '没有标题匹配 "{value}" 的窗口。当前窗口：{candidates}。先用 kimi_cu_windows 看清单。',
    'err.windowAmbiguous': '"{value}" 匹配到 {count} 个窗口：{candidates}。请传数字 id 指定一个。',
    'err.windowNotFound': '窗口 id={id} 已经不在了。',
    'err.windowNeedsIdOrTitle': 'window 必须是 id、标题或 @n',
    'err.cuBusy': '另一个会话正持有真实桌面输入。停止发输入，只读观察通常仍可用，不要杀别的会话。',
    'err.cuTool': 'KimiCU {code} {message}',

    'err.actionRequired': 'action 是必填项',
    'err.unknownAction': '未知 action "{action}"；可用：{available}',
    'err.clickTarget': 'click 需要 element_index 或 x/y 之一',
    'err.clickBoth': 'element_index 与 x/y 只能给一个',
    'err.clickXY': '必须同时给 x 和 y',
    'err.secondaryNeedsIndex': 'secondary 需要 element_index',
    'err.dragNeedsCoords': 'drag 需要 from_x/from_y 和 to_x/to_y',
    'err.dragPathNeedsPoints': 'drag_path 至少需要 2 个点',
    'err.scrollNeedsDelta': 'scroll 需要 scroll_x 或 scroll_y',
    'err.typeNeedsText': 'type 需要 text',
    'err.keyNeedsChord': 'key 需要组合键，如 "Control_L+a"',
    'err.setValueNeedsIndex': 'set_value 需要 element_index 和 value',
    'err.tooManyPoints': 'drag_path 最多 {max} 个点',
    'err.valueTooLong': '{field} 太长（{length} > {max}）',
    'err.selectorRequired': 'selector 不能为空：传 CSS 选择器（如 "#submit"）或 aria 里的 ref（如 @e12）',
    'err.findNeedsQuery': 'mode=find 需要 query（搜索词）',
    'err.frameNeedsHandle': 'mode=frame 需要 frame（例如 #f1）；先用 mode=read 看 frames 列表',
    'err.attachNeedsTabId': 'action=attach 需要 tab_id（整数）；先用 action=list_all 找到它',
    'err.scrollNeedsPoint': 'scroll 需要截图坐标 x/y（在窗口内哪个位置滚动）',
    'err.setValueNeedsValue': 'set_value 需要 value（字符串）',
    'err.dragMissingField': 'drag 需要 {field}',
    'err.pointShape': 'drag_path 的每个点必须是 [x, y] 两个整数',
    'err.secondaryNeedsUia': 'secondary 需要 uia_action（invoke / toggle / expand / collapse / select / scroll_into_view）',
    'err.observeBothFalse': 'screenshot 与 text 不能同时为 false：至少要读一样东西',
    'err.appRequired': 'app 不能为空',
    'err.cuStepNeedsWindow': '{action} 需要 window（id 或标题）',

    'err.frameTooLarge': '请求帧 {size} 字节，超过上限 {max}',
    'err.pipeTimeout': '{ms}ms 内没有收到帧',
    'err.cuTimeout': '等待 KimiCU Agent 响应超时（{ms}ms）',
    'err.cuAborted': 'KimiCU 请求已取消',
    'err.cuClosedEarly': 'KimiCU Agent 在返回完整帧之前关闭了连接',
    'err.cuNotObject': 'KimiCU Agent 返回了非对象响应',
    'err.cuIdMismatch': '响应 id 不匹配：期望 {expected}，收到 {actual}',
    'err.cuRequestFailed': 'KimiCU Agent 请求失败',
    'err.trailingData': '响应帧之后又收到数据',
    'err.trailingBytes': '单次请求的连接返回了尾随字节',
    'err.badFrameLength': '响应帧长度 {length} 非法',
    'err.badJson': '响应不是合法 JSON：{detail}',
    'err.agentNoPid': 'start-agent 没有报告运行中的 Agent（stdout: {stdout}）',
    'err.noVersion': 'KimiCU Agent 没有报告合法版本（收到 "{found}"），请升级运行时。',
    'err.agentStartFailed': 'KimiCU 运行时已安装，但 Agent 启动失败：{reason} 下一步：在终端运行 "{exe} doctor" 看诊断；必要时运行 "{exe} start-agent" 手动拉起。',
    'err.noArgs': '（无参数）',
    'err.unsupportedPlatformShort': 'KimiCU 只支持 Windows',
    'err.methodUnknown': '未知 KimiCU 方法 "{method}"；可用：{available}',
    'err.methodArgs': 'KimiCU 方法 "{method}" 不接受参数 "{field}"（它接受：{allowed}）',
    'err.windowEmpty': 'window 不能为空；可用窗口：{candidates}',
    'err.leaseMismatch': 'KimiCU 租约异常：{detail} 这通常意味着 Agent 刚重启过；重试一次即可，若持续失败请运行 "kimi-cu.exe doctor"。',

    'skill.whenToUse.browser': '需要操作用户浏览器、抓网页、填表单、截图时',
    'skill.whenToUse.desktop': '需要操作 Windows 桌面应用、点击输入、看窗口时',

    'log.loaded': 'v{version} 加载：browser={browser} desktop={desktop} lang={lang}',
    'log.tools': '已注册 {count} 个工具',
    'log.skills': '已注册 {count} 个 runtime skill',
    'log.skillFailed': '注册 skill "{name}" 失败：{reason}',
    'log.agentSkillFailed': '为 agent 注册 skill 失败：{reason}',
    'log.disabledTools': '按配置停用工具：{names}',
    'log.unknownDisabledTool': 'disabledTools 里有未知工具 "{name}"（可用：{available}）',

    'img.noRoute': '当前模型路由无法解析',
    'img.noLlm': '未挂载 llm 服务',
    'img.modelNoImage': '模型 "{model}" 未声明支持图片输入',
    'img.probeFailed': '无法确认图片能力：{detail}',
    'img.noAttachments': '未挂载 attachment 服务',
    'img.routeNoImage': '当前路由不支持图片',
    'img.rejected': '图片未被接收：{detail}',
    'img.noPath': '截图未返回文件路径',
    'img.unreadable': '截图文件读不到：{detail}',
    'img.badFormat': '截图不是可识别的图片格式',
    'img.badDataUrl': '截图不是标准 base64 data URL',
    'img.empty': '截图内容为空',
  },
}

/** 供测试使用：拿到某个语言的完整键集合。 */
export function catalogKeys(language) {
  return Object.keys(CATALOG[language] ?? {})
}

/** 供测试使用：拿到某个键在某个语言的原文。 */
export function catalogValue(language, key) {
  return CATALOG[language]?.[key]
}

/**
 * 参数替换：`{name}` → params.name。缺失参数保留占位符原样，便于发现漏传。
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 */
function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.hasOwn(params, name)) return match
    const value = params[name]
    return value === undefined || value === null ? '' : String(value)
  })
}

/**
 * 建一个 translator。
 * @param {'en' | 'zh'} language
 * @returns {(key: string, params?: Record<string, unknown>) => string}
 */
export function createTranslator(language) {
  const primary = CATALOG[language] ?? CATALOG.en
  const fallback = language === 'en' ? null : CATALOG.en
  return function t(key, params) {
    const template = Object.hasOwn(primary, key) ? primary[key] : fallback && Object.hasOwn(fallback, key) ? fallback[key] : undefined
    if (template === undefined) {
      if (process.env.KIMI_I18N_DEBUG) console.warn(`[i18n] missing key: ${key} (${language})`)
      return key
    }
    return interpolate(template, params)
  }
}

// ---------------------------------------------------------------------------
// 模块级当前语言
// ---------------------------------------------------------------------------
// 语言是「插件级」设置而不是「会话级」：一个 Host 进程只装一份插件，激活时
// 由 config.language 决定一次即可。这样每个模块直接 import { t } 就够了，
// 不必把 translator 顺着调用链一路传（那会让所有函数签名都多一个参数）。
// ---------------------------------------------------------------------------

/** @type {'en' | 'zh'} */
let currentLanguage = 'en'
/** @type {ReturnType<typeof createTranslator>} */
let currentTranslator = createTranslator('en')

/**
 * 设置当前语言（插件激活、或测试里切换）。
 * @param {'en' | 'zh'} language
 */
export function setLanguage(language) {
  const next = language === 'zh' ? 'zh' : 'en'
  if (next === currentLanguage) return next
  currentLanguage = next
  currentTranslator = createTranslator(next)
  return next
}

/** 当前语言。 */
export function getLanguage() {
  return currentLanguage
}

/**
 * 按配置初始化语言。返回生效的语言，便于日志。
 * @param {{language?: string}} config
 * @param {Record<string, string | undefined>} [env]
 */
export function configureI18n(config, env = process.env) {
  return setLanguage(resolveLanguage(config?.language ?? 'auto', env))
}

/**
 * 翻译当前语言的一条文案。
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
export function t(key, params) {
  return currentTranslator(key, params)
}

