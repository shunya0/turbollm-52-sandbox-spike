// Experiment 7, step 1: a real install with the code from TurboLLM PR 1 (#313), not with this repo's fetch-runtime.mjs.
// Downloads Deno and Pyodide from their real hosts, checks every pinned size and SHA-256, and prints where they landed.
//
//   node <TurboLLM>/turbollm/node_modules/tsx/dist/cli.mjs pr1/install.mts <TurboLLM>/turbollm <runtimes folder>
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [turbollm, runtimesDir] = process.argv.slice(2)
if (!turbollm || !runtimesDir) throw new Error('usage: install.mts <TurboLLM/turbollm> <runtimes folder>')
const { SandboxRuntime } = await import(pathToFileURL(join(turbollm, 'src/sandbox/runtime-install.ts')).href)

const rt = new SandboxRuntime({ runtimesDir: () => runtimesDir, announce: () => {} })
const before = rt.view()
console.log('BEFORE', `supported ${before.supported}, installed ${!!before.installed}, download ${before.downloadBytes} bytes, disk estimate ${before.diskBytes} bytes`)
const t0 = Date.now()
let last = -1
const tick = setInterval(() => {
  const v = rt.view()
  const tenth = Math.floor(v.job.doneBytes / v.downloadBytes * 10)
  if (tenth !== last) { last = tenth; console.log(`progress ${tenth * 10}%`) }
}, 250)
try { await rt.install() } finally { clearInterval(tick) }
const after = rt.view()
console.log('AFTER', `job ${after.job.state}, installed ${JSON.stringify(after.installed)}`)
console.log(`SECONDS ${((Date.now() - t0) / 1000).toFixed(1)}`)
console.log(`DENO ${rt.denoPath()}`)
console.log(`PYODIDE ${rt.pyodideDir()}`)
