// Experiment 4b: where does the cold start go? Times each step on its own. Runs under Node or Deno, so the two can be
// compared.
//
//   node 4b-start-timing.mjs
//   deno run --no-prompt --allow-read=runtime 4b-start-timing.mjs
import { loadPyodide } from './runtime/pyodide.mjs'
import { fileURLToPath } from 'node:url'

const rt = typeof Deno !== 'undefined' ? `deno ${Deno.version.deno}` : `node ${process.version}`
const mb = () => (process.memoryUsage().rss / 1e6).toFixed(0) + ' MB'
const step = async (name, fn) => {
  const t0 = performance.now()
  await fn()
  console.log(`${rt.padEnd(14)} ${name.padEnd(28)} ${((performance.now() - t0) / 1000).toFixed(2).padStart(6)} s   rss ${mb()}`)
}

let py
await step('load core', async () => { py = await loadPyodide({ indexURL: fileURLToPath(new URL('./runtime/', import.meta.url)) }) })
await step('loadPackage numpy+pandas', () => py.loadPackage(['numpy', 'pandas'], { messageCallback: () => {} }))
await step('import numpy', () => py.runPython('import numpy'))
await step('import pandas', () => py.runPython('import pandas'))
await step('loadPackage matplotlib', () => py.loadPackage(['matplotlib'], { messageCallback: () => {} }))
await step('import matplotlib.pyplot', () => py.runPython('import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot'))
await step('loadPackage sympy+pillow', () => py.loadPackage(['sympy', 'pillow'], { messageCallback: () => {} }))
await step('import sympy', () => py.runPython('import sympy'))
await step('import PIL.Image', () => py.runPython('import PIL.Image'))
