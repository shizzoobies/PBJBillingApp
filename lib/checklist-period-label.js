/**
 * The period a recurring task's work COVERS — shown beside its title.
 *
 * featreq-81429ad1. Brittany asked for it, then sent the first version back:
 *
 *   "The period covers should allow me to pick dates and then the how often
 *   should determine the next period"
 *
 * The first version made her pick an OFFSET ("the period before it is due").
 * She wants to pick the WINDOW — actual dates — and have the task's own
 * recurrence carry it forward. That is precisely the interaction she already
 * uses and approved on reimbursed expenses (featreq-fe3f8b0f): set the first
 * window once, and every cycle after it advances on its own.
 *
 * So this does not invent a second way of doing it. It calls the SAME functions
 * that move a reimbursement's covered dates — `nextCoverageRange`,
 * `coverageStepMonths`, `formatCoverageRange` — which is what makes a period
 * label read like the covered dates on an invoice rather than like a new idea.
 *
 * STILL PURELY A LABEL. Her earlier constraint has not changed: "purely a label
 * not to change anything we have already done." Nothing here is a due date, a
 * billing month, a filter or a sort. It is a string rendered beside a title, and
 * the tests pin that switching it on changes nothing else about a task.
 *
 * The window is DERIVED, never stored on the template as a moving value: an
 * instance's label is computed from that instance's own due date, so generating
 * the same cycle twice cannot produce two different labels and there is no
 * counter that can drift out of step.
 */

import {
  anchorDayFromRange,
  coverageStepMonths,
  formatCoverageRange,
  isIsoDate,
  nextCoverageRange,
} from './expense-coverage.js'

const pad = (n) => String(n).padStart(2, '0')

/** Last calendar day of a month, 1-indexed month. */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const isSpecificMonths = (template) => template?.frequency === 'specific-months'

/** The designated months of a specific-months recipe: 1-12, deduped, ascending. */
function scheduledMonthsOf(template) {
  const raw = Array.isArray(template?.scheduledMonths) ? template.scheduledMonths : []
  const clean = raw.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
  return [...new Set(clean)].sort((a, b) => a - b)
}

/** Whole months between two ISO dates, by calendar month rather than by days. */
function monthsBetween(fromIso, toIso) {
  const from = { y: Number(fromIso.slice(0, 4)), m: Number(fromIso.slice(5, 7)) }
  const to = { y: Number(toIso.slice(0, 4)), m: Number(toIso.slice(5, 7)) }
  return (to.y - from.y) * 12 + (to.m - from.m)
}

/**
 * Designated occurrences strictly after the anchor's month and on or before the
 * due date's month — the number of times the window has moved on.
 *
 * Counts OCCURRENCES, never calendar months: a recipe that runs in Feb, Mar,
 * May, Jun, Aug, Sep, Nov and Dec moves its window on once per occurrence, so
 * June to September is two moves (August, September) and not the three calendar
 * months that separate them. The year wraps, because a recipe that runs in
 * November and December has to keep counting into January.
 */
function scheduledStepsBetween(anchorIso, dueIso, months) {
  const span = Math.min(monthsBetween(anchorIso, dueIso), 7200)
  if (span <= 0) return 0
  const set = new Set(months)
  const anchorIndex = Number(anchorIso.slice(0, 4)) * 12 + (Number(anchorIso.slice(5, 7)) - 1)
  let steps = 0
  for (let i = 1; i <= span && steps < 600; i += 1) {
    if (set.has(((anchorIndex + i) % 12) + 1)) steps += 1
  }
  return steps
}

/**
 * An anchor a specific-months recipe can actually count from.
 *
 * `nextDueDate` is meaningless for this frequency — the materializer says so
 * itself — so a recipe can end up anchored to a month it never runs in. Counting
 * from that ghost shifts every window after it, so an anchor outside the
 * schedule moves forward to the first month the recipe really runs in.
 */
