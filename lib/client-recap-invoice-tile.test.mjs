/**
 * featreq-50a059cd: the Billing tile's Invoice is the real invoice once it has
 * been sent. "If monthly plan, rate of monthly plan; if hourly plan should be
 * same as service value until invoices are sent, then it should pull actual
 * invoice amounts."
 */
import { describe, expect, it } from 'vitest'
import { buildClientRecap } from './client-recap.js'

const base = {
  plans: [],
  employees: [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 120 }],
  reimbursements: [],
  recurringReimbursements: [],
}

// 12h at Lisa's $120 = $1,440 service value in August.
const hourlyData = {
  ...base,
  clients: [{ id: 'c1', name: 'Clover', billingMode: 'hourly', hourlyRate: 100, planIds: [], assignedBookkeeperIds: ['lisa'] }],
  timeEntries: [
    { id: 't1', employeeId: 'lisa', clientId: 'c1', date: '2026-08-10', minutes: 720, billable: true },
  ],
}
const planData = {
  ...base,
  clients: [{ id: 'c1', name: 'Clover', billingMode: 'subscription', monthlyRate: 900, planIds: [], assignedBookkeeperIds: ['lisa'] }],
  timeEntries: [],
}

const opts = {
  clientId: 'c1',
  periodType: 'month',
  period: '2026-08',
  today: '2026-09-04',
  includeFinancials: true,
}

const invoice = (over = {}) => ({
  id: 'inv-1',
  clientId: 'c1',
  period: '2026-08',
  kind: 'monthly',
  status: 'sent',
  number: 12,
  sentAt: '2026-09-02T14:00:00.000Z',
  total: 1300,
  lineItems: [{ kind: 'hourly', amount: 1300 }],
  ...over,
})

