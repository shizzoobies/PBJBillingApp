/**
 * How often a subscription plan's checklists run (featreq-acdd0c84, stage B1).
 *
 * `subscription_plans.cadence` is nullable on purpose and nothing is written to
 * old plans: when it is NULL the effective cadence is read off the end of the
 * plan's NAME ("Review and Prepare Reports - Quarterly"), and a plan whose name
 * says nothing is 'blueprint' - "use the checklist's own schedule", which is
 * what every plan did before this column existed.
 *
 * ONE list for both backends and the browser, so the vocabulary cannot drift.
 */

/** The values the column accepts (a CHECK constraint says the same on Postgres). */
export const PLAN_CADENCES = ['weekly', 'monthly', 'quarterly', 'annual', 'blueprint']

/** A stored value, or null when it is anything else (a bad payload never throws). */
export function normalizePlanCadence(value) {
  return typeof value === 'string' && PLAN_CADENCES.includes(value) ? value : null
}

const NAME_SUFFIX = /\s[-\u2013\u2014]\s*(weekly|monthly|quarterly|annual|annually|yearly)\s*$/i

/**
 * The cadence a plan's name ends in, or null. " - Yearly" and " - Annually" read as 'annual'.
 * Trailing spaces are ignored; the dash (hyphen, en dash or em dash) must stand alone ("Pre-Weekly" is not a
 * suffix).
 */
export function cadenceFromPlanName(name) {
  const match = NAME_SUFFIX.exec(typeof name === 'string' ? name : '')
  if (!match) return null
  const word = match[1].toLowerCase()
  return word === 'yearly' || word === 'annually' ? 'annual' : word
}

/** stored ?? parsed-from-the-name ?? 'blueprint'. */
export function effectivePlanCadence(plan) {
  return normalizePlanCadence(plan?.cadence) ?? cadenceFromPlanName(plan?.name) ?? 'blueprint'
}

/**
 * The cadence a bulk save writes for a plan, on BOTH backends (the old-bundle
 * preserve rule, the way `preservedStageCategoryId` does it for a step's Board
 * column). A payload plan that carries a valid value sets it; one that OMITS the
 * key, sends null, or sends anything invalid keeps `stored`, the value already
 * saved for that plan id. Clearing back to "read it off the name" is therefore
 * not something the bulk save can do: a tab on a bundle from before this column
 * existed omits the key, and a plan read with no stored value sends null back,
 * so neither may erase a choice somebody made.
 */
export function preservedPlanCadence(plan, stored) {
  return normalizePlanCadence(plan?.cadence) ?? normalizePlanCadence(stored)
}

/** How a cadence reads on screen - the Plans page's "How often" words. */
const CADENCE_LABELS = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly' }

/** "Quarterly", "Yearly"... ('blueprint' and junk read as the empty string). */
export function planCadenceLabel(cadence) {
  return CADENCE_LABELS[cadence] ?? ''
}

/** Brittany: a quarterly plan runs January / April / July / October. */
const QUARTERLY_MONTHS = [1, 4, 7, 10]

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const isDay = (value) => Number.isInteger(value) && value >= 1 && value <= 31
const isMonth = (value) => Number.isInteger(value) && value >= 1 && value <= 12

/** [year, month, day] of a well-formed YYYY-MM-DD, or null. */
function dateParts(value) {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null
  if (!match) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  return isMonth(parts[1]) && isDay(parts[2]) ? parts : null
}

const pad = (value) => String(value).padStart(2, '0')

/** A month's `monthlyDueDays` entry, or NaN. */
function perMonthDay(template, month) {
  const map = template?.monthlyDueDays
  return map && typeof map === 'object' ? Number(map[month]) : NaN
}

/**
 * The due date a specific-months recipe gets in `month` of `year` - the same rule
 * as the materializer's `resolveSpecificMonthsDueDate` (db/store.js, mirrored in
 * src/lib/utils.ts): the per-month day, else the shared `dueDayOfMonth`, else the
 * last day, clamped to the month's length.
 */
function specificMonthsDueDate(template, year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const perMonth = perMonthDay(template, month)
  const shared = typeof template?.dueDayOfMonth === 'number' ? template.dueDayOfMonth : NaN
  const requested = Number.isFinite(perMonth) && perMonth >= 1 ? perMonth : shared
  const day = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.trunc(requested), lastDay) : lastDay
  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * The first occurrence of a specific-months schedule on or after `todayIso`: this
 * year's designated months, then next year's. Null when there are no months.
 */
function firstSpecificMonthsDueOnOrAfter(template, todayIso) {
  const today = dateParts(todayIso)
  const months = [...new Set((template?.scheduledMonths ?? []).filter(isMonth))].sort((a, b) => a - b)
  if (!today || months.length === 0) return null
  for (const year of [today[0], today[0] + 1]) {
    for (const month of months) {
      const due = specificMonthsDueDate(template, year, month)
      if (due >= todayIso) return due
    }
  }
  return null
}

/**
 * The month a YEARLY plan's checklist runs in: a specific-months blueprint's
 * first (lowest) designated month, otherwise January. Never the month of the
 * blueprint's `nextDueDate`: standard blueprints carry stale dates (2026-06-30)
 * that say nothing about when the work belongs.
 */
