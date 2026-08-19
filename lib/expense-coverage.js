/**
 * Covered-date windows for recurring reimbursements — the wording that has to
 * say a different fortnight-and-a-bit every time it prints.
 *
 * THE PROBLEM THIS SOLVES. A reimbursed expense (the QBO subscription is the
 * example that produced this) runs on its own cycle — the 13th of one month to
 * the 13th of the next — and the invoice line has to name that window. Retyping
 * it every cycle is the whole of the chore: the wording never changes, only the
 * two dates inside it do. So the wording is configured ONCE, with placeholders,
 * and the window walks forward on its own.
 *
 * EVERYTHING HERE IS PURE. No clock, no I/O — a period is handed in and a range
 * comes back. That is what lets `buildInvoiceLines` show the owner the same
 * window on a preview that the month run will persist, without a preview being
 * able to advance anything.
 *
 * WHAT DRIVES THE ADVANCE. Invoice GENERATION, never a clock. The store writes
 * the resolved window into the expense's own ledger keyed by billing period, and
 * this module reads that ledger first — so re-running a month, or voiding it and
 * regenerating, resolves to the range that month already had. The advance is
 * idempotent per (expense, period) because the answer is stored, not recomputed.
 *
 * WHAT IT REFUSES TO GUESS. If the period being generated is not the one that
 * should follow the last one billed — a skipped cycle, or an expense that was
 * paused and resumed — it proposes ONE step forward and flags the line as
 * needing confirmation rather than striding across the gap. The owner decided
 * that: a silent multi-month jump is how a client gets billed for a window
 * nobody checked.
 */

import { shiftPeriod } from './periods.js'

const pad = (n) => String(n).padStart(2, '0')

/** Placeholders a verbiage template may use. Shown in the setup UI's hint. */
export const COVERAGE_PLACEHOLDERS = ['{range}', '{start}', '{end}', '{description}']

/**
 * What a newly configured expense gets when the owner does not write her own.
 * `{range}` rather than `{start}`–`{end}` because the collapsed form is what
 * reads well on an invoice: "July 13 – August 13, 2026", one year, one dash.
 */
export const DEFAULT_COVERAGE_TEMPLATE = '{description} — {range}'

/** How many months one billing cycle of each frequency covers. */
export function coverageStepMonths(frequency) {
  if (frequency === 'quarterly') return 3
  if (frequency === 'annually') return 12
  return 1
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE.test(value)
}

/** Last calendar day of a month, 1-indexed month. */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Shift a yyyy-mm-dd date by whole months, clamping into short ones:
 * 2026-01-31 +1 month is 2026-02-28, not the 3rd of March.
 */
export function addMonthsClamped(iso, months) {
  if (!isIsoDate(iso)) return null
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  const day = Number(iso.slice(8, 10))
  const index = year * 12 + (month - 1) + Math.trunc(months)
  const targetYear = Math.floor(index / 12)
  const targetMonth = (index % 12) + 1
  const clamped = Math.min(day, lastDayOfMonth(targetYear, targetMonth))
  return `${targetYear}-${pad(targetMonth)}-${pad(clamped)}`
}

/**
 * Put a date on a given day-of-month, clamping into short months. This is what
 * makes the cycle ANCHORED rather than drifting: a window that clamped to the
 * 28th in February must come back to the 31st in March, not stay on the 28th
 * forever. For the 13th-to-13th case it changes nothing, which is the point.
 */
export function withDayClamped(iso, day) {
  if (!isIsoDate(iso)) return null
  const anchor = Math.trunc(Number(day))
  if (!Number.isFinite(anchor) || anchor < 1 || anchor > 31) return iso
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  return `${year}-${pad(month)}-${pad(Math.min(anchor, lastDayOfMonth(year, month)))}`
}

/**
 * The window after this one. The last END becomes the new START — the windows
 * touch, because a subscription billed to the 13th resumes on the 13th and a
 * gap or an overlap between two invoices is a question from the client.
 *
 * `anchorDay` restores the day the cycle turns on after a short month clamped
 * it; absent, the end simply follows the start.
 */
export function nextCoverageRange(range, { months = 1, anchorDay = null } = {}) {
  if (!range || !isIsoDate(range.end)) return null
  const start = range.end
  const stepped = addMonthsClamped(start, months)
  if (!stepped) return null
  return { start, end: anchorDay ? withDayClamped(stepped, anchorDay) : stepped }
}

/* -------------------------------------------------------------------------- */
/* Formatting — American English, always                                      */
/* -------------------------------------------------------------------------- */

// Noon local, the same dodge the reimbursement and ad hoc date labels use, so a
// yyyy-mm-dd never lands on the previous day in a western timezone.
const asDate = (iso) => new Date(`${iso}T12:00:00`)

