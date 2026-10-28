import { describe, expect, it } from 'vitest'
import { summarizeInvoiceMonthTotals } from './invoiceMonthTotals'
import type { Client, PersistedInvoice } from './types'

/**
 * The Invoices page ribbon (featreq-ea4a68cd). "Sent", "service" and
 * "reimbursed" come from the Invoice Recap definitions, so these tests pin the
 * ribbon's arithmetic and its not-invoiced list, not those definitions again.
 */

const client = (id: string, over: Partial<Client> = {}) =>
  ({ id, name: id.toUpperCase(), lifecycleStage: 'active', ...over }) as Client

const invoice = (id: string, clientId: string, over: Partial<PersistedInvoice> = {}) =>
  ({
    id,
    clientId,
    period: '2026-10',
    kind: 'monthly',
    status: 'sent',
    number: id,
    total: 100,
    lineItems: [],
    ...over,
  }) as PersistedInvoice

describe('summarizeInvoiceMonthTotals', () => {
  it('counts only invoices that went out: sent, processing, paid, overdue', () => {
    const rows = [
      invoice('a', 'c1', { status: 'sent', total: 100 }),
      invoice('b', 'c2', { status: 'processing', total: 200 }),
      invoice('c', 'c3', { status: 'paid', total: 300 }),
      invoice('d', 'c4', { status: 'overdue', total: 400 }),
      invoice('e', 'c5', { status: 'draft', total: 1000 }),
      invoice('f', 'c6', { status: 'reviewed', total: 2000 }),
      invoice('g', 'c7', { status: 'void', total: 4000 }),
    ]
    const clients = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((id) => client(id))
    const totals = summarizeInvoiceMonthTotals(rows, clients)
    expect(totals.monthTotal).toBe(1000)
    expect(totals.clientsInvoiced).toBe(4)
    expect(totals.notInvoiced.map((entry) => entry.id)).toEqual(['c5', 'c6', 'c7'])
  })

  it('splits reimbursements from services, and takes prepayment and credit out of services', () => {
    const rows = [
      invoice('a', 'c1', {
        total: 1000,
        lineItems: [
          { kind: 'plan', label: 'Monthly', detail: '', amount: 600 },
          { kind: 'reimbursement', label: 'Filing fee', detail: '', amount: 50 },
          { kind: 'recurring', label: 'Software', detail: '', amount: 25 },
          { kind: 'prepayment', label: 'Next month', detail: '', amount: 400 },
          { kind: 'account_credit', label: 'Credit applied', detail: '', amount: -75 },
        ],
      } as Partial<PersistedInvoice>),
    ]
    const totals = summarizeInvoiceMonthTotals(rows, [client('c1')])
    expect(totals.monthTotal).toBe(1000)
    expect(totals.reimburseTotal).toBe(75)
    // 1000 - 75 reimbursed - 400 prepayment - (-75) credit
    expect(totals.serviceTotal).toBe(600)
  })

  it('ignores retainer invoices, like the Invoice Recap page', () => {
    const rows = [
      invoice('a', 'c1', { total: 100 }),
      invoice('r', 'c2', { kind: 'retainer', total: 5000 }),
    ]
    const totals = summarizeInvoiceMonthTotals(rows, [client('c1'), client('c2')])
    expect(totals.monthTotal).toBe(100)
    expect(totals.clientsInvoiced).toBe(1)
  })

  it('counts a client once however many invoices it holds, and a billing master once', () => {
    const rows = [
      invoice('a', 'c1', { total: 100 }),
      invoice('b', 'c1', { total: 50 }),
      invoice('m', 'master', { total: 700 }),
    ]
    const clients = [
      client('c1'),
      client('master', { isBillingMaster: true }),
      client('sub1', { billToClientId: 'master' }),
      client('sub2', { billToClientId: 'master' }),
    ]
    const totals = summarizeInvoiceMonthTotals(rows, clients)
    expect(totals.clientsInvoiced).toBe(2)
    expect(totals.monthTotal).toBe(850)
    // The subs are billed on the master's invoice, so they are not "left".
    expect(totals.notInvoiced).toEqual([])
  })

  it('lists, A to Z, only clients the month run would invoice that have no sent invoice', () => {
    const clients = [
      client('zed', { name: 'Zed Co' }),
      client('amy', { name: 'Amy LLC' }),
      client('done', { name: 'Done Inc' }),
      client('prospect', { name: 'Prospect', lifecycleStage: 'onboarding' }),
      client('retired', { name: 'Retired', lifecycleStage: 'inactive' }),
      client('outside', { name: 'Outside', platformInvoicingOptOut: true }),
      client('sub', { name: 'Sub', billToClientId: 'master' }),
    ]
    const totals = summarizeInvoiceMonthTotals([invoice('a', 'done')], clients)
    expect(totals.notInvoiced).toEqual([
      { id: 'amy', name: 'Amy LLC' },
      { id: 'zed', name: 'Zed Co' },
    ])
  })

  it('rounds to cents', () => {
    const rows = [invoice('a', 'c1', { total: 0.1 }), invoice('b', 'c2', { total: 0.2 })]
    const totals = summarizeInvoiceMonthTotals(rows, [client('c1'), client('c2')])
    expect(totals.monthTotal).toBe(0.3)
  })
})

