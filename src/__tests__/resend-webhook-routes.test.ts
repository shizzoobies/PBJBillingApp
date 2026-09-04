import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Resend delivery webhook's glue, pinned the way the coverage routes are
 * and for the same reason: server.js listens at module scope and exports
 * nothing, so there is no HTTP harness here. The DECISIONS are tested properly
 * elsewhere — the signature check in lib/resend-webhook.test.mjs, the log write
 * in the store. What is left is wiring, and a few specific ways it can rot into
 * something dangerous.
 *
 * Treat a failure here as "the route changed, go look", not as a behavioral
 * regression.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard to the next route match. */
function routeBlock(startPattern: RegExp, length = 4000): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const block = () =>
  routeBlock(
    /if \(normalizedPath === '\/api\/resend\/webhook' && request\.method === 'POST'\)/,
    6000,
  )

describe('the Resend webhook verifies before it trusts anything', () => {
  // The endpoint is unauthenticated by necessity. If the body were parsed — or
  // worse, acted on — before the signature check, anyone on the internet could
  // write "bounced" into a client's invoice history.
  it('reads the RAW bytes and verifies them before anything is parsed', () => {
    const text = block()
    expect(text).toContain('await readRawBody(request)')
    expect(text).toContain('verifyResendWebhook(rawBody, request.headers)')
    expect(text.indexOf('readRawBody')).toBeLessThan(text.indexOf('verifyResendWebhook'))
    // The parse belongs to the verifier, on bytes it has already authenticated.
    expect(text).not.toContain('readJsonBody')
    expect(text).not.toContain('JSON.parse')
  })

  it('rejects an unverifiable event with a 400, before any store call', () => {
    const text = block()
    const verifyAt = text.indexOf('verifyResendWebhook')
    expect(text.slice(verifyAt, verifyAt + 400)).toContain(
      "sendJson(response, 400, { error: 'Invalid signature' })",
    )
    expect(verifyAt).toBeLessThan(text.indexOf('appDataStore'))
  })

  // No secret means we cannot tell Resend from anyone else. Same answer the
  // Stripe endpoint gives, and it has to come FIRST — refusing after reading
  // the body would still have let an unsigned request get that far.
  it('answers 503 when no signing secret is configured, ahead of the body read', () => {
    const text = block()
    expect(text).toContain('if (!isResendWebhookConfigured())')
    expect(text).toContain(
      "sendJson(response, 503, { error: 'Resend webhooks are not configured' })",
    )
    expect(text.indexOf('isResendWebhookConfigured')).toBeLessThan(text.indexOf('readRawBody'))
  })
})

describe('what the Resend webhook may and may not do to an invoice', () => {
  // THE RULE. A bounce does not un-send an invoice: it went out, the payment
  // clock is running, and what is wrong is the address. A mail provider must
  // never be able to move money state.
  it('never writes a status, a payment or a send', () => {
    const text = block()
    expect(text).not.toContain('applyInvoicePayment')
    expect(text).not.toContain('recordInvoiceSent')
    expect(text).not.toContain('updateInvoice')
    expect(text).not.toMatch(/status:\s*'/)
    // The one write it is allowed.
    expect(text).toContain('appDataStore.recordInvoiceDeliveryEvent(')
  })

  // An event about a message we cannot place is not something Resend can fix
  // by retrying it for three days.
  it('answers 200 for an invoice it cannot find, rather than making Resend retry', () => {
    const text = block()
    const missingAt = text.indexOf('if (!deliveryInvoice) {')
    expect(missingAt).toBeGreaterThan(-1)
    expect(text.slice(missingAt, missingAt + 500)).toContain(
      'sendJson(response, 200, { received: true, matched: false })',
    )
    expect(text.slice(missingAt, missingAt + 500)).toContain('console.warn(')
  })

  it('acknowledges an event type it does not record, without touching the store', () => {
    const text = block()
    const ignoreAt = text.indexOf('if (!deliveryEvent) {')
    expect(ignoreAt).toBeGreaterThan(-1)
    expect(text.slice(ignoreAt, ignoreAt + 400)).toContain(
      'sendJson(response, 200, { received: true, ignored: true })',
    )
    expect(ignoreAt).toBeLessThan(text.indexOf('appDataStore'))
  })

  // Resend retries until it gets a 200, so the same bounce arrives more than
  // once. The store dedupes the log entry; this guard is what keeps the owners
  // from hearing about the same bounce twice.
  it('notifies every owner on a bounce or a complaint, but only the first time', () => {
    const text = block()
    expect(text).toContain('const alreadyLogged =')
    expect(text).toContain(
      "if (!alreadyLogged && (deliveryEvent === 'bounced' || deliveryEvent === 'complained'))",
    )
    expect(text).toContain("'invoice_email_bounced'")
    expect(text).toContain("members.filter((member) => member.role === 'owner')")
  })
})
