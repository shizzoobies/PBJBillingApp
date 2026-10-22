import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  baseUrl,
  describeHealth,
  expectedRevision,
  healthLine,
  reportedRevision,
  restartContainer,
  DEFAULT_APP_URL,
  MAX_EXTRA_RESTARTS,
  RESTART_GAP_MS,
} from './restart.mjs'

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

test('healthLine adds the env revision only when the app reports one', () => {
  assert.equal(
    healthLine(200, { commit: 'abc1234', maintenance: false, envRevision: '2026-10-21T12:00:00.000Z' }),
    'health: 200 commit=abc1234 maintenance=false envRevision=2026-10-21T12:00:00.000Z',
  )
  assert.equal(healthLine(200, { commit: 'abc1234', envRevision: null }), 'health: 200 commit=abc1234 maintenance=false')
})

test('expectedRevision reads --expect-revision=, defaults to none, refuses a blank value', () => {
  assert.equal(expectedRevision([]), null)
  assert.equal(expectedRevision(['x.env', '--url=https://a.test']), null)
  assert.equal(expectedRevision(['--expect-revision=2026-10-21T12:00:00.000Z']), '2026-10-21T12:00:00.000Z')
  assert.throws(() => expectedRevision(['--expect-revision=']), /needs a value/)
  assert.throws(() => expectedRevision(['--expect-revision=  ']), /needs a value/)
})

test('reportedRevision and describeHealth show only safe fields, in a fixed order', () => {
  assert.equal(reportedRevision({ envRevision: 'r1' }), 'r1')
  assert.equal(reportedRevision({ envRevision: null }), null)
  assert.equal(reportedRevision({ envRevision: 5 }), null)
  assert.equal(reportedRevision(null), null)
  assert.equal(describeHealth(503, { db: 'unreachable', maintenance: true, envRevision: 'r1', stripe: 'live' }), 'status=503 db=unreachable maintenance=true envRevision=r1')
  assert.equal(describeHealth(200, {}), 'status=200 db=unknown maintenance=false envRevision=none')
  assert.equal(describeHealth(null, null), 'no response')
})

test('prints graceful=true/false from the restart answer when the Worker reports it', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  await restartContainer([file], {
    env: {},
    print: (line) => lines.push(line),
    fetchImpl: async (url) => (url.endsWith('/internal/restart') ? answer(200, { restarted: true, graceful: false }) : answer(200, { commit: 'abc1234' })),
  })
  assert.equal(lines[0], 'restart: HTTP 200 graceful=false')
})

test('--expect-revision: a matching /health ends it after one restart', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  let restarts = 0
  const result = await restartContainer([file, '--expect-revision=rev-2'], {
    env: {},
    print: (line) => lines.push(line),
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith('/internal/restart')) { restarts++; return answer(200, { restarted: true }) }
      return answer(200, { commit: 'abc1234', maintenance: true, envRevision: 'rev-2' })
    },
  })
  assert.equal(restarts, 1)
  assert.equal(result.envRevision, 'rev-2')
  assert.deepEqual(lines, ['restart: HTTP 200', 'health: 200 commit=abc1234 maintenance=true envRevision=rev-2', 'env revision: matches'])
})

test('--expect-revision: a stale revision restarts again 20 s later until it matches', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  const sleeps = []
  let restarts = 0
  const result = await restartContainer([file, '--expect-revision=rev-2'], {
    env: {},
    print: (line) => lines.push(line),
    sleep: async (ms) => { sleeps.push(ms) },
    fetchImpl: async (url) => {
      if (url.endsWith('/internal/restart')) { restarts++; return answer(200, { restarted: true }) }
      return answer(200, { commit: 'abc1234', envRevision: restarts >= 3 ? 'rev-2' : 'rev-1' })
    },
  })
  assert.equal(restarts, 3)
  assert.equal(result.restarts, 3)
  assert.equal(sleeps.filter((ms) => ms === RESTART_GAP_MS).length, 2)
  assert.equal(RESTART_GAP_MS, 20_000)
  assert.ok(lines.some((line) => line.startsWith('env revision: expected rev-2, got rev-1; restarting again in 20 s (1 of 3)')))
  assert.equal(lines.at(-1), 'env revision: matches')
})

test('--expect-revision: gives up after the first restart plus three more and says what /health last said', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  let restarts = 0
  await assert.rejects(
    restartContainer([file, '--expect-revision=rev-2'], {
      env: {},
      print: () => {},
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/internal/restart')) { restarts++; return answer(200, {}) }
        return answer(200, { db: 'ok', maintenance: true, envRevision: 'rev-1', commit: 'abc1234' })
      },
    }),
    (error) => {
      assert.match(error.message, /status=200 db=ok maintenance=true envRevision=rev-1/)
      assert.match(error.message, /expected envRevision=rev-2/)
      assert.ok(!error.message.includes('synthetic-tick-token'))
      return true
    },
  )
  assert.equal(restarts, 1 + MAX_EXTRA_RESTARTS)
})

test('without --expect-revision a different revision is not an error and nothing restarts twice', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  let restarts = 0
  await restartContainer([file], {
    env: {},
    print: () => {},
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith('/internal/restart')) { restarts++; return answer(200, {}) }
      return answer(200, { envRevision: 'anything' })
    },
  })
  assert.equal(restarts, 1)
})

test('a /health timeout names the last status, db, maintenance and envRevision', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  let clock = 0
  await assert.rejects(
    restartContainer([file], {
      env: {},
      print: () => {},
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      fetchImpl: async (url) => (url.endsWith('/internal/restart') ? answer(200, {}) : answer(503, { db: 'unreachable', maintenance: true, envRevision: 'rev-1' })),
    }),
    /90 seconds \(last: status=503 db=unreachable maintenance=true envRevision=rev-1\)/,
  )
  clock = 0
  await assert.rejects(
    restartContainer([file], {
      env: {},
      print: () => {},
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      fetchImpl: async (url) => {
        if (url.endsWith('/internal/restart')) return answer(200, {})
        throw new Error('connection refused')
      },
    }),
    /90 seconds \(last: no response\)/,
  )
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
