import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * "Generate the invoice but never email it" (featreq-21d0bba8 answer 8,
 * Rivercity) - the server's wiring.
 *
 * `server.js` listens at module scope and exports nothing, so there is no HTTP
 * harness: these pin the wiring (the same convention as the pay-link and
 * rate-version route tests). The BEHAVIOR half - generation not skipped, the
 * sent stamp with no email, autopay refusing - is exercised for real in
 * db/store-staleness.test.mjs and lib/stripe-autopay.test.mjs.
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

const patchRoute = () =>
  between(
    'const invoicePatchMatch = normalizedPath.match(',
    '// POST /api/invoices/:id/confirm-coverage',
  )

describe('Mark reviewed also marks a never-email client’s invoice sent', () => {
  it('stamps through recordInvoiceSent with notEmailed, only after a review', () => {
    const body = patchRoute()
    expect(body).toContain("updated.status === 'reviewed' && payload?.status === 'reviewed'")
    expect(body).toContain('invoiceNoEmail === true')
    expect(body).toContain('appDataStore.recordInvoiceSent(updated.id, {')
    expect(body).toContain('notEmailed: true')
  })

  it('sends nothing and mints nothing on that path', () => {
    const body = patchRoute()
    const start = body.indexOf('invoiceNoEmail === true')
    const stamp = body.slice(start, body.indexOf('expireInvoiceSessions', start))
    for (const forbidden of [
      'sendInvoiceEmail',
      'createInvoiceCheckoutSession',
      'createInvoiceCardCheckoutSession',
      'getOrCreateInvoicePayToken',
      'swapInvoiceCheckoutSession',
      'ensureStripeCustomer',
    ]) {
      expect(stamp, `${forbidden} must not run when a never-email invoice is marked sent`).not.toContain(
        forbidden,
      )
    }
  })

  it('leaves a platform-invoicing opt-out client alone (nothing is stamped for them)', () => {
    const body = patchRoute()
    const start = body.indexOf('invoiceNoEmail === true')
    expect(body.slice(start, start + 200)).toContain('platformInvoicingOptOut')
  })

  it('answers a failed stamp with its own sentence rather than a silent success', () => {
    const body = patchRoute()
    expect(body).toContain("error: 'not_emailed_stamp_failed'")
    expect(body).toContain('Press Mark reviewed again to finish.')
  })
})

describe('the stamp step is honest about what it did', () => {
  const stampBlock = () => {
    const body = patchRoute()
    const start = body.indexOf('const stampFailure = {')
    expect(start, 'the stamp block is gone').toBeGreaterThan(-1)
    return body.slice(start, body.indexOf('expireInvoiceSessions', start))
  }

  it('records the activity only when something was actually stamped', () => {
    const block = stampBlock()
    const inside = block.indexOf('if (stamped) {')
    const activity = block.indexOf("'invoice_marked_sent_not_emailed'")
    expect(inside).toBeGreaterThan(-1)
    expect(activity).toBeGreaterThan(inside)
    // ...and that block closes only after the activity call.
    expect(block.indexOf("} catch (error) {", inside)).toBeGreaterThan(activity)
  })

  it('answers 500 when the client could not be read, instead of skipping the stamp with a 200', () => {
    const block = stampBlock()
    const read = block.indexOf('appDataStore.getClientById(updated.clientId)')
    expect(read).toBeGreaterThan(-1)
    expect(block.slice(read - 40, read + 400)).toContain('sendJson(response, 500, stampFailure)')
    expect(block).not.toMatch(/getClientById\(updated\.clientId\)\.catch\(/)
  })
})

describe('switching a client to never-email closes its open payment pages, and no receipt is emailed', () => {
  it('the bulk save reads who was never-email before, then expires sessions for the newly switched on', () => {
    const before = source.indexOf('.clientIdsWithNoEmail()')
    const write = source.indexOf('appDataStore.write(data, { expectedVersion')
    const expire = source.indexOf('await expireOpenSessionsForClients(')
    expect(before).toBeGreaterThan(-1)
    expect(before).toBeLessThan(write)
    expect(expire).toBeGreaterThan(write)
    expect(source.slice(expire, expire + 400)).toContain('invoiceNoEmail === true && !noEmailBefore.has(')
  })

  it('the helper closes only sent and overdue invoices of the named clients, through the shared expiry', () => {
    const helper = between('async function expireOpenSessionsForClients(', 'async function readInvoiceNow(')
    expect(helper).toContain("invoice.status === 'sent' || invoice.status === 'overdue'")
    expect(helper).toContain('expireInvoiceSessions(')
    expect(helper).toContain('stripeCheckoutSessionId')
    expect(helper).toContain('stripeCardSessionId')
  })

  it('the Stripe webhook skips the receipt email for a never-email client and logs it', () => {
    const skip = source.indexOf('paidClient?.invoiceNoEmail')
    expect(skip).toBeGreaterThan(-1)
    expect(skip).toBeLessThan(source.indexOf('await sendInvoicePaymentEmail({', skip))
    expect(source.slice(skip, skip + 700)).toContain('payment email skipped')
  })
})

describe('nothing can email, link or take payment for a never-email client', () => {
  const REFUSAL = "error: 'client_not_emailed'"

  it('the send route refuses before it resolves recipients or mints anything', () => {
    const body = between(
      'const invoiceSendMatch = normalizedPath.match(',
      '// A billing master has no contacts of its own',
    )
    expect(body).toContain('sendClient.invoiceNoEmail')
    expect(body).toContain(REFUSAL)
    // And it is still above every Stripe call and the email.
    const route = source.slice(source.indexOf('const invoiceSendMatch = normalizedPath.match('))
    const refusal = route.indexOf(REFUSAL)
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(route.indexOf('ensureStripeCustomer('))
    expect(refusal).toBeLessThan(route.indexOf('sendInvoiceEmail('))
  })

  it('the payment-link route refuses before a Stripe session exists', () => {
    const route = source.slice(source.indexOf('invoiceClient.platformInvoicingOptOut'))
    const refusal = route.indexOf('invoiceClient.invoiceNoEmail')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(route.indexOf('ensureStripeCustomer('))
    expect(route.slice(refusal, refusal + 400)).toContain(REFUSAL)
  })

  it('the pay page says it is handled outside the app and mints no session', () => {
    const body = between('const payLinkMatch = normalizedPath.match(', "if (normalizedPath === '/api/logout'")
    const branch = body.indexOf('payClient.invoiceNoEmail')
    expect(branch).toBeGreaterThan(-1)
    // The pay page copy: plain, and it points at the firm's billing address.
    const copy = body.slice(branch, branch + 500)
    expect(copy).toContain("can't be paid online")
    expect(copy).toContain('Please pay as arranged, or contact billing@pbjsa.com.')
    expect(branch).toBeLessThan(body.indexOf('ensureStripeCustomer('))
    expect(branch).toBeLessThan(body.indexOf('createInvoiceCheckoutSession'))
  })
})
