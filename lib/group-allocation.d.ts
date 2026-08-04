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

export declare function splitGroupPrefill(
  slices: Array<{ clientId?: string; minutes?: number; groupAllocation?: string }>,
): {
  clientIds: string[]
  customMinutes: Record<string, string>
  mode: GroupAllocationMode
  blockMinutes: number
  totalMinutes: number
}
