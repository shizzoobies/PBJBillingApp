/**
 * Types for the Remove case helpers. The runtime lives in `case-removal.js`
 * (plain JS so `db/store.js` can import it too).
 */

export interface CaseRow {
  id: string
  caseId?: string | null
  deletedAt?: string | null
}

export function caseKeyOf(checklist: CaseRow | null | undefined): string | null

export function rowsOfCase<T extends CaseRow>(checklists: readonly T[] | null | undefined, caseId: string | null | undefined): T[]

export function removedCaseSet<T extends CaseRow>(target: T | null | undefined, recycled: readonly T[] | null | undefined): T[]

export function stepCountLabel(count: number): string

export function removeCaseConfirmText(input: { title: string; clientName: string; stepCount: number }): string
