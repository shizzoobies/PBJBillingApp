import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Worker's own guards, in front of the router and the hosts. Both are stubbed: what these
// tests watch is what reaches them (worker-hosts.test.mjs covers the routing and the swaps).
const hostFetch = vi.fn()
const { default: worker, CONTAINER_ENV_NAMES, pickContainerEnv } = await import('./worker.js')

/** A router that names app-1, and a HOST namespace whose every instance answers with hostFetch. */
function stubs(extra = {}) {
  const router = {
    liveName: vi.fn(async () => 'app-1'),
    poke: vi.fn(async () => {}),
    status: vi.fn(async () => ({})),
    swap: vi.fn(async () => ({ swapping: true })),
  }
  const HOST = { idFromName: vi.fn((name) => name), get: vi.fn(() => ({ fetch: hostFetch })) }
  const env = { ROUTER: { idFromName: (name) => name, get: () => router }, HOST, ...extra }
  return { router, HOST, env }
}

/** Neither the router nor any host was asked anything. */
function expectNotReached({ router, HOST }) {
  expect(router.liveName).not.toHaveBeenCalled()
  expect(router.swap).not.toHaveBeenCalled()
  expect(HOST.get).not.toHaveBeenCalled()
  expect(hostFetch).not.toHaveBeenCalled()
}

beforeEach(() => {
  hostFetch.mockReset()
})

describe('fetch', () => {
  it('forwards the same method, url and body bytes to the host the router names', async () => {
    const response = new Response('ok')
    hostFetch.mockResolvedValue(response)
    const request = new Request('https://app.pbjsatime.com/api/stripe/webhook?x=1', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'stripe-signature': 't=1,v1=abc', 'cf-connecting-ip': '203.0.113.9' },
    })
    const { env, HOST } = stubs()
    await expect(worker.fetch(request, env)).resolves.toBe(response)
    expect(HOST.idFromName).toHaveBeenCalledWith('app-1')
    expect(HOST.get).toHaveBeenCalledWith('app-1')
    expect(hostFetch).toHaveBeenCalledTimes(1)
    const forwarded = hostFetch.mock.calls[0][0]
    expect(forwarded.method).toBe('POST')
    expect(forwarded.url).toBe('https://app.pbjsatime.com/api/stripe/webhook?x=1')
    expect(forwarded.headers.get('stripe-signature')).toBe('t=1,v1=abc')
    await expect(forwarded.text()).resolves.toBe('{"a":1}')
  })

  it('replaces a client-sent x-forwarded-for with the address Cloudflare saw, and drops x-real-ip', async () => {
    hostFetch.mockResolvedValue(new Response('ok'))
    const request = new Request('https://app.pbjsatime.com/api/auth/sign-in-with-password', {
      method: 'POST',
      body: '{}',
      headers: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2', 'x-real-ip': '198.51.100.3', 'cf-connecting-ip': '203.0.113.9' },
    })
    await worker.fetch(request, stubs().env)
    const forwarded = hostFetch.mock.calls[0][0]
    expect(forwarded.headers.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(forwarded.headers.has('x-real-ip')).toBe(false)
  })

  it('sends an empty x-forwarded-for (so the app uses the socket address) when cf-connecting-ip is absent', async () => {
    hostFetch.mockResolvedValue(new Response('ok'))
    const request = new Request('https://app.pbjsatime.com/', { headers: { 'x-forwarded-for': '198.51.100.1' } })
    await worker.fetch(request, stubs().env)
    expect(hostFetch.mock.calls[0][0].headers.get('x-forwarded-for')).toBe('')
  })

  it('answers 400 to a client-chosen container port without touching the router or a host', async () => {
    const request = new Request('https://app.pbjsatime.com/', { headers: { 'cf-container-target-port': '22' } })
    const s = stubs({ TICK_TOKEN: 't' })
    const response = await worker.fetch(request, s.env)
    expect(response.status).toBe(400)
    expectNotReached(s)
  })

  it('answers 404 to every /internal path from outside, including /internal/tick and encoded or cased spellings', async () => {
    const s = stubs({ TICK_TOKEN: 'tick-token-value' })
    for (const path of ['/internal/tick', '/internal/anything', '/INTERNAL/tick', '/%69nternal/tick', '/internal']) {
      const request = new Request('https://app.pbjsatime.com' + path, { method: 'POST', headers: { 'x-tick-token': 'tick-token-value' } })
      const response = await worker.fetch(request, s.env)
      expect(response.status, path).toBe(404)
    }
    expectNotReached(s)
  })

  it('answers 400 to a path that cannot be decoded', async () => {
    const s = stubs()
    const response = await worker.fetch(new Request('https://app.pbjsatime.com/%E0%A4%A'), s.env)
    expect(response.status).toBe(400)
    expectNotReached(s)
  })
})

