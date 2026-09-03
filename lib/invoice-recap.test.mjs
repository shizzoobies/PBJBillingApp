import { describe, expect, it } from 'vitest'
import {
  RECAP_INVOICE_STATUSES,
  REIMBURSED_LINE_KINDS,
  buildInvoiceRecap,
} from './invoice-recap.js'

/**
 * The staff invoice recap (featreq-0c2d4ce5): the total for the company, then
 * every reimbursed expense as its own line — and each team member sees only
 * their own clients' invoices. The scoping assertions here are the feature's
 * security boundary, so treat a failure as a leak, not a style break.
 */

const clients = [
  { id: 'client-a', name: 'Acme' },
  { id: 'client-b', name: 'Bravo' },
  { id: 'client-m', name: 'KLC Floors & More', isBillingMaster: true },
  { id: 'client-s', name: 'Bright Tower' },
]

function invoice(over = {}) {
  return {
    id: 'inv-1',
    clientId: 'client-a',
    kind: 'monthly',
    status: 'sent',
    number: 'INV-2026-08-001',
    total: 500,
    sentAt: '2026-08-05T00:00:00.000Z',
    paidAt: null,
    lineItems: [
      { kind: 'plan', label: 'Bookkeeping', detail: '', amount: 400 },
      { kind: 'reimbursement', label: 'Reimbursement: QBO subscription', detail: 'Aug 2, 2026', amount: 60 },
      { kind: 'recurring', label: 'Software pass-through', detail: 'Aug 1 – Aug 31', amount: 40 },
    ],
    ...over,
  }
}

const allVisible = new Set(['client-a', 'client-b', 'client-m', 'client-s'])

describe('buildInvoiceRecap', () => {
  it('shows the total, the accounting remainder, and each reimbursed line separately', () => {
    const rows = buildInvoiceRecap({ invoices: [invoice()], clients, visibleClientIds: allVisible })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.clientName).toBe('Acme')
    expect(row.total).toBe(500)
    expect(row.reimbursedTotal).toBe(100)
    expect(row.accountingTotal).toBe(400)
    // Each reimbursed expense stays its own labeled entry — never combined.
    expect(row.reimbursedLines).toHaveLength(2)
    expect(row.reimbursedLines[0].label).toBe('Reimbursement: QBO subscription')
    expect(row.reimbursedLines[0].detail).toBe('Aug 2, 2026')
    expect(row.reimbursedLines[1].amount).toBe(40)
  })

  it('the three numbers on a row always reconcile', () => {
    // Floating-point money: 3 × $0.10 reimbursed against a $0.50 bill.
    const rows = buildInvoiceRecap({
      invoices: [
        invoice({
          total: 0.5,
          lineItems: [
            { kind: 'plan', label: 'Fee', detail: '', amount: 0.2 },
            { kind: 'reimbursement', label: 'A', detail: '', amount: 0.1 },
            { kind: 'reimbursement', label: 'B', detail: '', amount: 0.1 },
            { kind: 'reimbursement', label: 'C', detail: '', amount: 0.1 },
          ],
        }),
      ],
      clients,
      visibleClientIds: allVisible,
    })
    const row = rows[0]
    expect(row.accountingTotal + row.reimbursedTotal).toBeCloseTo(row.total, 10)
    expect(row.reimbursedTotal).toBe(0.3)
  })

  it('each team member sees ONLY invoices for their assigned clients', () => {
    const rows = buildInvoiceRecap({
      invoices: [
        invoice(),
        invoice({ id: 'inv-2', clientId: 'client-b', number: 'INV-2026-08-002' }),
      ],
      clients,
      visibleClientIds: new Set(['client-b']),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].clientId).toBe('client-b')
  })

  it('recaps only bills that went out — never drafts, reviewed, or voids', () => {
    const rows = buildInvoiceRecap({
      invoices: [
        invoice({ id: 'i1', status: 'draft' }),
        invoice({ id: 'i2', status: 'reviewed' }),
        invoice({ id: 'i3', status: 'void' }),
        invoice({ id: 'i4', status: 'processing' }),
        invoice({ id: 'i5', status: 'paid' }),
        invoice({ id: 'i6', status: 'overdue' }),
      ],
      clients,
      visibleClientIds: allVisible,
    })
    expect(rows.map((row) => row.invoiceId).sort()).toEqual(['i4', 'i5', 'i6'])
    expect(RECAP_INVOICE_STATUSES).toEqual(['sent', 'processing', 'paid', 'overdue'])
  })

  it('skips retainer invoices — a retainer is not a monthly bill', () => {
    const rows = buildInvoiceRecap({
      invoices: [invoice({ kind: 'retainer' })],
      clients,
      visibleClientIds: allVisible,
    })
    expect(rows).toHaveLength(0)
  })

  it("names the company on a billing master's merged reimbursed lines", () => {
    const rows = buildInvoiceRecap({
      invoices: [
        invoice({
          clientId: 'client-m',
          lineItems: [
            { kind: 'plan', label: 'Bookkeeping services', detail: '', amount: 400 },
            {
              kind: 'reimbursement',
              label: 'Reimbursement: permits',
              detail: '',
              amount: 100,
              sourceClientId: 'client-s',
            },
          ],
        }),
      ],
      clients,
      visibleClientIds: allVisible,
    })
    expect(rows[0].reimbursedLines[0].company).toBe('Bright Tower')
  })

  it("a master's invoice is all-or-nothing: not visible unless the MASTER is assigned", () => {
    // Same stance as the Client Recap: being on a sub is not access to the
    // group's combined bill. Assign the master to the staffer instead.
    const rows = buildInvoiceRecap({
      invoices: [invoice({ clientId: 'client-m' })],
      clients,
      visibleClientIds: new Set(['client-s']),
    })
    expect(rows).toHaveLength(0)
  })

  it('reimbursed kinds are exactly the two expense kinds — fees and credits stay accounting-side', () => {
    expect(REIMBURSED_LINE_KINDS).toEqual(['reimbursement', 'recurring'])
    const rows = buildInvoiceRecap({
      invoices: [
        invoice({
          total: 510,
          lineItems: [
            { kind: 'plan', label: 'Fee', detail: '', amount: 400 },
            { kind: 'card-fee', label: 'Card processing fee', detail: '', amount: 15 },
            { kind: 'retainer_credit', label: 'Retainer credit', detail: '', amount: -5 },
            { kind: 'reimbursement', label: 'Postage', detail: '', amount: 100 },
          ],
        }),
      ],
      clients,
      visibleClientIds: allVisible,
    })
    expect(rows[0].reimbursedLines).toHaveLength(1)
    expect(rows[0].reimbursedTotal).toBe(100)
    expect(rows[0].accountingTotal).toBe(410)
  })

  it('sorts alphabetically by client, grouped for a month view', () => {
    const rows = buildInvoiceRecap({
      invoices: [
        invoice({ id: 'i-b', clientId: 'client-b', number: 'INV-2026-08-002' }),
        invoice({ id: 'i-a', clientId: 'client-a', number: 'INV-2026-08-001' }),
      ],
      clients,
      visibleClientIds: allVisible,
    })
    expect(rows.map((row) => row.clientName)).toEqual(['Acme', 'Bravo'])
  })
})
