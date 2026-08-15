/**
 * Who may WRITE to a checklist.
 *
 * `scopeAppDataForSession` deliberately sends a team member every checklist for
 * a client they're assigned to — a shared client needs shared visibility, and
 * that read scope is correct. Its comment claimed "edit/complete rights stay
 * gated to the assignee/editor in the write endpoints." That claim was false:
 * nearly every write endpoint accepted `|| clientVisible` as a sufficient
 * condition, so anyone assigned to the client could rename steps, add and
 * delete them, reorder them, flag waits and edit task details on a colleague's
 * active checklist. Brittany reproduced it from the Clients tab's Checklist
 * button. This module is the one place that decision now lives.
 *
 * The rule, in her words: an employee should not be able to edit another
 * employee's checklist they are not active on.
 *
 *   - Owners keep full rights, everywhere.
 *   - A non-owner may write only when the checklist's client is in their
 *     visible set AND they are the checklist's assignee or one of its
 *     `editorIds`.
 *   - For item-scoped writes a per-item assignee also counts — delegating a
 *     single step is an existing, deliberate feature.
 *
 * Client visibility stays as an AND (not a replacement) so an unassigned
 * client can never be written into by a stale assignee reference. That mirrors
 * `DELETE /api/checklists/:id`, the one endpoint that already had this right.
 *
 * Completing a step is stricter still and is NOT decided here: the toggle
 * endpoint requires the step's own responsible person. See the comment there.
 */

const DEFAULT_DENIAL =
  'This task belongs to someone else — you can view it, but only its assignee or an editor can change it.'

function isOwner(user) {
  return user?.role === 'owner'
}

function editorIdsOf(checklist) {
  return Array.isArray(checklist?.editorIds) ? checklist.editorIds : []
}

/**
 * Whole-checklist writes: task details, adding/reordering/deleting steps,
 * flagging a wait.
 *
 * @param {object} args
 * @param {{ id?: string, role?: string }} args.user session user
 * @param {{ clientId?: string, assigneeId?: string, editorIds?: string[] }} args.checklist
 * @param {Set<string>} [args.visibleClientIds] clients this user is assigned to
 * @returns {boolean}
 */
export function canWriteChecklist({ user, checklist, visibleClientIds }) {
  if (isOwner(user)) return true
  if (!user?.id || !checklist) return false
  if (!visibleClientIds?.has(checklist.clientId)) return false
  return checklist.assigneeId === user.id || editorIdsOf(checklist).includes(user.id)
}

/**
 * Item-scoped writes. Same rule plus the step's own assignee, since a step can
 * be handed to one person without handing over the whole task.
 *
 * @param {object} args
 * @param {{ id?: string, role?: string }} args.user session user
 * @param {{ clientId?: string, assigneeId?: string, editorIds?: string[] }} args.checklist
 * @param {{ assigneeId?: string }} [args.item] the parent ITEM (sub-items and
 *   sub-sub-items inherit their item's context)
 * @param {Set<string>} [args.visibleClientIds]
 * @returns {boolean}
 */
export function canWriteChecklistItem({ user, checklist, item, visibleClientIds }) {
  if (canWriteChecklist({ user, checklist, visibleClientIds })) return true
  if (!user?.id || !checklist) return false
  if (!visibleClientIds?.has(checklist.clientId)) return false
  return typeof item?.assigneeId === 'string' && item.assigneeId === user.id
}

/**
 * The 403 body for a refused write, or null when it's allowed. Endpoints pass
 * their own `error` so the message names the action that was refused.
 *
 * @param {object} args
 * @param {{ id?: string, role?: string }} args.user
 * @param {{ clientId?: string, assigneeId?: string, editorIds?: string[] }} args.checklist
 * @param {{ assigneeId?: string }} [args.item] present for item-scoped writes
 * @param {Set<string>} [args.visibleClientIds]
 * @param {string} [args.error] human message
 * @returns {null | { status: 403, error: string }}
 */
export function checklistWriteDenial({
  user,
  checklist,
  item,
  visibleClientIds,
  error = DEFAULT_DENIAL,
}) {
  const allowed = item
    ? canWriteChecklistItem({ user, checklist, item, visibleClientIds })
    : canWriteChecklist({ user, checklist, visibleClientIds })
  return allowed ? null : { status: 403, error }
}
