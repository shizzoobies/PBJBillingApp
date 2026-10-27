/**
 * Types for the Remove case helpers. The runtime lives in `case-removal.js`
 * (plain JS so `db/store.js` can import it too).
 */

export interface CaseRow {
  id: string
  caseId?: string | null
  deletedAt?: string | null
  templateId?: string | null
  dueDate?: string | null
  cycleDueDate?: string | null
  stageIndex?: number | null
  pushedToChecklistId?: string | null
  clientId?: string | null
}

export const RESTORE_CONFLICT_MESSAGE: string

export function caseTitleOf(
  rows: readonly ({ title?: string | null; stageIndex?: number | null } | null | undefined)[] | null | undefined,
  fallback?: string,
): string

export function restoreConflicts<T extends CaseRow>(set: readonly T[] | null | undefined, live: readonly CaseRow[] | null | undefined): T[]

export function caseKeyOf(checklist: CaseRow | null | undefined): string | null

export function rowsOfCase<T extends CaseRow>(
  checklists: readonly T[] | null | undefined,
  caseId: string | null | undefined,
  clientId?: string | null,
): T[]

export function removedCaseSet<T extends CaseRow>(target: T | null | undefined, recycled: readonly T[] | null | undefined): T[]

export function stepCountLabel(count: number): string

export function removeCaseConfirmText(input: { title: string; clientName: string; stepCount: number }): string
