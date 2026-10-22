import { beforeEach, describe, expect, it, vi } from 'vitest'

// The package is stubbed so this test (and `npm run verify`) does not need it installed.
const containerFetch = vi.fn()
const getContainer = vi.fn(() => ({ fetch: containerFetch }))
const renewCalls = []

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(ctx, env) {
      this.ctx = ctx
      this.env = env
    }
    renewActivityTimeout() {
      renewCalls.push(this)
    }
  },
  getContainer: (...args) => getContainer(...args),
}))

const { default: worker, AppContainer, CONTAINER_ENV_NAMES, pickContainerEnv } = await import('./worker.js')

beforeEach(() => {
  containerFetch.mockReset()
  getContainer.mockClear()
  renewCalls.length = 0
})

describe('fetch', () => {
  it('forwards the same method, url and body bytes to the one named container', async () => {
    const response = new Response('ok')
    containerFetch.mockResolvedValue(response)
    const request = new Request('https://app.pbjsatime.com/api/stripe/webhook?x=1', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'stripe-signature': 't=1,v1=abc', 'cf-connecting-ip': '203.0.113.9' },
    })
    const env = { APP: { binding: true } }
    await expect(worker.fetch(request, env)).resolves.toBe(response)
    expect(getContainer).toHaveBeenCalledWith(env.APP, 'app')
    expect(containerFetch).toHaveBeenCalledTimes(1)
    const forwarded = containerFetch.mock.calls[0][0]
    expect(forwarded.method).toBe('POST')
    expect(forwarded.url).toBe('https://app.pbjsatime.com/api/stripe/webhook?x=1')
    expect(forwarded.headers.get('stripe-signature')).toBe('t=1,v1=abc')
    await expect(forwarded.text()).resolves.toBe('{"a":1}')
  })

  it('replaces a client-sent x-forwarded-for with the address Cloudflare saw, and drops x-real-ip', async () => {
    containerFetch.mockResolvedValue(new Response('ok'))
    const request = new Request('https://app.pbjsatime.com/api/auth/sign-in-with-password', {
      method: 'POST',
      body: '{}',
      headers: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2', 'x-real-ip': '198.51.100.3', 'cf-connecting-ip': '203.0.113.9' },
    })
    await worker.fetch(request, { APP: {} })
    const forwarded = containerFetch.mock.calls[0][0]
    expect(forwarded.headers.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(forwarded.headers.has('x-real-ip')).toBe(false)
  })

  it('sends an empty x-forwarded-for (so the app uses the socket address) when cf-connecting-ip is absent', async () => {
    containerFetch.mockResolvedValue(new Response('ok'))
    const request = new Request('https://app.pbjsatime.com/', { headers: { 'x-forwarded-for': '198.51.100.1' } })
    await worker.fetch(request, { APP: {} })
    expect(containerFetch.mock.calls[0][0].headers.get('x-forwarded-for')).toBe('')
  })

  it('answers 400 to a client-chosen container port without touching the container', async () => {
    const request = new Request('https://app.pbjsatime.com/', { headers: { 'cf-container-target-port': '22' } })
    const response = await worker.fetch(request, { APP: {}, TICK_TOKEN: 't' })
    expect(response.status).toBe(400)
    expect(getContainer).not.toHaveBeenCalled()
  })

  it('answers 404 to every /internal path from outside, including /internal/tick and encoded or cased spellings', async () => {
    for (const path of ['/internal/tick', '/internal/anything', '/INTERNAL/tick', '/%69nternal/tick', '/internal']) {
      const request = new Request('https://app.pbjsatime.com' + path, { method: 'POST', headers: { 'x-tick-token': 'tick-token-value' } })
      const response = await worker.fetch(request, { APP: {}, TICK_TOKEN: 'tick-token-value' })
      expect(response.status, path).toBe(404)
    }
    expect(getContainer).not.toHaveBeenCalled()
  })

  it('answers 400 to a path that cannot be decoded', async () => {
    const response = await worker.fetch(new Request('https://app.pbjsatime.com/%E0%A4%A'), { APP: {} })
    expect(response.status).toBe(400)
    expect(getContainer).not.toHaveBeenCalled()
  })
})

