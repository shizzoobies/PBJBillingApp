import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { prodEnv, parseEnvText, readEnvFile, prodDatabaseUrl } from './env.mjs'

function fixture(t, text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbj-env-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'prod.env')
  writeFileSync(file, text)
  return { dir, file }
}

test('environment wins per name, and only requested names are returned', (t) => {
  const { file } = fixture(t, '# comment\r\nA=file-value\r\nB="with = and #"\r\nC=ignored\r\n')
  assert.deepEqual(prodEnv(['A', 'B'], { env: { A: 'env-value', PBJ_PROD_ENV_FILE: file } }),
    { A: 'env-value', B: 'with = and #' })
  assert.deepEqual(prodEnv(['A'], { env: { A: 'ready' }, readFile: () => assert.fail('unneeded file read') }), { A: 'ready' })
})

test('missing, unreadable and malformed files report names/path without values', (t) => {
  const { file } = fixture(t, 'A=synthetic-private-value\nB= \n')
  assert.throws(() => prodEnv(['B'], { env: { PBJ_PROD_ENV_FILE: file } }), (error) => {
    assert.match(error.message, /missing B/)
    assert.ok(error.message.includes(file))
    assert.ok(!error.message.includes('synthetic-private-value'))
    return true
  })
  writeFileSync(file, 'malformed-synthetic-private-value')
  assert.throws(() => prodEnv(['A'], { env: { PBJ_PROD_ENV_FILE: file } }), (error) => {
    assert.ok(error.message.includes(file))
    assert.ok(!error.message.includes('synthetic-private-value'))
    return true
  })
  assert.throws(() => prodEnv(['A'], { env: { PBJ_PROD_ENV_FILE: file + '.absent' } }), /missing A/)
})

test('empty env falls back; parser preserves literal shell syntax and rejects malformed quotes', (t) => {
  const { file } = fixture(t, "A='$(literal) = # value'\nB=abc#def\n")
  assert.equal(prodEnv(['A'], { env: { A: ' ', PBJ_PROD_ENV_FILE: file } }).A, '$(literal) = # value')
  assert.equal(parseEnvText('B=abc#def').B, 'abc#def')
  assert.throws(() => parseEnvText('A="fake-private-value'), (error) => !error.message.includes('fake-private-value'))
})

test('env files inside any git worktree are rejected', (t) => {
  const { dir, file } = fixture(t, 'A=fake')
  writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere')
  assert.throws(() => readEnvFile(file), /outside a git repository/)
  // Ancestors count too.
  mkdirSync(path.join(dir, 'nested'))
  const nested = path.join(dir, 'nested', 'prod.env')
  writeFileSync(nested, 'A=fake')
  assert.throws(() => readEnvFile(nested), /outside a git repository/)
})

test('TLS cannot be downgraded by URL flags or PGSSLMODE', () => {
  const url = prodDatabaseUrl('postgresql://fake:fake@db.example.invalid/pbj')
  assert.equal(new URL(url).searchParams.get('sslmode'), 'verify-full')
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } })
  assert.ok(client.ssl)
  assert.notEqual(client.ssl.rejectUnauthorized, false)
  for (const suffix of ['?sslmode=disable', '?sslmode=require', '?sslmode=no-verify', '?ssl=false',
    '?sslmode=verify-full&sslmode=disable', '?uselibpqcompat=true']) {
    assert.throws(() => prodDatabaseUrl('postgres://fake:fake@db.example.invalid/pbj' + suffix), /verify-full/)
  }
  assert.throws(() => prodDatabaseUrl('synthetic-private-value'), (error) => !error.message.includes('synthetic-private-value'))
})
