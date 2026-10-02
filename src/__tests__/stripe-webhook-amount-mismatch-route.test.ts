import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The glue for "a payment for a different amount than the invoice total is
 * flagged" (tracker featreq-9cc3c370). The decisions live in
 * lib/payment-amount-mismatch.test.mjs and db/store-staleness.test.mjs;
 * `server.js` listens at module scope, so these read the source and prove
 * wiring - a failure means "the routing moved, go look".
 *
 * What matters about the webhook step: it runs only after a SUCCESSFUL apply and
 * can never cause a forget or a 500, or a redelivered event would flag and
 * notify twice.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const routeStart = serverSource.indexOf("if (normalizedPath === '/api/stripe/webhook' && request.method === 'POST') {")
const routeEnd = serverSource.indexOf("if (normalizedPath === '/api/resend/webhook' && request.method === 'POST') {")
const route = serverSource.slice(routeStart, routeEnd)
const catchAt = route.indexOf("console.error('[stripe] webhook handling failed:', error)")
const stepAt = route.indexOf('await flagPaymentAmountMismatch(')

describe('the Stripe webhook flags a payment for a different amount', () => {
  it('finds the route and the step', () => {
    expect(routeStart).toBeGreaterThan(-1)
    expect(routeEnd).toBeGreaterThan(routeStart)
    expect(stepAt).toBeGreaterThan(-1)
  })

  it('runs AFTER the try/catch that can forget the event, so it can never cause a forget or a 500', () => {
    expect(stepAt).toBeGreaterThan(catchAt)
    const before = route.slice(0, stepAt)
    // Not inside the try: no forgetStripeEvent / webhook_failed can follow it.
    const after = route.slice(stepAt)
    expect(after).not.toContain('forgetStripeEvent')
    expect(after).not.toContain("'webhook_failed'")
    expect(before.lastIndexOf("sendJson(response, 500, { error: 'webhook_failed' })")).toBeLessThan(stepAt)
  })

  it('only after an apply that answered an invoice, and only for the two payment events', () => {
    const guard = route.slice(Math.max(0, stepAt - 700), stepAt)
    expect(guard).toContain("event.type === 'checkout.session.completed'")
    expect(guard).toContain("event.type === 'payment_intent.succeeded'")
    expect(guard).toContain('} else if (settledInvoice) {')
    expect(guard).not.toContain('payment_failed')
  })

  it('hands the helper the settled invoice (the total AFTER the fee line) and the real notify', () => {
    const call = route.slice(stepAt, stepAt + 300)
    expect(call).toContain('invoice: settledInvoice')
    expect(call).toContain('store: appDataStore')
    expect(call).toContain('notify,')
  })

  it('imports the helper from lib', () => {
    expect(serverSource).toContain("  flagPaymentAmountMismatch,")
    expect(serverSource).toContain("} from './lib/payment-amount-mismatch.js'")
  })
})

describe('POST /api/invoices/:id/amount-mismatch/handled', () => {
  const at = serverSource.indexOf('const amountMismatchMatch = normalizedPath.match(')
  const handler = serverSource.slice(at, serverSource.indexOf('// POST /api/invoices/:id/send', at))

  it('exists', () => {
    expect(at).toBeGreaterThan(-1)
    expect(handler).toContain("request.method === 'POST'")
    expect(handler).toContain('amount-mismatch\\/handled')
  })

  it('checks the session, the owner role and the origin, in that order, before writing', () => {
    const sessionAt = handler.indexOf('requireSession(request, response)')
    const roleAt = handler.indexOf("session.user.role !== 'owner'")
    const originAt = handler.indexOf('isCrossSiteOrigin(request)')
    const writeAt = handler.indexOf('acknowledgeInvoiceAmountMismatch(')
    expect(sessionAt).toBeGreaterThan(-1)
    expect(roleAt).toBeGreaterThan(sessionAt)
    expect(originAt).toBeGreaterThan(roleAt)
    expect(writeAt).toBeGreaterThan(originAt)
  })

  it('answers 404 for an unknown invoice and the invoice (with its derived marks) otherwise', () => {
    expect(handler).toContain("sendJson(response, 404, { error: 'Invoice not found' })")
    expect(handler).toContain('invoice: await withCoverageChangeable(updated)')
    expect(handler).toContain('byUserId: session.user.id')
  })
})

