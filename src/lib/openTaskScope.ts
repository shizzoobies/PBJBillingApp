import type { Checklist, ChecklistTemplate, Employee } from './types'

/**
 * Whose open tasks a given viewer's "open tasks" affordance should count.
 *
 * Brittany's rule: the badge shows the viewer's OWN open tasks, and for an
 * accountant it also covers the bookkeepers whose clients they oversee.
 *
 * WHY IT READS THE FEED AND NOT `assigned_bookkeeper_ids` (featreq-4fa0e70f):
 * this used to name that field as the deliberate stand-in for a hierarchy —
 * "her bookkeepers" meant the explicit team of the clients she was ALSO
 * explicitly on. The 2026-09-04 team/visibility split retired that reasoning.
 * The explicit team is now the MONEY gate: the list an owner picked by hand,
 * and the only thing that opens a client's invoices (`teamClientIdSet` in
 * server.js). Task visibility became COMPUTED instead — you can see a client
 * because you hold work on it (`visibleClientIdsForUser`, lib/data-scope.js).
 * An accountant who reaches ten clients that way is explicitly teamed on none
 * of them, so the old rule returned nothing but herself and hid her
 * bookkeepers' work. Re-picking the teams to fix it would hand her those
 * clients' invoices too — the leak the split was built to close.
 *
 * So this reads the computed side: her bookkeepers are the people holding live
 * work on the clients she can see. The feed handed in is already narrowed to
 * those clients by the server (`scopeAppDataForSession`), so its assignees ARE
 * that set. The three sources mirror `taskClientIdsForUser` exactly — a
 * checklist's assignee, a recurring template's, and a template stage's.
 *
 * AN OWNER IS NEVER ONE OF HER BOOKKEEPERS. The firm owner works clients too —
 * Brittany Ferguson holds open checklists on four of Allison's — and reading
 * assignees straight off the feed would sweep those in and show them to an
 * accountant as work "under her". They are filtered back out here rather than
 * at each call site, so the Board, the Completed tab and the Clients badge
 * cannot drift apart on it. The viewer is never filtered out of their own
 * scope, whatever role they hold.
 *
 * Returns `null` for "no restriction — count everyone", which is what an owner
 * gets. A Set is returned for everyone else so callers can test membership
 * without caring which rule produced it.
 */
export function openTaskAssigneeScope({
  viewerId,
  isOwner,
  staffRole,
  checklists,
  checklistTemplates,
  employees,
}: {
  viewerId: string
  isOwner: boolean
  /** Display staff role — 'Owner' | 'Accountant' | 'Bookkeeper'. */
  staffRole?: string
  /** The session's own checklist feed — already scoped to its visible clients. */
  checklists: Checklist[]
  /** The session's recurring templates, when the caller holds them. */
  checklistTemplates?: ChecklistTemplate[]
  /** The team roster, read only to keep owners out of an accountant's scope. */
  employees?: Employee[]
}): Set<string> | null {
  if (isOwner) return null
  const scope = new Set<string>()
  if (viewerId) scope.add(viewerId)
  if (staffRole !== 'Accountant') return scope

  for (const checklist of checklists ?? []) {
    if (checklist?.assigneeId) scope.add(checklist.assigneeId)
  }
  for (const template of checklistTemplates ?? []) {
    if (template?.assigneeId) scope.add(template.assigneeId)
    for (const stage of template?.stages ?? []) {
      if (stage?.assigneeId) scope.add(stage.assigneeId)
    }
  }
  for (const employee of employees ?? []) {
    if (employee?.role === 'Owner' && employee.id !== viewerId) scope.delete(employee.id)
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
