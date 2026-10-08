import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The glue for "a refund or a dispute on a second payment that became credit on
 * account is noticed" (tracker featreq-cadfcb44). The decisions live in
 * lib/payment-amount-mismatch.test.mjs and db/store-staleness.test.mjs;
 * `server.js` listens at module scope, so these read the source and prove
 * wiring - a failure means "the routing moved, go look".
 *
 * What matters about the branch: it sits AFTER the event ledger (a redelivery is
 * answered `duplicate` first) and BEFORE the invoice lookup (a Charge or a
 * Dispute carries no invoice id and must never reach the payment path), and it
 * only notices - it never applies a payment or voids a credit.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const routeStart = serverSource.indexOf("if (normalizedPath === '/api/stripe/webhook' && request.method === 'POST') {")
const routeEnd = serverSource.indexOf("if (normalizedPath === '/api/resend/webhook' && request.method === 'POST') {")
const route = serverSource.slice(routeStart, routeEnd)

const ledgerAt = route.indexOf('await appDataStore.recordStripeEventOnce(event.id, event.type)')
const duplicateAt = route.indexOf('duplicate: true')
const branchAt = route.indexOf('if (isPaymentReversalEvent(event)) {')
const lookupAt = route.indexOf('await appDataStore.findInvoiceByStripeRef(')
const catchAt = route.indexOf("console.error('[stripe] webhook handling failed:', error)")
const branch = route.slice(branchAt, route.indexOf('const object = event.data?.object', branchAt))

describe('the Stripe webhook notices a refund or a dispute', () => {
  it('finds the route and the branch', () => {
    expect(routeStart).toBeGreaterThan(-1)
    expect(routeEnd).toBeGreaterThan(routeStart)
    expect(branchAt).toBeGreaterThan(-1)
  })

  it('ledgers the event id first: a redelivery is answered duplicate before the branch', () => {
    expect(ledgerAt).toBeGreaterThan(-1)
    expect(duplicateAt).toBeGreaterThan(ledgerAt)
    expect(branchAt).toBeGreaterThan(duplicateAt)
  })

  it('sits before the invoice lookup, so a Charge or a Dispute never reaches the payment path', () => {
    expect(lookupAt).toBeGreaterThan(branchAt)
    expect(route.indexOf('const applyPayment = async')).toBeLessThan(branchAt)
    expect(route.slice(branchAt, lookupAt)).not.toContain('applyPayment(')
  })

  it('runs inside the try, so a store failure takes the event back out of the ledger for Stripe to retry', () => {
    const tryAt = route.lastIndexOf('try {', branchAt)
    expect(tryAt).toBeGreaterThan(-1)
    expect(tryAt).toBeGreaterThan(duplicateAt)
    expect(catchAt).toBeGreaterThan(branchAt)
    expect(route.slice(catchAt)).toContain('forgetStripeEvent(event.id)')
  })

  it('only notices: no apply, no void, no forget, no status write in the branch', () => {
    expect(branch).toContain('flagPaymentReversal({')
    for (const forbidden of ['applyPayment', 'applyInvoicePayment', 'voidAccountCredit', 'forgetStripeEvent', 'updateInvoice']) {
      expect(branch).not.toContain(forbidden)
    }
  })

  it('hands the helper the real store and notify, and answers 200 with whether anything matched', () => {
    expect(branch).toContain('store: appDataStore')
    expect(branch).toContain('notify,')
    expect(branch).toContain('appPublicUrl: getPublicAppUrl(request)')
    expect(branch).toContain('sendJson(response, 200, { received: true, matched: reversal.matched })')
    expect(branch).toContain('return')
  })

  it('imports the helpers from lib', () => {
    expect(serverSource).toContain('  flagPaymentReversal,')
    expect(serverSource).toContain('  isPaymentReversalEvent,')
    expect(serverSource).toContain("} from './lib/payment-amount-mismatch.js'")
  })

  it('handles exactly the three event types, and the other events still reach the payment path', () => {
    const lib = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/payment-amount-mismatch.js'),
      'utf8',
    )
    expect(lib).toMatch(
      /export const PAYMENT_REVERSAL_EVENT_TYPES = \[\s*'charge\.refunded',\s*'charge\.dispute\.created',\s*'charge\.dispute\.closed',\s*\]/,
    )
    expect(route).toContain("event.type === 'checkout.session.completed'")
    expect(route).toContain("event.type === 'payment_intent.succeeded'")
    expect(route).toContain("event.type === 'payment_intent.payment_failed'")
  })
})
