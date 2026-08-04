/**
 * Types for the plain-JS `lib/recurring-gate.js`, so `src/` can import the
 * shared "will this recurring checklist ever generate?" gate without a second
 * TypeScript copy of the rules drifting away from the server's.
 */

/** The first missing ingredient that stops a recipe from generating. */
export type RecurringGateReason =
  | 'no-client'
  | 'inactive'
  | 'no-stages'
  | 'no-steps'
  | 'no-months'
  | 'stale-year'
  | 'no-due-date'

/** Things that don't stop generation but make the result land badly. */
export type RecurringGateWarning = 'no-assignee' | 'no-board-column'

export interface RecurringGateVerdict {
  /** True for standard blueprints: never scheduled, so never a fault. */
  skipped: boolean
  /** The blocking reason, or null when the recipe will generate. */
  reason: RecurringGateReason | null
  /** Only populated when `reason` is null. */
  warnings: RecurringGateWarning[]
}

export declare function evaluateRecurringTemplate(
  template: {
    isStandard?: boolean
    clientId?: string
    active?: boolean
    stages?: { items?: unknown[]; assigneeId?: string }[]
    frequency?: string
    scheduledMonths?: number[]
    repeatAnnually?: boolean
    scheduleYear?: number
    nextDueDate?: string
    // Nullable on ChecklistTemplate: unset = "Uncategorized".
    categoryId?: string | null
  },
  options?: { currentYear?: number },
): RecurringGateVerdict
