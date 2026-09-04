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

/**
 * The assigned team for a client — the ONE source of truth.
 *
 * Assignment used to be stored twice: this array, and a `client_assignments`
 * table surfaced as `assignedEmployeeIds`. Only this array ever gated access,
 * so the other copy could (and did) disagree silently — a client added through
 * the Add-client form landed its team in the table and left this array empty,
 * making the client invisible to the very people just assigned to it.
 * `assignedEmployeeIds` is now a derived alias of this field; nothing reads the
 * table. See docs/plans/client-assignment-single-source-2026-08.md.
 *
 * Deliberately reads ONLY `assignedBookkeeperIds`, never the alias — accepting
 * the alias as an input would let the old field become a second source again.
 *
 * May contain owners: an owner sees every client regardless, so owner
 * membership is a display fact, not an access grant.
 *
 * @param {{ assignedBookkeeperIds?: string[] } | null | undefined} client
 * @returns {string[]}
 */
export function assignedTeamIds(client) {
  if (!client || !Array.isArray(client.assignedBookkeeperIds)) return []
  return [...new Set(client.assignedBookkeeperIds.filter((id) => typeof id === 'string' && id))]
}

/**
 * Whether a non-owner may see this client. Owner sessions bypass this entirely
 * (see `visibleClientIdSet` in server.js).
 *
 * @param {{ assignedBookkeeperIds?: string[] } | null | undefined} client
 * @param {string} userId
 * @returns {boolean}
 */
export function isClientVisibleToUser(client, userId) {
  if (!userId) return false
  return assignedTeamIds(client).includes(userId)
}

/**
 * The client ids a user reaches through TASK ASSIGNMENT — the VISIBILITY half
 * of what "assigned" used to mean.
 *
 * Until 2026-09-04 this set was WRITTEN into `assignedBookkeeperIds` (by
 * `grantClientVisibility` on every assignment, and re-derived on every read by
 * `backfillAssignedBookkeepers` in db/store.js), which made a client's team
 * list say "everyone who ever held a task here" — 33 of Lisa's 35 clients, 13
 * of Allison's 15. That is the right answer for checklists and time and the
 * wrong answer for money, and the Invoice Recap read the same field. It is
 * computed here instead of stored, so the team stays exactly what an owner
 * picked. See docs/plans/team-visibility-split-2026-09.md.
 *
 * The three sources mirror `backfillAssignedBookkeepers` EXACTLY, because this
 * has to reproduce the visibility those grants produced, no more:
 *   1. a live checklist's `assigneeId`,
 *   2. a recurring template's `assigneeId`,
 *   3. a template STAGE's `assigneeId`.
 * Step-level item assignees do NOT count — they never did.
 *
 * No owner special-case: owners bypass scoping entirely before they get here
 * (`visibleClientIdSet` in server.js), so a role filter in this leaf would be
 * dead code pretending to be a rule.
 *
 * @param {{ checklists?: Array<{ clientId?: string, assigneeId?: string }>, checklistTemplates?: Array<{ clientId?: string, assigneeId?: string, stages?: Array<{ assigneeId?: string }> }> } | null | undefined} data
 * @param {string} userId
 * @returns {Set<string>}
 */
export function taskClientIdsForUser(data, userId) {
  const ids = new Set()
  if (!data || !userId) return ids
  for (const checklist of data.checklists ?? []) {
    if (checklist?.clientId && checklist.assigneeId === userId) ids.add(checklist.clientId)
  }
  for (const template of data.checklistTemplates ?? []) {
    if (!template?.clientId) continue
    if (template.assigneeId === userId) ids.add(template.clientId)
    for (const stage of template.stages ?? []) {
      if (stage?.assigneeId === userId) ids.add(template.clientId)
    }
  }
  return ids
}

/**
 * Every client id a non-owner may SEE: the owner-picked team they are on, plus
 * every client they hold a task on. This gates checklists, time logging, notes
 * and the client dropdowns — everything that is not money. It is deliberately a
 * SUPERSET of the team; the team alone gates invoices (`teamClientIdSet` in
 * server.js).
 *
 * Owners never call this — they see everything (`visibleClientIdSet`).
 *
 * @param {{ clients?: Array<{ id?: string, assignedBookkeeperIds?: string[] }> } | null | undefined} data
 * @param {string} userId
 * @returns {Set<string>}
 */
export function visibleClientIdsForUser(data, userId) {
  const ids = new Set()
  if (!data || !userId) return ids
  for (const client of data.clients ?? []) {
    if (client?.id && isClientVisibleToUser(client, userId)) ids.add(client.id)
  }
  for (const id of taskClientIdsForUser(data, userId)) ids.add(id)
  return ids
}
