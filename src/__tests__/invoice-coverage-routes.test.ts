import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The API's covered-date guards, pinned at the level this repo can reach.
 *
 * WHAT THIS IS AND IS NOT. `server.js` calls `server.listen()` at module scope
 * and exports nothing, so importing it in a test starts a real listener and
 * reaches for a database — there is no HTTP harness here and inventing one for
 * this feature would be a bigger change than the feature. Every other route in
 * this app is likewise covered through the store functions it calls, which is
 * where the real decisions live: `invoiceHasUnconfirmedCoverage` and
 * `confirmExpenseCoverage` are exercised properly, both backends, in
 * db/store-staleness.test.mjs.
 *
 * What is left over is the GLUE, and one specific way it can rot: someone
 * deletes the guard, or changes an error code, and every store-level test still
 * passes. These assertions read the route source and pin exactly that — the
 * call is present, and each refusal carries the status the page is written
 * against. They prove wiring, not behavior. Treat a failure here as "the route
 * changed, go look", not as a behavioral regression.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard to the next route match. */
function routeBlock(startPattern: RegExp, length = 4000): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

describe('the send route refuses an unanswered covered-date window', () => {
  // Anchored on the send route's own void message — `listInvoices()` alone also
  // matches the payment-link route a few hundred lines earlier.
  const block = () => routeBlock(/This invoice is voided, so it cannot be sent\./, 6000)

  // The UI disables Send behind review, and review is gated — but this route is
  // reachable directly, and an invoice reviewed BEFORE the question existed
  // carries no flag in its stored lines at all.
  it('asks the store, rather than trusting the invoice’s stored lines', () => {
    expect(block()).toContain('appDataStore.invoiceHasUnconfirmedCoverage(invoice)')
  })

  it('answers 409 coverage_unconfirmed', () => {
    const text = block()
    const guardAt = text.indexOf('invoiceHasUnconfirmedCoverage')
    expect(text.slice(guardAt, guardAt + 400)).toMatch(
      /sendJson\(response, 409, \{\s*error: 'coverage_unconfirmed'/,
    )
  })

  // The guard has to sit BEFORE Stripe is asked for a Checkout session —
  // refusing after a session is minted would leave a live pay link for an
  // invoice that was never sent.
  it('runs before any payment session is created', () => {
    const text = block()
    expect(text.indexOf('invoiceHasUnconfirmedCoverage')).toBeLessThan(
      text.indexOf('createInvoiceCheckoutSession'),
    )
  })
})

describe('the confirm-coverage route maps each refusal to its own status', () => {
  const block = () => routeBlock(/const coverageConfirmMatch = normalizedPath\.match\(/, 3200)

  it('is owner-only, same-origin and JSON-bodied, like every other invoice write', () => {
    const text = block()
    expect(text).toContain("sendJson(response, 403, { error: 'Only owners can confirm covered dates' })")
    expect(text).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
    expect(text).toContain("sendJson(response, 415, { error: 'application/json required' })")
  })

  it('answers 400 when the expense is not named', () => {
    expect(block()).toContain("sendJson(response, 400, { error: 'recurringId is required' })")
  })

  // A refused confirm — bad dates, an end before its start, an expense not on
  // this invoice, or a VOIDED invoice — is a fact about the data, and she needs
  // the sentence rather than "please try again".
  it('answers 400 coverage_invalid with the store’s own message', () => {
    const text = block()
    expect(text).toContain('error instanceof CoverageConfirmationError')
    expect(text).toMatch(
      /sendJson\(response, 400, \{ error: 'coverage_invalid', message: error\.message \}\)/,
    )
  })

  it('answers 404 when there is no such invoice', () => {
    expect(block()).toContain("sendJson(response, 404, { error: 'Invoice not found' })")
  })

  it('imports the error class it branches on', () => {
    expect(serverSource).toMatch(/import \{[\s\S]*?CoverageConfirmationError,[\s\S]*?\} from '\.\/db\/store\.js'/)
  })
})

describe('the recurring-reimbursement routes never accept a ledger from the wire', () => {
  // The ledger is written by generation and by the confirm control. A request
  // body that could set it would let a stale tab rewrite which windows a client
  // has already been billed for.
  it('picks coverage fields one by one, and not the history', () => {
    const at = serverSource.indexOf('function readCoverageFields')
    expect(at).toBeGreaterThan(-1)
    const fn = serverSource.slice(at, at + 900)
    expect(fn).toContain('coverageEnabled')
    expect(fn).toContain('coveragePaused')
    expect(fn).toContain('coverageTemplate')
    expect(fn).toContain('coverageStart')
    expect(fn).toContain('coverageEnd')
    expect(fn).not.toContain('coverageHistory')
    expect(fn).not.toContain('coverageAnchorDay')
    expect(fn).not.toContain('coverageResumePending')
  })
})

/**
 * The paid lock's glue — featreq-ead3a215.
 *
 * The refusal itself is exercised properly, both backends, in
 * db/store-staleness.test.mjs. What can rot HERE is the translation: the store
 * throws `InvoiceLockedError`, and if the route stops catching it the owner gets
 * a 500 and "Could not save that change — please try again" for something that
 * will never succeed no matter how many times she tries.
 *
 * Same caveat as the block at the top of this file: this proves wiring, not
 * behavior.
 */
describe('the invoice PATCH route answers a locked invoice with a sentence', () => {
  const block = routeBlock(/const invoicePatchMatch = normalizedPath\.match\(/, 3000)

  it('catches the locked error rather than letting it fall to the 500', () => {
    expect(block).toContain('error instanceof InvoiceLockedError')
  })

  it('answers 409 with the code the page branches on', () => {
    const at = block.indexOf('error instanceof InvoiceLockedError')
    expect(at).toBeGreaterThan(-1)
    const branch = block.slice(at, at + 260)
    expect(branch).toContain('409')
    expect(branch).toContain("error: 'invoice_locked'")
    // The store's sentence, not a rewrite of it here — one wording, one place.
    expect(branch).toContain('message: error.message')
  })

  /**
   * POSITION. The generic `console.error` + 500 sits at the bottom of the same
   * catch, so a locked branch added BELOW it would never run while still
   * reading correctly to someone scanning the file.
   */
  it('branches before the catch-all 500', () => {
    const locked = block.indexOf('error instanceof InvoiceLockedError')
    const fallback = block.indexOf("error: 'invoice_update_failed'")
    expect(locked).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(-1)
    expect(locked).toBeLessThan(fallback)
  })

  it('imports the error class it branches on', () => {
    expect(serverSource).toMatch(
      /import \{[\s\S]*?InvoiceLockedError,[\s\S]*?\} from '\.\/db\/store\.js'/,
    )
  })
})

/**
 * The manual mark-paid glue — featreq-602d2c6e. Behavior is exercised on the
 * store (db/store-staleness.test.mjs); what can rot here is the wiring: owner
 * gate, the 409 sentence, and above all the SESSION EXPIRY — the one step that
 * keeps an emailed pay button from charging a client who already paid by check.
 */
describe('the mark-paid route', () => {
  const block = routeBlock(/const markPaidMatch = normalizedPath\.match\(/, 3500)

  it('is owner-gated and origin-checked like every invoice write', () => {
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain('isCrossSiteOrigin(request)')
  })

  it('answers a refused mark with the store sentence, not a 500', () => {
    const at = block.indexOf('error instanceof ManualPaymentError')
    expect(at).toBeGreaterThan(-1)
    const branch = block.slice(at, at + 260)
    expect(branch).toContain('409')
    expect(branch).toContain("error: 'manual_payment_refused'")
    expect(branch).toContain('message: error.message')
  })

  it('expires BOTH open checkout sessions after the mark commits', () => {
    expect(block).toContain('updated.stripeCheckoutSessionId')
    expect(block).toContain('updated.stripeCardSessionId')
    expect(block).toContain('expireCheckoutSession(sessionId)')
  })

  it('has the unmark route beside it, with the same guards', () => {
    const unmark = routeBlock(/const unmarkPaidMatch = normalizedPath\.match\(/, 2500)
    expect(unmark).toContain("session.user.role !== 'owner'")
    expect(unmark).toContain('unmarkManualInvoicePayment')
  })

  it('imports the error class it branches on', () => {
    expect(serverSource).toMatch(
      /import \{[\s\S]*?ManualPaymentError,[\s\S]*?\} from '\.\/db\/store\.js'/,
    )
  })
})

/**
 * verify-payment glue: the route must ask STRIPE before it writes anything —
 * the whole point over mark-paid is that it records Stripe's answer, not a
 * human's. Behavior is on the store; this pins the order of operations.
 */
/**
 * verify-all glue: the sweep must keep the single button's contract on EVERY
 * invoice it touches — Stripe asked before the store writes, nothing recorded
 * on any answer but 'succeeded' — and one invoice's failure must not end the
 * sweep for the rest.
 */
describe('the verify-all-payments route', () => {
  const block = routeBlock(
    /normalizedPath === '\/api\/invoices\/verify-all-payments'/,
    4200,
  )

  it('is owner-gated and origin-checked like every invoice write', () => {
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain('isCrossSiteOrigin(request)')
  })

  it('sweeps only invoices that are mid-payment', () => {
    expect(block).toContain("invoice.status === 'processing'")
  })

  it('queries the intent BEFORE calling the store, per invoice', () => {
    const ask = block.indexOf('retrievePaymentIntentStatus(')
    const record = block.indexOf('reconcileProcessingInvoicePaid(')
    expect(ask).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(record)
  })

  it('records nothing unless Stripe says succeeded', () => {
    expect(block).toContain("intent.status !== 'succeeded'")
    expect(block).toContain('stillSettling.push(')
  })

  it('reports an unreachable or intent-less invoice instead of guessing', () => {
    expect(block).toContain("reason: 'no_intent'")
    expect(block).toContain("reason: 'stripe_unreachable'")
  })

  // The loop-continues shape: every non-success path `continue`s or falls
  // through to the next invoice, and the store error is caught INSIDE the loop
  // so the response is a summary, never a 500 halfway through.
  it('handles each invoice independently — a store error becomes a summary line', () => {
    expect(block).toContain('error instanceof ManualPaymentError')
    expect(block).toContain("reason: 'error'")
    // The catch sits before the response is sent, inside the for-loop body.
    const catchAt = block.indexOf('error instanceof ManualPaymentError')
    const respondAt = block.indexOf('sendJson(response, 200, {')
    expect(catchAt).toBeGreaterThan(-1)
    expect(respondAt).toBeGreaterThan(-1)
    expect(catchAt).toBeLessThan(respondAt)
  })

  it('sits ABOVE the single verify-payment route', () => {
    expect(
      serverSource.indexOf("normalizedPath === '/api/invoices/verify-all-payments'"),
    ).toBeLessThan(serverSource.search(/const verifyPaymentMatch = normalizedPath\.match\(/))
  })
})

describe('the verify-payment route', () => {
  const block = routeBlock(/const verifyPaymentMatch = normalizedPath\.match\(/, 3500)

  it('queries the intent BEFORE calling the store', () => {
    const ask = block.indexOf('retrievePaymentIntentStatus(')
    const record = block.indexOf('reconcileProcessingInvoicePaid(')
    expect(ask).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(record)
  })

  it('records nothing unless Stripe says succeeded', () => {
    expect(block).toContain("intent.status !== 'succeeded'")
    expect(block).toContain("error: 'verify_still_settling'")
  })

  it('says so when Stripe is unreachable rather than guessing', () => {
    expect(block).toContain("error: 'stripe_unreachable'")
  })

  it('is owner-gated and origin-checked like every invoice write', () => {
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain('isCrossSiteOrigin(request)')
  })
})
