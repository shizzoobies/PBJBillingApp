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
  addMonthsClamped,
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

const DAY_MS = 86_400_000

/** A yyyy-mm-dd date as a whole number of days, so two of them subtract cleanly. */
function dayNumber(iso) {
  return Math.round(
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS,
  )
}

/** The date `days` after (or before) a yyyy-mm-dd date. */
function shiftDays(iso, days) {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10)
}

/** How many days one cycle is, for the two frequencies that repeat by the week. */
function cycleDaysOf(frequency) {
  if (frequency === 'weekly') return 7
  if (frequency === 'biweekly') return 14
  return null
}

/**
 * The cycle length in days when this recipe's window moves BY THE WEEK, else null.
 *
 * featreq-6678d532. Payroll runs weekly or every two weeks and its window is the
 * pay period: "August 30 - September 5". Those recipes used to move a month at a
 * time on the reimbursement step, which starts each window on the last one's end
 * and makes it a month long - production read "October 5 - November 5" on a
 * one-week window. A pay period moves by the days between two due dates and
 * keeps its length.
 *
 * A weekly task whose window is a month or longer ("August 1 - August 31") is a
 * different thing and stays on the month step below: every occurrence inside a
 * month names that month. Under four weeks is what tells the two apart.
 */
function weekCycleDays(template) {
  const days = cycleDaysOf(template?.frequency)
  if (!days) return null
  const start = template?.periodCoverageStart
  const end = template?.periodCoverageEnd
  if (!isIsoDate(start) || !isIsoDate(end)) return null
  return dayNumber(end) - dayNumber(start) + 1 < 28 ? days : null
}

/**
 * Whole cycles between the anchor and this occurrence, for a by-the-week recipe.
 *
 * Rounded to the nearest cycle, not floored: a step that is due a day or two
 * off the recipe's own date still belongs to that cycle. May be negative - the
 * callers decide what an occurrence before the anchor means.
 */
function weekCyclesBetween(anchorIso, dueIso, cycleDays) {
  return Math.round((dayNumber(dueIso) - dayNumber(anchorIso)) / cycleDays)
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

const dayOf = (iso) => Number(iso.slice(8, 10))

const isLastDayOfItsMonth = (iso) =>
  dayOf(iso) === lastDayOfMonth(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)))

/**
 * Does this end of a window mean "the END of the month", rather than a day
 * number that happens to fall there?
 *
 * "January 15 - February 28" ends at the end of February, so a month on it ends
 * March 31. But "September 30 - October 30" turns on the 30th and "January 28 -
 * February 28" on the 28th: the other end says so, by carrying the same day
 * number in a month where it is NOT the last day. Reading those as month ends
 * made a 30th-to-30th window come back 31 days long.
 */
function meansMonthEnd(iso, otherEnd) {
  if (!isLastDayOfItsMonth(iso)) return false
  return !(dayOf(otherEnd) === dayOf(iso) && !isLastDayOfItsMonth(otherEnd))
}

/**
 * One end of a window, moved by whole calendar months from the day she typed.
 * A month end stays a month end; any other day keeps its day, clamped into a
 * short month.
 */
