/**
 * Payroll aggregation + THE labor-cost rule — the ONE place hours become cost.
 *
 * Lifted verbatim out of `src/lib/payrollAggregation.ts` (behavior for behavior;
 * `src/__tests__/payroll-aggregation.test.ts` still pins every rule, now through
 * a re-export) so it can be plain JS and therefore shared with the Node server.
 * The trigger was the Client Recap: it had its OWN `hours × rate` loop, so a
 * full-mode group double-counted cost there and the rounding order differed
 * from the payroll report's. Two implementations of "what does this person's
 * time cost" is one too many — see `lib/invoice-lines.js` for the same story on
 * the revenue side.
 *
 * `src/lib/payrollAggregation.ts` is now a re-export of this file. Import from
 * either; there is only one implementation.
 *
 * ---- WHAT AN HOUR COSTS ----
 *
 * Cost is the two-decimal hours a report PRINTS times the cost rate — round the
 * hours, then multiply. See {@link personPeriodCost}. Every cost figure in the
 * app comes from that one function, so the arithmetic the owner does off a
 * printed report is the arithmetic the app did.
 *
 * ---- GROUP-TIME SPLITS ----
 *
 * When the owner splits one tracked block across several clients in `full`
 * mode, every resulting slice carries the ENTIRE block's minutes — that is the
 * point of the mode: each client is billed for the whole thing. So a 1-hour
 * block split across 3 clients in full mode produces 3 slices of 60 minutes,
 * and 3 billable hours is the correct BILLING answer.
 *
 * It is NOT the correct PAYROLL answer. The person worked one hour, and the
 * firm pays for one hour. Anything measuring wall time — tracked hours, day
 * subtotals, grand totals, labor cost — must count such a block ONCE.
 *
 * `even` and `custom` splits already carve the block up (their slices sum back
 * to the original), and ordinary entries have no group at all, so both count
 * normally. Only `full` needs the dedup.
 */

/**
 * Ids of slices whose minutes DUPLICATE another slice of the same full-mode
 * group. Every slice of a full-mode group carries identical minutes, so which
 * one is kept is arbitrary — the FIRST in the given order wins and the rest are
 * reported here. Callers use the set both to exclude those minutes from wall-
 * time totals and to mark the affected rows in the UI.
 */
export function duplicateFullSliceIds(entries) {
  const keptByGroup = new Map()
  const duplicates = new Set()
  for (const entry of entries) {
    if (entry.groupAllocation !== 'full' || !entry.groupId) continue
    if (keptByGroup.has(entry.groupId)) duplicates.add(entry.id)
    else keptByGroup.set(entry.groupId, entry.id)
  }
  return duplicates
}

/**
 * Wall-clock minutes actually worked: every entry counts once, and a full-mode
 * group counts once in total rather than once per slice.
 */
export function trackedMinutes(entries, duplicates = duplicateFullSliceIds(entries)) {
  return entries.reduce((sum, entry) => (duplicates.has(entry.id) ? sum : sum + entry.minutes), 0)
}

/**
 * Billable minutes. Deliberately NOT deduped — a full-mode split bills each
 * client the whole block on purpose, so all three of those hours are billed.
 */
export function billableMinutes(entries) {
  return entries.reduce((sum, entry) => (entry.billable ? sum + entry.minutes : sum), 0)
}

/** Non-billable minutes. Deduped like tracked time — it is still wall time. */
export function internalMinutes(entries, duplicates = duplicateFullSliceIds(entries)) {
  return entries.reduce(
    (sum, entry) => (entry.billable || duplicates.has(entry.id) ? sum : sum + entry.minutes),
    0,
  )
}

/**
 * Round money to whole cents.
 *
 * The ×100 product goes through a fixed-precision string first so a figure that
 * is arithmetically a half-cent — but stored as 4.00499999… — still rounds up
 * instead of silently down.
 */
export function roundToCent(amount) {
  const cents = Math.round(Number((amount * 100).toFixed(6)))
  // `Math.round` hands back -0 for anything in [-0.5, 0), and Intl renders that
  // as "-$0.00" on a payroll document. Normalize it away.
  return cents === 0 ? 0 : cents / 100
}

