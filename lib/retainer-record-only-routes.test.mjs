import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * "Record a retainer that was already invoiced and paid outside the app"
 * (featreq-9d3721d4) - the server's wiring.
 *
 * `server.js` listens at module scope and exports nothing, so there is no HTTP
 * harness: these pin the wiring (the same convention as
 * lib/invoice-no-email-routes.test.mjs). The behavior - paid, creditable,
 * audited - is exercised for real in db/store-staleness.test.mjs.
 */

const source = readFileSync('server.js', 'utf8')
const storeSource = readFileSync('db/store.js', 'utf8')

/** The text between two anchors, each of which must exist. */
function between(text, startAnchor, endAnchor) {
  const start = text.indexOf(startAnchor)
  expect(start, `${startAnchor} is gone`).toBeGreaterThan(-1)
  const end = text.indexOf(endAnchor, start + startAnchor.length)
  expect(end, `${endAnchor} is gone`).toBeGreaterThan(start)
  return text.slice(start, end)
}

const retainerRoute = () =>
  between(
    source,
    "normalizedPath === '/api/invoices/retainer' && request.method === 'POST'",
    '// PATCH /api/invoices/:id',
  )

describe('POST /api/invoices/retainer with recordOnly', () => {
  it('reads recordOnly strictly from the payload and hands it, and the actor, to the store', () => {
    const body = retainerRoute()
    expect(body).toContain('payload?.recordOnly === true')
    expect(body).toContain('recordOnly: retainerRecordOnly')
    expect(body).toContain('actorUserId: session.user.id')
  })

  it('records a different activity than an issued retainer', () => {
    const body = retainerRoute()
    expect(body).toContain("'retainer_recorded_paid'")
    expect(body).toContain("'retainer_invoice_issued'")
    expect(body).toMatch(
      /retainerRecordOnly\s*\?\s*'retainer_recorded_paid'\s*:\s*'retainer_invoice_issued'/,
    )
  })

  it('sends nothing and mints nothing: no email, no Stripe, no pay link is reachable', () => {
    const body = retainerRoute()
    for (const forbidden of [
      'sendInvoiceEmail',
      'recordInvoiceSent',
      'createInvoiceCheckoutSession',
      'createInvoiceCardCheckoutSession',
      'getOrCreateInvoicePayToken',
      'ensureStripeCustomer',
      'stripe',
      'Stripe',
    ]) {
      expect(body, `${forbidden} must not be reachable from the retainer route`).not.toContain(
        forbidden,
      )
    }
  })

  it('keeps every existing refusal', () => {
    const body = retainerRoute()
    expect(body).toContain("session.user.role !== 'owner'")
    expect(body).toContain('isCrossSiteOrigin(request)')
    expect(body).toContain('application/json required')
    expect(body).toContain('amount must be more than zero')
    expect(body).toContain('platformInvoicingOptOut')
    expect(body).toContain('client_opted_out')
  })
})

describe('the invoice insert persists what a recorded retainer carries', () => {
  it('writes sent_at, paid_at and payment_method on Postgres, not only on the file backend', () => {
    const insert = between(storeSource, 'async _insertInvoice(record', 'async createClient(')
    expect(insert).toMatch(
      /due_date, blurb, scope_flags, original_line_items,\s*sent_at, paid_at, payment_method/,
    )
    expect(insert).toContain('record.sentAt ?? null')
    expect(insert).toContain('record.paidAt ?? null')
    expect(insert).toContain('record.paymentMethod ?? null')
  })
})
