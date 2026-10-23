# Contributing

Thanks for taking a look. This plugin has no build step and no runtime
dependencies on purpose — keep it that way unless there is a strong reason.

## Ground rules

1. **Zero runtime dependencies.** A profile installed with
   `autoInstallPeers: false` cannot reliably resolve packages the plugin does not
   ship, and a bare `import` of one would stop the whole plugin from activating.
2. **No shell for protocol calls.** Browser requests are plain `node:http` with a
   UTF-8 buffer; desktop calls speak the framed named-pipe protocol directly.
   Shelling out corrupts non-ASCII payloads on Windows (this was measured) and
   bypasses argument validation.
3. **Validate before touching the runtime.** A bad argument must fail with
   `KIMI_ARGS` before any daemon or agent connection is opened.
4. **Never manage the shared processes.** Do not stop, restart, upgrade or
   uninstall the WebBridge daemon or the KimiCU agent. They belong to the user.
5. **Degrade, do not crash.** A screenshot that cannot be captured must not fail
   an observation; an attachment that cannot be stored must fall back to text.

## Setup

```bash
git clone https://github.com/dsh-community/dsh-kimi-assemble.git
cd dsh-kimi-assemble
node --version        # requires >= 22, developed on 24
```

There is nothing to install: no dependencies, no build.

## Local development loop

Install the checkout as a bundle in your own profile:

```text
plugin_manager install_bundle  target=<absolute path to this checkout>
```

Re-install after changing JavaScript — replacing an installed package requires a
restart to load a fresh module generation. Then verify:

```text
cordis_inspect_query(Tool.listTools)     # expect 17 kimi_* tools
kimi_status                              # expect both bridges reported
```

Mind the owner of the checkout: a `link:` install makes the profile's
`node_modules/<pkg>` a junction to this directory, and removing that bundle can
delete *through* the junction. Prefer installing the published package (or a
`npm pack` tarball) and keep this checkout out of the profile.

### Clean up after you test

Automated runs (`bench/run.mjs`, `bench/semantics.mjs`) close their own sessions.
When you test by hand in the host, you are the one leaving state behind — always
finish with:

```text
kimi_browser_tabs { action: "close_session", session: "<the session you used>" }
```

and stop the fixture server (`node bench/server.mjs`). Never leave `127.0.0.1`
test tabs or a running bench server in the user's browser: they land in the same
window the user is working in.

## Tests

```bash
# Offline, no hardware needed — must pass on every change
node test/unit.mjs           # framing, validation, schema subset, tool list
node test/faults.mjs         # dead port, port busy, extension offline, version too old
node test/i18n.mjs           # catalog parity, no untranslated CJK in `en`
node test/market.mjs         # plugin-market index conforms to format 1
node scripts/check-syntax.mjs

# Real machine only — skipped by CI, run these before a release
node test/live.mjs           # protocol-level connectivity, read-only
node test/integration.mjs    # tool layer incl. batch scripts
node test/bench.mjs          # latency breakdown
```

Run the offline suites twice, once per language:

```bash
KIMI_LANG=zh node test/unit.mjs
KIMI_LANG=en node test/unit.mjs
```

On PowerShell: `$env:KIMI_LANG="en"; node test/unit.mjs`.

## Style

- ES modules, `.mjs` for library code, no TypeScript build.
- Comments may be Chinese or English; **model-facing text** (tool descriptions)
  stays English, while user-facing text goes through `lib/i18n.mjs`.
- Every failure carries a `KIMI_*` code from `lib/errors.mjs`. Add codes there,
  never invent ad-hoc strings.
- Keep tool descriptions short: they cost context on every request.

## Changing the plugin-market index

`market/index.json` is generated, not hand-edited:

```bash
node scripts/build-market-index.mjs
node test/market.mjs
```

Bump `version` in `package.json` first — the index reads the manifest.

## Pull requests

- One logical change per PR, with the offline tests green.
- Note in the description whether you could run the real-machine suites; if not,
  say which parts remain unverified.
- Update `CHANGELOG.md` under `Unreleased`.
