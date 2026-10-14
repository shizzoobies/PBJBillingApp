import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The Idempotency-Key header on a payment reminder's provider call (the
 * provider keeps it for 24 hours and will not send twice for it). Optional in
 * the helper: an ordinary invoice send carries none. The network is a fake.
 */
const { sendInvoiceEmail } = await import('./notify.js')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function fakeFetch() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ id: 're_1' }), { status: 200 }),
  )
}

const message = { to: ['ann@acme.test'], subject: 'S', html: '<p>h</p>', text: 'h', invoiceId: 'inv-1' }

describe('sendInvoiceEmail idempotency key', () => {
  it('sends the key as the Idempotency-Key header when one is given', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('EMAIL_FROM', 'billing@pbjsa.test')
    const spy = fakeFetch()
    await sendInvoiceEmail({ ...message, kind: 'reminder', idempotencyKey: 'reminder/inv-1/2026-10-15' })
    expect(spy.mock.calls[0][1].headers['Idempotency-Key']).toBe('reminder/inv-1/2026-10-15')
  })

  it('hands back the provider\'s error name when it gave one, and adds nothing otherwise', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('EMAIL_FROM', 'billing@pbjsa.test')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'validation_error', message: 'Invalid to field' }), { status: 422 }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await sendInvoiceEmail(message)).toEqual({
      ok: false,
      error: 'Invalid to field',
      errorName: 'validation_error',
      providerId: null,
      status: 422,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 500 }))
    expect(await sendInvoiceEmail(message)).toEqual({
      ok: false,
      error: 'Email provider refused the message (500).',
      providerId: null,
      status: 500,
    })
  })

  it('sends no such header on an ordinary invoice send', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('EMAIL_FROM', 'billing@pbjsa.test')
    const spy = fakeFetch()
    await sendInvoiceEmail(message)
    expect(Object.keys(spy.mock.calls[0][1].headers)).not.toContain('Idempotency-Key')
  })
})
