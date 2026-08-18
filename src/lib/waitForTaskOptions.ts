import type { Checklist, Client } from './types'

/** One row in the waiting editor's "waiting for another task to finish" select. */
export type WaitForTaskOption = { id: string; title: string }

/**
 * What the "waiting for another task to finish" dropdown offers on one step.
 *
 * The owner's report (featreq-5dd514b8): the picker "lists all tasks across the
 * app, regardless of client… too many unrelated options to sort through". So the
 * rule is SAME CLIENT ONLY — a step on Acme's task can only wait on another of
 * Acme's tasks. It is also the honest rule for the notification this powers: the
 * "Ready to continue" ping fires when the named task completes, and a task on a
 * different client's books is never the thing actually holding this step up.
 *
 * TWO LISTS, DELIBERATELY. `offerable` is what may be CHOSEN; `all` is what a
 * saved choice may be RESOLVED against. They are not the same set, and
 * collapsing them is what breaks the feature in both directions:
 *
 * - `offerable` must be the app's own notion of a task you could work on —
 *   `visibleChecklists`, i.e. unskipped (a skipped occurrence would be a
 *   dependency that never completes, so the ping never fires) and visible to
 *   this viewer (a bookkeeper shouldn't be offered a task they can't open).
 * - `all` must be UNFILTERED — every active checklist plus
 *   `AppData.recycledChecklists`, which the store hands over as a separate array
 *   (see `db/store.js`'s `checklists` / `recycledChecklists` split). A step
 *   pointing at a task that was since skipped, recycled, or scoped away from
 *   this viewer must still show that link, or the box reads "not waiting on a
 *   task" while the record says otherwise.
 *
 * Three edges the filter must not get wrong:
 *
 * 1. **The task itself** is never offered — a step cannot wait on its own task.
 * 2. **A no-client task** (an internal/admin one, `clientId` empty) sees only
 *    other no-client tasks. That falls out of the same-client rule rather than
 *    being a special case: empty matches empty. The alternative — showing an
 *    internal task every client task in the workspace — is exactly the pile the
 *    owner asked us to remove.
 * 3. **An already-saved link is preserved**, whatever the filter says about it.
 *    Dropping the row would render the select with a value none of its options
 *    carry, and when the client has no other offerable tasks the row is hidden
 *    outright — leaving no way to change or remove the task link on its own,
 *    short of retiring the whole wait with Done or Clear. So `selectedId` is
 *    always appended when it resolves, and a CROSS-CLIENT one carries its
 *    client's name in the label so it doesn't read as one of this client's
 *    tasks (two clients can hold identically titled tasks).
 *
 * Pure — unit-tested.
 */
export function waitForTaskOptions({
  offerable,
  all,
  clients = [],
  checklistId,
  selectedId,
}: {
  /** Choosable tasks — the viewer's unskipped, visible feed. */
  offerable: Checklist[]
  /** Resolution pool for `selectedId` — actives + recycled, unfiltered. */
  all: Checklist[]
  /** Only used to name the client on an appended cross-client option. */
  clients?: Client[]
  checklistId: string
  selectedId?: string | null
}): WaitForTaskOption[] {
  const pool = all ?? []
  // Resolved from the unfiltered pool: this task may itself be skipped or
  // scoped out of `offerable`, and losing its client would empty the list.
  const current = pool.find((entry) => entry.id === checklistId)
  const currentClientId = current?.clientId ?? ''
  const options: WaitForTaskOption[] = current
    ? (offerable ?? [])
        .filter(
          (entry) => entry.id !== checklistId && (entry.clientId ?? '') === currentClientId,
        )
        .map((entry) => ({ id: entry.id, title: entry.title }))
    : []

  if (selectedId && !options.some((option) => option.id === selectedId)) {
    const selected = pool.find((entry) => entry.id === selectedId)
    if (selected) {
      const crossClient = (selected.clientId ?? '') !== currentClientId
      const owner = crossClient
        ? (clients ?? []).find((client) => client.id === selected.clientId)?.name
        : undefined
      options.push({ id: selected.id, title: owner ? `${selected.title} (${owner})` : selected.title })
    }
  }

  return options
}
