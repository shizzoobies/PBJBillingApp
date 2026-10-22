import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CONTAINER_ENV_NAMES } from '../../cloudflare/env-names.js'
import { SECRET_NAMES, WRANGLER_VARS, assertMaintenanceGate, parseJsonc, selectSecrets, uploadSecrets } from './secrets-upload.mjs'
import { parseEnvText } from '../prod/env.mjs'

function fixture(t, text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbj-upload-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'rotation.env')
  writeFileSync(file, text)
  return file
}

test('allow-list keeps only approved nonblank names, including false and off', () => {
  const values = Object.fromEntries(SECRET_NAMES.map((name) => [name, 'fake-' + name]))
  Object.assign(values, { VOICE_TOOL_SECRET: ' ', SIGNWELL_TEST_MODE: 'false', INVOICE_AUTO_REMINDERS: 'off', UNRELATED_TOKEN: 'not-allowed' })
  const { secrets, skipped } = selectSecrets(values)
  assert.equal(Object.keys(secrets).length, SECRET_NAMES.length - 1)
  assert.equal(secrets.SIGNWELL_TEST_MODE, 'false')
  assert.equal(secrets.INVOICE_AUTO_REMINDERS, 'off')
  assert.equal(secrets.UNRELATED_TOKEN, undefined)
  assert.ok(skipped.includes('VOICE_TOOL_SECRET'))
  assert.ok(skipped.includes('UNRELATED_TOKEN'))
})

test('secret names are exactly the container names minus the wrangler.jsonc vars', () => {
  assert.deepEqual([...WRANGLER_VARS].sort(), ['APP_PUBLIC_URL', 'FIRM_TIME_ZONE', 'NODE_ENV'])
  assert.deepEqual([...SECRET_NAMES], CONTAINER_ENV_NAMES.filter((name) => !WRANGLER_VARS.includes(name)))
  // The settings that used to be "deliberately absent" now travel as secrets: the repo is public.
  for (const name of ['MAINTENANCE_MODE', 'OWNER_EMAIL', 'ADMIN_EMAIL', 'EMAIL_FROM', 'INVOICE_EMAIL_FROM', 'INVOICE_REPLY_TO', 'ELEVENLABS_AGENT_ID', 'AUTOPAY_CHARGING', 'INVOICE_PAST_DUE_NOTICES', 'ASSISTANT_DIGEST']) {
    assert.ok(SECRET_NAMES.includes(name), name)
  }
  for (const name of WRANGLER_VARS) assert.ok(!SECRET_NAMES.includes(name), name)
})

test('parseJsonc keeps // inside strings, drops comments and trailing commas', () => {
  const parsed = parseJsonc('{ // note\n "url": "https://x.test/a", /* block */ "list": [1, 2,],\n}')
  assert.deepEqual(parsed, { url: 'https://x.test/a', list: [1, 2] })
  assert.throws(() => parseJsonc('{ /* open'), /Unterminated/)
})

test('a database upload without MAINTENANCE_MODE is refused unless --allow-live', (t) => {
  const file = fixture(t, 'DATABASE_URL=synthetic-private-url\nMAINTENANCE_MODE=  \n')
  const noRun = () => assert.fail('refused upload spawned a command')
  assert.throws(() => uploadSecrets([file], { run: noRun, print: () => {} }), (error) => {
    assert.match(error.message, /DATABASE_URL/)
    assert.match(error.message, /MAINTENANCE_MODE/)
    assert.ok(!error.message.includes('synthetic-private-url'))
    return true
  })
  assert.throws(() => uploadSecrets([file, '--dry-run'], { run: noRun, print: () => {} }), /MAINTENANCE_MODE/)
  let calls = 0
  uploadSecrets([file, '--allow-live'], { run: () => { calls++; return { status: 0 } }, print: () => {} })
  assert.equal(calls, 1)
})

test('the gate passes when MAINTENANCE_MODE is exactly 1, or when there is no database', () => {
  assert.doesNotThrow(() => assertMaintenanceGate({ DATABASE_URL: 'x', MAINTENANCE_MODE: '1' }))
  assert.doesNotThrow(() => assertMaintenanceGate({ VOICE_TOOL_SECRET: 'x' }))
  assert.doesNotThrow(() => assertMaintenanceGate({ DATABASE_URL: ' ' }))
  assert.throws(() => assertMaintenanceGate({ DATABASE_URL: 'x' }), /MAINTENANCE_MODE must be 1 \(or pass --allow-live\)/)
})

test('the gate uses the app\'s rule: "0", "true", " " and padded values are refused, --allow-live overrides', () => {
  for (const value of ['0', 'true', ' ', '', '01', 'on', 'yes']) {
    assert.throws(
      () => assertMaintenanceGate({ DATABASE_URL: 'x', MAINTENANCE_MODE: value }),
      /MAINTENANCE_MODE must be 1 \(or pass --allow-live\)/,
      JSON.stringify(value),
    )
    assert.doesNotThrow(() => assertMaintenanceGate({ DATABASE_URL: 'x', MAINTENANCE_MODE: value }, true), JSON.stringify(value))
  }
})

test('an upload with MAINTENANCE_MODE=0 and a database is refused end to end, and --allow-live is the way to go live', (t) => {
  const file = fixture(t, 'DATABASE_URL=synthetic-private-url\nMAINTENANCE_MODE=0\n')
  assert.throws(() => uploadSecrets([file], { run: () => assert.fail('spawned'), print: () => {} }), /MAINTENANCE_MODE must be 1/)
  let calls = 0
  uploadSecrets([file, '--allow-live'], { run: () => { calls++; return { status: 0 } }, print: () => {} })
  assert.equal(calls, 1)
})

