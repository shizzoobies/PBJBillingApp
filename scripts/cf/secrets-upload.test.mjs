import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SECRET_NAMES, selectSecrets, uploadSecrets } from './secrets-upload.mjs'
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
  Object.assign(values, { JWT_SECRET: ' ', SIGNWELL_TEST_MODE: 'false', INVOICE_AUTO_REMINDERS: 'off', UNRELATED_TOKEN: 'not-allowed' })
  const { secrets, skipped } = selectSecrets(values)
  assert.equal(Object.keys(secrets).length, SECRET_NAMES.length - 1)
  assert.equal(secrets.SIGNWELL_TEST_MODE, 'false')
  assert.equal(secrets.INVOICE_AUTO_REMINDERS, 'off')
  assert.equal(secrets.UNRELATED_TOKEN, undefined)
  assert.ok(skipped.includes('JWT_SECRET'))
  assert.ok(skipped.includes('UNRELATED_TOKEN'))
})

test('dry run prints only names, never invokes a command, and never modifies the file', (t) => {
  const file = fixture(t, '# preserve\r\nDATABASE_URL=synthetic-private-url\r\nJWT_SECRET=\r\nUNRELATED_TOKEN=fake-extra\r\n')
  const before = readFileSync(file, 'utf8')
  const lines = []
  const result = uploadSecrets([file, '--dry-run', '--generate'], {
    run: () => assert.fail('dry run spawned a command'),
    print: (line) => lines.push(line),
  })
  assert.ok(result.names.includes('DATABASE_URL'))
  assert.ok(result.names.includes('TICK_TOKEN'))
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.ok(!lines.join('\n').includes('synthetic-private-url'))
  assert.ok(!lines.join('\n').includes('fake-extra'))
})

test('upload sends JSON on stdin to the fixed Worker and hides child output', (t) => {
  const file = fixture(t, 'JWT_SECRET=synthetic-private-value\nOUTSIDE=fake-not-uploaded\n')
  const lines = []
  let calls = 0
  uploadSecrets([file], {
    run: (command, args, options) => {
      calls++
      assert.equal(command, 'npx')
      assert.deepEqual(args, ['--no-install', 'wrangler', 'secret', 'bulk', '--name', 'pbjbillingapp'])
      assert.deepEqual(JSON.parse(options.input), { JWT_SECRET: 'synthetic-private-value' })
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
      assert.equal(options.env.CI, 'true')
      return { status: 0, stdout: 'synthetic-private-value', stderr: 'synthetic-private-value' }
    },
    print: (line) => lines.push(line),
  })
  assert.equal(calls, 1)
  assert.ok(lines[0].startsWith('Set: JWT_SECRET'))
  assert.ok(!lines.join('\n').includes('synthetic-private-value'))
})

test('generate preserves existing values and comments; retries reuse saved generated values', (t) => {
  const file = fixture(t, '# keep this\r\nJWT_SECRET=existing-fake-value\r\nVOICE_TOOL_SECRET=\r\nOUTSIDE=preserve-me\r\n')
  const execute = () => uploadSecrets([file, '--generate'], { run: () => ({ status: 0 }), print: () => {} })
  execute()
  const text = readFileSync(file, 'utf8')
  const values = parseEnvText(text)
  assert.equal(values.JWT_SECRET, 'existing-fake-value')
  assert.match(values.VOICE_TOOL_SECRET, /^[a-f0-9]{64}$/)
  assert.match(values.TICK_TOKEN, /^[a-f0-9]{64}$/)
  assert.notEqual(values.VOICE_TOOL_SECRET, values.TICK_TOKEN)
  assert.equal(values.OUTSIDE, 'preserve-me')
  assert.ok(text.startsWith('# keep this'))
  execute()
  assert.equal(readFileSync(file, 'utf8'), text)
})

test('failed upload never prints child exceptions or claims success', (t) => {
  const file = fixture(t, 'JWT_SECRET=synthetic-private-value')
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
