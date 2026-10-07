import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * POST /api/invoices/:id/amount-mismatch/apply-credit (credit on account, stage
 * 1e): a double payment becomes a credit on the client's account. server.js
 * listens at module scope and exports nothing, so this pins the wiring by
 * reading the source; the decisions live in lib/payment-amount-mismatch.test.mjs
 * (planOverpaymentCredit) and the one-step write in db/store-staleness.test.mjs.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const start = serverSource.indexOf('const applyCreditMatch = normalizedPath.match(')
const handler = serverSource.slice(start, serverSource.indexOf('// POST /api/invoices/:id/send', start))
const squash = (text: string) => text.replace(/\s+/g, ' ')

describe('POST /api/invoices/:id/amount-mismatch/apply-credit', () => {
  it('exists, answers POST on its own path', () => {
    expect(start).toBeGreaterThan(-1)
    expect(handler).toContain("request.method === 'POST'")
    expect(handler).toContain('amount-mismatch\\/apply-credit')
  })

  it('checks session, owner role, origin and JSON, in that order, before anything is read or asked', () => {
    const order = [
      'requireSession(request, response)',
      "session.user.role !== 'owner'",
      'isCrossSiteOrigin(request)',
      'application/json',
      'readJsonBody(request)',
      'retrievePaymentIntentFacts(',
      'applyOverpaymentAsCredit(',
    ].map((needle) => handler.indexOf(needle))
    expect(order.every((at) => at > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(handler).toContain('sendJson(response, 403')
    expect(handler).toContain('sendJson(response, 415')
  })

  it('answers 404 for an unknown invoice', () => {
    expect(handler).toContain("sendJson(response, 404, { error: 'Invoice not found' })")
    expect(handler.indexOf("'Invoice not found'")).toBeLessThan(handler.indexOf('retrievePaymentIntentFacts('))
  })

  it('asks STRIPE, never the browser, and only for a payment that is waiting on this invoice', () => {
    const text = squash(handler)
    expect(text).toContain('duplicatePaymentWaiting(invoice.emailLog, paymentIntentId)')
    expect(text).toContain('await retrievePaymentIntentFacts(paymentIntentId)')
    // The credit amount comes from the plan (Stripe's amount_received, or a lower figure), not the body.
    expect(text).toContain('cents: plan.cents')
    expect(text).toContain('requestedAmount: body.amount')
    expect(handler).not.toMatch(/cents: body|body\.cents/)
  })

  it("sends the plan's refusal as its status and code (processing, wrong invoice, too high ...)", () => {
    const text = squash(handler)
    expect(text).toContain('planOverpaymentCredit({')
    expect(text).toContain('if (!plan.ok) {')
    expect(text).toContain('sendJson(response, plan.status, { error: plan.code, message: plan.message })')
    expect(handler.indexOf('planOverpaymentCredit(')).toBeLessThan(handler.indexOf('applyOverpaymentAsCredit('))
  })

  it('a replay answers the existing credit and handles nothing again', () => {
    const text = squash(handler)
    expect(text).toContain('duplicatePaymentLogged(invoice.emailLog, paymentIntentId)')
    expect(text).toContain('findOverpaymentCredit(paymentIntentId)')
    expect(handler.indexOf('findOverpaymentCredit(')).toBeLessThan(handler.indexOf('retrievePaymentIntentFacts('))
    expect(text).toContain('replayed: true')
  })

  it('writes the credit and the handled entry through ONE store call, as the signed-in owner', () => {
    const text = squash(handler)
    expect(text).toContain('appDataStore.applyOverpaymentAsCredit(invoice.id, {')
    expect(text).toContain('byUserId: session.user.id')
    // Not the multi-marker acknowledge, and not a second store call for the credit.
    expect(handler).not.toContain('acknowledgeInvoiceAmountMismatch')
    expect(handler).not.toContain('appDataStore.addAccountCredit')
  })

  it("answers the store's refusals as a 409 sentence, never a 500", () => {
    expect(handler).toContain('error instanceof AccountCreditError')
    expect(squash(handler)).toContain("error: 'credit_refused'")
  })

  it('trails an activity entry for a new credit and answers the credit row and the updated invoice', () => {
    const text = squash(handler)
    expect(text).toContain('recordActivity(')
    expect(text).toContain("'account_credit_added'")
    expect(text).toContain('invoice: await withCoverageChangeable(result.invoice)')
    expect(text).toContain('credit: result.credit')
  })

  it('imports its helpers', () => {
    expect(serverSource).toContain('  duplicatePaymentLogged,')
    expect(serverSource).toContain('  duplicatePaymentWaiting,')
    expect(serverSource).toContain('  planOverpaymentCredit,')
    expect(serverSource).toContain('  retrievePaymentIntentFacts,')
  })

  it('Mark as handled is untouched: it still acknowledges every unhandled marker', () => {
    const at = serverSource.indexOf('const amountMismatchMatch = normalizedPath.match(')
    const marked = serverSource.slice(at, serverSource.indexOf('const applyCreditMatch', at))
    expect(marked).toContain('acknowledgeInvoiceAmountMismatch(invoiceId')
    expect(marked).not.toContain('applyOverpaymentAsCredit')
  })
})

describe('the webhook flips a settled bank duplicate (and changes nothing else)', () => {
  it('flagDuplicatePayment is still the only duplicate step, called after the try/catch', () => {
    const route = serverSource.slice(
      serverSource.indexOf("if (normalizedPath === '/api/stripe/webhook' && request.method === 'POST') {"),
      serverSource.indexOf("if (normalizedPath === '/api/resend/webhook' && request.method === 'POST') {"),
    )
    expect(route.match(/await flagDuplicatePayment\(/g)).toHaveLength(1)
    expect(route).not.toContain('settleDuplicatePaymentMarker')
  })
})
