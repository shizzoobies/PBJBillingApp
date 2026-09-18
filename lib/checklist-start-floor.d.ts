/**
 * Types for the plain-JS `lib/checklist-start-floor.js`, so `src/` can share
 * the server's "a recipe starts the day it is set up" rule instead of keeping
 * a second TypeScript copy that drifts.
 */

/**
 * The earliest date a template may produce work for. `null` means the template
 * carries no creation stamp, which means NO floor (legacy behavior).
 */
export declare function templateStartFloor(
  template: { createdAt?: string | null } | null | undefined,
): string | null

/**
 * The first cycle on or after `floor`, walking the caller's own cadence
 * function so this module never becomes a third copy of the date math.
 */
export declare function firstCycleOnOrAfter<F extends string>(
  dateString: string,
  frequency: F,
  floor: string | null,
  advance: (date: string, frequency: F) => string,
): string

/** How many cycles below the floor a materializer spawns without complaint. */
export declare const BACKDATED_CYCLE_TOLERANCE: number

/**
 * The cycle date a materializer should start its spawn loop from: the floored
 * date when more than `BACKDATED_CYCLE_TOLERANCE` cycles sit below the floor,
 * and otherwise the date untouched, so one deliberately overdue cycle still
 * generates.
 */
export declare function flooredCycleStart<F extends string>(
  dateString: string,
  frequency: F,
  floor: string | null,
  advance: (date: string, frequency: F) => string,
): string

/**
 * The creation stamp to persist for a template the backend has never seen: the
 * payload's own, when it parses and is not in the future, else `now`. An id the
 * backend already holds is NOT this function's business — the stored stamp wins
 * there, always.
 */
export declare function newTemplateCreatedAt(
  template: { createdAt?: unknown } | null | undefined,
  now?: Date,
): Date
