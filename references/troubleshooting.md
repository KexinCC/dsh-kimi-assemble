# Troubleshooting

Every failure carries a stable code (`KIMI_*`). Read the code first, then the "next step" in the
message. For any connection-class failure, **call `kimi_status` once** instead of repeating the same
call.

## Browser (WebBridge)

| code | trigger | handling |
|---|---|---|
| `KIMI_WEBRIDGE_DOWN` | cannot reach `127.0.0.1:10086`, and the automatic `start` did not bring it up | run `~/.kimi-webbridge/bin/kimi-webbridge.exe start` by hand and read its port/error output |
| `KIMI_WEBRIDGE_PORT_BUSY` | something answered on the port with non-JSON (another program owns it) | change `~/.kimi-webbridge/daemon.addr` to a free port and set the same address in the extension (`ws://127.0.0.1:<port>/ws`) |
| `KIMI_WEBRIDGE_EXTENSION` | the daemon is up but the extension is not connected | open the Kimi side panel in Chrome → Settings → local agent remote control, and check the address matches |
| `KIMI_WEBRIDGE_VERSION` | the extension is behind | update it: https://www.kimi.com/products/kimi-webbridge |
| `KIMI_WEBRIDGE_TIMEOUT` | one action timed out | a page script may be blocking; check `kimi_status`; restart the daemon only if it is really stuck (that ends every browser session) |
| `KIMI_WEBRIDGE_TOOL` | the daemon explicitly refused (missing argument, no such element, no tab …) | fix the argument the message names; "session has no tab" means navigate/find_tab first |
| `KIMI_WEBRIDGE_BAD_ENVELOPE` | HTTP status is not 200 and the body is not an error envelope | usually a daemon version mismatch; upgrade `kimi-webbridge` itself |

Frequent non-error messages:

- `element not found: <sel>` — the selector is wrong or the element has not rendered; read the page
  first to get a ref.
- `unknown or expired ref` — the ref expired; re-read the page.
- `element has no layout box` — the element is not visible (`display:none` / zero size); use `click`
  or pick another target.
- `upload needs Chrome's per-extension file access` — have the user enable "allow access to file
  URLs" for the Kimi extension at `chrome://extensions`.

## Desktop (KimiCU)

| code | trigger | handling |
|---|---|---|
| `KIMI_CU_NOT_INSTALLED` | `kimi-cu.exe` not found | run https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd , or set `kimicuExePath` |
| `KIMI_CU_AGENT_START_FAILED` | the runtime is present but `start-agent` failed | run `kimi-cu.exe doctor`, then `kimi-cu.exe start-agent` |
| `KIMI_CU_RUNTIME_TOO_OLD` | version < 0.3.0, or an unparsable version string | upgrade with the setup script |
| `KIMI_CU_BUSY` | another session holds input (`computer_use_busy`) | stop sending input; read-only observation usually still works; **do not** kill the other session |
| `KIMI_CU_TIMEOUT` | one call timed out | the action **may already have taken effect**: observe before deciding, do not blindly retry |
| `KIMI_CU_PROTOCOL` | frame/lease anomaly | retry once; if it persists run `doctor` and check whether the agent restarted |
| `KIMI_CU_TOOL` | the agent explicitly refused | follow the message; for permission failures see below |
| `KIMI_UNSUPPORTED_PLATFORM` | not Windows | KimiCU is Windows-only |

**Permission failures** carry a `permission_context` (runtime version, process integrity level,
elevation, UIAccess). Handling: call
`kimi_cu_script {action:"call", args:{method:"open_panel"}}` to open the CU panel → have the user
**manually** upgrade or enable admin mode and confirm UAC → after the user confirms, start again
with a fresh observe. **Do not** automatically replay the failed input.

## The plugin itself

| code | trigger | handling |
|---|---|---|
| `KIMI_ARGS` | invalid tool arguments | fix what the message names; exclusive arguments (`element_index` vs `x/y`) and enum values are listed in it |
| `KIMI_CONFIG` | this row's config in `cordis.patch.yml` is invalid | see the range/format in the message; an address must be `host:port` |

## Order of investigation

1. `kimi_status` — a one-line verdict for both bridges plus the next step.
2. Look the code up in the tables above.
3. Still stuck: for the browser check `~/.kimi-webbridge/logs/daemon.log`; for the desktop run
   `kimi-cu.exe doctor`.
4. Restart the daemon only once you are sure it is stuck (it ends every browser session). Start the
   CU agent with `start-agent` (idempotent; it does not kill other sessions).

> The text a user sees is translated (`language`: `auto` / `en` / `zh`). Codes and the argument names
> inside messages never change, so this table applies to every language.
