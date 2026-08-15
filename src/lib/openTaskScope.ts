import { getAssignedTeamIds } from './utils'
import type { Checklist, Client } from './types'

/**
 * Whose open tasks a given viewer's "open tasks" affordance should count.
 *
 * Brittany's rule: the badge shows the viewer's OWN open tasks, and for an
 * accountant it also covers the bookkeepers whose clients they oversee.
 *
 * WHY IT IS DONE BY SHARED CLIENT AND NOT BY HIERARCHY: there is no
 * accountant→bookkeeper supervision relationship anywhere in the data. The
 * only user-to-user link the schema has is `clients.assigned_bookkeeper_ids`
 * (see `lib/data-scope.js` — it is the single source of truth for assignment);
 * there is no supervisor id, no team table, no reports-to column. "Their
 * bookkeepers" is therefore read as "the people staffed alongside them on the
 * clients they are assigned to." If a real hierarchy is added later, this is
 * the one function to change.
 *
 * Returns `null` for "no restriction — count everyone", which is what an owner
 * gets. A Set is returned for everyone else so callers can test membership
 * without caring which rule produced it.
 */
export function openTaskAssigneeScope({
  viewerId,
  isOwner,
  staffRole,
  clients,
}: {
  viewerId: string
  isOwner: boolean
  /** Display staff role — 'Owner' | 'Accountant' | 'Bookkeeper'. */
  staffRole?: string
  clients: Client[]
}): Set<string> | null {
  if (isOwner) return null
  const scope = new Set<string>()
  if (viewerId) scope.add(viewerId)
  if (staffRole !== 'Accountant') return scope

  for (const client of clients ?? []) {
    const team = getAssignedTeamIds(client)
    if (!team.includes(viewerId)) continue
    for (const memberId of team) scope.add(memberId)
  }
  return scope
}

/**
 * Apply a scope from `openTaskAssigneeScope` to a checklist list.
 *
 * An UNASSIGNED task belongs to nobody, so it is not "your" open task and does
 * not count for a scoped viewer. Owners (scope `null`) still see it.
 */
export function scopeChecklistsToOpenTaskOwners(
  checklists: Checklist[],
  scope: Set<string> | null,
): Checklist[] {
  if (!scope) return checklists
  return (checklists ?? []).filter((checklist) => scope.has(checklist.assigneeId ?? ''))
}
