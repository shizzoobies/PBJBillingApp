/**
 * Types for the shared checklist write gate. Same convention as
 * `waiting-on-state.d.ts` — the implementation is plain JS so the server can
 * import it directly, and this file lets the React side use it too.
 */

export type ChecklistWriteUser = {
  id?: string
  role?: string
}

export type ChecklistWriteTarget = {
  clientId?: string
  assigneeId?: string
  editorIds?: string[]
}

export type ChecklistWriteItem = {
  assigneeId?: string
}

export type ChecklistWriteArgs = {
  user: ChecklistWriteUser | undefined
  checklist: ChecklistWriteTarget | undefined
  visibleClientIds?: Set<string>
}

export type ChecklistItemWriteArgs = ChecklistWriteArgs & {
  item?: ChecklistWriteItem
}

export function canWriteChecklist(args: ChecklistWriteArgs): boolean
export function canWriteChecklistItem(args: ChecklistItemWriteArgs): boolean
export function checklistWriteDenial(
  args: ChecklistItemWriteArgs & { error?: string },
): null | { status: 403; error: string }
