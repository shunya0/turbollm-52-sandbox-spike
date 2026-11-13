// Experiment 7: a real install with TurboLLM PR 1's code (#313) on this OS, then the PR 2 launch-flag question, asked
// of the Deno that install put on disk. Fails if any claim does not hold. Writes a results table to the GitHub Actions
// job summary when run in CI.
//
//   TURBOLLM_DIR=<TurboLLM/turbollm at the PR 1 branch, after npm ci> node ci/pr1-check.mjs
//
// Everything goes into a new folder under the system temp folder; nothing outside it is written or removed.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'ci-out')
mkdirSync(OUT, { recursive: true })
const turbollm = process.env.TURBOLLM_DIR
if (!turbollm) throw new Error('TURBOLLM_DIR is not set')
// realpath: on Windows runners the temp folder is an 8.3 short name, and Deno compares --allow-read paths after resolving.
const WORK = join(realpathSync.native(tmpdir()), `pr1-check-${process.pid}-${Date.now()}`)
mkdirSync(WORK)
const results = []

function run(cmd, args, { cwd = ROOT, env = process.env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, shell: false })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => { out += `\n[runner] killed after ${timeoutMs / 1000} s`; p.kill('SIGKILL') }, timeoutMs)
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }) })
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e) }) })
  })
}

function listener() {
  let hits = 0
  const s = createServer((req, res) => { hits++; res.writeHead(201); res.end('{}') })
  return new Promise((r) => s.listen(6996, '127.0.0.1', () => r({ hits: () => hits, close: () => s.close() })))
}

async function check(id, claim, fn) {
  const t0 = Date.now()
  let ok = false, detail = ''
  try { [ok, detail] = await fn() } catch (e) { detail = 'runner error: ' + e.message }
  results.push({ id, claim, ok, detail })
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}  (${((Date.now() - t0) / 1000).toFixed(0)} s)\n      ${detail}`)
}

const val = (out, key) => (out.match(new RegExp(`^${key} (.*)$`, 'm')) || [])[1]?.trim()
const du = (p) => statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + du(join(p, f)), 0) : statSync(p).size
const MB = (b) => `${(b / 1e6).toFixed(0)} MB`
const tsx = join(turbollm, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const install = () => run(process.execPath, [tsx, join(ROOT, 'pr1', 'install.mts'), turbollm, join(WORK, 'runtimes')], { timeoutMs: 600_000 })

let deno = '', pyodide = ''
await check('7a', 'PR 1 installs Deno + Pyodide from the real hosts, every pinned size and SHA-256 matching', async () => {
  const { code, out } = await install()
  writeFileSync(join(OUT, 'pr1-install.log'), out)
  deno = val(out, 'DENO') ?? ''
  pyodide = val(out, 'PYODIDE') ?? ''
  const after = val(out, 'AFTER') ?? ''
  const ok = code === 0 && /installed \{"deno":"2\.9\.6","pyodide":"0\.29\.5"\}/.test(after)
  const disk = ok ? du(join(WORK, 'runtimes', 'sandbox')) : 0
  return [ok, ok ? `${val(out, 'SECONDS')} s, ${MB(disk)} on disk, ${readdirSync(pyodide).length} files in the Pyodide folder` : out.slice(-600)]
})

await check('7b', 'A second install is a no-op (the marker is trusted, nothing re-downloads)', async () => {
  const { code, out } = await install()
  const secs = Number(val(out, 'SECONDS'))
  return [code === 0 && /installed true/.test(val(out, 'BEFORE') ?? '') && secs < 2, `${secs} s, before: ${val(out, 'BEFORE')}`]
})

await check('7c', 'The installed Deno runs (exec bit set by the installer on macOS and Linux)', async () => {
  const { code, out } = await run(deno, ['--version'])
  return [code === 0 && /deno 2\.9\.6/.test(out), out.split('\n')[0]]
})

// One fresh folder and one fresh DENO_DIR per launch option, so no option sees another's cache.
const OPTIONS = [
  { id: 'A', flags: ['--no-config', '--no-npm', '--no-remote', '--unstable-detect-cjs'], packageJson: false, expectLoad: true,
    claim: 'Option A (full lock-down + --unstable-detect-cjs): Python works, 12/12 attacks blocked, listener gets nothing' },
  { id: 'B', flags: ['--no-remote'], packageJson: true, expectLoad: true,
    claim: 'Option B (daemon-owned folder with package.json, --no-remote only): Python works, 12/12 blocked, listener gets nothing' },
  { id: 'C', flags: ['--no-config', '--no-npm', '--no-remote'], packageJson: false, expectLoad: false,
    claim: 'Control C (A without --unstable-detect-cjs): Pyodide does not load, so A needs the flag' },
  { id: 'D', flags: ['--no-remote', '--allow-net', '--allow-env'], packageJson: true, expectLoad: true, expectThrough: true,
    claim: 'Control D (B with network and env granted): the same attacks get through, so this harness can tell' },
]
for (const o of OPTIONS) {
  await check(`7-${o.id}`, o.claim, async () => {
    const cwd = join(WORK, `option-${o.id}`)
    mkdirSync(cwd)
    copyFileSync(join(ROOT, 'pr1', 'host.mjs'), join(cwd, 'host.mjs'))
    if (o.packageJson) writeFileSync(join(cwd, 'package.json'), '{"private":true,"type":"module"}\n')
    const env = { ...process.env, DENO_DIR: join(WORK, `deno-dir-${o.id}`), NO_COLOR: '1' }
    const l = await listener()
    const { out } = await run(deno, ['run', '--no-prompt', ...o.flags, `--allow-read=${pyodide}`, 'host.mjs', pyodide, homedir()], { cwd, env })
    l.close()
    writeFileSync(join(OUT, `pr1-option-${o.id}.log`), out)
    const loaded = val(out, 'LOADED in')
    if (!o.expectLoad) return [!loaded && /LOAD FAILED/.test(out), loaded ? `it loaded: ${loaded}` : val(out, 'LOAD FAILED') ?? out.slice(-300)]
    const blocked = val(out, 'BLOCKED') ?? '?'
    if (o.expectThrough) {
      const through = (out.match(/^FAIL /gm) || []).length
      return [through >= 5 && l.hits() > 0, `${through} got through, listener received ${l.hits()}`]
    }
    return [!!loaded && blocked === '12/12' && l.hits() === 0, loaded
      ? `${blocked} blocked, listener received ${l.hits()}; ${loaded}`
      : (val(out, 'LOAD FAILED') ?? out.slice(-300))]
  })
}

const failed = results.filter((r) => !r.ok)
const os = `${process.platform} ${process.arch}`
let md = `## PR 1 real install + PR 2 launch options on ${os}\n\n| # | Claim | Result | Detail |\n|---|---|---|---|\n`
for (const r of results) md += `| ${r.id} | ${r.claim} | ${r.ok ? '✅ pass' : '❌ fail'} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |\n`
writeFileSync(join(OUT, 'pr1-results.md'), md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
console.log(`\n${results.length - failed.length}/${results.length} checks passed on ${os}`)
process.exit(failed.length ? 1 : 0)
