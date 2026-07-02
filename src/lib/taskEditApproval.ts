/**
 * Pure helpers for the task-edit approval routing feature.
 *
 * In this app a "task" is a {@link Checklist} (title / due date / assignee) with
 * steps. When a NON-creator (and non-owner) edits a task's DETAILS or STEPS the
 * change is NOT applied directly — it's filed as a PENDING EDIT routed to the
 * task's CREATOR (or, for system/recurring/template tasks with no creator, the
 * firm owner). These helpers are IO-free and React-free so they can be unit
 * tested and shared between the server and the client.
 */

import type { Checklist, Employee, SessionUser } from './types'

/** Minimal user shape the approver resolver needs — a role + an id. */
export type ApproverUser = Pick<Employee, 'id'> & { role?: string }

/**
 * Who should approve a routed edit to `checklist`.
 *
 * Returns the checklist's `createdBy` when that is a real, present, NON-owner-
 * absent user id (i.e. the creator still exists in `users`). Otherwise — the
 * task is system-created (recurring / template / onboarding, `createdBy` unset)
 * or its creator is gone — the firm OWNER approves. Falls back to the raw
 * `createdBy` only if there is no owner at all (defensive; every workspace has
 * an owner).
 */
export function resolveTaskApprover(
  checklist: Pick<Checklist, 'createdBy'>,
  users: ApproverUser[],
): string {
  const list = Array.isArray(users) ? users : []
  const owner = list.find((u) => u.role === 'owner')
  const createdBy = checklist?.createdBy
  if (createdBy) {
    const creator = list.find((u) => u.id === createdBy)
    // A real creator who is NOT the owner is the approver. If the creator IS the
    // owner (or is missing), fall through to the owner path below.
    if (creator && creator.role !== 'owner') {
      return createdBy
    }
  }
  return owner?.id ?? createdBy ?? ''
}

/**
 * Whether `user` may edit `checklist`'s details/steps DIRECTLY (no routing).
 * True for the firm owner (owner override) and for the task's own creator; every
 * other user's structural edit is routed to the approver.
 */
export function canEditDirectly(
  user: Pick<SessionUser, 'id' | 'role'>,
  checklist: Pick<Checklist, 'createdBy'>,
): boolean {
  if (!user) return false
  return user.role === 'owner' || (!!checklist?.createdBy && checklist.createdBy === user.id)
}

/** The kind of edit a pending request carries. */
export type TaskEditScope = 'details' | 'item' | 'add_item'

/**
 * A human-readable one-line summary of a proposed edit for the approver queue,
 * e.g. `Title: "A" → "B"`. `proposed` holds the new field values; `prev` holds
 * the current ones. Only fields present in `proposed` are described. Falsy /
 * empty values render as "—". Returns a fallback string when nothing is named.
 */
export function summarizeProposedEdit(
  scope: TaskEditScope,
  proposed: Record<string, unknown>,
  prev: Record<string, unknown> = {},
): string {
  const patch = proposed ?? {}
  const before = prev ?? {}
  const show = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—'
    return `"${String(value)}"`
  }
  const parts: string[] = []
  const field = (key: string, label: string) => {
    if (key in patch) {
      parts.push(`${label}: ${show(before[key])} → ${show(patch[key])}`)
    }
  }
  if (scope === 'add_item') {
    return `Add step: ${show(patch.title ?? patch.label)}`
  }
  field('title', 'Title')
  field('dueDate', 'Due date')
  field('assigneeId', 'Assignee')
  if (parts.length === 0) {
    return scope === 'item' ? 'Edit step' : 'Edit task details'
  }
  return parts.join('; ')
}
