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

export declare function checklistMonthLabel(
  checklist:
    | { periodLabel?: string | null; cycleDueDate?: string | null; dueDate?: string | null }
    | null
    | undefined,
): string | null

export declare function sanitizePeriodLabel(value: unknown): string | null

export declare function sanitizeCoverageDate(value: unknown): string | null

type CaseStepLike = {
  id?: string
  caseId?: string
  clientId?: string
  stageIndex?: number
  dueDate?: string
  cycleDueDate?: string | null
  periodLabel?: string | null
  periodLabelManual?: boolean
}

export declare function occurrenceBeforeAnchor(
  template:
    | {
        frequency?: string
        periodCoverageStart?: string | null
        periodCoverageEnd?: string | null
        periodCoverageAnchorDue?: string | null
      }
    | null
    | undefined,
  occurrence: string | null | undefined,
): boolean

export declare function occurrenceDateOf(
  checklist: { dueDate?: string; cycleDueDate?: string | null } | null | undefined,
): string | null

export declare function caseOccurrenceKey(
  checklist: { id?: string; caseId?: string; clientId?: string } | null | undefined,
): string

export declare function caseOccurrences(checklists: CaseStepLike[]): Map<string, string>

export declare function periodLabelForCaseStep(
  template: Parameters<typeof periodLabelForInstance>[0],
  caseSteps: CaseStepLike[],
): { periodLabel: string | null; periodLabelManual: boolean }

export declare function openCaseOccurrences<T extends CaseStepLike & { templateId?: string | null }>(
  templateId: string,
  liveChecklists: T[],
  binnedChecklists: T[],
  isFinished: (checklist: T) => boolean,
): string[]

export declare function openCases<T extends CaseStepLike & { templateId?: string | null }>(
  templateId: string,
  liveChecklists: T[],
  binnedChecklists: T[],
  isFinished: (checklist: T) => boolean,
): Array<{ occurrence: string; periodLabel: string | null }>

export declare function coverageReference(
  template: Parameters<typeof coverageAnchorForTemplate>[0],
  openOccurrences: string[],
  todayIso: string,
): { date: string | null; open: boolean }

export declare function coverageDatesFromLabel(
  label: string | null | undefined,
): { start: string; end: string } | null

export declare function periodLabelFromDates(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null