describe('POST /internal/restart', () => {
  const restart = (token, method = 'POST') =>
    new Request('https://app.pbjsatime.com/internal/restart', { method, headers: token === undefined ? {} : { 'x-tick-token': token } })

  it('is 404 when TICK_TOKEN is not configured, and does not touch the container', async () => {
    const response = await worker.fetch(restart('anything'), { APP: {} })
    expect(response.status).toBe(404)
    expect(getContainer).not.toHaveBeenCalled()
  })

  it('is 401 for a missing or wrong token (same length or not), and does not touch the container', async () => {
    for (const token of [undefined, '', 'wrong', 'tick-token-valuf', 'tick-token-value-and-more']) {
      const response = await worker.fetch(restart(token), { APP: {}, TICK_TOKEN: 'tick-token-value' })
      expect(response.status).toBe(401)
    }
    expect(getContainer).not.toHaveBeenCalled()
  })

  it('is 404 for any other method', async () => {
    const response = await worker.fetch(restart('tick-token-value', 'GET'), { APP: {}, TICK_TOKEN: 'tick-token-value' })
    expect(response.status).toBe(404)
    expect(getContainer).not.toHaveBeenCalled()
  })

  it('hands the Worker env to restartWith (not the stub-side stop/destroy) and relays graceful and lastStatus', async () => {
    const restartWith = vi.fn(async () => ({ graceful: true, lastStatus: 'stopped_with_code' }))
    const stop = vi.fn()
    const destroy = vi.fn()
    getContainer.mockReturnValueOnce({ restartWith, stop, destroy, fetch: containerFetch })
    const env = {
      APP: { binding: true },
      TICK_TOKEN: 'tick-token-value',
      DATABASE_URL: 'db-new',
      ENV_REVISION: 'rev-2',
      CLOUDFLARE_API_TOKEN: 'never-forwarded',
    }
    const response = await worker.fetch(restart('tick-token-value'), env)
    expect(getContainer).toHaveBeenCalledWith(env.APP, 'app')
    expect(restartWith).toHaveBeenCalledTimes(1)
    expect(restartWith).toHaveBeenCalledWith({
      DATABASE_URL: 'db-new',
      TICK_TOKEN: 'tick-token-value',
      ENV_REVISION: 'rev-2',
    })
    expect(stop).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
    expect(containerFetch).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ restarted: true, graceful: true, lastStatus: 'stopped_with_code' })
  })

  it('answers 500 { restarted: false } and logs the message only when restartWith fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getContainer.mockReturnValueOnce({ restartWith: vi.fn(async () => { throw new Error('destroy exploded') }) })
    const response = await worker.fetch(restart('tick-token-value'), { APP: {}, TICK_TOKEN: 'tick-token-value', DATABASE_URL: 'secret-db-value' })
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ restarted: false })
    expect(spy).toHaveBeenCalledWith('[restart] restartWith failed', 'destroy exploded')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-db-value')
    spy.mockRestore()
  })
})

describe('GET /internal/env-revision', () => {
  const read = (token, method = 'GET') =>
    new Request('https://app.pbjsatime.com/internal/env-revision', { method, headers: token === undefined ? {} : { 'x-tick-token': token } })

  it('is 404 when TICK_TOKEN is not configured, and for any other method', async () => {
    expect((await worker.fetch(read('anything'), { APP: {}, ENV_REVISION: 'rev-2' })).status).toBe(404)
    expect((await worker.fetch(read('tick-token-value', 'POST'), { APP: {}, TICK_TOKEN: 'tick-token-value' })).status).toBe(404)
    expect(getContainer).not.toHaveBeenCalled()
  })

  it('is 401 for a missing or wrong token', async () => {
    for (const token of [undefined, '', 'wrong', 'tick-token-valuf']) {
      const response = await worker.fetch(read(token), { APP: {}, TICK_TOKEN: 'tick-token-value', ENV_REVISION: 'rev-2' })
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain('rev-2')
    }
    expect(getContainer).not.toHaveBeenCalled()
  })

  it('answers the revision this Worker version carries, or null, without touching the container', async () => {
    const withRevision = await worker.fetch(read('tick-token-value'), { APP: {}, TICK_TOKEN: 'tick-token-value', ENV_REVISION: 'rev-2' })
    expect(withRevision.status).toBe(200)
    await expect(withRevision.json()).resolves.toEqual({ workerEnvRevision: 'rev-2' })
    const without = await worker.fetch(read('tick-token-value'), { APP: {}, TICK_TOKEN: 'tick-token-value' })
    await expect(without.json()).resolves.toEqual({ workerEnvRevision: null })
    expect(getContainer).not.toHaveBeenCalled()
    expect(containerFetch).not.toHaveBeenCalled()
  })
})

