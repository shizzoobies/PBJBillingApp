# Team vs. visibility: two meanings, one field — the split

Written 2026-09-04, the day Brittany reported that "some of her people can
see invoices for clients they aren't assigned to." She is right, and the
Invoice Recap's gate is not the bug. The word "assigned" has meant two things
in this app since the visibility system was built, and the recap is the first
surface where the difference costs money.

## 0. The decision (Alex, 2026-09-04)

1. **Contain now:** the Invoice Recap is owner-only (page and API) until the
   split ships. Shipped the same day.
2. **Build the split** below.
3. **Reset team lists to explicit-only, Brittany re-picks.** One approved
   production write with a committed snapshot; task visibility is computed
   from that point on, so nobody loses a checklist or a time dropdown.

## 1. What is actually happening (read-only reproduction, 2026-09-04)

`clients.assigned_bookkeeper_ids` is the one field that gates what a
non-owner can see. It is written two ways:

- **Explicitly** — an owner picks the team on the client's page or the Team
  page (`PUT /api/clients/:id/assigned-team`). Nobody has done this since at
  least early August; `client_team_updated` does not appear in the activity
  log.
- **Implicitly** — `grantClientVisibility` adds a person to the client's team
  whenever a checklist, case, or template stage is assigned to them (six call
  sites in `server.js` plus one in `lib/assistant.js`), and
  `backfillAssignedBookkeepers` re-adds anyone named on a checklist or
  template on every workspace read (`db/store.js`, called from `read()`).

The result in production:

| Staffer | On the team of | Explicit picks | Task-derived |
|---|---|---|---|
| Lisa Mockabee | 35 clients | 2 (Fore Motion, Skyline) | 33 |
| Allison Lehmann | 15 clients | 2 (Bright Tower, Skyline) | 13 |

Lisa sees Welch Properties' invoice because of one checklist ("Clean up
2023"). Allison sees Emerald Custom Homes, Four Leaf, and Associated
Enterprises' invoices because she has "Clear Client Email" and "Payroll"
steps there. The UI itself says what the field is: the client page calls the
picker "Who can see this client" and the Team page calls the list "Clients
they can see". It was never "who works this account."

Ruled out: the owner-only `/api/invoices` route (correct); the legacy
`client_assignments` table (empty, inert); the KLC billing master
(`client-lamjjjc`, team empty, nobody sees INV-2026-08-045); the stale-save
race (the workspace fingerprint covers `clients`; two refusals on 2026-08-31
were logged correctly).

## 2. The model after the split

Two concepts, two sources:

- **Team** (`assignedBookkeeperIds`, unchanged name): the people an OWNER
  picked for this client. Only `setClientAssignedTeam` and `createClient`
  write it. **No task assignment ever widens it.** This is what gates money:
  the Invoice Recap, and any future staff-facing billing surface.
- **Visibility** (computed, never stored): `team ∪ clients where the person
  is the assignee of a live checklist, a recurring template, or a template
  stage`. This is what gates checklists, time logging, notes, and the client
  dropdowns — everything that is not money. It is exactly what the implicit
  grants were trying to produce, computed at read time instead of written
  into the team.

`visibleClientIdSet(session, clients)` in `server.js` becomes
`visibleClientIdSet(session, data)` and computes the union; a new
`teamClientIdSet(session, clients)` returns the explicit team only. Every
existing caller keeps calling `visibleClientIdSet` and sees no change. The
Invoice Recap calls `teamClientIdSet`. Owners bypass both, as today.

The client-side union in `App.tsx` (own-checklist and own-time-entry clients)
already does the visibility half for the SPA; it stays.

## 3. Steps

1. **`lib/data-scope.js`**: add `taskClientIdsForUser(data, userId)` (live
   checklists' `assigneeId`, templates' `assigneeId`, template stages'
   `assigneeId`; skip nothing for owners — owners never reach it) and
   `visibleClientIds(data, userId)` = team ∪ tasks. Unit tests on the leaf.
2. **`server.js`**: `visibleClientIdSet` reads through the new helper;
   `teamClientIdSet` added; `/api/invoice-recap` uses `teamClientIdSet` and
   the owner gate from the containment comes off. Route-glue test flips back
   to "session, not owner; scoped through teamClientIdSet".
3. **Stop the implicit writes**: `grantClientVisibility` becomes a no-op that
   logs once per process (kept so no call site changes in this commit; the
   call sites are removed in a follow-up), and `backfillAssignedBookkeepers`
   stops being called from `read()`. BOTH backends (cardinal rule 1); the
   file backend's `grantClientVisibility` branch too.
4. **Copy**: client page picker → "Assigned team — who works this account
   (owner-picked). Task assignees see the client's checklists and can log
   time either way; only the assigned team sees its invoices." Team page
   list → "Assigned clients". Manifest section updated, voice agent
   re-provisioned.
5. **Production reset** (needs Alex's explicit yes at the time; snapshot to
   `docs/prod-snapshots/` first, undo statement in the log): for every
   client, `assigned_bookkeeper_ids` := the ids with NO task on that client
   (the provably explicit ones: Lisa on Fore Motion + Skyline, Allison on
   Bright Tower + Skyline, the two test accounts everywhere they are now, the
   two owner-only clients). Everything task-derived is dropped — it is
   recomputed as visibility from that moment. Then Brittany picks the real
   team per client on the Team page; the Invoice Recap reopens to staff on
   the deploy that ships step 2, which can land before or after her pass
   (with an empty team a staffer sees nothing, which is the safe direction).
6. Handoff entry; tracker item for Brittany in her words: "the recap is back
   for staff; pick each client's team on the Team page — that list now
   decides who sees the client's invoices; tasks no longer add people to it."

## 3.6 Draft note for Brittany's tracker item (`featreq-0c2d4ce5` dev_notes)

Not yet posted — the in-session write was blocked; Alex posts it or approves
the write. Paste as-is:

> [2026-09-04 — you are right, and here is why it happened] Checked against
> the live data: Allison is on 15 clients' team lists, and 13 of those came
> from TASKS, not from anyone picking her. The app has always added a person
> to a client's team automatically the moment they are given a checklist on
> that client (so they can see the checklist). That was fine while it only
> controlled checklists — the Invoice Recap then used the same list, so a
> single "Clear Client Email" or "Payroll" step on Emerald or Four Leaf made
> their invoices visible to her. Lisa is the same: 33 of her 35 clients are
> from tasks.
>
> WHAT IS DONE NOW: the Invoice Recap is owner-only (deployed today). Your
> team no longer sees it at all, so nobody can see an invoice they should
> not.
>
> WHAT COMES NEXT: the team list will become one only an owner picks — a
> task will never add anyone to it again — and only that list decides who
> sees a client's invoices. Tasks will still show people the checklists they
> are given. Once that ships, the team lists will be reset to the deliberate
> picks and you pick each client's real team once on the Team page; the
> recap reopens to staff with that rule. Alex will confirm the reset with
> you before it runs.

## 4. What does not change

- Owners see everything, everywhere.
- The month-lock, waiting-on, checklist-edit, and time-entry rules are
  untouched; they read visibility, which is a superset of what they read
  today (equal, once the reset happens and tasks are recomputed).
- Invoices are never on the bulk save payload; nothing here touches money
  calculation.
