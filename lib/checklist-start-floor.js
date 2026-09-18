/**
 * When a recurring recipe starts producing work — the "no history on day one"
 * rule (featreq-c133daf8).
 *
 * Brittany: "When a new client is added, the system automatically generates
 * checklist items for past dates; the owner has to delete them. Auto-generated
 * items should begin only from the client's setup date forward."
 *
 * TWO generators have to agree about this, for exactly the reason the identity
 * keys in lib/checklist-identity.js live in one file: the server materializer
 * (`materializeRecurringChecklists`, db/store.js) and the browser's copy
 * (`ensureRecurringChecklists`, src/lib/utils.ts) both spawn instances, so a
 * floor the server honors and the browser does not would simply be re-created
 * by the next bulk save.
 *
 * Plain JS with a sibling .d.ts so `src/` and the server share one file — same
 * arrangement as lib/recurring-gate.js.
 */

/**
 * The earliest date a template may produce work for: the day it was created.
 *
 * Returns null when the template carries no creation stamp, and null means NO
 * FLOOR — pre-existing behavior, unchanged. That matters for every template
 * that predates this rule: a missing stamp must never be read as "created
 * today", which would stop a legacy recipe from filling in the cycle it is
 * genuinely due for.
 *
 * @param {{ createdAt?: string | null } | null | undefined} template
 * @returns {string | null} `YYYY-MM-DD`, or null for no floor.
 */
export function templateStartFloor(template) {
  const raw = template?.createdAt
  if (typeof raw !== 'string') return null
  const day = raw.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

/**
 * Walk a cadence forward until it lands on or after `floor`, keeping the
 * cadence's own phase (a monthly recipe due on the 15th stays on the 15th).
 *
 * Used twice: to floor a COPIED template's first due date at today (a standard
 * blueprint's `nextDueDate` is months stale, so copying it verbatim spawned a
 * dozen backdated instances on the next read), and to floor a template's own
 * cycle walk at its creation date before the materializer's loop runs.
 *
 * @param {string} dateString  the cycle date to start from (`YYYY-MM-DD`)
 * @param {string} frequency  the template's cadence
 * @param {string | null} floor  the earliest acceptable date, or null for none
 * @param {(date: string, frequency: string) => string} advance
 *   the caller's own `advanceChecklistFrequency`. There is one copy in
 *   db/store.js and one in src/lib/utils.ts; this helper must not become a
 *   third, so the walk is injected rather than re-implemented here.
 * @returns {string} the first cycle on or after `floor`, or `dateString`
 *   unchanged when there is no floor, it is already met, or the cadence
 *   refuses to advance.
 */
export function firstCycleOnOrAfter(dateString, frequency, floor, advance) {
  return walkToFloor(dateString, frequency, floor, advance).date
}

/**
 * How many cycles below the floor a materializer will spawn WITHOUT complaint.
 *
 * One, and the number is the whole design. The materializer cannot tell a stale
 * date it inherited from a date somebody typed on purpose — both are just a
 * `nextDueDate` in the past — so it distinguishes them by how much history they
 * ask for. A recipe set up today whose next due date is the 1st of this month
 * is ONE cycle overdue: an owner who means it, and that occurrence generates.
 * A weekly recipe carrying a blueprint's date from June is ten, which is the
 * pile of backdated tasks featreq-c133daf8 is about.
 */
export const BACKDATED_CYCLE_TOLERANCE = 1

/**
 * The cycle date the materializer should actually START its spawn loop from.
 *
 * Unlike `firstCycleOnOrAfter` — which is used at template CREATION, where the
 * caller knows whether a date was chosen or inherited — this is the spawn-side
 * rule and has to infer intent. It floors only when more than
 * `BACKDATED_CYCLE_TOLERANCE` cycles sit below the floor; otherwise the date is
 * handed back untouched and the single overdue occurrence generates as it
 * always has.
 *
 * @param {string} dateString  the template's `nextDueDate`
 * @param {string} frequency  the template's cadence
 * @param {string | null} floor  the template's creation date, or null for none
 * @param {(date: string, frequency: string) => string} advance
 * @returns {string} the cycle date to start from.
 */
export function flooredCycleStart(dateString, frequency, floor, advance) {
  const walked = walkToFloor(dateString, frequency, floor, advance)
  return walked.below > BACKDATED_CYCLE_TOLERANCE ? walked.date : dateString
}

/**
 * The cadences that step in DAYS, where a day-of-month anchor is meaningless.
 * Everything else steps in MONTHS. Mirrors the branches of
 * `advanceChecklistFrequency` — which exists twice (db/store.js and
 * src/lib/utils.ts) and is injected into the walk rather than copied a third
 * time; this set is the one thing the walk has to know about it.
 */
const DAY_STEPPED_FREQUENCIES = new Set(['daily', 'weekly', 'biweekly'])

/**
 * Re-seat a month-stepped date on its anchor day, clamped to the month's real
 * length — the same clamp `resolveSpecificMonthsDueDate` applies (db/store.js).
 *
 * `advanceChecklistFrequency` builds its monthly step with `new Date(y, m + n,
 * day)`, which OVERFLOWS rather than clamping: a recipe due Jan 31 advances to
 * Mar 3, and stepping from there walks off the month end for good (Jan 31 → Mar
 * 3 → Apr 3 → …). A month-end recipe that got floored therefore landed on the
 * 3rd of a month instead of its last day. Re-anchoring after each step keeps a
 * month-end recipe on month ends. It does skip the overflowed month (Jan 31 →
 * Mar 31, no February), which is correct here: the walk only ever crosses
 * cycles that are being suppressed anyway, and what matters is where it LANDS.
 */
function reanchorDay(dateString, anchorDay) {
  const [year, month] = dateString.split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month)) return dateString
  const lastDay = new Date(year, month, 0).getDate()
  const day = Math.min(anchorDay, lastDay)
  return `${dateString.slice(0, 8)}${String(day).padStart(2, '0')}`
}

