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
    expect(body.slice(branch, branch + 500)).toContain('handled outside the app')
    expect(branch).toBeLessThan(body.indexOf('ensureStripeCustomer('))
    expect(branch).toBeLessThan(body.indexOf('createInvoiceCheckoutSession'))
  })
})
