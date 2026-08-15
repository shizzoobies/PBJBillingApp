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
 * THE canonical payroll cost rule: one person, one period.
 *
 * Minutes are kept seconds-exact right up to the end, then the dollar figure is
 * rounded ONCE, to the cent. Rounding hours first (the natural thing to do by
 * hand off a 2-decimal report) gives a different answer, and rounding per entry
 * and adding gives a third — this is the one the firm pays and the one every
 * cost cell and cost total on every surface must show.
 *
 * `null` = the person has NO cost rate. For an owner that is the correct,
 * permanent answer rather than a missing setting: she draws no hourly wage, so
 * her time carries no labor cost. Never render it as $0.00.
 */
export function personPeriodCost(minutes, rate) {
  if (typeof rate !== 'number' || Number.isNaN(rate)) return null
  return roundToCent((minutes / 60) * rate)
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

/**
 * Export cell: the minutes as stored, verbatim. Trimmed at six decimals only to
 * strip binary dust (3.6500000000000004 → 3.65), never to round the value away.
 * This is the column that makes a cost figure re-derivable by hand.
 */
export function exactMinutesCell(minutes) {
  return String(Number(minutes.toFixed(6)))
}

/**
 * Export cell: hours at FOUR decimals. Two decimals cannot reproduce a cost
 * built from exact seconds — that mismatch is the whole reason this column
 * exists — and four is enough that hours × rate lands back on the same cent.
 */
export function exactHoursCell(minutes) {
  return (minutes / 60).toFixed(4)
}
