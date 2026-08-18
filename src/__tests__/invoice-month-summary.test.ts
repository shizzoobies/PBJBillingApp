import { describe, expect, it } from 'vitest'
import { summarizeInvoiceMonth } from '../lib/utils'
import type { PersistedInvoice } from '../lib/types'

/**
 * The figures on the History view's month header. These are read as fact by
 * someone deciding who to chase, so the two judgement calls in them are pinned
 * here rather than left to be rediscovered: a VOID is not billed revenue, and
 * PROCESSING is not money that has arrived.
 */

function makeInvoice(overrides: Partial<PersistedInvoice>): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-1',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'sent',
    lineItems: [],
    subtotal: 0,
    total: 0,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

describe('summarizeInvoiceMonth', () => {
  it('adds up a month and splits paid from outstanding', () => {
    const summary = summarizeInvoiceMonth([
      makeInvoice({ id: 'a', status: 'paid', total: 400 }),
      makeInvoice({ id: 'b', status: 'sent', total: 250 }),
      makeInvoice({ id: 'c', status: 'draft', total: 100 }),
    ])

    expect(summary).toEqual({
      liveCount: 3,
      voidCount: 0,
      billed: 750,
      paid: 400,
      outstanding: 350,
    })
  })

  it('leaves voided invoices out of every total, but still counts them', () => {
    const summary = summarizeInvoiceMonth([
      makeInvoice({ id: 'a', status: 'paid', total: 400 }),
      makeInvoice({ id: 'b', status: 'void', total: 9000 }),
      makeInvoice({ id: 'c', status: 'void', total: 50 }),
    ])

    expect(summary.billed).toBe(400)
    expect(summary.paid).toBe(400)
    expect(summary.outstanding).toBe(0)
    expect(summary.liveCount).toBe(1)
    expect(summary.voidCount).toBe(2)
  })

  it('counts a processing invoice as outstanding — ACH has not cleared yet', () => {
    const summary = summarizeInvoiceMonth([
      makeInvoice({ id: 'a', status: 'processing', total: 600 }),
    ])

    expect(summary.paid).toBe(0)
    expect(summary.outstanding).toBe(600)
  })

  it('counts an overdue invoice as outstanding', () => {
    const summary = summarizeInvoiceMonth([
      makeInvoice({ id: 'a', status: 'overdue', total: 175 }),
    ])

    expect(summary.paid).toBe(0)
    expect(summary.outstanding).toBe(175)
  })

  /**
   * Float sums leave residue — $0.80 arrives as 0.7999999999999999 and a
   * squared-off month can land on a hair below zero, which formats as the
   * indefensible "-$0.00". Rounding to cents at the boundary keeps that off
   * the screen no matter what the invoice amounts are.
   */
  it('rounds to cents so float residue never reaches the screen', () => {
    const summary = summarizeInvoiceMonth([
      makeInvoice({ id: 'a', status: 'paid', total: 0.7 }),
      makeInvoice({ id: 'b', status: 'paid', total: 0.1 }),
      makeInvoice({ id: 'c', status: 'sent', total: 0.2 }),
    ])

    expect(summary.billed).toBe(1)
    expect(summary.paid).toBe(0.8)
    expect(summary.outstanding).toBe(0.2)
  })

  it('reports a squared-off month as exactly zero outstanding', () => {
    const summary = summarizeInvoiceMonth([
      makeInvoice({ id: 'a', status: 'paid', total: 0.7 }),
      makeInvoice({ id: 'b', status: 'paid', total: 0.1 }),
    ])

    expect(Object.is(summary.outstanding, -0)).toBe(false)
    expect(summary.outstanding).toBe(0)
  })

  it('reports zeros rather than NaN for a month with nothing in it', () => {
    expect(summarizeInvoiceMonth([])).toEqual({
      liveCount: 0,
      voidCount: 0,
      billed: 0,
      paid: 0,
      outstanding: 0,
    })
  })
})
