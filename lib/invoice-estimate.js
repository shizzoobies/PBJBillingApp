/**
 * The owner's estimate of the month's invoices (featreq-a5e14899, 3b162946).
 *
 * "The estimated invoice month view": for every client the month run would
 * invoice, what its invoice is or will be. A client with a SENT monthly invoice
 * is that invoice, as it stands (the Invoice Recap figures: accounting total,
 * reimbursed lines, total). Every other client is the Client Recap's projection
 * for the month (`recap.projection`, lib/client-recap.js), so this page and the
 * client's own recap can never quote two different numbers for the same month.
 *
 * Money rules, because she reads these daily:
 *  - "Sent" and "service / reimbursed" are lib/invoice-recap.js's definitions,
 *    never a second copy.
 *  - A projection with nothing usable behind it (no estimated hours, no rates,
 *    nothing booked yet) is `basis: 'too_early'` with `service: null`. It is
 *    NEVER turned into a $0.00 service figure: the page says "too early" or
 *    "no rates". Reimbursements already recorded are real money and still count.
 *  - A billing master is the sum of its eligible subs' projections (a sub is
 *    billed on the master's invoice and gets no row of its own).
 *
 * Pure: the route reads the store and hands the data in.
 */
import { buildClientRecap } from './client-recap.js'
import { buildInvoiceRecap } from './invoice-recap.js'

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * The clients the month run would offer an invoice to: active, not invoiced
 * outside the app, and not billed on a master's invoice. Mirrors the skips in
 * the generator (`generateInvoices`, db/store.js).
 */
export function isInvoiceRunClient(client) {
  return (
    (client?.lifecycleStage ?? 'active') === 'active' &&
    client?.platformInvoicingOptOut !== true &&
    !(typeof client?.billToClientId === 'string' && client.billToClientId)
  )
}

const DETAIL_BY_KIND = Object.freeze({
  estimate: 'estimate',
  service_so_far: 'service so far',
  no_rates: 'service so far, no rates',
  no_estimate: 'service so far, no estimate set',
})

/**
 * @param {object} args
 * @param {string} args.period  'YYYY-MM'
 * @param {object} args.data    the workspace (clients, timeEntries, plans, ...)
 * @param {Array<object>} args.invoices  the month's stored invoices
 * @param {Array<object>} [args.billRateVersions]
 * @param {string} args.today  yyyy-mm-dd
 */
export function buildInvoiceEstimate({ period, data, invoices = [], billRateVersions = [], today }) {
  const clients = data.clients ?? []
  const sentRows = buildInvoiceRecap({
    invoices,
    clients,
    visibleClientIds: new Set(invoices.map((invoice) => invoice.clientId)),
  })
  const sentByClient = new Map()
  for (const row of sentRows) {
    if (!sentByClient.has(row.clientId)) sentByClient.set(row.clientId, [])
    sentByClient.get(row.clientId).push(row)
  }

  /** One client's projection for the month, or null when there is none. */
  const project = (client) => {
    const recap = buildClientRecap(data, {
      clientId: client.id,
      periodType: 'month',
      period,
      today,
      includeFinancials: true,
      billRateVersions,
      costRateVersions: [],
      invoices: [],
    })
    const projection = recap?.projection
    if (!projection) return null
    const reimburse = round2(projection.reimbursementsToDate)
    if (projection.basis === 'too_early') {
      return {
        usable: false,
        reimburse,
        detail: projection.estimateKind === 'no_rates' ? 'no rates' : 'too early',
      }
    }
    let detail
    if (projection.basis === 'plan') detail = 'plan'
    else if (projection.basis === 'actual') detail = 'as it stands'
    else detail = DETAIL_BY_KIND[projection.estimateKind] ?? 'estimate'
    return { usable: true, service: round2(projection.serviceAmount), reimburse, detail }
  }

  const rows = []
  const addRow = (client, fields) =>
    rows.push({ clientId: client.id, clientName: client.name, ...fields })
  const unusableRow = (reimburse, detail) => ({
    basis: 'too_early',
    detail,
    service: null,
    reimburse,
    total: reimburse > 0 ? reimburse : null,
  })

  const considered = clients.filter(
    (client) => isInvoiceRunClient(client) || sentByClient.has(client.id),
  )
  for (const client of considered) {
    const sent = sentByClient.get(client.id)
    if (sent) {
      addRow(client, {
        basis: 'sent',
        detail: null,
        service: round2(sent.reduce((sum, row) => sum + row.accountingTotal, 0)),
        reimburse: round2(sent.reduce((sum, row) => sum + row.reimbursedTotal, 0)),
        total: round2(sent.reduce((sum, row) => sum + row.total, 0)),
        invoiceNumber: sent[0].number ?? null,
      })
      continue
    }
    if (client.isBillingMaster === true) {
      const subs = clients.filter(
        (sub) =>
          sub.billToClientId === client.id &&
          (sub.lifecycleStage ?? 'active') === 'active' &&
          sub.platformInvoicingOptOut !== true,
      )
      const parts = subs.map(project).filter(Boolean)
      const usable = parts.filter((part) => part.usable)
      const reimburse = round2(parts.reduce((sum, part) => sum + part.reimburse, 0))
      if (usable.length === 0) {
        addRow(client, unusableRow(reimburse, subs.length === 0 ? 'no companies yet' : 'too early'))
      } else {
        const service = round2(usable.reduce((sum, part) => sum + part.service, 0))
        addRow(client, {
          basis: 'projected',
          detail: 'combined',
          service,
          reimburse,
          total: round2(service + reimburse),
        })
      }
      continue
    }
    const part = project(client)
    if (!part) continue
    if (!part.usable) {
      addRow(client, unusableRow(part.reimburse, part.detail))
    } else {
      addRow(client, {
        basis: 'projected',
        detail: part.detail,
        service: part.service,
        reimburse: part.reimburse,
        total: round2(part.service + part.reimburse),
      })
    }
  }

  rows.sort((a, b) => a.clientName.localeCompare(b.clientName))
  return {
    period,
    monthTotal: round2(rows.reduce((sum, row) => sum + (row.total ?? 0), 0)),
    serviceTotal: round2(rows.reduce((sum, row) => sum + (row.service ?? 0), 0)),
    reimburseTotal: round2(rows.reduce((sum, row) => sum + row.reimburse, 0)),
    clients: rows,
  }
}

/**
 * The clients that have something to bill but no sent invoice yet: projected
 * rows (or too-early ones holding recorded reimbursements) with money behind
 * them. A client with nothing to bill this month is not "left to invoice".
 */
export function clientsLeftToInvoice(rows) {
  return rows
    .filter((row) => row.basis !== 'sent' && (row.service ?? 0) + row.reimburse > 0)
    .map((row) => ({ id: row.clientId, name: row.clientName }))
}
