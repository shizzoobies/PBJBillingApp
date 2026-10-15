/**
 * Types for the plain-JS `lib/checklist-link-match.js`: which of a client's own
 * checklists stand for a plan or package blueprint, shared by the browser's Set
 * up and the server's package apply.
 */

/** The fields of a template the matching reads. */
export interface LinkableTemplate {
  id: string
  title: string
  clientId?: string | null
  isStandard?: boolean
  onboardingForClientId?: string | null
  sourceTemplateId?: string | null
  active?: boolean
  frequency?: string
  scheduledMonths?: number[]
}

/** The client's own checklists "Link existing" can attach to a blueprint, by title. */
export declare function linkableClientChecklists<T extends LinkableTemplate>(
  clientId: string,
  templates: readonly T[],
): T[]

/** The client's linkable, switched-on checklists that stand for a blueprint. */
export declare function linkCandidatesForPlanTemplate<T extends LinkableTemplate>(
  blueprint: { title: string },
  clientId: string,
  templates: readonly T[],
): T[]

/** What Set up does with one missing blueprint. */
export type PlanSetUpStep<B, T> =
  | { kind: 'link'; blueprint: B; copy: T }
  | { kind: 'create'; blueprint: B }
  | { kind: 'choose'; blueprint: B; candidates: T[]; reason: 'several' | 'schedule' }

/** Link the one existing match, create when none, leave several for her to choose. */
export declare function planSetUpSteps<
  B extends { title: string; frequency?: string; scheduledMonths?: number[] },
  T extends LinkableTemplate,
>(
  blueprints: readonly B[],
  clientId: string,
  templates: readonly T[],
  /** The "How often" the plan gives this blueprint's copy; a link needs it to agree with the checklist. */
  cadenceFor?: (blueprint: B) => string | null | undefined,
): Array<PlanSetUpStep<B, T>>
