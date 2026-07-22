/**
 * Pure data-scoping rules shared by the server (and its tests).
 *
 * `scopeAppDataForSession` in server.js strips the workspace down to what a
 * non-owner may see. These helpers hold the individual visibility predicates so
 * the security-relevant logic can be unit-tested without booting the server.
 */

/**
 * Whether a checklist TEMPLATE is visible to a scoped (non-owner) session.
 *
 * - Client-agnostic "standard" blueprints (`isStandard`) carry no client or
 *   billing data and are the firm's reusable recipes, so every team member may
 *   view them (they can see what standard work exists instead of re-creating
 *   it).
 * - Client-bound recurring templates are visible only when the member is
 *   assigned to that template's client (its id is in `allowedClientIds`).
 *
 * @param {{ isStandard?: boolean, clientId?: string }} template
 * @param {Set<string>} allowedClientIds - client ids this member is assigned to.
 * @returns {boolean}
 */
export function isTemplateVisibleToScope(template, allowedClientIds) {
  if (!template) return false
  if (template.isStandard) return true
  return Boolean(allowedClientIds) && allowedClientIds.has(template.clientId)
}

/**
 * Whether a TIME ENTRY is visible to a scoped (non-owner) session.
 *
 * Always and only the member's OWN entries. Beyond that:
 * - Administrative time has no client, so client scoping can't apply.
 * - An unsplit GROUP holding entry also has no single client — the member
 *   clients live in `groupClientIds` until the block is split for billing. It
 *   must stay visible to whoever tracked it, or they can't see, edit or split
 *   their own time. (Only the count is surfaced in the UI, never the member
 *   client names, so this reveals nothing about clients they aren't assigned to.)
 * - Everything else is client-bound and needs that client in their assigned set.
 *
 * Omitting the group case is what made an owner's totals disagree with the
 * bookkeeper's: the owner saw 15 entries for a day where the bookkeeper saw 10.
 *
 * @param {{ employeeId?: string, isAdministrative?: boolean, clientId?: string, groupClientIds?: string[] }} entry
 * @param {string} userId - the session member's id.
 * @param {Set<string>} allowedClientIds - client ids this member is assigned to.
 * @returns {boolean}
 */
export function isTimeEntryVisibleToScope(entry, userId, allowedClientIds) {
  if (!entry || entry.employeeId !== userId) return false
  if (entry.isAdministrative) return true
  if (!entry.clientId && Array.isArray(entry.groupClientIds) && entry.groupClientIds.length > 0) {
    return true
  }
  return Boolean(allowedClientIds) && allowedClientIds.has(entry.clientId)
}