describe('summarizeInvoiceMonthTotals with the owner estimate', () => {
  const row = (clientId: string, over: Record<string, unknown> = {}) => ({
    clientId,
    clientName: clientId.toUpperCase(),
    basis: 'projected' as const,
    detail: 'plan',
    service: 500,
    reimburse: 0,
    total: 500,
    ...over,
  })

  it('names only the clients with something to bill, not those with nothing to bill', () => {
    const clients = [client('todo'), client('zero'), client('done')]
    const totals = summarizeInvoiceMonthTotals([invoice('a', 'done')], clients, [
      row('todo'),
      row('zero', { service: 0, total: 0 }),
      row('done', { basis: 'sent', detail: null }),
    ])
    expect(totals.notInvoicedFrom).toBe('estimate')
    expect(totals.notInvoiced).toEqual([{ id: 'todo', name: 'TODO' }])
  })

  it('counts a too-early client only when reimbursements are already recorded', () => {
    const clients = [client('c1'), client('c2')]
    const totals = summarizeInvoiceMonthTotals([], clients, [
      row('c1', { basis: 'too_early', detail: 'too early', service: null, reimburse: 0, total: null }),
      row('c2', { basis: 'too_early', detail: 'too early', service: null, reimburse: 40, total: 40 }),
    ])
    expect(totals.notInvoiced.map((entry) => entry.id)).toEqual(['c2'])
  })

  it('drops a client sent since the estimate was read', () => {
    const totals = summarizeInvoiceMonthTotals([invoice('a', 'c1')], [client('c1')], [row('c1')])
    expect(totals.notInvoiced).toEqual([])
  })

  it('puts a client back when its sent invoice was voided after the estimate loaded', () => {
    // The estimate still calls c1 sent; the live invoice list no longer has a sent one.
    const totals = summarizeInvoiceMonthTotals(
      [invoice('a', 'c1', { status: 'void' })],
      [client('c1'), client('c2', { lifecycleStage: 'inactive' })],
      [row('c1', { basis: 'sent', detail: null }), row('c2', { basis: 'sent', detail: null })],
    )
    // c2 is retired, so it is not a client the run would offer.
    expect(totals.notInvoiced).toEqual([{ id: 'c1', name: 'C1' }])
  })

  it('falls back to the roster while the estimate is not there', () => {
    const totals = summarizeInvoiceMonthTotals([], [client('c1')], null)
    expect(totals.notInvoicedFrom).toBe('roster')
    expect(totals.notInvoiced).toEqual([{ id: 'c1', name: 'C1' }])
  })
})
