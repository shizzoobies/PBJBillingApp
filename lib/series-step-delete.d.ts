/**
 * Types for the plain-JS `lib/series-step-delete.js` (the rules behind the
 * "this and future" step delete), so a test or `src/` can import them.
 */

export declare const LAST_RECURRING_STEP_MESSAGE: string
export declare const NOT_RECURRING_MESSAGE: string
export declare const SHARED_TEMPLATE_MESSAGE: string
export declare function seriesDeleteDenial(
  checklist: { templateId?: string | null; clientId: string } | null | undefined,
  templates: { id: string; isStandard?: boolean; clientId?: string }[] | null | undefined,
): { status: 400 | 409; error: string } | null
/** The slice of the data store these helpers call (db/store.js). */
type SeriesDeleteStore = {
  deleteChecklistItemFromSeries(checklistId: string, itemId: string): Promise<unknown>
  recordActivity(actorId: string, type: string, detail: string): Promise<unknown>
  read(): Promise<{
    checklists: { id: string }[]
    checklistTemplates: { id: string }[]
  }>
  setItemDeletionRequestScope(id: string, scope: string): Promise<unknown>
}
type DeletionRequestPath = {
  checklistId: string
  itemId: string
  subItemId?: string | null
  subSubItemId?: string | null
}
export declare function runSeriesStepDelete(args: {
  store: SeriesDeleteStore
  actorId: string
  broadcast: () => void
  checklist: { id: string; title: string; templateId?: string | null }
  itemId: string
  label: string
}): Promise<{ status: number; body: Record<string, unknown> }>
export declare function reuseDuplicateDeletionRequest<T extends DeletionRequestPath & { id: string; scope?: string; requestedBy?: string | null }>(
  store: SeriesDeleteStore,
  existing: T[],
  path: DeletionRequestPath & { scope?: string; requestedBy?: string | null },
): Promise<{ request: T; scopeChanged: boolean } | null>
export declare const REQUEST_CHANGED_MESSAGE: string
export declare const SERIES_SUBSTEP_MESSAGE: string
export declare function approvalDenial(
  request: DeletionRequestPath & { scope?: string },
  shownScope: string | null | undefined,
): { status: 409; body: { error: string; message?: string } } | null