function shiftMonthsKeepingMonthEnd(iso, months, monthEnd) {
  const moved = addMonthsClamped(iso, months)
  if (!moved || !monthEnd) return moved
  const year = Number(moved.slice(0, 4))
  const month = Number(moved.slice(5, 7))
  return `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`
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
 * SPECIFIC-MONTHS recipes are counted in CALENDAR MONTHS (featreq-6678d532).
 * They were counted in occurrences for a while, and production showed why that
 * is wrong for every schedule she uses: the reconciliations that skip the
 * quarter months (Feb, Mar, May, Jun, Aug, Sep, Nov, Dec) read "September" on
 * the November checklist - September to November is one run, and two months -
 * and the quarterly ones (Jan, Apr, Jul, Oct) would have moved a three-month
 * window on by one month each quarter. The work a checklist covers is set by
 * the calendar: the November one covers October whether or not there was an
 * October one. The window keeps the length she typed either way.
 *
 * WEEKLY AND BIWEEKLY with a window under four weeks count whole cycles of
 * days - see `weekCycleDays`. With a month-long window they stay on calendar
 * months, which is what `coverageStepMonths` gives them: every occurrence
 * inside a month reads that month's window and it turns over when the month does.
 */
export function coverageStepsBetween(anchorDue, dueDate, frequency, template = null) {
  if (!isIsoDate(anchorDue) || !isIsoDate(dueDate)) return 0
  if (frequency === 'specific-months') {
    // No designated months - a recipe that never runs. The window she typed
    // simply stands rather than marching forward on its own.
    if (scheduledMonthsOf(template).length === 0) return 0
    return Math.min(600, Math.max(0, monthsBetween(anchorDue, dueDate)))
  }
  const cycleDays = weekCycleDays(template ? { ...template, frequency } : null)
  if (cycleDays) {
    return Math.min(600, Math.max(0, weekCyclesBetween(anchorDue, dueDate, cycleDays)))
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

  // By the week: both ends move by the same number of days, so a Sunday to
  // Saturday pay period stays Sunday to Saturday.
  const cycleDays = weekCycleDays(template)
  if (cycleDays) {
    return { start: shiftDays(start, steps * cycleDays), end: shiftDays(end, steps * cycleDays) }
  }

  // Chosen months, with a window that is not whole months ("July 13 - October
  // 13"): both ends move by the calendar months that passed, each from the day
  // she typed, so the window keeps its length. The reimbursement step below
  // would restart it at one month long after the first move.
  if (isSpecificMonths(template) && !isWholeMonthWindow(start, end)) {
    const movedStart = shiftMonthsKeepingMonthEnd(start, steps, meansMonthEnd(start, end))
    const movedEnd = shiftMonthsKeepingMonthEnd(end, steps, meansMonthEnd(end, start))
    return movedStart && movedEnd ? { start: movedStart, end: movedEnd } : { start, end }
  }

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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * How a checklist is named by its month in a sentence: its own period label when
 * it has one ("October 13 - November 13, 2026"), else the month of the occurrence
 * it belongs to ("November 2026", from `cycleDueDate`, else `dueDate`). Null when
 * it has neither. Used by the "Kept on ..." notice and the activity log, so the
 * client and the server name a checklist the same way.
 *
 * @param {{ periodLabel?: string | null, cycleDueDate?: string | null, dueDate?: string | null } | null | undefined} checklist
 * @returns {string | null}
 */
export function checklistMonthLabel(checklist) {
  const own = typeof checklist?.periodLabel === 'string' ? checklist.periodLabel.replace(/\s+/g, ' ').trim() : ''
  if (own) return own
  const due = checklist?.cycleDueDate || checklist?.dueDate
  const match = typeof due === 'string' ? /^(\d{4})-(\d{2})-\d{2}/.exec(due) : null
  const month = match ? Number(match[2]) : 0
  return month >= 1 && month <= 12 ? `${MONTH_NAMES[month - 1]} ${match[1]}` : null
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

/**
 * Is this occurrence EARLIER than the one the window was set for?
 *
 * Such a checklist belongs to a cycle she was not describing when she typed the
 * dates, so the re-stamp leaves its label alone. By month for the recipes that
 * move by months (two steps of one occurrence can be due in the same month on
 * either side of the anchor's day), by whole cycles for the by-the-week ones.
 */
export function occurrenceBeforeAnchor(template, occurrence) {
  const anchor = template?.periodCoverageAnchorDue
  if (!isIsoDate(anchor) || !isIsoDate(occurrence)) return false
  const cycleDays = weekCycleDays(template)
  if (cycleDays) return weekCyclesBetween(anchor, occurrence, cycleDays) < 0
  return occurrence.slice(0, 7) < anchor.slice(0, 7)
}

/**
 * The date a checklist's covered dates are counted from: the date it was FIRST
 * due. A checklist pushed to a later date keeps the period it was for, so the
 * cycle date wins over the working due date.
 */
export function occurrenceDateOf(checklist) {
  const cycle = checklist?.cycleDueDate
  if (isIsoDate(cycle)) return cycle
  const due = checklist?.dueDate
  return isIsoDate(due) ? due : null
}

/** The case a checklist belongs to. Case ids are shared across clients in old data, so the client is part of it. */
export function caseOccurrenceKey(checklist) {
  const caseId = checklist?.caseId || checklist?.id || ''
  return `${checklist?.clientId ?? ''}|${caseId}`
}

/**
 * One date per case: the occurrence of the case's FIRST step.
 *
 * Every step of a case covers the same period. Later steps are due later -
 * sometimes in another month - and counting each from its own due date gave one
 * case two different labels (a quarterly case read "July 1 - September 30" on
 * step 1 and "December 1 - December 31" on steps 2 to 6). So the whole case is
 * counted from where it started. Pass the binned steps too: a first step that
 * was deleted still says when the case began.
 *
 * @param {Array<{ id?: string, caseId?: string, clientId?: string, stageIndex?: number, dueDate?: string, cycleDueDate?: string | null }>} checklists
 * @returns {Map<string, string>} case key -> yyyy-mm-dd
 */
export function caseOccurrences(checklists) {
  const best = new Map()
  for (const checklist of Array.isArray(checklists) ? checklists : []) {
    if (!checklist) continue
    const occurrence = occurrenceDateOf(checklist)
    if (!occurrence) continue
    const key = caseOccurrenceKey(checklist)
    const stageIndex = typeof checklist.stageIndex === 'number' ? checklist.stageIndex : 0
    const held = best.get(key)
    if (
      !held ||
      stageIndex < held.stageIndex ||
      (stageIndex === held.stageIndex && occurrence < held.occurrence)
    ) {
      best.set(key, { stageIndex, occurrence })
    }
  }
  return new Map([...best].map(([key, value]) => [key, value.occurrence]))
}

/**
 * The covered dates a NEW step of a case is born with.
 *
 * Dates set by hand on the case travel with it: a step that opens later carries
 * the same hand-set dates, marked the same way, so the correction does not have
 * to be made again on every step. Otherwise the step reads what the recipe
 * gives the case's first step.
 *
 * One exception: a case that began BEFORE the occurrence the recipe's dates
 * were set for. The recipe's dates do not describe it (working them out would
 * hand it the anchor's own window, a period too late, and the re-stamp never
 * touches such a case), so a new step reads what the case's earliest step
 * already says. One case, one period, even there.
 *
 * @param {object | null | undefined} template
 * @param {Array<object>} caseSteps the steps of this case that already exist
 * @returns {{ periodLabel: string | null, periodLabelManual: boolean }}
 */
export function periodLabelForCaseStep(template, caseSteps) {
  const steps = (Array.isArray(caseSteps) ? caseSteps : []).filter(Boolean)
  const byHand = steps
    .filter((step) => step.periodLabelManual === true && sanitizePeriodLabel(step.periodLabel))
    .sort((a, b) => (b.stageIndex ?? 0) - (a.stageIndex ?? 0))[0]
  if (byHand) {
    return { periodLabel: sanitizePeriodLabel(byHand.periodLabel), periodLabelManual: true }
  }
  const occurrence = [...caseOccurrences(steps).values()][0] ?? null
  if (occurrence && template?.periodLabelEnabled === true && occurrenceBeforeAnchor(template, occurrence)) {
    const said = [...steps]
      .sort((a, b) => (a.stageIndex ?? 0) - (b.stageIndex ?? 0))
      .map((step) => sanitizePeriodLabel(step.periodLabel))
      .find(Boolean)
    if (said) return { periodLabel: said, periodLabelManual: false }
  }
  return {
    periodLabel: occurrence ? periodLabelForInstance(template, occurrence) : null,
    periodLabelManual: false,
  }
}

/**
 * The occurrence the dates on a recipe are FOR, when she looks at the recipe.
 *
 * featreq-6678d532. Typing dates on a recipe used to attach them to the recipe's
 * NEXT due date - but the checklist she is correcting is the one already open,
 * which is the occurrence before that. So the correction skipped the checklist
 * in front of her and landed a month off on the one after. The dates now belong
 * to the EARLIEST checklist of the recipe that is still open, and every later
 * one steps on from it; with nothing open they belong to the next occurrence, as
 * before.
 *
 * @param {object | null | undefined} template
 * @param {string[]} openOccurrences occurrence dates of the recipe's open cases
 * @param {string} todayIso
 * @returns {{ date: string | null, open: boolean }}
 */
export function coverageReference(template, openOccurrences, todayIso) {
  const open = (Array.isArray(openOccurrences) ? openOccurrences : []).filter(isIsoDate).sort()
  if (open.length > 0) return { date: open[0], open: true }
  return { date: coverageAnchorForTemplate(template, todayIso), open: false }
}

/**
 * The occurrence dates of a recipe's OPEN cases - what `coverageReference` picks from.
 *
 * A case is open while any live step of it still has work: not finished, not
 * skipped, not the done-only record a push leaves behind. A case whose dates
 * were set by hand is left out: the recipe's dates are not what it shows.
 * `isFinished` is the caller's own "every step done" test, so the browser and
 * the server each use the one they already have.
 *
 * @param {string} templateId
 * @param {Array<object>} liveChecklists
 * @param {Array<object>} binnedChecklists
 * @param {(checklist: object) => boolean} isFinished
 * @returns {string[]} yyyy-mm-dd, ascending, no repeats
 */
export function openCaseOccurrences(templateId, liveChecklists, binnedChecklists, isFinished) {
  return [
    ...new Set(
      openCases(templateId, liveChecklists, binnedChecklists, isFinished).map((entry) => entry.occurrence),
    ),
  ]
}

/**
 * The same open cases with the label each one SHOWS: `{ occurrence, periodLabel }`,
 * earliest first. The label is that of the case's earliest open step - what the
 * card in front of her says. The recipe editor needs it for a checklist the
 * recipe's dates do not govern (one due before the anchor): there the only
 * honest answer to "what does this checklist cover" is what it says itself.
 */
export function openCases(templateId, liveChecklists, binnedChecklists, isFinished) {
  const ofRecipe = (checklist) => Boolean(checklist) && checklist.templateId === templateId
  const live = (Array.isArray(liveChecklists) ? liveChecklists : []).filter(ofRecipe)
  const binned = (Array.isArray(binnedChecklists) ? binnedChecklists : []).filter(ofRecipe)
  const occurrences = caseOccurrences([...live, ...binned])
  const byHand = new Set(
    [...live, ...binned]
      .filter((checklist) => checklist.periodLabelManual === true)
      .map((checklist) => caseOccurrenceKey(checklist)),
  )
  const open = new Map()
  for (const checklist of live) {
    if (checklist.deletedAt || checklist.skippedAt || checklist.projected) continue
    if (checklist.pushedToChecklistId) continue
    if (isFinished(checklist)) continue
    const key = caseOccurrenceKey(checklist)
    if (byHand.has(key)) continue
    const occurrence = occurrences.get(key)
    if (!occurrence) continue
    const stageIndex = typeof checklist.stageIndex === 'number' ? checklist.stageIndex : 0
    const held = open.get(key)
    if (!held || stageIndex < held.stageIndex) {
      open.set(key, { occurrence, stageIndex, periodLabel: sanitizePeriodLabel(checklist.periodLabel) })
    }
  }
  return [...open.values()]
    .map(({ occurrence, periodLabel }) => ({ occurrence, periodLabel }))
    .sort((a, b) => (a.occurrence < b.occurrence ? -1 : a.occurrence > b.occurrence ? 1 : 0))
}

const MONTH_NUMBER = new Map(MONTH_NAMES.map((name, index) => [name, index + 1]))

function isoFromParts(monthName, day, year) {
  const month = MONTH_NUMBER.get(monthName)
  if (!month) return null
  return `${year}-${pad(month)}-${pad(Number(day))}`
}

/**
 * The two dates behind a label this app wrote - "July 13 - August 13, 2026"
 * back to `{ start, end }` - or null.
 *
 * A checklist stores its covered dates as the finished phrase, not as two
 * dates, so the editor that changes them has to read the phrase back. Only a
 * phrase that formats to EXACTLY itself is accepted: anything else (an old
 * hand-typed label, a phrase in another shape) is null and the editor opens
 * empty rather than guessing.
 */
export function coverageDatesFromLabel(label) {
  const text = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  const sameYear = /^([A-Z][a-z]+) (\d{1,2}) – ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text)
  const twoYears = /^([A-Z][a-z]+) (\d{1,2}), (\d{4}) – ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text)
  let start = null
  let end = null
  if (sameYear) {
    start = isoFromParts(sameYear[1], sameYear[2], sameYear[5])
    end = isoFromParts(sameYear[3], sameYear[4], sameYear[5])
  } else if (twoYears) {
    start = isoFromParts(twoYears[1], twoYears[2], twoYears[3])
    end = isoFromParts(twoYears[4], twoYears[5], twoYears[6])
  }
  if (!start || !end) return null
  return formatCoverageRange(start, end) === text ? { start, end } : null
}

/**
 * The label for dates set by hand on one checklist, or null when the two dates
 * are not a real window (both real dates, the first on or before the second).
 */
export function periodLabelFromDates(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) return null
  // A date that is not on the calendar (February 30) is refused, not rolled over.
  if (shiftDays(start, 0) !== start || shiftDays(end, 0) !== end) return null
  return sanitizePeriodLabel(formatCoverageRange(start, end))
}
