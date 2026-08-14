# Client Assignment — One Source of Truth (Batch 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `clients.assigned_bookkeeper_ids` the only stored answer to "who is assigned to this client", leave `client_assignments` inert, and add tests that fail if the two ever disagree again.

**Architecture:** `assignedBookkeeperIds` stays canonical — it is already what every access-gating path reads, so security-critical code does not move. `assignedEmployeeIds` becomes a derived read-only alias emitted by both backends' read mappers. The visibility predicate moves into `lib/data-scope.js`, which `server.js` already imports and which the frontend's `src/lib/utils.ts` can re-export — so the server and the UI share one definition rather than two that drift. `client_assignments` stops being read and written; dropping it is batch 2.

**Tech Stack:** Node (ESM, no TypeScript in `db/` `lib/` `server.js`), React + TypeScript in `src/`, Postgres via `pg`, Vitest.

**Spec:** [`docs/plans/client-assignment-single-source-2026-08.md`](client-assignment-single-source-2026-08.md). Read it first — it holds the evidence and the two decisions (owners allowed; report before merging).

## Global Constraints

- **`db/store.js` has TWO backends.** Every persisted change must touch both the Postgres branch (`if (this.pool)`) and the JSON-file branch. Tests run the file backend; production is Postgres.
- **`npm run verify`** (eslint + `tsc -b && vite build` + vitest) must be green before every push.
- **No production writes.** Nothing in this plan writes to prod. Task 8's script is `select`-only.
- **American English** in all comments, copy, and identifiers (`labor`, `color`, `labeled`).
- **Commit trailer**, every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Do not drop `client_assignments`, do not touch `db/schema.sql`, do not touch `BULK_SAVE_TABLES`.** The table stays present and inert this batch. That is what makes batch 1 reversible.
- Run a single test file with `npx vitest run <path>`; a single test with `npx vitest run <path> -t "<name>"`.

---

## File Structure

| File | Change | Responsibility after |
|---|---|---|
| `lib/data-scope.js` | modify | Gains `assignedTeamIds()` + `isClientVisibleToUser()` — the one definition of "assigned", shared by server and UI |
| `src/__tests__/data-scope.test.ts` | modify | Unit tests for the above (existing file already tests this module from TS) |
| `server.js` | modify (`:64`, `:545`) | `visibleClientIdSet` delegates to the shared predicate |
| `db/store.js` | modify (7 sites) | Canonical write in `createClient`; derived alias in both read mappers; stops touching `client_assignments`; owners allowed in `setClientAssignedTeam` |
| `db/store-staleness.test.mjs` | modify | Postgres statement-level guards via `fakePostgres`; file-backend invariant |
| `src/lib/utils.ts` | modify (`:500`) | `getAssignedTeamIds` re-exported from `lib/data-scope.js` |
| `src/App.tsx`, `src/pages/ClientsPage.tsx`, `src/pages/ChecklistsPage.tsx`, `src/pages/SetupChecklistPage.tsx`, `src/lib/completeness.ts` | modify | All read assignment through the one accessor |
| `src/components/AssignedTeamControl.tsx` | modify (`:22`) | Owners selectable |
| `scripts/report-client-assignment-divergence.mjs` | **create** | Read-only prod divergence report |
| `docs/HANDOFF.md`, `docs/capability-manifest.md` | modify | Corrected facts |

---

## Task 1: Shared assignment predicate

Pure refactor — no behavior change. It exists so Task 5 can point the UI at the *same function* the server uses, instead of a parallel copy.

**Files:**
- Modify: `lib/data-scope.js` (append)
- Modify: `server.js:64`, `server.js:545-558`
- Test: `src/__tests__/data-scope.test.ts` (append)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `assignedTeamIds(client: { assignedBookkeeperIds?: string[] } | null | undefined): string[]` — deduped, strings only, empty-string ids dropped, never null
  - `isClientVisibleToUser(client, userId: string): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/data-scope.test.ts`:

```ts
import { assignedTeamIds, isClientVisibleToUser } from '../../lib/data-scope.js'

describe('assignedTeamIds', () => {
  it('reads the assigned team off assignedBookkeeperIds', () => {
    expect(assignedTeamIds({ assignedBookkeeperIds: ['emp-1', 'emp-2'] })).toEqual([
      'emp-1',
      'emp-2',
    ])
  })

  it('returns an empty array for a client with no team', () => {
    expect(assignedTeamIds({})).toEqual([])
    expect(assignedTeamIds(null)).toEqual([])
  })

  it('drops duplicates, non-strings and empty ids', () => {
    expect(
      assignedTeamIds({ assignedBookkeeperIds: ['emp-1', 'emp-1', '', 7, null] }),
    ).toEqual(['emp-1'])
  })

  it('ignores assignedEmployeeIds — it is a derived alias, never an input', () => {
    expect(assignedTeamIds({ assignedEmployeeIds: ['emp-9'] })).toEqual([])
  })
})

describe('isClientVisibleToUser', () => {
  it('is true when the user is on the assigned team', () => {
    expect(isClientVisibleToUser({ assignedBookkeeperIds: ['emp-1'] }, 'emp-1')).toBe(true)
  })

  it('is false when they are not', () => {
    expect(isClientVisibleToUser({ assignedBookkeeperIds: ['emp-2'] }, 'emp-1')).toBe(false)
  })

  it('is false for a missing client or missing user', () => {
    expect(isClientVisibleToUser(null, 'emp-1')).toBe(false)
    expect(isClientVisibleToUser({ assignedBookkeeperIds: ['emp-1'] }, '')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/data-scope.test.ts`
Expected: FAIL — `assignedTeamIds is not a function`.

- [ ] **Step 3: Implement**

