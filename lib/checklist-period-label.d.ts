export declare function periodGrainForFrequency(
  frequency: string | null | undefined,
): 'month' | 'quarter' | 'year'

export declare function normalizePeriodLabelOffset(value: unknown): number

export declare function periodLabelFor(
  dueDate: string | null | undefined,
  frequency: string | null | undefined,
  offset?: number,
): string | null

export declare function periodLabelForInstance(
  template:
    | { periodLabelEnabled?: boolean; frequency?: string; periodLabelOffset?: number }
    | null
    | undefined,
  dueDate: string | null | undefined,
): string | null

export declare function sanitizePeriodLabel(value: unknown): string | null
