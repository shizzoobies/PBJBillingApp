import { describe, expect, it } from 'vitest'
import { generatedCreditNote } from '../lib/accountCreditText'
import type { PersistedInvoice } from '../lib/types'

/**
 * What the build note says about credit on account (stage 1c): the month run now
 * draws it onto each new monthly draft by itself, so the note that follows
 * Generate, a one-client generate and Void & regenerate has to say it happened.
 * Read off the invoices the server returned (their credit lines), never computed
 * from a balance: the figure she is told is the figure stored.
 */

const base = {
  clientId: 'client-acme',
  period: '2026-10',
  kind: 'monthly',
  status: 'draft',
  subtotal: 600,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: 'u1',
} as const

const hours = { kind: 'hourly', label: 'Billable hours', detail: '', amount: 600 } as const
const credit = (amount: number) => ({
  kind: 'account_credit' as const,
  label: 'Credit on account',
  detail: '',
  amount: -amount,
  draws: [] as { creditId: string; amount: number }[],
})

const invoice = (id: string, lineItems: PersistedInvoice['lineItems'], total: number) =>
  ({ ...base, id, number: id.toUpperCase(), lineItems, total }) as unknown as PersistedInvoice

describe('generatedCreditNote', () => {
  it('is nothing when no new invoice drew any credit', () => {
    expect(generatedCreditNote([])).toBe('')
    expect(generatedCreditNote([invoice('a', [hours], 600)])).toBe('')
  })

  it('says how much was applied, on one invoice', () => {
    expect(generatedCreditNote([invoice('a', [hours, credit(250)], 350)])).toBe(
      ' Credit on account applied: $250.00 on 1 invoice.',
    )
  })

  it('adds up across invoices and counts only those that drew', () => {
    const created = [
      invoice('a', [hours, credit(600)], 0),
      invoice('b', [hours], 600),
      invoice('c', [hours, credit(100.5)], 499.5),
    ]
    expect(generatedCreditNote(created)).toBe(' Credit on account applied: $700.50 across 2 invoices.')
  })

  it('adds cents without floating-point drift', () => {
    const created = [invoice('a', [hours, credit(0.1)], 599.9), invoice('b', [hours, credit(0.2)], 599.8)]
    expect(generatedCreditNote(created)).toBe(' Credit on account applied: $0.30 across 2 invoices.')
  })
})
