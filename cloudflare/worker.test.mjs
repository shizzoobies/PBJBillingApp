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
})

describe('scheduled', () => {
  it('posts the tick with the token header and keeps the Worker alive until it answers', async () => {
    const pending = Promise.resolve(new Response('{}'))
    containerFetch.mockReturnValue(pending)
    const waitUntil = vi.fn()
    worker.scheduled({}, { APP: {}, TICK_TOKEN: 'tick-token-value' }, { waitUntil })
    expect(containerFetch).toHaveBeenCalledWith('http://app/internal/tick', {
      method: 'POST',
      headers: { 'x-tick-token': 'tick-token-value' },
    })
    expect(waitUntil).toHaveBeenCalledWith(pending)
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
