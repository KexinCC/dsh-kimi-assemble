# Kimi browser extension (WebBridge) — action reference

Daemon address: `http://127.0.0.1:10086` (the default; the real address lives in
`~/.kimi-webbridge/daemon.addr`). This plugin passes actions through
`kimi_browser_script { action, args, session }`; `args` is the argument object of each action below.

> **Do not call this daemon with curl/pwsh.** Inline JSON through a shell corrupts non-ASCII text on
> Windows (measured: the body arrives BOM-mangled and the daemon answers `invalid JSON`).
> `kimi_browser_script` sends UTF-8 from inside the Node process, so it does not have that problem.

## Sessions and tab groups

- Use one `session` per task (the tools derive `dsh-<id>` from the agent by default). Tabs opened in
  one session join one tab group.
- `navigate`'s `group_title` is the user-visible group name; it defaults to the plugin's
  `browserGroupTitle`.
- Closing is the user's call: only call `close_session` when the user explicitly asks to close
  those tabs.

## Open and locate

| action | arguments | returns | notes |
|---|---|---|---|
| `navigate` | `url*`, `newTab`(bool), `group_title` | `{success,url,tabId}` | first call opens a tab; `newTab:false` navigates the current tab |
| `find_tab` | `url`, `active`(bool) | `{success,url,tabId,borrowed}` | matches by host among tabs this session opened; `active:true` borrows the tab the user is viewing |
| `list_tabs` | — | `{success,tabs:[{tabId,url,title,active,groupTitle}]}` | this session's tabs |
| `list_browser_tabs` | — | `{success,tabs:[{tabId,windowId,url,title,active}]}` | every tab the extension can see, across windows |
| `attach_tab` | `tabId*` | `{success,tabId,url,title,borrowed}` | attach to an existing tab without stealing focus |
| `activate_tab` | `tabId?` | `{success,tabId,windowId,active}` | bring the tab to the front |
| `close_tab` | — | `{success,closed}` | close the current tab |
| `close_session` | — | `{success,closed:int}` | close the tabs this session opened (borrowed ones stay) |
| `go_back` / `go_forward` / `reload` | — | `{success,tabId,reason?}` | `reason:"no_history_entry"` means there is no entry |

## Read

| action | arguments | returns | notes |
|---|---|---|---|
| `snapshot` | `ref?`, `format:"aria"?`, `max_chars`(1–60000)?, `cursor`? | default `{url,title,tree}`; aria `{url,title,tree_text,truncated,next_cursor}` | the accessibility tree. The default is a node array; `format:"aria"` is text carrying `[ref=eNNN]` |
| `find` | `query*` | `{url,title,query,totalMatches,matches:[{role,matchedField,path,...}]}` | search the whole main-document tree |
| `read_page` | `frame?` | `{text,...}` | read an embedded document; the `frame` handle comes from the snapshot's `frames` list (e.g. `#f1`) |
| `evaluate` | `code*` | `{type,value}` | evaluate page JS. The realm is shared, so a repeated `const` collides — wrap it in an IIFE |
| `inspect_region` | `selector*`/ref | `{version,coordinate_space,candidates:[{ref,depth,has_layout,label,rect}]}` | candidate elements of one region |
| `highlight_region` | `selector*`/ref | `{version,highlight_id,duration_ms,...}` | highlight on the page (visible to the user) |
| `clear_highlight` | `highlight_id*` | — | clear a highlight |

## Act

| action | arguments | notes |
|---|---|---|
| `click` | `selector*` (CSS or `@e` ref) | DOM-level `el.click()`, returns `{success,tag,text}` |
| `mouse_click` | `selector*` | real mouse events through CDP; fails when the element has no layout box |
| `fill` | `selector*`, `value*` | overwriting input; supports `<input>/<textarea>/[contenteditable]` (ProseMirror and friends) |
| `key_type` | `text*`, `selector?` | type character by character as keyboard events |
| `send_keys` | `keys*` | chords such as `Enter`, `Mod+A`, `Shift+Tab`, `Enter Escape` |
| `hover` | `selector*` | hover |
| `select_option` | `selector*`, `value?`/`label?` | `<select>` options |
| `set_checked` | `selector*` (or `target`), `checked`(bool) | check/uncheck |
| `drag` | `from*`, `to*` | returns `dispatched` but does **not** guarantee an effect |
| `scroll` | `selector?`, `dy?`, `dx?` | with no arguments scrolls one screen; with `selector` scrolls that element into view |
| `upload` | `selector*`, `files*` or `attachments*` | needs the extension's "allow access to file URLs" permission |
| `dialog` | `action` = `status`/`accept`/`dismiss` | handle JS dialogs |
| `wait` | one of `text` / `text_gone` / `selector` / `frame:"any"`, plus `timeout_ms?` | wait for a condition; no condition is an error |
| `network` | `cmd` = `start`/`stop`/`list`/`detail`, `filter?`, `requestId?` | capture traffic; call `detail` before `stop` |
| `cdp` | `method*`, `params?` | raw Chrome DevTools Protocol passthrough |
| `screenshot` | `format`(png/jpeg), `quality`(0-100), `selector?`, `path?`, `full_page?` | returns a file path, not base64 |
| `save_as_pdf` | `paper_format`(letter/a4/legal/a3/tabloid), `landscape`, `scale`(0.1–2), `print_background`, `path?` | renders the current page to PDF and returns the path |

## Keyboard events: raw actions are not real, `act press` is

Measured on daemon v2.0.26 / extension 2.0.24:

- `send_keys` and `key_type` do **not** produce DOM keydown events (a capture-phase listener never
  fires; `key_type` only inserts text into the focused field). So nothing that depends on a browser
  default action happens — implicit form submission by Enter being the important case.
- The daemon's `cdp` passthrough **can** produce real, trusted key events via
  `Input.dispatchKeyEvent` (rawKeyDown → char → keyUp). Measured: Enter submitted a real form.
- It only works after `Page.bringToFront`. Without it the key event is dropped, because input goes
  to the active target. The extension implements that as focus emulation — it does not steal the
  user's foreground window.

This plugin therefore sends single keys through CDP:

| Situation | What happens |
| --- | --- |
| `kimi_browser_act {verb:"press", keys:"Enter", selector:"#q"}` | focuses the selector, bringToFront, then a real key event |
| `kimi_browser_act {verb:"press", keys:"Mod+A"}` | chords are not synthesised; it falls back to `send_keys` and reports `realKey:false` |
| `kimi_browser_fill {submit:true}` | clicks the submit button, then `requestSubmit()`, then a **real** Enter, then a plain Enter |

Supported single keys: Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown.

## Known limits

- **iframes**: `snapshot`/`click`/`fill`/`evaluate` only see the top-level document. Take the handle
  from the snapshot's `frames` and call `read_page {frame}` for embedded documents. Elements
  **inside** an iframe cannot be operated directly.
- **Sites that strictly verify `isTrusted`** (banking, CAPTCHA): `click`/`fill` are synthetic events
  and will not take effect — tell the user to act manually.
- **Refs expire**: re-`snapshot` after navigation, large DOM changes or a reconnect.
- **Screenshot/PDF paths are chosen by the daemon** and land in the OS temp directory; this plugin
  turns a screenshot into an image block in the conversation.
- When the extension is behind, the daemon answers `Please update the Kimi Browser Extension`; this
  plugin maps that to `KIMI_WEBRIDGE_VERSION` and attaches the upgrade link.
