# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/KexinCC/dsh-kimi-assemble/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/KexinCC/dsh-kimi-assemble/releases/tag/v1.0.0
