/**
 * Types for the plain-JS `lib/plan-cadence.js`: how often a plan's checklists
 * run, shared by both store backends and the Plans page.
 */

export type PlanCadence = 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'blueprint'

export declare const PLAN_CADENCES: readonly PlanCadence[]

/** A valid stored value, or null for anything else. */
export declare function normalizePlanCadence(value: unknown): PlanCadence | null

/** The cadence a plan name ends in (" - Weekly" ... " - Yearly" / " - Annually"), or null. */
export declare function cadenceFromPlanName(name: unknown): Exclude<PlanCadence, 'blueprint'> | null

/** stored ?? parsed from the name ?? 'blueprint'. */
export declare function effectivePlanCadence(plan: { cadence?: unknown; name?: unknown } | null | undefined): PlanCadence

/** The value a bulk save writes: a valid payload value, else the stored one, else null. */
export declare function preservedPlanCadence(
  plan: { cadence?: unknown } | null | undefined,
  stored: unknown,
): PlanCadence | null
