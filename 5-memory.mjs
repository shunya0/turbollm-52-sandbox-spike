// Experiment 5: can Python's memory be capped?
//
// Python allocates 100 MB at a time (up to 6 GB) until something stops it. Run it with and without V8's
// WebAssembly page cap (8192 pages x 64 KB = 512 MB) and compare:
//
//   deno run --no-prompt --allow-read=runtime 5-memory.mjs
//   deno run --no-prompt --allow-read=runtime --v8-flags=--wasm-max-mem-pages=8192 5-memory.mjs
//
// Optional second part, only with the cap: `... 5-memory.mjs escaped` also checks what escaped JavaScript can
// allocate. A new WebAssembly.Memory over the cap is refused, but a plain 1 GB ArrayBuffer is not, which is why the
// daemon needs its own memory watchdog as well. (The spike tried 3 GB; 1 GB keeps this gentle on small machines.)
import { loadPyodide } from './runtime/pyodide.mjs'
import { fileURLToPath } from 'node:url'

const mb = () => (process.memoryUsage().rss / 1e6).toFixed(0)
const py = await loadPyodide({ indexURL: fileURLToPath(new URL('./runtime/', import.meta.url)) })
console.log(`loaded, rss ${mb()} MB`)

let peak = 0
const timer = setInterval(() => { peak = Math.max(peak, Number(mb())) }, 20)
const t0 = performance.now()
try {
  console.log('Python says:', py.runPython(`
held = []
try:
    for i in range(60):
        held.append(bytearray(100 * 1024 * 1024))
    r = f"allocated {len(held) * 100} MB with no error"
except MemoryError:
    r = f"MemoryError after {len(held) * 100} MB"
held = None
r`))
} catch (e) {
  console.log('runtime error:', String(e.message).split('\n').filter(Boolean).slice(-1)[0].slice(0, 160))
}
clearInterval(timer)
console.log(`took ${((performance.now() - t0) / 1000).toFixed(2)} s, peak rss about ${Math.max(peak, Number(mb()))} MB`)
console.log('Python still usable afterwards: 1 + 1 =', py.runPython('1 + 1'))

if ((typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2))[0] === 'escaped') {
  py.globals.set('SRC', `
    const out = []
    try { new WebAssembly.Memory({ initial: 16000 }); out.push('1 GB WebAssembly.Memory: ALLOWED') } catch (e) { out.push('1 GB WebAssembly.Memory: refused (' + e.name + ')') }
    try { const b = new Uint8Array(1024 * 1024 * 1024); b.fill(1); out.push('1 GB ArrayBuffer: allocated and filled') } catch (e) { out.push('1 GB ArrayBuffer: refused (' + e.name + ')') }
    return out.join('; ')`)
  console.log('escaped JS:', String(py.runPython(`
from pyodide.ffi import to_js
to_js({}).constructor.constructor(SRC)()`)), `· rss ${mb()} MB`)
}
