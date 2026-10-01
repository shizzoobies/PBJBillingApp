import { describe, expect, it } from 'vitest'
import {
  INVOICE_LOCKED_MESSAGE,
  INVOICE_PAYMENT_PROCESSING_CODE,
  INVOICE_PAYMENT_PROCESSING_MESSAGE,
  INVOICE_PROCESSING_LOCKED_MESSAGE,
  LOCKED_INVOICE_STATUSES,
  invoiceLockMessage,
  invoiceLockRefusal,
  invoiceVoidRefusal,
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
  // The CONTENT lock never refuses a void; the one void it cannot allow, a
  // clearing payment, is `invoiceVoidRefusal`'s answer (tested below).
  it('does not treat a void as a content edit', () => {
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

/**
 * The one void the escape hatch must NOT let through: an invoice whose bank
 * payment is still clearing. `applyInvoicePayment` ignores a void invoice, so a
 * void here would let the money arrive against no live invoice with nothing
 * saying so.
 */
describe('voiding while a bank payment is clearing', () => {
  it('refuses a void of a processing invoice with its own code and sentence', () => {
    expect(invoiceVoidRefusal(at('processing'), { status: 'void' })).toEqual({
      code: 'invoice_payment_processing',
      message:
        'A bank payment is still clearing on this invoice. Wait until it is paid or fails, then void it.',
    })
    expect(INVOICE_PAYMENT_PROCESSING_CODE).toBe('invoice_payment_processing')
    expect(INVOICE_PAYMENT_PROCESSING_MESSAGE).toBe(
      'A bank payment is still clearing on this invoice. Wait until it is paid or fails, then void it.',
    )
  })

  it('allows a void of a draft, reviewed, sent, overdue or paid invoice', () => {
    for (const status of ['draft', 'reviewed', 'sent', 'overdue', 'paid']) {
      expect(invoiceVoidRefusal(at(status), { status: 'void' })).toBeNull()
    }
  })

  it('has no opinion on a patch that is not a void', () => {
    expect(invoiceVoidRefusal(at('processing'), { blurb: 'x' })).toBeNull()
    expect(invoiceVoidRefusal(at('processing'), { status: 'draft' })).toBeNull()
    expect(invoiceVoidRefusal(at('processing'), {})).toBeNull()
    expect(invoiceVoidRefusal(at('processing'), null)).toBeNull()
    expect(invoiceVoidRefusal(null, { status: 'void' })).toBeNull()
  })

  // Non-void changes to a processing invoice keep today's lock answer.
  it('leaves the content lock answering a processing invoice as before', () => {
    expect(invoiceLockRefusal(at('processing'), { blurb: 'x' })).toBe(
      INVOICE_PROCESSING_LOCKED_MESSAGE,
    )
    expect(invoiceLockRefusal(at('processing'), { status: 'draft' })).toBe(
      INVOICE_PROCESSING_LOCKED_MESSAGE,
    )
    expect(invoiceLockRefusal(at('processing'), {})).toBeNull()
  })
})