describe('POST /internal/restart', () => {
  const restart = (token, method = 'POST') =>
    new Request('https://app.pbjsatime.com/internal/restart', { method, headers: token === undefined ? {} : { 'x-tick-token': token } })

  it('is 404 when TICK_TOKEN is not configured, and does not touch the router or a host', async () => {
    const s = stubs()
    const response = await worker.fetch(restart('anything'), s.env)
    expect(response.status).toBe(404)
    expectNotReached(s)
  })

  it('is 401 for a missing or wrong token (same length or not), and does not touch the router or a host', async () => {
    const s = stubs({ TICK_TOKEN: 'tick-token-value' })
    for (const token of [undefined, '', 'wrong', 'tick-token-valuf', 'tick-token-value-and-more']) {
      const response = await worker.fetch(restart(token), s.env)
      expect(response.status).toBe(401)
    }
    expectNotReached(s)
  })

  it('is 404 for any other method', async () => {
    const s = stubs({ TICK_TOKEN: 'tick-token-value' })
    const response = await worker.fetch(restart('tick-token-value', 'GET'), s.env)
    expect(response.status).toBe(404)
    expectNotReached(s)
  })

  it('hands the Worker env to router.swap (not to a host) and relays that it is swapping', async () => {
    const s = stubs({
      TICK_TOKEN: 'tick-token-value',
      DATABASE_URL: 'db-new',
      ENV_REVISION: 'rev-2',
      CLOUDFLARE_API_TOKEN: 'never-forwarded',
    })
    const response = await worker.fetch(restart('tick-token-value'), s.env)
    expect(s.router.swap).toHaveBeenCalledTimes(1)
    expect(s.router.swap).toHaveBeenCalledWith({
      envVars: { DATABASE_URL: 'db-new', TICK_TOKEN: 'tick-token-value', ENV_REVISION: 'rev-2' },
      reason: 'restart',
    })
    expect(s.HOST.get).not.toHaveBeenCalled()
    expect(hostFetch).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ restarted: true, graceful: true, lastStatus: 'swapping', swapping: true })
  })

  it('answers 500 { restarted: false } and logs the message only when the swap fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = stubs({ TICK_TOKEN: 'tick-token-value', DATABASE_URL: 'secret-db-value' })
    s.router.swap.mockRejectedValueOnce(new Error('swap exploded'))
    const response = await worker.fetch(restart('tick-token-value'), s.env)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ restarted: false })
    expect(spy).toHaveBeenCalledWith('[restart] swap failed', 'swap exploded')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-db-value')
    spy.mockRestore()
  })
})

describe('GET /internal/env-revision', () => {
  const read = (token, method = 'GET') =>
    new Request('https://app.pbjsatime.com/internal/env-revision', { method, headers: token === undefined ? {} : { 'x-tick-token': token } })

  it('is 404 when TICK_TOKEN is not configured, and for any other method', async () => {
    const s = stubs({ ENV_REVISION: 'rev-2' })
    expect((await worker.fetch(read('anything'), s.env)).status).toBe(404)
    const t = stubs({ TICK_TOKEN: 'tick-token-value' })
    expect((await worker.fetch(read('tick-token-value', 'POST'), t.env)).status).toBe(404)
    expectNotReached(s)
    expectNotReached(t)
  })

  it('is 401 for a missing or wrong token', async () => {
    const s = stubs({ TICK_TOKEN: 'tick-token-value', ENV_REVISION: 'rev-2' })
    for (const token of [undefined, '', 'wrong', 'tick-token-valuf']) {
      const response = await worker.fetch(read(token), s.env)
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain('rev-2')
    }
    expectNotReached(s)
  })

  it('answers the revision this Worker version carries, or null, without touching the router or a host', async () => {
    const s = stubs({ TICK_TOKEN: 'tick-token-value', ENV_REVISION: 'rev-2' })
    const withRevision = await worker.fetch(read('tick-token-value'), s.env)
    expect(withRevision.status).toBe(200)
    await expect(withRevision.json()).resolves.toEqual({ workerEnvRevision: 'rev-2' })
    const t = stubs({ TICK_TOKEN: 'tick-token-value' })
    const without = await worker.fetch(read('tick-token-value'), t.env)
    await expect(without.json()).resolves.toEqual({ workerEnvRevision: null })
    expectNotReached(s)
    expectNotReached(t)
  })
})

