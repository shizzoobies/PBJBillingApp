import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The unpaid-prepayment send guard (billing period, stage 2) - the server's wiring.
 *
 * `server.js` listens at module scope and exports nothing, so there is no HTTP
 * harness: these pin the wiring (the same convention as the never-email and pay-link
 * route tests). The RULE is exercised for real in lib/billing-period.test.mjs and
 * db/store-staleness.test.mjs.
 */

const source = readFileSync('server.js', 'utf8')

const sendRoute = () => {
  const start = source.indexOf('const invoiceSendMatch = normalizedPath.match(')
  expect(start, 'the send route is gone').toBeGreaterThan(-1)
  return source.slice(start)
}

// The one body every route that would put a later month out as sent answers with (M-1: the
// never-email Mark reviewed shares it with Send).
const refusalHelper = () => {
  const start = source.indexOf('function prepaymentHoldRefusal(hold, allowAnyway)')
  expect(start, 'the shared refusal helper is gone').toBeGreaterThan(-1)
  return source.slice(start, start + 700)
}

describe('the shared refusal', () => {
  it('answers prepayment_unpaid with the reason, the sentence and the anchor, unless the owner said anyway to an unpaid anchor', () => {
    const helper = refusalHelper()
    expect(helper).toContain("error: 'prepayment_unpaid'")
    expect(helper).toContain('reason: hold.reason')
    expect(helper).toContain('message: hold.message')
    expect(helper).toContain("hold.reason === 'unpaid' && allowAnyway === true")
    // 'processing' and 'not_applied' are never lifted.
    expect(helper).not.toContain("'processing'")
    expect(helper).not.toContain("'not_applied'")
  })
})

describe('the send route', () => {
  it('refuses with the shared 409 body', () => {
    const route = sendRoute()
    const guard = route.indexOf('await appDataStore.unpaidPrepaymentFor(invoice)')
    expect(guard).toBeGreaterThan(-1)
    const block = route.slice(guard - 120, guard + 400)
    expect(block).toContain('prepaymentHoldRefusal(')
    expect(block).toContain('sendJson(response, 409, prepaymentRefusal)')
  })

  // M-8: the server decides on the rows as they are at send time. The check runs on
  // EVERY send (the override only lifts the 'unpaid' hold), and the 'not_applied'
  // hold (anchor paid, this invoice never drew it) cannot be overridden.
  it('re-derives the hold at send time and lets Send anyway lift only the unpaid reason', () => {
    const route = sendRoute()
    const guard = route.indexOf('await appDataStore.unpaidPrepaymentFor(invoice)')
    expect(guard).toBeGreaterThan(-1)
    const line = route.slice(guard, guard + 400)
    expect(line).toContain('sendPayload?.allowUnpaidPrepayment')
    expect(route.slice(Math.max(0, guard - 1200), guard)).not.toContain('allowUnpaidPrepayment !== true')
    // 'processing' (anchor payment still clearing) and 'not_applied' are never lifted.
    expect(line).not.toContain("'processing'")
    expect(line).not.toContain("'not_applied'")
  })

  it('asks before anything is resolved, minted or emailed, and after the never-email refusal', () => {
    const route = sendRoute()
    const guard = route.indexOf('sendJson(response, 409, prepaymentRefusal)')
    expect(guard).toBeGreaterThan(route.indexOf("error: 'client_not_emailed'"))
    expect(route.indexOf('await appDataStore.unpaidPrepaymentFor(invoice)')).toBeGreaterThan(
      route.indexOf("error: 'client_not_emailed'"),
    )
    for (const later of [
      'invoiceEmailAddressee(',
      'resolveInvoiceRecipients(',
      'planAutopaySend(',
      'ensureStripeCustomer(',
      'createInvoiceCheckoutSession(',
      'sendInvoiceEmail(',
    ]) {
      const at = route.indexOf(later)
      expect(at, `${later} is gone`).toBeGreaterThan(-1)
      expect(guard, `the guard must come before ${later}`).toBeLessThan(at)
    }
  })

  it('reads the override only from the body flag (the helper takes a strict true)', () => {
    expect(sendRoute()).toContain('sendPayload?.allowUnpaidPrepayment,')
  })
})

// M-1: Mark reviewed on a never-email client stamps the invoice SENT with no email, so it
// asks the same question as Send - before anything is written, and again before the stamp.
describe('Mark reviewed on a never-email client', () => {
  const patchRoute = () => {
    const start = source.indexOf('const invoicePatchMatch = normalizedPath.match(')
    expect(start, 'the invoice PATCH route is gone').toBeGreaterThan(-1)
    return source.slice(start, start + 14000)
  }

  it('asks before the review is written', () => {
    const route = patchRoute()
    const check = route.indexOf('await neverEmailReviewRefusal(invoiceId, payload)')
    expect(check).toBeGreaterThan(-1)
    expect(route.indexOf('sendJson(response, 409, reviewRefusal)')).toBeGreaterThan(check)
    expect(route.indexOf('await appDataStore.updateInvoice(')).toBeGreaterThan(check)
  })

  it('answers only a status move to reviewed, and reads the owner\'s yes from the body (the helper wants a strict true)', () => {
    const start = source.indexOf('async function neverEmailReviewRefusal(invoiceId, payload)')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 800)
    expect(body).toContain("payload?.status !== 'reviewed'")
    expect(body).toContain('payload.allowUnpaidPrepayment')
    expect(body).toContain('appDataStore.unpaidPrepaymentFor(stored)')
  })

  it('asks again on the row as written, right before the sent stamp', () => {
    const route = patchRoute()
    const again = route.indexOf('await appDataStore.unpaidPrepaymentFor(updated)')
    expect(again).toBeGreaterThan(-1)
    expect(route.indexOf('sendJson(response, 409, stampRefusal)')).toBeGreaterThan(again)
    expect(route.indexOf('await appDataStore.recordInvoiceSent(')).toBeGreaterThan(again)
  })

  it('checks only a never-email client that is not billed outside the app', () => {
    const start = source.indexOf('async function neverEmailReviewRefusal(invoiceId, payload)')
    const body = source.slice(start, start + 800)
    expect(body).toContain('holdClient?.invoiceNoEmail !== true || holdClient.platformInvoicingOptOut === true')
  })
})

describe('the month list', () => {
  it('marks the rows the guard would stop, as its own best-effort step after the changed-since-sent mark', () => {
    const changed = source.indexOf('appDataStore.withChangedSinceSent(marked)')
    const prepayment = source.indexOf('appDataStore.withUnpaidPrepayment(marked)')
    expect(changed).toBeGreaterThan(-1)
    expect(prepayment).toBeGreaterThan(changed)
    const step = source.slice(prepayment - 60, prepayment + 360)
    expect(step).toContain('try {')
    expect(step).toContain('unpaid-prepayment mark failed on the list, answering unmarked')
    expect(source.indexOf('sendJson(response, 200, { invoices: marked })', prepayment)).toBeGreaterThan(prepayment)
  })
})
