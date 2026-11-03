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
import { REIMBURSED_LINE_KINDS, buildInvoiceRecap } from './invoice-recap.js'
import { carriedLinesFromRolledInvoice } from './invoice-rollforward.js'
import { currentPeriod, isValidPeriod } from './periods.js'
import { getBillingPeriodLabel } from './invoice-lines.js'

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

/**
 * The month the estimate route answers for: the asked-for 'YYYY-MM' when it is a
 * real month, today's month when none was asked, and null (a 400) for anything
 * else. One definition so the route and its tests cannot drift apart.
 */
export function resolveEstimatePeriod(periodParam, todayIso) {
  if (!periodParam) return currentPeriod('month', todayIso)
  return isValidPeriod('month', periodParam) ? periodParam : null
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
 * @param {Array<object>} [args.priorInvoices]  last month's stored invoices (for work pushed into this month)
 * @param {Array<object>} [args.billRateVersions]
 * @param {Array<object>} [args.activityInvoices]  every invoice's narrow evidence row
 *   (store.listInvoiceEvidence) - when each client started being billed, so the
 *   Client Recap's active-month rule never drops a client's row for a month it
 *   was billed or reimbursed in before its client record was created
 * @param {string} args.today  yyyy-mm-dd
 */
export function buildInvoiceEstimate({
  period,
  data,
  invoices = [],
  priorInvoices = [],
  billRateVersions = [],
  activityInvoices = [],
  today,
}) {
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
      // Evidence only (featreq-8dffdff7): the month's own invoices - a DRAFT
      // counts - and every period's, so a client created after this month but
      // billed in it keeps its row. Nothing is priced from these.
      activityInvoices: [...activityInvoices, ...invoices],
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

  // Clients holding a live (not void) monthly invoice of their own this period,
  // with that invoice's status.
  const liveOwnInvoice = new Map()
  for (const invoice of invoices) {
    if (invoice?.kind === 'monthly' && invoice.status !== 'void' && !liveOwnInvoice.has(invoice.clientId)) {
      liveOwnInvoice.set(invoice.clientId, invoice.status)
    }
  }
  const isBilledSub = (client) =>
    typeof client?.billToClientId === 'string' && client.billToClientId !== ''
  // PUSHED TO NEXT MONTH (featreq-40697310): a client whose invoice for this month
  // was closed into the next month's. Not "left to invoice" and no projection: the
  // work is billed on that later invoice, so quoting it here would count it twice.
  const rolledInto = new Map()
  for (const invoice of invoices) {
    if (
      invoice?.kind === 'monthly' &&
      invoice.status === 'void' &&
      isValidPeriod('month', invoice.rolledIntoPeriod) &&
      !liveOwnInvoice.has(invoice.clientId)
    ) {
      rolledInto.set(invoice.clientId, invoice.rolledIntoPeriod)
    }
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

  // A sub that holds its own live invoice is not on the master's: if that invoice is
  // not sent yet it still has to appear somewhere, so it gets a row of its own.
  const considered = clients.filter(
    (client) =>
      isInvoiceRunClient(client) ||
      sentByClient.has(client.id) ||
      (isBilledSub(client) &&
        (client.lifecycleStage ?? 'active') === 'active' &&
        client.platformInvoicingOptOut !== true &&
        liveOwnInvoice.has(client.id)),
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
    if (rolledInto.has(client.id)) {
      addRow(client, {
        basis: 'rolled',
        detail: `Rolled into ${getBillingPeriodLabel(rolledInto.get(client.id))}`,
        service: null,
        reimburse: 0,
        total: null,
        rolledIntoPeriod: rolledInto.get(client.id),
      })
      continue
    }
    if (client.isBillingMaster === true) {
      // The generator's own merge rules: a retired, prospect or opted-out sub is
      // off the master's invoice, and so is a sub that already holds a live
      // monthly invoice of its own for the period ('already-billed-on-own-invoice',
      // the migration month): counting it here would add it twice.
      const eligibleSubs = clients.filter(
        (sub) =>
          sub.billToClientId === client.id &&
          (sub.lifecycleStage ?? 'active') === 'active' &&
          sub.platformInvoicingOptOut !== true,
      )
      const subs = eligibleSubs.filter((sub) => !liveOwnInvoice.has(sub.id))
      const onOwnInvoice = eligibleSubs.length - subs.length
      const parts = subs.map(project).filter(Boolean)
      const usable = parts.filter((part) => part.usable)
      const reimburse = round2(parts.reduce((sum, part) => sum + part.reimburse, 0))
      if (usable.length === 0) {
        const emptyWord = onOwnInvoice > 0 ? 'companies on their own invoices' : 'no companies yet'
        addRow(client, unusableRow(reimburse, subs.length === 0 ? emptyWord : 'too early'))
      } else {
        const service = round2(usable.reduce((sum, part) => sum + part.service, 0))
        // Never a silent partial sum: say how many companies the figure covers
        // and why the rest are out.
        const unusable = parts.filter((part) => !part.usable)
        const why = ['too early', 'no rates']
          .map((word) => [word, unusable.filter((part) => part.detail === word).length])
          .filter(([, count]) => count > 0)
          .map(([word, count]) => `${count} ${word}`)
        if (onOwnInvoice > 0) why.push(`${onOwnInvoice} on own invoice`)
        addRow(client, {
          basis: 'projected',
          detail:
            unusable.length === 0
              ? why.length === 0
                ? 'combined'
                : `combined (${why.join(', ')})`
              : `combined, ${usable.length} of ${parts.length} companies (${why.join(', ')})`,
          service,
          reimburse,
          total: round2(service + reimburse),
        })
      }
      continue
    }
    const part = project(client)
    if (!part) continue
    // A billed-through sub reaches here only for its own unsent invoice: say so.
    const ownNote = isBilledSub(client) ? `own invoice (${liveOwnInvoice.get(client.id)})` : null
    if (!part.usable) {
      addRow(client, unusableRow(part.reimburse, ownNote ? `${ownNote}, ${part.detail}` : part.detail))
    } else {
      addRow(client, {
        basis: 'projected',
        detail: ownNote ?? part.detail,
        service: part.service,
        reimburse: part.reimburse,
        total: round2(part.service + part.reimburse),
      })
    }
  }

  // WORK PUSHED INTO THIS MONTH (featreq-40697310) that no invoice holds yet.
  // Its money is real (it is last month's lines, as she left them), so a billable
  // client's row ADDS it - service and reimbursed split the way the recap splits
  // them - and says so ("incl. October 2026 pushed work"): the month total shows
  // it before this month is generated, and the client is left to invoice whatever
  // its own projection. A billable client with no row of its own gets a neutral
  // "pushed work waiting" row carrying that money. A client who can no longer be
  // billed (inactive, a prospect, opted out, billed on another client's invoice)
  // gets a "client not billable" row with no figure, so the money is never
  // dropped from every surface, nor counted as if it will be billed.
  const waitingFrom = new Map()
  for (const invoice of priorInvoices) {
    if (
      invoice?.kind === 'monthly' &&
      invoice.status === 'void' &&
      invoice.rolledIntoPeriod === period &&
      !liveOwnInvoice.has(invoice.clientId)
    ) {
      waitingFrom.set(invoice.clientId, invoice)
    }
  }
  const carriedMoney = (invoice) => {
    const lines = carriedLinesFromRolledInvoice(invoice)
    const reimburse = round2(
      lines.filter((line) => REIMBURSED_LINE_KINDS.includes(line.kind)).reduce((sum, line) => sum + line.amount, 0),
    )
    const total = round2(lines.reduce((sum, line) => sum + line.amount, 0))
    return { service: round2(total - reimburse), reimburse }
  }
  for (const row of rows) {
    const pushed = waitingFrom.get(row.clientId)
    if (row.basis === 'sent' || !pushed) continue
    const money = carriedMoney(pushed)
    const words = `incl. ${getBillingPeriodLabel(pushed.period)} pushed work`
    row.pushedInWaiting = pushed.period
    row.service = round2((row.service ?? 0) + money.service)
    row.reimburse = round2(row.reimburse + money.reimburse)
    row.total = round2(row.service + row.reimburse)
    row.detail = row.detail ? `${row.detail}, ${words}` : words
  }
  for (const [clientId, pushed] of waitingFrom) {
    if (rows.some((row) => row.clientId === clientId)) continue
    const client = clients.find((entry) => entry.id === clientId)
    const label = getBillingPeriodLabel(pushed.period)
    const base = {
      clientId,
      clientName: client?.name ?? 'Unknown client',
      basis: 'pushed_waiting',
      pushedInWaiting: pushed.period,
    }
    if (client && isInvoiceRunClient(client)) {
      const money = carriedMoney(pushed)
      rows.push({
        ...base,
        detail: `${label}'s pushed work waiting`,
        service: money.service,
        reimburse: money.reimburse,
        total: round2(money.service + money.reimburse),
        notBillable: false,
      })
    } else {
      rows.push({
        ...base,
        detail: `${label}'s pushed work waiting - client not billable`,
        service: null,
        reimburse: 0,
        total: null,
        notBillable: true,
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
    .filter(
      (row) =>
        row.basis !== 'sent' &&
        row.basis !== 'rolled' &&
        !(row.basis === 'pushed_waiting' && row.notBillable) &&
        ((row.service ?? 0) + row.reimburse > 0 || Boolean(row.pushedInWaiting)),
    )
    .map((row) =>
      row.basis === 'pushed_waiting'
        ? { id: row.clientId, name: row.clientName, label: 'pushed work waiting' }
        : { id: row.clientId, name: row.clientName },
    )
}
