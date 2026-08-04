/**
 * Types for the shared recurring-instance identity helpers. The runtime lives
 * in `checklist-identity.js` (plain JS so `db/store.js` and `server.js` can
 * import it too); this file is what the Vite/TS side compiles against.
 */

/** Minimal shape the identity helpers read off a checklist. */
export interface ChecklistInstanceIdentity {
  templateId?: string | null
  dueDate?: string | null
  stageIndex?: number | null
}

export function checklistInstanceKey(
  templateId: string | null | undefined,
  dueDate: string | null | undefined,
  stageIndex?: number | null,
): string | null

export function checklistMonthKey(
  templateId: string | null | undefined,
  dueDate: string | null | undefined,
): string | null

export function buildChecklistInstanceKeys(
  // Null/undefined lists AND null entries are tolerated — callers pass raw
  // `data.checklists` / `data.recycledChecklists` straight off the wire.
  ...lists: (readonly (ChecklistInstanceIdentity | null | undefined)[] | null | undefined)[]
): { instanceKeys: Set<string>; monthKeys: Set<string> }

export function findChecklistInstance<T extends ChecklistInstanceIdentity>(
  checklists: readonly T[] | null | undefined,
  templateId: string | null | undefined,
  dueDate: string | null | undefined,
  stageIndex?: number | null,
): T | undefined

export const CHECKLIST_INSTANCE_UNIQUE_INDEX: string
