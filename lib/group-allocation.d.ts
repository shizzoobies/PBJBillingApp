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
