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

describe('the send route', () => {
  it('refuses with 409 prepayment_unpaid, the reason and the sentence, unless the owner said Send anyway to an unpaid anchor', () => {
    const route = sendRoute()
    const guard = route.indexOf('await appDataStore.unpaidPrepaymentFor(invoice)')
    expect(guard).toBeGreaterThan(-1)
    const block = route.slice(guard, guard + 900)
    expect(block).toContain("sendJson(response, 409, {")
    expect(block).toContain("error: 'prepayment_unpaid'")
    expect(block).toContain('reason: prepaymentHold.reason')
    expect(block).toContain('message: prepaymentHold.message')
  })

  // M-8: the server decides on the rows as they are at send time. The check runs on
  // EVERY send (the override only lifts the 'unpaid' hold), and the 'not_applied'
  // hold (anchor paid, this invoice never drew it) cannot be overridden.
  it('re-derives the hold at send time and lets Send anyway lift only the unpaid reason', () => {
    const route = sendRoute()
    const guard = route.indexOf('const prepaymentHold = await appDataStore.unpaidPrepaymentFor(invoice)')
    expect(guard).toBeGreaterThan(-1)
    const line = route.slice(guard, guard + 400)
    expect(line).toContain("prepaymentHold.reason === 'unpaid' && sendPayload?.allowUnpaidPrepayment === true")
    expect(route.slice(Math.max(0, guard - 1200), guard)).not.toContain('allowUnpaidPrepayment !== true')
    // 'processing' (anchor payment still clearing) and 'not_applied' are never lifted.
    expect(line).not.toContain("'processing'")
    expect(line).not.toContain("'not_applied'")
  })

  it('asks before anything is resolved, minted or emailed, and after the never-email refusal', () => {
    const route = sendRoute()
    const guard = route.indexOf("error: 'prepayment_unpaid'")
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

  it('reads the override only from the body flag, as a strict true', () => {
    expect(sendRoute()).toContain('sendPayload?.allowUnpaidPrepayment === true')
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