describe('scheduled', () => {
  it('posts the tick with the token header to the live host and keeps the Worker alive until it answers', async () => {
    hostFetch.mockReturnValue(Promise.resolve(new Response('{}')))
    const { env, router } = stubs({ TICK_TOKEN: 'tick-token-value' })
    const waitUntil = vi.fn()
    worker.scheduled({}, env, { waitUntil })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    // [the router poke, the tick's answer being ok]
    await expect(waitUntil.mock.calls[0][0]).resolves.toEqual([undefined, true])
    expect(router.poke).toHaveBeenCalledTimes(1)
    expect(hostFetch).toHaveBeenCalledTimes(1)
    const tick = hostFetch.mock.calls[0][0]
    expect(tick.url).toBe('http://app/internal/tick')
    expect(tick.method).toBe('POST')
    expect(tick.headers.get('x-tick-token')).toBe('tick-token-value')
  })

  it('logs the status when the tick is not ok', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hostFetch.mockResolvedValue(new Response('{}', { status: 401 }))
    const waitUntil = vi.fn()
    worker.scheduled({}, stubs({ TICK_TOKEN: 'tick-token-value' }).env, { waitUntil })
    await waitUntil.mock.calls[0][0]
    expect(spy).toHaveBeenCalledWith('[cron] tick', 401)
    spy.mockRestore()
  })

  it('logs a tick whose host cannot be reached instead of leaving an unhandled rejection', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hostFetch.mockRejectedValue(new Error('container down'))
    const waitUntil = vi.fn()
    worker.scheduled({}, stubs({ TICK_TOKEN: 'tick-token-value' }).env, { waitUntil })
    await expect(waitUntil.mock.calls[0][0]).resolves.toEqual([undefined, undefined])
    // The tick is tried twice, then answered with a 503 that the cron logs.
    expect(hostFetch).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalledWith('[worker] could not reach the live instance:', 'container down')
    expect(spy).toHaveBeenCalledWith('[cron] tick', 503)
    spy.mockRestore()
  })

  it('sends an empty token (which the app refuses) rather than the word "undefined"', async () => {
    hostFetch.mockResolvedValue(new Response('{}'))
    const waitUntil = vi.fn()
    worker.scheduled({}, stubs().env, { waitUntil })
    await waitUntil.mock.calls[0][0]
    expect(hostFetch.mock.calls[0][0].headers.get('x-tick-token')).toBe('')
  })
})

describe('pickContainerEnv', () => {
  it('pins exactly the names the app is allowed to receive', () => {
    expect(CONTAINER_ENV_NAMES).toEqual([
      'DATABASE_URL',
      'PGSSLMODE',
      'NODE_ENV',
      'APP_PUBLIC_URL',
      'FIRM_TIME_ZONE',
      'VOICE_TOOL_SECRET',
      'OWNER_BOOTSTRAP_PASSWORD',
      'OWNER_EMAIL',
      'ADMIN_EMAIL',
      'TOTP_ENC_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'RESEND_API_KEY',
      'RESEND_WEBHOOK_SECRET',
      'EMAIL_FROM',
      'INVOICE_EMAIL_FROM',
      'INVOICE_REPLY_TO',
      'ANTHROPIC_API_KEY',
      'ELEVENLABS_API_KEY',
      'ELEVENLABS_AGENT_ID',
      'ELEVENLABS_WEBHOOK_SECRET',
      'SIGNWELL_API_KEY',
      'SIGNWELL_TEST_MODE',
      'SIGNWELL_WEBHOOK_ID',
      'ESIGNATURES_SECRET_TOKEN',
      'ESIGNATURES_TEST_MODE',
      'ESIGN_PROVIDER',
      'INVOICE_AUTO_REMINDERS',
      'INVOICE_PAST_DUE_NOTICES',
      'ASSISTANT_DIGEST',
      'ASSISTANT_DIGEST_DOW',
      'ASSISTANT_MODEL',
      'ASSISTANT_FALLBACK_MODEL',
      'ASSISTANT_SUMMARY_MODEL',
      'ASSISTANT_CAPACITY_TARGET',
      'INVOICE_AI_MODEL',
      'INVOICE_AUTO_REMINDER_MIN_DAYS',
      'FEATURE_REQUEST_EMAIL',
      'AUTOPAY_CHARGING',
      'TICK_TOKEN',
      'MAINTENANCE_MODE',
      'FEEDBACK_STORAGE',
      'FEEDBACK_R2_ENDPOINT',
      'FEEDBACK_R2_BUCKET',
      'FEEDBACK_R2_ACCESS_KEY_ID',
      'FEEDBACK_R2_SECRET_ACCESS_KEY',
      'FEEDBACK_ATTACHMENTS_PAUSED',
      'ENV_REVISION',
    ])
  })

  it('copies the listed names that are defined and skips the rest', () => {
    const env = { DATABASE_URL: 'x', NODE_ENV: 'production', VOICE_TOOL_SECRET: undefined, MAINTENANCE_MODE: '1' }
    expect(pickContainerEnv(env)).toEqual({ DATABASE_URL: 'x', NODE_ENV: 'production', MAINTENANCE_MODE: '1' })
  })

  it('never invents a name: bindings and unlisted variables stay behind', () => {
    const env = { ROUTER: { binding: true }, HOST: { binding: true }, SOMETHING_ELSE: 'no', CLOUDFLARE_API_TOKEN: 'no', DATABASE_URL: 'x' }
    expect(pickContainerEnv(env)).toEqual({ DATABASE_URL: 'x' })
    expect(pickContainerEnv({})).toEqual({})
    expect(pickContainerEnv(undefined)).toEqual({})
  })
})
