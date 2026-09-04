/**
 * Resend's delivery webhook: the signature check, and nothing else.
 *
 * A leaf on purpose. This module is the whole security boundary for an
 * UNAUTHENTICATED endpoint — Resend cannot hold a session, so if this says yes
 * to a forged body then anyone on the internet can write into an invoice's
 * email log. It touches no store, no network and no environment beyond the
 * secret it is handed, which is what makes it provable in a unit test.
 *
 * Resend signs with Svix. Three headers travel with every delivery:
 *
 *   svix-id         the message id, stable across retries
 *   svix-timestamp  unix seconds, so a captured request cannot be replayed
 *                   next week
 *   svix-signature  one or more space-separated `v1,<base64>` entries — plural
 *                   because a secret rotation signs with both keys for a while
 *
 * The signed content is `${id}.${timestamp}.${rawBody}` and the expected value
 * is base64(HMAC-SHA256(secretBytes, signedContent)), where the secret's bytes
 * are the base64 decode of everything after the `whsec_` prefix.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * How far out of step a timestamp may be. Svix's own default, and the reason a
 * request captured off the wire cannot be replayed tomorrow.
 */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 300

/** True when webhook signatures can be verified. Without this we refuse events. */
export function isResendWebhookConfigured() {
  return Boolean(process.env.RESEND_WEBHOOK_SECRET)
}

/**
 * The delivery events worth recording, mapped to the short word the email log
 * stores. Anything else Resend sends is acknowledged and ignored.
 */
export const RESEND_DELIVERY_EVENTS = Object.freeze(
  Object.assign(Object.create(null), {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'delayed',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
  }),
)

/** The log's word for a Resend event type, or null when we do not record it. */
export function resendDeliveryEventFor(type) {
  const key = String(type ?? '')
  return Object.hasOwn(RESEND_DELIVERY_EVENTS, key) ? RESEND_DELIVERY_EVENTS[key] : null
}

/** The signing key's raw bytes, or null when the secret is missing/malformed. */
function secretBytes(secret) {
  const raw = String(secret ?? '').trim()
  if (!raw) return null
  const encoded = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw
  if (!encoded) return null
  const bytes = Buffer.from(encoded, 'base64')
  return bytes.length > 0 ? bytes : null
}

/** One header value, however node happened to hand it over. */
function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toUpperCase()]
  if (Array.isArray(value)) return String(value[0] ?? '')
  return typeof value === 'string' ? value : ''
}

/**
 * Verify a Resend (Svix) webhook and return the parsed event.
 *
 * Returns null — never throws, never partially trusts — when the secret is
 * unusable, a header is missing, the timestamp is outside the tolerance, no
 * offered signature matches, or the body is not JSON. The caller's only correct
 * response to null is to reject the request.
 *
 * @param {string} rawBody the EXACT bytes received, before any parse
 * @param {object} headers the request headers (lowercased keys, as node gives)
 * @param {string} [secret] defaults to RESEND_WEBHOOK_SECRET
 * @param {{now?: number}} [options] `now` in ms, for tests
 * @returns {object|null}
 */
export function verifyResendWebhook(
  rawBody,
  headers,
  secret = process.env.RESEND_WEBHOOK_SECRET,
  { now = Date.now() } = {},
) {
  const key = secretBytes(secret)
  if (!key) return null

  const id = headerValue(headers, 'svix-id')
  const timestamp = headerValue(headers, 'svix-timestamp')
  const offered = headerValue(headers, 'svix-signature')
  if (!id || !timestamp || !offered) return null

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) return null
  if (Math.abs(now / 1000 - seconds) > RESEND_WEBHOOK_TOLERANCE_SECONDS) return null

  const body = typeof rawBody === 'string' ? rawBody : String(rawBody ?? '')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()

  // ANY entry may match: during a secret rotation Svix signs with the old key
  // and the new one, and refusing the pair would drop half the events for the
  // length of the overlap. Compared in constant time, so a near-miss reveals
  // nothing about how near it was.
  const matched = offered.split(' ').some((entry) => {
    const comma = entry.indexOf(',')
    if (comma === -1 || entry.slice(0, comma) !== 'v1') return false
    const candidate = Buffer.from(entry.slice(comma + 1), 'base64')
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  })
  if (!matched) return null

  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