const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' })

/** "2026-07-13" -> "July 13, 2026". */
export function formatCoverageDate(iso) {
  if (!isIsoDate(iso)) return String(iso ?? '')
  const parsed = asDate(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return MONTH_DAY_YEAR.format(parsed)
}

/**
 * The window as one phrase: "July 13 – August 13, 2026". The year is printed
 * once when both ends share it and on both when they do not — "December 13,
 * 2026 – January 13, 2027" is a sentence a client can check, and dropping the
 * first year there would make it ambiguous.
 */
export function formatCoverageRange(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end)) {
    return [start, end].filter(Boolean).join(' – ')
  }
  const from = asDate(start)
  const to = asDate(end)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return `${start} – ${end}`
  }
  if (start.slice(0, 4) === end.slice(0, 4)) {
    return `${MONTH_DAY.format(from)} – ${MONTH_DAY_YEAR.format(to)}`
  }
  return `${MONTH_DAY_YEAR.format(from)} – ${MONTH_DAY_YEAR.format(to)}`
}

/**
 * Put this cycle's dates into the owner's saved wording.
 *
 * `{start}` and `{end}` are always FULL dates ("July 13, 2026"), so a template
 * that uses only one of them still says which year. `{range}` is the collapsed
 * phrase above, and is what the default template uses.
 *
 * One pass, so a formatted date containing a brace could never be re-scanned.
 */
