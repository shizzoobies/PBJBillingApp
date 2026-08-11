/**
 * ONE answer to "which clients may be picked for new work?".
 *
 * Retiring a client is a visibility flag, not a delete: `lifecycleStage:
 * 'inactive'` keeps every time entry, checklist, invoice and report row exactly
 * where it was, and only stops the client being OFFERED for anything new. That
 * distinction has to hold across a dozen dropdowns, and before this file each
 * one derived its own list (see the comment on {@link selectableClients}), so a
 * retired client would have kept showing up in whichever picker was missed.
 *
 * The rule of thumb for callers:
 *   - a picker that CREATES something (timer, manual entry, split, new task,
 *     template copy, team assignment, invoice run) → `selectableClients`;
 *   - a filter/label over data that already exists (reports, timesheets,
 *     approvals, invoice history, board filters, Client Recap) → the raw list,
 *     because history must never lose its subject.
 */
import type { Client, LifecycleStage } from './types'

/**
 * The effective lifecycle stage of a client. Absent ⇒ 'active': every client
 * predating the field is a working client, and must never read as a prospect.
 */
export function lifecycleOf(client: Pick<Client, 'lifecycleStage'>): LifecycleStage {
  return client.lifecycleStage ?? 'active'
}

/** Has this client been retired? */
export function isInactiveClient(client: Pick<Client, 'lifecycleStage'>): boolean {
  return lifecycleOf(client) === 'inactive'
}

/**
 * The clients a picker may offer for NEW work — everything except retired ones.
 *
 * `keepIds` re-admits clients that are already bound to the thing being edited
 * (the entry's current client, the template's current client). Dropping them
 * would leave a `<select>` with a value that matches no option, which renders
 * blank and silently re-points the record on the next save — a worse outcome
 * than showing one retired name in one dropdown.
 */
export function selectableClients<T extends Pick<Client, 'id' | 'lifecycleStage'>>(
  clients: readonly T[],
  keepIds: readonly (string | null | undefined)[] = [],
): T[] {
  const keep = new Set(keepIds.filter((id): id is string => Boolean(id)))
  return clients.filter((client) => !isInactiveClient(client) || keep.has(client.id))
}

/**
 * What "Mark inactive" actually does, named in full before it happens — one
 * copy, because the action sits on both the Clients list and the client detail
 * page and the two must not describe the same button differently.
 *
 * Every verb here is about visibility, and the last paragraph is the one that
 * matters: this is not a delete, and it is reversible from the same place.
 */
export function markInactiveConfirm(clientName: string): string {
  return [
    `Mark ${clientName} inactive?`,
    '',
    'They will be hidden from the client list, from the client pickers for time',
    'tracking, checklists and new work, and from the monthly invoice run. Their',
    'recurring checklists stop generating new instances.',
    '',
    'Nothing is deleted. All of their time entries, checklists, invoices, notes',
    'and reports stay exactly as they are, and you can reactivate them at any',
    'time to put everything back.',
  ].join('\n')
}
