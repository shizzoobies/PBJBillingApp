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
    const guard = route.slice(Math.max(0, stepAt - 400), stepAt)
    expect(guard).toContain('settledInvoice &&')
    expect(guard).toContain("event.type === 'checkout.session.completed'")
    expect(guard).toContain("event.type === 'payment_intent.succeeded'")
    expect(guard).not.toContain('payment_failed')
  })

  it('hands the helper the settled invoice (the total AFTER the fee line) and the real notify', () => {
    const call = route.slice(stepAt, stepAt + 300)
    expect(call).toContain('invoice: settledInvoice')
    expect(call).toContain('store: appDataStore')
    expect(call).toContain('notify,')
  })

  it('imports the helper from lib', () => {
    expect(serverSource).toContain("import { flagPaymentAmountMismatch } from './lib/payment-amount-mismatch.js'")
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
