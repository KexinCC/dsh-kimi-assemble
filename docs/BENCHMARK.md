# Benchmark — this bridge vs Playwright

**Read this first: there is no recognised leaderboard for a plugin.**

The well-known web-agent benchmarks (WebArena, WebVoyager, Mind2Web, OSWorld) measure
**an agent** — model plus tools — on hundreds of tasks, inside Docker or a VM, with an LLM
in the loop. No "plugin score" exists in that system, and anything claiming one would be
invented.

So this page reports something narrower and honest: **latency and throughput**, measured
against the industry-standard baseline for browser automation, on the same machine, the same
pages, and the same operations. Reproduce it yourself with one command (below).

## What is being compared

| | This plugin | Playwright |
|---|---|---|
| Route to the page | plugin → local daemon (HTTP) → browser extension → CDP → **your real Chrome** | Playwright → **headless Chrome** (`channel: "chrome"`) |
| Session state | your logged-in profile, your extensions | clean profile |
| Returns | accessibility tree with `@ref` handles + page state | whatever you ask for |

Both run on one machine over the same local fixture pages. The route difference is the whole
point: this plugin pays two extra hops in exchange for driving the browser you are actually
using.

## Results

Windows, local fixture pages, `n = 10`, median / p95, milliseconds.

| Operation | This plugin p50 | p95 | Playwright p50 | p95 | Ratio (plugin / Playwright) |
|---|---:|---:|---:|---:|---:|
| navigate to a page | 157 | 191 | 20 | 39 | **7.8× slower** |
| read the page | 48 | 60 | 19 | 56 | 2.5× slower |
| click **with change verification** (default) | 674 | 715 | 64 | 90 | 10.6× slower |
| click **without verification** (`verify:false`) | 18 | 25 | 52 | 67 | **3× faster** |
| fill an input | 32 | 41 | 24 | 33 | 1.4× slower |
| screenshot | 145 | 165 | 50 | 107 | 2.9× slower |
| cold start (first usable page) | 524 | — | 507 | — | about the same |
| **20 operations in one call** | **102 ms (196 ops/s)** | — | 320 ms (62 ops/s) | — | **3.2× faster** |

Payload handed to the model: `read` returns 6,471 B here (aria tree with refs + page state)
versus 3,893 B of `innerText` for Playwright — more information per read, and more tokens.

## What the numbers actually say

1. **Navigation is the expensive part, and it is not this plugin's fault.** Two extra hops
   (daemon + extension) and a wait-for-load cost ~137 ms per navigation. That is the price of
   operating the user's real browser instead of a throwaway one.
2. **Verification is the dominant cost, and it is a choice.** `browserVerify` waits up to
   600 ms to answer "did this click do anything?". Without it the raw dispatch is 18 ms —
   three times faster than Playwright, which spends its time on actionability guarantees.
   You are buying knowledge, not speed; `browserVerify: "off"` gets the speed back.
3. **Batching is where the model-loop win is.** One tool call carrying 20 operations runs at
   196 ops/s versus 62 ops/s for 20 awaited Playwright calls — and, more importantly, one
   model round instead of twenty.
4. **Cold start is a wash** (~510 ms each).

## Caveats (read before quoting these numbers)

- Local fixture pages on one Windows machine; not the public web, no network latency.
- The plugin runs the **real Chrome profile with extensions loaded**; Playwright runs a clean
  headless Chrome. Part of the gap is other extensions doing their thing.
- `read` is not the same operation on both sides (aria tree vs `innerText`), so treat the
  payload row as context, not a like-for-like comparison.
- Timings move ±10–20 % between runs on a desktop that is doing other things.

## Reproduce

```bash
node bench/bench.mjs --reps=10
```

It prints the table above plus the raw samples as JSON. The fixture server, the operations and
the aggregation all live in `bench/bench.mjs` — change `--reps` for more samples.

Task **success** is measured separately, against machine-checked oracles rather than
self-reports: see [`bench/RESULTS.md`](RESULTS.md) (37 % → 100 % task success, 10 → 0 silent
failures between 1.0.1 and 1.1.0).
