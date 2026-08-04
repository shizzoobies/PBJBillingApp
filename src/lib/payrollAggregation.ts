/**
 * Payroll aggregation rules for GROUP-TIME SPLITS.
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

/** The slice fields these rules need. Structural so tests can pass literals. */
export type PayrollSlice = {
  id: string
  employeeId: string
  minutes: number
  billable: boolean
  groupId?: string
  groupAllocation?: 'even' | 'full' | 'custom'
}

/**
 * Ids of slices whose minutes DUPLICATE another slice of the same full-mode
 * group. Every slice of a full-mode group carries identical minutes, so which
 * one is kept is arbitrary — the FIRST in the given order wins and the rest are
 * reported here. Callers use the set both to exclude those minutes from wall-
 * time totals and to mark the affected rows in the UI.
 */
export function duplicateFullSliceIds(entries: readonly PayrollSlice[]): Set<string> {
  const keptByGroup = new Map<string, string>()
  const duplicates = new Set<string>()
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
export function trackedMinutes(
  entries: readonly PayrollSlice[],
  duplicates: ReadonlySet<string> = duplicateFullSliceIds(entries),
): number {
  return entries.reduce((sum, entry) => (duplicates.has(entry.id) ? sum : sum + entry.minutes), 0)
}

/**
 * Billable minutes. Deliberately NOT deduped — a full-mode split bills each
 * client the whole block on purpose, so all three of those hours are billed.
 */
export function billableMinutes(entries: readonly PayrollSlice[]): number {
  return entries.reduce((sum, entry) => (entry.billable ? sum + entry.minutes : sum), 0)
}

/** Non-billable minutes. Deduped like tracked time — it is still wall time. */
export function internalMinutes(
  entries: readonly PayrollSlice[],
  duplicates: ReadonlySet<string> = duplicateFullSliceIds(entries),
): number {
  return entries.reduce(
    (sum, entry) =>
      entry.billable || duplicates.has(entry.id) ? sum : sum + entry.minutes,
    0,
  )
}

/**
 * Labor cost — hours actually worked × the person's cost rate, deduped the same
 * way tracked time is. `costRateOf` returns `null`/`undefined` for someone with
 * NO cost rate (an owner draws no hourly wage); those minutes contribute
 * nothing, which is why the caller must never render the result as their $0.00.
 */
export function laborCost(
  entries: readonly PayrollSlice[],
  costRateOf: (employeeId: string) => number | null | undefined,
  duplicates: ReadonlySet<string> = duplicateFullSliceIds(entries),
): number {
  return entries.reduce((sum, entry) => {
    if (duplicates.has(entry.id)) return sum
    const rate = costRateOf(entry.employeeId)
    if (typeof rate !== 'number' || Number.isNaN(rate)) return sum
    return sum + (entry.minutes / 60) * rate
  }, 0)
}
