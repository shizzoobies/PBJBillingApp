import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { baseUrl, healthLine, restartContainer, DEFAULT_APP_URL } from './restart.mjs'

function fixture(t, text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbj-restart-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'rotation.env')
  writeFileSync(file, text)
  return file
}

const answer = (status, body) => ({ status, json: async () => body })

test('baseUrl: flag, then APP_PUBLIC_URL, then the production domain; https only', () => {
  assert.equal(baseUrl([], {}), DEFAULT_APP_URL)
  assert.equal(baseUrl([], { APP_PUBLIC_URL: 'https://example.test/some/path' }), 'https://example.test')
  assert.equal(baseUrl(['--url=https://pbjbillingapp.example.workers.dev'], { APP_PUBLIC_URL: 'https://other.test' }), 'https://pbjbillingapp.example.workers.dev')
  assert.throws(() => baseUrl(['--url=http://app.test'], {}), /https/)
  assert.throws(() => baseUrl(['--url=not a url'], {}), /Invalid app URL/)
})

test('healthLine shows only the commit and maintenance flag', () => {
  assert.equal(healthLine(200, { commit: 'abc1234', maintenance: true, db: 'secret-looking' }), 'health: 200 commit=abc1234 maintenance=true')
  assert.equal(healthLine(200, null), 'health: 200 commit=unknown maintenance=false')
})

test('posts the token header to /internal/restart, polls /health until 200, never prints the token', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\r\n')
  const calls = []
  const lines = []
  let healthCalls = 0
  let clock = 0
  const result = await restartContainer([file], {
    env: {},
    print: (line) => lines.push(line),
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, token: init.headers?.['x-tick-token'] })
      if (url.endsWith('/internal/restart')) return answer(200, { restarted: true })
      healthCalls++
      if (healthCalls === 1) throw new Error('container starting')
      if (healthCalls === 2) return answer(503, {})
      return answer(200, { ok: true, commit: 'abc1234', maintenance: true })
    },
  })
  assert.deepEqual(calls[0], { url: DEFAULT_APP_URL + '/internal/restart', method: 'POST', token: 'synthetic-tick-token' })
  assert.equal(healthCalls, 3)
  assert.deepEqual(lines, ['restart: HTTP 200', 'health: 200 commit=abc1234 maintenance=true'])
  assert.equal(result.maintenance, true)
  assert.ok(!lines.join('\n').includes('synthetic-tick-token'))
})

test('refusals and a missing token fail with plain messages and no token', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  for (const [status, pattern] of [[404, /not uploaded/], [401, /does not match/], [500, /HTTP 500/]]) {
    await assert.rejects(
      restartContainer([file], { env: {}, print: () => {}, fetchImpl: async () => answer(status, {}) }),
      (error) => pattern.test(error.message) && !error.message.includes('synthetic-tick-token'),
    )
  }
  const blank = fixture(t, 'TICK_TOKEN=\n')
  await assert.rejects(restartContainer([blank], { env: {}, fetchImpl: () => assert.fail('no request') }), /TICK_TOKEN is blank/)
  await assert.rejects(restartContainer([file], { env: {}, fetchImpl: async () => { throw new Error('synthetic-tick-token') } }), (error) => !error.message.includes('synthetic-tick-token'))
})

test('gives up after 90 seconds without a 200', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  let clock = 0
  await assert.rejects(
    restartContainer([file], {
      env: {},
      print: () => {},
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      fetchImpl: async (url) => (url.endsWith('/internal/restart') ? answer(200, {}) : answer(503, {})),
    }),
    /90 seconds/,
  )
  assert.ok(clock >= 90_000)
})

test('unknown flags are refused without echoing them', async () => {
  await assert.rejects(restartContainer(['--synthetic-private-value'], { env: {} }), (error) => !error.message.includes('synthetic-private-value'))
})
