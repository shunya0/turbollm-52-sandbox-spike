// Experiment 4: do the real use cases work offline, inside the Deno wall, and how much memory do they take?
//
// Loads numpy, pandas, matplotlib, sympy and Pillow from ./runtime (no network permission at all), then runs:
//   CSV -> monthly totals + chart, a loan EMI schedule, solving an equation + plot, resizing a photo.
// Output files stay in Pyodide's in-memory file system; only their sizes are printed.
//
//   deno run --no-prompt --allow-read=runtime 4-use-cases.mjs [--emit]
import { loadPyodide } from './runtime/pyodide.mjs'
import { fileURLToPath } from 'node:url'

const mb = () => (Deno.memoryUsage().rss / 1e6).toFixed(0) + ' MB'
const secs = (t0) => ((performance.now() - t0) / 1000).toFixed(2) + ' s'

let t0 = performance.now()
const py = await loadPyodide({ indexURL: fileURLToPath(new URL('./runtime/', import.meta.url)) })
console.log('Pyodide core loaded', secs(t0), 'rss', mb())

t0 = performance.now()
await py.loadPackage(['numpy', 'pandas', 'matplotlib', 'sympy', 'pillow'], { messageCallback: () => {} })
py.runPython('import numpy, pandas, matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt, sympy, PIL')
console.log('libraries loaded and imported', secs(t0), 'rss', mb(), '\n')

const cases = {
  'CSV -> monthly totals + chart.png': `
import os, random, pandas as pd
random.seed(1)
os.makedirs('/work', exist_ok=True)
rows = ["date,amount"] + [f"2026-{m:02d}-{d:02d},{random.randint(500,5000)}" for m in range(1,11) for d in range(1,29)]
open('/work/sales.csv','w').write("\\n".join(rows))
df = pd.read_csv('/work/sales.csv', parse_dates=['date'])
m = df.groupby(df.date.dt.to_period('M')).amount.sum()
ax = m.plot(kind='bar', title='Revenue by month'); ax.figure.tight_layout(); ax.figure.savefig('/work/revenue.png', dpi=100)
f"best month {m.idxmax()} = {m.max()}, chart {os.path.getsize('/work/revenue.png')} bytes"`,
  'Loan EMI (₹20L, 8.6%, 15 years) + schedule.csv': `
P, r, n = 2_000_000, 0.086/12, 180
emi = P*r*(1+r)**n/((1+r)**n-1)
bal, rows = P, ["month,interest,principal,balance"]
for k in range(1, n+1):
    i = bal*r; p = emi-i; bal -= p; rows.append(f"{k},{i:.2f},{p:.2f},{max(bal,0):.2f}")
open('/work/schedule.csv','w').write("\\n".join(rows))
f"EMI = {emi:,.2f}; schedule rows = {n}"`,
  'Solve x^3-6x^2+11x-6=0 + plot.png': `
import sympy as sp, numpy as np, matplotlib.pyplot as plt
x = sp.symbols('x'); roots = sp.solve(x**3-6*x**2+11*x-6, x)
xs = np.linspace(0,4,200); plt.figure(); plt.plot(xs, xs**3-6*xs**2+11*xs-6); plt.axhline(0); plt.savefig('/work/plot.png')
f"roots {roots}"`,
  'Resize a 4000x3000 photo -> JPG': `
import os
from PIL import Image
Image.new('RGB', (4000, 3000), (200, 120, 40)).save('/work/photo.png')
im = Image.open('/work/photo.png'); im.thumbnail((1080, 1080)); im.save('/work/photo.jpg', quality=85)
f"resized to {im.size}, {os.path.getsize('/work/photo.jpg')} bytes"`,
}
for (const [name, code] of Object.entries(cases)) {
  t0 = performance.now()
  try { const r = py.runPython(code); console.log(`OK    ${name.padEnd(48)} ${secs(t0).padStart(7)}  ${r}`) }
  catch (e) { console.log(`FAIL  ${name}: ${String(e.message).split('\n').filter(Boolean).slice(-1)[0]}`) }
}
console.log('\nfiles made:', py.runPython(`import os; ", ".join(f"{f} ({os.path.getsize('/work/'+f)} B)" for f in sorted(os.listdir('/work')))`))
console.log('final rss', mb())

// With --emit, the files are written to stdout as base64 lines, the way the sandbox would hand files back to the
// daemon over its pipe. Deno still has no write permission; ci/run-all.mjs saves them on the outside.
if (Deno.args.includes('--emit')) {
  for (const f of ['revenue.png', 'plot.png', 'photo.jpg', 'schedule.csv']) {
    const bytes = py.FS.readFile('/work/' + f)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    console.log(`FILE ${f} ${btoa(bin)}`)
  }
}
