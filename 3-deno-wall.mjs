// Experiment 3: does Deno's permission model stop the escape?
//
// Runs Pyodide under Deno with read access to ./runtime only: no network, no writes, no subprocesses, no env, no FFI.
// Every attack below is launched from Python through the same Function-constructor escape as experiment 1, so the
// only thing that can stop it is Deno. Each line prints PASS when the attack was blocked.
//
//   node 3-listener.mjs                       (first, in another terminal)
//   deno run --no-prompt --allow-read=runtime 3-deno-wall.mjs <your home folder>
//
// The home folder argument only names targets for the read/write attempts (Deno cannot look it up itself without
// env permission). Nothing is written: the write attempt must fail.
import { loadPyodide } from './runtime/pyodide.mjs'
import { fileURLToPath } from 'node:url'

const home = (Deno.args[0] ?? '').replace(/\\/g, '/').replace(/\/$/, '')
if (!home) throw new Error('usage: deno run --no-prompt --allow-read=runtime 3-deno-wall.mjs <home folder>')
const win = Deno.build.os === 'windows'
const otherFile = win ? 'C:/Windows/win.ini' : '/etc/hosts'
const nativeLib = win ? 'kernel32.dll' : Deno.build.os === 'darwin' ? 'libSystem.dylib' : 'libc.so.6'

const t0 = performance.now()
const py = await loadPyodide({ indexURL: fileURLToPath(new URL('./runtime/', import.meta.url)) })
console.log(`Pyodide loaded under Deno in ${((performance.now() - t0) / 1000).toFixed(2)} s\n`)

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
  'read ~/.turbollm/config.json (if you use TurboLLM)': `try { return 'READ ' + Deno.readTextFileSync(${JSON.stringify(home + '/.turbollm/config.json')}).length + ' chars' } catch (e) { return 'blocked: ' + e.name }`,
  'read a system file with node:fs': `return import('node:fs').then(f => { try { return 'READ ' + f.readFileSync(${JSON.stringify(otherFile)}, 'utf8').length } catch (e) { return 'blocked: ' + (e.code || e.name) } })`,
  'write a file in the home folder': `try { Deno.writeTextFileSync(${JSON.stringify(home + '/spike-should-not-exist.txt')}, 'x'); return 'WROTE' } catch (e) { return 'blocked: ' + e.name }`,
  'start a program: Deno.Command': `try { new Deno.Command('whoami').outputSync(); return 'RAN' } catch (e) { return 'blocked: ' + e.name }`,
  'start a program: node:child_process': `return import('node:child_process').then(c => { try { return 'RAN ' + c.execSync('whoami') } catch (e) { return 'blocked: ' + (e.code || e.name) } })`,
  'read environment variables': `try { return 'ENV ' + Object.keys(Deno.env.toObject()).length + ' vars' } catch (e) { return 'blocked: ' + e.name }`,
  'load a native library (FFI)': `try { Deno.dlopen(${JSON.stringify(nativeLib)}, {}); return 'FFI OPEN' } catch (e) { return 'blocked: ' + e.name }`,
  'network from a Worker (workers inherit the wall)': `return new Promise(res => {
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
    // Wrapped in a promise so an attack that throws synchronously is still reported, not mistaken for a block.
    r = String(await py.runPythonAsync(`
from pyodide.ffi import to_js
F = to_js({}).constructor.constructor
await F("return Promise.resolve().then(() => (function () {" + SRC + "})())")()`))
  } catch (e) {
    r = 'blocked (Python error): ' + String(e.message).split('\n').filter(Boolean).slice(-1)[0]
  }
  const ok = r.startsWith('blocked')
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${r}`)
}
console.log(failed ? `\n${failed} attack(s) got through` : `\nall ${Object.keys(attacks).length} attacks blocked`)

// Not counted above: a Worker that asks for MORE permissions than its parent. Deno refuses, and in our run that ended
// the whole process, which is the safe outcome. Uncomment to see it.
// new Worker('data:text/javascript,1', { type: 'module', deno: { permissions: { net: true } } })

// Exit explicitly: in the control run, a connection that got through can keep the process alive.
Deno.exit(0)
