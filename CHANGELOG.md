# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] — 2026-10-30

Field report from real work inside a corporate portal (an OA behind an iframe, Element UI style
widgets, SSO through the portal). Three of the four things that cost time are now handled by the
plugin instead of by the caller.

### Added — iframes are addressed like normal elements

- `read` lists `frames:` with handles (`#f1 (same-origin) src=…`) whenever a page has any — and
  says nothing when it has none.
- `click` / `fill` **auto-detect** the frame: when the selector is not in the top document, the
  plugin looks through same-origin iframes, acts inside the right one and reports `frameUsed`.
  `frame:"#f1"` forces a specific one. Cross-origin frames are reported as such instead of faked.
- Frame-aware verification: the top-level signature cannot see inside an iframe (measured: the
  page looked "unchanged" while the inner click had worked), so this path compares a deep
  signature — top document plus every same-origin frame.

### Added — a JS click that does nothing gets retried as a real mouse event

- When a click reports no change, the plugin finds the element, brings the tab to front, and
  dispatches `Input.dispatchMouseEvent` at its centre, then re-checks. Element UI / Ant Design
  dropdowns only respond to real events, which is why `el.click()` looked broken.
- `clickStrategy` says what actually worked: `js` / `frame-js` / `mouse` / `frame-mouse`.
  Measured on the fixture: a custom dropdown went from "no reaction" to opened.
- Required constraint, measured: CDP input events (keyboard **and** mouse) do nothing until
  `Page.bringToFront`. It is focus emulation, not a foreground steal.

### Added — swallowed popups are reported

- Clicks install a `window.open` probe once per session; if it was called and the tab count did
  not increase, the result carries `popupBlocked: true` and the render says to allow popups or
  open the link manually. Before this, a blocked SSO popup looked exactly like a dead click.

### Config

- `mouseFallback` (`auto` | `off`), `popupWatch` (`on` | `off`).

Suite: syntax 38 files, unit 59, assert 5, faults 12, i18n 11, market 9, pack 7, version 8,
bench semantics 20 (+3: iframe addressing, mouse fallback, popup blocking).

## [1.3.0] — 2026-10-30

Two things, both about not lying to the model: how hard an action is verified, and what the
result actually means.

### Changed — verification is tiered by reversibility

- `scroll`, `hover`, `mouse_click`, `set_checked`, `select_option`, `key_type`, `send_keys`,
  `upload`, `go_back`/`go_forward`/`reload`, `cdp` no longer wait for a change window. They are
  reversible, so waiting 600 ms to learn "nothing changed" was pure cost: **measured 649 ms →
  13 ms per scroll call** on the same page.
- Clicks that hit a risky target (`submit`, `delete`, `send`, `pay`, `save`, `确认`, `删除`,
  `支付` …) or `fill {submit:true}` are upgraded to `strict`: full window plus stale-ref retry.
  Ordinary clicks and fills stay `normal`. Per call you can override with
  `verify: false | true | "light" | "strict"`.
- New `browserVerifyLightMs` (default `0`) tunes the light budget.

### Changed — one vocabulary for results

- Actions now return `status` — `verified` / `unchanged` / `dispatched` / `blocked` — alongside
  `verifyTier`. Before, the browser said `changed: true|false` while every `kimi_cu_*` action said
  `dispatched: true` (KimiCU cannot confirm effects), so "sent" looked like "done".
  `kimi_cu_*` results are explicitly `dispatched`; `fill` without submit is `dispatched` too
  (the value landed, the page did not change); a native dialog yields `blocked`.

Suite: syntax 37 files, unit 59, assert 5, faults 12, i18n 11, market 9, pack 7, version 8,
bench semantics 17.

## [1.2.0] — 2026-10-30

First-use experience, model correctness, and the version bug. Four changes, all driven by
things that were actually wrong rather than things that could be nicer.

### Fixed

- **`VERSION` had been stuck at 1.0.0 for five releases**, so every load log lied about which
  build was running. It now derives from `package.json` — one source of truth — and
  `test/version.mjs` asserts the invariant so it cannot drift again. Same test also asserts the
  market index version, that the READMEs contain no hard-coded install pin (they had `@1.1.0`),
  that the READMEs stated tool count matches the real one, and that `files`/`bin` point at files
  that exist.

