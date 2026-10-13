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

/** "Weekly" / "Monthly" / "Quarterly" / "Yearly"; '' for 'blueprint' and junk. */
export declare function planCadenceLabel(cadence: unknown): string

/** The schedule fields a plan's cadence lays over a client copy (see the JSDoc in plan-cadence.js). */
export type CadenceScheduleFields = {
  frequency: 'weekly' | 'monthly' | 'specific-months'
  scheduledMonths?: number[]
  dueDayOfMonth?: number
  nextDueDate?: string
}

/** The template fields `cadenceSchedule` reads. */
type ScheduleSource = {
  frequency?: unknown
  scheduledMonths?: readonly number[] | null
  dueDayOfMonth?: unknown
  monthlyDueDays?: Record<number, number> | Record<string, number> | null
  nextDueDate?: unknown
}

/** null for 'blueprint' (copy as before); else the fields a copy following the plan carries. */
export declare function cadenceSchedule(
  cadence: unknown,
  blueprint: ScheduleSource | null | undefined,
  todayIso?: string,
  target?: ScheduleSource | null,
): CadenceScheduleFields | null

/** The frequency differs, or the designated months differ as sets. */
export declare function scheduleDiffers(
  template: { frequency?: unknown; scheduledMonths?: readonly number[] | null } | null | undefined,
  mapped: CadenceScheduleFields | null,
): boolean

/** The first plan in `plans` whose templateIds bundles `templateId`, or null. */
export declare function bundlingPlan<P extends { templateIds?: readonly string[] | null }>(
  templateId: string,
  plans: readonly (P | null | undefined)[] | null | undefined,
): P | null
