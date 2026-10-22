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
  reportedUptime,
  restartContainer,
  uptimeProvesRestart,
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

/**
 * A fake of the whole app: /health answers `health(restarts)` (restarts = POSTs seen so far),
 * /internal/env-revision answers `workerRevision` (null = the Worker reports none, undefined =
 * the route does not exist), /internal/restart counts and answers `restartBody`.
 */
function fakeApp({ health, workerRevision = null, restartBody = { restarted: true }, restartStatus = 200 } = {}) {
  const state = { restarts: 0, healthCalls: 0, calls: [] }
  const fetchImpl = async (url, init = {}) => {
    state.calls.push({ url, method: init.method ?? 'GET', token: init.headers?.['x-tick-token'] })
    if (url.endsWith('/internal/restart')) {
      state.restarts++
      return answer(restartStatus, restartBody)
    }
    if (url.endsWith('/internal/env-revision')) {
      return workerRevision === undefined ? answer(404, {}) : answer(200, { workerEnvRevision: workerRevision })
    }
    state.healthCalls++
    return health(state.restarts, state.healthCalls)
  }
  return { state, fetchImpl }
}

// A container that was up for 5000 s and, after each restart, is up for 7 s.
const healthyAfterRestart = (extra = {}) => (restarts) =>
  answer(200, { commit: 'abc1234', uptimeSeconds: restarts === 0 ? 5000 : 7, ...extra })

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

test('reportedRevision, reportedUptime and describeHealth show only safe fields, in a fixed order', () => {
  assert.equal(reportedRevision({ envRevision: 'r1' }), 'r1')
  assert.equal(reportedRevision({ envRevision: null }), null)
  assert.equal(reportedRevision({ envRevision: 5 }), null)
  assert.equal(reportedRevision(null), null)
  assert.equal(reportedUptime({ uptimeSeconds: 12 }), 12)
  assert.equal(reportedUptime({ uptimeSeconds: 0 }), 0)
  for (const bad of [{ uptimeSeconds: '12' }, { uptimeSeconds: -1 }, { uptimeSeconds: NaN }, {}, null]) assert.equal(reportedUptime(bad), null)
  assert.equal(describeHealth(503, { db: 'unreachable', maintenance: true, envRevision: 'r1', stripe: 'live' }), 'status=503 db=unreachable maintenance=true envRevision=r1')
  assert.equal(describeHealth(200, { uptimeSeconds: 9 }), 'status=200 db=unknown maintenance=false envRevision=none uptimeSeconds=9')
  assert.equal(describeHealth(null, null), 'no response')
})

test('uptimeProvesRestart: lower than before, fresh when there was no before, undecidable when not reported', () => {
  assert.equal(uptimeProvesRestart(5000, 7), true)
  assert.equal(uptimeProvesRestart(5000, 5003), false)
  assert.equal(uptimeProvesRestart(5000, 5000), false)
  assert.equal(uptimeProvesRestart(null, 119), true)
  assert.equal(uptimeProvesRestart(null, 4000), false)
  assert.equal(uptimeProvesRestart(5000, null), null)
  assert.equal(uptimeProvesRestart(null, null), null)
  // an old process keeps counting: 5000 s plus the 30 s since it was read is not a restart, 12 s is
  assert.equal(uptimeProvesRestart(5, 35, 30), false)
  assert.equal(uptimeProvesRestart(5, 12, 30), true)
})

test('prints graceful and lastStatus from the restart answer when the Worker reports them', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  const app = fakeApp({ health: healthyAfterRestart(), restartBody: { restarted: true, graceful: false, lastStatus: 'running' } })
  await restartContainer([file], { env: {}, print: (line) => lines.push(line), sleep: async () => {}, fetchImpl: app.fetchImpl })
  assert.ok(lines.includes('restart: HTTP 200 graceful=false lastStatus=running'))
})

test('reads /health and the Worker revision first, prints the Worker revision, restarts, and proves the restart by the uptime drop', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\r\n')
  const lines = []
  const app = fakeApp({ health: healthyAfterRestart({ envRevision: 'rev-2' }), workerRevision: 'rev-2' })
  const result = await restartContainer([file], { env: {}, print: (line) => lines.push(line), sleep: async () => {}, fetchImpl: app.fetchImpl })
  assert.deepEqual(app.state.calls.map((c) => c.method + ' ' + c.url.replace(DEFAULT_APP_URL, '')), [
    'GET /health',
    'GET /internal/env-revision',
    'POST /internal/restart',
    'GET /health',
  ])
  assert.equal(app.state.calls[1].token, 'synthetic-tick-token')
  assert.equal(app.state.calls[2].token, 'synthetic-tick-token')
  assert.deepEqual(lines, [
    'worker env revision: rev-2',
    'restart: HTTP 200',
    'container restarted: uptime 7 s',
    'health: 200 commit=abc1234 maintenance=false envRevision=rev-2',
    'env revision: matches (rev-2, uptime 7 s)',
  ])
  assert.equal(result.uptimeSeconds, 7)
  assert.ok(!lines.join('\n').includes('synthetic-tick-token'))
})

