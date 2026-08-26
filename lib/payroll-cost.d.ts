/**
 * Types for the plain-JS `lib/payroll-cost.js`, so `src/` can import the shared
 * payroll/labor-cost rules instead of keeping a second TypeScript copy that
 * drifts away from the server's.
 *
 * Keep the shapes here in sync with the actual exports in lib/payroll-cost.js.
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

export declare function duplicateFullSliceIds(entries: readonly PayrollSlice[]): Set<string>

export declare function trackedMinutes(
  entries: readonly PayrollSlice[],
  duplicates?: ReadonlySet<string>,
): number

export declare function billableMinutes(entries: readonly PayrollSlice[]): number

export declare function internalMinutes(
  entries: readonly PayrollSlice[],
  duplicates?: ReadonlySet<string>,
): number

export declare function roundToCent(amount: number): number

export declare function displayHours(minutes: number): number

export declare function personPeriodCost(
  minutes: number,
  rate: number | null | undefined,
): number | null

export declare function sumDisplayHours(hours: readonly (number | null | undefined)[]): number

export declare function sumPersonCosts(costs: readonly (number | null | undefined)[]): number

export declare function periodDisplayHours(minutesPerRow: readonly number[]): number

export declare function periodMoney(
  minutesPerRow: readonly number[],
  rate: number | null | undefined,
): number | null

export declare function allocatePersonCost(
  minutesPerRow: readonly number[],
  rate: number | null | undefined,
): (number | null)[]

export declare function laborCost(
  entries: readonly PayrollSlice[],
  costRateOf: (employeeId: string) => number | null | undefined,
  duplicates?: ReadonlySet<string>,
): number