function annualMonth(blueprint) {
  if (blueprint?.frequency === 'specific-months') {
    const months = (Array.isArray(blueprint.scheduledMonths) ? blueprint.scheduledMonths : []).filter(isMonth)
    if (months.length > 0) return Math.min(...months)
  }
  return 1
}

/**
 * The schedule a client copy of a plan's checklist runs on, given the plan's
 * effective cadence (featreq-acdd0c84, stage B2). Pure and deterministic.
 *
 * Returns null for 'blueprint' (and anything that is not a cadence): the copy is
 * made exactly as before, on the blueprint's own schedule. Otherwise the fields
 * to lay over the copy:
 *
 *   - weekly    -> { frequency: 'weekly' }
 *   - monthly   -> { frequency: 'monthly' }
 *   - quarterly -> { frequency: 'specific-months', scheduledMonths: [1, 4, 7, 10], repeatAnnually: true }
 *   - annual    -> { frequency: 'specific-months', scheduledMonths: [m], repeatAnnually: true },
 *                  m = a specific-months blueprint's first designated month, else
 *                  January (never the month of a stale `nextDueDate`).
 *
 * Quarterly and annual are specific-months ON PURPOSE, not frequency 'quarterly'
 * / 'annually': those walk the blueprint's stale `nextDueDate`, which would land
 * the first occurrence in the wrong months. `repeatAnnually: true` because a
 * plan's schedule runs every year: a blueprint's stale `repeatAnnually: false` /
 * old `scheduleYear` would otherwise make a copy the materializer skips forever.
 *
 * The due day is the one the copy already carries (`dueDayOfMonth` /
 * `monthlyDueDays` come over with every copy). Only when the schedule CHANGES to
 * specific-months and `target` has no due day for every new month (no
 * `dueDayOfMonth`, `monthlyDueDays` missing one of them) is `dueDayOfMonth` set,
 * from the day of `target.nextDueDate` - the day a monthly recipe ran on. With no
 * such date either, nothing is set and the materializer's last-day-of-month rule
 * applies.
 *
 * For a specific-months result, `nextDueDate` is also returned when `todayIso` is
 * a YYYY-MM-DD: the first designated month's due date on or after today (the
 * materializer ignores `nextDueDate` for specific-months; this keeps what the
 * screens show honest). Weekly / monthly carry no `nextDueDate` - the caller
 * floors the blueprint's date with its own cadence walk, as every copy does.
 *
 * `target` is the template whose day settings the result keeps: the blueprint for
 * a NEW copy (the default), the existing copy for "Match plan". The months always
 * come from `blueprint`.
 */
export function cadenceSchedule(cadence, blueprint, todayIso, target = blueprint) {
  const value = normalizePlanCadence(cadence)
  if (!value || value === 'blueprint') return null
  if (value === 'weekly' || value === 'monthly') return { frequency: value }

  const scheduledMonths = value === 'quarterly' ? [...QUARTERLY_MONTHS] : [annualMonth(blueprint)]
  const fields = { frequency: 'specific-months', scheduledMonths, repeatAnnually: true }
  const hasDay =
    isDay(target?.dueDayOfMonth) ||
    scheduledMonths.every((month) => {
      const day = perMonthDay(target, month)
      return Number.isFinite(day) && day >= 1
    })
  const nextDay = dateParts(target?.nextDueDate)?.[2]
  if (target?.frequency !== 'specific-months' && !hasDay && nextDay) fields.dueDayOfMonth = nextDay

  const nextDueDate = firstSpecificMonthsDueOnOrAfter(
    {
      monthlyDueDays: target?.monthlyDueDays,
      dueDayOfMonth: fields.dueDayOfMonth ?? target?.dueDayOfMonth,
      scheduledMonths,
    },
    todayIso,
  )
  if (nextDueDate) fields.nextDueDate = nextDueDate
  return fields
}

/**
 * Whether a copy's schedule is not the one `mapped` (a `cadenceSchedule` result)
 * says - the "Match plan" button's test: the frequency differs, or the designated
 * months differ as sets, or a specific-months copy has "Repeat every year" off.
 * Months left on a weekly / monthly copy do not count (nothing reads them). A
 * null `mapped` never differs.
 */
export function scheduleDiffers(template, mapped) {
  if (!mapped) return false
  if (template?.frequency !== mapped.frequency) return true
  if (!Array.isArray(mapped.scheduledMonths)) return false
  // A copy stuck on one year ("Repeat every year" off) never runs again.
  if (mapped.repeatAnnually === true && template?.repeatAnnually === false) return true
  const have = new Set((Array.isArray(template?.scheduledMonths) ? template.scheduledMonths : []).filter(isMonth))
  const want = new Set(mapped.scheduledMonths)
  return have.size !== want.size || [...want].some((month) => !have.has(month))
}

/**
 * The plan a checklist's cadence comes from: the FIRST plan in `plans` (the
 * order the caller considers them in - the plans a copy was triggered by) whose
 * `templateIds` bundles `templateId`, or null.
 */
export function bundlingPlan(templateId, plans) {
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (Array.isArray(plan?.templateIds) && plan.templateIds.includes(templateId)) return plan
  }
  return null
}
