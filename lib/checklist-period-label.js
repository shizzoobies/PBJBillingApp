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

/** Whole months between two ISO dates, by calendar month rather than by days. */
function monthsBetween(fromIso, toIso) {
  const from = { y: Number(fromIso.slice(0, 4)), m: Number(fromIso.slice(5, 7)) }
  const to = { y: Number(toIso.slice(0, 4)), m: Number(toIso.slice(5, 7)) }
  return (to.y - from.y) * 12 + (to.m - from.m)
}

/**
 * How many whole recurrence steps this instance sits after the one she set the
 * window for.
 *
 * Clamped at zero, and capped: an instance due BEFORE the anchor shows the
 * window she typed rather than one invented by stepping backwards through dates
 * she never saw, and a template whose anchor is years stale cannot spin this
 * into thousands of iterations.
 */
export function coverageStepsBetween(anchorDue, dueDate, frequency) {
  if (!isIsoDate(anchorDue) || !isIsoDate(dueDate)) return 0
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

  const anchor = isIsoDate(template.periodCoverageAnchorDue)
    ? template.periodCoverageAnchorDue
    : dueDate
  const steps = coverageStepsBetween(anchor, dueDate, template.frequency)
  if (steps === 0) return { start, end }

  const months = coverageStepMonths(template.frequency)
  const anchorDay = anchorDayFromRange(end)
  let window = { start, end }
  for (let i = 0; i < steps; i += 1) {
    const advanced = nextCoverageRange(window, { months, anchorDay })
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
