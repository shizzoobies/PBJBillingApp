import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendInvoiceEmail } from './notify.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * The sending plumbing for an engagement letter (featreq-5e195707): the same
 * `sendInvoiceEmail` an invoice uses, tagged with the send-log row instead of an
 * invoice, carrying the PDF, replying to the invoice mailbox, and answering with
 * the provider's HTTP status so a loop can tell a 429 from a refusal.
 */
function stubResend({ status = 200, body = JSON.stringify({ id: 're_letter_1' }) } = {}) {
  const calls = []
  vi.stubEnv('RESEND_API_KEY', 're_test_key')
  vi.stubEnv('INVOICE_EMAIL_FROM', 'billing@pbjsa.com')
  vi.stubEnv('INVOICE_REPLY_TO', 'brittany@pbjsa.com')
  vi.stubEnv('OWNER_EMAIL', 'alex@example.test')
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  })
  return calls
}

const sendLetter = (over = {}) =>
  sendInvoiceEmail({
    to: ['pat@acme.test'],
    subject: 'Your 2027 1099s',
    html: '<p>hi</p>',
    text: 'hi',
    fromName: 'PB&J Strategic Accounting',
    attachments: [{ filename: 'Engagement-Letter-Acme-2026.pdf', content: Buffer.from('%PDF-1.3 letter') }],
    letterSendId: 'els-1a2b3c4d',
    kind: 'letter',
    ...over,
  })

describe('sendInvoiceEmail for an engagement letter', () => {
  it('tags the send-log row, not an invoice, so the webhook never files it on one', async () => {
    const calls = stubResend()
    const result = await sendLetter()
    expect(result).toEqual({ ok: true, error: null, providerId: 're_letter_1', status: 200 })
    expect(calls[0].body.tags).toEqual([
      { name: 'letter_send_id', value: 'els-1a2b3c4d' },
      { name: 'kind', value: 'letter' },
    ])
    expect(calls[0].body.tags.map((tag) => tag.name)).not.toContain('invoice_id')
  })

  it('sanitizes the tag value rather than letting it fail the send', async () => {
    const calls = stubResend()
    await sendLetter({ letterSendId: 'els 1a/2b.3c' })
    expect(calls[0].body.tags[0]).toEqual({ name: 'letter_send_id', value: 'els_1a_2b_3c' })
  })

  it('leaves the letter tag off when none is given, as an invoice send does', async () => {
    const calls = stubResend()
    await sendLetter({ letterSendId: undefined, kind: 'invoice', invoiceId: 'inv-8f2a91cd' })
    expect(calls[0].body.tags).toEqual([
      { name: 'invoice_id', value: 'inv-8f2a91cd' },
      { name: 'kind', value: 'invoice' },
    ])
  })

  it('sends the PDF, from the named firm, replying to the invoice mailbox, with no copy to anyone', async () => {
    const calls = stubResend()
    await sendLetter()
    const body = calls[0].body
    expect(body.from).toBe('PB&J Strategic Accounting <billing@pbjsa.com>')
    expect(body.reply_to).toBe('brittany@pbjsa.com')
    expect(body.to).toEqual(['pat@acme.test'])
    expect(body.attachments).toEqual([
      { filename: 'Engagement-Letter-Acme-2026.pdf', content: Buffer.from('%PDF-1.3 letter').toString('base64') },
    ])
    expect(body).not.toHaveProperty('bcc')
    expect(body).not.toHaveProperty('cc')
  })
})

describe('sendInvoiceEmail status', () => {
  it('answers the HTTP status of an accepted send', async () => {
    stubResend({ status: 200 })
    expect((await sendLetter()).status).toBe(200)
  })

  it('answers 429 for a rate-limited send, with the provider’s own words', async () => {
    stubResend({ status: 429, body: JSON.stringify({ message: 'Too many requests.' }) })
    expect(await sendLetter()).toEqual({
      ok: false,
      error: 'Too many requests.',
      providerId: null,
      status: 429,
    })
  })

  it('answers the status of a hard refusal, with the generic sentence when the body has none', async () => {
    stubResend({ status: 422, body: 'not json' })
    expect(await sendLetter()).toEqual({
      ok: false,
      error: 'Email provider refused the message (422).',
      providerId: null,
      status: 422,
    })
  })

  it('answers null when no answer came: a network failure, no key, no recipient', async () => {
    stubResend()
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up')
    })
    expect(await sendLetter()).toEqual({
      ok: false,
      error: 'Could not reach the email provider.',
      providerId: null,
      status: null,
    })

    vi.stubEnv('RESEND_API_KEY', '')
    expect((await sendLetter()).status).toBeNull()

    stubResend()
    const empty = await sendLetter({ to: [] })
    expect(empty).toEqual({ ok: false, error: 'No recipient address.', providerId: null, status: null })
  })
})
