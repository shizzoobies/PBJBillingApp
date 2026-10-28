/**
 * The Invoices page's top ribbon for a month (featreq-ea4a68cd): what has gone
 * out, split into services and reimbursements, and who is still left.
 *
 * Nothing here defines "sent", "service" or "reimbursed" a second time. The
 * rows come from `buildInvoiceRecap` (lib/invoice-recap.js) - the same function
 * behind the staff Invoice Recap page - so the ribbon and that page can never
 * disagree: sent / processing / paid / overdue monthly invoices only, service =
 * total minus reimbursed, prepayment and credit-applied lines.
 */
import { buildInvoiceRecap } from '../../lib/invoice-recap.js'
import { lifecycleOf } from './clientLifecycle'
import type { Client, PersistedInvoice } from './types'

export type InvoiceMonthTotals = {
  /** Sum of `total` over the month's sent monthly invoices. */
  monthTotal: number
  /** Sum of each one's accounting side (total minus reimbursed, prepayment, credit). */
  serviceTotal: number
  /** Sum of each one's reimbursed lines. */
  reimburseTotal: number
  /** Distinct clients holding a sent invoice (a billing master counts once). */
  clientsInvoiced: number
  /** Clients the month run would invoice that have no sent invoice yet, A to Z. */
  notInvoiced: Array<{ id: string; name: string }>
}

const cents = (value: number) => Math.round(value * 100) / 100

/**
 * The clients the month run offers an invoice to: active, not invoiced outside
 * the app, and not billed on a master's invoice (the master stands for them).
 * Mirrors the generator's skips in `generateInvoices` (db/store.js).
 */
function billableThisMonth(client: Client) {
  return (
    lifecycleOf(client) === 'active' &&
    client.platformInvoicingOptOut !== true &&
    !(typeof client.billToClientId === 'string' && client.billToClientId)
  )
}

export function summarizeInvoiceMonthTotals(
  invoices: readonly PersistedInvoice[],
  clients: readonly Client[],
): InvoiceMonthTotals {
  const rows = buildInvoiceRecap({
    invoices,
    clients,
    visibleClientIds: new Set(invoices.map((invoice) => invoice.clientId)),
  })
  const invoiced = new Set(rows.map((row) => row.clientId))
  return {
    monthTotal: cents(rows.reduce((sum, row) => sum + row.total, 0)),
    serviceTotal: cents(rows.reduce((sum, row) => sum + row.accountingTotal, 0)),
    reimburseTotal: cents(rows.reduce((sum, row) => sum + row.reimbursedTotal, 0)),
    clientsInvoiced: invoiced.size,
    notInvoiced: clients
      .filter((client) => billableThisMonth(client) && !invoiced.has(client.id))
      .map((client) => ({ id: client.id, name: client.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}
