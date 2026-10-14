/**
 * Types for the plain-JS `lib/checklist-template-copy.js`, so the browser clone
 * and the server copy share ONE list of what a copied recipe carries.
 */

/** The template-level settings a copy keeps (schedule, column, labels, access). */
export declare function copiedTemplateSettings<T extends object>(
  source: T,
  options?: {
    /** The firm year at copy time: a past `scheduleYear` on a one-year recipe rebases to it. */
    currentYear?: number
  },
): {
  assigneeId: string
  categoryId: string | null
  leadDays: number | undefined
  scheduledMonths: number[] | undefined
  dueDayOfMonth: number | undefined
  monthlyDueDays: Record<string, number> | undefined
  repeatAnnually: boolean | undefined
  scheduleYear: number | undefined
  skipAllowed: boolean | undefined
  periodLabelEnabled: boolean | undefined
  periodCoverageStart: string | null
  periodCoverageEnd: string | null
  periodCoverageAnchorDue: string | null
  viewerIds: string[]
  editorIds: string[]
}

/** The stages of a copy, spread, with fresh ids at every level. */
export declare function copiedTemplateStages<S extends { items?: unknown[] }>(
  stages: readonly S[] | null | undefined,
  newId: (prefix: string) => string,
): S[]
