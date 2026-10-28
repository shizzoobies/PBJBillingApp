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
import {
  clientsLeftToInvoice,
  isInvoiceRunClient,
  type InvoiceEstimateRow,
} from '../../lib/invoice-estimate.js'
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
  /** Clients still to invoice (no sent invoice yet), A to Z. */
  notInvoiced: Array<{ id: string; name: string }>
  /**
   * Where `notInvoiced` came from. 'estimate': the owner's estimate rows, so only
   * clients with something to bill. 'roster': the fallback while that request is
   * pending or failed - every client the run would offer, including any with
   * nothing to bill this month.
   */
  notInvoicedFrom: 'estimate' | 'roster'
}

const cents = (value: number) => Math.round(value * 100) / 100

export function summarizeInvoiceMonthTotals(
  invoices: readonly PersistedInvoice[],
  clients: readonly Client[],
  /** The owner's estimate rows for this month, once loaded (see lib/invoice-estimate.js). */
  estimateRows?: readonly InvoiceEstimateRow[] | null,
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
    // The estimate is read when the month opens; a send since then moves a client
    // into `invoiced` straight away, so that wins over the older estimate.
    notInvoiced: (estimateRows
      ? clientsLeftToInvoice(estimateRows)
      : clients.filter(isInvoiceRunClient).map((client) => ({ id: client.id, name: client.name }))
    )
      .filter((client) => !invoiced.has(client.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    notInvoicedFrom: estimateRows ? 'estimate' : 'roster',
  }
}
