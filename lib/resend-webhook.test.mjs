import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  RESEND_WEBHOOK_TOLERANCE_SECONDS,
  resendDeliveryEventFor,
  verifyResendWebhook,
} from './resend-webhook.js'

/**
 * The signature check on an endpoint nobody authenticates.
 *
 * Every signature below is built the way Svix builds one — real HMAC, real
 * base64, over the real bytes — because a test that stubs the crypto proves
 * only that the stub was called. What matters is that a body signed with the
 * right key is accepted and that everything else is refused.
 */

const SECRET = 'whsec_c2VjcmV0LWtleS1mb3ItdGVzdHM='
const SECRET_BYTES = Buffer.from(SECRET.slice('whsec_'.length), 'base64')

function sign(body, { id = 'msg_1', timestamp, secretBytes = SECRET_BYTES } = {}) {
  return createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64')
}

function headersFor(body, over = {}) {
  const id = over.id ?? 'msg_1'
  const timestamp = String(over.timestamp ?? Math.floor(Date.now() / 1000))
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': over.signature ?? `v1,${sign(body, { id, timestamp })}`,
  }
}

const EVENT = {
  type: 'email.delivered',
  created_at: '2026-09-04T12:00:00.000Z',
  data: { email_id: 'ee-1', to: ['ann@acme.com'], tags: { invoice_id: 'inv-abc123', kind: 'invoice' } },
}
const BODY = JSON.stringify(EVENT)

describe('verifyResendWebhook', () => {
  it('accepts a body signed with the configured secret and returns the event', () => {
    expect(verifyResendWebhook(BODY, headersFor(BODY), SECRET)).toEqual(EVENT)
  })

  it('signs over the EXACT bytes — a body changed after signing is refused', () => {
    const headers = headersFor(BODY)
    const tampered = BODY.replace('ann@acme.com', 'mallory@example.com')
    expect(verifyResendWebhook(tampered, headers, SECRET)).toBeNull()
  })

  it('refuses a signature made with a different key', () => {
    const headers = headersFor(BODY)
    const timestamp = headers['svix-timestamp']
    headers['svix-signature'] = `v1,${sign(BODY, {
      timestamp,
      secretBytes: Buffer.from('another-key'),
    })}`
    expect(verifyResendWebhook(BODY, headers, SECRET)).toBeNull()
  })

  it('refuses a timestamp outside the five-minute window, however well signed', () => {
    const stale = Math.floor(Date.now() / 1000) - (RESEND_WEBHOOK_TOLERANCE_SECONDS + 60)
    expect(verifyResendWebhook(BODY, headersFor(BODY, { timestamp: stale }), SECRET)).toBeNull()
    // Symmetrically: a clock running far ahead is just as much a replay.
    const future = Math.floor(Date.now() / 1000) + (RESEND_WEBHOOK_TOLERANCE_SECONDS + 60)
    expect(verifyResendWebhook(BODY, headersFor(BODY, { timestamp: future }), SECRET)).toBeNull()
  })

  // A secret rotation signs with both keys for a while. Taking only the first
  // entry would drop half the events for the length of the overlap.
  it('accepts when ANY offered signature matches, not only the first', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const good = sign(BODY, { timestamp })
    const stale = sign(BODY, { timestamp, secretBytes: Buffer.from('old-key') })
    const headers = headersFor(BODY, { timestamp, signature: `v1,${stale} v1,${good}` })
    expect(verifyResendWebhook(BODY, headers, SECRET)).toEqual(EVENT)
  })

  it('ignores an entry that is not a v1 signature', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const good = sign(BODY, { timestamp })
    const headers = headersFor(BODY, { timestamp, signature: `v0,whatever v1,${good}` })
    expect(verifyResendWebhook(BODY, headers, SECRET)).toEqual(EVENT)
    expect(
      verifyResendWebhook(BODY, headersFor(BODY, { timestamp, signature: `v0,${good}` }), SECRET),
    ).toBeNull()
  })

  it('refuses when the secret, a header or the body is missing or unusable', () => {
    expect(verifyResendWebhook(BODY, headersFor(BODY), '')).toBeNull()
    expect(verifyResendWebhook(BODY, headersFor(BODY), 'whsec_')).toBeNull()
    for (const header of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const headers = headersFor(BODY)
      delete headers[header]
      expect(verifyResendWebhook(BODY, headers, SECRET)).toBeNull()
    }
    expect(verifyResendWebhook(BODY, headersFor(BODY, { timestamp: 'soon' }), SECRET)).toBeNull()
  })

  it('refuses a correctly signed body that is not a JSON object', () => {
    const body = 'not json at all'
    expect(verifyResendWebhook(body, headersFor(body), SECRET)).toBeNull()
  })

  // The prefix is a Svix convention, not part of the key material.
  it('takes the secret with or without its whsec_ prefix', () => {
    expect(verifyResendWebhook(BODY, headersFor(BODY), SECRET.slice('whsec_'.length))).toEqual(EVENT)
  })
})

describe('resendDeliveryEventFor', () => {
  it('names the five events we record', () => {
    expect(resendDeliveryEventFor('email.sent')).toBe('sent')
    expect(resendDeliveryEventFor('email.delivered')).toBe('delivered')
    expect(resendDeliveryEventFor('email.delivery_delayed')).toBe('delayed')
    expect(resendDeliveryEventFor('email.bounced')).toBe('bounced')
    expect(resendDeliveryEventFor('email.complained')).toBe('complained')
  })

  it('says nothing about anything else', () => {
    expect(resendDeliveryEventFor('email.opened')).toBeNull()
    expect(resendDeliveryEventFor('contact.created')).toBeNull()
    expect(resendDeliveryEventFor(undefined)).toBeNull()
  })
})