/**
 * featreq-c8e5f169 (smaller items): a payment for a VOIDED invoice, and a second
 * payment on an already PAID one. Same rule as above - after the try/catch, so a
 * failure cannot become a forget or a 500.
 */
describe('the Stripe webhook records a payment for a voided or already-paid invoice', () => {
  const duplicateAt = route.indexOf('await flagDuplicatePayment(')
  const voidedAt = route.indexOf('await flagPaymentOnVoidedInvoice(')

  it('has both steps, after the try/catch that can forget the event', () => {
    expect(duplicateAt).toBeGreaterThan(catchAt)
    expect(voidedAt).toBeGreaterThan(catchAt)
    const after = route.slice(Math.min(duplicateAt, voidedAt))
    expect(after).not.toContain('forgetStripeEvent')
    expect(after).not.toContain("'webhook_failed'")
  })

  it('a duplicate is what the STORE says it is, and the amount check is the other branch', () => {
    const guard = route.slice(duplicateAt - 200, duplicateAt)
    expect(guard).toContain('settledInvoice?.duplicatePayment')
    expect(route.indexOf('await flagPaymentAmountMismatch(')).toBeGreaterThan(duplicateAt)
  })

  it('the voided step runs only when an apply RETURNED null, with the invoice first found', () => {
    const guard = route.slice(voidedAt - 120, voidedAt + 500)
    expect(guard).toContain('paymentApplied && lookedUpInvoice')
    expect(guard).toContain('invoice: lookedUpInvoice')
    expect(guard).toContain('getInvoice:')
    expect(route).toContain('lookedUpInvoice = invoice')
  })

  it('imports all three steps from lib', () => {
    expect(serverSource).toContain('flagDuplicatePayment,')
    expect(serverSource).toContain('flagPaymentOnVoidedInvoice,')
  })
})

/**
 * Review round: a failed second BANK payment clears its own flag, the bank-vs-card
 * fact reaches the notices, and the payment-failed notice opens the invoice month.
 */
describe('a failure for a started second payment, and the notices\' wording and link', () => {
  const clearCalls = [...route.matchAll(/await clearDuplicatePaymentOnFailure\(\{/g)].map(
    (match) => match.index as number,
  )

  it('clears the duplicate in BOTH stale-failure returns, before answering, never after a status write', () => {
    expect(clearCalls).toHaveLength(2)
    for (const at of clearCalls) {
      const after = route.slice(at, at + 400)
      expect(after).toContain('store: appDataStore')
      expect(after).toContain('sendJson(response, 200, { received: true, ignored: \'stale_payment_failure\' })')
    }
    // The first return looks at the pre-read invoice, the second at the store's own row.
    expect(route.slice(clearCalls[0], clearCalls[0] + 300)).toContain('invoice,')
    expect(route.slice(clearCalls[1], clearCalls[1] + 300)).toContain('invoice: failedInvoice')
  })

  it('tells the duplicate and voided steps which channel paid', () => {
    expect(route.slice(route.indexOf('await flagDuplicatePayment('), route.indexOf('await flagDuplicatePayment(') + 300)).toContain(
      'isCard: settledByCard',
    )
    expect(
      route.slice(route.indexOf('await flagPaymentOnVoidedInvoice('), route.indexOf('await flagPaymentOnVoidedInvoice(') + 400),
    ).toContain('isCard: settledByCard')
  })

  it('the payment-failed notice opens the invoice month, like the others', () => {
    const at = route.indexOf("'invoice_payment_failed', {")
    expect(at).toBeGreaterThan(-1)
    expect(route.slice(at, at + 400)).toContain('link: invoicePeriodLink(invoice)')
    expect(serverSource).toContain('invoicePeriodLink,')
  })
})
