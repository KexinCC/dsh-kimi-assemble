# dsh-kimi-assemble

Native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) tools for two Kimi
bridges that run on your own machine:

| Capability | Backend | Tools |
|---|---|---|
| Drive your **real, logged-in browser** | Kimi browser extension daemon (WebBridge, `127.0.0.1:10086`) | `kimi_browser_*` |
| Observe and operate **real Windows windows** | KimiCU native agent (`\\.\pipe\kimi-cu-win-<user>`) | `kimi_cu_*` |
| Diagnose both | — | `kimi_status` |

Once installed the model does not need to read a skill, shell out to `curl`, or write a
node-repl `js` cell — it calls tools. UTF-8 survives end to end, a bad argument names the exact
field, and a connection failure comes with the next step.

[中文文档](README.zh.md)

---

## Install

### Read this first: what you must already have

This plugin is a **bridge**, not a bundled implementation. It drives two Kimi components that live
on your machine; without them the tools answer `KIMI_WEBRIDGE_DOWN` / `KIMI_CU_NOT_INSTALLED` on
every call — with install instructions attached, because a plugin must not download and execute
remote installers by itself.

| You want… | You need | How to get it |
|---|---|---|
| browser control | Chrome or Edge + the **Kimi browser extension**. The local-Agent path needs **no Kimi account** (only the sidebar does). | 1) install the "Kimi" extension from the Chrome Web Store or Edge Add-ons (or the [manual install](https://www.kimi.com/products/kimi-browser-extension)); 2) open the extension sidebar → Settings → “本地 Agent 远程控制” → click **去连接 / Connect**; 3) copy the install command shown in that dialog into a terminal and run it — this installs the local daemon under `~/.kimi-webbridge`. [FAQ](https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-faq) |
| desktop control | Windows + the **KimiCU runtime** (`kimi-cu.exe`) | download and run [setup_windows.cmd](https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd) in a terminal, or set `kimicuExePath` in the config to an existing copy |
| either | DeepSeek Harness `>= 0.2.0` (verified on `0.2.1-rc.2`), Node `>= 22` | — |

Only want the browser half? Set `kimicuEnabled: false` — the five `kimi_cu_*` tools then never
register, on any OS.

A fresh machine is wired once `kimi_status` reports both bridges as installed; after that the
plugin discovers, starts and reconnects to both components automatically (including clearing a
stale daemon pid file left by an unclean shutdown).

**Install from npm (simplest):**

```text
plugin_manager install_bundle  target=dsh-kimi-assemble@1.1.0
```

**Or from the plugin market:** add this index URL under Discover → index sources, then install
the plugin from there:

```text
https://raw.githubusercontent.com/KexinCC/dsh-kimi-assemble/main/market/index.json
```

**Or clone and install the checkout directly** (no registry involved):

```bash
git clone https://github.com/KexinCC/dsh-kimi-assemble.git
```

```text
plugin_manager install_bundle  target=<absolute path to that clone>
```

Either way, `cordis_inspect_query(Tool.listTools)` should then list 13 `kimi_*` tools.

**Coming from the old KimiCU MCP?** Disable that row. It exposes
`mcp__kimicu__js` / `js_reset` / `js_add_node_module_dir`; this plugin covers all 16 KimiCU
methods, so keeping both only adds a second path competing for real desktop input:

```yaml
# in <profile>/cordis.patch.yml, on the existing mcp-kimicu row:
- id: mcp-kimicu
  name: "@deepseek-ai/dsh-mcp-client"
  config: { ... }          # keep the existing config
  disabled: true
```

## Configure

`config` is **replaced wholesale** (loader semantics, not a deep merge). Write only the keys you
want to change; everything else falls back to the defaults.

| Key | Default | Meaning |
|---|---|---|
| `webbridgeEnabled` | `true` | when false, no browser tools are registered |
| `webbridgeAddr` | `''` | empty = read `~/.kimi-webbridge/daemon.addr`, else `127.0.0.1:10086` |
| `webbridgeAutoStart` | `true` | start the daemon idempotently when it is unreachable |
| `webbridgeTimeoutMs` | `60000` | per browser action |
| `browserGroupTitle` | `DSH` | default tab group title, visible in the user's browser |
| `browserReadMaxChars` | `20000` | default `kimi_browser_read` budget |
| `browserVerify` | `auto` | `auto` = verify that each action changed the page; `off` = fire-and-forget (rollback switch) |
| `browserVerifyMs` | `600` | how long to watch for a change before reporting "unchanged" (100–10000) |
| `browserReadIncludeMeta` | `true` | attach the page-state line (url / load / scroll / focus / counts) to reads |
| `kimicuEnabled` | `true` | when false, no desktop tools are registered |
| `kimicuExePath` | `''` | empty = `KIMI_CU_WINDOWS_EXE` → `KIMI_CU_WINDOWS_HOME` → `%LOCALAPPDATA%\Kimi Computer Use\kimi-cu.exe` → legacy `KimiCU` directory |
| `kimicuAutoStart` | `true` | start the agent idempotently when it is unreachable |
| `kimicuTimeoutMs` | `120000` | per desktop call |
| `cuMaxTreeChars` | `12000` | default accessibility-tree truncation |
| `promptSection` | `true` | contribute the system-prompt section |
| `registerSkills` | `true` | register the `kimi-webbridge` / `kimi-cu` runtime skills (they shadow the older curl/`js`-cell skills) |
| `language` | `"auto"` | `auto` → Chinese when the system locale is `zh*`, else English; `en` / `zh` force one |
| `disabledTools` | `[]` | tool names to drop (e.g. `["kimi_cu_launch"]`) |

Tool **descriptions** are always English — they are part of the model-facing tool catalog.
`language` controls the text a human sees: error messages, tool output, the prompt section and
the skill bodies.

---

## Tools

### Diagnosis

- **`kimi_status {deep?}`** — the live state of both bridges (daemon address/version/extension
  connection, CU exe/version/agent pid/pipe/permissions) plus `hints[]` with the concrete next
  step. **First stop after any connection failure.**

### Browser

- **`kimi_browser_open {url, new_tab=true, wait_until=load|domcontentloaded|none, group_title?, session?}`**
  → final URL / title / tabId / page state. Waits for load by default so the next action does not race the page.
- **`kimi_browser_read {mode=read|find|frame|diff, include_meta?, include_screenshot?, ref?, max_chars?, cursor?}`**
  → accessibility tree text (with `[ref=eNNN]`), a page-state line (url / load state / scroll / focused
  element / element counts), search hits, iframe text, or **only what changed since the previous read**
  (`mode=diff`, typically ~4% of the full payload).
- **`kimi_browser_click {selector, verify?, session?}`** — CSS or `@eNNN` / `eNNN` / `[ref=eNNN]`.
  Reports `changed` / `changeDetail`; a stale ref is re-read and retried once.
- **`kimi_browser_fill {selector, value, submit=false, verify?, session?}`** — reports whether a
  → `submit=true` commits for you: it clicks the form submit button (falling back to `requestSubmit()`, Esc + click, then Enter) and reports `submitStrategy`. This extension **cannot produce real key events**, so implicit Enter-to-submit never happens.
  `submit=true` Enter actually changed the page (suggestion dropdowns swallow it).
- **`kimi_browser_act {verb, ...}`** — `press`, `type`, `clear`, `select`, `check`, `uncheck`, `hover`,
  `scroll`, `drag`, `mouse_click`, `upload`, each verified, with optional `wait_for`.
- **`kimi_browser_wait {text|text_gone|selector|url|ready|ms, timeout_ms?}`** — wait for a condition
  instead of re-reading in a loop; on timeout it returns the current page state.
- **`kimi_browser_eval {code, max_chars?}`** — evaluate page JS, JSON result.
- **`kimi_browser_dialog {action=status|accept|dismiss, text?}`** — native dialogs freeze the page;
  click/fill/act report `dialogOpen` instead of failing, and this answers them.
- **`kimi_browser_screenshot {selector?, full_page=false, format=png|jpeg, quality?, session?}`** →
  an image block (a path when the model route has no image input)
- **`kimi_browser_tabs {action=list|list_all|attach|close|close_session, tab_id?}`**
- **`kimi_browser_script`** — **two shapes**:
  - single step (escape hatch): `{action, args, session?}`, covering all 35 daemon actions
    (network / upload / pdf / cdp / highlight …)
  - batch: `{steps:[{action,args,capture?}], stop_on_error?, max_result_chars?}` — 1–25 steps in
    one call
  - argument table: [`references/browser-actions.md`](references/browser-actions.md)

### Why actions are verified

Every mutating browser tool reports whether the page actually changed. The extension's click is a
DOM-level dispatch: it returns success even when nothing happens, which used to make a wrong click
look identical to a right one. `browserVerify: 'off'` restores the old fire-and-forget behaviour.
Measured effect (6 fixtures × 5 runs, see [`bench/RESULTS.md`](https://github.com/KexinCC/dsh-kimi-assemble/blob/main/bench/RESULTS.md)): silent failures
10 → 0, task success 37% → 100%, at the cost of ~600ms on actions that genuinely do nothing.

### Desktop

- **`kimi_cu_windows {filter?, limit?}`** → `[{id, title, app}]`
- **`kimi_cu_observe {window, screenshot=true, text=true, filter?, max_chars?}`** →
  accessibility tree (with `[index]`) + focus + screenshot image block + `coordinate_space`
- **`kimi_cu_act {action, window, ...}`** — `click` (`element_index` **or** `x/y`), `type`, `key`,
  `scroll` (**`scroll_y > 0` scrolls down**), `set_value`, `drag`, `drag_path`, `secondary`,
  `activate`
- **`kimi_cu_launch {app}`**
- **`kimi_cu_script`** — **two shapes**:
  - single step: `{action, window, ...}`, or `{action:"call", args:{method,args}}` for any of the
    16 KimiCU methods (`open_panel`, `list_apps`, …)
  - batch: `{steps:[...], stop_on_error?, settle_ms?, max_result_chars?}` — 1–30 steps **inside one
    input lease**; step actions are the 9 input actions above plus `windows` / `observe` /
    `launch` / `wait_window` / `sleep` / `call`; a later step can address the n-th window of the
    previous `windows` step with `window:"@n"`
  - argument table: [`references/computer-api.md`](references/computer-api.md)

---

## Performance: the plugin is fast, the model rounds are the cost

Measured with `node test/bench.mjs` on the development machine:

| Layer | Measured | Meaning |
|---|---|---|
| HTTP health check / status (cached) | **0.0–2.1 ms** | plugin overhead |
| HTTP `snapshot` / `list_tabs` / `evaluate` | **4–10 ms** | plugin overhead |
| CU `ping` / `list_windows` / `get_window` | **0.5–2.7 ms** | plugin overhead |
| CU lease begin+end | **0.3 ms** | negligible |
| browser `navigate` | ~206 ms | page load — the daemon's job |
| browser `screenshot` | ~144 ms | Chrome capture |
| CU `get_window_state`, text only | ~82 ms | UIA tree walk |
| CU `get_window_state`, with screenshot | ~217 ms | UIA + WGC capture |
| **one model round** | **seconds** | the real cost |

Local execution is 0.5–220 ms; a model round is seconds. So the optimisation is **more work per
call**, not a faster transport. That is what the batch scripts are for: one tool call is one model
round, and six browser steps that used to cost six rounds now finish inside a single 0.6 s call.

---

## Why it does not go wrong

1. **No shell.** Browser requests are `node:http` with a UTF-8 buffer inside the Host process.
   Inline JSON through a shell corrupts non-ASCII text on Windows (measured: the daemon answers
   `invalid JSON`) — that path was removed.
2. **Validate before touching the runtime.** Action arguments are compiled into requests
   (`planAction` / `preflightSteps`) before any agent is started; exclusive fields, enum
   overflows and unknown fields all fail with `KIMI_ARGS`, naming the field (and the step number
   inside a script).
3. **No guessing at windows.** `window` accepts an id, an exact title, a substring or `@n`; zero
   or multiple matches fail and list the candidates instead of silently picking the first.
4. **Lease isolation.** Every desktop call is a lease (`begin` → N calls → `end`, released in
   `finally`), serialized process-wide so two input streams cannot interleave; `begin`/`end` must
   share connection, session and nonce (a mismatch fails). A batch script uses one lease for the
   whole script.
5. **Dispatched ≠ accepted.** Every input tool says `dispatched:true` and asks for a
   `kimi_cu_observe` confirmation.
6. **Six connection classes, six error codes, six next steps** (see
   [`references/troubleshooting.md`](references/troubleshooting.md)). A too-old runtime is never
   "worked around", and permission failures are never auto-retried.
7. **Screenshots degrade safely.** Image blocks are only produced when the current model route
   declares image input; any attachment failure degrades to text plus a local path. Inside a batch
   script one failed observation degrades that step alone.
8. **Shared resources are left alone.** Uninstalling only closes the plugin's own sockets — it
   never stops, restarts, upgrades or removes the daemon, and never kills the desktop agent.

---

## Best practice: spend fewer rounds

Anything that fits in one call should be one call:

```js
// browser: open → read → fill → click → wait → read  (1 call = 1 model round)
kimi_browser_script({ session: "task-a", steps: [
  { action: "navigate", args: { url: "https://example.com/form" } },
  { action: "read",     args: { max_chars: 1500 } },
  { action: "fill",     args: { selector: "#name", value: "Ada Lovelace" } },
  { action: "click",    args: { selector: "#submit" } },
  { action: "wait",     args: { selector: "#result" } },
  { action: "read",     args: { max_chars: 800 } },
]})

// desktop: list → observe → click → observe  (1 call, one shared lease)
kimi_cu_script({ steps: [
  { action: "windows", args: { filter: "Calculator" } },
  { action: "observe", args: { window: "@0", max_chars: 1200 } },
  { action: "click",   args: { window: "@0", element_index: 12 } },
  { action: "observe", args: { window: "@0", max_chars: 800 } },
]})
```

When you cannot predict how the page or UI will change, split it into two calls: run the first
half ending in `read` / `observe`, look at the result, then run the second half.

## Rollback

```text
plugin_manager remove_bundle  target=dsh-kimi-assemble
# and remove `disabled: true` from the mcp-kimicu row if you want the old MCP back
```

The daemon and the desktop agent are untouched.

---

## Verify a checkout

```bash
node scripts/check-syntax.mjs   # every .js/.mjs parses
node test/unit.mjs              # offline: framing, validation, preflight, schema subset, tool list
node test/faults.mjs            # dead port, port busy, extension offline, old runtime, ambiguous window
node test/i18n.mjs              # catalog parity, no untranslated CJK in `en`, language-neutral tool text
node test/market.mjs            # market/index.json conforms to format 1
node test/pack.mjs              # npm pack contains the right files and nothing else

# real machine only (needs the bridges running)
node test/live.mjs              # protocol-level connectivity, read-only
node test/integration.mjs       # tool layer, including batch scripts
node test/bench.mjs             # latency breakdown
```

Run the offline suites under both languages:

```bash
KIMI_LANG=en node test/unit.mjs
KIMI_LANG=zh node test/unit.mjs
```

In-host acceptance (2026-10-23): 13 `kimi_*` tools visible; a `kimi_cu_observe` screenshot
arrived as an image block; Chinese round-tripped intact through `kimi_browser_open/read/screenshot`;
a 6-step batch script finished in 0.6 s; the `kimi-cu` / `kimi-webbridge` runtime skills replaced
the old curl/`js` versions.

## Layout

```
index.js              apply(ctx, config)
lib/
  i18n.mjs            en/zh catalog + language resolution (zero IO, zero deps)
  config.mjs          defaults + hand-written validation (no schemastery)
  errors.mjs          KIMI_* codes
  tool.mjs            a small defineTool (JSON-Schema-subset validation + render)
  webbridge.mjs       daemon client (auto start, port discovery, UTF-8)
  kimicu.mjs          pipe client (framing, leases, auto start, window resolution)
  images.mjs          data URL / file → attachment image block (model-gated)
  guidance.mjs        system-prompt section
  skills.mjs          the two runtime skills (agent-scoped, shadowing the curl/js versions)
  tools/              status / browser (+ batch script) / computer (+ batch script)
references/           action table, method table, troubleshooting
scripts/              syntax check, market-index generator
market/index.json     generated plugin-market index (not shipped in the package)
test/                 unit / faults / i18n / market / pack / live / integration / bench
```

## Limitations

- The **desktop** half is Windows only. The browser half also runs on macOS/Linux, where the
  daemon path is resolved under `~`.
- No settings panel in v1; configuration lives in `cordis.patch.yml`.
- The plugin never closes the user's tabs on its own; `close_session` is only used when asked.
- Sites that strictly verify `isTrusted` (banking, CAPTCHA) cannot be driven by synthetic events.
  It fails loudly instead of pretending to work.
- iframe internals cannot be operated directly (daemon limitation); they can be read.
- A few windows (input-method hosts, protected windows, fully occluded or minimised) cannot be
  captured: `kimi_cu_observe` degrades to text and states why, instead of failing the call.
- A batch script runs blind: intermediate results do not reach the model, so split the script when
  the page or UI may change unpredictably.

## Security

This plugin can drive your real browser session and your real desktop. It opens no listening
socket, sends no telemetry, and only talks to the local daemon and the local named pipe described
above. Read [SECURITY.md](SECURITY.md) before enabling it on a shared machine.

## License

[MIT](LICENSE)
