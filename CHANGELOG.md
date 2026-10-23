# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/KexinCC/dsh-kimi-assemble/releases/tag/v1.0.0
