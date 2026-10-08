import { describe, expect, it } from 'vitest'
import {
  PREPAYMENT_LINE_KIND,
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

  it('reimbursed kinds are exactly the two expense kinds — fees stay accounting-side, credits are their own figure', () => {
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
    // The $5 retainer credit is Credit applied now (R1-2), not a deduction from the fees.
    expect(rows[0].creditTotal).toBe(-5)
    expect(rows[0].accountingTotal).toBe(415)
  })

  it('R1-2: a retainer credit sized against the prepayments never makes Accounting services negative', () => {
    // Fee 500 + prepayments 1,000, a $1,200 retainer given back: total 300.
    const [row] = buildInvoiceRecap({
      invoices: [
        invoice({
          total: 300,
          lineItems: [
            { kind: 'plan', label: 'Monthly service', detail: '', amount: 500 },
            { kind: 'prepayment', label: 'Prepayment for November 2026', detail: '', amount: 500, period: '2026-11' },
            { kind: 'prepayment', label: 'Prepayment for December 2026', detail: '', amount: 500, period: '2026-12' },
            { kind: 'retainer_credit', label: 'Retainer credit', detail: '', amount: -1200 },
          ],
        }),
      ],
      clients,
      visibleClientIds: allVisible,
    })
    expect(row.total).toBe(300)
    expect(row.accountingTotal).toBe(500)
    expect(row.prepaymentTotal).toBe(1000)
    expect(row.creditTotal).toBe(-1200)
    expect(row.accountingTotal + row.prepaymentTotal + row.reimbursedTotal + row.creditTotal).toBe(row.total)
  })

  it('both credit kinds together are one Credit applied figure', () => {
    const [row] = buildInvoiceRecap({
      invoices: [
        invoice({
          total: 300,
          lineItems: [
            { kind: 'plan', label: 'Fee', detail: '', amount: 500 },
            { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -150, draws: [] },
            { kind: 'retainer_credit', label: 'Retainer credit', detail: '', amount: -50 },
          ],
        }),
      ],
      clients,
      visibleClientIds: allVisible,
    })
    expect(row.creditTotal).toBe(-200)
    expect(row.accountingTotal).toBe(500)
  })

  describe('prepayments (billing period, M-9): deferred revenue, not this month\'s fees', () => {
    const anchor = invoice({
      total: 5550,
      lineItems: [
        { kind: 'plan', label: 'Monthly service', detail: '', amount: 1850 },
        { kind: 'prepayment', label: 'Prepayment for November 2026', detail: '', amount: 1850, period: '2026-11' },
        { kind: 'prepayment', label: 'Prepayment for December 2026', detail: '', amount: 1850, period: '2026-12' },
      ],
    })
    // A later month of the same period: the fee, less the credit that draws the prepayment.
    const later = invoice({
      id: 'inv-2',
      number: 'INV-2026-11-001',
      total: 0,
      lineItems: [
        { kind: 'plan', label: 'Monthly service', detail: '', amount: 1850 },
        { kind: 'account_credit', label: 'Credit on account - meant for November 2026', detail: '', amount: -1850 },
      ],
    })

    it('shows the prepayments on their own line and keeps them out of the fees total', () => {
      expect(PREPAYMENT_LINE_KIND).toBe('prepayment')
      const [row] = buildInvoiceRecap({ invoices: [anchor], clients, visibleClientIds: allVisible })
      expect(row.total).toBe(5550)
      expect(row.prepaymentTotal).toBe(3700)
      expect(row.accountingTotal).toBe(1850)
      expect(row.reimbursedTotal).toBe(0)
      expect(row.prepaymentLines).toEqual([
        { label: 'Prepayment for November 2026', detail: '', amount: 1850, period: '2026-11' },
        { label: 'Prepayment for December 2026', detail: '', amount: 1850, period: '2026-12' },
      ])
    })

    it('reconciles: accounting + prepayments + reimbursed = total', () => {
      const withExpense = invoice({
        total: 5650,
        lineItems: [...anchor.lineItems, { kind: 'reimbursement', label: 'Postage', detail: '', amount: 100 }],
      })
      const [row] = buildInvoiceRecap({ invoices: [withExpense], clients, visibleClientIds: allVisible })
      expect(row.accountingTotal + row.prepaymentTotal + row.reimbursedTotal).toBeCloseTo(row.total, 10)
      expect(row.reimbursedTotal).toBe(100)
      expect(row.accountingTotal).toBe(1850)
    })

    it('shows the credit draw on a later month as Credit applied: accounting = its fee, credit = minus the fee, total $0', () => {
      const [row] = buildInvoiceRecap({ invoices: [later], clients, visibleClientIds: allVisible })
      expect(row.total).toBe(0)
      expect(row.accountingTotal).toBe(1850)
      expect(row.creditTotal).toBe(-1850)
      expect(row.prepaymentTotal).toBe(0)
      expect(row.prepaymentLines).toEqual([])
    })

    it('N-4: a stored credit drawn against the anchor never makes Accounting services negative', () => {
      // Fee 500 + prepayments 1,000, an $800 overpayment credit drawn at generation: total 700.
      const drawn = invoice({
        total: 700,
        lineItems: [
          { kind: 'plan', label: 'Monthly service', detail: '', amount: 500 },
          { kind: 'prepayment', label: 'Prepayment for November 2026', detail: '', amount: 500, period: '2026-11' },
          { kind: 'prepayment', label: 'Prepayment for December 2026', detail: '', amount: 500, period: '2026-12' },
          { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -800, draws: [] },
        ],
      })
      const [row] = buildInvoiceRecap({ invoices: [drawn], clients, visibleClientIds: allVisible })
      expect(row.total).toBe(700)
      expect(row.accountingTotal).toBe(500)
      expect(row.prepaymentTotal).toBe(1000)
      expect(row.creditTotal).toBe(-800)
      expect(row.reimbursedTotal).toBe(0)
      expect(row.accountingTotal + row.prepaymentTotal + row.reimbursedTotal + row.creditTotal).toBe(row.total)
    })

    it('an ordinary invoice has none', () => {
      const [row] = buildInvoiceRecap({ invoices: [invoice()], clients, visibleClientIds: allVisible })
      expect(row.prepaymentTotal).toBe(0)
      expect(row.prepaymentLines).toEqual([])
      expect(row.accountingTotal).toBe(400)
    })
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
