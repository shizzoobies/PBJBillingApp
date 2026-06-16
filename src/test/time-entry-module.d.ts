/**
 * Ambient type declaration for the backend time-entry module
 * (`lib/time-entry.js`), which is plain JavaScript living outside `src/` and
 * so has no generated `.d.ts`. This lets the test suite import it with types
 * instead of `any`. It is a test-support file only — it does not affect the
 * shipped app.
 *
 * Keep the shapes here in sync with the actual exports in lib/time-entry.js.
 */
declare module '*/lib/time-entry.js' {
  export function normalizeTimeEntryMethod(payload?: {
    entryMethod?: unknown
    manualReason?: unknown
  }): {
    entryMethod: 'timer' | 'manual'
    manualReason: string | undefined
    error: string | null
  }
  export function findBlockingRejectedWeek(
    entryWeekStart: string,
    priorWeekStarts: Iterable<string>,
    submissions: ReadonlyArray<{ weekStart: string; status: string }>,
  ): string | null
}
