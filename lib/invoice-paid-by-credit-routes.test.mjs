import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { autopayChargeDecision } from './stripe-autopay.js'
import { buildQboCsv } from './qbo-export.js'

/**
 * Credit on account, stage 1d - the server's wiring for "Paid at Send".
 *
 * `server.js` listens at module scope and exports nothing, so there is no HTTP
 * harness: these pin the wiring (the convention of the never-email and pay-link
 * route tests). The BEHAVIOR half - the stamp on both backends, idempotence, the
 * refusals, the late Stripe payment - runs for real in db/store-staleness.test.mjs;
 * the paid copy in lib/invoice-paid-by-credit.test.mjs.
 */

const source = readFileSync('server.js', 'utf8')

/** The text between two anchors, each of which must exist. */
function between(startAnchor, endAnchor, from = 0) {
  const start = source.indexOf(startAnchor, from)
  expect(start, `${startAnchor} is gone`).toBeGreaterThan(-1)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  expect(end, `${endAnchor} is gone`).toBeGreaterThan(start)
  return source.slice(start, end)
}

const sendRoute = () =>
  between(
    'const invoiceSendMatch = normalizedPath.match(',
    '// GET /api/invoices/:id/preview - exactly what the client receives',
  )
const patchRoute = () =>
  between(
    'const invoicePatchMatch = normalizedPath.match(',
    '// POST /api/invoices/:id/confirm-coverage',
  )

