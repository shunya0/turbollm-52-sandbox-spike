// Experiment 4c: can a Pyodide memory snapshot (made once, loaded at every start) remove the cold start?
// On 0.29.5 with these packages it could not: making the snapshot failed with "Unexpected hiwire entry at index 6".
//
//   node 4c-snapshot.mjs make <new file>      writes a snapshot (refuses to overwrite an existing file)
//   node 4c-snapshot.mjs load <file>          starts from it and runs a pandas + chart job
import { loadPyodide } from './runtime/pyodide.mjs'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const [mode, file] = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2)
if (!['make', 'load'].includes(mode) || !file) throw new Error('usage: 4c-snapshot.mjs make|load <file>')
const indexURL = fileURLToPath(new URL('./runtime/', import.meta.url))
const t0 = performance.now()
const secs = () => ((performance.now() - t0) / 1000).toFixed(2) + ' s'

if (mode === 'make') {
  if (existsSync(file)) throw new Error('refusing to overwrite ' + file)
  const py = await loadPyodide({ indexURL, _makeSnapshot: true, packages: ['numpy', 'pandas', 'matplotlib'] })
  py.runPython('import numpy, pandas, matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot')
  const snap = py.makeMemorySnapshot()
  writeFileSync(file, snap)
  console.log(`snapshot made in ${secs()}: ${(snap.length / 1e6).toFixed(1)} MB`)
} else {
  const py = await loadPyodide({ indexURL, _loadSnapshot: readFileSync(file) })
  console.log(`started from snapshot in ${secs()}`)
  console.log(py.runPython(`
import pandas as pd, io
df = pd.DataFrame({'m': list('ABCDEFGHIJ'), 'v': range(10)})
buf = io.BytesIO(); df.plot(x='m', y='v', kind='bar').figure.savefig(buf, format='png')
f"pandas + chart ok, png {len(buf.getvalue())} bytes"`), `(total ${secs()})`)
}