### Added

- **Script-engine actions `assert` and `commit`** for batch scripts. `assert` checks a
  precondition (url contains / selector exists or is visible / text present, with `not` to
  invert) and **aborts the whole batch** when it fails, naming the step — no more silently
  continuing after a step that did not take effect. `commit` marks an irreversible boundary;
  failures after it say so, so a retry does not blindly resubmit. Covered by `test/assert.mjs`
  with a fake daemon (offline, deterministic).
- **Every failure now carries its next step.** `KIMI_WEBRIDGE_DOWN` / `_EXTENSION` /
  `_VERSION` / `_PORT_BUSY` and the four `KIMI_CU_*` codes append a block with a runnable
  `doctor` command plus a one-line JSON `next_actions` array (`kind:"run"` vs `kind:"user"`),
  so an agent does not need an extra tool round to learn what to do. Unrelated errors stay
  quiet — no noise added.

### Changed

- **README install section rebuilt around the preflight.** Pick a path (browser-only /
  desktop-only / both, with tool counts), run `doctor` as the spine, install, verify — and the
  security boundary (page content is untrusted data; `eval` is privileged) is stated up front
  instead of buried in SECURITY.md.
- **Tool-selection table and recipes moved into the skill body** (on demand) instead of
  staying in tool descriptions. The always-on cost of the 17 tool definitions is ~5.4k tokens;
  the rules are unchanged, they just stop costing context on every turn.

## [1.1.5] — 2026-10-29

Publishes a reproducible benchmark. Docs and bench only; no runtime change.

### Added

- : same machine, same fixture pages, same operations, this bridge versus
  Playwright (installed Chrome via channel:chrome). Measures cold start, per-action p50/p95,
  20-operation batching and the payload handed to the model.
-  plus a Benchmark section in both READMEs, stating up front that no
  recognised leaderboard exists for a plugin, and reporting the numbers it actually has:
  navigation 7.8x slower (two extra hops, but it is the user real Chrome), click with change
  verification 10.6x slower and click without it 3x faster than Playwright, batching 3.2x
  faster (196 vs 62 ops/s), cold start a wash.

## [1.1.4] — 2026-10-29

Reliability tail: the failures that actually showed up in 10,909 logged tool calls are now either
self-healed or explained. Adds an opt-in diagnostic log so the next failure has a crime scene.

### Added

- `diagnostics: true` (default off) appends one JSONL line per tool call to
  `~/.dsh/kimi-assemble/diag.log`: tool, session, duration, ok, error code, first line of the error.
  Argument values and page content are never written. `diagnosticsMaxKb` (512) rotates it.

### Fixed

- **KimiCU window handle invalid** (`window is no longer valid`) was the most common desktop failure
  (7 of 51 logged failures). A call that hits it now re-resolves the window from the original id/title
  and retries once — safe, because that error means the action never landed. If the window is really
  gone, the original error is returned unchanged.
- `snapshot` failing because **another browser extension injected its own panel** into the page
  (password managers, translators, recorders) now says so and tells you what to do: close that panel,
  or read the data with `kimi_browser_eval`.
- A misspelled `action` inside a script now gets a "did you mean …?" suggestion.
- Legacy `scroll_x` / `scroll_y` arguments are accepted as `dx` / `dy` instead of failing validation.

### Docs

- `references/troubleshooting.md`: where every log lives (daemon, plugin, DSH sessions) and the order
  to read them.
- `SECURITY.md`: this plugin makes no network requests; discloses what the Kimi components it drives
  report (`gator.volces.com`, tool-name level only).

## [1.1.3] — 2026-10-24

Documentation only; the doctor invocation in the README did not work on Windows.

### Fixed

- `npx -p dsh-kimi-assemble kimi-assemble-doctor` fails with "not recognized" when a package's bin name
  differs from its package name (tested three npx variants). Replaced with three verified forms: run the
  installed copy by path, `npm i -g dsh-kimi-assemble && kimi-assemble-doctor`, or the same with
  `--json` for agents.

