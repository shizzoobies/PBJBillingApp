import type { Checklist } from './types'

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