/**
 * The shared walk: advance until the cursor reaches `floor`, counting the
 * cycles left behind. Both exported helpers read it so "where does the cadence
 * land" and "how much history was skipped to get there" can never disagree.
 *
 * @returns {{ date: string, below: number }}
 */
function walkToFloor(dateString, frequency, floor, advance) {
  if (typeof dateString !== 'string' || !dateString) return { date: dateString, below: 0 }
  if (!floor || dateString >= floor) return { date: dateString, below: 0 }
  const anchorDay = Number(dateString.slice(8, 10))
  const reanchor =
    !DAY_STEPPED_FREQUENCIES.has(frequency) && Number.isFinite(anchorDay) && anchorDay > 28
  let cursor = dateString
  let below = 0
  // Bounded for the same reason the materializer's own loop is: a cadence that
  // will not advance, or a floor years out, must not spin. 600 steps covers a
  // daily recipe stranded well over a year in the past.
  for (let step = 0; step < 600 && cursor < floor; step += 1) {
    below += 1
    const advanced = advance(cursor, frequency)
    if (typeof advanced !== 'string' || !advanced) break
    const next = reanchor ? reanchorDay(advanced, anchorDay) : advanced
    if (next === cursor || next < cursor) break
    cursor = next
  }
  return { date: cursor, below }
}

/**
 * The creation stamp to persist for a template a backend has NEVER seen.
 *
 * Both backends deliberately ignore the payload for a row they already hold —
 * that snapshot-wins rule is what stops a stale tab rewriting history, and it
 * stays absolute. A row that is genuinely NEW is the opposite case: its stamp
 * is the only record of when the recipe was meant to start, and
 * `copyTemplateToClient` puts an owner's chosen first due date there precisely
 * so the materializer's floor can never argue with the date they typed. A
 * claimed stamp can therefore only ever WIDEN the spawn window back toward the
 * pre-existing behavior; it cannot delete or overwrite anything.
 *
 * A stamp in the FUTURE is refused, since that would silence the recipe
 * entirely, as is anything unparseable.
 *
 * @param {{ createdAt?: unknown }} template
 * @param {Date} [now]
 * @returns {Date}
 */
export function newTemplateCreatedAt(template, now = new Date()) {
  const raw = template?.createdAt
  if (typeof raw !== 'string' || !raw) return now
  const claimed = new Date(raw)
  if (Number.isNaN(claimed.getTime())) return now
  return claimed <= now ? claimed : now
}
