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
      'markPaidByCreditAndClose(session.user.id, invoice',
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
    const stamp = body.indexOf('markPaidByCreditAndClose(')
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
    expect(stamp).toContain('markPaidByCreditAndClose')
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

  it('answers a raced refusal as invoice_changed (so the row reloads) and a failed stamp with a 500, sending nothing either way', () => {
    const body = sendRoute()
    const start = body.indexOf('markPaidByCreditAndClose(session.user.id, invoice')
    const catchBlock = body.slice(start, body.indexOf('invoice = paidByCredit', start))
    expect(catchBlock).toContain('error instanceof ManualPaymentError')
    expect(catchBlock).toContain("error: 'invoice_changed'")
    expect(catchBlock).not.toContain("error: 'manual_payment_refused'")
    expect(catchBlock).toContain("error: 'paid_by_credit_failed'")
    expect(catchBlock).toContain('nothing was sent')
  })

  it('the shared stamp expires the sessions of the row the stamp RETURNED, and its activity line cannot fail it', () => {
    const helper = between('async function markPaidByCreditAndClose(', 'async function assembleInvoicePreview(')
    expect(helper).toContain('[paid.stripeCheckoutSessionId, paid.stripeCardSessionId]')
    expect(helper.indexOf('expireInvoiceSessions(')).toBeGreaterThan(helper.indexOf('markInvoicePaidByCredit('))
    const activity = helper.indexOf("'invoice_paid_by_credit'")
    expect(helper.lastIndexOf('try {', activity)).toBeGreaterThan(-1)
    expect(helper.indexOf('catch (error)', activity)).toBeGreaterThan(activity)
    // Send does not repeat any of it with the pre-stamp copy.
    expect(sendRoute()).not.toContain('invoice.stripeCheckoutSessionId')
  })

  it('a stamp that landed and an email that did not says so, hands back the paid row, and reloads the page', () => {
    const body = sendRoute()
    expect(body).toContain("error: 'invoice_paid_not_sent'")
    expect(body).toContain('The invoice is marked paid by credit on account; press Send again to email the paid copy.')
    expect(body).toContain('invoice: paidInvoice')
    // Both late failures use it: the provider refusing, and the last look failing.
    const failure = body.slice(body.indexOf('ok: false,'), body.indexOf('// Past this point the email HAS been delivered'))
    expect(failure).toContain('paidNotSent(invoice, sendResult.error)')
    expect(failure).toContain('coveredByCredit')
    expect(body).toContain("paidNotSent(invoice, 'Could not confirm the invoice before sending.')")
    // An ordinary failed send is untouched.
    expect(failure).toContain("error: 'invoice_send_failed', message: sendResult.error")
    // The page treats the code as "this invoice moved": it reloads the month.
    const ui = readFileSync('src/components/InvoiceMonthRun.tsx', 'utf8')
    const moved = ui.slice(ui.indexOf('const INVOICE_MOVED_CODES'), ui.indexOf('])', ui.indexOf('const INVOICE_MOVED_CODES')))
    expect(moved).toContain("'invoice_paid_not_sent'")
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
    const paid = body.indexOf('markPaidByCreditAndClose(session.user.id, updated')
    expect(sent).toBeGreaterThan(-1)
    expect(paid).toBeGreaterThan(sent)
    expect(body).toContain('if (invoicePaidByCreditAtSend(updated)) {')
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

  it('takes ONE stamp for both steps, so the sent date and the paid date cannot differ', () => {
    const body = block()
    expect(body.match(/const stampAt = /g)).toHaveLength(1)
    expect(body).toContain('stamp: stampAt')
    expect(body).toContain('paidAt: stampAt')
  })

  it('a failed paid step has its own sentence, and the sent stamp stands', () => {
    const body = block()
    expect(body).toContain("error: 'not_emailed_paid_failed'")
    expect(body).toContain('could not be marked paid by credit on account')
    expect(body).toContain('Press Mark reviewed again to finish.')
  })
})

describe('Mark reviewed finishes an unfinished never-email paid stamp', () => {
  const finishing = () => between('async function finishUnfinishedCreditPayment(', 'async function assembleInvoicePreview(')

  it('runs ABOVE the review, for a never-email, SENT, credit-covered invoice only', () => {
    const body = patchRoute()
    expect(body.indexOf('await finishUnfinishedCreditPayment(session.user.id, invoiceId, payload)')).toBeGreaterThan(-1)
    expect(body.indexOf('finishUnfinishedCreditPayment(')).toBeLessThan(body.indexOf('appDataStore.updateInvoice('))
    const branch = finishing()
    expect(branch).toContain("payload?.status !== 'reviewed'")
    expect(branch).toContain("Object.keys(payload).every((key) => key === 'status')")
    expect(branch).toContain("existing?.status === 'sent'")
    expect(branch).toContain('invoicePaidByCreditAtSend(existing)')
    expect(branch).toContain('finishClient?.invoiceNoEmail === true')
    expect(branch).toContain('finishClient.platformInvoicingOptOut !== true')
  })

  it('stamps paid and nothing else: no review, no second sent stamp, no email, no minting', () => {
    const branch = finishing()
    expect(branch).toContain('markPaidByCreditAndClose(userId, finishing)')
    for (const forbidden of [
      'updateInvoice',
      'recordInvoiceSent',
      'sendInvoiceEmail',
      'createInvoiceCheckoutSession',
      'getOrCreateInvoicePayToken',
      'ensureStripeCustomer',
    ]) {
      expect(branch, forbidden).not.toContain(forbidden)
    }
    expect(branch).toContain("error: 'not_emailed_paid_failed'")
    expect(branch).toContain("error: 'invoice_changed'")
    expect(branch).toContain('Press Mark reviewed again to finish.')
  })

  it('falls through to the ordinary review when the check itself cannot be made', () => {
    expect(finishing()).toContain('the ordinary review follows')
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
    expect(body.indexOf('markPaidByCreditAndClose(')).toBeLessThan(body.indexOf('planAutopaySend(invoice, sendClient)'))
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
