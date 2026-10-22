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
  it('hands the very same Request to the one named container', async () => {
    const response = new Response('ok')
    containerFetch.mockResolvedValue(response)
    const request = new Request('https://app.pbjsatime.com/api/stripe/webhook', { method: 'POST', body: '{"a":1}' })
    const env = { APP: { binding: true } }
    await expect(worker.fetch(request, env)).resolves.toBe(response)
    expect(getContainer).toHaveBeenCalledWith(env.APP, 'app')
    expect(containerFetch).toHaveBeenCalledTimes(1)
    expect(containerFetch.mock.calls[0][0]).toBe(request)
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

  it('destroys the container (awaited) and answers { restarted: true } for the right token', async () => {
    let finished = false
    const destroy = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      finished = true
    })
    getContainer.mockReturnValueOnce({ destroy, fetch: containerFetch })
    const env = { APP: { binding: true }, TICK_TOKEN: 'tick-token-value' }
    const response = await worker.fetch(restart('tick-token-value'), env)
    expect(finished).toBe(true)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(getContainer).toHaveBeenCalledWith(env.APP, 'app')
    expect(containerFetch).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ restarted: true })
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
      'JWT_SECRET',
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
    ])
  })

  it('copies the listed names that are defined and skips the rest', () => {
    const env = { DATABASE_URL: 'x', NODE_ENV: 'production', JWT_SECRET: undefined, MAINTENANCE_MODE: '1' }
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