test('dry run prints only names, never invokes a command, and never modifies the file', (t) => {
  const file = fixture(t, '# preserve\r\nDATABASE_URL=synthetic-private-url\r\nMAINTENANCE_MODE=1\r\nVOICE_TOOL_SECRET=\r\nUNRELATED_TOKEN=fake-extra\r\n')
  const before = readFileSync(file, 'utf8')
  const lines = []
  const result = uploadSecrets([file, '--dry-run', '--generate'], {
    run: () => assert.fail('dry run spawned a command'),
    print: (line) => lines.push(line),
  })
  assert.ok(result.names.includes('DATABASE_URL'))
  assert.ok(result.names.includes('TICK_TOKEN'))
  assert.ok(!result.names.includes('ENV_REVISION'), 'a dry run stamps no revision')
  assert.equal(result.revision, null)
  assert.ok(!lines.join('\n').includes('Env revision'))
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.ok(!lines.join('\n').includes('synthetic-private-url'))
  assert.ok(!lines.join('\n').includes('fake-extra'))
})

test('upload sends JSON on stdin to the fixed Worker and hides child output', (t) => {
  const file = fixture(t, 'VOICE_TOOL_SECRET=synthetic-private-value\nOUTSIDE=fake-not-uploaded\n')
  const lines = []
  let calls = 0
  uploadSecrets([file], {
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    run: (command, args, options) => {
      calls++
      assert.equal(command, 'npx')
      assert.deepEqual(args, ['--no-install', 'wrangler', 'secret', 'bulk', '--name', 'pbjbillingapp'])
      assert.deepEqual(JSON.parse(options.input), { VOICE_TOOL_SECRET: 'synthetic-private-value', ENV_REVISION: '2026-10-21T12:00:00.000Z' })
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
      assert.equal(options.env.CI, 'true')
      return { status: 0, stdout: 'synthetic-private-value', stderr: 'synthetic-private-value' }
    },
    print: (line) => lines.push(line),
  })
  assert.equal(calls, 1)
  assert.equal(lines[0], 'Set: VOICE_TOOL_SECRET, ENV_REVISION')
  assert.ok(lines[1].startsWith('Skipped: DATABASE_URL') && !lines[1].includes('ENV_REVISION'))
  assert.match(lines[2], /^Env revision: 2026-10-21T12:00:00\.000Z .*--expect-revision=2026-10-21T12:00:00\.000Z/)
  assert.ok(!lines.join('\n').includes('synthetic-private-value'))
})

test('every real upload stamps a fresh ENV_REVISION that replaces any value in the file', (t) => {
  const file = fixture(t, 'ENV_REVISION=stale-from-file\nVOICE_TOOL_SECRET=fake\n')
  const sent = []
  const run = (command, args, options) => { sent.push(JSON.parse(options.input)); return { status: 0 } }
  const first = uploadSecrets([file], { run, print: () => {}, now: () => new Date('2026-10-21T12:00:00.000Z') })
  const second = uploadSecrets([file], { run, print: () => {}, now: () => new Date('2026-10-21T12:00:01.000Z') })
  assert.equal(sent[0].ENV_REVISION, '2026-10-21T12:00:00.000Z')
  assert.equal(sent[1].ENV_REVISION, '2026-10-21T12:00:01.000Z')
  assert.equal(first.revision, sent[0].ENV_REVISION)
  assert.notEqual(first.revision, second.revision)
  assert.ok(!first.skipped.includes('ENV_REVISION'))
  assert.ok(SECRET_NAMES.includes('ENV_REVISION'))
})

test('generate preserves existing values and comments; retries reuse saved generated values', (t) => {
  const file = fixture(t, '# keep this\r\nTICK_TOKEN=existing-fake-value\r\nVOICE_TOOL_SECRET=\r\nOUTSIDE=preserve-me\r\n')
  const execute = () => uploadSecrets([file, '--generate'], { run: () => ({ status: 0 }), print: () => {} })
  execute()
  const text = readFileSync(file, 'utf8')
  const values = parseEnvText(text)
  assert.equal(values.TICK_TOKEN, 'existing-fake-value')
  assert.match(values.VOICE_TOOL_SECRET, /^[a-f0-9]{64}$/)
  assert.equal(values.JWT_SECRET, undefined, 'JWT_SECRET is not an app setting and is never generated')
  assert.equal(values.OUTSIDE, 'preserve-me')
  assert.ok(text.startsWith('# keep this'))
  execute()
  assert.equal(readFileSync(file, 'utf8'), text)
})

test('failed upload never prints child exceptions or claims success', (t) => {
  const file = fixture(t, 'VOICE_TOOL_SECRET=synthetic-private-value')
  for (const run of [
    () => ({ status: 1, stderr: 'synthetic-private-value' }),
    () => ({ status: null, error: new Error('synthetic-private-value') }),
    () => { throw new Error('synthetic-private-value') },
  ]) {
    const lines = []
    assert.throws(() => uploadSecrets([file], { run, print: (line) => lines.push(line) }), (error) => {
      assert.match(error.message, /Secret upload failed/)
      assert.ok(!error.message.includes('synthetic-private-value'))
      return true
    })
    assert.equal(lines.length, 0)
  }
})

test('an empty allow-list makes no network call; unknown flags fail without echoing input', (t) => {
  const file = fixture(t, 'OUTSIDE=fake')
  uploadSecrets([file], { run: () => assert.fail('empty upload'), print: () => {} })
  assert.throws(() => uploadSecrets(['--synthetic-private-value']), (error) => !error.message.includes('synthetic-private-value'))
})
