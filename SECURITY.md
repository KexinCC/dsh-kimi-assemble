# Security Policy

## What this plugin can do

`dsh-kimi-assemble` is an automation bridge. Once installed and enabled it lets a
model:

- drive **your real, logged-in browser** through the Kimi browser extension
  (navigate, click, type, upload, screenshot, read page content), and
- observe and control **real Windows desktop windows** through the KimiCU agent
  (accessibility tree, screenshots, mouse and keyboard input).

That is a powerful capability. Treat it the way you would treat a remote-control
tool: only run it in a profile you control, and only let agents you trust use it.

## Network surface

The plugin opens **no** listening socket and makes **no** outbound network
requests of its own. It talks only to:

| Endpoint | Purpose |
|---|---|
| `127.0.0.1:<port>` (default `10086`) | the WebBridge daemon you installed |
| `\\.\pipe\kimi-cu-win-<user>` | the KimiCU agent on the same machine |
| `%LOCALAPPDATA%\Kimi Computer Use\kimi-cu.exe` | resolved and executed only when the agent is not running |

Page content fetched by the browser bridge comes from your own browser session;
the plugin itself never phones home. There is no telemetry and no analytics.

## Data handling

- Credentials, cookies and browser profile files are never read, parsed or
  copied by this plugin. Authentication stays inside your browser.
- Screenshots and accessibility trees are sent to your configured model provider
  as part of the conversation, like any other tool result. If that is
  unacceptable for a given window, do not observe it.
- Configuration and logs live in the DeepSeek Harness profile directory.

## Recommended posture

- Keep `kimicuEnabled` / `webbridgeEnabled` off unless you are actively using
  the capability, and use `disabledTools` to narrow what the model can reach.
- Prefer short-lived scripts over long unattended loops.
- Do not expose the WebBridge daemon beyond loopback. If you change its port,
  also change the extension's setting; do not bind it to `0.0.0.0`.
- On shared machines, remember that desktop input is machine-global: another
  session holding the lease will block yours, and vice versa.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through the repository's *Security → Report a vulnerability*
advisory form, or by email to the maintainer address listed in `package.json`.

Include: affected version, the tool or code path, a minimal reproduction, and
what an attacker gains. You can expect an acknowledgement within a few days.

## Supported versions

Security fixes land on the latest published minor. Pre-1.0 the maintainers may
backport to the previous minor when the fix is small.
