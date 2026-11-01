// Runs every experiment as its own process, checks each result against what the spike claims, and fails if any
// claim does not hold. Writes a results table to the GitHub Actions job summary when run in CI.
//
//   node ci/run-all.mjs                       (experiment 2 is skipped unless TURBOLLM_DIR is set)
//   TURBOLLM_DIR=<path to TurboLLM/turbollm> node ci/run-all.mjs
//
// Needs `npm ci` and `node fetch-runtime.mjs` first, plus Node 22+ and Deno 2.x on PATH.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('..', import.meta.url)
const OUT = join(fileURLToPath(ROOT), 'ci-out')
mkdirSync(OUT, { recursive: true })
const results = []
const timings = []

function run(cmd, args, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: false })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => { out += `\n[runner] killed after ${timeoutMs / 1000} s`; p.kill('SIGKILL') }, timeoutMs)
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }) })
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e) }) })
  })
}

// A stand-in daemon on 127.0.0.1:6996 that counts every request (experiment 3 and its control run).
function listener() {
  let hits = 0
  const s = createServer((req, res) => { hits++; res.writeHead(201); res.end('{}') })
  return new Promise((r) => s.listen(6996, '127.0.0.1', () => r({ hits: () => hits, close: () => s.close() })))
}

// ONLY=1,3,6 runs just those checks (handy on a machine with little free memory).
const only = process.env.ONLY?.split(',')

async function check(id, claim, fn) {
  if (only && !only.includes(id)) return
  const t0 = Date.now()
  let ok = false, detail = ''
  try { [ok, detail] = await fn() } catch (e) { detail = 'runner error: ' + e.message }
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  results.push({ id, claim, ok, detail })
  console.log(`\n${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}  (${secs} s)\n      ${detail}`)
}

const line = (out, re) => (out.match(re) || [])[0] || ''
const deno = (...a) => run('deno', ['run', '--no-prompt', ...a])