test('a plain run defaults --expect-revision to the Worker revision and restarts again while the container is on another', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  const sleeps = []
  // restarts 1 and 2 come back on the old env (still a new process each time), restart 3 matches
  const app = fakeApp({
    workerRevision: 'rev-2',
    health: (restarts) => answer(200, { commit: 'abc1234', uptimeSeconds: restarts === 0 ? 5000 : 6, envRevision: restarts >= 3 ? 'rev-2' : 'rev-1' }),
  })
  const result = await restartContainer([file], { env: {}, print: (line) => lines.push(line), sleep: async (ms) => { sleeps.push(ms) }, fetchImpl: app.fetchImpl })
  assert.equal(app.state.restarts, 3)
  assert.equal(result.restarts, 3)
  assert.equal(sleeps.filter((ms) => ms === RESTART_GAP_MS).length, 2)
  assert.ok(lines.some((line) => line.startsWith('env revision: expected rev-2, got rev-1; restarting again in 20 s (1 of 3)')))
  assert.match(lines.at(-1), /^env revision: matches \(rev-2, uptime 6 s\)$/)
})

test('--expect-revision wins over the Worker revision', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  const app = fakeApp({ workerRevision: 'rev-worker', health: healthyAfterRestart({ envRevision: 'rev-flag' }) })
  await restartContainer([file, '--expect-revision=rev-flag'], { env: {}, print: (line) => lines.push(line), sleep: async () => {}, fetchImpl: app.fetchImpl })
  assert.equal(app.state.restarts, 1)
  assert.ok(lines.includes('worker env revision: rev-worker'))
  assert.match(lines.at(-1), /^env revision: matches \(rev-flag/)
})

test('--expect-revision: a stale revision restarts again 20 s later until it matches', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  const sleeps = []
  const app = fakeApp({
    health: (restarts) => answer(200, { commit: 'abc1234', uptimeSeconds: restarts === 0 ? 5000 : 6, envRevision: restarts >= 3 ? 'rev-2' : 'rev-1' }),
  })
  const result = await restartContainer([file, '--expect-revision=rev-2'], { env: {}, print: (line) => lines.push(line), sleep: async (ms) => { sleeps.push(ms) }, fetchImpl: app.fetchImpl })
  assert.equal(app.state.restarts, 3)
  assert.equal(result.restarts, 3)
  assert.equal(sleeps.filter((ms) => ms === RESTART_GAP_MS).length, 2)
  assert.equal(RESTART_GAP_MS, 20_000)
})

test('--expect-revision: gives up after the first restart plus three more and says what /health last said', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const app = fakeApp({ health: (restarts) => answer(200, { db: 'ok', maintenance: true, envRevision: 'rev-1', commit: 'abc1234', uptimeSeconds: restarts === 0 ? 5000 : 6 }) })
  await assert.rejects(
    restartContainer([file, '--expect-revision=rev-2'], { env: {}, print: () => {}, sleep: async () => {}, fetchImpl: app.fetchImpl }),
    (error) => {
      assert.match(error.message, /status=200 db=ok maintenance=true envRevision=rev-1 uptimeSeconds=6/)
      assert.match(error.message, /expected envRevision=rev-2/)
      assert.ok(!error.message.includes('synthetic-tick-token'))
      return true
    },
  )
  assert.equal(app.state.restarts, 1 + MAX_EXTRA_RESTARTS)
})

test('without a flag or a Worker revision a different revision is not an error and nothing restarts twice', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  const app = fakeApp({ workerRevision: undefined, health: healthyAfterRestart({ envRevision: 'anything' }) })
  await restartContainer([file], { env: {}, print: (line) => lines.push(line), sleep: async () => {}, fetchImpl: app.fetchImpl })
  assert.equal(app.state.restarts, 1)
  assert.equal(lines[0], 'worker env revision: none')
  assert.ok(!lines.some((line) => line.startsWith('env revision:')))
})

test('the uptime must DROP: a 200 whose uptime kept growing is not a restart, and the failure says so with the last fields', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  let clock = 0
  // an old process: its uptime advances with the (fake) clock
  const app = fakeApp({ health: () => answer(200, { db: 'ok', commit: 'abc1234', uptimeSeconds: 5000 + Math.round(clock / 1000) }) })
  await assert.rejects(
    restartContainer([file], { env: {}, print: () => {}, now: () => clock, sleep: async (ms) => { clock += ms }, fetchImpl: app.fetchImpl }),
    (error) => {
      assert.match(error.message, /^the container did not restart/)
      assert.match(error.message, /status=200 db=ok maintenance=false envRevision=none uptimeSeconds=50\d\d/)
      return true
    },
  )
  assert.ok(clock >= 90_000)
})

