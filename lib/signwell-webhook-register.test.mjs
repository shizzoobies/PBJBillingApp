import { describe, expect, it, vi } from 'vitest'

import { callbackUrlFor, registerWebhook, resolveEnvironment } from '../scripts/prod/signwell-webhook-register.mjs'

const env = { SIGNWELL_API_KEY: 'sw_fake_key_1234567890', APP_PUBLIC_URL: 'https://app.example.invalid/' }
const CALLBACK = 'https://app.example.invalid/api/signwell/webhook'

function fakeApi({ hooks = [], created = { id: 'hook-new', callback_url: CALLBACK } } = {}) {
  return {
    listWebhooks: vi.fn(async () => hooks),
    createWebhook: vi.fn(async () => created),
    deleteWebhook: vi.fn(async () => null),
  }
}
const run = (args) => {
  const lines = []
  return registerWebhook({ ...args, print: (line) => lines.push(line) }).then((result) => ({ ...result, lines, text: lines.join('\n') }))
}

describe('the SignWell webhook registration script', () => {
  it('builds the callback from APP_PUBLIC_URL without a doubled slash', () => {
    expect(callbackUrlFor('https://app.example.invalid/')).toBe(CALLBACK)
    expect(callbackUrlFor(' https://app.example.invalid ')).toBe(CALLBACK)
  })

  it('creates the hook only when absent, and prints the id to set as SIGNWELL_WEBHOOK_ID', async () => {
    const api = fakeApi()
    const result = await run({ env, api })
    expect(api.listWebhooks).toHaveBeenCalledTimes(1)
    expect(api.createWebhook).toHaveBeenCalledTimes(1)
    expect(api.createWebhook.mock.calls[0][0]).toBe(CALLBACK)
    expect(result.created.id).toBe('hook-new')
    expect(result.text).toContain('created webhook hook-new')
    expect(result.text).toContain('Set SIGNWELL_WEBHOOK_ID to hook-new on the Railway service')
  })

  it('does not create a duplicate: an existing hook for this app is reported with its id', async () => {
    const api = fakeApi({ hooks: [{ id: 'hook-other', callback_url: 'https://elsewhere.invalid/x' }, { id: 'hook-ours', callback_url: CALLBACK }] })
    const result = await run({ env, api })
    expect(api.createWebhook).not.toHaveBeenCalled()
    expect(result.created).toBeNull()
    expect(result.text).toContain('2 webhook(s) registered')
    expect(result.text).toContain("The app's webhook already exists: hook-ours")
    expect(result.text).toContain('Set SIGNWELL_WEBHOOK_ID to hook-ours')
    // Another hook's id is a secret too: never printed.
    expect(result.text).not.toContain('hook-other')
  })

  it('--delete removes one hook by id and creates nothing', async () => {
    const api = fakeApi()
    const result = await run({ env, api, argv: ['--delete', 'hook-old'] })
    expect(api.deleteWebhook).toHaveBeenCalledWith('hook-old', expect.objectContaining({ env: expect.any(Object) }))
    expect(api.listWebhooks).not.toHaveBeenCalled()
    expect(api.createWebhook).not.toHaveBeenCalled()
    expect(result.deleted).toBe('hook-old')
    await expect(run({ env, api, argv: ['--delete'] })).rejects.toThrow(/needs the webhook id/)
  })

  it('never prints the API key or the callback URL', async () => {
    const api = fakeApi({ hooks: [{ id: 'hook-ours', callback_url: CALLBACK }] })
    const listed = await run({ env, api })
    const made = await run({ env, api: fakeApi() })
    for (const result of [listed, made]) {
      expect(result.text).not.toContain('sw_fake_key')
      expect(result.text).not.toContain('app.example.invalid')
      expect(result.text).not.toContain('http')
    }
  })

  it('reads what the environment lacks from the Railway variables, and says what is missing', () => {
    const readRailway = vi.fn(() => ({ SIGNWELL_API_KEY: 'from-railway', APP_PUBLIC_URL: 'https://railway.example.invalid' }))
    expect(resolveEnvironment(env, readRailway)).toMatchObject(env)
    expect(readRailway).not.toHaveBeenCalled()
    expect(resolveEnvironment({ APP_PUBLIC_URL: 'https://mine.invalid' }, readRailway)).toMatchObject({
      SIGNWELL_API_KEY: 'from-railway',
      APP_PUBLIC_URL: 'https://mine.invalid',
    })
    expect(() => resolveEnvironment({}, () => ({}))).toThrow(/missing SIGNWELL_API_KEY/)
  })
})