await check('1', 'Pyodide alone is not a sandbox: hardened Python reaches node:http', async () => {
  const { out } = await run('node', ['1-escape-node.mjs'])
  const got = line(out, /Python got back: .*/)
  return [/HTTP 201/.test(got) && /listener received: \[/.test(out), got || out.slice(-300)]
})

await check('2', 'Same escape against a real TurboLLM daemon saves an MCP server entry', async () => {
  const dir = process.env.TURBOLLM_DIR
  if (!dir) return [null, 'TURBOLLM_DIR not set']
  const { out } = await run('node', ['2-escape-real-daemon.mjs', dir], 240_000)
  const got = line(out, /Python got back: HTTP \d+/), after = line(out, /config mcp.servers AFTER:.*/)
  return [/HTTP 201/.test(got) && /spike-escape/.test(after), `${got} | ${after.slice(0, 160)}` || out.slice(-300)]
})

await check('3', 'Pyodide inside Deno with no permissions: all 12 attacks blocked, listener gets nothing', async () => {
  const l = await listener()
  const { out } = await deno('--allow-read=runtime', '3-deno-wall.mjs', homedir())
  l.close()
  const failed = (out.match(/^FAIL /gm) || []).length
  return [/all 12 attacks blocked/.test(out) && l.hits() === 0, `${12 - failed}/12 blocked, listener received ${l.hits()}`]
})

await check('3c', 'Control: with permissions granted, the same attacks get through (the test is real)', async () => {
  const l = await listener()
  const { out } = await deno('--allow-read', '--allow-net', '--allow-env', '3-deno-wall.mjs', homedir())
  l.close()
  const through = (out.match(/^FAIL /gm) || []).length
  return [through >= 5 && l.hits() > 0, `${through} got through, listener received ${l.hits()}`]
})

await check('4', 'Real use cases run offline inside the wall and hand files back over stdout', async () => {
  const { out } = await deno('--allow-read=runtime', '4-use-cases.mjs', '--emit')
  const oks = (out.match(/^OK /gm) || []).length
  for (const m of out.matchAll(/^FILE (\S+) (\S+)$/gm)) writeFileSync(join(OUT, m[1]), Buffer.from(m[2], 'base64'))
  const files = [...out.matchAll(/^FILE (\S+)/gm)].map((m) => m[1])
  const good = oks === 4 && /EMI = 19,812\.20/.test(out) && /roots \[1, 2, 3\]/.test(out) && files.length === 4
  return [good, `${oks}/4 OK, ${line(out, /EMI = [\d,.]+/)}, ${line(out, /roots \[[^\]]*\]/)}, files back: ${files.join(', ')}, ${line(out, /final rss .*/)}`]
})

for (const [rt, cmd, args] of [['deno', 'deno', ['run', '--no-prompt', '--allow-read=runtime', '4b-start-timing.mjs']], ['node', 'node', ['4b-start-timing.mjs']]]) {
  await check(`4b-${rt}`, `Start-up timing under ${rt} (measured, no pass threshold)`, async () => {
    const { code, out } = await run(cmd, args)
    const steps = [...out.matchAll(/^\S+ \S+\s+(.+?)\s+([\d.]+) s\s+rss (\d+) MB/gm)]
    const total = steps.reduce((s, m) => s + Number(m[2]), 0)
    timings.push({ rt, total: total.toFixed(1), rss: steps.at(-1)?.[3], steps: steps.map((m) => `${m[1].trim()} ${m[2]} s`) })
    return [code === 0 && steps.length === 9, `${total.toFixed(1)} s in all, rss ${steps.at(-1)?.[3]} MB`]
  })
}

await check('5', 'Memory cap: MemoryError under 512 MB, Python still usable, escaped wasm growth refused', async () => {
  const { out } = await deno('--allow-read=runtime', '--v8-flags=--wasm-max-mem-pages=8192', '5-memory.mjs', 'escaped')
  const mem = Number((out.match(/MemoryError after (\d+) MB/) || [])[1])
  const good = mem > 0 && mem <= 500 && /1 \+ 1 = 2/.test(out) && /WebAssembly\.Memory: refused/.test(out)
  return [good, `${line(out, /MemoryError after \d+ MB/) || 'no MemoryError'}; ${line(out, /peak rss about \d+ MB/)}; ${line(out, /escaped JS: .*/)}`]
})

await check('6', 'Stop: a Python loop is interrupted and keeps state; a C loop needs a hard kill', async () => {
  const { out } = await deno('--allow-read=runtime,6-stop-worker.mjs', '6-stop.mjs')
  const pyLoop = line(out, /Python loop.*/), kept = line(out, /variable set.*/), cLoop = line(out, /C loop.*/)
  const good = /KeyboardInterrupt/.test(pyLoop) && /kept/.test(kept) && /did NOT stop/.test(cLoop) && /worker terminated/.test(out)
  return [good, `${pyLoop.replace(/\s+/g, ' ')} | ${cLoop.replace(/\s+/g, ' ')}`]
})

const failed = results.filter((r) => r.ok === false)
const os = `${process.platform} ${process.arch}`
let md = `## Sandbox spike on ${os}\n\n| # | Claim | Result | Detail |\n|---|---|---|---|\n`
for (const r of results) md += `| ${r.id} | ${r.claim} | ${r.ok === null ? 'skipped' : r.ok ? '✅ pass' : '❌ fail'} | ${r.detail.replace(/\|/g, '\\|')} |\n`
md += `\n### Start-up on this machine\n\n| Runtime | Total | RSS at end | Steps |\n|---|---|---|---|\n`
for (const t of timings) md += `| ${t.rt} | ${t.total} s | ${t.rss} MB | ${t.steps.join('; ')} |\n`
writeFileSync(join(OUT, 'results.md'), md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
console.log(`\n${results.length - failed.length}/${results.length} checks passed or skipped on ${os}`)
process.exit(failed.length ? 1 : 0)
