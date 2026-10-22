# KimiCU desktop API reference (Windows)

A local native agent on pipe `\\.\pipe\kimi-cu-win-<username>`, shipped as
`%LOCALAPPDATA%\Kimi Computer Use\kimi-cu.exe`. This plugin reaches it through the `kimi_cu_*`
tools — you do **not** need the node-repl `js` cell and you do **not** need `import("@kimi/cu")`.

## Protocol at a glance (for troubleshooting)

- Frame: 8-byte little-endian uint64 length + UTF-8 JSON
- Request: `{id, session_id, method, params, telemetry_tool?, lifecycle?}`
- Response: `{id, ok, result?, error_code?, error?}`
- Methods:
  - `__agent_ping` → `{version, pid, permissions:{elevated,integrity,ui_access}, ok}`
  - `__lifecycle_v1 {action:"begin"|"end", nonce}` — **begin and end must share one connection, one
    session_id and one nonce**
  - `__computer_use_call_v1 {method, arguments}` plus `lifecycle:{nonce}`
- Calling without an active lease answers `Agent lifecycle lease is not active`.

The plugin's `withLease()` runs begin → N calls → end per tool call (released in `finally`) and is
serialized process-wide, so two input streams never fight over the real mouse and keyboard.

## Methods

| method | arguments | returns |
|---|---|---|
| `open_panel` | — | `{opened, runtime_version, administrator_mode_supported}` |
| `list_windows` | — | `[{app, id, title}]` |
| `get_window` | `{id, app?}` | `{app, id, title}` |
| `list_apps` | — | `[{displayName, id, isRunning, windows:[...]}]` (apps that have windows) |
| `list_available_apps` | — | `[{displayName, appId}]` (all StartApps entries, running or not) |
| `launch_app` | `{app}` | `undefined` (launching is dispatched; a window is not guaranteed) |
| `get_window_state` | `{window, include_screenshot?, include_text?}` | `WindowState` (below) |
| `click` | `{window, element_index}` or `{window, screenshotId, x, y}` plus `mouse_button?`, `click_count?`, `timing?` | `undefined` |
| `press_key` | `{window, key}` | `undefined` |
| `type_text` | `{window, text}` | `undefined` (goes to the **current focus**; overwrites the clipboard) |
| `scroll` | `{window, screenshotId?, x, y, scrollX, scrollY}` | `undefined` |
| `set_value` | `{window, element_index, value}` | `undefined` (needs a real UIA Value/RangeValue) |
| `drag` | `{window, screenshotId?, from_x, from_y, to_x, to_y, timing?}` | `undefined` |
| `drag_path` | `{window, screenshotId?, points:[[x,y],...], timing?}` | `undefined` (2–1024 points) |
| `perform_secondary_action` | `{window, element_index, action}` | `undefined` (`invoke`/`toggle`/`expand`/`collapse`/`select`/`scroll_into_view`) |
| `activate_window` | `{window}` | `undefined` |

## WindowState

```ts
{
  window: {app, id, title}
  accessibility: { tree: string, focused_element?: string, selected_elements?: string[], document_text?: string } | null
  screenshots: [{ id, width, height, zIndex, url }]   // url is data:image/png;base64,...
  coordinate_space: {
    kind: "screenshot_pixels", origin: "top_left",
    image_width, image_height,
    window_rect: {left, top, right, bottom, width, height},
    input_revision
  }
  accessibility_status?: {status:"timeout", reason, timeout_ms, retryable, next_step}
}
```

- `tree` is **one string**, one line per element: `[12] 按钮 name="Save" class="Button" rect=10,20 80x24`.
  Filtering keeps the original lines; a line's position in the filtered output is **not** its
  `element_index`.
- `include_screenshot:false` makes `screenshots` empty; `include_text:false` makes `accessibility`
  `null`; both false is rejected.
- Screenshot coordinates are **window screenshot pixels**, origin top-left — not screen coordinates
  and not CSS pixels. Re-observe after the window geometry changes.

## Choosing a target

```js
// by accessibility index (real mouse input, not a UIA Invoke)
await kimiCU.click({ window, element_index: 12 })
// or by screenshot coordinates
await kimiCU.click({ window, screenshotId: state.screenshots[0].id, x: 120, y: 340 })
```

`element_index` and `x/y` **cannot be mixed**. `kimi_cu_act` rejects the mix before sending anything.

## Keyboard

- `press_key` takes the singular field `key`, e.g. `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`,
  `Control_L+a`, `Control_L+v`, `Shift_L+Tab`, `F5`, `PageDown`, `Insert`, arrow keys.
- Named punctuation: `equal`, `minus`, `comma`, `period`, `semicolon`, `slash`, `backslash`,
  `grave`, `bracketleft`, `bracketright`, `apostrophe`.
- Physical-key semantics: Shift is **not** implied; `Shift_L+equal` is what produces `+`.
- `type_text` neither focuses, clears nor submits — click into the field, confirm the focus, type,
  then send `Enter` with `key`.

## Scroll and drag

- `scrollY > 0` scrolls **down**, `< 0` up; `scrollX > 0` scrolls right. **This is the opposite of
  the old MCP `dy`.**
- `drag` is one straight-line drag (10 interpolated points internally); there is no `steps` option.
- `drag_path` is one continuous left-button gesture (2–1024 integer points, at least two distinct).
- Multi-stroke drawing is "await several `drag_path` calls in order", not one array.

## Input timing (optional)

| field (ms) | click default | drag/path default | range |
|---|---|---|---|
| `move_settle_ms` | 40 | 0 | 0–1000 |
| `press_ms` | 25 | 12 | 0–1000 |
| `step_ms` | not accepted | 8 | 0–100 |
| `after_ms` | 60 | 12 | 0–1000 |

Do not touch these without measurement; `0` only skips waiting, it does not make the app keep up.

## Errors and recovery

| symptom | meaning | handling |
|---|---|---|
| `computer_use_busy` | another session holds real input | stop sending input; read-only observation usually still works; **do not kill the other session** |
| failure carrying `permission_context` | permission evidence (integrity/elevation/ui_access) | `open_panel()` and let the user elevate or enable admin mode and confirm UAC; **do not auto-retry** |
| `Agent lifecycle lease is not active` / `... does not match its begin` | lease anomaly (e.g. the agent just restarted) | retry once; if it persists run `kimi-cu.exe doctor` |
| the same `Agent lifecycle ...` error repeatedly | stale pipe | `kimi-cu.exe start-agent` is idempotent, re-run it |
| window occluded | the result names the blocking window | within what the user allows, move or close it, then observe again |
| window minimised | — | `activate_window` first, then observe |
| lock screen / secure desktop | — | ask the user to unlock; do **not** retry in a loop |

## Runtime boundaries

- Desktop/taskbar shell windows are excluded (`Progman`, `WorkerW`, `Shell_TrayWnd`, …); ordinary
  Explorer windows are still supported.
- Input to terminal windows (cmd / PowerShell / Windows Terminal / OpenCode) is **refused**.
- Windows/Meta/Super chords are **refused**.
- An unlocked interactive desktop is required.
- Do not bypass KimiCU with shell/OS automation, and do not infer "may send/delete" from
  "may observe".