Append to `lib/data-scope.js`:

```js
/**
 * The assigned team for a client — the ONE source of truth.
 *
 * Assignment used to be stored twice: this array, and a `client_assignments`
 * table surfaced as `assignedEmployeeIds`. Only this array ever gated access,
 * so the other copy could (and did) disagree silently — a client added through
 * the Add-client form landed its team in the table and left this array empty,
 * making the client invisible to the very people just assigned to it.
 * `assignedEmployeeIds` is now a derived alias of this field; nothing reads the
 * table. See docs/plans/client-assignment-single-source-2026-08.md.
 *
 * Deliberately reads ONLY `assignedBookkeeperIds`, never the alias — accepting
 * the alias as an input would let the old field become a second source again.
 *
 * May contain owners: an owner sees every client regardless, so owner
 * membership is a display fact, not an access grant.
 *
 * @param {{ assignedBookkeeperIds?: string[] } | null | undefined} client
 * @returns {string[]}
 */
export function assignedTeamIds(client) {
  if (!client || !Array.isArray(client.assignedBookkeeperIds)) return []
  return [...new Set(client.assignedBookkeeperIds.filter((id) => typeof id === 'string' && id))]
}

/**
 * Whether a non-owner may see this client. Owner sessions bypass this entirely
 * (see `visibleClientIdSet` in server.js).
 *
 * @param {{ assignedBookkeeperIds?: string[] } | null | undefined} client
 * @param {string} userId
 * @returns {boolean}
 */
export function isClientVisibleToUser(client, userId) {
  if (!userId) return false
  return assignedTeamIds(client).includes(userId)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/data-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Point the server at it**

`server.js:64` — extend the existing import:

```js
import {
  isClientVisibleToUser,
  isTemplateVisibleToScope,
  isTimeEntryVisibleToScope,
} from './lib/data-scope.js'
```

`server.js:537-558` — replace the comment and function:

```js
/**
 * Compute the set of client ids visible to a session. Owners always see
 * everything. Non-owners see only clients whose assigned team includes their
 * user id — `assignedTeamIds` in lib/data-scope.js is the one definition of
 * that team, shared with the frontend so the two cannot drift.
 */
// `weekStartOf` (the Sun–Sat week anchor) now lives in lib/time-entry.js beside
// the weekly gate that consumes it — imported above.

function visibleClientIdSet(session, clients) {
  if (session.user.role === 'owner') {
    return new Set(clients.map((client) => client.id))
  }
  const me = session.user.id
  return new Set(
    clients.filter((client) => isClientVisibleToUser(client, me)).map((client) => client.id),
  )
}
```

- [ ] **Step 6: Verify nothing broke**

Run: `npm run lint && npx vitest run`
Expected: PASS, same test count as before plus the new data-scope tests.

- [ ] **Step 7: Commit**

```bash
git add lib/data-scope.js server.js src/__tests__/data-scope.test.ts
git commit -m "Assignment: one shared predicate for who is on a client's team

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The incident fix — a new client's team can actually see it

This is the 2026-08-13 bug. Shippable on its own.

**Files:**
- Modify: `db/store.js:7242-7259` (inside `createClient`, the `normalizeClientProfile` call)
- Test: `db/store-staleness.test.mjs` — both the file-backend and the Postgres `createClient` describe blocks

**Interfaces:**
- Consumes: nothing
- Produces: `createClient(payload)` now returns a record where `assignedBookkeeperIds` holds the union of the payload's `assignedBookkeeperIds` and `assignedEmployeeIds`, and `assignedEmployeeIds` equals it

**Deviation from spec §3.3, deliberate:** the spec says "filtered to known users". The fold does **not** validate ids against the `users` table. There is no FK on `assigned_bookkeeper_ids`, an unknown id grants nothing (visibility compares against a real session user id), the ids come from an owner-only form listing real employees, and `setClientAssignedTeam` validates on every later edit. Adding a validation `select` inside the create transaction would also make the `fakePostgres` test filter everything to empty, since the fake returns no rows for unmatched selects.

- [ ] **Step 1: Write the failing Postgres test**

In `db/store-staleness.test.mjs`, inside `describe('createClient writes every form field to Postgres', ...)`, add:

```js
  it('puts the team the form picked where visibility actually reads it', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient(formValues)

    // `assignedEmployeeIds` is what the Add-client form sends. It used to land
    // ONLY in client_assignments while this column went in empty, so the team
    // just picked could not see the client (2026-08-13).
    const bound = boundColumns(fake.matching(/^insert into clients/i)[0])
    expect(bound.assigned_bookkeeper_ids).toEqual(['emp-1'])
  })

  it('unions both inbound names without duplicating', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient({
      ...formValues,
      assignedEmployeeIds: ['emp-1', 'emp-2'],
      assignedBookkeeperIds: ['emp-2', 'emp-3'],
    })

    const bound = boundColumns(fake.matching(/^insert into clients/i)[0])
    expect([...bound.assigned_bookkeeper_ids].sort()).toEqual(['emp-1', 'emp-2', 'emp-3'])
  })
```

- [ ] **Step 2: Rewrite the file-backend test that encodes the wrong belief**

Replace the test at `db/store-staleness.test.mjs:1352` (`'keeps the team selection, which is what drives client visibility'`) with:

```js
  it('keeps the team selection in the field that drives client visibility', async () => {
    const created = await store.createClient(formValues)
    const data = await store.read()
    const stored = data.clients.find((c) => c.id === created.id)
    // Both names, one value. `assignedBookkeeperIds` is what
    // `visibleClientIdSet` reads; `assignedEmployeeIds` is its alias.
    expect(stored.assignedBookkeeperIds).toEqual(['emp-1'])
    expect(stored.assignedEmployeeIds).toEqual(['emp-1'])
  })
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run db/store-staleness.test.mjs -t "visibility"`
Expected: FAIL — `assigned_bookkeeper_ids` binds `[]`, and `stored.assignedBookkeeperIds` is `[]`.