describe('Billing tile: Invoice', () => {
  it('stays the live figure, "Not invoiced yet", with no invoices', () => {
    const r = buildClientRecap(hourlyData, opts)
    expect(r.billing.invoice).toMatchObject({ amount: 1440, caption: 'Not invoiced yet', sentMonths: 0 })
    expect(r.billing.revenue).toBe(1440)
    expect(r.estimates.profit.serviceValueDelta).toBe(0)
  })

  it('shows a monthly plan client at its plan rate until the invoice goes out', () => {
    const r = buildClientRecap(planData, opts)
    expect(r.billing.invoice.amount).toBe(900)
    expect(r.billing.invoice.caption).toBe('Not invoiced yet')
  })

  it('pulls the actual amount for a plan client once sent', () => {
    const r = buildClientRecap(planData, { ...opts, invoices: [invoice({ total: 1000, lineItems: [{ kind: 'plan', amount: 1000 }] })] })
    expect(r.billing.invoice.amount).toBe(1000)
    expect(r.billing.invoice.caption).toBe('From invoice #12, sent September 2, 2026')
    expect(r.billing.revenue).toBe(900) // Profitability still measures the live figure
  })

  it('pulls the actual amount for an hourly client once sent, and Over/Under follows it', () => {
    const r = buildClientRecap(hourlyData, { ...opts, invoices: [invoice()] })
    expect(r.billing.invoice.amount).toBe(1300)
    expect(r.estimates.profit.serviceValue).toBe(1440)
    expect(r.estimates.profit.serviceValueDelta).toBe(140) // service value 1,440 - invoice 1,300
    expect(r.estimates.profit.serviceValueDirection).toBe('over')
  })

  it('leaves reimbursements, prepayments and credit applied out of the invoice figure', () => {
    const r = buildClientRecap(hourlyData, {
      ...opts,
      invoices: [
        invoice({
          total: 1380,
          lineItems: [
            { kind: 'hourly', amount: 1300 },
            { kind: 'reimbursement', amount: 80 },
            { kind: 'prepayment', amount: 500 },
            { kind: 'account_credit', amount: -500 },
          ],
        }),
      ],
    })
    // 1,380 total - 80 reimbursed - 500 prepayment - (-500) credit = 1,300
    expect(r.billing.invoice.amount).toBe(1300)
  })

  it('counts sent, processing and paid invoices, and states the sent date on the firm calendar', () => {
    for (const status of ['sent', 'processing', 'paid']) {
      const r = buildClientRecap(hourlyData, { ...opts, invoices: [invoice({ status })] })
      expect(r.billing.invoice.amount).toBe(1300)
    }
    // 01:30 UTC on the 3rd is the evening of the 2nd in New York.
    const late = buildClientRecap(hourlyData, { ...opts, invoices: [invoice({ sentAt: '2026-09-03T01:30:00.000Z' })] })
    expect(late.billing.invoice.caption).toBe('From invoice #12, sent September 2, 2026')
  })

  it('ignores drafts, reviewed invoices, voids, retainers and other clients', () => {
    for (const odd of [
      { status: 'draft' },
      { status: 'reviewed' },
      { status: 'void' },
      { kind: 'retainer' },
      { clientId: 'someone-else' },
      { period: '2026-07' },
    ]) {
      const r = buildClientRecap(hourlyData, { ...opts, invoices: [invoice(odd)] })
      expect(r.billing.invoice.amount).toBe(1440)
      expect(r.billing.invoice.caption).toBe('Not invoiced yet')
    }
  })

  it('says how many months came from sent invoices over a quarter', () => {
    const q = { ...opts, periodType: 'quarter', period: '2026-Q3', today: '2026-10-04' }
    const none = buildClientRecap(planData, q)
    expect(none.billing.invoice).toMatchObject({ amount: 2700, caption: 'Not invoiced yet' })

    const one = buildClientRecap(planData, {
      ...q,
      invoices: [invoice({ total: 1000, lineItems: [{ kind: 'plan', amount: 1000 }] })],
    })
    // July and September live (900 + 900), August from the invoice.
    expect(one.billing.invoice.amount).toBe(2800)
    expect(one.billing.invoice.caption).toBe('1 of 3 months from sent invoices')

    const all = buildClientRecap(planData, {
      ...q,
      invoices: ['2026-07', '2026-08', '2026-09'].map((period, index) =>
        invoice({ id: `inv-${index}`, period, number: 10 + index, total: 1000, lineItems: [{ kind: 'plan', amount: 1000 }] }),
      ),
    })
    expect(all.billing.invoice.amount).toBe(3000)
    expect(all.billing.invoice.caption).toBe('From 3 sent invoices')
  })

  it('leaves a card fee out, so the tile does not change between Sent and Paid', () => {
    const fee = { kind: 'card-fee', amount: 39 }
    const sent = buildClientRecap(hourlyData, { ...opts, invoices: [invoice()] })
    const paid = buildClientRecap(hourlyData, {
      ...opts,
      invoices: [invoice({ status: 'paid', total: 1339, lineItems: [{ kind: 'hourly', amount: 1300 }, fee] })],
    })
    expect(sent.billing.invoice.amount).toBe(1300)
    expect(paid.billing.invoice.amount).toBe(1300)
  })

  it('omits the # when an invoice has no number, and names the latest send when there are several', () => {
    const noNumber = buildClientRecap(hourlyData, { ...opts, invoices: [invoice({ number: null })] })
    expect(noNumber.billing.invoice.caption).toBe('From invoice, sent September 2, 2026')
    const two = buildClientRecap(hourlyData, {
      ...opts,
      invoices: [
        invoice({ id: 'a', number: 12, sentAt: '2026-09-02T14:00:00.000Z', total: 700, lineItems: [{ kind: 'hourly', amount: 700 }] }),
        invoice({ id: 'b', number: 13, sentAt: '2026-09-03T14:00:00.000Z', total: 600, lineItems: [{ kind: 'hourly', amount: 600 }] }),
      ],
    })
    expect(two.billing.invoice.amount).toBe(1300)
    expect(two.billing.invoice.caption).toBe('From invoices #12, #13, sent September 3, 2026')
  })

  it("names the master's invoice for a sub billed on it, and keeps the live figure", () => {
    const sub = {
      ...hourlyData,
      clients: [
        { ...hourlyData.clients[0], billToClientId: 'm1' },
        { id: 'm1', name: 'KLC', isBillingMaster: true },
      ],
    }
    const masterInvoice = invoice({
      id: 'm-inv',
      clientId: 'm1',
      number: 40,
      total: 9000,
      lineItems: [{ kind: 'hourly', amount: 9000, sourceClientId: 'c1' }],
    })
    const r = buildClientRecap(sub, { ...opts, invoices: [masterInvoice] })
    expect(r.billing.invoice.amount).toBe(1440)
    expect(r.billing.invoice.caption).toBe("Billed on KLC's invoice #40 (live figure)")
  })

  it('is absent for staff, who get no billing at all', () => {
    const r = buildClientRecap(hourlyData, { ...opts, includeFinancials: false, invoices: [invoice()] })
    expect(r.billing).toBeNull()
  })
})