function snapAnchorToSchedule(template, anchorIso) {
  if (!isSpecificMonths(template) || !isIsoDate(anchorIso)) return anchorIso
  const months = scheduledMonthsOf(template)
  const month = Number(anchorIso.slice(5, 7))
  if (months.length === 0 || months.includes(month)) return anchorIso
  const year = Number(anchorIso.slice(0, 4))
  const later = months.find((m) => m > month)
  return later ? `${year}-${pad(later)}-01` : `${year + 1}-${pad(months[0])}-01`
}

/**
 * Is this window whole calendar months — the 1st through the last day of one?
 *
 * "August 1 – August 31" is a MONTH, and the month after it is September 1 – 30.
 * A reimbursement's window is a different animal: "July 13 – August 13" turns on
 * the 13th, and the next one starts on the day the last one ended, which is
 * right for a subscription and wrong for a month — it walks a whole-month window
 * onto August 31 – September 30, then September 30 – October 31, one day further
 * adrift every cycle. A window that starts mid-month keeps the reimbursement
 * step, unchanged.
 */
function isWholeMonthWindow(start, end) {
  if (start.slice(8, 10) !== '01') return false
  const year = Number(end.slice(0, 4))
  const month = Number(end.slice(5, 7))
  const day = Number(end.slice(8, 10))
  // February typed as the 28th is a whole month too. Without this a window she
  // set in a common year drops off this path the moment a leap year comes
  // round, lands on the end-anchored step, and starts drifting a day a cycle —
  // in 2028 rather than now, which is the worst possible time to find out.
  if (month === 2 && day === 28) return true
  return day === lastDayOfMonth(year, month)
}

/** Months since year 0 — the arithmetic every whole-month step is done in. */
function monthIndex(iso) {
  return Number(iso.slice(0, 4)) * 12 + (Number(iso.slice(5, 7)) - 1)
}

/** `{ y, m }` back out of a month index, as a first-of-month ISO date. */
function firstOfMonth(index) {
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`
}

/** The same index as the LAST day of its month. */
function lastOfMonth(index) {
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`
}

/**
 * The whole-calendar-month window one step on.
 *
 * Both ends move by the SAME step, so the window keeps the length she typed.
 * Sizing the new end off the frequency instead — which is what this did first —
 * quietly rewrote the window itself: a January-to-March window on a recipe that
 * steps a month at a time came back as April alone, and a one-month window on a
 * quarterly recipe came back three months long. The step says WHEN the window
 * moves; only she says HOW LONG it is.
 */
function nextWholeMonthWindow(range, months) {
  const step = Math.max(1, Math.trunc(months))
  const span = Math.max(0, monthsBetween(range.start, range.end))
  const startIndex = monthIndex(range.start) + step
  return { start: firstOfMonth(startIndex), end: lastOfMonth(startIndex + span) }
}

/**
 * How many whole recurrence steps this instance sits after the one she set the
 * window for.
 *
 * Clamped at zero, and capped: an instance due BEFORE the anchor shows the
 * window she typed rather than one invented by stepping backwards through dates
 * she never saw, and a template whose anchor is years stale cannot spin this
 * into thousands of iterations.
 *
 * SPECIFIC-MONTHS recipes are counted in OCCURRENCES — see
 * `scheduledStepsBetween`. `coverageStepMonths` returns 1 for them, which
 * counted the empty calendar months between two designated ones as moves and
 * ran the window months ahead of the task.
 *
 * WEEKLY AND BIWEEKLY stay on calendar months, which is what
 * `coverageStepMonths` already gives them: everything below quarterly is one
 * month per cycle on the reimbursement side, because reimbursements bill
 * monthly. So every occurrence inside a month reads that month's window and it
 * turns over when the month does, rather than racing a month ahead every week —
 * which is the only reading under which a weekly task's label stays a period
 * somebody recognizes.
 */