test('without an uptime from before, a young uptime (under 120 s) proves the restart and an old one does not', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const young = fakeApp({ health: (restarts) => (restarts === 0 ? answer(503, {}) : answer(200, { commit: 'abc1234', uptimeSeconds: 40 })) })
  const lines = []
  await restartContainer([file], { env: {}, print: (line) => lines.push(line), sleep: async () => {}, fetchImpl: young.fetchImpl })
  assert.ok(lines.includes('container restarted: uptime 40 s'))

  let clock = 0
  const old = fakeApp({ health: (restarts) => (restarts === 0 ? answer(503, {}) : answer(200, { commit: 'abc1234', uptimeSeconds: 4000 })) })
  await assert.rejects(
    restartContainer([file], { env: {}, print: () => {}, now: () => clock, sleep: async (ms) => { clock += ms }, fetchImpl: old.fetchImpl }),
    /did not restart/,
  )
})

test('an app version that reports no uptime is accepted with a note, since nothing can prove it', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  const lines = []
  const app = fakeApp({ health: () => answer(200, { commit: 'abc1234' }) })
  const result = await restartContainer([file], { env: {}, print: (line) => lines.push(line), sleep: async () => {}, fetchImpl: app.fetchImpl })
  assert.ok(lines.includes('container restarted: uptime not reported by this app version'))
  assert.equal(result.uptimeSeconds, null)
})

test('a /health timeout names the last status, db, maintenance and envRevision', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  let clock = 0
  const unreachable = fakeApp({ health: () => answer(503, { db: 'unreachable', maintenance: true, envRevision: 'rev-1' }) })
  await assert.rejects(
    restartContainer([file], { env: {}, print: () => {}, now: () => clock, sleep: async (ms) => { clock += ms }, fetchImpl: unreachable.fetchImpl }),
    /90 seconds \(last: status=503 db=unreachable maintenance=true envRevision=rev-1\)/,
  )
  clock = 0
  const refused = fakeApp({ health: () => { throw new Error('connection refused') } })
  await assert.rejects(
    restartContainer([file], { env: {}, print: () => {}, now: () => clock, sleep: async (ms) => { clock += ms }, fetchImpl: refused.fetchImpl }),
    /90 seconds \(last: no response\)/,
  )
})

test('posts the token header to /internal/restart, polls /health until 200, never prints the token', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\r\n')
  const lines = []
  let clock = 0
  const app = fakeApp({
    health: (restarts, calls) => {
      if (restarts === 0) return answer(200, { uptimeSeconds: 900 })
      if (calls === 2) throw new Error('container starting')
      if (calls === 3) return answer(503, {})
      return answer(200, { ok: true, commit: 'abc1234', maintenance: true, uptimeSeconds: 4 })
    },
  })
  const result = await restartContainer([file], {
    env: {},
    print: (line) => lines.push(line),
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    fetchImpl: app.fetchImpl,
  })
  const restartCall = app.state.calls.find((call) => call.url.endsWith('/internal/restart'))
  assert.deepEqual(restartCall, { url: DEFAULT_APP_URL + '/internal/restart', method: 'POST', token: 'synthetic-tick-token' })
  assert.equal(app.state.healthCalls, 4)
  assert.deepEqual(lines, ['worker env revision: none', 'restart: HTTP 200', 'container restarted: uptime 4 s', 'health: 200 commit=abc1234 maintenance=true'])
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
  await assert.rejects(restartContainer([file], { env: {}, print: () => {}, fetchImpl: async () => { throw new Error('synthetic-tick-token') } }), (error) => !error.message.includes('synthetic-tick-token'))
})

test('gives up after 90 seconds without a 200', async (t) => {
  const file = fixture(t, 'TICK_TOKEN=synthetic-tick-token\n')
  let clock = 0
  const app = fakeApp({ health: () => answer(503, {}) })
  await assert.rejects(
    restartContainer([file], { env: {}, print: () => {}, now: () => clock, sleep: async (ms) => { clock += ms }, fetchImpl: app.fetchImpl }),
    /90 seconds/,
  )
  assert.ok(clock >= 90_000)
})

test('unknown flags are refused without echoing them', async () => {
  await assert.rejects(restartContainer(['--synthetic-private-value'], { env: {} }), (error) => !error.message.includes('synthetic-private-value'))
})
