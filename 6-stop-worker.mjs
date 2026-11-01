// Worker for experiment 6: runs Pyodide and watches a shared interrupt flag set by the main thread.
import { loadPyodide } from './runtime/pyodide.mjs'
import { fileURLToPath } from 'node:url'

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    self.py = await loadPyodide({ indexURL: fileURLToPath(new URL('./runtime/', import.meta.url)) })
    self.py.setInterruptBuffer(new Int32Array(data.sab))
    self.py.runPython('state = "kept"')
    postMessage({ type: 'ready' })
  } else if (data.type === 'run') {
    const t0 = performance.now()
    let r
    try { r = String(self.py.runPython(data.code)) } catch (e) { r = String(e.message).split('\n').filter(Boolean).slice(-1)[0] }
    postMessage({ type: 'done', r, secs: ((performance.now() - t0) / 1000).toFixed(2) })
  }
}
