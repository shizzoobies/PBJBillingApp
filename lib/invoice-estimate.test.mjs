/**
 * The owner's estimate of the month's invoices (featreq-a5e14899).
 *
 * Pinned here: sent clients are their invoice as stored; everyone else is the
 * Client Recap projection; an unusable estimate is never a $0.00 service figure;
 * a billing master is its subs added up; and "left to invoice" ignores clients
 * with nothing to bill.
 */
import { describe, expect, it } from 'vitest'
import { buildInvoiceEstimate, clientsLeftToInvoice, isInvoiceRunClient } from './invoice-estimate.js'

const PERIOD = '2026-10'
const TODAY = '2026-10-15'

const client = (id, name, over = {}) => ({
  id,
  name,
  billingMode: 'hourly',
  hourlyRate: 100,
  planIds: [],
  lifecycleStage: 'active',
  ...over,
})

const lisa = { id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 120 }

const baseData = (clients, extra = {}) => ({
  clients,
  plans: [],
  employees: [lisa],
  timeEntries: [],
  reimbursements: [],
  recurringReimbursements: [],
  ...extra,
})

const rateVersions = [{ userId: 'lisa', effectiveDate: '1970-01-01', rate: 120 }]

const sentInvoice = (id, clientId, over = {}) => ({
  id,
  clientId,
  period: PERIOD,
  kind: 'monthly',
  status: 'sent',
  number: `INV-${id}`,
  total: 700,
  lineItems: [
    { kind: 'plan', label: 'Monthly', detail: '', amount: 600 },
    { kind: 'reimbursement', label: 'Filing fee', detail: '', amount: 100 },
  ],
  ...over,
})

const estimate = (data, invoices = []) =>
  buildInvoiceEstimate({ period: PERIOD, data, invoices, billRateVersions: rateVersions, today: TODAY })

const row = (result, id) => result.clients.find((entry) => entry.clientId === id)