- [ ] **Step 4: Implement**

`db/store.js`, in `createClient`, immediately before the `const record = normalizeClientProfile({` call at `:7242`:

```js
    // ONE assigned team. The Add-client form sends `assignedEmployeeIds`; the
    // rest of the app writes `assignedBookkeeperIds`. Only the latter gates
    // visibility, so a payload carrying just the former used to create a client
    // its own team could not see. Accept either name, fold into one value.
    const assignedTeam = [
      ...new Set([
        ...stringIds(client.assignedBookkeeperIds),
        ...stringIds(client.assignedEmployeeIds),
      ]),
    ]
```

Then replace lines `:7251-7255` (the two assignment properties and their comment) with:

```js
      // One team, two names — `assignedEmployeeIds` is a derived alias kept
      // for the UI until batch 2 removes it.
      assignedEmployeeIds: assignedTeam,
      assignedBookkeeperIds: assignedTeam,
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run db/store-staleness.test.mjs`
Expected: PASS — including the pre-existing `'derives client_assignments from the team the form picked'`, which still passes because `record.assignedEmployeeIds` is now the folded team. Task 3 removes it.

- [ ] **Step 6: Commit**

```bash
git add db/store.js db/store-staleness.test.mjs
git commit -m "Clients: a new client's picked team can actually see it

The Add-client form sends assignedEmployeeIds, which landed only in
client_assignments while assigned_bookkeeper_ids — the field
visibleClientIdSet reads — went in empty. createClient now folds either
inbound name into the canonical field.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Stop writing `client_assignments`

The table stays in the schema; nothing writes it after this task.

**Files:**
- Modify: `db/store.js:4371` (the delete in `write()`), `db/store.js:4575-4585` (the re-insert loop), `db/store.js:4290-4293` (a now-stale comment), `db/store.js:7364-7375` (the loop in `createClient`)
- Test: `db/store-staleness.test.mjs`

**Interfaces:**
- Consumes: Task 2's `assignedTeam` fold
- Produces: no `client_assignments` statement is issued by any store method

- [ ] **Step 1: Write the failing tests**

Replace the existing test at `db/store-staleness.test.mjs:1443` (`'derives client_assignments from the team the form picked'`) with:

```js
  it('does not touch client_assignments — the team lives on the client row', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient(formValues)

    expect(fake.matching(/client_assignments/i)).toEqual([])
  })
```

And add a new `describe` block beside the other bulk-save Postgres suites:

```js
/**
 * `client_assignments` was the second, non-authoritative copy of a client's
 * assigned team. `write()` used to delete every row and rebuild it from
 * `assignedEmployeeIds`, which no UI had updated since the Assigned-team
 * control writes `assignedBookkeeperIds` — so each bulk save re-asserted a
 * stale team. Nothing reads the table now; nothing may write it.
 */
describe('bulk save leaves client_assignments alone (postgres branch)', () => {
  it('issues no client_assignments statement at all', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', assignedBookkeeperIds: ['emp-1'] }],
      }),
    )

    expect(fake.matching(/client_assignments/i)).toEqual([])
  })

  it('still persists the assigned team to the clients row', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', assignedBookkeeperIds: ['emp-1'] }],
      }),
    )

    const insert = fake.matching(/^insert into clients/i)[0]
    expect(insert.params).toContainEqual(['emp-1'])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run db/store-staleness.test.mjs -t "client_assignments"`
Expected: FAIL — the matching arrays are non-empty (a `delete from client_assignments` and an `insert into client_assignments`).

- [ ] **Step 3: Remove the write in `createClient`**

Delete `db/store.js:7364-7375` entirely — the comment block beginning `// Same derivation the bulk save uses` and the `for (const userId of record.assignedEmployeeIds)` loop with its insert. The `await dbClient.query('commit')` that follows stays.

- [ ] **Step 4: Remove the wipe-and-rebuild in `write()`**

Delete `db/store.js:4371`:

```js
        await client.query('delete from client_assignments')
```

Delete `db/store.js:4575-4585` — the `for (const employeeId of (clientRecord.assignedEmployeeIds ?? []).filter(...))` loop and its insert. The `}` closing the `for (const clientRecord of safeClients)` loop stays.

- [ ] **Step 5: Correct the stale comment**

`db/store.js:4290-4293` currently reads:

```js
      // No filtering on client.assignedEmployeeIds either — same reason
      // (users table is preserved across saves, so user_id refs remain
      // valid). If we ever see an FK error on client_assignments.user_id,
      // it'll surface via the diagnostic in server.js.
```

Replace with:

```js
      // Nothing to filter on a client's assigned team: it lives in the
      // `assigned_bookkeeper_ids` text[] column, which carries no FK. The
      // `client_assignments` table this used to rebuild is inert (see
      // docs/plans/client-assignment-single-source-2026-08.md).
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run db/store-staleness.test.mjs`
Expected: PASS.

- [ ] **Step 7: Confirm nothing else writes the table**

Run: `npx vitest run` then
Run: `git grep -n "client_assignments" -- db/ lib/ server.js src/`
Expected: hits ONLY in `db/store.js:2563` (create table), `db/store.js:3611-3615` (the read, removed in Task 4), `db/store.js:8450` (orphan cleanup, batch 2), `db/schema.sql:79`, `lib/workspace-version.js:62`, and the tests. No inserts, no deletes outside `:8450`.

- [ ] **Step 8: Commit**