## [1.1.2] — 2026-10-24

Prerequisite setup can now be driven by an agent, with the human-only parts called out explicitly.

### Added

- `scripts/doctor.mjs` (published as the `kimi-assemble-doctor` bin): preflight for both bridges with
  `--json` output shaped for agents — each finding carries `nextActions[]` tagged `kind: "run"`
  (an agent may execute it) or `kind: "user"` (only a human can). Exit codes: `0` ready, `2` needs a
  human, `3` only the desktop runtime is missing and is installable.
- `--install-desktop`: downloads and runs the official KimiCU installer
  (`https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd`) — opt-in only, prints the
  URL first, then re-checks.
- `--addr=` to preflight a non-default daemon address.
- README (en/zh): "Let an agent install the prerequisites" — a table of what is automatable and what
  is not, plus the agent loop (run doctor → hand `kind: "user"` steps to the human → re-run).

### Notes

- The WebBridge local service has **no public installer URL** (verified: guessed `cdn.kimi.com/…/setup_*`
  paths answer 403). It can only be installed with the command the browser extension shows in
  Settings → local agent remote control → Connect. The docs say so instead of pretending a script can
  do it.
- The plugin still never downloads or executes an installer on its own.

## [1.1.1] — 2026-10-23

`fill {submit: true}` now actually submits, and the reason Enter never worked is documented.

### Fixed

- Submitting a form used to depend on pressing Enter, which **cannot work through this extension**:
  `send_keys` / `key_type` do not produce DOM keydown events (measured — a capture-phase listener
  never fires, `key_type` only inserts text), so the browser never performs implicit form
  submission. A suggestion dropdown swallowing Enter was only the visible symptom.
- `kimi_browser_fill {submit: true}` now clicks the form submit button, falling back to
  `form.requestSubmit()`, then Esc + click, then Enter, verifying the page after each route and
  reporting which one worked (`submitStrategy`). Three new fixtures cover the swallowed-Enter,
  no-button and working-form cases.
- Change detection no longer gives up when a probe fails mid-navigation (that made a successful
  submit look like "no change" and could trigger a second submit).

## [1.1.0] — 2026-10-23

