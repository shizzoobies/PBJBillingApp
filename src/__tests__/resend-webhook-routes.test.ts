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
    // Wide enough for the proposal, engagement and questionnaire branches ahead
    // of the invoice lookup; a longer route block is not a reason to re-anchor.
    // (7000 -> 8000 when the engagement branch arrived, 2026-10-11.)
    8000,
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
    expect(text.slice(missingAt, missingAt + 1200)).toContain(
      'sendJson(response, 200, { received: true, matched: false })',
    )
    // An event for a message that CLAIMED an invoice (tagged) and cannot be placed
    // is worth a warning.
    const warnAt = text.indexOf('console.warn(', missingAt)
    expect(warnAt).toBeGreaterThan(-1)
    expect(text.slice(missingAt, warnAt)).toContain('if (!taggedInvoiceId) {')
  })

  // featreq-c8e5f169 (B ii): notification, sign-in and report mail goes through
  // Resend with no invoice tag. Every event for it used to log an "unknown
  // invoice" warning; it must be answered quietly instead.
  it('does not warn for mail that names no invoice, and skips internal mail before any lookup', () => {
    const text = block()
    const missingAt = text.indexOf('if (!deliveryInvoice) {')
    const untaggedAt = text.indexOf('if (!taggedInvoiceId) {', missingAt)
    const warnAt = text.indexOf('console.warn(', missingAt)
    expect(untaggedAt).toBeGreaterThan(missingAt)
    expect(untaggedAt).toBeLessThan(warnAt)
    const untagged = text.slice(untaggedAt, warnAt)
    // Silent: no warn (Node's console.debug prints too, so there is no line at all).
    expect(untagged).not.toContain('console.warn(')
    expect(untagged).not.toContain('console.debug(')
    expect(untagged).not.toContain('console.log(')
    expect(untagged).toContain('sendJson(response, 200, { received: true, matched: false })')

    const internalAt = text.indexOf('if (tagBag.kind === INTERNAL_EMAIL_KIND) {')
    expect(internalAt).toBeGreaterThan(-1)
    expect(internalAt).toBeLessThan(text.indexOf('appDataStore.listInvoices()'))
    expect(internalAt).toBeLessThan(text.indexOf('findInvoiceByEmailProviderId'))
    expect(text.slice(internalAt, internalAt + 200)).toContain('sendJson(response, 200,')
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

describe('an engagement letter event goes on the engagement, never on an invoice', () => {
  const helper = () => {
    const start = serverSource.indexOf('async function recordEngagementDelivery(')
    expect(start, 'recordEngagementDelivery is gone').toBeGreaterThan(-1)
    const rest = serverSource.slice(start)
    const end = rest.search(/\r?\n\}\r?\n/)
    expect(end, 'recordEngagementDelivery has no end').toBeGreaterThan(-1)
    return rest.slice(0, end + 3)
  }

  it('routes an engagement_id tag to the engagement before the questionnaire and invoice lookups', () => {
    const text = block()
    const branchAt = text.indexOf("if (typeof tagBag.engagement_id === 'string' && tagBag.engagement_id) {")
    expect(branchAt).toBeGreaterThan(-1)
    expect(branchAt).toBeGreaterThan(text.indexOf("if (typeof tagBag.proposal_id === 'string' && tagBag.proposal_id) {"))
    expect(branchAt).toBeLessThan(text.indexOf("if (typeof tagBag.questionnaire_id === 'string' && tagBag.questionnaire_id) {"))
    expect(branchAt).toBeLessThan(text.indexOf('appDataStore.listInvoices()'))
    const branch = text.slice(branchAt, branchAt + 400)
    expect(branch).toContain('await recordEngagementDelivery(request, tagBag.engagement_id, deliveryEvent, resendEvent)')
    expect(branch).toContain('sendJson(response, 200, { received: true, matched })')
  })

  it('appends the event through the store, idempotently, and never writes a status', () => {
    const text = helper()
    expect(text).toContain('appDataStore.getEngagement(engagementId)')
    expect(text).toContain('appDataStore.appendEngagementEmailEvent(engagement.id, {')
    expect(text).toContain("kind: 'delivery',")
    for (const write of ['signEngagement', 'voidEngagement', 'updateEngagement', 'markEngagementSent', 'recordInvoiceDeliveryEvent']) {
      expect(text).not.toContain(write)
    }
    expect(text).not.toMatch(/status:\s*'/)
    // An event for an engagement that is gone is answered 200 (matched: false), not retried for days.
    expect(text).toContain('return false')
  })

  it('tells the owners once on a bounce or a complaint, with the ordinary event and no document', () => {
    const text = helper()
    expect(text).toContain('const alreadyLogged =')
    expect(text).toContain("if (!alreadyLogged && (deliveryEvent === 'bounced' || deliveryEvent === 'complained'))")
    expect(text).toContain("notify(appDataStore, owner.id, 'invoice_email_bounced', {")
    expect(text).toContain("members.filter((member) => member.role === 'owner')")
    expect(text).toContain('link: `/engagements/${engagement.id}`')
    expect(text).not.toMatch(/attachments|pdf|letterBody|emailBody/i)
  })
})
