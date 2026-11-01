# TurboLLM #52 sandbox spike

[![Sandbox spike](https://github.com/shunya0/turbollm-52-sandbox-spike/actions/workflows/spike.yml/badge.svg)](https://github.com/shunya0/turbollm-52-sandbox-spike/actions/workflows/spike.yml)

Throwaway experiments behind the Python sandbox proposal on [TurboLLM issue #52](https://github.com/mohitsoni48/TurboLLM/issues/52). They answer one question before any TurboLLM code is written: can chat run model-written Python safely, offline, and fast enough?

None of this is TurboLLM code, and none of it changes TurboLLM. Experiment 2 starts a TurboLLM daemon from a source checkout with a brand-new config in a temp folder; your own `~/.turbollm` is never touched.

## Setup

Needs Node 22+ and Deno 2.x.

```sh
npm install                 # pyodide 0.29.5 from npm
node fetch-runtime.mjs      # builds ./runtime: Pyodide core + 15 wheels (about 34 MB), every sha256 checked against pyodide-lock.json
```

## Run everything and check the results

```sh
node ci/run-all.mjs                                     # every experiment except 2
TURBOLLM_DIR=<path to TurboLLM/turbollm> node ci/run-all.mjs   # including experiment 2
ONLY=1,3,6 node ci/run-all.mjs                          # just some checks, for a machine with little free memory
```

The runner runs each experiment as its own process, checks its output against the claims below, and exits with an error if any claim does not hold. It writes a results table and the files the sandbox handed back to `ci-out/`.

The [CI workflow](.github/workflows/spike.yml) does this on every push on Ubuntu, macOS (Apple Silicon) and Windows, with experiment 2 run against TurboLLM pinned at `632fae6c`. Each run's page shows a results table per OS, and the chart, plot, photo and CSV the sandbox made are attached to the run. The uncapped memory run (experiment 5 without the flag) and the snapshot attempt (4c) are not part of it: the first allocates about 4 GB, and the second is a known failure.

## The experiments

| # | Question | Run | Result on my machine |
|---|---|---|---|
| 1 | Is Pyodide alone a sandbox? | `node 1-escape-node.mjs` | **No.** With `jsglobals: {}`, `js`/`pyodide_js` blocked and `fetch` deleted, Python still reaches JS `Function` through `to_js({}).constructor.constructor` and POSTs with `node:http`: HTTP 201 |
| 2 | Does that reach a real TurboLLM? | `node 2-escape-real-daemon.mjs <path to TurboLLM/turbollm>` | **Yes.** HTTP 201 from `POST /api/v1/mcp/servers`, and the entry (`whoami`, `enabled: false`) was saved to the throwaway config. Enabled, it would start a program |
| 3 | Does Deno's permission model stop it? | `node 3-listener.mjs`, then `deno run --no-prompt --allow-read=runtime 3-deno-wall.mjs <home folder>` | **12 of 12 blocked** (`NotCapable`): network four ways, reading TurboLLM's config and a system file, writing a file, starting a program two ways, env, FFI, network from a Worker. The listener received nothing |
| 3 (control) | Are those attacks real? | same, with `--allow-read --allow-net --allow-env` | 7 got through (the four network attacks, the system file, env, the Worker); the ones still blocked had no permission granted |
| 4 | Do real use cases work offline in the wall? | `deno run --no-prompt --allow-read=runtime 4-use-cases.mjs [--emit]` | All four: CSV → chart, loan EMI ₹19,812.20 with a 180-row schedule, sympy roots [1, 2, 3] + plot, photo resize. 465 MB RSS at the end |
| 4b | Where does start-up time go? | `node 4b-start-timing.mjs` / `deno run --no-prompt --allow-read=runtime 4b-start-timing.mjs` | Varies a lot. 31 Oct: core about 8 s, pandas 11–13 s, matplotlib about 8 s, sympy about 14 s, so 45–55 s for everything. 1 Nov, right after `fetch-runtime.mjs` (files likely still in the OS disk cache): core 3.4 s, pandas 3.9 s, matplotlib 2.4 s, sympy 4.5 s, about 17 s in all. Deno and Node about the same |
| 4c | Can a memory snapshot skip that? | `node 4c-snapshot.mjs make <new file>` | **Not on 0.29.5:** "Unexpected hiwire entry at index 6" |
| 5 | Can memory be capped? | `deno run --no-prompt --allow-read=runtime [--v8-flags=--wasm-max-mem-pages=8192] 5-memory.mjs [escaped]` | Without the flag: MemoryError only at 4,000 MB (RSS 4.3 GB). With it: MemoryError at 400 MB, peak RSS about 560 MB, Python still usable. Escaped JS cannot grow WebAssembly memory past the cap, but can still allocate a plain ArrayBuffer, so the host needs its own watchdog |
| 6 | Can runaway code be stopped? | `deno run --no-prompt --allow-read=runtime,6-stop-worker.mjs 6-stop.mjs` | A Python loop stops in about 2 s and keeps its variables. `sum(range(10**12))` runs in C, ignores the interrupt, and needs a hard kill |

Measured on 31 Oct and 1 Nov 2026: Windows 11, i5-1135G7, 16 GB RAM with only about 3 GB free, Node 22.17.0, Deno 2.9.6, Pyodide 0.29.5, TurboLLM `main` at 632fae6c. Timings will be better on an idle machine.

## Notes

- Experiment 2 is not a TurboLLM vulnerability. The daemon trusts callers on `127.0.0.1` as the owner by design, which is right for real local programs. It shows why a sandbox inside TurboLLM must have no network access: untrusted code that can open a socket inherits the owner's trust.

- Always pass `--no-prompt` to Deno, or it asks interactively for each permission instead of refusing.
- `fetch-runtime.mjs` writes `runtime/package.json` with `{"type":"commonjs"}`; Deno needs it to load `pyodide.asm.js`.
- Experiment 3's write attempt targets `<home>/spike-should-not-exist.txt` and must fail. Do not run it with `--allow-write`.
- Experiment 5 without the flag allocates up to about 4 GB. Run it only on a machine with room for that.
- Not covered yet: the daemon-side memory watchdog on each OS, the daemon↔sandbox framing with large files, running from a built npm package, macOS and Linux runs.