Actions now report whether they took effect, and the browser tool surface covers what used to be
reachable only through raw daemon actions. Measured with a controlled A/B against 1.0.1 (6 fixtures
× 5 runs, [`bench/RESULTS.md`](https://github.com/KexinCC/dsh-kimi-assemble/blob/main/bench/RESULTS.md)):
task success 37% → 100%, silent failures 10 → 0.

### Added

- **Action verification.** `kimi_browser_click` / `fill` / `act` capture a page fingerprint before
  the action and poll after it (geometric 100/200/400ms inside `browserVerifyMs`), returning
  `changed` plus a description of what changed. A stale ref is re-read and retried once; if it still
  fails the response carries a fresh snapshot so the next attempt does not need another round.
- **`kimi_browser_act`** — `press`, `type`, `clear`, `select`, `check`, `uncheck`, `hover`, `scroll`,
  `drag`, `mouse_click`, `upload`, all verified, optional `wait_for`.
- **`kimi_browser_wait`** — `text` / `text_gone` / `selector` / `url` / `ready` / `ms`; replaces
  model-side polling loops and reports the page state on timeout.
- **`kimi_browser_eval`** — structured page JS evaluation (JSON, size-capped).
- **`kimi_browser_dialog`** — `status` / `accept` / `dismiss`. A native dialog freezes page JS;
  click/fill/act now return `dialogOpen: true` instead of a hard error.
- **`kimi_browser_read` additions** — page-state line (`include_meta`, default on: url, readyState,
  scroll, focused element, element counts), `mode=diff` (only what changed since the last read,
  measured ~4% of the full payload), and `include_screenshot` (text and image in one call).
- **`kimi_browser_open` waits for load** (`wait_until: load|domcontentloaded|none`) so the next
  action does not race the page; the extra `list_tabs` round trip is gone (the title comes from the
  same probe).
- Config: `browserVerify` (`auto`/`off`), `browserVerifyMs`, `browserReadIncludeMeta`.
- `bench/` — fixture server with machine-checkable oracles, self-test, semantic checks and the A/B
  driver, so these claims can be re-run instead of trusted.

### Changed

- `kimi_browser_read` now costs one extra parallel probe (meta) but returns the page state; full
  reads stay the same wall time because snapshot, meta and screenshot are issued in parallel.
- Tool catalog: 13 → 17 tools.

### Fixed

- A click that did nothing used to look identical to a successful one; so did a `fill` whose
  `submit=true` Enter was swallowed by a suggestion dropdown.
- A native dialog used to surface as an opaque `Runtime.callFunctionOn was interrupted` error.
- Waiting for async rendering by re-reading repeatedly was unreliable and slow: the daemon's `wait`
  took 2993ms for a 1.2s render, and `evaluate`'s `await Promise` has ~1s of fixed overhead, so the
  wait is implemented as cheap client-side polling over a DOM walk that skips `script`/`style`.

### Compatibility

- No existing tool name or argument changed meaning; new arguments are optional.
- `browserVerify: "off"` reproduces the 1.0.x fire-and-forget behaviour exactly (covered by a test).

## [1.0.1] — 2026-10-23

Documentation-only patch; no runtime code changed. Published so the npm page and tarball match
the repository.

### Fixed

- README (en/zh) now lists the npm install line as the primary path and keeps the plugin-market
  index and the clone-and-install routes as alternatives.
- `references/troubleshooting.md` corrects the warning about `link:` installs: clearing such a
  bundle can delete *through* the junction into the source checkout (it did, twice, during this
  release), so it now says to install the published package or a throwaway clone, and to remove a
  leftover junction with `cmd /c rmdir` rather than a recursive delete.

## [1.0.0] — 2026-10-23

First public release.

### Added

- Host plugin that turns the Kimi browser extension (WebBridge, local daemon on
  `127.0.0.1:10086`) into native DeepSeek Harness tools: `kimi_browser_open`,
  `kimi_browser_read`, `kimi_browser_click`, `kimi_browser_fill`,
  `kimi_browser_screenshot`, `kimi_browser_tabs`.
- Desktop control of real Windows windows through the KimiCU native agent
  (named pipe `\\.\pipe\kimi-cu-win-<user>`): `kimi_cu_windows`,
  `kimi_cu_observe`, `kimi_cu_act`, `kimi_cu_launch`.
- `kimi_browser_script` and `kimi_cu_script`: run 1–25 (browser) or 1–30
  (desktop) actions in a single tool call, so a multi-step task costs one model
  round instead of one per action. Desktop scripts run inside a single input
  lease and can reference a window listed by a previous step with `window: "@0"`.
- `kimi_status`: one call reporting both bridges plus the concrete next step for
  every connection failure.
- Automatic, idempotent start-up of the WebBridge daemon and the KimiCU agent.
- Screenshots become real image blocks in the conversation, gated on the current
  model route declaring image input; every attachment failure degrades to text
  plus a local path.
- Graceful degradation when a window cannot be captured (protected windows,
  input-method hosts, fully occluded): the accessibility tree is still returned
  and the reason is stated.
- Runtime skills `kimi-webbridge` and `kimi-cu` that override the older
  curl-based and `js`-cell-based skills of the same name, so the model stops
  routing through the shell.
- Configuration: `language` (`auto` / `en` / `zh`), `disabledTools`, plus the
  connection, timeout and truncation knobs described in the README.
- Offline unit tests, fault-injection tests, real-machine integration tests, a
  latency benchmark, and a plugin-market index generator.

### Security

- No listening socket, no telemetry, no outbound network access: the plugin only
  connects to the local daemon and the local named pipe documented above.
- Credentials and browser profile data are never read or copied.
- Uninstalling the plugin never stops, restarts, upgrades or removes the shared
  daemon and desktop agent; it only closes its own sockets.

[Unreleased]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/KexinCC/dsh-kimi-assemble/releases/tag/v1.0.0