describe('buildInvoiceEstimate', () => {
  it('uses the stored invoice for a client that has been sent, with its service and reimbursed split', () => {
    const result = estimate(baseData([client('c1', 'Acme')]), [sentInvoice('a', 'c1')])
    expect(row(result, 'c1')).toMatchObject({
      basis: 'sent',
      service: 600,
      reimburse: 100,
      total: 700,
      invoiceNumber: 'INV-a',
    })
    expect(result).toMatchObject({ monthTotal: 700, serviceTotal: 600, reimburseTotal: 100 })
  })

  it('does not count a draft, a reviewed invoice or a void as sent', () => {
    for (const status of ['draft', 'reviewed', 'void']) {
      const result = estimate(baseData([client('c1', 'Acme')]), [sentInvoice('a', 'c1', { status })])
      expect(row(result, 'c1').basis).not.toBe('sent')
    }
  })

  it('projects an hourly client at estimated hours x rate, with the word "estimate"', () => {
    const data = baseData([
      client('c1', 'Acme', { assignedBookkeeperIds: ['lisa'], estimatedBookkeeperHours: 10 }),
    ])
    expect(row(estimate(data), 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'estimate',
      service: 1200,
      reimburse: 0,
      total: 1200,
    })
  })

  it('projects a plan client at its fixed amount plus the reimbursements recorded', () => {
    const data = baseData(
      [client('c1', 'Acme', { billingMode: 'subscription', monthlyRate: 500 })],
      { reimbursements: [{ id: 'r1', clientId: 'c1', date: '2026-10-03', amount: 50, description: 'Fee' }] },
    )
    expect(row(estimate(data), 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'plan',
      service: 500,
      reimburse: 50,
      total: 550,
    })
  })

  it('never turns an unusable estimate into a $0.00 service figure', () => {
    const noEstimate = estimate(baseData([client('c1', 'Acme')]))
    expect(row(noEstimate, 'c1')).toMatchObject({
      basis: 'too_early',
      detail: 'too early',
      service: null,
      reimburse: 0,
      total: null,
    })
    expect(noEstimate.serviceTotal).toBe(0)

    // Estimated hours but nobody has a rate: say so, still no made-up service figure.
    const noRates = buildInvoiceEstimate({
      period: PERIOD,
      data: baseData([client('c1', 'Acme', { hourlyRate: 0, estimatedBookkeeperHours: 10 })], {
        employees: [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper' }],
      }),
      invoices: [],
      billRateVersions: [],
      today: TODAY,
    })
    expect(row(noRates, 'c1')).toMatchObject({ basis: 'too_early', detail: 'no rates', service: null })
  })

  it('still counts reimbursements already recorded on a too-early client', () => {
    const data = baseData([client('c1', 'Acme')], {
      reimbursements: [{ id: 'r1', clientId: 'c1', date: '2026-10-03', amount: 75, description: 'Fee' }],
    })
    const result = estimate(data)
    expect(row(result, 'c1')).toMatchObject({ basis: 'too_early', service: null, reimburse: 75, total: 75 })
    expect(result.reimburseTotal).toBe(75)
    expect(result.monthTotal).toBe(75)
  })

  it('sums sent and projected rows into the totals, A to Z', () => {
    const data = baseData([
      client('c2', 'Zed', { billingMode: 'subscription', monthlyRate: 500 }),
      client('c1', 'Acme'),
    ])
    const result = estimate(data, [sentInvoice('a', 'c1')])
    expect(result.clients.map((entry) => entry.clientName)).toEqual(['Acme', 'Zed'])
    expect(result.monthTotal).toBe(1200)
    expect(result.serviceTotal).toBe(1100)
    expect(result.reimburseTotal).toBe(100)
  })

  it('leaves out retired, prospect, opted-out and billed-through-a-master clients', () => {
    const data = baseData([
      client('retired', 'Retired', { lifecycleStage: 'inactive' }),
      client('prospect', 'Prospect', { lifecycleStage: 'onboarding' }),
      client('outside', 'Outside', { platformInvoicingOptOut: true }),
      client('sub', 'Sub', { billToClientId: 'm' }),
      client('c1', 'Acme'),
    ])
    expect(estimate(data).clients.map((entry) => entry.clientId)).toEqual(['c1'])
    expect(isInvoiceRunClient(data.clients[3])).toBe(false)
  })

  it('keeps a retired client that already has a sent invoice, so the month total is true', () => {
    const data = baseData([client('old', 'Old Co', { lifecycleStage: 'inactive' })])
    const result = estimate(data, [sentInvoice('a', 'old')])
    expect(row(result, 'old').basis).toBe('sent')
    expect(result.monthTotal).toBe(700)
  })

  it('makes a billing master the sum of its eligible subs, and gives the subs no rows', () => {
    const data = baseData([
      client('m', 'Master', { isBillingMaster: true, billingMode: 'subscription' }),
      client('s1', 'Sub One', {
        billToClientId: 'm',
        billingMode: 'subscription',
        monthlyRate: 300,
      }),
      client('s2', 'Sub Two', {
        billToClientId: 'm',
        billingMode: 'subscription',
        monthlyRate: 200,
      }),
      client('s3', 'Sub Out', {
        billToClientId: 'm',
        billingMode: 'subscription',
        monthlyRate: 999,
        platformInvoicingOptOut: true,
      }),
    ])
    const result = estimate(data)
    expect(result.clients.map((entry) => entry.clientId)).toEqual(['m'])
    expect(row(result, 'm')).toMatchObject({ basis: 'projected', detail: 'combined', service: 500, total: 500 })
  })
})

describe('buildInvoiceEstimate: billing masters', () => {
  const subOf = (id, name, rate, over = {}) =>
    client(id, name, { billToClientId: 'm', billingMode: 'subscription', monthlyRate: rate, ...over })
  const master = client('m', 'Master', { isBillingMaster: true, billingMode: 'subscription' })

  it('does not add a sub that already holds its own live monthly invoice (the migration month)', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    // s1 has its own sent invoice: it is its own row, and the master's projection leaves it out.
    const result = estimate(data, [sentInvoice('a', 's1', { total: 300, lineItems: [] })])
    expect(row(result, 's1')).toMatchObject({ basis: 'sent', total: 300 })
    expect(row(result, 'm')).toMatchObject({ basis: 'projected', service: 200 })
    expect(result.monthTotal).toBe(500)
  })

  it('leaves out a sub with a live draft of its own, but not one with only a void', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    const result = estimate(data, [
      sentInvoice('d', 's1', { status: 'draft' }),
      sentInvoice('v', 's2', { status: 'void' }),
    ])
    expect(row(result, 'm')).toMatchObject({ service: 200 })
  })

  it('never hides a partial sum: it says how many companies the figure covers and why', () => {
    const data = baseData([
      master,
      subOf('s1', 'Sub One', 300),
      subOf('s2', 'Sub Two', 200),
      client('s3', 'Sub Three', { billToClientId: 'm' }),
      client('s4', 'Sub Four', { billToClientId: 'm', hourlyRate: 0, estimatedBookkeeperHours: 10 }),
    ])
    data.employees = [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper' }]
    const result = buildInvoiceEstimate({
      period: PERIOD,
      data,
      invoices: [],
      billRateVersions: [],
      today: TODAY,
    })
    expect(row(result, 'm')).toMatchObject({
      basis: 'projected',
      service: 500,
      detail: 'combined, 2 of 4 companies (1 too early, 1 no rates)',
    })
  })

  it('says plain "combined" when every company is covered', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    expect(row(estimate(data), 'm').detail).toBe('combined')
  })
})

describe('clientsLeftToInvoice', () => {
  it('names projected clients with something to bill, not sent ones and not clients with nothing to bill', () => {
    const data = baseData([
      client('sent', 'Sent Co', { billingMode: 'subscription', monthlyRate: 500 }),
      client('todo', 'To Do', { billingMode: 'subscription', monthlyRate: 500 }),
      client('zero', 'Zero Plan', { billingMode: 'subscription', monthlyRate: 0 }),
      client('empty', 'No Hours'),
      client('reimb', 'Fee Only'),
    ])
    data.reimbursements = [
      { id: 'r1', clientId: 'reimb', date: '2026-10-03', amount: 40, description: 'Fee' },
    ]
    const result = estimate(data, [sentInvoice('a', 'sent')])
    expect(clientsLeftToInvoice(result.clients)).toEqual([
      { id: 'reimb', name: 'Fee Only' },
      { id: 'todo', name: 'To Do' },
    ])
  })
})
