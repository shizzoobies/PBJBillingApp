import { openTaskAssigneeScope, scopeChecklistsToOpenTaskOwners } from './openTaskScope'
import type { Checklist, Client } from './types'

/**
 * The checklists a viewer is shown as THEIRS.
 *
 * The server sends a team member every checklist for a client they're assigned
 * to — deliberately, because a shared client needs shared visibility. That is
 * the raw feed, not what any "my work" surface should render. This is the
 * narrowing every such surface uses: the Checklists tab's In-progress list, and
 * the client Checklist button's active-tasks panel.
 *
 * Extracted from `App.tsx` so the rule can be tested on its own. It is the
 * client-side half of the same boundary `lib/checklist-write-permission.js`
 * enforces on writes — an employee should not be handed, or able to edit,
 * another employee's checklist.
 *
 * `viewerIds` is included because it is an explicit, owner-granted share: the
 * owner naming you a viewer on a task is a decision to show it to you.
 */
export function checklistsVisibleTo(
  checklists: Checklist[],
  { viewerId, isOwner }: { viewerId: string; isOwner: boolean },
): Checklist[] {
  if (isOwner) return checklists
  return (checklists ?? []).filter(
    (checklist) =>
      checklist.assigneeId === viewerId || (checklist.viewerIds ?? []).includes(viewerId),
  )
}

/**
 * The people an accountant's Board toggle may reveal — "the bookkeepers under
 * her", in the owner's words.
 *
 * THE DERIVATION, NAMED SO IT CAN BE CORRECTED: there is no supervisor field
 * anywhere in this data. `clients.assigned_bookkeeper_ids` is the only
 * user-to-user link the schema has (see `lib/data-scope.js`) — no reports-to
 * column, no team table. So "under her" is read as "the people staffed
 * alongside her on the clients she is assigned to", exactly the substitution
 * the open-task badge already makes (`openTaskAssigneeScope`). If a real
 * hierarchy is ever added, that function and this one are the two to change.
 *
 * Empty for a bookkeeper, for an owner (who already sees everything), and for
 * an accountant who happens to be alone on all of her clients — the Board uses
 * that to decide whether the toggle is worth showing at all.
 */
export function boardTeamMemberIds({
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
}): string[] {
  if (isOwner) return []
  const scope = openTaskAssigneeScope({ viewerId, isOwner: false, staffRole, clients })
  return [...(scope ?? [])].filter((id) => id !== viewerId).sort()
}

/**
 * What the Board shows a given viewer.
 *
 * The owner's rework of featreq-9b47ab5b: "The standard view should be
 * checklists they are active on only — a bookkeeper should only see hers and an
 * accountant should see hers, and [a] button like show upcoming that she could
 * see those under her."
 *
 * So: ACTIVE ON = the same predicate every other "my work" surface uses
 * ({@link checklistsVisibleTo} — the task's assignee, or a viewer the owner
 * explicitly named). An OWNER is untouched: Brittany reviews the whole board.
 * An accountant with `includeTeam` also gets her teammates' tasks, which the
 * cards themselves still render read-only (only an assignee, a named editor, or
 * an owner can write — `lib/checklist-write-permission.js` re-checks the same).
 *
 * `checklists` must be the feed the session already holds (every task for a
 * client it is assigned to). This only ever NARROWS that feed — the reveal
 * cannot show work the session was not already sent.
 */
export function boardChecklistsFor(
  checklists: Checklist[],
  {
    viewerId,
    isOwner,
    staffRole,
    clients,
    includeTeam = false,
  }: {
    viewerId: string
    isOwner: boolean
    staffRole?: string
    clients: Client[]
    includeTeam?: boolean
  },
): Checklist[] {
  if (isOwner) return checklists ?? []
  const mine = checklistsVisibleTo(checklists, { viewerId, isOwner: false })
  if (!includeTeam) return mine
  const scope = openTaskAssigneeScope({ viewerId, isOwner: false, staffRole, clients })
  const mineIds = new Set(mine.map((checklist) => checklist.id))
  const theirs = scopeChecklistsToOpenTaskOwners(checklists, scope).filter(
    (checklist) => !mineIds.has(checklist.id),
  )
  return [...mine, ...theirs]
}
