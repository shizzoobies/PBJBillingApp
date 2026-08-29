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
 *   - a picker that offers a client for WORK (timer, manual entry, split, new
 *     task, template copy) → `workableClients`;
 *   - a picker that CREATES something else about a client (team assignment,
 *     invoice run) → `selectableClients`;
 *   - a filter/label over data that already exists (reports, timesheets,
 *     approvals, invoice history, board filters, Client Recap) → the raw list,
 *     because history must never lose its subject.
 *
 * The work/not-work split is the second reason a client can be unofferable, and
 * it arrived with consolidated billing: a BILLING MASTER is a payer, not a
 * company anyone works for. See {@link workableClients}.
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

/** Is this client a billing master — a payer that holds no work of its own? */
export function isBillingMasterClient(client: Pick<Client, 'isBillingMaster'>): boolean {
  return client.isBillingMaster === true
}

/**
 * The clients a picker may offer to be WORKED — `selectableClients`, minus the
 * billing masters.
 *
 * A billing master exists to be invoiced, not to be worked: it holds no time
 * entries, checklists, estimates or recurring reimbursements, and the server
 * refuses writes of any of them against it. Offering "KLC Master" in the timer
 * dropdown is therefore an invitation to a refusal — the app should not present
 * a choice it will not honor. This is the UI half of the plan's "hide those
 * surfaces in the UI for a master"; the server-side guard is the half that
 * makes it safe rather than merely tidy.
 *
 * `keepIds` re-admits for the same reason it does above, and it matters MORE
 * here: a record already pointed at a master (data written before the guard, or
 * before a client became one) must keep its own name in its own dropdown, or
 * the select renders blank and the next save silently re-points it.
 *
 * Masters are still offered wherever they are legitimately addressed — the
 * invoice month run, the client list and detail pages, and the Client Recap
 * picker, which is where their roll-up lives.
 */
export function workableClients<
  T extends Pick<Client, 'id' | 'lifecycleStage' | 'isBillingMaster'>,
>(clients: readonly T[], keepIds: readonly (string | null | undefined)[] = []): T[] {
  const keep = new Set(keepIds.filter((id): id is string => Boolean(id)))
  return selectableClients(clients, keepIds).filter(
    (client) => !isBillingMasterClient(client) || keep.has(client.id),
  )
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
