/**
 * Turning a client + a month into a DRAFT INVOICE (I1).
 *
 * `buildInvoiceLines` answers "what do we bill for the work". This adds the
 * things an invoice needs that a line list does not:
 *
 *   - a prior-month adjustment, so a correction rolls forward instead of being
 *     re-typed (Brittany's steps 3b/4d)
 *   - out-of-scope flags — "confirm no extra charges, the girls won't know"
 *     (her step 4f), surfaced for review rather than silently billed
 *   - a due date derived from the client's own payment terms
 *
 * Pure: no clock, no database, no numbering. The caller supplies `today` and
 * assigns the invoice number, because that needs a sequence only the store can
 * hand out safely.
 */

import { buildInvoiceLines } from './invoice-lines.js'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Read a due date out of free-text payment terms. Brittany types these per
 * client, so this stays forgiving: "Net 30", "net30", "30 days", "Due on
 * receipt". Anything unrecognized falls back to `defaultNetDays` rather than
 * guessing — an invoice with a wrong due date is worse than a conservative one.
 */
export function dueDateFromTerms(periodEnd, terms, defaultNetDays = 30) {
  const text = String(terms ?? '').trim().toLowerCase()
  let days = defaultNetDays
  if (/receipt|immediat|upon\s+receipt/.test(text)) {
    days = 0
  } else {
    const match = text.match(/(\d{1,3})/)
    if (match) {
      const parsed = Number(match[1])
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 365) days = parsed
    }
  }
  const base = new Date(`${periodEnd}T12:00:00`)
  if (Number.isNaN(base.getTime())) return null
  base.setDate(base.getDate() + days)
  return base.toISOString().slice(0, 10)
}

/** Last calendar day of a "YYYY-MM" period, as YYYY-MM-DD. */
export function periodEndDate(period) {
  const year = Number(String(period).slice(0, 4))
  const month = Number(String(period).slice(5, 7))
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null
  // Day 0 of the NEXT month is the last day of this one.
  const end = new Date(Date.UTC(year, month, 0))
  return end.toISOString().slice(0, 10)
}

