import { describe, expect, it } from 'vitest'
import {
  INVOICE_LOCKED_MESSAGE,
  INVOICE_PROCESSING_LOCKED_MESSAGE,
  LOCKED_INVOICE_STATUSES,
  invoiceLockMessage,
  invoiceLockRefusal,
  isInvoiceLocked,
} from './invoice-lines.js'

/**
 * The paid lock — Brittany's rule off the tracker (featreq-ead3a215): "invoices
 * should not be editable once paid all invoices should lock after paid."
 *
 * She was answering a NARROWER question (should a retainer credit freeze at the
 * amount paid?) and replied with the general rule, so the general rule is what
 * shipped. That makes the retainer half of it structural rather than a second
 * calculation, which is the case the last block here pins: a retainer must be
 * paid before it can be credited, and a paid invoice's total can no longer move,
 * so the credit cannot drift from the money that arrived.
 *
 * The interesting edges are the ones that must STAY OPEN. A lock that also
 * froze the lifecycle would trap a wrong invoice with no way out.
 */

const at = (status) => ({ status })

describe('which invoices are locked', () => {
  it('locks paid and processing', () => {
    expect(isInvoiceLocked(at('paid'))).toBe(true)
    expect(isInvoiceLocked(at('processing'))).toBe(true)
    expect([...LOCKED_INVOICE_STATUSES].sort()).toEqual(['paid', 'processing'])
  })

  // The judgment call, pinned so it cannot be widened by accident. `sent` means
  // nobody has paid anything yet, and correcting an invoice before a client pays
  // it is ordinary bookkeeping she never asked to lose.
  it('leaves draft, reviewed, sent, overdue and void editable', () => {
    for (const status of ['draft', 'reviewed', 'sent', 'overdue', 'void']) {
      expect(isInvoiceLocked(at(status))).toBe(false)
    }
  })

  it('says something different while a payment is still settling', () => {
    expect(invoiceLockMessage(at('paid'))).toBe(INVOICE_LOCKED_MESSAGE)
    expect(invoiceLockMessage(at('processing'))).toBe(INVOICE_PROCESSING_LOCKED_MESSAGE)
    expect(invoiceLockMessage(at('draft'))).toBeNull()
  })

  it('survives a missing or malformed invoice', () => {
    expect(isInvoiceLocked(null)).toBe(false)
    expect(isInvoiceLocked(undefined)).toBe(false)
    expect(isInvoiceLocked({})).toBe(false)
  })
})

describe('what a locked invoice refuses', () => {
  it('refuses every content field', () => {
    expect(invoiceLockRefusal(at('paid'), { lineItems: [] })).toBe(INVOICE_LOCKED_MESSAGE)
    expect(invoiceLockRefusal(at('paid'), { blurb: 'thanks!' })).toBe(INVOICE_LOCKED_MESSAGE)
    expect(invoiceLockRefusal(at('paid'), { dueDate: '2026-09-01' })).toBe(INVOICE_LOCKED_MESSAGE)
  })

  // Keyed on the KEYS PRESENT, not on whether the value differs: "your tab is
  // out of date" and "you changed nothing" are the same request on the wire, and
  // answering the second with a silent success lets a stale tab believe it saved.
  it('refuses a content field even when the value is unchanged', () => {
    const invoice = { status: 'paid', blurb: 'Thanks for your business.' }
    expect(invoiceLockRefusal(invoice, { blurb: 'Thanks for your business.' })).toBe(
      INVOICE_LOCKED_MESSAGE,
    )
  })

  it('refuses being walked back to draft or reviewed', () => {
    expect(invoiceLockRefusal(at('paid'), { status: 'draft' })).toBe(INVOICE_LOCKED_MESSAGE)
    expect(invoiceLockRefusal(at('paid'), { status: 'reviewed' })).toBe(INVOICE_LOCKED_MESSAGE)
  })

  // THE ESCAPE HATCH, and the reason the lock is safe to have. Withdrawing an
  // invoice that turned out to be wrong is a visible act with its own record; a
  // silent edit is not. Take this away and a wrong paid invoice is permanent.
  it('always allows voiding', () => {
    expect(invoiceLockRefusal(at('paid'), { status: 'void' })).toBeNull()
    expect(invoiceLockRefusal(at('processing'), { status: 'void' })).toBeNull()
  })

  it('allows a patch that asks for nothing', () => {
    expect(invoiceLockRefusal(at('paid'), {})).toBeNull()
    expect(invoiceLockRefusal(at('paid'), null)).toBeNull()
    expect(invoiceLockRefusal(at('paid'), undefined)).toBeNull()
  })

  it('does not treat re-sending the current status as a rewind', () => {
    expect(invoiceLockRefusal(at('paid'), { status: 'paid' })).toBeNull()
  })

  it('refuses nothing on an invoice that is not locked', () => {
    expect(invoiceLockRefusal(at('draft'), { lineItems: [], blurb: 'x' })).toBeNull()
    expect(invoiceLockRefusal(at('sent'), { lineItems: [] })).toBeNull()
  })
})
