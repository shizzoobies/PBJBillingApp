/**
 * Pure helpers for the workspace autosave / real-time-sync state machine in
 * `src/App.tsx`. Kept here (and unit-tested in `src/__tests__/sync.test.ts`) so
 * the load-bearing "is it safe to overwrite local data?" and "is the workspace
 * actually saved?" decisions are testable in isolation — the App component
 * itself is too large to render in a unit test.
 *
 * Background: the autosave indicator used to lie ("All changes saved" when no
 * PUT had happened) and a background refetch could overwrite edits the user was
 * still typing. The model below makes both decisions explicit.
 */

export type SyncStateLike = 'loading' | 'saving' | 'synced' | 'offline' | 'error'

/**
 * Serialize the bulk workspace for change detection. The autosave effect treats
 * the workspace as "clean" only when a serialized payload has been confirmed by
 * a successful PUT, so equality here = "this exact data is on the server."
 */
export function workspaceSnapshot(data: unknown): string {
  return JSON.stringify(data)
}

export interface RefetchGuard {
  /** Owner is previewing as another user — strictly read-only, never refetch. */
  preview: boolean
  /** Current sync state. A save in flight / a pending error must not be stomped. */
  syncState: SyncStateLike
  /** A local workspace edit happened within the recent grace window. */
  recentlyEdited: boolean
  /** There are local changes not yet confirmed persisted by a bulk PUT. */
  dirty: boolean
  /** The user currently has an editable element focused (mid-typing). */
  editingField: boolean
}

/**
 * Decide whether a cross-session refetch must be DEFERRED rather than applied.
 * Deferring (instead of replacing local `data` with the server copy) is what
 * prevents "it won't save what you were working on": we never overwrite the
 * workspace while the user has unsaved or in-progress edits.
 */
export function shouldDeferRefetch(g: RefetchGuard): boolean {
  return (
    g.preview ||
    g.syncState === 'saving' ||
    g.syncState === 'loading' ||
    g.syncState === 'error' ||
    g.recentlyEdited ||
    g.dirty ||
    g.editingField
  )
}

/**
 * Whether a focused element should be treated as "the user is mid-edit" so a
 * refetch defers. Pure so it can be tested without a DOM.
 */
export function isEditableElementTag(
  tagName: string | null | undefined,
  isContentEditable = false,
): boolean {
  if (isContentEditable) return true
  const tag = (tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
