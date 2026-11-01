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
  it('records the advance after the invoice is paid, and lets a failure be redelivered', () => {
    const succeeded = route.indexOf("} else if (event.type === 'payment_intent.succeeded') {")
    const apply = route.indexOf("status: 'paid',", succeeded)
    const settle = route.indexOf('settledAdvanceCents = await settleCombinedAdvance({', succeeded)
    expect(apply).toBeGreaterThan(succeeded)
    expect(settle).toBeGreaterThan(apply)
    const guard = route.slice(apply, settle)
    expect(guard).toContain('settledInvoice && !settledInvoice.duplicatePayment && object.metadata?.advancePaymentRequestId')
    expect(guard).toContain('paymentApplied = false')
    expect(route.slice(settle, settle + 400)).toContain('paymentApplied = true')
    expect(settle).toBeLessThan(route.indexOf("console.error('[stripe] webhook handling failed:', error)"))
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
  it('the pay page shows what the link collects before minting anything', () => {
    const payStart = serverSource.indexOf('const payLinkMatch = normalizedPath.match(')
    const summary = serverSource.indexOf('renderPaySummaryPage({', payStart)
    expect(summary).toBeGreaterThan(payStart)
    expect(summary).toBeLessThan(serverSource.indexOf('ensureStripeCustomer({ client: payClient', payStart))
    expect(summary).toBeLessThan(serverSource.indexOf('createInvoiceCardCheckoutSession', payStart))
    expect(serverSource.slice(summary - 400, summary)).toContain("requestUrl.searchParams.get('go') !== '1'")
  })
})