export function coverageStepsBetween(anchorDue, dueDate, frequency, template = null) {
  if (!isIsoDate(anchorDue) || !isIsoDate(dueDate)) return 0
  if (frequency === 'specific-months') {
    const months = scheduledMonthsOf(template)
    // No designated months — nothing to count occurrences of. Falling through
    // to calendar months would march the window forward on a recipe that never
    // runs at all, so the window she typed simply stands.
    if (months.length === 0) return 0
    return scheduledStepsBetween(anchorDue, dueDate, months)
  }
  const perStep = coverageStepMonths(frequency)
  if (!Number.isFinite(perStep) || perStep <= 0) return 0
  const steps = Math.floor(monthsBetween(anchorDue, dueDate) / perStep)
  return Math.min(600, Math.max(0, steps))
}

/**
 * The window this instance covers, or null when the template carries none.
 *
 * Advanced by repeating `nextCoverageRange` rather than by jumping straight to
 * the answer, so a task's windows land on exactly the dates a reimbursement's
 * would — including the month-end clamping, where "the 31st" becomes the 30th in
 * a short month and then returns.
 */
export function periodWindowFor(template, dueDate) {
  if (!template || template.periodLabelEnabled !== true) return null
  const start = template.periodCoverageStart
  const end = template.periodCoverageEnd
  if (!isIsoDate(start) || !isIsoDate(end)) return null

  const anchor = snapAnchorToSchedule(
    template,
    isIsoDate(template.periodCoverageAnchorDue) ? template.periodCoverageAnchorDue : dueDate,
  )
  const steps = coverageStepsBetween(anchor, dueDate, template.frequency, template)
  if (steps === 0) return { start, end }

  const months = coverageStepMonths(template.frequency)
  const anchorDay = anchorDayFromRange(end)
  // Decided once: a whole-month window stays a whole-month window through every
  // advance, so the shape cannot change halfway down the loop.
  const wholeMonths = isWholeMonthWindow(start, end)
  let window = { start, end }
  for (let i = 0; i < steps; i += 1) {
    const advanced = wholeMonths
      ? nextWholeMonthWindow(window, months)
      : nextCoverageRange(window, { months, anchorDay })
    if (!advanced) return window
    window = advanced
  }
  return window
}

/**
 * The label for one instance — "July 13 – August 13, 2026" — or null.
 *
 * Null rather than a placeholder, because "not all checklist/task would have
 * it": an absent label has to render as nothing at all, not an empty chip.
 */
export function periodLabelForInstance(template, dueDate) {
  const window = periodWindowFor(template, dueDate)
  if (!window) return null
  const text = formatCoverageRange(window.start, window.end)
  return text ? text : null
}

/** Trim and cap a hand-typed label; empty becomes null, never ''. */
export function sanitizePeriodLabel(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, 80)
  return trimmed === '' ? null : trimmed
}

/** An ISO date or null — what the store persists for the three window fields. */
export function sanitizeCoverageDate(value) {
  return isIsoDate(value) ? value : null
}

/**
 * The occurrence a window typed TODAY belongs to — what gets stored as the
 * anchor when she sets the dates.
 *
 * For a specific-months recipe `nextDueDate` is not an occurrence at all: the
 * materializer ignores it and the designated months drive generation instead.
 * Saving it as the anchor is what put "51 Beach Monthly Reconciliations" on
 * October 31 – November 30 when she had typed August — the cycle was counted
 * from a stale June date nothing ever ran on. The anchor is instead the first
 * designated month that has not finished yet: this month when it is one of
 * them, otherwise the next, wrapping into next year. The day is the 1st because
 * only the MONTH decides which occurrence carries the window.
 */
export function coverageAnchorForTemplate(template, todayIso) {
  if (!isSpecificMonths(template)) {
    return isIsoDate(template?.nextDueDate) ? template.nextDueDate : null
  }
  const months = scheduledMonthsOf(template)
  if (!isIsoDate(todayIso) || months.length === 0) return null
  const year = Number(todayIso.slice(0, 4))
  const month = Number(todayIso.slice(5, 7))
  const current = months.find((m) => m >= month)
  return current ? `${year}-${pad(current)}-01` : `${year + 1}-${pad(months[0])}-01`
}
