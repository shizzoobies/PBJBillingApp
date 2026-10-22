import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tailWorker } from './tail.mjs'

test('tail skips without authentication and does not resolve or launch Wrangler', async () => {
  const lines = []
  await tailWorker({ env: {}, resolveCli: () => assert.fail('attempted login'), print: (line) => lines.push(line) })
  assert.match(lines.join('\n'), /no browser login attempted/)
})

test('tail reports a missing dependency without a browser login', async () => {
  const lines = []
  await tailWorker({ env: { CLOUDFLARE_API_TOKEN: 'fake' }, resolveCli: () => { throw Error('missing') }, print: (line) => lines.push(line) })
  assert.match(lines.join('\n'), /locked Wrangler dependency/)
})

test('tail terminates the real CLI process and closes its pipes at the timeout', { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbj-tail-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cli = path.join(dir, 'cli.mjs')
  const pidFile = path.join(dir, 'pid')
  writeFileSync(cli, "import fs from 'node:fs'; fs.writeFileSync(process.env.PID_FILE,String(process.pid)); console.log('fake tail event'); setInterval(()=>{},1000);")
  const lines = []
  const start = Date.now()
  await tailWorker({ env: { ...process.env, CLOUDFLARE_API_TOKEN: 'fake', PID_FILE: pidFile }, resolveCli: () => cli, durationMs: 1000, print: (line) => lines.push(line) })
  assert.ok(Date.now() - start < 5000)
  assert.match(lines.join('\n'), /fake tail event/)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
})

test('tail suppresses failed child stderr and reports skipped logs', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbj-tail-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cli = path.join(dir, 'cli.mjs')
  writeFileSync(cli, "console.error('synthetic-private-value'); process.exit(1)")
  const lines = []
  await tailWorker({ env: { ...process.env, CLOUDFLARE_API_TOKEN: 'fake' }, resolveCli: () => cli, print: (line) => lines.push(line) })
  assert.match(lines.join('\n'), /Skipped Wrangler tail/)
  assert.ok(!lines.join('\n').includes('synthetic-private-value'))
})