describe('AppContainer.restartWith', () => {
  const make = ({ stop, getState, destroy, running } = {}) => {
    const container = new AppContainer({}, { DATABASE_URL: 'stale-db' })
    container.stop = stop ?? vi.fn(async () => {})
    container.getState = getState ?? vi.fn(async () => ({ status: 'stopped' }))
    container.destroy = destroy ?? vi.fn(async () => {})
    if (running !== undefined) container.container = { running }
    return container
  }

  it('sets the passed env BEFORE destroy, sends SIGTERM, polls until stopped, then destroys (awaited)', async () => {
    const order = []
    let finished = false
    let envAtDestroy
    const states = [{ status: 'healthy' }, { status: 'stopping' }, { status: 'stopped_with_code' }]
    const container = make({
      stop: vi.fn(async () => { order.push('stop') }),
      getState: vi.fn(async () => { order.push('getState'); return states.shift() }),
      destroy: vi.fn(async () => {
        order.push('destroy')
        envAtDestroy = container.envVars
        await new Promise((resolve) => setTimeout(resolve, 5))
        finished = true
      }),
    })
    await expect(container.restartWith({ DATABASE_URL: 'fresh-db', ENV_REVISION: 'rev-2' })).resolves.toEqual({ graceful: true, lastStatus: 'stopped_with_code' })
    expect(finished).toBe(true)
    expect(container.stop).toHaveBeenCalledWith('SIGTERM')
    expect(order).toEqual(['stop', 'getState', 'getState', 'getState', 'destroy'])
    expect(envAtDestroy).toEqual({ DATABASE_URL: 'fresh-db', ENV_REVISION: 'rev-2' })
    expect(container.envVars).toEqual({ DATABASE_URL: 'fresh-db', ENV_REVISION: 'rev-2' })
  })

  it('counts a runtime that reports not running as stopped even while the state still says healthy', async () => {
    const container = make({ getState: vi.fn(async () => ({ status: 'healthy' })), running: false })
    await expect(container.restartWith({})).resolves.toEqual({ graceful: true, lastStatus: 'healthy' })
  })

  it('destroys anyway and reports graceful: false with the last status when it does not stop within 20 seconds', async () => {
    vi.useFakeTimers()
    try {
      const container = make({ getState: vi.fn(async () => ({ status: 'running' })), running: true })
      const pending = container.restartWith({ DATABASE_URL: 'fresh-db' })
      await vi.advanceTimersByTimeAsync(21_000)
      await expect(pending).resolves.toEqual({ graceful: false, lastStatus: 'running' })
      expect(container.destroy).toHaveBeenCalledTimes(1)
      expect(container.getState.mock.calls.length).toBeGreaterThan(10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still destroys, with graceful: false, when stop() throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = make({ stop: vi.fn(async () => { throw new Error('rpc failed') }) })
    await expect(container.restartWith({})).resolves.toEqual({ graceful: false, lastStatus: null })
    expect(container.destroy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('logs "[restart] destroy failed" with the message only and throws when destroy() fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = make({ destroy: vi.fn(async () => { throw new Error('destroy exploded') }) })
    await expect(container.restartWith({ DATABASE_URL: 'secret-db-value' })).rejects.toThrow('destroy exploded')
    expect(spy).toHaveBeenCalledWith('[restart] destroy failed', 'destroy exploded')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-db-value')
    spy.mockRestore()
  })

  it('refuses a bad env before touching the container, with messages that carry no values', async () => {
    for (const bad of [null, undefined, 'x', 5, [], new Map(), { NOT_LISTED: 'secret-value' }, { DATABASE_URL: 5 }, { DATABASE_URL: null }]) {
      const container = make()
      const error = await container.restartWith(bad).then(() => null, (e) => e)
      expect(error, String(bad)).toBeInstanceOf(Error)
      expect(error.message).not.toContain('secret-value')
      expect(container.stop).not.toHaveBeenCalled()
      expect(container.destroy).not.toHaveBeenCalled()
      expect(container.envVars).toEqual({ DATABASE_URL: 'stale-db' })
    }
  })

  it('copies the env it is given instead of keeping the caller\'s object', async () => {
    const container = make()
    const given = { DATABASE_URL: 'fresh-db' }
    await container.restartWith(given)
    given.DATABASE_URL = 'changed-later'
    expect(container.envVars).toEqual({ DATABASE_URL: 'fresh-db' })
  })
})

describe('scheduled', () => {
  it('posts the tick with the token header and keeps the Worker alive until it answers', async () => {
    containerFetch.mockReturnValue(Promise.resolve(new Response('{}')))
    const waitUntil = vi.fn()
    worker.scheduled({}, { APP: {}, TICK_TOKEN: 'tick-token-value' }, { waitUntil })
    expect(containerFetch).toHaveBeenCalledWith('http://app/internal/tick', {
      method: 'POST',
      headers: { 'x-tick-token': 'tick-token-value' },
    })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await expect(waitUntil.mock.calls[0][0]).resolves.toBe(true)
  })

  it('logs the status when the tick is not ok', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    containerFetch.mockResolvedValue(new Response('{}', { status: 401 }))
    const waitUntil = vi.fn()
    worker.scheduled({}, { APP: {}, TICK_TOKEN: 'tick-token-value' }, { waitUntil })
    await waitUntil.mock.calls[0][0]
    expect(spy).toHaveBeenCalledWith('[cron] tick', 401)
    spy.mockRestore()
  })

  it('logs a tick that throws instead of leaving an unhandled rejection', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    containerFetch.mockRejectedValue(new Error('container down'))
    const waitUntil = vi.fn()
    worker.scheduled({}, { APP: {}, TICK_TOKEN: 'tick-token-value' }, { waitUntil })
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith('[cron] tick failed', 'container down')
    spy.mockRestore()
  })

  it('sends an empty token (which the app refuses) rather than the word "undefined"', () => {
    containerFetch.mockResolvedValue(new Response('{}'))
    worker.scheduled({}, { APP: {} }, { waitUntil: vi.fn() })
    expect(containerFetch.mock.calls[0][1].headers['x-tick-token']).toBe('')
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
      'ENV_REVISION',
    ])
  })

  it('copies the listed names that are defined and skips the rest', () => {
    const env = { DATABASE_URL: 'x', NODE_ENV: 'production', VOICE_TOOL_SECRET: undefined, MAINTENANCE_MODE: '1' }
    expect(pickContainerEnv(env)).toEqual({ DATABASE_URL: 'x', NODE_ENV: 'production', MAINTENANCE_MODE: '1' })
  })

  it('never invents a name: bindings and unlisted variables stay behind', () => {
    const env = { APP: { binding: true }, SOMETHING_ELSE: 'no', CLOUDFLARE_API_TOKEN: 'no', DATABASE_URL: 'x' }
    expect(pickContainerEnv(env)).toEqual({ DATABASE_URL: 'x' })
    expect(pickContainerEnv({})).toEqual({})
    expect(pickContainerEnv(undefined)).toEqual({})
  })
})

describe('AppContainer', () => {
  it('listens where the image listens, stays awake long, and receives the picked env', () => {
    const container = new AppContainer({}, { DATABASE_URL: 'db', SOMETHING_ELSE: 'no' })
    expect(container.defaultPort).toBe(8080)
    expect(container.sleepAfter).toBe('2h')
    expect(container.envVars).toEqual({ DATABASE_URL: 'db' })
  })

  it('renews the activity timeout instead of stopping when it expires', async () => {
    const container = new AppContainer({}, {})
    container.stop = vi.fn()
    container.destroy = vi.fn()
    await container.onActivityExpired()
    expect(renewCalls).toEqual([container])
    expect(container.stop).not.toHaveBeenCalled()
    expect(container.destroy).not.toHaveBeenCalled()
  })
})
