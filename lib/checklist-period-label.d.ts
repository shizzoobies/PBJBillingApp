export declare function coverageStepsBetween(
  anchorDue: string | null | undefined,
  dueDate: string | null | undefined,
  frequency: string | null | undefined,
): number

export declare function periodWindowFor(
  template:
    | {
        periodLabelEnabled?: boolean
        frequency?: string
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
        periodCoverageStart?: string | null
        periodCoverageEnd?: string | null
        periodCoverageAnchorDue?: string | null
      }
    | null
    | undefined,
  dueDate: string | null | undefined,
): string | null

export declare function sanitizePeriodLabel(value: unknown): string | null

export declare function sanitizeCoverageDate(value: unknown): string | null