/**
 * Minutes as the HOURS THE REPORTS SHOW: two decimals, rounded half-up.
 *
 * Not a formatter — it returns a number, because this figure is the multiplicand
 * in {@link personPeriodCost}. `src/lib/utils.ts` `decimalHours` prints exactly
 * this value, so what is on screen and what is multiplied cannot drift apart.
 *
 * The ×100 product goes through a fixed-precision string for the same reason
 * `roundToCent` does: 0.995h (59.7 min) is stored a hair below its decimal form,
 * and a bare `toFixed(2)` would report 0.99 where written arithmetic says 1.00.
 *
 * `Math.round` breaks halves toward +∞, so an exact negative half-hundredth
 * rounds TOWARD ZERO (-0.005h -> -0.00h) where the positive one rounds away
 * from it. The only negative figure in the app is the Client Recap's
 * "vs. prior period" delta, where the asymmetry is invisible; noted so nobody
 * has to rediscover it.
 */
export function displayHours(minutes) {
  const hundredths = Math.round(Number(((minutes / 60) * 100).toFixed(6)))
  // -0 would render as "-0.00" and multiply into "-$0.00". Normalize it away.
  return hundredths === 0 ? 0 : hundredths / 100
}

/**
 * THE canonical payroll cost rule: one person, one period.
 *
 * Sum the person's minutes seconds-exact, round to the TWO-DECIMAL HOURS the
 * report prints, and multiply that by the cost rate. Round the hours FIRST —
 * that order is the rule, not an approximation of one. In the firm owner's own
 * words, verbatim: "I pay by the minute so if someone works 20 hours and 13.4
 * minutes rounded to the 2nd decimal then I would pay 20.22 times her cost and
 * that time because the staple for all comparisons".
 *
 * It used to divide seconds and round the dollars once at the end, which is a
 * defensible rule and is not the one she pays by: it made the printed Hours
 * column un-multipliable, so every report had to carry an exact-minutes column
 * to explain a few cents of drift. Now the visible hours ARE the input, so
 * hours × rate reproduces every cost cell by hand and rows add to totals.
 *
 * The trailing `roundToCent` is not a second rounding of the policy — 20.22 ×
 * a rate can still land on a third decimal ($8.015) — it just settles the cent.
 *
 * `null` = the person has NO cost rate. For an owner that is the correct,
 * permanent answer rather than a missing setting: she draws no hourly wage, so
 * her time carries no labor cost. Never render it as $0.00.
 */
export function personPeriodCost(minutes, rate) {
  if (typeof rate !== 'number' || Number.isNaN(rate)) return null
  return roundToCent(displayHours(minutes) * rate)
}

/**
 * An hours TOTAL: the sum of already-two-decimal hour figures, added in whole
 * hundredths so no float dust survives.
 *
 * A TOTAL IS THE SUM OF THE ROWS THE READER SEES — not the rounded sum of the
 * raw seconds behind them. Those two differ: three rows of 0.17h, 0.17h and
 * 0.75h read 1.09h, while the underlying 10 + 10 + 45 minutes round to 1.08h.
 * The owner adds the column; the column has to be right. This became
 * load-bearing when the hours stopped being a display of the costing figure and
 * BECAME it — see {@link personPeriodCost}.
 *
 * Callers pass hours, not minutes, so the values summed are literally the ones
 * printed: `sumDisplayHours(rows.map((r) => displayHours(r.minutes)))`.
 */
export function sumDisplayHours(hours) {
  const hundredths = hours.reduce(
    (sum, value) =>
      typeof value === 'number' && !Number.isNaN(value) ? sum + Math.round(value * 100) : sum,
    0,
  )
  return hundredths === 0 ? 0 : hundredths / 100
}

/**
 * A cost TOTAL: the sum of already-cent-rounded per-person costs, added in whole
 * cents so no float dust survives. Every total is built this way, which is what
 * makes adding up a visible Cost column by hand land exactly on the shown total.
 * People with no rate contribute nothing.
 */
