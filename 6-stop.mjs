// Experiment 6: can runaway code be stopped without losing the chat's state?
//
// Pyodide runs in a worker. After 2 s the main thread sets a shared flag (2 = SIGINT), which Python checks between
// bytecodes. Three runs: a Python loop, a check that a variable survived, and a loop inside C code that never checks
// the flag, which needs a hard kill.
//
//   deno run --no-prompt --allow-read=runtime,6-stop-worker.mjs 6-stop.mjs
const sab = new SharedArrayBuffer(4)
const flag = new Int32Array(sab)
const w = new Worker(new URL('./6-stop-worker.mjs', import.meta.url), { type: 'module' })
const next = () => new Promise((res) => (w.onmessage = (e) => res(e.data)))

w.postMessage({ type: 'init', sab }); await next()
const run = async (label, code) => {
  flag[0] = 0
  const done = next()
  w.postMessage({ type: 'run', code })
  setTimeout(() => (flag[0] = 2), 2000)
  const out = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 4500))])
  console.log(out ? `${label.padEnd(40)} stopped after ${out.secs} s -> ${out.r}` : `${label.padEnd(40)} did NOT stop within 2.5 s of the interrupt`)
  return out
}
await run('Python loop: while True: pass', 'while True: pass')
await run('variable set before the loop', 'state')
const c = await run('C loop: sum(range(10**12))', 'sum(range(10**12))')
if (!c) { w.terminate(); console.log('worker terminated (hard kill): a fresh Python would start, losing variables') }
Deno.exit(0)
