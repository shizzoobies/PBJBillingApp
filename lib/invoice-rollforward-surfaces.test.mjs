/**
 * Push to next month (featreq-40697310) on the surfaces that count invoices:
 * the owner's estimate and its "Clients not invoiced" list, and the Client Recap
 * Billing tile. A pushed month is not "not invoiced", is never quoted twice, and
 * says where it went.
 */
import { describe, expect, it } from 'vitest'
import { buildInvoiceEstimate, clientsLeftToInvoice } from './invoice-estimate.js'
import { buildClientRecap } from './client-recap.js'

const rolled = (over = {}) => ({
  id: 'inv-oct',
  clientId: 'c1',
  period: '2026-10',
  kind: 'monthly',
  status: 'void',
  rolledIntoPeriod: '2026-11',
  number: 'INV-2026-10-001',
  total: 120,
  lineItems: [{ kind: 'hourly', label: 'Bookkeeping Services', amount: 120, hours: 1, rate: 120 }],
  ...over,
})

const data = {
  clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 120, planIds: [], lifecycleStage: 'active', assignedBookkeeperIds: ['lisa'] }],
  plans: [],
  employees: [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 120 }],
  timeEntries: [{ id: 't1', employeeId: 'lisa', clientId: 'c1', date: '2026-10-10', minutes: 60, billable: true }],
  reimbursements: [],
  recurringReimbursements: [],
}
const rateVersions = [{ userId: 'lisa', effectiveDate: '1970-01-01', rate: 120 }]

describe('the estimate: a pushed month', () => {
  const estimate = (invoices) =>
    buildInvoiceEstimate({ period: '2026-10', data, invoices, billRateVersions: rateVersions, today: '2026-11-02' })

  it('is a "Rolled into November 2026" row with no figure, and is not left to invoice', () => {
    const result = estimate([rolled()])
    expect(result.clients).toEqual([
      expect.objectContaining({
        clientId: 'c1',
        basis: 'rolled',
        detail: 'Rolled into November 2026',
        service: null,
        reimburse: 0,
        total: null,
        rolledIntoPeriod: '2026-11',
      }),
    ])
    expect(result.monthTotal).toBe(0)
    expect(clientsLeftToInvoice(result.clients)).toEqual([])
  })

  it('a plain void is still projected and left to invoice', () => {
    const result = estimate([rolled({ rolledIntoPeriod: null })])
    expect(result.clients[0].basis).toBe('projected')
    expect(clientsLeftToInvoice(result.clients)).toEqual([{ id: 'c1', name: 'Acme' }])
  })

  it('a live invoice for the month wins over an older push', () => {
    const result = estimate([rolled(), { ...rolled({ id: 'inv-new', status: 'draft', rolledIntoPeriod: null }) }])
    expect(result.clients[0].basis).toBe('projected')
  })
})

describe('Client Recap Billing tile: a pushed month', () => {
  const opts = { clientId: 'c1', periodType: 'month', period: '2026-10', today: '2026-11-02', includeFinancials: true }

  it('says where it went and keeps the live figure', () => {
    const recap = buildClientRecap(data, { ...opts, invoices: [rolled()] })
    expect(recap.billing.invoice.caption).toBe("Rolled into November 2026's invoice")
    expect(recap.billing.invoice.amount).toBe(120)
    expect(recap.billing.invoice.sentMonths).toBe(0)
  })

  it('a plain void still reads "Not invoiced yet"', () => {
    const recap = buildClientRecap(data, { ...opts, invoices: [rolled({ rolledIntoPeriod: null })] })
    expect(recap.billing.invoice.caption).toBe('Not invoiced yet')
  })
})

describe('the estimate: pushed work waiting', () => {
  const pushedIn = rolled({ period: '2026-10', rolledIntoPeriod: '2026-11' })
  const estimateNovember = (clientOver = {}, invoices = []) =>
    buildInvoiceEstimate({
      period: '2026-11',
      data: { ...data, clients: [{ ...data.clients[0], ...clientOver }] },
      invoices,
      priorInvoices: [pushedIn],
      billRateVersions: rateVersions,
      today: '2026-11-02',
    })

  it.each([
    ['inactive', { lifecycleStage: 'inactive' }],
    ['a prospect', { lifecycleStage: 'prospect' }],
    ['opted out', { platformInvoicingOptOut: true }],
    ['billed on another client', { billToClientId: 'master-1' }],
  ])('a client who is %s gets a "pushed work waiting - client not billable" row', (_name, over) => {
    const result = estimateNovember(over)
    expect(result.clients).toEqual([
      expect.objectContaining({
        clientId: 'c1',
        basis: 'pushed_waiting',
        detail: "October 2026's pushed work waiting - client not billable",
        service: null,
        total: null,
        pushedInWaiting: '2026-10',
      }),
    ])
    expect(clientsLeftToInvoice(result.clients)).toEqual([])
  })

  it('a billable client with pushed work not yet on an invoice is left to invoice, whatever its own projection', () => {
    const result = estimateNovember()
    expect(result.clients[0]).toMatchObject({ clientId: 'c1', pushedInWaiting: '2026-10' })
    expect(clientsLeftToInvoice(result.clients)).toEqual([{ id: 'c1', name: 'Acme' }])
  })

  it('once November has a live invoice nothing is waiting', () => {
    const result = estimateNovember({}, [rolled({ id: 'inv-nov', period: '2026-11', status: 'draft', rolledIntoPeriod: null })])
    expect(result.clients[0].pushedInWaiting).toBeUndefined()
  })
})