/** The "YYYY-MM" immediately before `period`. */
export function previousPeriod(period) {
  let year = Number(String(period).slice(0, 4))
  let month = Number(String(period).slice(5, 7))
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null
  month -= 1
  if (month < 1) {
    month = 12
    year -= 1
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * Work logged this month that the client's plan does not obviously cover —
 * "the girls won't know". These are FLAGS, never charges: they appear on the
 * draft for Brittany to decide about, and carry no amount, because silently
 * billing for unexpected work is the exact thing she was guarding against.
 *
 * Two signals, both deliberately blunt — a flag that fires often gets ignored:
 *   1. the month's tracked hours exceeded the client's estimated hours
 *   2. a subscription/annual client accrued BILLABLE hours, which their flat
 *      fee already covers, so someone logged work as billable by mistake or
 *      did something outside the arrangement
 */
export function buildScopeFlags({ client, entries = [], period }) {
  const clientEntries = entries.filter(
    (entry) => entry.clientId === client.id && String(entry.date ?? '').startsWith(period),
  )
  if (clientEntries.length === 0) return []

  const flags = []
  const totalMinutes = clientEntries.reduce((sum, entry) => sum + (Number(entry.minutes) || 0), 0)
  const totalHours = totalMinutes / 60

  const estimated =
    (Number(client.estimatedBookkeeperHours) || 0) +
    (Number(client.estimatedAccountantHours) || 0) +
    (Number(client.estimatedCfoHours) || 0)
  if (estimated > 0 && totalHours > estimated) {
    flags.push({
      kind: 'over-estimate',
      label: 'More hours than this client is scoped for',
      detail: `${totalHours.toFixed(1)}h logged against an estimate of ${estimated.toFixed(1)}h`,
    })
  }

  if (client.billingMode === 'subscription' || client.billingMode === 'annual') {
    const billableMinutes = clientEntries.reduce(
      (sum, entry) => sum + (entry.billable ? Number(entry.minutes) || 0 : 0),
      0,
    )
    if (billableMinutes > 0) {
      flags.push({
        kind: 'billable-on-flat-fee',
        label: 'Billable time on a flat-fee client',
        detail: `${(billableMinutes / 60).toFixed(1)}h marked billable — the flat fee already covers it, so this is not on the invoice`,
      })
    }
  }

  return flags
}

/**
 * Build one client's draft for one period.
 *
 * @param {object} args
 * @param {object} args.client
 * @param {string} args.period                 "YYYY-MM"
 * @param {Array}  [args.entries]
 * @param {Array}  [args.plans]
 * @param {Array}  [args.reimbursements]
 * @param {Array}  [args.recurringReimbursements]
 * @param {Array}  [args.employees]
 * @param {number} [args.defaultHourlyRate]
 * @param {object|null} [args.priorInvoice]    last month's invoice, for the true-up
 * @param {number} [args.defaultNetDays]
 * @returns {{
 *   clientId: string, period: string, lineItems: Array, subtotal: number,
 *   total: number, dueDate: string|null, scopeFlags: Array, billableMinutes: number,
 *   entryCount: number, periodLabel: string,
 * }}
 */
export function buildInvoiceDraft({
  client,
  period,
  entries = [],
  plans = [],
  reimbursements = [],
  recurringReimbursements = [],
  employees = [],
  defaultHourlyRate = 0,
  priorInvoice = null,
  defaultNetDays = 30,
}) {
  const built = buildInvoiceLines({
    client,
    entries,
    plans,
    billingPeriod: period,
    reimbursements,
    recurringReimbursements,
    employees,
    defaultHourlyRate,
  })

  const lineItems = built.lines.map((line) => ({ ...line, amount: round2(line.amount) }))
  const subtotal = round2(lineItems.reduce((sum, line) => sum + line.amount, 0))

  // Prior-month true-up. Carried automatically so a correction Brittany made
  // last month rolls forward instead of being re-typed; I2 lets her override
  // the amount. Only a NON-ZERO adjustment earns a line.
  const adjustmentAmount = round2(priorInvoice?.adjustmentForNextPeriod ?? 0)
  if (adjustmentAmount !== 0) {
    const prior = previousPeriod(period)
    lineItems.push({
      kind: 'adjustment',
      label: `Adjustment — ${prior ?? 'prior month'}`,
      detail:
        adjustmentAmount > 0
          ? 'Additional amount carried from last month'
          : 'Credit carried from last month',
      amount: adjustmentAmount,
    })
  }

  const total = round2(lineItems.reduce((sum, line) => sum + line.amount, 0))
  const end = periodEndDate(period)

  return {
    clientId: client.id,
    period,
    lineItems,
    subtotal,
    total,
    dueDate: end ? dueDateFromTerms(end, client.paymentTerms, defaultNetDays) : null,
    scopeFlags: buildScopeFlags({ client, entries, period }),
    billableMinutes: built.billableMinutes,
    entryCount: built.entryCount,
    periodLabel: built.periodLabel,
  }
}

/**
 * Sequential invoice number for a period: INV-2026-08-001.
 *
 * `takenNumbers` is every number already issued FOR THAT PERIOD, so a re-run
 * continues the sequence rather than colliding. Numbering is per period, not
 * global, which is what makes a month's invoices read as a batch.
 */
export function nextInvoiceNumber(period, takenNumbers = []) {
  const prefix = `INV-${period}-`
  let highest = 0
  for (const number of takenNumbers) {
    if (typeof number !== 'string' || !number.startsWith(prefix)) continue
    const parsed = Number(number.slice(prefix.length))
    if (Number.isFinite(parsed) && parsed > highest) highest = parsed
  }
  return `${prefix}${String(highest + 1).padStart(3, '0')}`
}