```bash
git add db/store.js db/store-staleness.test.mjs
git commit -m "Assignment: stop rebuilding client_assignments on every save

The table was a second copy of a client's team that no UI updated, so each
bulk save re-asserted a stale list. Nothing writes it now; the column is
the one source. The table itself stays until batch 2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `assignedEmployeeIds` becomes a derived alias in both backends

**Files:**
- Modify: `db/store.js:3611-3615` (drop the read query), `db/store.js:3560` (drop the destructured result), `db/store.js:3685-3690` (drop `assignmentsByClient`), `db/store.js:3853-3909` (derive the alias), `db/store.js:438-451` (`normalizeClientProfile`)
- Test: `db/store-staleness.test.mjs` (extend `fakePostgres`)

**Interfaces:**
- Consumes: Task 3 (nothing writes the table)
- Produces: for every client emitted by either backend, `assignedEmployeeIds` deep-equals `assignedBookkeeperIds`

- [ ] **Step 1: Teach `fakePostgres` to return client rows**

`db/store-staleness.test.mjs:930` — extend the signature and add one matcher. The clients read is the only statement matching `from clients … order by name asc`, so the pattern cannot collide with `select count(*) from clients` or the contacts read:

```js
function fakePostgres({ invoices = [], groupSlices = [], clientRows = [] } = {}) {
  const statements = []
  const record = (text, params) => {
    const trimmed = String(text).trim()
    statements.push({ text: trimmed, params })
    if (/^select\b[\s\S]*\bfrom invoices\b/i.test(trimmed)) {
      return { rows: invoices }
    }
    // The clients read inside read() — lets a test exercise the row mapper.
    if (/^select\b[\s\S]*\bfrom clients\b[\s\S]*order by name asc/i.test(trimmed)) {
      return { rows: clientRows }
    }
    // The `for update` read a split adjustment starts with.
    if (/^select\b[\s\S]*\bfrom time_entries where group_id\b/i.test(trimmed)) {
      return { rows: groupSlices, rowCount: groupSlices.length }
    }
    return { rows: [] }
  }
```

- [ ] **Step 2: Write the failing tests**

Add to `db/store-staleness.test.mjs`:

```js
/**
 * `assignedEmployeeIds` no longer has a table behind it — it is an alias of
 * `assignedBookkeeperIds`, emitted identically by both backends so a UI reading
 * either name gets the same answer. This is the Postgres half; the file half
 * is in the invariant suite.
 */
describe('read() derives assignedEmployeeIds from the client row (postgres branch)', () => {
  const clientRow = {
    id: 'c1',
    name: 'Acme',
    contact: 'Pat',
    billing_mode: 'hourly',
    hourly_rate: 0,
    plan_id: null,
    plan_ids: [],
    contact_ids: [],
    assigned_bookkeeper_ids: ['emp-1', 'emp-2'],
    lifecycle_stage: 'active',
  }

  it('emits both names with the same value', async () => {
    const fake = fakePostgres({ clientRows: [clientRow] })
    const data = await postgresStore(fake).read()

    expect(data.clients[0].assignedBookkeeperIds).toEqual(['emp-1', 'emp-2'])
    expect(data.clients[0].assignedEmployeeIds).toEqual(['emp-1', 'emp-2'])
  })

  it('no longer selects from client_assignments', async () => {
    const fake = fakePostgres({ clientRows: [clientRow] })
    await postgresStore(fake).read()

    expect(fake.matching(/client_assignments/i)).toEqual([])
  })

  it('emits an empty team as an empty array on both names', async () => {
    const fake = fakePostgres({ clientRows: [{ ...clientRow, assigned_bookkeeper_ids: null }] })
    const data = await postgresStore(fake).read()

    expect(data.clients[0].assignedBookkeeperIds).toEqual([])
    expect(data.clients[0].assignedEmployeeIds).toEqual([])
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run db/store-staleness.test.mjs -t "derives assignedEmployeeIds"`
Expected: FAIL — `assignedEmployeeIds` is `[]` (the fake returns no `client_assignments` rows), and the `client_assignments` select is still issued.

- [ ] **Step 4: Drop the table read**

`db/store.js:3560` — remove `assignmentsResult,` from the destructuring array.

`db/store.js:3611-3615` — remove the whole query from the `Promise.all`:

```js
          this.pool.query(`
            select client_id, user_id
            from client_assignments
            order by client_id asc, user_id asc
          `),
```

`db/store.js:3685-3690` — remove the `assignmentsByClient` map construction:

```js
      const assignmentsByClient = new Map()
      for (const row of assignmentsResult.rows) {
        const existing = assignmentsByClient.get(row.client_id) ?? []
        existing.push(row.user_id)
        assignmentsByClient.set(row.client_id, existing)
      }
```

- [ ] **Step 5: Derive the alias in the row mapper**

`db/store.js`, in the `clients: clientsResult.rows.map((row) => {` block, after the `contactIds` const at `:3867-3869`, add:

```js
          // One assigned team, normalized once. `assignedEmployeeIds` below is
          // an alias of this — it used to come from the `client_assignments`
          // table, which could and did disagree with the column that actually
          // gates visibility.
          const assignedTeam = Array.isArray(row.assigned_bookkeeper_ids)
            ? [...new Set(row.assigned_bookkeeper_ids.filter((id) => typeof id === 'string'))]
            : []
```

Then replace `:3906-3909` (both properties) with:

```js
            assignedEmployeeIds: assignedTeam,
            assignedBookkeeperIds: assignedTeam,
```

Note the indentation change: the existing `assignedBookkeeperIds` block is indented two spaces shallower than its neighbors. Match the surrounding `assignedEmployeeIds` indentation for both.

- [ ] **Step 6: Derive the alias on the file backend**

`db/store.js:438-451`, in `normalizeClientProfile`. Hoist the value above the `return {`:

```js
  // One assigned team — see lib/data-scope.js. `assignedEmployeeIds` is an
  // alias; whatever a caller passed under that name is discarded here so the
  // old field cannot become a second source of truth again.
  const assignedTeam = Array.isArray(client.assignedBookkeeperIds)
    ? [...new Set(client.assignedBookkeeperIds.filter((id) => typeof id === 'string'))]
    : []
  return {
    ...client,
```

and replace the existing `assignedBookkeeperIds:` property (`:449-451`) with:

```js
    assignedBookkeeperIds: assignedTeam,
    assignedEmployeeIds: assignedTeam,
```

- [ ] **Step 7: Run to verify they pass**

Run: `npx vitest run db/store-staleness.test.mjs`
Expected: PASS.

- [ ] **Step 8: Full suite**

Run: `npx vitest run`
Expected: PASS. If a test fails asserting `assignedEmployeeIds` independently of `assignedBookkeeperIds`, that test encoded the divergence — update it to set `assignedBookkeeperIds`, and note which one in the commit body.

- [ ] **Step 9: Commit**

```bash
git add db/store.js db/store-staleness.test.mjs
git commit -m "Assignment: assignedEmployeeIds is now derived, in both backends

Both backends emit it as an alias of assignedBookkeeperIds, so a caller
reading either name gets the same answer and client_assignments is no
longer read at all.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: One accessor for every UI reader

**Files:**
- Modify: `src/lib/utils.ts:500-502`, `src/App.tsx:133` + `:1023`, `src/pages/ClientsPage.tsx:44` + `:1045-1046` + `:525`, `src/lib/completeness.ts:134`, `src/pages/ChecklistsPage.tsx:1730-1734`, `src/pages/SetupChecklistPage.tsx:331-332` + `:373-376`, `db/store.js:7756-7757`
- Test: `src/__tests__/completeness.test.ts:26`

**Interfaces:**
- Consumes: `assignedTeamIds` from Task 1
- Produces: `getAssignedTeamIds(client: Client): string[]` exported from `src/lib/utils.ts`

- [ ] **Step 1: Write the failing test**

`src/__tests__/completeness.test.ts:26` — change the `makeClient` default from `assignedEmployeeIds: ['emp-1'],` to:

```ts
  assignedBookkeeperIds: ['emp-1'],
```

and in the two overrides at `:63` and `:103`, change `assignedEmployeeIds: []` to `assignedBookkeeperIds: []`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/completeness.test.ts`
Expected: FAIL — `computeSetupIssues` still reads `assignedEmployeeIds`, so the fully-set-up workspace now reports an "Assign a team member" issue.

- [ ] **Step 3: Re-point the accessor**

`src/lib/utils.ts:500-502` — replace `getAssignedEmployeeIds` with a re-export of the shared predicate, matching how this file already re-exports `lib/checklist-identity.js`:

```ts
/**
 * The assigned team for a client. Re-exported from `lib/data-scope.js` so the
 * UI and the server's `visibleClientIdSet` share ONE definition — they used to
 * read different fields and disagreed about who could see what.
 */
export { assignedTeamIds as getAssignedTeamIds } from '../../lib/data-scope.js'
```

Place it beside the existing `lib/checklist-identity.js` re-export block near `:488`, not in the middle of the local helpers.

If `lib/data-scope.js` has no type declarations reachable from `src/`, mirror whatever `src/__tests__/data-scope.test.ts` and `src/__tests__/confirmed-wait-stays.test.tsx` already do for `../../lib/*.js` imports — those files prove the pattern compiles under `tsc -b`.

- [ ] **Step 4: Update the five readers**

`src/lib/completeness.ts:134`:

```ts
    // No assigned team member.
    if (getAssignedTeamIds(client).length === 0) {
```

with the import added at the top of the file from `./utils`.

`src/App.tsx:133` — change the import from `getAssignedEmployeeIds` to `getAssignedTeamIds`. `src/App.tsx:1023`:

```tsx
        .filter((client) => getAssignedTeamIds(client).includes(activeEmployeeId))
```

`src/pages/ClientsPage.tsx:44` — same import rename. `:1045-1046`:

```tsx
                    {getAssignedTeamIds(client).length > 0 ? (
                      getAssignedTeamIds(client).map((employeeId) => (
```

`src/pages/ChecklistsPage.tsx:1730-1734` — the OR collapses to one read:

```tsx
  const checklistClient = clients.find((c) => c.id === checklist.clientId)
  const isAssignedToClient =
    !!checklistClient && getAssignedTeamIds(checklistClient).includes(activeEmployeeId)
```

with `getAssignedTeamIds` imported from `../lib/utils`.

`src/pages/SetupChecklistPage.tsx:331-332`:

```tsx
  const [teamIds, setTeamIds] = useState<string[]>(() =>
    fix.kind === 'clientTeam' ? getAssignedTeamIds(client ?? ({} as Client)) : [],
  )
```

and `:373-376` — one field, not two:

```tsx
        updateClient(fix.clientId, { assignedBookkeeperIds: teamIds })
```

- [ ] **Step 5: Make the Add-client form send the canonical name**

`src/pages/ClientsPage.tsx:525` — replace `assignedEmployeeIds,` in the `onCreate` payload with:

```tsx
      assignedBookkeeperIds: assignedEmployeeIds,
```

Leave the local state variable and `toggleEmployee` named as they are — renaming the whole form's local state is churn without a behavior change. Task 2's fold keeps this working either way; this makes the canonical name the one on the wire.

- [ ] **Step 6: Drop the store's fallback arm**

`db/store.js:7756-7757` in `startOnboarding`:

```js
    const assigneeId = (client.assignedBookkeeperIds ?? [])[0] || ''
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/__tests__/completeness.test.ts && npm run build`
Expected: PASS, and `tsc -b && vite build` clean.

- [ ] **Step 8: Confirm no reader is left behind**

Run: `git grep -n "assignedEmployeeIds" -- src/ db/ lib/ server.js`
Expected: hits ONLY in `src/lib/types.ts:147` (the type, removed in batch 2), `db/store.js` where the alias is *produced* (`normalizeClientProfile`, the row mapper, the `createClient` fold), `db/store.js:9896` (`deleteTeamMember`'s file branch), and tests. No UI file reads it.

- [ ] **Step 9: Commit**

```bash
git add src/ db/store.js
git commit -m "Assignment: every reader goes through one accessor

getAssignedTeamIds re-exports the server's own predicate, so the Clients
list, the setup checklist, checklist edit rights and the client-side
visibility filter all answer 'who is assigned' the same way the server does.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Owners may be on a team

Per spec §3.4 and the decision recorded there. Explicit picks only — implicit grants still skip owners.

**Files:**
- Modify: `db/store.js:6618-6651` (`setClientAssignedTeam`, both branches), `src/components/AssignedTeamControl.tsx:22`, `server.js:7034-7035` (comment)
- Test: `db/store-staleness.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `setClientAssignedTeam(clientId, ids)` accepts owner ids

- [ ] **Step 1: Write the failing test**

Add to `db/store-staleness.test.mjs`, in the file-backend section:

```js
/**
 * An owner can appear on a client's assigned team. It grants nothing — owners
 * see every client regardless — but the Clients-page team column shows who
 * works the account, and dropping owners from it silently misreported the team.
 * Implicit grants (grantClientVisibility, the checklist backfill) still skip
 * owners: being handed one task should not add you to a client's team list.
 */
describe('setClientAssignedTeam (file backend)', () => {
  beforeEach(async () => {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', assignedBookkeeperIds: [] }],
        employees: [
          { id: 'emp-1', name: 'Lisa', role: 'bookkeeper' },
          { id: 'owner-1', name: 'Brittany', role: 'Owner' },
        ],
      }),
    )
  })

  it('keeps an owner the user explicitly picked', async () => {
    const updated = await store.setClientAssignedTeam('c1', ['emp-1', 'owner-1'])
    expect(updated.assignedBookkeeperIds).toEqual(['emp-1', 'owner-1'])
  })

  it('still drops an id that is nobody', async () => {
    const updated = await store.setClientAssignedTeam('c1', ['emp-1', 'ghost-9'])
    expect(updated.assignedBookkeeperIds).toEqual(['emp-1'])
  })

  it('keeps the alias in step with what it stored', async () => {
    await store.setClientAssignedTeam('c1', ['emp-1', 'owner-1'])
    const data = await store.read()
    const client = data.clients.find((c) => c.id === 'c1')
    expect(client.assignedEmployeeIds).toEqual(client.assignedBookkeeperIds)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run db/store-staleness.test.mjs -t "setClientAssignedTeam"`
Expected: FAIL — `owner-1` is filtered out, so the first assertion gets `['emp-1']`.

- [ ] **Step 3: Implement — Postgres branch**

`db/store.js:6620-6624`:

```js
      // Every real user is pickable, owners included. An owner on the list is
      // a display fact: they see every client either way, and hiding them made
      // the Clients-page team column misreport who works the account.
      const usersResult = await this.pool.query(`select id from users`)
      const valid = new Set(usersResult.rows.map((r) => r.id))
      const safe = [...new Set((bookkeeperIds ?? []).filter((id) => valid.has(id)))]
```

- [ ] **Step 4: Implement — file branch**

`db/store.js:6637-6641`:

```js
    const employees = Array.isArray(data.employees) ? data.employees : []
    const valid = new Set(employees.map((e) => e.id))
    const safe = [...new Set((bookkeeperIds ?? []).filter((id) => valid.has(id)))]
```

- [ ] **Step 5: Let the picker offer owners**

`src/components/AssignedTeamControl.tsx:22`:

```tsx
  // Owners are pickable: an owner sees every client anyway, so listing one here
  // records who works the account rather than granting anything.
  const eligible = employees
```

and `:38-40`, the helper copy, which currently overstates the rule:

```tsx
      <p className="sharing-helper">
        Only these team members can see this client — plus owners, who always see
        everything.
      </p>
```

- [ ] **Step 6: Correct the route comment**

`server.js:7034-7035`:

```js
    // PUT /api/clients/:id/assigned-team — owner-only. Replaces the per-client
    // assigned-team list. Validates each id is a real employee; owners may be
    // on the list (it grants them nothing — they see every client already).
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run db/store-staleness.test.mjs -t "setClientAssignedTeam" && npm run build`
Expected: PASS, build clean.

- [ ] **Step 8: Confirm implicit grants still skip owners**

Run: `npx vitest run lib/assistant.test.mjs`
Expected: PASS — `grantClientVisibility` is not called for an owner (`lib/assistant.test.mjs:226-247`). Do **not** change `grantClientVisibility` or `backfillAssignedBookkeepers`.

- [ ] **Step 9: Commit**

```bash
git add db/store.js src/components/AssignedTeamControl.tsx server.js db/store-staleness.test.mjs
git commit -m "Assigned team: an owner you pick on purpose stays picked

Explicit picks accept owners; implicit grants still skip them, so being
handed one task does not add you to a client's team.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The invariant that fails when they diverge

The regression net. Every mutation path, both backends, one assertion.

**Files:**
- Test: `db/store-staleness.test.mjs` (append)

**Interfaces:**
- Consumes: Tasks 2–6
- Produces: `expectOneTeamSource(client)` — module-local test helper

- [ ] **Step 1: Write the tests**

Append to `db/store-staleness.test.mjs`:

```js
/**
 * THE invariant. Client assignment was stored twice — `assigned_bookkeeper_ids`
 * and the `client_assignments` table — and only the first gated visibility, so
 * the two could disagree without anything failing. They are one value now, and
 * every mutation path has to keep them one value.
 *
 * If a future change reintroduces a second source, this is what catches it.
 */
const expectOneTeamSource = (client) => {
  expect(client).toBeTruthy()
  expect(client.assignedEmployeeIds).toEqual(client.assignedBookkeeperIds)
}

describe('one source of truth for a client team (file backend)', () => {
  const teamWorkspace = () =>
    workspace({
      clients: [{ id: 'c1', name: 'Acme', assignedBookkeeperIds: ['emp-1'] }],
      employees: [
        { id: 'emp-1', name: 'Lisa', role: 'bookkeeper' },
        { id: 'emp-2', name: 'Dana', role: 'bookkeeper' },
      ],
    })

  const clientFromDisk = async (id = 'c1') => {
    const data = await store.read()
    return data.clients.find((c) => c.id === id)
  }

  beforeEach(async () => {
    await store.write(teamWorkspace())
  })

  it('holds after a bulk-save round trip', async () => {
    expectOneTeamSource(await clientFromDisk())
    expect((await clientFromDisk()).assignedBookkeeperIds).toEqual(['emp-1'])
  })

  it('holds after createClient', async () => {
    const created = await store.createClient({
      name: 'Northwind',
      contact: 'Dana',
      assignedEmployeeIds: ['emp-2'],
    })
    expectOneTeamSource(await clientFromDisk(created.id))
    expect((await clientFromDisk(created.id)).assignedBookkeeperIds).toEqual(['emp-2'])
  })

  it('holds after setClientAssignedTeam', async () => {
    await store.setClientAssignedTeam('c1', ['emp-2'])
    expectOneTeamSource(await clientFromDisk())
  })

  it('holds after grantClientVisibility', async () => {
    await store.grantClientVisibility('c1', 'emp-2')
    const client = await clientFromDisk()
    expectOneTeamSource(client)
    expect(client.assignedBookkeeperIds).toContain('emp-2')
  })

  it('holds after a bulk save carrying a STALE alias', async () => {
    // The shape that used to cause the divergence: a payload whose alias
    // disagrees with the canonical field. The canonical field must win.
    await store.write(
      workspace({
        clients: [
          {
            id: 'c1',
            name: 'Acme',
            assignedBookkeeperIds: ['emp-2'],
            assignedEmployeeIds: ['emp-1'],
          },
        ],
      }),
    )
    const client = await clientFromDisk()
    expectOneTeamSource(client)
    expect(client.assignedBookkeeperIds).toEqual(['emp-2'])
  })
})
```

- [ ] **Step 2: Run them**

Run: `npx vitest run db/store-staleness.test.mjs -t "one source of truth"`
Expected: PASS. If the stale-alias case fails, `normalizeClientProfile` is not being applied on the bulk-save path — fix that rather than weakening the test, since that payload shape is exactly the production failure.

- [ ] **Step 3: Add the deleteTeamMember case**

```js
  it('holds after deleteTeamMember removes someone from the team', async () => {
    await store.setClientAssignedTeam('c1', ['emp-1', 'emp-2'])
    await store.deleteTeamMember('emp-2')
    const client = await clientFromDisk()
    expectOneTeamSource(client)
    expect(client.assignedBookkeeperIds).not.toContain('emp-2')
  })
```

`deleteTeamMember` needs a real auth-file user to act on; follow the setup the existing `deleteTeamMember` tests in this file use (they already handle `tmp/auth.json`). If no such suite exists, seed the auth file the way `beforeAll` does and note it in the commit body.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run db/store-staleness.test.mjs`
Expected: PASS.

```bash
git add db/store-staleness.test.mjs
git commit -m "Tests: fail loudly if a client's team ever has two answers again

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Read-only production divergence report

**Files:**
- Create: `scripts/report-client-assignment-divergence.mjs`

**Interfaces:**
- Consumes: `DATABASE_URL`
- Produces: a printed report; no exports, no writes

**This script must never write.** No `insert`, `update`, `delete`, `begin`, or `commit`. It is the artifact Alex and Brittany decide from, per spec §2 decision 2 and cardinal rule 5.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * Read-only report: where do the two representations of "who is assigned to
 * this client" disagree in production?
 *
 *   clients.assigned_bookkeeper_ids  — the one that gates visibility
 *   client_assignments               — the inert second copy (batch 2 drops it)
 *
 * Anyone in the table but NOT in the column currently sees nothing for that
 * client. Merging them in would GRANT access that does not exist today, which
 * is a decision for Alex and Brittany — not for this script. It writes nothing.
 *
 * Usage:  DATABASE_URL=... node scripts/report-client-assignment-divergence.mjs
 */
import pg from 'pg'

const { DATABASE_URL } = process.env
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (read-only — this script never writes).')
  process.exit(1)
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
})

const { rows } = await pool.query(`
  select c.id,
         c.name,
         coalesce(c.assigned_bookkeeper_ids, '{}') as column_ids,
         coalesce(array_agg(a.user_id) filter (where a.user_id is not null), '{}') as table_ids
    from clients c
    left join client_assignments a on a.client_id = c.id
   group by c.id, c.name, c.assigned_bookkeeper_ids
   order by c.name asc
`)

const { rows: userRows } = await pool.query(
  `select id, name, role, inactive_at from users`,
)
const users = new Map(userRows.map((u) => [u.id, u]))
const label = (id) => {
  const user = users.get(id)
  if (!user) return `${id} (NO SUCH USER)`
  const flags = [user.role === 'owner' ? 'owner' : null, user.inactive_at ? 'INACTIVE' : null]
    .filter(Boolean)
    .join(', ')
  return flags ? `${user.name} [${flags}]` : user.name
}

let diverged = 0
for (const row of rows) {
  const column = new Set(row.column_ids)
  const table = new Set(row.table_ids)
  const tableOnly = [...table].filter((id) => !column.has(id))
  const columnOnly = [...column].filter((id) => !table.has(id))
  if (tableOnly.length === 0 && columnOnly.length === 0) continue

  diverged += 1
  console.log(`\n${row.name}  (${row.id})`)
  if (tableOnly.length > 0) {
    console.log(`  in client_assignments only — CANNOT see this client today:`)
    for (const id of tableOnly) console.log(`    - ${label(id)}`)
  }
  if (columnOnly.length > 0) {
    console.log(`  on the assigned team only — can see it, absent from the table:`)
    for (const id of columnOnly) console.log(`    - ${label(id)}`)
  }
}

console.log(
  `\n${diverged} of ${rows.length} clients disagree. ` +
    `Nothing was changed — this report is read-only.`,
)

await pool.end()
```

- [ ] **Step 2: Prove it is read-only before it ever sees production**

Run: `git grep -nEi "insert|update |delete|begin|commit" scripts/report-client-assignment-divergence.mjs`
Expected: no output.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/report-client-assignment-divergence.mjs
git commit -m "Scripts: read-only report on client-assignment divergence

Lists, per client, who is in client_assignments but cannot actually see the
client — with owner and inactive flags, since those should not be merged.
Writes nothing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand the output to Alex — do not act on it**

Run it against production read-only, paste the output, and stop. Any resulting write needs explicit approval (cardinal rule 5).

---

## Task 9: Docs, verify, ship

**Files:**
- Modify: `docs/HANDOFF.md:133-134`, `docs/capability-manifest.md`

- [ ] **Step 1: Correct HANDOFF**

Replace `docs/HANDOFF.md:133-134`:

```markdown
- `clients` has only `assigned_bookkeeper_ids` — the ONE source of truth for a
  client's assigned team, and the only thing `visibleClientIdSet` reads.
  `assignedEmployeeIds` is a derived alias of it with no DB column;
  `client_assignments` is inert (nothing reads or writes it) and is dropped in
  batch 2. See `docs/plans/client-assignment-single-source-2026-08.md`. Owners
  may appear on an assigned team — it grants nothing, they see everything.
```

- [ ] **Step 2: Update the capability manifest**

Cardinal rule 3. Two user-visible facts to add where the manifest covers clients and visibility:
1. The team picked on the Add-client form can see the new client immediately (previously they could not until an owner re-picked the team on the client page).
2. An owner can be listed on a client's assigned team.

Match the manifest's existing voice and section structure — read it before editing.

- [ ] **Step 3: Full verify**

Run: `npm run verify`
Expected: eslint clean, `tsc -b && vite build` clean, all tests pass. Note the final test/file count — the suite was 1021 tests / 78 files as of the invoicing run.

- [ ] **Step 4: Commit and push**

```bash
git add docs/HANDOFF.md docs/capability-manifest.md
git commit -m "Docs: one source of truth for client assignment

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Push to `main` only on Alex's go signal. If `gh` 403s as `pmuf-code` mid-session, run `gh auth switch --user shizzoobies` and retry.

- [ ] **Step 5: Deploy is part of done**

Poll Railway until the deploy SUCCEEDS **on the hash you pushed** (match it — a green deploy of an older hash means nothing), then `/health` must return 200. Then re-provision the voice agent, since the manifest changed:

```bash
node scripts/provision-voice-agent.mjs
```

- [ ] **Step 6: Verify against production, read-only**

Run the Task 8 report again post-deploy and confirm the count has not grown. Then create one throwaway client through the Add-client form as an owner, confirm the assigned staff member can see it, and delete it. If you would rather not create a client in production, prove the same thing with a `BEGIN … ROLLBACK` transaction issuing `createClient`'s exact statements (HANDOFF §4).

---

## Self-review

**Spec coverage:** §3.1 → Tasks 3+4. §3.2 → Task 4. §3.3 → Task 2 (with one documented deviation on user-id validation). §3.4 → Task 6. §3.5 → Tasks 1+5. §3.6 → Tasks 2, 3, 4, 7. §3.7 → Task 8. §3.8 → Task 9. §4 (batch 2) → deliberately out of scope, guarded by the Global Constraint forbidding schema changes. No gaps.

**One addition beyond the spec:** §3.5 asked for one accessor; Task 1 puts it in `lib/data-scope.js` so the server and the UI share the *same function* rather than two that agree today. This follows the existing `isTemplateVisibleToScope` pattern (imported by `server.js`, tested from `src/__tests__/data-scope.test.ts`) and is the strongest available guard against the two drifting again.

**Type consistency:** `assignedTeamIds` (lib) → `getAssignedTeamIds` (the `src/lib/utils.ts` re-export alias) → used in `App.tsx`, `ClientsPage.tsx`, `ChecklistsPage.tsx`, `SetupChecklistPage.tsx`, `completeness.ts`. `isClientVisibleToUser` used only in `server.js`. `expectOneTeamSource` is test-local to `db/store-staleness.test.mjs`. `assignedTeam` is a local const in three separate store functions — no cross-file contract.

**Known ordering dependency:** Task 4 must follow Task 3. If the alias were derived while `write()` still rebuilt the table from it, the rebuild would silently start working off the canonical value and mask what Task 3's test is meant to prove.
