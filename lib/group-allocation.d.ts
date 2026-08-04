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
  currentClientId?: string,
): Array<{ id: string; name: string }>
