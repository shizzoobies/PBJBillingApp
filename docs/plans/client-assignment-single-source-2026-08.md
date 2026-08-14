# One source of truth for "who is assigned to this client"

**Date:** 2026-08-13 · **Status:** batch 1 implemented on this branch, not yet deployed

Client assignment is stored twice today, and the two copies disagree. This spec
collapses them to one. Batch 1 (this spec) makes the second copy inert and adds
the tests that fail when they drift. Batch 2 archives and drops it.

---

## 1. What exists today

Two parallel representations:

| | Where | Written by | Read by |
|---|---|---|---|
| `client_assignments` table → `assignedEmployeeIds` | `db/store.js:3906` maps it in | `write()` deletes all + re-inserts (`:4371`, `:4575`); `createClient` inserts (`:7368`) | 5 UI/store sites, listed below |
| `clients.assigned_bookkeeper_ids` → `assignedBookkeeperIds` | `db/store.js:3907` | `setClientAssignedTeam` (`:6626`), `grantClientVisibility` (`:6583`), `write()` (`:4544`), `createClient` (`:7347`), `backfillAssignedBookkeepers` (`:1091`) | everything that gates access |

**`assignedBookkeeperIds` is the load-bearing one.** It is the sole input to
`visibleClientIdSet` (`server.js:545`), which decides what a non-owner can see
and therefore what `scopeAppDataForSession` (`server.js:718`) sends them. It also
drives `timeTrackingClients` (`src/App.tsx:3592`), the "Who can see this client"
control (`src/pages/ClientDetailPage.tsx:824` → `server.js:7053`), `TeamPage`,
and the assistant's workspace snapshot (`server.js:395`).

**`assignedEmployeeIds` is not vestigial, but carries no meaning of its own.**
Five readers, all asking the same question and getting a stale answer:

- `src/App.tsx:1023` — client-side `visibleClientIds` (contradicts the server)
- `src/pages/ClientsPage.tsx:1045` — the team column on the Clients list
- `src/lib/completeness.ts:134` — the "Assign a team member to X" setup issue
- `src/pages/ChecklistsPage.tsx:1733` — checklist edit rights (OR'd with bookkeeper ids)
- `db/store.js:7757` — `startOnboarding`'s assignee fallback

### The two live bugs

**Bug 1 — a client added through the Add-client form is invisible to the team
you just picked.** The form sends only `assignedEmployeeIds`
(`src/pages/ClientsPage.tsx:525`). `createClient` binds `assigned_bookkeeper_ids`
from `assignedBookkeeperIds`, which is absent, so it inserts `{}`
(`db/store.js:7347`) and writes the picked team into `client_assignments`
(`db/store.js:7368`). The comment there — "so visibility works immediately" — is
wrong, and the test pinning it is named "keeps the team selection, which is what
drives client visibility" (`db/store-staleness.test.mjs:1352`). This is the
2026-08-13 incident: the table was populated, the accounts stayed empty.

**Bug 2 — every "Assigned team" edit widens the gap permanently.** That UI writes
only `assigned_bookkeeper_ids`. The next bulk save deletes all of
`client_assignments` and rebuilds it from the *unchanged* `assignedEmployeeIds`.
So the Clients-page team column drifts from the client detail page, and — because
scoped payloads keep `assignedEmployeeIds` intact (`server.js:721`) —
`src/App.tsx:1023` can hide a client the server legitimately granted.

### Why CI never caught this

`db/store.js` has two backends. The file backend stores `assignedEmployeeIds` as
a literal JSON field with no derivation and has no table at all; the divergence
only exists in Postgres. Tests run the file backend. **No file-backend test can
catch this** — the guard has to assert on the statements Postgres issues, via the
existing `fakePostgres()` harness in `db/store-staleness.test.mjs`.

### Secondary asymmetry (flagged, not fixed here)

`deleteTeamMember` on Postgres strips the user from `assigned_bookkeeper_ids`
(`db/store.js:9802`) but never from `client_assignments`; the file backend strips
both (`db/store.js:9893`). So the table currently holds deactivated users. It
stops mattering once the table is inert, and it is a reason to keep those rows
out of any merge decision.

---

## 2. Decisions taken

1. **One field, owners allowed.** A single concept of "assigned team" that may
   include owners. Storing an owner is display-only: the visibility rule is
   unchanged (owner ⇒ sees everything, membership irrelevant), so it grants
   nothing. This preserves what the Clients-page team column shows today.
2. **Report before merging.** At cutover some clients have people in
   `client_assignments` who are not in `assigned_bookkeeper_ids`. Those people
   see nothing today, so merging them in would **grant access that does not
   exist now**. Batch 1 ships a read-only report instead; Alex and Brittany
   decide per client.
3. **Alias-then-delete, not a column rename.** `assignedBookkeeperIds` stays
   canonical — it is already what every security-critical path reads, so that
   code does not move. Renaming the column that gates all non-owner visibility,
   on a Postgres-only path CI cannot see, is blast radius for a cosmetic gain.
   The naming wart (`assignedBookkeeperIds` holding owners) is a deliberate
   follow-up, not part of this work.

---

## 3. Design — batch 1

### 3.1 One stored representation

`clients.assigned_bookkeeper_ids` (Postgres) / `client.assignedBookkeeperIds`
(file JSON) is the only place assignment is stored. It may contain owners.
`client_assignments` becomes **inert**: still present, never read, never written.

### 3.2 `assignedEmployeeIds` becomes derived, in both backends

- **Postgres:** the read mapper (`db/store.js:3906`) sets `assignedEmployeeIds`
  from `assigned_bookkeeper_ids`. The `select … from client_assignments` query
  (`db/store.js:3611`) and its `assignmentsByClient` map are removed.
- **File:** `normalizeClientProfile` (`db/store.js:438`) sets the same alias,
  overriding whatever the object spread carried in.
- **Bulk save:** `write()` stops deleting (`:4371`) and re-inserting (`:4575`)
  `client_assignments`. It already persists `assigned_bookkeeper_ids` correctly
  (`:4544`) — unchanged.

Both backends now emit identical client shapes. That is cardinal rule 1
satisfied, and it is what makes a file-backend parity test meaningful.

### 3.3 The incident fix

`createClient` folds *either* inbound name into the canonical field:
`union(assignedBookkeeperIds, assignedEmployeeIds)`, filtered to known users, and
writes it to `assigned_bookkeeper_ids`. Its `insert into client_assignments`
(`:7368`) is removed. The Add-client form keeps working unchanged; it is also
updated to send the canonical name, so the union is transitional rather than
permanent.

### 3.4 Owners allowed — on explicit picks only

- `setClientAssignedTeam` (`db/store.js:6618`) drops its `role <> 'owner'`
  filter, still validating that ids are real users. Both backends.
- The Assigned-team picker (`AssignedTeamControl`) lists owners.
- `grantClientVisibility` (`:6569`) and `backfillAssignedBookkeepers` (`:1091`)
  **keep skipping owners**. These are implicit grants; an owner assigned one
  checklist should not silently join every client's team list.
- `visibleClientIdSet` is untouched.

### 3.5 One accessor for all readers

`getAssignedEmployeeIds` (`src/lib/utils.ts:500`) becomes `getAssignedTeamIds`,
returning `assignedBookkeeperIds ?? []`. The four UI read sites route through it:
`App.tsx:1023` (which is how the client-side filter stops contradicting the
server), `ClientsPage.tsx:1045`, `completeness.ts:134`,
`ChecklistsPage.tsx:1733`. `startOnboarding` (`db/store.js:7756`) loses its
second fallback arm.

`App.tsx:1023` keeps its existing union with own-checklist and own-time-entry
clients — that union only ever widens, and those clients are not in a non-owner's
payload anyway.

### 3.6 Tests that fail on divergence

Statement-level, through `fakePostgres()`:

- `write()` issues **no** `client_assignments` statement — neither delete nor insert.
- `createClient({ assignedEmployeeIds: ['emp-1'] })` binds
  `assigned_bookkeeper_ids: ['emp-1']`. Direct regression test for 2026-08-13.
- `visibleClientIdSet` sees a client built from the real Add-form payload. This test passes.

Invariant, both backends:

- A shared `expectOneTeamSource(client)` asserting `assignedEmployeeIds`
  deep-equals `assignedBookkeeperIds`, applied after every mutation path:
  `createClient`, `setClientAssignedTeam`, `grantClientVisibility`, a bulk-save
  round-trip, and `deleteTeamMember`.

Rewrites (not deletions) of the two tests encoding the wrong belief:
`db/store-staleness.test.mjs:1352` and `:1443`.

### 3.7 Read-only production report

A script under `scripts/` following the existing prod-diagnostic pattern.
**`select` only — no writes, no transaction that could be mistaken for one.**
Per client where the two disagree: client name, ids in the table but not in the
array, ids in the array but not the table, each with the user's name and
`inactive_at`. Output is the artifact Alex and Brittany decide from, and doubles
as proof the fix worked.

### 3.8 Docs

- `docs/HANDOFF.md:133` — currently says `assignedEmployeeIds` is "a
  frontend/legacy field with no DB column". True but incomplete; it now says
  derived-from, and names the one source of truth.
- `docs/capability-manifest.md` — user-visible change (cardinal rule 3): the team
  picked on the Add-client form can now actually see the client, and owners may
  appear on a team. Re-provision the voice agent after deploy.

---

## 4. Batch 2 — after the inert period

Only once batch 1 has been live long enough to prove nothing reads the table:

1. `create table client_assignments_archive as select * from client_assignments`
   — preserves `assigned_at`, which is the only history the table holds.
2. Drop `client_assignments`; remove it from `db/schema.sql:79`.
3. Remove it from `BULK_SAVE_TABLES` (`lib/workspace-version.js:62`). This
   changes the staleness fingerprint set and invalidates open tabs once —
   harmless, but worth doing outside Brittany's billing window.
4. Remove the orphan-cleanup delete (`db/store.js:8449`).
5. Remove the `assignedEmployeeIds` alias and its remaining type
   (`src/lib/types.ts:147`); rename the accessor's last callers.
6. Resolve the `deleteTeamMember` asymmetry, which the drop makes moot.

---

## 5. Out of scope

- Renaming `assigned_bookkeeper_ids` to something that does not say "bookkeeper"
  now that owners are allowed. Cosmetic; high blast radius.
- Any production write. Batch 1 writes nothing to prod; the report is read-only,
  and cardinal rule 5 governs whatever the report leads to.
- Changing who can see what. The visibility *rule* is untouched — this work only
  makes the stored answer singular.
