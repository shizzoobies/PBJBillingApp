/**
 * Who may copy a checklist template onto a client.
 *
 * Extracted from the `POST /api/checklist-templates/:id/apply-to-client`
 * handler so the decision can be unit-tested. The handler had a bug this file
 * exists to prevent recurring: it compared `session.user.role` against the
 * DATABASE role `'senior_bookkeeper'`, but `mapSessionUser()` collapses role to
 * `'owner' | 'employee'` before a session ever sees it. The check could never
 * be true, so accountants were refused outright. The staff role — Owner /
 * Accountant / Bookkeeper — is the field that identifies an accountant.
 *
 * The rules:
 *   - Owners may apply ANY template to ANY client.
 *   - Accountants may apply a STANDARD blueprint to a client they are assigned
 *     to. They could already read the blueprint library and were told to "ask
 *     an owner"; this lets them do it themselves.
 *   - Bookkeepers are unchanged and still ask.
 *
 * Both non-owner restrictions are security boundaries, not UI conveniences: a
 * standard blueprint carries no other client's data, and the target must be a
 * client they can actually see — otherwise this endpoint would be a side door
 * into a client they are not assigned to.
 */

/**
 * Stage 1 — the role gate. Evaluated BEFORE the template is loaded so a
 * bookkeeper cannot use the response code to probe which template ids exist.
 *
 * @param {{ role?: string, staffRole?: string }} user session user
 * @returns {null | { status: number, error: string }} null when allowed
 */
export function templateApplyRoleDenial(user) {
  if (isOwner(user)) return null
  if (user?.staffRole === 'Accountant') return null
  return {
    status: 403,
    error: 'Only owners and accountants can apply templates to clients',
  }
}

/**
 * Stage 2 — the non-owner restrictions, once the template and target client
 * are known. Owners are exempt.
 *
 * @param {object} args
 * @param {{ role?: string, staffRole?: string }} args.user session user
 * @param {{ isStandard?: boolean }} args.template the SOURCE template
 * @param {string} args.clientId target client
 * @param {Set<string>} args.visibleClientIds clients this user is assigned to
 * @returns {null | { status: number, error: string }} null when allowed
 */
export function templateApplyScopeDenial({ user, template, clientId, visibleClientIds }) {
  if (isOwner(user)) return null
  if (!template?.isStandard) {
    return {
      status: 403,
      error: 'Accountants can apply standard checklists only — ask an owner for this one',
    }
  }
  if (!visibleClientIds?.has(clientId)) {
    return {
      status: 403,
      error: 'You can only apply a checklist to a client you are assigned to',
    }
  }
  return null
}

function isOwner(user) {
  return user?.role === 'owner'
}
