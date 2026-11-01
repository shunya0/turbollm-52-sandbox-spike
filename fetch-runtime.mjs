// Builds ./runtime: an offline Pyodide folder with the npm core files plus the wheels for numpy, pandas, matplotlib,
// sympy and Pillow (and everything they depend on). Every wheel is checked against the sha256 in pyodide-lock.json.
// Run once after `npm install`:  node fetch-runtime.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const VERSION = '0.29.5'
const CORE = 'node_modules/pyodide'
const OUT = 'runtime'
const WANT = ['numpy', 'pandas', 'matplotlib', 'sympy', 'pillow']

if (existsSync(OUT)) throw new Error('./runtime already exists; nothing to do')
mkdirSync(OUT)
for (const f of readdirSync(CORE)) if (statSync(join(CORE, f)).isFile()) copyFileSync(join(CORE, f), join(OUT, f))
// Deno treats .js files as ES modules unless told otherwise; pyodide.asm.js is CommonJS.
writeFileSync(join(OUT, 'package.json'), '{"type":"commonjs"}\n')

const lock = JSON.parse(readFileSync(join(CORE, 'pyodide-lock.json'), 'utf8'))
const key = (n) => Object.keys(lock.packages).find((k) => k.toLowerCase() === n.toLowerCase())
const need = new Set()
const visit = (n) => {
  const k = key(n)
  if (!k) throw new Error(`not in pyodide-lock.json: ${n}`)
  if (need.has(k)) return
  need.add(k)
  for (const d of lock.packages[k].depends) visit(d)
}
WANT.forEach(visit)

let total = 0
for (const k of need) {
  const p = lock.packages[k]
  const url = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/${p.file_name}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== p.sha256) throw new Error(`sha256 mismatch for ${k}: got ${got}, lock says ${p.sha256}`)
  writeFileSync(join(OUT, p.file_name), buf)
  total += buf.length
  console.log(`ok ${k.padEnd(22)} ${(buf.length / 1e6).toFixed(2)} MB  sha256 verified`)
}
const core = readdirSync(OUT).filter((f) => !f.endsWith('.whl')).reduce((s, f) => s + statSync(join(OUT, f)).size, 0)
console.log(`\n${need.size} packages: wheels ${(total / 1e6).toFixed(1)} MB, core ${(core / 1e6).toFixed(1)} MB`)