export function applyCoverageTemplate(template, { start, end, description = '' } = {}) {
  const text = String(template ?? '')
  if (!text) return ''
  return text.replace(/\{(range|start|end|description)\}/g, (_, key) => {
    if (key === 'range') return formatCoverageRange(start, end)
    if (key === 'start') return formatCoverageDate(start)
    if (key === 'end') return formatCoverageDate(end)
    return String(description ?? '')
  })
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/** Is this expense configured to carry a covered-date window at all? */
export function hasCoverage(expense) {
  return Boolean(
    expense?.coverageEnabled &&
      isIsoDate(expense?.coverageStart) &&
      isIsoDate(expense?.coverageEnd),
  )
}

/** The ledger as a plain object, whatever shape it arrived in. */
function ledgerOf(expense) {
  const raw = expense?.coverageHistory
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

const isPeriod = (value) => /^\d{4}-\d{2}$/.test(String(value))

/**
 * The day of the month this expense's cycle turns on.
 *
 * STORED, not re-derived from the seed window. Deriving it meant a window the
 * owner had CONFIRMED onto a different day snapped back on the next advance —
 * she moves an end from the 13th to the 20th, and the cycle after it proposes
 * the 13th again, quietly billing a 23-day period at the full monthly price.
 * The stored day is updated when she moves the end; the seed is only the
 * fallback for a row written before the column existed.
 */
export function anchorDayOf(expense) {
  const stored = Number(expense?.coverageAnchorDay)
  if (Number.isInteger(stored) && stored >= 1 && stored <= 31) return stored
  return isIsoDate(expense?.coverageEnd) ? Number(expense.coverageEnd.slice(8, 10)) : null
}

/** The anchor a confirmed window implies — the day its END lands on. */
export function anchorDayFromRange(end) {
  return isIsoDate(end) ? Number(end.slice(8, 10)) : null
}

/** The latest billed period strictly before `period`, or null. */
function lastBilledPeriodBefore(ledger, period) {
  let latest = null
  for (const key of Object.keys(ledger)) {
    if (!isPeriod(key) || key >= period) continue
    if (latest === null || key > latest) latest = key
  }
  return latest
}

/**
 * What window does this expense cover on this billing period?
 *
 * Returns null when the expense carries no coverage configuration — the caller
 * then bills it exactly as it did before this feature existed.
 *
 * Otherwise `{ start, end, needsConfirmation, reason, source }`:
 *   - source 'ledger'  — this period was already resolved; the stored answer is
 *     handed back verbatim. THIS is what makes regeneration idempotent.
 *   - source 'seed'    — nothing billed yet, so the range the owner typed at
 *     setup is the first one. Never needs confirming; she just entered it.
 *   - source 'advance' — stepped forward from the last billed window.
 *
 * `reason` names why confirmation is wanted: 'gap' (the period being billed is
 * not the one that follows the last) or 'resumed' (the expense was paused and
 * has been switched back on). Null when the line is hands-off.
 */
export function resolveCoverageForPeriod(expense, period) {
  if (!hasCoverage(expense) || !isPeriod(period)) return null

  const ledger = ledgerOf(expense)
  const recorded = ledger[period]
  if (recorded && isIsoDate(recorded.start) && isIsoDate(recorded.end)) {
    return {
      start: recorded.start,
      end: recorded.end,
      needsConfirmation: Boolean(recorded.needsConfirmation),
      reason: recorded.needsConfirmation ? (recorded.reason ?? 'gap') : null,
      source: 'ledger',
    }
  }

  const previous = lastBilledPeriodBefore(ledger, period)
  // A period the ledger already has an ANSWER AFTER. Generating January when
  // March has billed is a backfill, and the window for it cannot be reasoned
  // forward from anything — the cycle has already moved past it. Proposed, and
  // asked about, rather than assumed.
  const backfill = Object.keys(ledger).some((key) => isPeriod(key) && key > period)

  if (previous === null) {
    return {
      start: expense.coverageStart,
      end: expense.coverageEnd,
      needsConfirmation: backfill,
      reason: backfill ? 'backfill' : null,
      source: 'seed',
    }
  }

  const months = coverageStepMonths(expense.frequency)
  const last = ledger[previous]
  const advanced = nextCoverageRange(last, { months, anchorDay: anchorDayOf(expense) })
  if (!advanced) return null

  // The period this expense SHOULD be billing next. Anything else means a cycle
  // went by unbilled, and the window proposed below is one step — not the leap
  // that would silently cover months nobody looked at.
  const expected = shiftPeriod('month', previous, months)
  const gapped = period !== expected
  const resumed = Boolean(expense.coverageResumePending)

  return {
    ...advanced,
    needsConfirmation: gapped || resumed || backfill,
    // Ordered most-specific-first. A pause OUTRANKS the gap it caused, because
    // the two are almost always the same event seen twice: pausing an expense is
    // precisely how months go by unbilled, and telling her "a billing cycle was
    // skipped" about a pause she made on purpose reads as a fault report for
    // something she did deliberately. A backfill likewise implies a gap, and is
    // the more useful half of the pair to say out loud.
    reason: resumed ? 'resumed' : backfill ? 'backfill' : gapped ? 'gap' : null,
    source: 'advance',
  }
}

/**
 * The finished invoice line text for one expense on one period, or null when
 * the expense has no coverage configured.
 *
 * Shared by the preview (`getInvoice`) and the month run so the wording the
 * owner reads before generating is the wording that gets stored.
 */
export function coverageLineLabel(expense, coverage) {
  // No expense means no wording to render. The default template leads with
  // `{description}`, so building one anyway would title the line "— August 13 –
  // September 13, 2026" — a dangling dash where the expense used to be.
  if (!coverage || !expense) return null
  const template = String(expense?.coverageTemplate ?? '').trim() || DEFAULT_COVERAGE_TEMPLATE
  const text = applyCoverageTemplate(template, {
    start: coverage.start,
    end: coverage.end,
    description: expense?.description ?? '',
  }).trim()
  return text || null
}

/** Does this invoice carry a covered-date window the owner has not confirmed? */
export function hasUnconfirmedCoverage(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : []).some(
    (line) => line?.kind === 'recurring' && Boolean(line?.needsCoverageConfirmation),
  )
}

/** Why the owner is being asked, in her words. */
export function coverageConfirmationPrompt(reason) {
  if (reason === 'resumed') {
    return 'This expense was paused. Confirm the dates this invoice covers.'
  }
  if (reason === 'backfill') {
    return 'This month comes before one already billed. Confirm the dates this invoice covers.'
  }
  return 'A billing cycle was skipped. Confirm the dates this invoice covers.'
}

/**
 * The shared normalizer for a stored recurring reimbursement.
 *
 * ONE definition of the shape, read by the Postgres row mapper AND by the file
 * backend's reads, because cardinal rule 1 bites hardest exactly here: a row
 * written before this feature existed has no coverage fields at all, and the
 * two backends were filling that absence differently — Postgres through its
 * mapper's defaults, the file backend not at all. The resolver then saw
 * `coverageHistory: undefined` on one and `{}` on the other.
 */
export function normalizeRecurringReimbursement(record) {
  if (!record || typeof record !== 'object') return record
  const history =
    record.coverageHistory && typeof record.coverageHistory === 'object' &&
    !Array.isArray(record.coverageHistory)
      ? record.coverageHistory
      : {}
  const anchor = Number(record.coverageAnchorDay)
  return {
    ...record,
    coverageEnabled: Boolean(record.coverageEnabled),
    coverageTemplate: record.coverageTemplate ?? '',
    coverageStart: isIsoDate(record.coverageStart) ? record.coverageStart : null,
    coverageEnd: isIsoDate(record.coverageEnd) ? record.coverageEnd : null,
    coverageAnchorDay:
      Number.isInteger(anchor) && anchor >= 1 && anchor <= 31 ? anchor : null,
    coveragePaused: Boolean(record.coveragePaused),
    coverageResumePending: Boolean(record.coverageResumePending),
    coverageHistory: history,
  }
}
