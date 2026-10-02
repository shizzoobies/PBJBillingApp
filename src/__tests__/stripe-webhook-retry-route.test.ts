import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The glue for "a payment that could not be applied is asked for again"
 * (tracker featreq-6a5c6162). The decisions live in db/store-staleness.test.mjs
 * (the locked-row apply, forgetStripeEvent on both backends).
 * `server.js` listens at module scope, so these read the webhook route source:
 * they prove wiring, and a failure means "the routing moved, go look".
 *
 * The property that matters, in one sentence: the event id is ledgered BEFORE
 * the apply (it stops two concurrent deliveries both applying), so a failed
 * apply must take it back out and answer 500 - and ONLY a failed apply may,
 * because forgetting after a successful one redelivers the event and tells the
 * owners twice.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const routeStart = serverSource.indexOf("if (normalizedPath === '/api/stripe/webhook' && request.method === 'POST') {")
const routeEnd = serverSource.indexOf("if (normalizedPath === '/api/resend/webhook' && request.method === 'POST') {")
const route = serverSource.slice(routeStart, routeEnd)
const catchAt = route.indexOf("console.error('[stripe] webhook handling failed:', error)")
const catchBlock = route.slice(catchAt, route.indexOf("sendJson(response, 500, { error: 'webhook_failed' })", catchAt) + 80)

describe('the Stripe webhook takes a failed payment back out of the ledger', () => {
  it('finds the route and its catch', () => {
    expect(routeStart).toBeGreaterThan(-1)
    expect(routeEnd).toBeGreaterThan(routeStart)
    expect(catchAt).toBeGreaterThan(-1)
  })

  it('still ledgers the event BEFORE it applies anything (that is what stops a double apply)', () => {
    const recordAt = route.indexOf('appDataStore.recordStripeEventOnce(event.id, event.type)')
    const applyAt = route.indexOf('await applyPayment(invoice.id')
    expect(recordAt).toBeGreaterThan(-1)
    expect(applyAt).toBeGreaterThan(recordAt)
  })

  it('every apply call goes through the wrapper that records it returned', () => {
    expect(route).not.toContain('appDataStore.applyInvoicePayment(invoice.id')
    expect(route.match(/await applyPayment\(invoice\.id/g)).toHaveLength(3)
    const wrapperAt = route.indexOf('const applyPayment = async (invoiceId, patch) => {')
    const wrapper = route.slice(wrapperAt, wrapperAt + 300)
    const applyAt = wrapper.indexOf('await appDataStore.applyInvoicePayment(invoiceId, patch)')
    const flagAt = wrapper.indexOf('paymentApplied = true')
    expect(applyAt).toBeGreaterThan(-1)
    // The flag flips only AFTER the apply returned - a throw leaves it false.
    expect(flagAt).toBeGreaterThan(applyAt)
    expect(route).toContain('let paymentApplied = false')
  })

  it('forgets the event only when the payment was not applied, then answers 500 webhook_failed', () => {
    const guardAt = catchBlock.indexOf('if (!paymentApplied) {')
    const forgetAt = catchBlock.indexOf('await appDataStore.forgetStripeEvent(event.id)')
    const answerAt = catchBlock.indexOf("sendJson(response, 500, { error: 'webhook_failed' })")
    expect(guardAt).toBeGreaterThan(-1)
    expect(forgetAt).toBeGreaterThan(guardAt)
    expect(answerAt).toBeGreaterThan(forgetAt)
    // Nothing between the guard and the forget but its own try.
    expect(catchBlock.slice(guardAt, forgetAt)).not.toMatch(/else|sendJson/)
  })

  it('a failure to forget is logged loudly and the answer is still the 500', () => {
    const forgetAt = catchBlock.indexOf('await appDataStore.forgetStripeEvent(event.id)')
    expect(catchBlock.slice(forgetAt - 20, forgetAt)).toContain('try {')
    const after = catchBlock.slice(forgetAt, catchBlock.indexOf("sendJson(response, 500"))
    expect(after).toContain('} catch (forgetError) {')
    expect(after).toContain('console.error(')
    expect(after).not.toContain('return')
  })

  it('never forgets anywhere else: a successful apply (or the email after it) cannot cause a redelivery', () => {
    expect(serverSource.match(/forgetStripeEvent\(/g)).toHaveLength(1)
    // The client-email step sits after the catch, outside the try, and has none.
    const emailAt = route.indexOf('paymentEmailKindFor(settledInvoice.status')
    expect(emailAt).toBeGreaterThan(catchAt)
    expect(route.slice(emailAt)).not.toContain('forgetStripeEvent')
  })

  it('no longer claims a 500 is retried into a second chance on its own', () => {
    expect(route).not.toContain('the dedup ledger means the retry cannot double-apply')
    expect(route).toContain('answered "duplicate" and never reach the apply')
  })
})

describe('a redelivered payment_failed that no longer applies is dropped, not announced', () => {
  const failedAt = route.indexOf("} else if (event.type === 'payment_intent.payment_failed') {")
  const failed = route.slice(failedAt, route.indexOf('} catch (error) {', failedAt))

  it('finds the branch', () => {
    expect(failedAt).toBeGreaterThan(-1)
  })

  it('skips BEFORE applying anything when the invoice is paid or now carries a different payment intent', () => {
    const guardAt = failed.indexOf("invoice.status === 'paid' ||")
    const applyAt = failed.indexOf('await applyPayment(invoice.id')
    expect(guardAt).toBeGreaterThan(-1)
    expect(applyAt).toBeGreaterThan(guardAt)
    const guard = failed.slice(guardAt, applyAt)
    expect(guard).toContain('invoice.stripePaymentIntentId !== object.id')
    // Acknowledged (200), so Stripe stops retrying, with one log line and a return.
    expect(guard).toContain("sendJson(response, 200, { received: true, ignored: 'stale_payment_failure' })")
    expect(guard).toContain('console.warn(')
    expect(guard).toContain('return')
  })

  it('skips the failure log and the owner notification when the store left the invoice paid (or there is nothing to write on)', () => {
    const applyAt = failed.indexOf('await applyPayment(invoice.id')
    const checkAt = failed.indexOf("if (!failedInvoice || failedInvoice.status === 'paid') {")
    const logAt = failed.indexOf('recordInvoicePaymentFailure(')
    const notifyAt = failed.indexOf("'invoice_payment_failed'")
    expect(checkAt).toBeGreaterThan(applyAt)
    expect(logAt).toBeGreaterThan(checkAt)
    expect(notifyAt).toBeGreaterThan(checkAt)
    expect(failed.slice(checkAt, logAt)).toContain('return')
  })

  it('does not drop a decline on an invoice that is simply still sent (nothing moves, owners still hear)', () => {
    // The skip keys on paid / a different intent / no row, never on "status did not change".
    expect(failed).not.toContain('statusChanged')
  })
})
