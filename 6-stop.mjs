// Experiment 6: can runaway code be stopped without losing the chat's state?
//
// Pyodide runs in a worker. After 2 s the main thread sets a shared flag (2 = SIGINT), which Python checks between
// bytecodes. Three runs: a Python loop, a check that a variable survived, and a loop inside C code that never checks
// the flag, which needs a hard kill. Each run has an id, so a late reply is never taken for the next run's answer, and
// the Python loop gets up to 15 s so a slow interrupt is measured instead of cut off.
//
//   deno run --no-prompt --allow-read=runtime,6-stop-worker.mjs 6-stop.mjs
const sab = new SharedArrayBuffer(4)
const flag = new Int32Array(sab)
const w = new Worker(new URL('./6-stop-worker.mjs', import.meta.url), { type: 'module' })
const waiting = new Map()
w.onmessage = (e) => waiting.get(e.data.id)?.(e.data)

let nextId = 0
const send = (msg) => new Promise((res) => { const id = nextId++; waiting.set(id, res); w.postMessage({ ...msg, id }) })
await send({ type: 'init', sab })

const run = async (label, code, waitMs) => {
  Atomics.store(flag, 0, 0)
  const done = send({ type: 'run', code })
  const t = setTimeout(() => Atomics.store(flag, 0, 2), 2000)
  const out = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), waitMs))])
  clearTimeout(t)
  if (!out) console.log(`${label.padEnd(40)} did NOT stop within ${(waitMs - 2000) / 1000} s of the interrupt`)
  else if (Number(out.secs) < 2) console.log(`${label.padEnd(40)} finished after ${out.secs} s -> ${out.r}`)
  else console.log(`${label.padEnd(40)} stopped after ${out.secs} s (${(out.secs - 2).toFixed(2)} s after the interrupt) -> ${out.r}`)
  return out
}
await run('Python loop: while True: pass', 'while True: pass', 17_000)
await run('variable set before the loop', 'state', 4_500)
const c = await run('C loop: sum(range(10**12))', 'sum(range(10**12))', 4_500)
if (!c) { w.terminate(); console.log('worker terminated (hard kill): a fresh Python would start, losing variables') }
Deno.exit(0)
