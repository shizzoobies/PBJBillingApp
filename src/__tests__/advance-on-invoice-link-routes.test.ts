import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Wiring for "one link, one payment" (Brittany, 2026-11-01). `server.js`
 * listens at module scope, so these read the source; the decisions themselves
 * are tested in lib/advance-on-invoice-link.test.mjs and db/store-staleness.test.mjs.
 */
const serverSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'), 'utf8')
const routeStart = serverSource.indexOf("if (normalizedPath === '/api/stripe/webhook' && request.method === 'POST') {")
const route = serverSource.slice(routeStart, serverSource.indexOf("if (normalizedPath === '/api/resend/webhook' && request.method === 'POST') {"))

describe('the Stripe webhook splits a combined payment', () => {
  it('takes the advance-only path only when no invoice is named', () => {
    expect(route).toContain('if (object.metadata?.advancePaymentRequestId && !object.metadata?.invoiceId) {')
    expect(route).not.toMatch(/if \(object\.metadata\?\.advancePaymentRequestId\) \{/)
  })
  it('records the advance only after the invoice payment applied, through the releasing step', () => {
    // Behavior (release + redelivery, owner notice) is tested in
    // lib/advance-on-invoice-link.test.mjs and db/store-staleness.test.mjs.
    const succeeded = route.indexOf("} else if (event.type === 'payment_intent.succeeded') {")
    const apply = route.indexOf("status: 'paid',", succeeded)
    const settle = route.indexOf('settledAdvanceCents = await settleCombinedAdvanceOrRelease({', succeeded)
    expect(apply).toBeGreaterThan(succeeded)
    expect(settle).toBeGreaterThan(apply)
    expect(route.slice(apply, settle)).toContain('settledInvoice && !settledInvoice.duplicatePayment && object.metadata?.advancePaymentRequestId')
  })
  it('expects invoice total + the advance portion in the amount check, and charges the card fee on both', () => {
    const step = route.indexOf('await flagPaymentAmountMismatch(')
    expect(route.slice(step, step + 400)).toContain('advanceCents: settledAdvanceCents')
    expect(route).toContain('cardProcessingFeeLine(invoice, linkAdvanceCents)')
    expect(route).toContain('settledAdvanceCents = combinedAdvanceCents({ eventType: event.type, object, invoice, isCard: isCardChannel })')
  })
})

describe('every payment link carries the live advance', () => {
  it('the pay page, the owner link and both send sessions pass it', () => {
    expect(serverSource).toContain('advance: payAdvance,')
    expect(serverSource).toContain('advance: await invoiceCheckoutAdvance(appDataStore, invoice),')
    expect(serverSource.split('advance: sendAdvance,').length - 1).toBe(2)
  })
  it('the pay page decides summary-or-mint with the tested helper, before any mint or per-link count', () => {
    const payStart = serverSource.indexOf('const payLinkMatch = normalizedPath.match(')
    const step = serverSource.indexOf("payLinkAdvanceStep({ carried: Boolean(payCarried), searchParams: requestUrl.searchParams }) === 'summary'", payStart)
    expect(step).toBeGreaterThan(payStart)
    expect(step).toBeLessThan(serverSource.indexOf('isRateLimited(`token:${payToken}`', payStart))
    expect(step).toBeLessThan(serverSource.indexOf('ensureStripeCustomer({ client: payClient', payStart))
  })

})