describe('the send route marks a covered invoice paid, in order', () => {
  it('settled guard -> paid-by-credit stamp -> autopay plan -> documents -> email -> recordInvoiceSent', () => {
    const body = sendRoute()
    const at = (needle) => {
      const index = body.indexOf(needle)
      expect(index, `${needle} is gone from the send route`).toBeGreaterThan(-1)
      return index
    }
    const order = [
      'const coveredByCredit = invoicePaidByCreditAtSend(invoice)',
      'const settled = invoice.status ===',
      'appDataStore.markInvoicePaidByCredit(invoice.id',
      'await planAutopaySend(invoice, sendClient)',
      'await buildInvoiceDocuments({',
      'await sendInvoiceEmail({',
      'await appDataStore.recordInvoiceSent(invoice.id, {',
    ].map(at)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('treats the covered invoice as settled, so no link is ever minted for it', () => {
    const body = sendRoute()
    expect(body).toMatch(/const settled = [^\n]*\|\| coveredByCredit/)
    expect(body).toMatch(/invoice\.total > 0 &&\s+!settled/)
  })

  it('stamps only after every refusal (recipients, opt-out, never-email) and before any Stripe call', () => {
    const body = sendRoute()
    const stamp = body.indexOf('markInvoicePaidByCredit(')
    for (const refusal of [
      "error: 'client_opted_out'",
      "error: 'client_not_emailed'",
      "error: 'coverage_unconfirmed'",
      'resolveSendRecipients({',
    ]) {
      expect(body.indexOf(refusal), refusal).toBeGreaterThan(-1)
      expect(body.indexOf(refusal), refusal).toBeLessThan(stamp)
    }
    for (const stripeCall of [
      'ensureStripeCustomer(',
      'getOrCreateInvoicePayToken(',
      'createInvoiceCheckoutSession(',
      'createInvoiceCardCheckoutSession(',
      'swapInvoiceCheckoutSession(',
    ]) {
      expect(body.indexOf(stripeCall), stripeCall).toBeGreaterThan(stamp)
    }
  })

  it('mints nothing and emails nothing inside the stamp itself', () => {
    const body = sendRoute()
    const start = body.indexOf('if (coveredByCredit) {')
    const stamp = body.slice(start, body.indexOf('// STRIPE AUTOPAY (featreq-bef42b72), decided BEFORE', start))
    expect(stamp).toContain('markInvoicePaidByCredit')
    for (const forbidden of [
      'sendInvoiceEmail',
      'createInvoiceCheckoutSession',
      'createInvoiceCardCheckoutSession',
      'getOrCreateInvoicePayToken',
      'swapInvoiceCheckoutSession',
      'ensureStripeCustomer',
    ]) {
      expect(stamp, forbidden).not.toContain(forbidden)
    }
  })

  it('builds the documents from the PAID row, with the same moment the stamp carries', () => {
    const body = sendRoute()
    expect(body).toContain('paidAt: sendStamp')
    expect(body).toContain('invoice = paidByCredit')
    // The documents read `invoice` through invoiceAsSent, after the stamp replaced it.
    expect(body.indexOf('invoice = paidByCredit')).toBeLessThan(
      body.indexOf('const sendInvoice = invoiceAsSent(invoice,'),
    )
    expect(body.match(/const sendStamp = /g)).toHaveLength(1)
  })

  it('answers a refused stamp with a sentence and a failed one with a 500, and sends nothing either way', () => {
    const body = sendRoute()
    const start = body.indexOf('markInvoicePaidByCredit(invoice.id')
    const catchBlock = body.slice(start, body.indexOf('invoice = paidByCredit', start))
    expect(catchBlock).toContain('error instanceof ManualPaymentError')
    expect(catchBlock).toContain("error: 'manual_payment_refused'")
    expect(catchBlock).toContain("error: 'paid_by_credit_failed'")
    expect(catchBlock).toContain('nothing was sent')
  })

  it('closes the sessions an earlier send left on it, like Mark paid', () => {
    const body = sendRoute()
    expect(body).toContain("'paid by credit at send'")
    expect(body).toContain('[invoice.stripeCheckoutSessionId, invoice.stripeCardSessionId]')
  })
})

describe('the preview shows the same paid copy', () => {
  it('builds a covered invoice as paid by credit, settled, with no pay link', () => {
    const preview = between('async function assembleInvoicePreview(', 'async function planAutopaySend(')
    expect(preview).toContain('invoicePaidByCreditAtSend(invoice)')
    expect(preview).toContain('invoiceAsPaidByCredit(invoice, stamp)')
    expect(preview).toMatch(/const settled = [^\n]*\|\| coveredByCredit/)
  })
})

describe('Mark reviewed on a never-email client\'s covered invoice', () => {
  const block = () => {
    const body = patchRoute()
    const start = body.indexOf('stampClient?.invoiceNoEmail === true')
    expect(start, 'the never-email stamp is gone').toBeGreaterThan(-1)
    return body.slice(start, body.indexOf('expireInvoiceSessions', start))
  }

  it('stamps sent first (that stamp needs a reviewed invoice), then paid by credit', () => {
    const body = block()
    const sent = body.indexOf('appDataStore.recordInvoiceSent(updated.id, {')
    const paid = body.indexOf('appDataStore.markInvoicePaidByCredit(updated.id')
    expect(sent).toBeGreaterThan(-1)
    expect(paid).toBeGreaterThan(sent)
    expect(body).toContain('if (invoicePaidByCreditAtSend(updated)) {')
    expect(body).toContain("'invoice_paid_by_credit'")
  })

  it('still sends nothing and mints nothing', () => {
    const body = block()
    for (const forbidden of [
      'sendInvoiceEmail',
      'createInvoiceCheckoutSession',
      'getOrCreateInvoicePayToken',
      'ensureStripeCustomer',
    ]) {
      expect(body, forbidden).not.toContain(forbidden)
    }
  })

  it('a failed paid step has its own sentence, and the sent stamp stands', () => {
    const body = block()
    expect(body).toContain("error: 'not_emailed_paid_failed'")
    expect(body).toContain('could not be marked paid by credit on account')
    expect(body).toContain('Press Mark reviewed again to finish.')
  })
})

describe('un-marking: the unmark route reaches the store, which refuses a credit payment', () => {
  it('answers the store\'s sentence as a 409', () => {
    const route = between('const unmarkPaidMatch = normalizedPath.match(', '// POST /api/invoices/:id/amount-mismatch/handled')
    expect(route).toContain('unmarkManualInvoicePayment(invoiceId')
    expect(route).toContain("error: 'manual_payment_refused'")
  })
})

describe('the webhook meets a late payment for a credit-paid invoice', () => {
  it('reads a duplicate (the store flags it) before it would read a mismatch, and sends no receipt for it', () => {
    const duplicate = source.indexOf('if (settledInvoice?.duplicatePayment) {')
    const mismatch = source.indexOf('await flagPaymentAmountMismatch({', duplicate)
    expect(duplicate).toBeGreaterThan(-1)
    expect(mismatch).toBeGreaterThan(duplicate)
    // The receipt is gated on a real status change, which a duplicate never has.
    const receipt = source.indexOf('settledInvoice.statusChanged &&')
    expect(receipt).toBeGreaterThan(-1)
  })
})

describe('a credit-paid invoice is never charged', () => {
  const ON = { AUTOPAY_CHARGING: 'on' }
  const enrollment = {
    clientId: 'c1',
    status: 'enrolled',
    paymentMethodId: 'pm_bank',
    methodType: 'us_bank_account',
    mandateId: 'mandate_1',
    last4: '6789',
    setupToken: 'tok',
  }
  const client = { id: 'c1', name: 'Acme', cardPaymentsEnabled: false }
  const covered = {
    id: 'inv-1',
    number: 'INV-2026-10-001',
    status: 'reviewed',
    total: 0,
    lineItems: [
      { kind: 'hourly', label: 'Billable hours', detail: '', amount: 600 },
      { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -600, draws: [] },
    ],
    emailLog: [],
  }
  const decide = (invoice) =>
    autopayChargeDecision({ client, invoice, enrollment, attempts: [], env: ON })

  it('sees nothing owed before the stamp and a paid invoice after it', () => {
    expect(decide(covered)).toEqual({ ok: false, reason: 'nothing_owed' })
    expect(decide({ ...covered, status: 'paid', paymentMethod: 'credit' })).toEqual({
      ok: false,
      reason: 'nothing_owed',
    })
    // A positive-total paid invoice is refused for being paid, in the same decision.
    expect(decide({ ...covered, status: 'paid', total: 50 })).toEqual({ ok: false, reason: 'invoice_paid' })
  })

  it('the send route plans autopay AFTER the stamp, from the paid row', () => {
    const body = sendRoute()
    expect(body.indexOf('markInvoicePaidByCredit(')).toBeLessThan(body.indexOf('planAutopaySend(invoice, sendClient)'))
  })
})

describe('QuickBooks gets nothing for a credit payment', () => {
  const lines = [
    { kind: 'hourly', label: 'Billable hours', detail: '', amount: 600 },
    { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -600, draws: [] },
  ]
  const invoice = (over = {}) => ({
    id: 'inv-1',
    number: 'INV-2026-10-001',
    clientId: 'c1',
    period: '2026-10',
    status: 'reviewed',
    lineItems: lines,
    total: 0,
    dueDate: null,
    ...over,
  })
  const clients = new Map([['c1', { name: 'Acme' }]])

  it('exports the service line and the negative Deferred Revenue line, the same rows paid or not', () => {
    const before = buildQboCsv([invoice()], clients)
    const after = buildQboCsv([invoice({ status: 'paid', paymentMethod: 'credit', paidAt: '2026-10-31T12:00:00.000Z' })], clients)
    expect(after).toBe(before)
    const rows = after.split('\r\n')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain('600.00')
    expect(rows[2]).toContain('Deferred Revenue')
    expect(rows[2]).toContain('-600.00')
  })
})
