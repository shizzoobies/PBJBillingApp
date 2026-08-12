/**
 * Types for the plain-JS `lib/group-allocation.js`, so `src/` can import the
 * shared allocation math without `@ts-expect-error` and without a second
 * TypeScript copy of the rules drifting away from the server's.
 */

export type GroupAllocationMode = 'even' | 'full' | 'custom'

export declare function minutesToSeconds(minutes: number): number

export declare function secondsToMinutes(seconds: number): number

export declare function formatDurationLabel(minutes: number): string

export declare function allocateGroupMinutes(
  totalMinutes: number,
  clientIds: string[],
  mode: GroupAllocationMode,
  custom?: Record<string, number>,
): Record<string, number>

/** Do these percentages add up to 100 (allowing for ±0.0001 of float dust)? */
export declare function percentagesTotalTo100(percents: Record<string, number>): boolean

/**
 * Percentages → minutes, in whole seconds, summing to EXACTLY the block when the
 * percentages total 100. Persisted as a plain `custom` split — percentages are an
 * input method, not a stored mode.
 */
export declare function allocateByPercentages(
  totalMinutes: number,
  percents: Record<string, number>,
): Record<string, number>

/** Minutes → percentages (2dp, adjusted to display summing to 100). */
export declare function percentagesFromMinutes(
  allocations: Record<string, number>,
  totalMinutes: number,
): Record<string, number>

export type SplitTargetKind = 'holding' | 'regular' | 'administrative' | 'unsplittable'

export declare function classifySplitTarget(entry: {
  clientId?: string
  isAdministrative?: boolean
  groupClientIds?: string[]
}): SplitTargetKind

export declare function splitClientOptions(
  clients: Array<{ id: string; name?: string }>,
  /** One id, or an existing split's member ids — all pinned to the front. */
  currentClientId?: string | string[],
): Array<{ id: string; name: string }>

export declare function sliceMinutesAfterSessionEdit(
  currentMinutes: number,
  previousSessions: Array<{ startAt: string; endAt: string }>,
  nextSessions: Array<{ startAt: string; endAt: string }>,
): number

export declare function minutesAfterEntryEdit(options: {
  /** What the user typed, or null/undefined when the duration was untouched. */
  typedMinutes?: number | null
  /** Total across the NEW sessions. */
  sessionsMinutes: number
  isSlice: boolean
  currentMinutes: number
  previousSessions: Array<{ startAt: string; endAt: string }>
  nextSessions: Array<{ startAt: string; endAt: string }>
}): number

export declare function splitGroupPrefill(
  slices: Array<{ clientId?: string; minutes?: number; groupAllocation?: string }>,
): {
  clientIds: string[]
  customMinutes: Record<string, string>
  mode: GroupAllocationMode
  blockMinutes: number
  totalMinutes: number
}
