import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Stripe webhook's `payment_intent.payment_failed` branch, pinned the way
 * the Resend webhook's glue is: server.js listens at module scope and exports
 * nothing, so this reads the source. The store write is tested properly in
 * db/store-staleness.test.mjs; what is pinned here is the ORDER and the
 * arguments — the two ways this can rot into an invoice that reads "Sent" with
 * no memory that anyone tried to pay it.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const branch = () => {
  const at = serverSource.indexOf("event.type === 'payment_intent.payment_failed'")
  expect(at, 'payment_failed branch not found').toBeGreaterThan(-1)
  // Up to the next `else`/catch — the branch is short.
  const end = serverSource.indexOf('} catch (error) {', at)
  return serverSource.slice(at, end)
}

describe('the Stripe webhook remembers a failed payment', () => {
  it('moves the status back to sent FIRST, then records the failure on the log', () => {
    const text = branch()
    const statusAt = text.indexOf("status: 'sent'")
    const recordAt = text.indexOf('.recordInvoicePaymentFailure(')
    expect(statusAt).toBeGreaterThan(-1)
    expect(recordAt).toBeGreaterThan(-1)
    expect(statusAt).toBeLessThan(recordAt)
  })

  // The intent id is the idempotency key and the reason is what she reads on
  // the row. Losing either makes the tab either double up or say nothing.
  it('passes the PaymentIntent id and Stripe’s own reason', () => {
    const text = branch()
    const recordAt = text.indexOf('.recordInvoicePaymentFailure(')
    const call = text.slice(recordAt, recordAt + 400)
    expect(call).toContain('paymentIntentId: object.id')
    expect(call).toContain('detail: failureMessage')
    expect(call).toContain('at:')
  })

  // The event id is ledgered BEFORE the handler runs, so a 500 here is not a
  // second chance — Stripe's retry answers `duplicate`. A failed log write must
  // therefore never take the owners' notification down with it.
  it('never lets the log write cost the owners their notification', () => {
    const text = branch()
    const recordAt = text.indexOf('.recordInvoicePaymentFailure(')
    const notifyAt = text.indexOf("'invoice_payment_failed'")
    expect(recordAt).toBeLessThan(notifyAt)
    expect(text.slice(recordAt, notifyAt)).toContain('.catch(')
  })

  it('names the client in the owners’ notification', () => {
    const text = branch()
    expect(text).toContain("'invoice_payment_failed'")
    expect(text).toContain('getClientNameById(invoice.clientId)')
    expect(text).toContain('clientId: invoice.clientId')
  })
})
