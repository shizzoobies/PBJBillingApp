/**
 * The period a recurring task's work COVERS — "July 2026" on a task due in
 * August — as a pure, side-effect-free calculation.
 *
 * Brittany, featreq-81429ad1: *"I need a time period area - like the period the
 * task is due for so you can keep it straight, but not all checklist/task would
 * have it and then the next would spring forward."* Asked which shape she meant,
 * she answered:
 *
 *   1. - next to the title
 *   2. purely a label not to change anything we have already done
 *
 * BOTH HALVES OF THAT ARE LOAD-BEARING, and the second one is a constraint on
 * the whole feature: this label is COSMETIC. It is never a filter, never a
 * billing month, never an input to a report, a total, a due date or a sort. It
 * is a string rendered beside a title. Anything that reads it to make a decision
 * is a bug, and `checklist-period-label.test.mjs` pins that the label never
 * reaches the due date it was derived from.
 *
 * "The next would spring forward" needs no machinery of its own: the label is
 * derived from the INSTANCE's own due date, so when the materializer creates
 * next cycle's instance with a later due date, the label advances by itself.
 * There is no counter to keep in sync and nothing to migrate.
 */

const MONTH_NAMES = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
])

/**
 * How wide a period the label names, taken from the template's OWN frequency
 * rather than a second setting she would have to keep in step with it.
 *
 * Daily and weekly fall to the month deliberately: "the week of Aug 3" is a due
 * date, not a period of books, and she asked for the period the work covers.
 */
export function periodGrainForFrequency(frequency) {
  if (frequency === 'quarterly') return 'quarter'
  if (frequency === 'annually') return 'year'
  return 'month'
}

/**
 * How many whole periods BACK from the due date the covered period sits.
 *
 * 1 is the default because that is the bookkeeping case: July's books are done
 * in August. 0 means the task covers the period it falls in. Clamped to 0..24 —
 * a negative offset would name a period that has not happened yet, and beyond
 * two years the label stops being a memory aid.
 */
export function normalizePeriodLabelOffset(value) {
  const offset = Number(value)
  if (!Number.isFinite(offset)) return 1
  return Math.min(24, Math.max(0, Math.round(offset)))
}

/**
 * The label for one instance, or null when there is nothing honest to say.
 *
 * Null rather than a placeholder: "not all checklist/task would have it", so an
 * absent label has to render as nothing at all, not as an empty chip.
 */
export function periodLabelFor(dueDate, frequency, offset = 1) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate ?? ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return null

  const back = normalizePeriodLabelOffset(offset)
  const grain = periodGrainForFrequency(frequency)

  if (grain === 'year') return String(year - back)

  if (grain === 'quarter') {
    const quarterIndex = Math.floor((month - 1) / 3) // 0..3
    const absolute = year * 4 + quarterIndex - back
    return `Q${(absolute % 4) + 1} ${Math.floor(absolute / 4)}`
  }

  // Months, counted absolutely so the year rolls over on its own.
  const absolute = year * 12 + (month - 1) - back
  return `${MONTH_NAMES[absolute % 12]} ${Math.floor(absolute / 12)}`
}

/**
 * The label to store on a newly materialized instance: the template's setting
 * applied to the instance's due date, or null when the template does not carry
 * one.
 *
 * Kept as its own function so the store has exactly one thing to call and the
 * "is it switched on" question is answered in one place.
 */
export function periodLabelForInstance(template, dueDate) {
  if (!template || template.periodLabelEnabled !== true) return null
  return periodLabelFor(dueDate, template.frequency, template.periodLabelOffset)
}

/** Trim and cap a hand-typed label; empty becomes null, never ''. */
export function sanitizePeriodLabel(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, 60)
  return trimmed === '' ? null : trimmed
}
