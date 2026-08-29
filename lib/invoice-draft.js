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

import { buildInvoiceLines, getBillingPeriodLabel } from './invoice-lines.js'

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
 * The prior-month true-up line, or null when there is nothing to carry.
 *
 * Carried automatically so a correction Brittany made last month rolls forward
 * instead of being re-typed; I2 lets her override the amount. Only a NON-ZERO
 * adjustment earns a line.
 *
 * Extracted so the consolidated draft can apply the MASTER's adjustment through
 * exactly the same rule rather than a second copy of it — an adjustment that
 * read differently on a merged invoice would be a correction quietly changing
 * shape on its way to the client.
 */
function priorAdjustmentLine(period, priorInvoice) {
  const amount = round2(priorInvoice?.adjustmentForNextPeriod ?? 0)
  if (amount === 0) return null
  const prior = previousPeriod(period)
  return {
    kind: 'adjustment',
    label: `Adjustment — ${prior ?? 'prior month'}`,
    detail:
      amount > 0
        ? 'Additional amount carried from last month'
        : 'Credit carried from last month',
    amount,
  }
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

  // Cents, once, here — this is where lines become money of record. An adhoc
  // line's `adhocAmount` is rounded alongside its `amount`: the two are the same
  // figure seen from either side of the owner's billed/courtesy/omitted choice,
  // and a sub-cent gap between them would surface as a penny appearing when she
  // flipped a line back to billed.
  const lineItems = built.lines.map((line) => ({
    ...line,
    amount: round2(line.amount),
    ...(line.kind === 'adhoc' ? { adhocAmount: round2(line.adhocAmount) } : {}),
  }))
  const subtotal = round2(lineItems.reduce((sum, line) => sum + line.amount, 0))

  const adjustment = priorAdjustmentLine(period, priorInvoice)
  if (adjustment) lineItems.push(adjustment)

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
 * Build the BILLING MASTER's draft for one period, out of its subs' drafts.
 *
 * KLC pays one invoice covering four companies (`docs/plans/consolidated-billing-2026-08.md`).
 * A master holds no time, no plans and no reimbursements of its own, so it has
 * no lines to build — every line on this draft was already priced by
 * `buildInvoiceDraft` for one of the subs, and is carried across UNCHANGED.
 *
 * THE ONE MONEY CALCULATOR RULE, restated for this function: nothing here
 * multiplies, prices or re-rounds anything. Subtotal and total are the SUM of
 * the sub drafts' own figures, which were rounded once, where they were built.
 * Re-deriving them from the merged lines would look equivalent and would not be
 * — a sub's total already carries that sub's own adjustment.
 *
 * Every carried line is stamped `sourceClientId`, which is what answers "what
 * did each company pay" on every app-side surface afterwards. A line that
 * already carries one keeps it: the stamp is written at generation and never
 * re-derived.
 *
 * @param {object} args
 * @param {object} args.master             the billing-master client row
 * @param {string} args.period             "YYYY-MM"
 * @param {Array<{client: object, draft: object}>} [args.subDrafts]
 *   each sub's normal `buildInvoiceDraft` result, IN THE ORDER THEY SHOULD
 *   PRINT (the store sends client-name order). A sub with no lines contributes
 *   nothing and is not an error — a quiet month is not a fault.
 * @param {object|null} [args.priorInvoice] the MASTER's own last invoice
 * @param {number} [args.defaultNetDays]
 * @returns {object} the same shape `buildInvoiceDraft` returns
 */
export function buildConsolidatedInvoiceDraft({
  master,
  period,
  subDrafts = [],
  priorInvoice = null,
  defaultNetDays = 30,
}) {
  const lineItems = []
  const scopeFlags = []
  let subtotal = 0
  let total = 0
  let billableMinutes = 0
  let entryCount = 0

  for (const entry of Array.isArray(subDrafts) ? subDrafts : []) {
    const client = entry?.client
    const draft = entry?.draft
    if (!client || !draft) continue
    const name = String(client.name ?? '').trim()

    for (const line of draft.lineItems ?? []) {
      lineItems.push({ ...line, sourceClientId: line.sourceClientId ?? client.id })
      // Subs no longer invoice, so a sub-level true-up should not exist by the
      // time this runs. If one does, it stays that sub's line — dropping it
      // would silently swallow a correction — and it is FLAGGED, because it
      // means a sub was still being invoiced when it should not have been.
      if (line.kind === 'adjustment') {
        scopeFlags.push({
          kind: 'sub-adjustment',
          label: `${name}: prior-month adjustment carried onto the combined invoice`,
          detail: `${name} no longer invoices on its own, so this true-up came from an invoice that should not exist`,
          sourceClientId: client.id,
        })
      }
    }

    // Prefixed so the month-run chips read "Chemtrex: More hours than this
    // client is scoped for" — on a merged invoice a bare flag names nobody.
    for (const flag of draft.scopeFlags ?? []) {
      scopeFlags.push({
        ...flag,
        label: `${name}: ${String(flag?.label ?? '')}`,
        sourceClientId: client.id,
      })
    }

    subtotal += Number(draft.subtotal) || 0
    total += Number(draft.total) || 0
    billableMinutes += Number(draft.billableMinutes) || 0
    entryCount += Number(draft.entryCount) || 0
  }

  // The MASTER's own true-up, applied exactly as it is on any other invoice:
  // after the lines, counted in the total and not in the subtotal.
  const adjustment = priorAdjustmentLine(period, priorInvoice)
  if (adjustment) {
    lineItems.push(adjustment)
    total += adjustment.amount
  }

  const end = periodEndDate(period)

  return {
    clientId: master.id,
    period,
    lineItems,
    subtotal: round2(subtotal),
    total: round2(total),
    dueDate: end ? dueDateFromTerms(end, master.paymentTerms, defaultNetDays) : null,
    scopeFlags,
    billableMinutes,
    entryCount,
    periodLabel: getBillingPeriodLabel(period),
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

/**
 * Sequential number for a RETAINER invoice: INV-RET-2026-001.
 *
 * Its own prefix, and scoped to the YEAR rather than the month, because a
 * retainer is not part of any month's batch — it is issued once when a client
 * signs, and reading it as "the third retainer we issued in 2026" is the fact
 * that matters. The separate prefix is also what keeps the two sequences from
 * ever colliding: `nextInvoiceNumber`'s prefix is `INV-<period>-`, which no
 * `INV-RET-` number can start with, and vice versa.
 *
 * Derived from what already exists, exactly like the monthly counter — there is
 * no counter table to fall out of step with the rows.
 */
export function nextRetainerInvoiceNumber(year, takenNumbers = []) {
  const prefix = `INV-RET-${year}-`
  let highest = 0
  for (const number of takenNumbers) {
    if (typeof number !== 'string' || !number.startsWith(prefix)) continue
    const parsed = Number(number.slice(prefix.length))
    if (Number.isFinite(parsed) && parsed > highest) highest = parsed
  }
  return `${prefix}${String(highest + 1).padStart(3, '0')}`
}
