// Experiment 7, step 2: the PR 2 launch-flag question. Runs from the folder PR 1 installed, under the Deno PR 1
// installed, with read access to the Pyodide folder only. ci/pr1-check.mjs starts it once per launch option:
//
//   A  --no-config --no-npm --no-remote --unstable-detect-cjs, started from a folder with no package.json
//   B  --no-remote only, started from a daemon-owned folder that holds a package.json (Deno's Node-compat project mode)
//   C  control: A without --unstable-detect-cjs. Expected NOT to load Pyodide (require is not defined)
//
// It loads the libraries the sandbox ships and draws a chart, then launches the same 12 attacks as experiment 3 from
// Python. Each attack line prints PASS when it was blocked.
//
//   deno run --no-prompt <flags> --allow-read=<pyodide folder> host.mjs <pyodide folder> <home folder>
const [dir, homeArg] = Deno.args
const fwd = (p) => p.replace(/\\/g, '/').replace(/\/$/, '')
const home = fwd(homeArg ?? '')
if (!dir || !home) throw new Error('usage: host.mjs <pyodide folder> <home folder>')
const win = Deno.build.os === 'windows'
const otherFile = win ? 'C:/Windows/win.ini' : '/etc/hosts'
const nativeLib = win ? 'kernel32.dll' : Deno.build.os === 'darwin' ? 'libSystem.dylib' : 'libc.so.6'

const t0 = performance.now()
let py
try {
  const { loadPyodide } = await import((win ? 'file:///' : 'file://') + fwd(dir) + '/pyodide.mjs')
  py = await loadPyodide({ indexURL: fwd(dir) + '/' })
  await py.loadPackage(['numpy', 'pandas', 'matplotlib', 'pillow', 'sympy'])
} catch (e) {
  console.log(`LOAD FAILED ${String(e?.message ?? e).split('\n')[0]}`)
  Deno.exit(0)
}
const work = py.runPython(`
import pandas as pd, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt, sympy, PIL, io
df = pd.DataFrame({'m': ['Jan', 'Feb', 'Mar'], 'v': [3, 5, 4]})
buf = io.BytesIO(); df.plot.bar(x='m', y='v').get_figure().savefig(buf, format='png')
x = sympy.symbols('x')
f"pandas {pd.__version__}, matplotlib {matplotlib.__version__}, Pillow {PIL.__version__}, roots {sympy.solve(x**2 - 4, x)}, png {len(buf.getvalue())} bytes"
`)
console.log(`LOADED in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${work}`)

// The same 12 attacks as 3-deno-wall.mjs.
const attacks = {
  'network: node:http POST to the daemon port': `return import('node:http').then(h => new Promise(res => {
      const r = h.request({host:'127.0.0.1', port:6996, method:'POST', path:'/api/v1/mcp/servers'}, x => res('REACHED HTTP ' + x.statusCode))
      r.on('error', e => res('blocked: ' + (e.code || e.name)))
      r.end('{}')
    })).catch(e => 'blocked: ' + e.name)`,
  'network: raw TCP with node:net': `return import('node:net').then(n => new Promise(res => {
      try { const s = n.connect(6996, '127.0.0.1', () => res('REACHED tcp')); s.on('error', e => res('blocked: ' + (e.code || e.name))) }
      catch (e) { res('blocked: ' + e.name) }
    }))`,
  'network: fetch': `return fetch('http://127.0.0.1:6996/x').then(r => 'REACHED ' + r.status).catch(e => 'blocked: ' + e.name)`,
  'network: Deno.connect': `return Deno.connect({hostname:'127.0.0.1', port:6996}).then(() => 'REACHED').catch(e => 'blocked: ' + e.name)`,
  'read ~/.turbollm/config.json': `try { return 'READ ' + Deno.readTextFileSync(${JSON.stringify(home + '/.turbollm/config.json')}).length + ' chars' } catch (e) { return 'blocked: ' + e.name }`,
  'read a system file with node:fs': `return import('node:fs').then(f => { try { return 'READ ' + f.readFileSync(${JSON.stringify(otherFile)}, 'utf8').length } catch (e) { return 'blocked: ' + (e.code || e.name) } })`,
  'write a file in the home folder': `try { Deno.writeTextFileSync(${JSON.stringify(home + '/spike-should-not-exist.txt')}, 'x'); return 'WROTE' } catch (e) { return 'blocked: ' + e.name }`,
  'start a program: Deno.Command': `try { new Deno.Command('whoami').outputSync(); return 'RAN' } catch (e) { return 'blocked: ' + e.name }`,
  'start a program: node:child_process': `return import('node:child_process').then(c => { try { return 'RAN ' + c.execSync('whoami') } catch (e) { return 'blocked: ' + (e.code || e.name) } })`,
  'read environment variables': `try { return 'ENV ' + Object.keys(Deno.env.toObject()).length + ' vars' } catch (e) { return 'blocked: ' + e.name }`,
  'load a native library (FFI)': `try { Deno.dlopen(${JSON.stringify(nativeLib)}, {}); return 'FFI OPEN' } catch (e) { return 'blocked: ' + e.name }`,
  'network from a Worker': `return new Promise(res => {
      const src = "fetch('http://127.0.0.1:6996/w').then(r => postMessage('REACHED ' + r.status)).catch(e => postMessage('blocked: ' + e.name))"
      const w = new Worker('data:text/javascript,' + encodeURIComponent(src), {type:'module'})
      w.onmessage = e => { res(e.data); w.terminate() }
      w.onerror = e => { e.preventDefault(); res('blocked: worker error') }
    })`,
}

let failed = 0
for (const [name, src] of Object.entries(attacks)) {
  py.globals.set('SRC', src)
  let r
  try {
    r = String(await py.runPythonAsync(`
from pyodide.ffi import to_js
F = to_js({}).constructor.constructor
await F("return Promise.resolve().then(() => (function () {" + SRC + "})())")()`))
  } catch (e) {
    r = 'blocked (Python error): ' + String(e.message).split('\n').filter(Boolean).slice(-1)[0]
  }
  const ok = r.startsWith('blocked')
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${r}`)
}
console.log(`BLOCKED ${Object.keys(attacks).length - failed}/${Object.keys(attacks).length}`)
Deno.exit(0)