export function sumPersonCosts(costs) {
  const cents = costs.reduce(
    (sum, cost) =>
      typeof cost === 'number' && !Number.isNaN(cost) ? sum + Math.round(cost * 100) : sum,
    0,
  )
  return cents / 100
}

/**
 * Labor cost for a set of slices: hours actually worked × the person's cost
 * rate, deduped the same way tracked time is, and — because it is a total —
 * assembled per person under {@link personPeriodCost}. Slices are grouped by
 * employee FIRST so each person's minutes are summed exactly and rounded once.
 */
/**
 * Split ONE person's period cost across their own entry rows, so a per-entry
 * Cost column ADDS UP to the total printed under it.
 *
 * The grain problem, stated plainly: the firm pays on a person's period hours
 * (`personPeriodCost`), but featreq-55212377 puts a Cost cell on every entry of
 * the raw/printed time report. Pricing each row independently off its own
 * rounded hours cannot sum to the period figure — each row carries up to half a
 * hundredth of an hour of rounding, and over a month of entries those add to
 * dollars, not pennies. One of the two has to give, and it is not the total:
 * the total is what she pays.
 *
 * So each row STARTS at its own `displayHours × rate` — the figure a reader
 * would compute from the row — and the residual against the person's period
 * cost is handed out a penny at a time, largest fractional part first (smallest
 * first when pennies must come back), wrapping around if the gap exceeds one
 * penny per row. The column therefore sums EXACTLY, every row's adjustment is
 * within a penny of every other row's (no line absorbs the whole gap), and a
 * row lands a few cents from its own hours × rate rather than being a fresh
 * invention — closer the more rows there are, which is the opposite of what
 * pricing rows independently did to the total.
 *
 * Full-mode duplicate slices must be filtered out by the caller before this is
 * called — the firm pays for such a block once, so it gets one row's cost.
 *
 * `null` rate -> every row is null (no cost rate is not $0.00 — see
 * {@link personPeriodCost}).
 */
export function allocatePersonCost(minutesPerRow, rate) {
  if (typeof rate !== 'number' || Number.isNaN(rate)) return minutesPerRow.map(() => null)
  if (minutesPerRow.length === 0) return []
  const totalMinutes = minutesPerRow.reduce((sum, minutes) => sum + minutes, 0)
  const targetCents = Math.round(personPeriodCost(totalMinutes, rate) * 100)
  // `toFixed(6)` first for the same reason roundToCent uses it: a product that
  // is arithmetically 629 must not floor to 628 because it is stored as 628.999…
  const ideals = minutesPerRow.map((minutes) =>
    Number((displayHours(minutes) * rate * 100).toFixed(6)),
  )
  const cents = ideals.map((ideal) => Math.floor(ideal))
  let residual = targetCents - cents.reduce((sum, value) => sum + value, 0)
  const step = residual >= 0 ? 1 : -1
  const order = ideals
    .map((ideal, index) => ({ index, fraction: ideal - Math.floor(ideal) }))
    // Pennies to hand out go to the rows closest to earning one; pennies to take
    // back come from the rows furthest from it.
    .sort((a, b) => (step > 0 ? b.fraction - a.fraction : a.fraction - b.fraction))
  for (let k = 0; residual !== 0; k++) {
    cents[order[k % order.length].index] += step
    residual -= step
  }
  return cents.map((value) => (value === 0 ? 0 : value / 100))
}

export function laborCost(entries, costRateOf, duplicates = duplicateFullSliceIds(entries)) {
  const minutesByEmployee = new Map()
  for (const entry of entries) {
    if (duplicates.has(entry.id)) continue
    minutesByEmployee.set(
      entry.employeeId,
      (minutesByEmployee.get(entry.employeeId) ?? 0) + entry.minutes,
    )
  }
  return sumPersonCosts(
    [...minutesByEmployee].map(([employeeId, minutes]) =>
      personPeriodCost(minutes, costRateOf(employeeId)),
    ),
  )
}

