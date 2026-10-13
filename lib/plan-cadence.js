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
