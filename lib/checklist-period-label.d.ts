export declare function coverageStepsBetween(
  anchorDue: string | null | undefined,
  dueDate: string | null | undefined,
  frequency: string | null | undefined,
  template?: { scheduledMonths?: number[] } | null,
): number

export declare function periodWindowFor(
  template:
    | {
        periodLabelEnabled?: boolean
        frequency?: string
        scheduledMonths?: number[]
        periodCoverageStart?: string | null
        periodCoverageEnd?: string | null
        periodCoverageAnchorDue?: string | null
      }
    | null
    | undefined,
  dueDate: string | null | undefined,
): { start: string; end: string } | null

export declare function periodLabelForInstance(
  template:
    | {
        periodLabelEnabled?: boolean
        frequency?: string
        scheduledMonths?: number[]
        periodCoverageStart?: string | null
        periodCoverageEnd?: string | null
        periodCoverageAnchorDue?: string | null
      }
    | null
    | undefined,
  dueDate: string | null | undefined,
): string | null

export declare function coverageAnchorForTemplate(
  template:
    | {
        frequency?: string
        scheduledMonths?: number[]
        nextDueDate?: string | null
      }
    | null
    | undefined,
  todayIso: string | null | undefined,
): string | null

export declare function sanitizePeriodLabel(value: unknown): string | null

export declare function sanitizeCoverageDate(value: unknown): string | null
