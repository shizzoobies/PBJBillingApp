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
