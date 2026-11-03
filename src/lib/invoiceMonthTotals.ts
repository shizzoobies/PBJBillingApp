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
import { getBillingPeriodLabel } from './utils'

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
  notInvoiced: Array<{ id: string; name: string; label?: string }>
  /**
   * Where `notInvoiced` came from. 'estimate': the owner's estimate rows, so only
   * clients with something to bill. 'roster': the fallback while that request is
   * pending or failed - every client the run would offer, including any with
   * nothing to bill this month.
   */
  notInvoicedFrom: 'estimate' | 'roster'
  /**
   * Push to next month (featreq-40697310): clients whose invoice for this month was
   * closed into a later month's, A to Z. Never in `notInvoiced`: the work is billed
   * on that later invoice. `label` is what the fold-out says ("Rolled into November 2026").
   */
  rolled: Array<{ id: string; name: string; intoPeriod: string; label: string }>
  /**
   * Clients with work pushed into this month (featreq-40697310) that can no longer
   * be billed (inactive, a prospect, opted out, billed on another client's
   * invoice): never dropped from every surface. Counted in "Clients not invoiced".
   * From the estimate only.
   */
  waiting: Array<{ id: string; name: string; label: string }>
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
  // A pushed month: a void monthly invoice carrying the month it went into, for a
  // client with no live monthly invoice of its own this month.
  const live = new Set(
    invoices
      .filter((invoice) => invoice.kind === 'monthly' && invoice.status !== 'void')
      .map((invoice) => invoice.clientId),
  )
  const rolledInto = new Map<string, string>()
  for (const invoice of invoices) {
    if (
      invoice.kind === 'monthly' &&
      invoice.status === 'void' &&
      typeof invoice.rolledIntoPeriod === 'string' &&
      /^[0-9]{4}-[0-9]{2}$/.test(invoice.rolledIntoPeriod) &&
      !live.has(invoice.clientId)
    ) {
      rolledInto.set(invoice.clientId, invoice.rolledIntoPeriod)
    }
  }
  const rolled = [...rolledInto.entries()]
    .map(([id, intoPeriod]) => ({
      id,
      name: clients.find((client) => client.id === id)?.name ?? 'Unknown client',
      intoPeriod,
      label: `Rolled into ${getBillingPeriodLabel(intoPeriod)}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    monthTotal: cents(rows.reduce((sum, row) => sum + row.total, 0)),
    serviceTotal: cents(rows.reduce((sum, row) => sum + row.accountingTotal, 0)),
    reimburseTotal: cents(rows.reduce((sum, row) => sum + row.reimbursedTotal, 0)),
    clientsInvoiced: invoiced.size,
    // The estimate is read when the month opens; a send since then moves a client
    // into `invoiced` straight away, so that wins over the older estimate.
    // A sent invoice VOIDED since the estimate was read leaves `invoiced` while the
    // estimate still calls that client sent: it is left to invoice again.
    notInvoiced: (estimateRows
      ? [
          ...clientsLeftToInvoice(estimateRows),
          ...estimateRows
            .filter((entry) => entry.basis === 'sent')
            .map((entry) => clients.find((client) => client.id === entry.clientId))
            .filter((client): client is Client => !!client && isInvoiceRunClient(client))
            .map((client) => ({ id: client.id, name: client.name })),
        ]
      : clients.filter(isInvoiceRunClient).map((client) => ({ id: client.id, name: client.name }))
    )
      .filter((client) => !invoiced.has(client.id) && !rolledInto.has(client.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    notInvoicedFrom: estimateRows ? 'estimate' : 'roster',
    rolled,
    waiting: (estimateRows ?? [])
      .filter((entry) => entry.basis === 'pushed_waiting' && entry.notBillable === true && !invoiced.has(entry.clientId))
      .map((entry) => ({
        id: entry.clientId,
        name: entry.clientName,
        label: 'pushed work waiting - client not billable',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}
