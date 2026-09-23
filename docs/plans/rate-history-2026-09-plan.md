# Rate History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bill rates and cost rates become dated versions. Each hourly client is pinned to the month whose bill rates it bills at, and moves to current rates only when the owner presses "Move to current rates from". Cost is resolved by the date the time was worked. After the migration every price and every cost equals today's numbers exactly.

**Architecture:** One pure resolver, `lib/rate-history.js`, answers every "what rate applied then" question — no second implementation on either side. Two new version tables (`bill_rate_versions`, `cost_rate_versions`) plus two new `clients` columns (`hourly_rate_period`, `hourly_rate_history`) on Postgres, with mirrored slices in the file backend's auth store and workspace blob. `users.bill_rate` / `users.cost_rate` remain a latest-version mirror, so every reader that has not moved to the resolver keeps working. `buildInvoiceLines` gains `billRateVersions` + `ratePeriod` opts behind a fallback chain that leaves every existing test green. `laborCost` changes its resolver contract from `(employeeId)` to `(employeeId, entryDate)`.

**Tech Stack:** Node ESM (no TypeScript in `db/`, `lib/`, `server.js`), React 19 + TypeScript + Vite in `src/`, Postgres via `pg`, Vitest.

**Spec:** [`docs/plans/rate-history-2026-09.md`](rate-history-2026-09.md). Read it before Task 1 — it holds the decision, the evidence and the two guarantees.

## Global Constraints

- `db/store.js` has TWO backends — every persisted change touches the Postgres branch (`if (this.pool)`) AND the JSON-file branch; tests run the file backend, production is Postgres.
- `npm run verify` (eslint + `tsc -b && vite build` + vitest) must be green before any push.
- The repo is CRLF — edit in place; never rewrite a file with LF endings.
- American spellings everywhere (labor, color, labeled).
- There is NO prettier; eslint is the only style authority.
- Commit messages open with a statement of behavior (no conventional-commit prefix) and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `tmp/` is NOT eslint-ignored — scratch scripts go in the OS temp scratchpad, never the repo.
- Never write to the production database. Every production step in this plan is read-only.
- AI structured-output schemas must not use `minimum`/`maximum`/`minItems`/`maxItems` — nothing in this plan adds a schema, and nothing here may grow one.
- Rates are owner-only and redacted for staff (`scopeAppDataForSession`).
- Sent/paid/voided invoices' `line_items` must never be repriced — nothing in this plan touches stored invoices.
- Run one test file with `npx vitest run <path>`; one test with `npx vitest run <path> -t "<name>"`.

---

## File Structure

| File | Change | Responsibility after |
|---|---|---|
| `lib/rate-history.js` | **create** | The five resolver functions — the only answer to "what rate applied then" |
| `lib/rate-history.d.ts` | **create** | Types so `src/` can import the resolver |
| `lib/rate-history.test.mjs` | **create** | Resolver unit tests |
| `db/store.js` | modify (9 sites) | Two version tables/slices, two client columns, the migration, five new methods, two thinned wrappers |
| `db/store-staleness.test.mjs` | modify (append) | File-backend behavior + Postgres statement shapes |
| `server.js` | modify (6 sites) | `loadRateVersions`, six endpoints, staff redaction, the hours summary |
| `lib/invoice-lines.js` / `.d.ts` | modify | `billRateVersions` + `ratePeriod` opts on `buildInvoiceLines` |
| `lib/invoice-draft.js` / `.d.ts` | modify | Passes both through |
| `lib/client-recap.js` | modify | Per-month pin on revenue; date-keyed cost; estimate rates |
| `lib/firm-analytics.js` | modify | Revenue through the resolver; date-keyed cost |
| `lib/payroll-cost.js` / `.d.ts` | modify | `costRateOf(employeeId, entryDate)` |
| `src/lib/utils.ts` | modify | `getInvoice` passes versions + pin |
| `src/lib/api.ts`, `src/lib/types.ts` | modify | Six new calls, three new types, two new `Client` fields |
| `src/pages/TeamPage.tsx` | modify | Effective-from inputs + history disclosures |
| `src/pages/ClientDetailPage.tsx` | modify | The "Hourly rates" block |
| `src/pages/ClientRecapPage.tsx` | modify | The multi-month caption and the cost basis note |
| `src/pages/ReportsPage.tsx` | modify | Cost through the date-keyed resolver |
| `docs/capability-manifest.md` | modify | Four entries updated, one added |

---

### Task 1: The resolver

**Files:**
- Create: `lib/rate-history.js`
- Create: `lib/rate-history.d.ts`
- Test: `lib/rate-history.test.mjs` (create)

**Interfaces:**
- Consumes: nothing. Pure, no I/O, no clock.
- Produces:
  - `billRateFor(versions, employeeId, ratePeriod): number | null`
  - `costRateFor(versions, employeeId, entryDate): number | null`
  - `latestBillRate(versions, employeeId): number | null`
  - `latestCostRate(versions, employeeId): number | null`
  - `ratePeriodAsOf(client, period): string | null`

- [ ] **Step 1: Write the failing test**

  Create `lib/rate-history.test.mjs`:

  ```js
  import { describe, expect, it } from 'vitest'
  import {
    billRateFor,
    costRateFor,
    latestBillRate,
    latestCostRate,
    ratePeriodAsOf,
  } from './rate-history.js'

  const bill = [
    { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
    { userId: 'emp-lisa', effectivePeriod: '2027-01', rate: 55 },
    { userId: 'emp-allison', effectivePeriod: '2026-09', rate: 70 },
  ]

  describe('billRateFor', () => {
    it('hits an exact month', () => {
      expect(billRateFor(bill, 'emp-lisa', '2026-06')).toBe(40)
      expect(billRateFor(bill, 'emp-lisa', '2027-01')).toBe(55)
    })

    it('carries the latest version forward to a later month', () => {
      expect(billRateFor(bill, 'emp-lisa', '2026-12')).toBe(40)
      expect(billRateFor(bill, 'emp-lisa', '2030-03')).toBe(55)
    })

    it('is null before the first version', () => {
      expect(billRateFor(bill, 'emp-lisa', '2026-05')).toBeNull()
      expect(billRateFor(bill, 'emp-allison', '2026-08')).toBeNull()
    })

    it('does not read one person’s versions for another', () => {
      expect(billRateFor(bill, 'emp-allison', '2026-09')).toBe(70)
      expect(billRateFor(bill, 'emp-nobody', '2026-09')).toBeNull()
    })

    it('does not depend on the input order', () => {
      const shuffled = [bill[1], bill[2], bill[0]]
      expect(billRateFor(shuffled, 'emp-lisa', '2026-12')).toBe(40)
    })

    it('answers null for a missing period or a missing list', () => {
      expect(billRateFor(bill, 'emp-lisa', null)).toBeNull()
      expect(billRateFor(null, 'emp-lisa', '2026-06')).toBeNull()
    })
  })

  const cost = [
    { userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 },
    { userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 },
  ]

  describe('costRateFor', () => {
    it('costs the day before a raise at the old rate and the day of it at the new', () => {
      expect(costRateFor(cost, 'emp-lisa', '2026-09-14')).toBe(20)
      expect(costRateFor(cost, 'emp-lisa', '2026-09-15')).toBe(24)
      expect(costRateFor(cost, 'emp-lisa', '2026-09-16')).toBe(24)
    })

    it('is null before the first version', () => {
      expect(costRateFor(cost, 'emp-lisa', '1969-12-31')).toBeNull()
    })
  })

  describe('latestBillRate / latestCostRate', () => {
    it('returns the greatest version, whatever the order', () => {
      expect(latestBillRate([bill[1], bill[0]], 'emp-lisa')).toBe(55)
      expect(latestCostRate(cost, 'emp-lisa')).toBe(24)
    })

    it('is null for someone with no versions', () => {
      expect(latestBillRate(bill, 'emp-nobody')).toBeNull()
      expect(latestCostRate(cost, 'emp-nobody')).toBeNull()
    })
  })

  describe('ratePeriodAsOf', () => {
    const moved = {
      hourlyRatePeriod: '2026-09',
      hourlyRateHistory: [
        { from: null, to: '2026-06', changedAt: '2026-06-01T00:00:00.000Z', changedBy: 'emp-patrice' },
        { from: '2026-06', to: '2026-09', changedAt: '2026-08-20T00:00:00.000Z', changedBy: 'emp-patrice' },
      ],
    }

    it('reads the pin that applied in a past month, not today’s', () => {
      expect(ratePeriodAsOf(moved, '2026-07')).toBe('2026-06')
      expect(ratePeriodAsOf(moved, '2026-09')).toBe('2026-09')
      expect(ratePeriodAsOf(moved, '2026-12')).toBe('2026-09')
    })

    it('falls back to the earliest from when the month predates every move', () => {
      expect(ratePeriodAsOf(moved, '2026-05')).toBeNull()
    })

    it('uses the live pin when there is no history', () => {
      expect(ratePeriodAsOf({ hourlyRatePeriod: '2026-06', hourlyRateHistory: [] }, '2026-09')).toBe('2026-06')
      expect(ratePeriodAsOf({ hourlyRatePeriod: '2026-06' }, '2026-09')).toBe('2026-06')
    })

    it('is null for a client with neither', () => {
      expect(ratePeriodAsOf({}, '2026-09')).toBeNull()
      expect(ratePeriodAsOf(null, '2026-09')).toBeNull()
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run lib/rate-history.test.mjs
  ```

  Expected: the run fails to collect the file — `Failed to resolve import "./rate-history.js"` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

  Create `lib/rate-history.js`:

  ```js
  /**
   * EFFECTIVE-DATED RATES — the one answer to "what did this person's hour cost,
   * or bill for, back then".
   *
   * Pure: same inputs, same answer, no clock and no I/O, exactly like
   * `lib/invoice-lines.js` and `lib/payroll-cost.js`. Every surface that prices
   * or costs time goes through here, so a raise can never mean two different
   * things on two screens.
   *
   * COMPARISON IS LEXICOGRAPHIC, on purpose. 'YYYY-MM' and 'YYYY-MM-DD' are
   * zero-padded fixed-width strings, so string order IS chronological order —
   * the convention `lib/invoice-lines.js` already bills by
   * (`billingPeriod >= PER_EMPLOYEE_BILLING_START`). No Date is constructed
   * anywhere in this file, which is also what keeps it free of time zones.
   *
   * `null` means NO RATE ON FILE and keeps today's meaning: on the bill side the
   * caller falls back to the employee's `billRate` and then the client's own
   * rate; on the cost side that person's time carries no labor cost (never
   * $0.00 — see `personPeriodCost`).
   */

  /** The greatest `key` <= `asOf` for this person, or null. */
  function resolve(versions, employeeId, asOf, key) {
    if (!Array.isArray(versions)) return null
    if (typeof employeeId !== 'string' || !employeeId) return null
    if (typeof asOf !== 'string' || !asOf) return null
    let best = null
    for (const version of versions) {
      if (!version || version.userId !== employeeId) continue
      const at = version[key]
      if (typeof at !== 'string' || !at || at > asOf) continue
      if (best === null || at > best[key]) best = version
    }
    const rate = Number(best?.rate)
    return best && Number.isFinite(rate) ? rate : null
  }

  /** The greatest `key` for this person regardless of date, or null. */
  function newest(versions, employeeId, key) {
    if (!Array.isArray(versions)) return null
    if (typeof employeeId !== 'string' || !employeeId) return null
    let best = null
    for (const version of versions) {
      if (!version || version.userId !== employeeId) continue
      const at = version[key]
      if (typeof at !== 'string' || !at) continue
      if (best === null || at > best[key]) best = version
    }
    const rate = Number(best?.rate)
    return best && Number.isFinite(rate) ? rate : null
  }

  /**
   * What this person's time BILLS at for a given rate period ('YYYY-MM') — the
   * row with the greatest `effectivePeriod` at or before it.
   */
  export function billRateFor(versions, employeeId, ratePeriod) {
    return resolve(versions, employeeId, ratePeriod, 'effectivePeriod')
  }

  /**
   * What this person's time COSTS on a given day ('YYYY-MM-DD') — the row with
   * the greatest `effectiveDate` at or before it.
   *
   * Keyed by the ENTRY DATE rather than the billing period because a raise lands
   * on a payday and the payroll report's windows are date ranges. A September
   * recap therefore costs September's entries at the rate in force on each
   * entry's own day.
   */
  export function costRateFor(versions, employeeId, entryDate) {
    return resolve(versions, employeeId, entryDate, 'effectiveDate')
  }

  /** This person's newest bill rate — what `users.bill_rate` mirrors. */
  export function latestBillRate(versions, employeeId) {
    return newest(versions, employeeId, 'effectivePeriod')
  }

  /** This person's newest cost rate — what `users.cost_rate` mirrors. */
  export function latestCostRate(versions, employeeId) {
    return newest(versions, employeeId, 'effectiveDate')
  }

  /**
   * THE CLIENT'S PIN AS IT STOOD IN A GIVEN BILLING MONTH.
   *
   * A client pinned to June and moved to September in August bills July at
   * June's rates and October at September's. The live `hourlyRatePeriod` alone
   * cannot say that, so the move is also written to `hourlyRateHistory` as
   * `{ from, to, changedAt, changedBy }` and this reads it back:
   *
   *   1. the latest history entry whose `to` is at or before `period` — the pin
   *      that was in force that month;
   *   2. else, if there IS history, the earliest entry's `from` — where the
   *      client sat before the first move (null when it was never pinned);
   *   3. else the live `hourlyRatePeriod`, for a client that has never moved.
   *
   * Null means "no pin", and the caller then prices at the billing period
   * itself — today's rates, which is what an unpinned client has always done.
   */
  export function ratePeriodAsOf(client, period) {
    const history = Array.isArray(client?.hourlyRateHistory)
      ? client.hourlyRateHistory.filter(
          (entry) => entry && typeof entry.to === 'string' && entry.to,
        )
      : []
    if (history.length > 0 && typeof period === 'string' && period) {
      let applied = null
      for (const entry of history) {
        if (entry.to > period) continue
        if (applied === null || entry.to > applied.to) applied = entry
      }
      if (applied) return applied.to
      let earliest = history[0]
      for (const entry of history) if (entry.to < earliest.to) earliest = entry
      return typeof earliest.from === 'string' && earliest.from ? earliest.from : null
    }
    const pin = client?.hourlyRatePeriod
    return typeof pin === 'string' && pin ? pin : null
  }
  ```

  Create `lib/rate-history.d.ts`:

  ```ts
  /**
   * Types for the plain-JS `lib/rate-history.js`, so `src/` can resolve a rate
   * client-side (the Client page's "Hourly rates" block) through the very
   * function the server prices with.
   *
   * Keep these in sync with the actual exports in lib/rate-history.js.
   */

  export type BillRateVersion = {
    userId: string
    /** 'YYYY-MM' — the first billing period this rate applies to. */
    effectivePeriod: string
    rate: number
    createdAt?: string
    createdBy?: string | null
  }

  export type CostRateVersion = {
    userId: string
    /** 'YYYY-MM-DD' — the first day worked at this rate. */
    effectiveDate: string
    rate: number
    createdAt?: string
    createdBy?: string | null
  }

  export type RateHistoryEntry = {
    from: string | null
    to: string
    changedAt: string
    changedBy: string
  }

  export type PinnedClient = {
    hourlyRatePeriod?: string | null
    hourlyRateHistory?: readonly RateHistoryEntry[] | null
  }

  export declare function billRateFor(
    versions: readonly BillRateVersion[] | null | undefined,
    employeeId: string,
    ratePeriod: string | null | undefined,
  ): number | null

  export declare function costRateFor(
    versions: readonly CostRateVersion[] | null | undefined,
    employeeId: string,
    entryDate: string | null | undefined,
  ): number | null

  export declare function latestBillRate(
    versions: readonly BillRateVersion[] | null | undefined,
    employeeId: string,
  ): number | null

  export declare function latestCostRate(
    versions: readonly CostRateVersion[] | null | undefined,
    employeeId: string,
  ): number | null

  export declare function ratePeriodAsOf(
    client: PinnedClient | null | undefined,
    period: string | null | undefined,
  ): string | null
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run lib/rate-history.test.mjs
  npx eslint lib/rate-history.js
  ```

  Expected: `Test Files  1 passed (1)` with 15 passing tests; eslint silent.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/rate-history.js lib/rate-history.d.ts lib/rate-history.test.mjs
  git commit -m "$(cat <<'EOF'
Resolve a person's bill or cost rate as it stood in a given month or on a given day

Adds lib/rate-history.js: billRateFor / costRateFor pick the newest version at
or before the date asked about, latestBillRate / latestCostRate give the newest
of all, and ratePeriodAsOf reads a client's pin as it stood in a past billing
month from hourly_rate_history. Pure, lexicographic string comparison only, no
Date and no I/O — the same convention lib/invoice-lines.js already bills by.
Null means no rate on file, which keeps today's meaning on both sides.

Nothing calls it yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 2: Schema, slices and the migration (both backends)

**Files:**
- Modify: `db/store.js` — `CLIENT_SELECT_COLUMNS` (`:1437-1451`), `mapClientRow` (`:1540-1543`), `normalizeClientProfile` (`:589` area, end of the returned object), Postgres `initialize()` (`:4878-4881`), file `initialize()` (`:5045-5047`), `write()` Postgres snapshot (`:6330-6335`) and clients insert (`:6465-6576`), `write()` file preservation (`:7255-7293`), `createClient` (`:12766-12915`)
- Test: `db/store-staleness.test.mjs` (append at end of file)

**Interfaces:**
- Consumes: nothing new
- Produces:
  - Postgres tables `bill_rate_versions(user_id text references users(id) on delete cascade, effective_period text, rate numeric(12,2), created_at timestamptz default now(), created_by text, primary key(user_id, effective_period))` and `cost_rate_versions(user_id text references users(id) on delete cascade, effective_date date, rate numeric(12,2), created_at timestamptz default now(), created_by text, primary key(user_id, effective_date))`
  - Postgres columns `clients.hourly_rate_period text`, `clients.hourly_rate_history jsonb not null default '[]'`
  - File backend: `authState.billRateVersions` / `authState.costRateVersions` arrays in `tmp/auth-state.json`; `hourlyRatePeriod` / `hourlyRateHistory` on client records in `tmp/app-data.json`
  - Client read shape gains `hourlyRatePeriod: string | null` and `hourlyRateHistory: Array<{from, to, changedAt, changedBy}>` on BOTH backends

- [ ] **Step 1: Write the failing test**

  Append to `db/store-staleness.test.mjs`:

  ```js
  /**
   * RATE HISTORY — the migration and the two client fields.
   *
   * Spec §4: after the migration every price and every cost must equal today's
   * numbers exactly, which is only true if every user with a rate gets a floor
   * version and every hourly client gets a pin at the cutover.
   */
  describe('rate history: migration + client pin (file backend)', () => {
    beforeEach(async () => {
      const authState = JSON.parse(await readFile(localAuthPath, 'utf8'))
      authState.billRateVersions = []
      authState.costRateVersions = []
      authState.users = [
        { id: 'emp-lisa', name: 'Lisa', role: 'employee', billRate: 40, costRate: 20 },
        { id: 'emp-no-rates', name: 'Nobody', role: 'employee' },
      ]
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      await store.write(
        workspace({
          clients: [
            { id: 'c-hourly', name: 'Hourly Co', billingMode: 'hourly', hourlyRate: 100 },
            { id: 'c-monthly', name: 'Monthly Co', billingMode: 'subscription', monthlyRate: 500 },
          ],
          timeEntries: [],
        }),
      )
      await store.initialize()
    })

    it('seeds a bill-rate version at the cutover for every user with a bill rate', async () => {
      const versions = await store.listBillRateVersions()
      expect(versions).toEqual([
        expect.objectContaining({ userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 }),
      ])
    })

    it('seeds a cost-rate version at the 1970 floor for every user with a cost rate', async () => {
      const versions = await store.listCostRateVersions()
      expect(versions).toEqual([
        expect.objectContaining({ userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 }),
      ])
    })

    it('pins every hourly client at the cutover and leaves monthly clients alone', async () => {
      const data = await store.read()
      const hourly = data.clients.find((client) => client.id === 'c-hourly')
      const monthly = data.clients.find((client) => client.id === 'c-monthly')
      expect(hourly.hourlyRatePeriod).toBe('2026-06')
      expect(hourly.hourlyRateHistory).toEqual([])
      expect(monthly.hourlyRatePeriod).toBeNull()
    })

    it('is idempotent — a second boot adds nothing and moves no pin', async () => {
      await store.initialize()
      await store.initialize()
      expect(await store.listBillRateVersions()).toHaveLength(1)
      expect(await store.listCostRateVersions()).toHaveLength(1)
      const data = await store.read()
      expect(data.clients.find((client) => client.id === 'c-hourly').hourlyRatePeriod).toBe('2026-06')
    })

    it('does not move a pin a bulk save is stale about — the payload is ignored outright', async () => {
      await store.write(
        workspace({
          clients: [
            {
              id: 'c-hourly',
              name: 'Hourly Co',
              billingMode: 'hourly',
              hourlyRate: 100,
              // A stale owner tab still thinks this client is on the old pin.
              hourlyRatePeriod: '2020-01',
              hourlyRateHistory: [{ from: null, to: '2020-01', changedAt: 'x', changedBy: 'y' }],
            },
          ],
          timeEntries: [],
        }),
      )
      const data = await store.read()
      const hourly = data.clients.find((client) => client.id === 'c-hourly')
      expect(hourly.hourlyRatePeriod).toBe('2026-06')
      expect(hourly.hourlyRateHistory).toEqual([])
    })
  })

  describe('rate history: the Postgres statements', () => {
    it('creates both version tables and both client columns on initialize', async () => {
      const fake = fakePostgres()
      await postgresStore(fake).initialize()
      expect(fake.matching(/create table if not exists bill_rate_versions/i)).toHaveLength(1)
      expect(fake.matching(/create table if not exists cost_rate_versions/i)).toHaveLength(1)
      expect(
        fake.matching(/alter table clients add column if not exists hourly_rate_period text/i),
      ).toHaveLength(1)
      expect(
        fake.matching(
          /alter table clients add column if not exists hourly_rate_history jsonb not null default '\[\]'/i,
        ),
      ).toHaveLength(1)
    })

    it('backfills both version tables and the pin, each guarded so a re-run is a no-op', async () => {
      const fake = fakePostgres()
      await postgresStore(fake).initialize()
      const [billSeed] = fake.matching(/^insert into bill_rate_versions/i)
      expect(billSeed.text).toMatch(/where u\.bill_rate is not null/i)
      expect(billSeed.text).toMatch(/on conflict \(user_id, effective_period\) do nothing/i)
      expect(billSeed.text).toMatch(/'2026-06'/)
      const [costSeed] = fake.matching(/^insert into cost_rate_versions/i)
      expect(costSeed.text).toMatch(/where u\.cost_rate is not null/i)
      expect(costSeed.text).toMatch(/'1970-01-01'/)
      const [pinSeed] = fake.matching(/^update clients set hourly_rate_period/i)
      expect(pinSeed.text).toMatch(/where billing_mode = 'hourly' and hourly_rate_period is null/i)
    })

    it('selects both new client columns and maps them', async () => {
      expect(CLIENT_SELECT_COLUMNS).toMatch(/hourly_rate_period/)
      expect(CLIENT_SELECT_COLUMNS).toMatch(/hourly_rate_history/)
      const mapped = mapClientRow({
        id: 'c1',
        name: 'Acme',
        billing_mode: 'hourly',
        hourly_rate: 100,
        plan_ids: [],
        contact_ids: [],
        assigned_bookkeeper_ids: [],
        hourly_rate_period: '2026-06',
        hourly_rate_history: [{ from: null, to: '2026-06', changedAt: 'x', changedBy: 'y' }],
      })
      expect(mapped.hourlyRatePeriod).toBe('2026-06')
      expect(mapped.hourlyRateHistory).toEqual([
        { from: null, to: '2026-06', changedAt: 'x', changedBy: 'y' },
      ])
      expect(mapClientRow({ id: 'c2', name: 'B', plan_ids: [], contact_ids: [] }).hourlyRateHistory).toEqual([])
    })

    it('restores the STORED pin on a bulk save rather than the payload’s', async () => {
      const fake = fakePostgres({
        clientRows: [
          { id: 'c1', hourly_rate_period: '2026-06', hourly_rate_history: [] },
        ],
      })
      await postgresStore(fake).write(
        workspace({ clients: [{ id: 'c1', name: 'Acme', hourlyRatePeriod: '2020-01' }] }),
      )
      const [snapshot] = fake.matching(
        /^select id, hourly_rate_period, hourly_rate_history from clients$/i,
      )
      expect(snapshot, 'the bulk save never snapshotted the stored pin').toBeTruthy()
      const [insert] = fake.matching(/^insert into clients/i)
      expect(insert.text).toMatch(/hourly_rate_period, hourly_rate_history/)
    })
  })
  ```

  The `clientRows` answer for the new snapshot needs a branch in `fakePostgres`. Add it immediately before the `return { rows: [] }` default at `db/store-staleness.test.mjs:1195`:

  ```js
    // The rate-history pin snapshot the bulk save takes before the wipe — the
    // same idiom as `priorStripeCustomerIds`. Anchored on its exact shape so a
    // rewrite that stopped reading it falls through to the empty default and
    // the test fails loudly rather than passing on a stale answer.
    if (/^select id, hourly_rate_period, hourly_rate_history from clients$/i.test(trimmed)) {
      return { rows: clientRows }
    }
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run db/store-staleness.test.mjs -t "rate history"
  ```

  Expected failures: `store.listBillRateVersions is not a function`, and the Postgres statement tests reporting `expected [] to have a length of 1`.

- [ ] **Step 3: Write minimal implementation**

  **(a) `db/store.js` — Postgres schema + migration.** Insert after the `stripe_customer_id` alter (currently ends at `:4881`), before the `drop table if exists invoice_drafts` comment:

  ```js
      // ---- RATE HISTORY (docs/plans/rate-history-2026-09.md) ----
      //
      // Brittany raises rates one client at a time, at that client's yearly
      // review, and a raise must never change what a past Client Recap says the
      // work cost. One firm-wide number per person cannot do either, so the
      // rates become dated VERSIONS and each hourly client is PINNED to the
      // month whose bill rates it bills at.
      //
      // `users.bill_rate` / `users.cost_rate` stay and mirror the newest
      // version after every edit, so every reader that has not yet moved to the
      // resolver keeps working and nothing has to change in one step.
      //
      // `on delete cascade` on the user FK matches `sessions`: deleting a user
      // is a hard delete that takes their rows with it. The ordinary removal
      // path is a SOFT delete (`inactive_at`), which touches nothing here — an
      // inactive person's historical rates still price their historical hours.
      await this.pool.query(`
        create table if not exists bill_rate_versions (
          user_id text not null references users(id) on delete cascade,
          effective_period text not null,
          rate numeric(12, 2) not null,
          created_at timestamptz not null default now(),
          created_by text,
          primary key (user_id, effective_period)
        )
      `)
      await this.pool.query(`
        create table if not exists cost_rate_versions (
          user_id text not null references users(id) on delete cascade,
          effective_date date not null,
          rate numeric(12, 2) not null,
          created_at timestamptz not null default now(),
          created_by text,
          primary key (user_id, effective_date)
        )
      `)
      // The client's pin, and the ledger of its moves. `hourly_rate_history` is
      // an ARRAY of {from, to, changedAt, changedBy} — the nearest relative in
      // this schema is `recurring_reimbursements.coverage_history`, a stored
      // idempotent ledger read by a pure resolver rather than re-derived.
      await this.pool.query(
        `alter table clients add column if not exists hourly_rate_period text`,
      )
      await this.pool.query(
        `alter table clients add column if not exists hourly_rate_history jsonb not null default '[]'`,
      )
      // MIGRATION (spec §4), idempotent — every statement is guarded, so a boot
      // that has already run it writes nothing. The floors are chosen so that
      // after the migration every price and every cost equals today's numbers
      // exactly: '2026-06' is the per-employee billing cutover
      // (PER_EMPLOYEE_BILLING_START), and '1970-01-01' predates every time
      // entry the app has ever held.
      await this.pool.query(`
        insert into bill_rate_versions (user_id, effective_period, rate, created_by)
        select u.id, '2026-06', u.bill_rate, 'migration'
          from users u
         where u.bill_rate is not null
           and not exists (select 1 from bill_rate_versions v where v.user_id = u.id)
        on conflict (user_id, effective_period) do nothing
      `)
      await this.pool.query(`
        insert into cost_rate_versions (user_id, effective_date, rate, created_by)
        select u.id, '1970-01-01', u.cost_rate, 'migration'
          from users u
         where u.cost_rate is not null
           and not exists (select 1 from cost_rate_versions v where v.user_id = u.id)
        on conflict (user_id, effective_date) do nothing
      `)
      await this.pool.query(`
        update clients
           set hourly_rate_period = '2026-06', hourly_rate_history = '[]'::jsonb
         where billing_mode = 'hourly' and hourly_rate_period is null
      `)
  ```

  **(b) `db/store.js:1437` — `CLIENT_SELECT_COLUMNS`.** Append to the last line of the template literal so it reads:

  ```js
            bill_to_client_id, is_billing_master, invoice_recipient_client_id,
            hourly_rate_period, hourly_rate_history`
  ```

  **(c) `db/store.js:1540-1543` — `mapClientRow`.** After `invoiceRecipientClientId: row.invoice_recipient_client_id ?? null,` add:

  ```js
      // Rate history. The pin is null for a client that has never had one (every
      // monthly and annual client, by design — only Hourly uses it), and the
      // ledger is an empty array rather than undefined so every reader can
      // iterate without a null check. Same shape `normalizeClientProfile`
      // produces for the file backend — cardinal rule 1.
      hourlyRatePeriod: row.hourly_rate_period ?? null,
      hourlyRateHistory: Array.isArray(row.hourly_rate_history) ? row.hourly_rate_history : [],
  ```

  **(d) `db/store.js:519` — `normalizeClientProfile`.** Add two entries to the returned object, beside the other normalizations (anywhere after `assignedEmployeeIds: assignedTeam,`):

  ```js
      // Rate history, mirroring the Postgres read map exactly (cardinal rule 1).
      hourlyRatePeriod:
        typeof client.hourlyRatePeriod === 'string' && client.hourlyRatePeriod
          ? client.hourlyRatePeriod
          : null,
      hourlyRateHistory: Array.isArray(client.hourlyRateHistory) ? client.hourlyRateHistory : [],
  ```

  **(e) `db/store.js:6330` — `write()`, Postgres snapshot.** Immediately after the `priorStripeCustomerIds` block, add:

  ```js
        // The rate-history pin and its ledger, by the same rule as the Stripe
        // customer id above: they are ENDPOINT-OWNED
        // (`setClientHourlyRatePeriod` is the only writer) and the bulk-save
        // payload must not be consulted at all. Without this the re-insert
        // writes NULL and the next owner autosave un-pins every hourly client —
        // silently repricing the whole book at today's rates, which is exactly
        // the thing this feature exists to prevent. Stored wins outright.
        const priorRatePins = new Map(
          (
            await client.query(`select id, hourly_rate_period, hourly_rate_history from clients`)
          ).rows.map((row) => [
            row.id,
            {
              period: row.hourly_rate_period ?? null,
              history: Array.isArray(row.hourly_rate_history) ? row.hourly_rate_history : [],
            },
          ]),
        )
  ```

  **(f) `db/store.js:6465-6576` — the clients insert.** Add the two columns to the column list (after `bill_to_client_id, is_billing_master, invoice_recipient_client_id,`):

  ```
                  hourly_rate_period, hourly_rate_history,
  ```

  Renumber the `values (…)` list to end `$44, $45::jsonb, now())` (the two new placeholders go before `created_at`'s `$46`; write the list out in full rather than editing by eye — the existing list runs `$1 … $43, now()`, so the new shape is `$1 … $43, $44, $45::jsonb, $46, now())` with `$46` being `createdAtFor('clients', clientRecord.id)`). Then, in the params array, insert **before** `createdAtFor('clients', clientRecord.id),`:

  ```js
              // Stored wins outright (see the snapshot above). A brand-new
              // client has no entry and gets null / [] — right, because it has
              // no pin until the create path or the migration gives it one.
              priorRatePins.get(clientRecord.id)?.period ?? null,
              JSON.stringify(priorRatePins.get(clientRecord.id)?.history ?? []),
  ```

  **(g) `db/store.js:7255` — `write()`, file-backend preservation.** Inside the `if (previous) { … }` block, after the `priorTemplateCreatedAt` handling and before the closing brace, add:

  ```js
          // Cardinal rule 1 mirror of `priorRatePins` in the Postgres branch.
          // The pin and its ledger are endpoint-owned; what is stored wins and
          // the payload's copy is ignored outright. A client this file has
          // never seen keeps whatever the payload carried — the create path is
          // what pins a genuinely new client.
          const priorPinById = new Map(
            (Array.isArray(previous.clients) ? previous.clients : [])
              .filter((entry) => entry && typeof entry.id === 'string')
              .map((entry) => [
                entry.id,
                {
                  hourlyRatePeriod: entry.hourlyRatePeriod ?? null,
                  hourlyRateHistory: Array.isArray(entry.hourlyRateHistory)
                    ? entry.hourlyRateHistory
                    : [],
                },
              ]),
          )
          if (Array.isArray(data.clients)) {
            data.clients = data.clients.map((clientRecord) => {
              if (!clientRecord || typeof clientRecord.id !== 'string') return clientRecord
              const prior = priorPinById.get(clientRecord.id)
              if (!prior) return clientRecord
              return { ...clientRecord, ...prior }
            })
          }
  ```

  **(h) `db/store.js` — file `initialize()`.** After `await this.syncOwnerEmailInFile()` (currently `:5046`), add:

  ```js
      await this.migrateRateHistoryInFile()
  ```

  and add the method immediately after `initialize()` closes:

  ```js
    /**
     * Spec §4 on the FILE backend: the same four migration steps the Postgres
     * branch runs inline, idempotent, so a developer's workspace and production
     * agree about what a fresh boot produces (cardinal rule 1).
     *
     * The version slices live in the AUTH store beside `billRate`/`costRate`,
     * never in `tmp/app-data.json` — the bulk save replaces that file wholesale,
     * so a slice that is not in the payload is a slice the next autosave erases.
     * The client pin does live in the workspace blob, because it is a client
     * field; `write()` preserves it from what is stored (see `priorPinById`).
     */
    async migrateRateHistoryInFile() {
      const authState = await readJson(localAuthPath)
      let authMutated = false
      if (!Array.isArray(authState.billRateVersions)) {
        authState.billRateVersions = []
        authMutated = true
      }
      if (!Array.isArray(authState.costRateVersions)) {
        authState.costRateVersions = []
        authMutated = true
      }
      const createdAt = nowIso()
      for (const user of authState.users ?? []) {
        if (!user || typeof user.id !== 'string') continue
        if (
          typeof user.billRate === 'number' &&
          !authState.billRateVersions.some((row) => row && row.userId === user.id)
        ) {
          authState.billRateVersions.push({
            userId: user.id,
            effectivePeriod: '2026-06',
            rate: user.billRate,
            createdAt,
            createdBy: 'migration',
          })
          authMutated = true
        }
        if (
          typeof user.costRate === 'number' &&
          !authState.costRateVersions.some((row) => row && row.userId === user.id)
        ) {
          authState.costRateVersions.push({
            userId: user.id,
            effectiveDate: '1970-01-01',
            rate: user.costRate,
            createdAt,
            createdBy: 'migration',
          })
          authMutated = true
        }
      }
      if (authMutated) {
        await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      }

      if (!existsSync(localDataPath)) return
      const data = await readJson(localDataPath)
      let dataMutated = false
      for (const clientRecord of data.clients ?? []) {
        if (!clientRecord || clientRecord.billingMode !== 'hourly') continue
        if (typeof clientRecord.hourlyRatePeriod === 'string' && clientRecord.hourlyRatePeriod) {
          continue
        }
        clientRecord.hourlyRatePeriod = '2026-06'
        clientRecord.hourlyRateHistory = []
        dataMutated = true
      }
      if (dataMutated) {
        await writeFile(localDataPath, JSON.stringify(data, null, 2))
      }
    }
  ```

  **(i) `db/store.js:12766` — `createClient`.** Spec §2.2: a new client starts on the CURRENT rates. Inside the `normalizeClientProfile({ … })` call, add before the closing brace:

  ```js
        // A NEW client starts on the current rates: pinned to the month it is
        // created in, with an empty ledger. Only Hourly clients use a pin, so
        // Monthly and Annual get null — `ratePeriodAsOf` then answers null and
        // nothing prices off it. Server-side, deliberately: nothing visible
        // changes in the Add-client modal (spec §5).
        hourlyRatePeriod:
          (client.billingMode ?? 'hourly') === 'hourly' ? nowIso().slice(0, 7) : null,
        hourlyRateHistory: [],
  ```

  Add the two columns to the `insert into clients (…)` list in that method (after `invoice_recipient_client_id,`), extend the `values` list by two placeholders before `updated_at`'s `now()`, and add to the params array after `record.invoiceRecipientClientId ?? null,`:

  ```js
              record.hourlyRatePeriod,
              JSON.stringify(record.hourlyRateHistory ?? []),
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run db/store-staleness.test.mjs
  npx eslint db/store.js db/store-staleness.test.mjs
  ```

  Expected: the whole store suite green, including the 9 new `rate history` tests. No other test in that file changes.

- [ ] **Step 5: Commit**

  ```bash
  git add db/store.js db/store-staleness.test.mjs
  git commit -m "$(cat <<'EOF'
Store dated rate versions and a per-client rate pin on both backends

Adds bill_rate_versions and cost_rate_versions (Postgres) with matching auth-store
slices on the file backend, plus clients.hourly_rate_period and
clients.hourly_rate_history. initialize() runs spec section 4's four migration
steps idempotently on both backends: a bill-rate version at 2026-06 and a
cost-rate version at 1970-01-01 for every user who has a rate, and a 2026-06 pin
on every hourly client without one, so nothing reprices.

The pin and its ledger are endpoint-owned: the bulk save snapshots what is
stored and ignores the payload, the same rule stripe_customer_id follows. A
client created from here on is pinned to the month it was created in.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 3: Bill-rate version store methods

**Files:**
- Modify: `db/store.js` — new `RateVersionError` beside `BillingMasterError` (`:1019-1024`); new methods beside `setEmployeeBillRate` (`:15043-15070`)
- Test: `db/store-staleness.test.mjs` (append)

**Interfaces:**
- Consumes: `latestBillRate` from `lib/rate-history.js`
- Produces:
  - `listBillRateVersions(): Promise<Array<{userId, effectivePeriod, rate, createdAt, createdBy}>>` — every row, ordered by `userId` then `effectivePeriod` ascending
  - `upsertBillRateVersion({ userId, effectivePeriod, rate, actingUserId }): Promise<Array<version>>` — that user's versions after the write
  - `deleteBillRateVersion({ userId, effectivePeriod }): Promise<Array<version>>` — throws `RateVersionError` unless it is that user's newest AND no client's `hourlyRatePeriod` is at or after it
  - `class RateVersionError extends Error` (exported, `name: 'RateVersionError'`)
  - `setEmployeeBillRate(userId, rate)` becomes a thin wrapper over `upsertBillRateVersion` at the current month (unchanged signature and return value)

- [ ] **Step 1: Write the failing test**

  Append to `db/store-staleness.test.mjs`:

  ```js
  describe('bill rate versions (file backend)', () => {
    beforeEach(async () => {
      const authState = JSON.parse(await readFile(localAuthPath, 'utf8'))
      authState.billRateVersions = []
      authState.users = [{ id: 'emp-lisa', name: 'Lisa', role: 'employee' }]
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      await store.write(
        workspace({
          clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 }],
          timeEntries: [],
        }),
      )
    })

    const pin = async (period) => {
      const data = JSON.parse(await readFile(localDataPath, 'utf8'))
      data.clients[0].hourlyRatePeriod = period
      await writeFile(localDataPath, JSON.stringify(data, null, 2))
    }

    it('adds a version and mirrors the newest onto the user record', async () => {
      await store.upsertBillRateVersion({
        userId: 'emp-lisa',
        effectivePeriod: '2026-06',
        rate: 40,
        actingUserId: 'emp-patrice',
      })
      const versions = await store.upsertBillRateVersion({
        userId: 'emp-lisa',
        effectivePeriod: '2027-01',
        rate: 55,
        actingUserId: 'emp-patrice',
      })
      expect(versions.map((row) => row.effectivePeriod)).toEqual(['2026-06', '2027-01'])
      expect(versions[1].createdBy).toBe('emp-patrice')
      const members = await store.getTeamMembers()
      expect(members.find((member) => member.id === 'emp-lisa').billRate).toBe(55)
    })

    it('REPLACES the row when the same month is saved again — a correction', async () => {
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 })
      const versions = await store.upsertBillRateVersion({
        userId: 'emp-lisa',
        effectivePeriod: '2026-06',
        rate: 42,
      })
      expect(versions).toHaveLength(1)
      expect(versions[0].rate).toBe(42)
    })

    it('backfills an EARLIER month in order without moving the mirror', async () => {
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2027-01', rate: 55 })
      const versions = await store.upsertBillRateVersion({
        userId: 'emp-lisa',
        effectivePeriod: '2026-06',
        rate: 40,
      })
      expect(versions.map((row) => row.effectivePeriod)).toEqual(['2026-06', '2027-01'])
      const members = await store.getTeamMembers()
      expect(members.find((member) => member.id === 'emp-lisa').billRate).toBe(55)
    })

    it('deletes the newest version and re-mirrors', async () => {
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 })
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2027-01', rate: 55 })
      await pin('2026-06')
      const versions = await store.deleteBillRateVersion({
        userId: 'emp-lisa',
        effectivePeriod: '2027-01',
      })
      expect(versions.map((row) => row.effectivePeriod)).toEqual(['2026-06'])
      const members = await store.getTeamMembers()
      expect(members.find((member) => member.id === 'emp-lisa').billRate).toBe(40)
    })

    it('REFUSES to delete anything but the newest version', async () => {
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 })
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2027-01', rate: 55 })
      await pin('2026-06')
      await expect(
        store.deleteBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2026-06' }),
      ).rejects.toBeInstanceOf(RateVersionError)
    })

    it('REFUSES to delete a version a client is pinned at or after', async () => {
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 })
      await store.upsertBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2027-01', rate: 55 })
      await pin('2027-01')
      await expect(
        store.deleteBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2027-01' }),
      ).rejects.toThrow(/pinned/i)
    })

    it('setEmployeeBillRate still works and now writes this month’s version', async () => {
      const rate = await store.setEmployeeBillRate('emp-lisa', 48)
      expect(rate).toBe(48)
      const versions = await store.listBillRateVersions()
      expect(versions).toHaveLength(1)
      expect(versions[0].effectivePeriod).toMatch(/^\d{4}-\d{2}$/)
      expect(versions[0].rate).toBe(48)
      const members = await store.getTeamMembers()
      expect(members.find((member) => member.id === 'emp-lisa').billRate).toBe(48)
    })

    it('setEmployeeBillRate(null) clears the mirror and every version', async () => {
      await store.setEmployeeBillRate('emp-lisa', 48)
      expect(await store.setEmployeeBillRate('emp-lisa', null)).toBeNull()
      expect(await store.listBillRateVersions()).toEqual([])
      const members = await store.getTeamMembers()
      expect(members.find((member) => member.id === 'emp-lisa').billRate).toBeNull()
    })
  })

  describe('bill rate versions (postgres branch)', () => {
    it('upserts with ON CONFLICT and mirrors onto users in one pass', async () => {
      const fake = fakePostgres()
      await postgresStore(fake).upsertBillRateVersion({
        userId: 'emp-lisa',
        effectivePeriod: '2026-06',
        rate: 40,
        actingUserId: 'emp-patrice',
      })
      const [upsert] = fake.matching(/^insert into bill_rate_versions/i)
      expect(upsert.text).toMatch(
        /on conflict \(user_id, effective_period\) do update set rate = excluded\.rate/i,
      )
      expect(upsert.params).toEqual(['emp-lisa', '2026-06', 40, 'emp-patrice'])
      expect(fake.matching(/^update users set bill_rate/i)).toHaveLength(1)
    })

    it('deletes by the composite key', async () => {
      const fake = fakePostgres()
      const pgStore = postgresStore(fake)
      pgStore.listBillRateVersions = async () => [
        { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
      ]
      pgStore.read = async () => ({ clients: [] })
      await pgStore.deleteBillRateVersion({ userId: 'emp-lisa', effectivePeriod: '2026-06' })
      const [remove] = fake.matching(/^delete from bill_rate_versions/i)
      expect(remove.text).toMatch(/where user_id = \$1 and effective_period = \$2/i)
      expect(remove.params).toEqual(['emp-lisa', '2026-06'])
    })

    it('lists in user then period order', async () => {
      const fake = fakePostgres()
      await postgresStore(fake).listBillRateVersions()
      const [select] = fake.matching(/from bill_rate_versions/i)
      expect(select.text).toMatch(/order by user_id asc, effective_period asc/i)
    })
  })
  ```

  Add `RateVersionError` to the store import block at the top of `db/store-staleness.test.mjs` (`:7-24`), alphabetically after `PackageApplyError`.

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run db/store-staleness.test.mjs -t "bill rate versions"
  ```

  Expected: `SyntaxError: The requested module './store.js' does not provide an export named 'RateVersionError'`.

- [ ] **Step 3: Write minimal implementation**

  Add the import at the top of `db/store.js`, beside the other `lib/` imports:

  ```js
  import { latestBillRate, latestCostRate } from '../lib/rate-history.js'
  ```

  Add the error class after `BillingMasterError` (`db/store.js:1024`):

  ```js
  /**
   * A rate version that may not be deleted.
   *
   * A sentence rather than a code, like `BillingMasterError`: the endpoint maps
   * it to 409 and prints `message` verbatim, because the person pressing Delete
   * needs to know WHICH rule stopped them — "that is not the newest one" and
   * "a client is still billing at it" are different problems with different
   * fixes.
   */
  export class RateVersionError extends Error {
    constructor(message) {
      super(message)
      this.name = 'RateVersionError'
    }
  }
  ```

  Add the methods in `db/store.js` immediately before `setEmployeeBillRate` (`:15043`):

  ```js
    /**
     * Every bill-rate version, every person, oldest first per person.
     *
     * Owner-only at the endpoint layer — this is what the firm charges, and it
     * is redacted for staff the same way every other rate is.
     */
    async listBillRateVersions() {
      if (this.pool) {
        const { rows } = await this.pool.query(
          `select user_id, effective_period, rate, created_at, created_by
             from bill_rate_versions
            order by user_id asc, effective_period asc`,
        )
        return rows.map((row) => ({
          userId: row.user_id,
          effectivePeriod: row.effective_period,
          rate: Number(row.rate),
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
          createdBy: row.created_by ?? null,
        }))
      }
      const authState = await readJson(localAuthPath)
      const list = Array.isArray(authState.billRateVersions) ? authState.billRateVersions : []
      return list
        .filter((row) => row && typeof row.userId === 'string')
        .map((row) => ({
          userId: row.userId,
          effectivePeriod: row.effectivePeriod,
          rate: Number(row.rate),
          createdAt: row.createdAt ?? null,
          createdBy: row.createdBy ?? null,
        }))
        .sort(
          (a, b) =>
            a.userId.localeCompare(b.userId) ||
            a.effectivePeriod.localeCompare(b.effectivePeriod),
        )
    }

    /**
     * Save one person's bill rate for one month.
     *
     * REPLACE on the same month (a correction), INSERT otherwise — including a
     * month EARLIER than the newest, which is a legitimate backfill of a change
     * she forgot to record and simply sorts into place.
     *
     * Then `users.bill_rate` is re-mirrored from the NEWEST version, which is
     * what keeps every reader that has not moved to the resolver correct.
     * Backfilling an old month therefore leaves the mirror alone, which is right
     * — it did not change what this person bills today.
     *
     * Returns this user's versions, oldest first.
     */
    async upsertBillRateVersion({ userId, effectivePeriod, rate, actingUserId = null } = {}) {
      if (typeof userId !== 'string' || !userId) return []
      if (!/^\d{4}-\d{2}$/.test(String(effectivePeriod ?? ''))) return []
      const amount = Number(rate)
      if (!Number.isFinite(amount) || amount < 0) return []
      const normalized = Math.round(amount * 100) / 100

      if (this.pool) {
        await this.pool.query(
          `insert into bill_rate_versions (user_id, effective_period, rate, created_by)
           values ($1, $2, $3, $4)
           on conflict (user_id, effective_period)
             do update set rate = excluded.rate, created_by = excluded.created_by,
                           created_at = now()`,
          [userId, effectivePeriod, normalized, actingUserId],
        )
      } else {
        const authState = await readJson(localAuthPath)
        if (!Array.isArray(authState.billRateVersions)) authState.billRateVersions = []
        const existing = authState.billRateVersions.find(
          (row) => row && row.userId === userId && row.effectivePeriod === effectivePeriod,
        )
        if (existing) {
          existing.rate = normalized
          existing.createdAt = nowIso()
          existing.createdBy = actingUserId
        } else {
          authState.billRateVersions.push({
            userId,
            effectivePeriod,
            rate: normalized,
            createdAt: nowIso(),
            createdBy: actingUserId,
          })
        }
        await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      }

      await this._mirrorLatestBillRate(userId)
      return (await this.listBillRateVersions()).filter((row) => row.userId === userId)
    }

    /**
     * Remove one bill-rate version.
     *
     * TWO GUARDS, and both are about not rewriting history. Only the NEWEST
     * version may go — deleting an older one would silently reprice every month
     * it covered. And it may not go while any client is pinned at or after it,
     * because that client is billing at this exact row; removing it would drop
     * the person back to an earlier rate on an invoice already being prepared.
     *
     * Throws `RateVersionError`, which the endpoint maps to 409.
     */
    async deleteBillRateVersion({ userId, effectivePeriod } = {}) {
      if (typeof userId !== 'string' || !userId) return []
      const mine = (await this.listBillRateVersions()).filter((row) => row.userId === userId)
      const target = mine.find((row) => row.effectivePeriod === effectivePeriod)
      if (!target) return mine
      const newest = mine[mine.length - 1]
      if (newest.effectivePeriod !== effectivePeriod) {
        throw new RateVersionError(
          'Only the newest rate can be removed — an older one is what past months were billed at.',
        )
      }
      const data = await this.read()
      const pinnedAtOrAfter = (data.clients ?? []).some(
        (clientRecord) =>
          typeof clientRecord?.hourlyRatePeriod === 'string' &&
          clientRecord.hourlyRatePeriod >= effectivePeriod,
      )
      if (pinnedAtOrAfter) {
        throw new RateVersionError(
          'A client is pinned at or after this month, so it is still billing at this rate. Move that client first.',
        )
      }

      if (this.pool) {
        await this.pool.query(
          `delete from bill_rate_versions where user_id = $1 and effective_period = $2`,
          [userId, effectivePeriod],
        )
      } else {
        const authState = await readJson(localAuthPath)
        authState.billRateVersions = (
          Array.isArray(authState.billRateVersions) ? authState.billRateVersions : []
        ).filter((row) => !(row && row.userId === userId && row.effectivePeriod === effectivePeriod))
        await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      }

      await this._mirrorLatestBillRate(userId)
      return (await this.listBillRateVersions()).filter((row) => row.userId === userId)
    }

    /** `users.bill_rate` = the newest version, or null when there is none. */
    async _mirrorLatestBillRate(userId) {
      const versions = await this.listBillRateVersions()
      const mirror = latestBillRate(versions, userId)
      if (this.pool) {
        await this.pool.query(`update users set bill_rate = $2 where id = $1`, [userId, mirror])
        return mirror
      }
      const authState = await readJson(localAuthPath)
      const user = (authState.users ?? []).find((entry) => entry.id === userId)
      if (!user) return mirror
      if (mirror === null) delete user.billRate
      else user.billRate = mirror
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      return mirror
    }
  ```

  Replace the body of `setEmployeeBillRate` (`db/store.js:15049-15070`) so the whole method reads:

  ```js
    /**
     * Owner-only: set or clear a team member's BILL rate.
     *
     * NOW A THIN WRAPPER over the version list: saving a rate with no month
     * attached means "from this month on", which is what this control has always
     * meant and is the default the Team page's effective-from input offers.
     * Clearing removes EVERY version — there is no rate on file any more, so
     * there is no history of one either.
     *
     * Kept so the existing endpoint, the existing tests and any old client keep
     * working while the Team page moves to the dated control.
     */
    async setEmployeeBillRate(userId, rate) {
      if (!userId) return null
      if (rate === null || rate === undefined || rate === '') {
        if (this.pool) {
          await this.pool.query(`delete from bill_rate_versions where user_id = $1`, [userId])
        } else {
          const authState = await readJson(localAuthPath)
          authState.billRateVersions = (
            Array.isArray(authState.billRateVersions) ? authState.billRateVersions : []
          ).filter((row) => !(row && row.userId === userId))
          await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
        }
        return this._mirrorLatestBillRate(userId)
      }
      const n = Number(rate)
      if (!Number.isFinite(n) || n < 0) return null
      await this.upsertBillRateVersion({
        userId,
        effectivePeriod: nowIso().slice(0, 7),
        rate: n,
        actingUserId: null,
      })
      return Math.round(n * 100) / 100
    }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run db/store-staleness.test.mjs
  npx eslint db/store.js db/store-staleness.test.mjs
  ```

  Expected: green, with the 11 new `bill rate versions` tests passing.

- [ ] **Step 5: Commit**

  ```bash
  git add db/store.js db/store-staleness.test.mjs
  git commit -m "$(cat <<'EOF'
Save, replace and remove a person's bill rate one month at a time

listBillRateVersions / upsertBillRateVersion / deleteBillRateVersion on both
backends. Saving the same month replaces that row (a correction), an earlier
month backfills in order, and users.bill_rate is re-mirrored from the newest
version after every write so readers that have not moved to the resolver stay
correct. Deleting refuses anything but the newest version, and refuses that
while any client is pinned at or after it — the endpoint turns the refusal into
a 409 and prints the sentence.

setEmployeeBillRate is now a wrapper that writes this month's version, so the
existing endpoint and its callers are unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 4: Cost-rate version store methods

**Files:**
- Modify: `db/store.js` — new methods beside `setEmployeeCostRate` (`:15015-15041`)
- Test: `db/store-staleness.test.mjs` (append)

**Interfaces:**
- Consumes: `latestCostRate` from `lib/rate-history.js` (already imported by Task 3)
- Produces:
  - `listCostRateVersions(): Promise<Array<{userId, effectiveDate, rate, createdAt, createdBy}>>`
  - `upsertCostRateVersion({ userId, effectiveDate, rate, actingUserId }): Promise<Array<version>>`
  - `deleteCostRateVersion({ userId, effectiveDate }): Promise<Array<version>>` — newest only
  - `setEmployeeCostRate(userId, rate)` becomes a thin wrapper at today's date

- [ ] **Step 1: Write the failing test**

  Append to `db/store-staleness.test.mjs`:

  ```js
  describe('cost rate versions (file backend)', () => {
    beforeEach(async () => {
      const authState = JSON.parse(await readFile(localAuthPath, 'utf8'))
      authState.costRateVersions = []
      authState.users = [{ id: 'emp-lisa', name: 'Lisa', role: 'employee' }]
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    })

    it('adds versions and mirrors the newest onto the user record', async () => {
      await store.upsertCostRateVersion({
        userId: 'emp-lisa',
        effectiveDate: '1970-01-01',
        rate: 20,
      })
      const versions = await store.upsertCostRateVersion({
        userId: 'emp-lisa',
        effectiveDate: '2026-09-15',
        rate: 24,
        actingUserId: 'emp-patrice',
      })
      expect(versions.map((row) => row.effectiveDate)).toEqual(['1970-01-01', '2026-09-15'])
      const members = await store.getTeamMembers()
      expect(members.find((member) => member.id === 'emp-lisa').costRate).toBe(24)
    })

    it('REPLACES the row when the same day is saved again', async () => {
      await store.upsertCostRateVersion({ userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 })
      const versions = await store.upsertCostRateVersion({
        userId: 'emp-lisa',
        effectiveDate: '2026-09-15',
        rate: 25,
      })
      expect(versions).toHaveLength(1)
      expect(versions[0].rate).toBe(25)
    })

    it('deletes the newest version and re-mirrors', async () => {
      await store.upsertCostRateVersion({ userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 })
      await store.upsertCostRateVersion({ userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 })
      const versions = await store.deleteCostRateVersion({
        userId: 'emp-lisa',
        effectiveDate: '2026-09-15',
      })
      expect(versions.map((row) => row.effectiveDate)).toEqual(['1970-01-01'])
      const members = await store.getTeamMembers()
      expect(members.find((member) => member.id === 'emp-lisa').costRate).toBe(20)
    })

    it('REFUSES to delete anything but the newest version', async () => {
      await store.upsertCostRateVersion({ userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 })
      await store.upsertCostRateVersion({ userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 })
      await expect(
        store.deleteCostRateVersion({ userId: 'emp-lisa', effectiveDate: '1970-01-01' }),
      ).rejects.toBeInstanceOf(RateVersionError)
    })

    it('setEmployeeCostRate still works and now writes today’s version', async () => {
      expect(await store.setEmployeeCostRate('emp-lisa', 22)).toBe(22)
      const versions = await store.listCostRateVersions()
      expect(versions).toHaveLength(1)
      expect(versions[0].effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(await store.setEmployeeCostRate('emp-lisa', null)).toBeNull()
      expect(await store.listCostRateVersions()).toEqual([])
    })
  })

  describe('cost rate versions (postgres branch)', () => {
    it('upserts with ON CONFLICT and mirrors onto users', async () => {
      const fake = fakePostgres()
      await postgresStore(fake).upsertCostRateVersion({
        userId: 'emp-lisa',
        effectiveDate: '2026-09-15',
        rate: 24,
        actingUserId: 'emp-patrice',
      })
      const [upsert] = fake.matching(/^insert into cost_rate_versions/i)
      expect(upsert.text).toMatch(
        /on conflict \(user_id, effective_date\) do update set rate = excluded\.rate/i,
      )
      expect(upsert.params).toEqual(['emp-lisa', '2026-09-15', 24, 'emp-patrice'])
      expect(fake.matching(/^update users set cost_rate/i)).toHaveLength(1)
    })

    it('reads the date as a plain YYYY-MM-DD string, never a Date', async () => {
      const fake = fakePostgres()
      await postgresStore(fake).listCostRateVersions()
      const [select] = fake.matching(/from cost_rate_versions/i)
      expect(select.text).toMatch(/to_char\(effective_date, 'YYYY-MM-DD'\)/i)
      expect(select.text).toMatch(/order by user_id asc, effective_date asc/i)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run db/store-staleness.test.mjs -t "cost rate versions"
  ```

  Expected: `store.upsertCostRateVersion is not a function`.

- [ ] **Step 3: Write minimal implementation**

  Add before `setEmployeeCostRate` in `db/store.js` (`:15015`):

  ```js
    /**
     * Every cost-rate version, every person, oldest first per person.
     *
     * The date comes back as a plain 'YYYY-MM-DD' STRING, never a Date: the
     * resolver compares lexicographically and a Date would drag the server's
     * time zone into what a person was paid on a given day. Same discipline as
     * `time_entries.entry_date` everywhere else in this file.
     */
    async listCostRateVersions() {
      if (this.pool) {
        const { rows } = await this.pool.query(
          `select user_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date,
                  rate, created_at, created_by
             from cost_rate_versions
            order by user_id asc, effective_date asc`,
        )
        return rows.map((row) => ({
          userId: row.user_id,
          effectiveDate: row.effective_date,
          rate: Number(row.rate),
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
          createdBy: row.created_by ?? null,
        }))
      }
      const authState = await readJson(localAuthPath)
      const list = Array.isArray(authState.costRateVersions) ? authState.costRateVersions : []
      return list
        .filter((row) => row && typeof row.userId === 'string')
        .map((row) => ({
          userId: row.userId,
          effectiveDate: row.effectiveDate,
          rate: Number(row.rate),
          createdAt: row.createdAt ?? null,
          createdBy: row.createdBy ?? null,
        }))
        .sort(
          (a, b) =>
            a.userId.localeCompare(b.userId) || a.effectiveDate.localeCompare(b.effectiveDate),
        )
    }

    /**
     * Save one person's cost rate from one DAY on. Same edit rule as the bill
     * side: replace on the same day, insert otherwise, mirror the newest onto
     * `users.cost_rate`.
     *
     * Keyed by day rather than by month because a raise lands on a payday and
     * the payroll report's windows are semi-monthly date ranges (spec §2.3).
     */
    async upsertCostRateVersion({ userId, effectiveDate, rate, actingUserId = null } = {}) {
      if (typeof userId !== 'string' || !userId) return []
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate ?? ''))) return []
      const amount = Number(rate)
      if (!Number.isFinite(amount) || amount < 0) return []
      const normalized = Math.round(amount * 100) / 100

      if (this.pool) {
        await this.pool.query(
          `insert into cost_rate_versions (user_id, effective_date, rate, created_by)
           values ($1, $2, $3, $4)
           on conflict (user_id, effective_date)
             do update set rate = excluded.rate, created_by = excluded.created_by,
                           created_at = now()`,
          [userId, effectiveDate, normalized, actingUserId],
        )
      } else {
        const authState = await readJson(localAuthPath)
        if (!Array.isArray(authState.costRateVersions)) authState.costRateVersions = []
        const existing = authState.costRateVersions.find(
          (row) => row && row.userId === userId && row.effectiveDate === effectiveDate,
        )
        if (existing) {
          existing.rate = normalized
          existing.createdAt = nowIso()
          existing.createdBy = actingUserId
        } else {
          authState.costRateVersions.push({
            userId,
            effectiveDate,
            rate: normalized,
            createdAt: nowIso(),
            createdBy: actingUserId,
          })
        }
        await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      }

      await this._mirrorLatestCostRate(userId)
      return (await this.listCostRateVersions()).filter((row) => row.userId === userId)
    }

    /**
     * Remove one cost-rate version — the NEWEST only, for the same reason the
     * bill side refuses an older one: an old version is what past months were
     * costed at, and a recap that changes after the fact is the thing this
     * whole feature exists to stop. No client-pin guard here: cost is keyed by
     * the entry date, so no client is pointing at a particular row.
     */
    async deleteCostRateVersion({ userId, effectiveDate } = {}) {
      if (typeof userId !== 'string' || !userId) return []
      const mine = (await this.listCostRateVersions()).filter((row) => row.userId === userId)
      const target = mine.find((row) => row.effectiveDate === effectiveDate)
      if (!target) return mine
      const newest = mine[mine.length - 1]
      if (newest.effectiveDate !== effectiveDate) {
        throw new RateVersionError(
          'Only the newest cost rate can be removed — an older one is what past months were costed at.',
        )
      }

      if (this.pool) {
        await this.pool.query(
          `delete from cost_rate_versions where user_id = $1 and effective_date = $2`,
          [userId, effectiveDate],
        )
      } else {
        const authState = await readJson(localAuthPath)
        authState.costRateVersions = (
          Array.isArray(authState.costRateVersions) ? authState.costRateVersions : []
        ).filter((row) => !(row && row.userId === userId && row.effectiveDate === effectiveDate))
        await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      }

      await this._mirrorLatestCostRate(userId)
      return (await this.listCostRateVersions()).filter((row) => row.userId === userId)
    }

    /** `users.cost_rate` = the newest version, or null when there is none. */
    async _mirrorLatestCostRate(userId) {
      const versions = await this.listCostRateVersions()
      const mirror = latestCostRate(versions, userId)
      if (this.pool) {
        await this.pool.query(`update users set cost_rate = $2 where id = $1`, [userId, mirror])
        return mirror
      }
      const authState = await readJson(localAuthPath)
      const user = (authState.users ?? []).find((entry) => entry.id === userId)
      if (!user) return mirror
      if (mirror === null) delete user.costRate
      else user.costRate = mirror
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      return mirror
    }
  ```

  Replace the body of `setEmployeeCostRate` (`db/store.js:15020-15041`) with:

  ```js
    async setEmployeeCostRate(userId, rate) {
      if (!userId) return null
      if (rate === null || rate === undefined || rate === '') {
        if (this.pool) {
          await this.pool.query(`delete from cost_rate_versions where user_id = $1`, [userId])
        } else {
          const authState = await readJson(localAuthPath)
          authState.costRateVersions = (
            Array.isArray(authState.costRateVersions) ? authState.costRateVersions : []
          ).filter((row) => !(row && row.userId === userId))
          await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
        }
        return this._mirrorLatestCostRate(userId)
      }
      const n = Number(rate)
      if (!Number.isFinite(n) || n < 0) return null
      await this.upsertCostRateVersion({
        userId,
        effectiveDate: nowIso().slice(0, 10),
        rate: n,
        actingUserId: null,
      })
      return Math.round(n * 100) / 100
    }
  ```

  Keep the existing doc comment above it and extend it with the same "NOW A THIN WRAPPER" note used on the bill side, substituting "today" for "this month".

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run db/store-staleness.test.mjs
  npx eslint db/store.js db/store-staleness.test.mjs
  ```

  Expected: green, 7 new `cost rate versions` tests passing.

- [ ] **Step 5: Commit**

  ```bash
  git add db/store.js db/store-staleness.test.mjs
  git commit -m "$(cat <<'EOF'
Save a person's cost rate from a given day on, and keep every earlier one

listCostRateVersions / upsertCostRateVersion / deleteCostRateVersion on both
backends, keyed by the day the rate starts because a raise lands on a payday and
the payroll windows are date ranges. Postgres reads the date back as a plain
YYYY-MM-DD string so no time zone can reach what someone was paid on a day.
Deleting refuses anything but the newest version. users.cost_rate mirrors the
newest, and setEmployeeCostRate is now a wrapper that writes today's version.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---
### Task 5: Moving a client to current rates

**Files:**
- Modify: `db/store.js` — new method beside `setClientAssignedTeam`
- Test: `db/store-staleness.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new
- Produces: `setClientHourlyRatePeriod({ clientId, period, actingUserId }): Promise<client | null>` — sets `hourly_rate_period` and APPENDS `{from, to, changedAt, changedBy}` to `hourly_rate_history`; returns the updated client in read shape, or null when there is no such client

- [ ] **Step 1: Write the failing test**

  Append to `db/store-staleness.test.mjs`:

  ```js
  describe('moving a client to current rates (file backend)', () => {
    beforeEach(async () => {
      await store.write(
        workspace({
          clients: [
            {
              id: 'c1',
              name: 'Acme',
              billingMode: 'hourly',
              hourlyRate: 100,
              hourlyRatePeriod: '2026-06',
              hourlyRateHistory: [],
            },
          ],
          timeEntries: [],
        }),
      )
    })

    it('sets the pin and appends the move to the ledger', async () => {
      const updated = await store.setClientHourlyRatePeriod({
        clientId: 'c1',
        period: '2026-10',
        actingUserId: 'emp-patrice',
      })
      expect(updated.hourlyRatePeriod).toBe('2026-10')
      expect(updated.hourlyRateHistory).toHaveLength(1)
      expect(updated.hourlyRateHistory[0]).toMatchObject({
        from: '2026-06',
        to: '2026-10',
        changedBy: 'emp-patrice',
      })
      expect(updated.hourlyRateHistory[0].changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('appends rather than replaces, so the ledger reads as a history', async () => {
      await store.setClientHourlyRatePeriod({ clientId: 'c1', period: '2026-10', actingUserId: 'u' })
      const updated = await store.setClientHourlyRatePeriod({
        clientId: 'c1',
        period: '2027-10',
        actingUserId: 'u',
      })
      expect(updated.hourlyRateHistory.map((entry) => entry.to)).toEqual(['2026-10', '2027-10'])
      expect(updated.hourlyRateHistory[1].from).toBe('2026-10')
    })

    it('survives a bulk save afterwards — the pin is endpoint-owned', async () => {
      await store.setClientHourlyRatePeriod({ clientId: 'c1', period: '2026-10', actingUserId: 'u' })
      await store.write(
        workspace({
          clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 }],
          timeEntries: [],
        }),
      )
      const data = await store.read()
      const client = data.clients.find((entry) => entry.id === 'c1')
      expect(client.hourlyRatePeriod).toBe('2026-10')
      expect(client.hourlyRateHistory).toHaveLength(1)
    })

    it('answers null for a client that is not there', async () => {
      expect(
        await store.setClientHourlyRatePeriod({ clientId: 'nope', period: '2026-10' }),
      ).toBeNull()
    })
  })

  describe('moving a client to current rates (postgres branch)', () => {
    it('writes both columns in ONE targeted update, never the bulk save', async () => {
      const fake = fakePostgres({
        clientRows: [{ id: 'c1', hourly_rate_period: '2026-06', hourly_rate_history: [] }],
      })
      const pgStore = postgresStore(fake)
      pgStore.read = async () => ({ clients: [{ id: 'c1', hourlyRatePeriod: '2026-10' }] })
      await pgStore.setClientHourlyRatePeriod({
        clientId: 'c1',
        period: '2026-10',
        actingUserId: 'emp-patrice',
      })
      const [update] = fake.matching(/^update clients set hourly_rate_period/i)
      expect(update.text).toMatch(/hourly_rate_history = \$3::jsonb/)
      expect(update.text).toMatch(/updated_at = now\(\)/)
      expect(update.text).toMatch(/where id = \$1/)
      expect(update.params[1]).toBe('2026-10')
      expect(JSON.parse(update.params[2])[0]).toMatchObject({ from: '2026-06', to: '2026-10' })
      expect(fake.matching(/^delete from clients/i)).toHaveLength(0)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run db/store-staleness.test.mjs -t "current rates"
  ```

  Expected: `store.setClientHourlyRatePeriod is not a function`.

- [ ] **Step 3: Write minimal implementation**

  Add to `db/store.js` immediately after `setClientAssignedTeam` closes:

  ```js
    /**
     * "Move to current rates from <month>" — the client page's one-press review
     * action (spec §2.2).
     *
     * A TARGETED ENDPOINT, deliberately, and this is the whole reason the pin is
     * not in the bulk-save clamp list: a stale owner tab autosaving yesterday's
     * snapshot must not be able to drag a client back onto rates she moved it
     * off this morning. Same call the team-picker fix made, for the same reason.
     *
     * The move is also APPENDED to `hourly_rate_history` as
     * `{from, to, changedAt, changedBy}`. That ledger is what lets
     * `ratePeriodAsOf` price a PAST month at the pin that was in force then — a
     * client moved in August still has July billed at June's rates, which is the
     * guarantee Brittany asked for. Appending rather than replacing is the whole
     * mechanism; nothing here ever rewrites an entry.
     *
     * Returns the updated client in read shape, or null when there is no such
     * client. Callers validate that the client is Hourly and that `period` is
     * 'YYYY-MM' before getting here (the endpoint answers 400 otherwise).
     */
    async setClientHourlyRatePeriod({ clientId, period, actingUserId = null } = {}) {
      if (typeof clientId !== 'string' || !clientId) return null
      if (!/^\d{4}-\d{2}$/.test(String(period ?? ''))) return null
      const changedAt = nowIso()

      if (this.pool) {
        const { rows } = await this.pool.query(
          `select hourly_rate_period, hourly_rate_history from clients where id = $1`,
          [clientId],
        )
        if (!rows[0]) return null
        const history = Array.isArray(rows[0].hourly_rate_history)
          ? rows[0].hourly_rate_history
          : []
        const next = [
          ...history,
          {
            from: rows[0].hourly_rate_period ?? null,
            to: period,
            changedAt,
            changedBy: actingUserId,
          },
        ]
        const result = await this.pool.query(
          `update clients
              set hourly_rate_period = $2, hourly_rate_history = $3::jsonb, updated_at = now()
            where id = $1
            returning id`,
          [clientId, period, JSON.stringify(next)],
        )
        if (!result.rowCount) return null
        const data = await this.read()
        return data.clients.find((entry) => entry.id === clientId) ?? null
      }

      const data = await readJson(localDataPath)
      let updated = null
      data.clients = (data.clients ?? []).map((entry) => {
        if (entry.id !== clientId) return entry
        const history = Array.isArray(entry.hourlyRateHistory) ? entry.hourlyRateHistory : []
        updated = {
          ...entry,
          hourlyRatePeriod: period,
          hourlyRateHistory: [
            ...history,
            {
              from: entry.hourlyRatePeriod ?? null,
              to: period,
              changedAt,
              changedBy: actingUserId,
            },
          ],
        }
        return updated
      })
      if (!updated) return null
      await writeFile(localDataPath, JSON.stringify(data, null, 2))
      return normalizeClientProfile(updated)
    }
  ```

  Add a `select hourly_rate_period, hourly_rate_history from clients where id = $1` branch to `fakePostgres` (immediately before the new `select id, hourly_rate_period…` branch from Task 2):

  ```js
    if (/^select hourly_rate_period, hourly_rate_history from clients where id = \$1$/i.test(trimmed)) {
      const found = clientRows.find((row) => row.id === params?.[0])
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 }
    }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run db/store-staleness.test.mjs
  npx eslint db/store.js db/store-staleness.test.mjs
  ```

  Expected: green, 5 new `current rates` tests passing.

- [ ] **Step 5: Commit**

  ```bash
  git add db/store.js db/store-staleness.test.mjs
  git commit -m "$(cat <<'EOF'
Move a client onto a chosen month's rates and keep a record of the move

setClientHourlyRatePeriod sets clients.hourly_rate_period and appends
{from, to, changedAt, changedBy} to hourly_rate_history on both backends. One
targeted UPDATE, never the bulk save, so a stale owner tab cannot drag a client
back onto rates she moved it off this morning. The appended ledger is what lets
ratePeriodAsOf price a past month at the pin that was in force then.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 6: Server helper, endpoints and staff redaction

**Files:**
- Modify: `server.js` — `buildCostRateMap` (`:593-602`), its two call sites (`:614`, `:3475`), `scopeAppDataForSession` (`:1092-1109`), new endpoints beside `PUT /api/team/bill-rate` (`:10578`) and beside `PUT /api/clients/:id/assigned-team` (`:10437`)
- Test: `lib/rate-history-server.test.mjs` (create)

**Interfaces:**
- Consumes: `listBillRateVersions`, `listCostRateVersions`, `upsertBillRateVersion`, `deleteBillRateVersion`, `upsertCostRateVersion`, `deleteCostRateVersion`, `setClientHourlyRatePeriod`, `RateVersionError`
- Produces:
  - `loadRateVersions(session): Promise<{ billRateVersions, costRateVersions }>` — the real lists for an owner, two empty arrays otherwise
  - `GET /api/rate-versions` → `{ billRateVersions, costRateVersions }` (owner-only)
  - `PUT /api/team/bill-rate-version` body `{ userId, effectivePeriod, rate }` → `{ ok, userId, versions }`
  - `DELETE /api/team/bill-rate-version` body `{ userId, effectivePeriod }` → `{ ok, userId, versions }`, 409 on `RateVersionError`
  - `PUT /api/team/cost-rate-version` body `{ userId, effectiveDate, rate }`
  - `DELETE /api/team/cost-rate-version` body `{ userId, effectiveDate }`
  - `PUT /api/clients/:id/hourly-rate-period` body `{ period }` → the updated client; 400 unless the client is hourly and `period` matches `/^\d{4}-\d{2}$/`
  - `buildCostRateMap` is DELETED

- [ ] **Step 1: Write the failing test**

  `server.js` is not importable (it boots an HTTP listener), so this task is pinned the way the schema tripwires are: by scanning the source. Create `lib/rate-history-server.test.mjs`:

  ```js
  import { readFileSync } from 'node:fs'
  import { describe, expect, it } from 'vitest'

  // vitest runs from the repo root; a cwd-relative path sidesteps the
  // import.meta.url scheme differences between node and the vite runner.
  const source = readFileSync('server.js', 'utf8')

  describe('the rate-version routes exist and are owner-only', () => {
    const routes = [
      ["'/api/rate-versions'", 'GET'],
      ["'/api/team/bill-rate-version'", 'PUT'],
      ["'/api/team/bill-rate-version'", 'DELETE'],
      ["'/api/team/cost-rate-version'", 'PUT'],
      ["'/api/team/cost-rate-version'", 'DELETE'],
    ]
    for (const [path, method] of routes) {
      it(`${method} ${path} is routed`, () => {
        expect(source).toContain(`normalizedPath === ${path} && request.method === '${method}'`)
      })
    }

    it('routes the targeted client pin update', () => {
      expect(source).toMatch(/\/\^\\\/api\\\/clients\\\/\(\[\^\/\]\+\)\\\/hourly-rate-period\$\//)
    })

    it('has exactly one owner guard per new route', () => {
      expect(
        source.match(/Only owners can see rate history|Only owners can set rate versions|Only owners can move a client’s rates/g),
      ).not.toBeNull()
    })
  })

  describe('loadRateVersions replaced buildCostRateMap', () => {
    it('defines loadRateVersions', () => {
      expect(source).toContain('async function loadRateVersions(session)')
    })

    it('no longer defines or calls buildCostRateMap', () => {
      expect(source).not.toContain('buildCostRateMap')
    })

    it('hands staff two empty lists rather than the real rates', () => {
      const body = source.slice(
        source.indexOf('async function loadRateVersions(session)'),
        source.indexOf('async function loadRateVersions(session)') + 900,
      )
      expect(body).toContain("session?.user?.role !== 'owner'")
      expect(body).toContain('billRateVersions: [], costRateVersions: []')
    })
  })

  describe('staff redaction covers the pin and its ledger', () => {
    it('blanks both fields beside the other rates in scopeAppDataForSession', () => {
      const start = source.indexOf('function scopeAppDataForSession(session, data)')
      const body = source.slice(start, start + 2000)
      expect(body).toContain('hourlyRate: 0,')
      expect(body).toContain('hourlyRatePeriod: null,')
      expect(body).toContain('hourlyRateHistory: [],')
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run lib/rate-history-server.test.mjs
  ```

  Expected: 10 failures — the routes, `loadRateVersions` and both redaction lines are all absent, and `buildCostRateMap` is still present.

- [ ] **Step 3: Write minimal implementation**

  **(a) Replace `buildCostRateMap` (`server.js:593-602`) with:**

  ```js
  /**
   * The rate history the caller is allowed to see.
   *
   * Replaces `buildCostRateMap()`, which returned one live cost rate per person
   * and so repriced every past month the moment anybody got a raise. Everything
   * downstream now takes the VERSIONS and resolves them through
   * `lib/rate-history.js`.
   *
   * RATES ARE OWNER-ONLY. A staff session gets two empty lists rather than a
   * filtered set: with no versions, `billRateFor` and `costRateFor` answer null,
   * the recap's cost is zero and the invoice falls back exactly as it does for a
   * person with no rate on file. That is the same stance
   * `scopeAppDataForSession` takes with `hourlyRate`, and it means no caller
   * needs a role branch of its own.
   */
  async function loadRateVersions(session) {
    if (session?.user?.role !== 'owner') {
      return { billRateVersions: [], costRateVersions: [] }
    }
    const [billRateVersions, costRateVersions] = await Promise.all([
      appDataStore.listBillRateVersions(),
      appDataStore.listCostRateVersions(),
    ])
    return { billRateVersions, costRateVersions }
  }
  ```

  **(b) `server.js:609-615` — the assistant tool.** The assistant loop is owner-only at the chat endpoint, so pass an owner-shaped session:

  ```js
      get_client_profitability: async (input) => {
        const data = await appDataStore.read()
        const month = /^\d{4}-\d{2}$/.test(String(input.month || ''))
          ? input.month
          : todayIso().slice(0, 7)
        // The chat endpoint is owner-only, so the full history is in scope here.
        const { billRateVersions, costRateVersions } = await loadRateVersions({
          user: { role: 'owner' },
        })
        return clientProfitability(data, { month, billRateVersions, costRateVersions })
      },
  ```

  **(c) `server.js:3474-3543` — the recap route.** Replace

  ```js
        const includeFinancials = session.user.role === 'owner'
        const costRates = includeFinancials ? await buildCostRateMap() : {}
  ```

  with

  ```js
        const includeFinancials = session.user.role === 'owner'
        const { billRateVersions, costRateVersions } = await loadRateVersions(session)
  ```

  and replace each `costRates,` in the two `buildClientRecap({ … })` calls (`:3513` and `:3542`) with

  ```js
            billRateVersions,
            costRateVersions,
  ```

  **(d) `server.js:1092-1109` — `scopeAppDataForSession`.** Add two lines inside the client map, immediately after `hourlyRate: 0,`:

  ```js
        // The pin and its ledger are rate data: the pin names the month whose
        // bill rates this client is charged at, and the ledger is a record of
        // every price change. Blanked beside the rate itself, for the same
        // reason — what PB&J charges is between the owner and the client.
        hourlyRatePeriod: null,
        hourlyRateHistory: [],
  ```

  **(e) The team rate-version endpoints.** Insert after the `PUT /api/team/bill-rate` block closes (`server.js:10578`):

  ```js
      // Owner-only: the whole rate history, both sides. The Team page's history
      // disclosures and the Client page's "Hourly rates" block read from here
      // rather than from the workspace blob — `read()` deliberately does not
      // select rate data, so it never reaches a staff session at all.
      if (normalizedPath === '/api/rate-versions' && request.method === 'GET') {
        const session = await requireSession(request, response)
        if (!session) return
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can see rate history' })
          return
        }
        sendJson(response, 200, await loadRateVersions(session))
        return
      }

      // Owner-only: save one person's BILL rate for one month. Saving a month
      // that already has a row replaces it (a correction); any other month is a
      // new version. `users.bill_rate` re-mirrors the newest afterwards.
      if (normalizedPath === '/api/team/bill-rate-version' && request.method === 'PUT') {
        const session = await requireSession(request, response)
        if (!session) return
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can set rate versions' })
          return
        }
        const contentType = String(request.headers['content-type'] || '')
        if (!contentType.toLowerCase().includes('application/json')) {
          sendJson(response, 415, { error: 'application/json required' })
          return
        }
        if (isCrossSiteOrigin(request)) {
          sendJson(response, 403, { error: 'Origin not allowed' })
          return
        }
        const payload = await readJsonBody(request)
        const userId = String(payload?.userId ?? '')
        const effectivePeriod = String(payload?.effectivePeriod ?? '')
        const rate = Number(payload?.rate)
        if (!userId) {
          sendJson(response, 400, { error: 'userId is required' })
          return
        }
        if (!/^\d{4}-\d{2}$/.test(effectivePeriod)) {
          sendJson(response, 400, { error: 'effectivePeriod must be YYYY-MM' })
          return
        }
        if (!Number.isFinite(rate) || rate < 0) {
          sendJson(response, 400, { error: 'rate must be a non-negative number' })
          return
        }
        const versions = await appDataStore.upsertBillRateVersion({
          userId,
          effectivePeriod,
          rate,
          actingUserId: session.user.id,
        })
        sendJson(response, 200, { ok: true, userId, versions })
        return
      }

      // Owner-only: remove one BILL rate version. The store refuses anything but
      // the newest, and refuses that while a client is still pinned at or after
      // it — both come back as a sentence, which is what 409 carries.
      if (normalizedPath === '/api/team/bill-rate-version' && request.method === 'DELETE') {
        const session = await requireSession(request, response)
        if (!session) return
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can set rate versions' })
          return
        }
        if (isCrossSiteOrigin(request)) {
          sendJson(response, 403, { error: 'Origin not allowed' })
          return
        }
        const payload = await readJsonBody(request)
        const userId = String(payload?.userId ?? '')
        const effectivePeriod = String(payload?.effectivePeriod ?? '')
        if (!userId || !/^\d{4}-\d{2}$/.test(effectivePeriod)) {
          sendJson(response, 400, { error: 'userId and effectivePeriod (YYYY-MM) are required' })
          return
        }
        try {
          const versions = await appDataStore.deleteBillRateVersion({ userId, effectivePeriod })
          sendJson(response, 200, { ok: true, userId, versions })
        } catch (error) {
          if (error instanceof RateVersionError) {
            sendJson(response, 409, { error: 'rate_version_locked', message: error.message })
            return
          }
          throw error
        }
        return
      }

      // Owner-only: save one person's COST rate from one day on. Same rules as
      // the bill side, keyed by date rather than month.
      if (normalizedPath === '/api/team/cost-rate-version' && request.method === 'PUT') {
        const session = await requireSession(request, response)
        if (!session) return
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can set rate versions' })
          return
        }
        const contentType = String(request.headers['content-type'] || '')
        if (!contentType.toLowerCase().includes('application/json')) {
          sendJson(response, 415, { error: 'application/json required' })
          return
        }
        if (isCrossSiteOrigin(request)) {
          sendJson(response, 403, { error: 'Origin not allowed' })
          return
        }
        const payload = await readJsonBody(request)
        const userId = String(payload?.userId ?? '')
        const effectiveDate = String(payload?.effectiveDate ?? '')
        const rate = Number(payload?.rate)
        if (!userId) {
          sendJson(response, 400, { error: 'userId is required' })
          return
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
          sendJson(response, 400, { error: 'effectiveDate must be YYYY-MM-DD' })
          return
        }
        if (!Number.isFinite(rate) || rate < 0) {
          sendJson(response, 400, { error: 'rate must be a non-negative number' })
          return
        }
        const versions = await appDataStore.upsertCostRateVersion({
          userId,
          effectiveDate,
          rate,
          actingUserId: session.user.id,
        })
        sendJson(response, 200, { ok: true, userId, versions })
        return
      }

      // Owner-only: remove one COST rate version — the newest only.
      if (normalizedPath === '/api/team/cost-rate-version' && request.method === 'DELETE') {
        const session = await requireSession(request, response)
        if (!session) return
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can set rate versions' })
          return
        }
        if (isCrossSiteOrigin(request)) {
          sendJson(response, 403, { error: 'Origin not allowed' })
          return
        }
        const payload = await readJsonBody(request)
        const userId = String(payload?.userId ?? '')
        const effectiveDate = String(payload?.effectiveDate ?? '')
        if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
          sendJson(response, 400, { error: 'userId and effectiveDate (YYYY-MM-DD) are required' })
          return
        }
        try {
          const versions = await appDataStore.deleteCostRateVersion({ userId, effectiveDate })
          sendJson(response, 200, { ok: true, userId, versions })
        } catch (error) {
          if (error instanceof RateVersionError) {
            sendJson(response, 409, { error: 'rate_version_locked', message: error.message })
            return
          }
          throw error
        }
        return
      }
  ```

  **(f) The client pin endpoint.** Insert after the `PUT /api/clients/:id/assigned-team` block closes (`server.js:10437`):

  ```js
      // PUT /api/clients/:id/hourly-rate-period — owner-only. "Move to current
      // rates from <month>". A TARGETED endpoint rather than part of the bulk
      // save, so a stale owner tab can never clobber a pin (cardinal rule 4).
      const clientRatePeriodMatch = normalizedPath.match(
        /^\/api\/clients\/([^/]+)\/hourly-rate-period$/,
      )
      if (clientRatePeriodMatch) {
        const session = await requireSession(request, response)
        if (!session) return
        if (request.method !== 'PUT') {
          sendJson(response, 405, { error: 'Method not allowed' })
          return
        }
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can move a client’s rates' })
          return
        }
        const clientId = clientRatePeriodMatch[1]
        const payload = await readJsonBody(request)
        const period = String(payload?.period ?? '')
        if (!/^\d{4}-\d{2}$/.test(period)) {
          sendJson(response, 400, { error: 'period must be YYYY-MM' })
          return
        }
        const data = await appDataStore.read()
        const target = (data.clients ?? []).find((entry) => entry.id === clientId)
        if (!target) {
          sendJson(response, 404, { error: 'Client not found' })
          return
        }
        // Only Hourly clients bill off a person's rate, so only they have a pin.
        // Refused out loud rather than silently stored, because a pin on a
        // monthly client would be a setting that never does anything.
        if (target.billingMode !== 'hourly') {
          sendJson(response, 400, {
            error: 'not_hourly',
            message: 'Only Hourly clients bill at a person’s rate, so only they have a rate month.',
          })
          return
        }
        const updated = await appDataStore.setClientHourlyRatePeriod({
          clientId,
          period,
          actingUserId: session.user.id,
        })
        if (!updated) {
          sendJson(response, 404, { error: 'Client not found' })
          return
        }
        await appDataStore.recordActivity(
          session.user.id,
          'client_rate_period_moved',
          updated.name ?? clientId,
        )
        sendJson(response, 200, updated)
        return
      }
  ```

  **(g)** Add `RateVersionError` to the `db/store.js` import list at the top of `server.js` (`:9` area, beside `BillingMasterError`).

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run lib/rate-history-server.test.mjs
  npx eslint server.js lib/rate-history-server.test.mjs
  node --check server.js
  ```

  Expected: 10 passing tests, eslint silent, `node --check` silent. `clientProfitability` and `buildClientRecap` do not yet accept the new opts — that is Tasks 9 and 11, and the extra keys are ignored until then.

- [ ] **Step 5: Commit**

  ```bash
  git add server.js lib/rate-history-server.test.mjs
  git commit -m "$(cat <<'EOF'
Serve the rate history to owners only and let them edit it one version at a time

loadRateVersions replaces buildCostRateMap: it hands owners both version lists
and everyone else two empty arrays, so a staff session resolves every rate to
null exactly as it already resolves hourlyRate to zero. Six new routes —
GET /api/rate-versions, PUT and DELETE for bill and cost versions, and the
targeted PUT /api/clients/:id/hourly-rate-period, which refuses a non-hourly
client and anything that is not YYYY-MM. A refused delete comes back as 409 with
the store's sentence.

scopeAppDataForSession now blanks hourlyRatePeriod and hourlyRateHistory beside
hourlyRate — the pin names the month a client is charged at and the ledger is a
record of every price change, so both are rate data.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 7: Pricing — `buildInvoiceLines` takes versions and a pin

**Files:**
- Modify: `lib/invoice-lines.js` (`:569-578` signature, `:671-677` `rateFor`)
- Modify: `lib/invoice-lines.d.ts` (`:76-112` `BuildInvoiceLinesArgs`)
- Test: `lib/rate-history-pricing.test.mjs` (create)

**Interfaces:**
- Consumes: `billRateFor` from `lib/rate-history.js`
- Produces: `buildInvoiceLines` accepts two new optional opts — `billRateVersions: Array<{userId, effectivePeriod, rate}>` (default `[]`) and `ratePeriod: string | null` (default `null`). `rateFor(employeeId)` becomes `billRateFor(billRateVersions, employeeId, ratePeriod ?? billingPeriod)` ?? `employee.billRate` ?? `defaultHourlyRate`.

- [ ] **Step 1: Write the failing test**

  Create `lib/rate-history-pricing.test.mjs`:

  ```js
  import { describe, expect, it } from 'vitest'
  import { buildInvoiceLines } from './invoice-lines.js'

  const employees = [
    { id: 'emp-lisa', name: 'Lisa', billRate: 55 },
    { id: 'emp-none', name: 'Nobody' },
  ]

  const client = (overrides = {}) => ({
    id: 'c1',
    name: 'Acme',
    billingMode: 'hourly',
    hourlyRate: 100,
    ...overrides,
  })

  const entries = (clientId) => [
    { id: 't1', clientId, employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-10' },
  ]

  const billRateVersions = [
    { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
    { userId: 'emp-lisa', effectivePeriod: '2026-09', rate: 55 },
  ]

  describe('buildInvoiceLines with rate versions', () => {
    it('bills two clients on different pins at different rates in the SAME period', () => {
      const oldPin = buildInvoiceLines({
        client: client({ id: 'c-old' }),
        entries: entries('c-old'),
        billingPeriod: '2026-09',
        employees,
        defaultHourlyRate: 100,
        billRateVersions,
        ratePeriod: '2026-06',
      })
      const newPin = buildInvoiceLines({
        client: client({ id: 'c-new' }),
        entries: entries('c-new'),
        billingPeriod: '2026-09',
        employees,
        defaultHourlyRate: 100,
        billRateVersions,
        ratePeriod: '2026-09',
      })
      expect(oldPin.lines[0].rate).toBe(40)
      expect(oldPin.lines[0].amount).toBe(40)
      expect(newPin.lines[0].rate).toBe(55)
      expect(newPin.lines[0].amount).toBe(55)
    })

    it('falls back to the billing period when no pin is given', () => {
      const built = buildInvoiceLines({
        client: client(),
        entries: entries('c1'),
        billingPeriod: '2026-06',
        employees,
        defaultHourlyRate: 100,
        billRateVersions,
      })
      expect(built.lines[0].rate).toBe(40)
    })

    it('falls back to the employee’s own billRate when they have no version', () => {
      const built = buildInvoiceLines({
        client: client(),
        entries: entries('c1'),
        billingPeriod: '2026-09',
        employees,
        defaultHourlyRate: 100,
        billRateVersions: [],
        ratePeriod: '2026-09',
      })
      expect(built.lines[0].rate).toBe(55)
    })

    it('falls back to the client’s own rate when there is neither', () => {
      const built = buildInvoiceLines({
        client: client(),
        entries: [
          { id: 't1', clientId: 'c1', employeeId: 'emp-none', minutes: 60, billable: true, date: '2026-09-10' },
        ],
        billingPeriod: '2026-09',
        employees,
        defaultHourlyRate: 100,
      })
      expect(built.lines[0].rate).toBe(100)
    })

    it('prices ad hoc work at the pin too', () => {
      const built = buildInvoiceLines({
        client: client(),
        entries: [
          {
            id: 't1',
            clientId: 'c1',
            employeeId: 'emp-lisa',
            minutes: 60,
            billable: true,
            date: '2026-09-10',
            description: 'One-off',
            isAdhoc: true,
          },
        ],
        billingPeriod: '2026-09',
        employees,
        defaultHourlyRate: 100,
        billRateVersions,
        ratePeriod: '2026-06',
      })
      const adhoc = built.lines.find((line) => line.kind === 'adhoc')
      expect(adhoc.amount).toBe(40)
      expect(adhoc.detail).toContain('$40.00/hr')
    })

    it('leaves the pre-cutover legacy branch alone', () => {
      const built = buildInvoiceLines({
        client: client(),
        entries: [
          { id: 't1', clientId: 'c1', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-05-10' },
        ],
        billingPeriod: '2026-05',
        employees,
        defaultHourlyRate: 100,
        billRateVersions,
        ratePeriod: '2026-06',
      })
      expect(built.lines[0].label).toBe('Billable hours')
      expect(built.lines[0].amount).toBe(100)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run lib/rate-history-pricing.test.mjs
  ```

  Expected: 4 failures (the two pin cases, the billing-period fallback, and the ad hoc case) — every one reporting `expected 55 to be 40` or similar, because the opts are ignored.

- [ ] **Step 3: Write minimal implementation**

  Add to the import block at the top of `lib/invoice-lines.js`, after the `staff-tiers.js` import:

  ```js
  // THE rate resolver (lib/rate-history.js). A client bills each person at that
  // person's rate AS IT STOOD in the client's pinned month, so pricing can no
  // longer read a single live number off the employee record.
  import { billRateFor } from './rate-history.js'
  ```

  Change the signature (`lib/invoice-lines.js:569-578`) to:

  ```js
  export function buildInvoiceLines({
    client,
    entries = [],
    plans = [],
    billingPeriod,
    reimbursements = [],
    recurringReimbursements = [],
    employees = [],
    defaultHourlyRate = 0,
    billRateVersions = [],
    ratePeriod = null,
  }) {
  ```

  Replace `rateFor` (`lib/invoice-lines.js:671-677`) with:

  ```js
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
    /**
     * WHAT ONE HOUR OF THIS PERSON'S TIME BILLS AT, for THIS client.
     *
     * A three-step fallback, and the order is the whole contract:
     *
     *   1. the person's bill rate AS IT STOOD in the client's pinned month
     *      (`ratePeriod`). This is the answer once the rate history exists, and
     *      it is what lets a new client start on higher rates while an existing
     *      one stays where it is until her yearly review moves it.
     *   2. the person's live `billRate`, which is a MIRROR of their newest
     *      version. Reached when nobody passed versions (every existing caller
     *      and every existing test) or when this person has no version at or
     *      before the pin.
     *   3. the client's own `defaultHourlyRate` — the firm default, the meaning
     *      "no rate on file" has always carried here.
     *
     * `ratePeriod ?? billingPeriod` is what makes an UNPINNED client price at
     * today's rates, exactly as it did before any of this existed.
     */
    const rateFor = (employeeId) => {
      const versioned = billRateFor(billRateVersions, employeeId, ratePeriod ?? billingPeriod)
      if (versioned !== null) return versioned
      const employee = employeeById.get(employeeId)
      return employee && typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
        ? employee.billRate
        : defaultHourlyRate
    }
  ```

  In `lib/invoice-lines.d.ts`, add to `BuildInvoiceLinesArgs` (after `defaultHourlyRate?: number`):

  ```ts
    /**
     * Dated bill rates (lib/rate-history.js). Absent or empty means "no history
     * passed", and every rate falls back to the employee's own `billRate`.
     */
    billRateVersions?: readonly import('./rate-history.js').BillRateVersion[]
    /**
     * The client's PIN — the month whose bill rates this client is charged at.
     * Null (or absent) prices at `billingPeriod`, i.e. today's rates.
     */
    ratePeriod?: string | null
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run lib/rate-history-pricing.test.mjs
  npx vitest run src/__tests__/get-invoice.test.ts lib/invoice-draft.test.mjs lib/adhoc-invoicing.test.mjs lib/invoice-billed-hours.test.mjs lib/client-recap.test.mjs
  npx eslint lib/invoice-lines.js lib/rate-history-pricing.test.mjs
  ```

  Expected: 6 new tests pass; every existing invoice test still passes untouched (the fallback chain is why).

- [ ] **Step 5: Commit**

  ```bash
  git add lib/invoice-lines.js lib/invoice-lines.d.ts lib/rate-history-pricing.test.mjs
  git commit -m "$(cat <<'EOF'
Bill each client at the rates in force in the month it is pinned to

buildInvoiceLines gains billRateVersions and ratePeriod. rateFor now asks the
resolver for the person's rate as it stood in the client's pinned month, then
falls back to their live billRate (which mirrors their newest version) and then
to the client's own rate. That fallback chain is what lets two clients on
different pins bill the same person at different rates in the same month while
every caller that passes nothing behaves exactly as it did.

The pre-June legacy branch is untouched: a pinned month before the cutover is
impossible because the migration floors at 2026-06.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 8: Every invoice caller passes the versions and the pin

**Files:**
- Modify: `lib/invoice-draft.js` (`:221-292` `buildInvoiceDraft`), `lib/invoice-draft.d.ts`
- Modify: `db/store.js` (`:10239-10257` `draftFor`, plus the surrounding generator so the lists are loaded once)
- Modify: `src/lib/utils.ts` (`:1649-1682` `getInvoice`)
- Test: `db/store-staleness.test.mjs` (append)

**Interfaces:**
- Consumes: `buildInvoiceLines` (Task 7), `ratePeriodAsOf` from `lib/rate-history.js`
- Produces:
  - `buildInvoiceDraft({ …, billRateVersions = [], ratePeriod = null })` — passes both straight through
  - `generateInvoicesForPeriod` loads `listBillRateVersions()` once and resolves each target's own pin
  - `getInvoice(client, entries, plans, billingPeriod, reimbursements, recurringReimbursements, employees, defaultHourlyRate, billRateVersions = [])` — resolves the pin itself with `ratePeriodAsOf(client, billingPeriod)`

- [ ] **Step 1: Write the failing test**

  Append to `db/store-staleness.test.mjs`:

  ```js
  describe('the month run bills each client at its own pin (file backend)', () => {
    beforeEach(async () => {
      const authState = JSON.parse(await readFile(localAuthPath, 'utf8'))
      authState.billRateVersions = [
        { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
        { userId: 'emp-lisa', effectivePeriod: '2026-09', rate: 55 },
      ]
      authState.users = [{ id: 'emp-lisa', name: 'Lisa', role: 'employee', billRate: 55 }]
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      await store.write(
        workspace({
          employees: [{ id: 'emp-lisa', name: 'Lisa', role: 'bookkeeper' }],
          clients: [
            {
              id: 'c-old',
              name: 'Old Pin Co',
              billingMode: 'hourly',
              hourlyRate: 100,
              lifecycleStage: 'active',
              hourlyRatePeriod: '2026-06',
              hourlyRateHistory: [],
            },
            {
              id: 'c-new',
              name: 'New Pin Co',
              billingMode: 'hourly',
              hourlyRate: 100,
              lifecycleStage: 'active',
              hourlyRatePeriod: '2026-09',
              hourlyRateHistory: [],
            },
          ],
          timeEntries: [
            { id: 't-old', clientId: 'c-old', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-10' },
            { id: 't-new', clientId: 'c-new', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-10' },
          ],
        }),
      )
    })

    it('prices the same person’s hour differently on two clients in one run', async () => {
      const result = await store.generateInvoicesForPeriod({ period: '2026-09' })
      const byClient = new Map(result.invoices.map((invoice) => [invoice.clientId, invoice]))
      expect(byClient.get('c-old').lineItems[0].rate).toBe(40)
      expect(byClient.get('c-old').total).toBe(40)
      expect(byClient.get('c-new').lineItems[0].rate).toBe(55)
      expect(byClient.get('c-new').total).toBe(55)
    })
  })
  ```

  If `generateInvoicesForPeriod`'s signature in this repo differs, read the method (`db/store.js`, search `async generateInvoicesForPeriod`) and call it exactly as the existing `consolidated billing: generateInvoicesForPeriod merges the subs` suite (`db/store-staleness.test.mjs:11689`) does — copy that call shape verbatim.

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run db/store-staleness.test.mjs -t "its own pin"
  ```

  Expected: `expected 55 to be 40` — both clients bill at today's rate because the generator passes no versions.

- [ ] **Step 3: Write minimal implementation**

  **(a) `lib/invoice-draft.js`.** Add to the JSDoc above `buildInvoiceDraft`:

  ```
   * @param {Array}  [args.billRateVersions]   dated bill rates (lib/rate-history.js)
   * @param {string|null} [args.ratePeriod]    the client's pin; null = today's rates
  ```

  Add the two parameters to the destructured signature (after `defaultHourlyRate = 0,`):

  ```js
    billRateVersions = [],
    ratePeriod = null,
  ```

  and pass them through in the `buildInvoiceLines({ … })` call (after `defaultHourlyRate,`):

  ```js
      billRateVersions,
      ratePeriod,
  ```

  Mirror both in `lib/invoice-draft.d.ts`'s `buildInvoiceDraft` argument type.

  `buildConsolidatedInvoiceDraft` needs NO change: it merges sub drafts that were already priced, which is exactly how each company keeps its own pin (spec §2.2).

  **(b) `db/store.js` — the generator.** Add the import at the top beside the Task 3 one:

  ```js
  import { latestBillRate, latestCostRate, ratePeriodAsOf } from '../lib/rate-history.js'
  ```

  In `generateInvoicesForPeriod`, immediately before the client loop that contains `draftFor` (just above `db/store.js:10190` — find the `for (const client of …)` that encloses the `draftFor` at `:10239`), add:

  ```js
      // ONE read for the whole run. Every client resolves its own pin against
      // this same list, which is what lets a single generate bill the same
      // person at two rates for two companies without two lookups disagreeing.
      const billRateVersions = await this.listBillRateVersions()
  ```

  and change `draftFor` (`db/store.js:10239-10257`) so the `buildInvoiceDraft({ … })` call gains, after `defaultHourlyRate: Number(target.hourlyRate) || 0,`:

  ```js
            billRateVersions,
            // THIS company's pin, resolved for THIS month. A sub on a master's
            // consolidated invoice is priced here, at its own pin, before the
            // merge — which is the same way the merge already refuses to blend
            // rates.
            ratePeriod: ratePeriodAsOf(target, period),
  ```

  **(c) `src/lib/utils.ts:1649-1682` — `getInvoice`.** Change the signature to add a ninth parameter and resolve the pin:

  ```ts
  export function getInvoice(
    client: Client,
    entries: TimeEntry[],
    plans: SubscriptionPlan[],
    billingPeriod: string,
    reimbursements: Reimbursement[] = [],
    recurringReimbursements: RecurringReimbursement[] = [],
    employees: Employee[] = [],
    defaultHourlyRate = 0,
    billRateVersions: BillRateVersion[] = [],
  ): Invoice {
    // Thin wrapper. The lines themselves are built by the SHARED builder in
    // `lib/invoice-lines.js`, which the server-side draft generator and Client
    // Recap also call — so what the UI shows, what gets invoiced, and what the
    // profit figure is measured against can no longer drift apart.
    //
    // The PIN is resolved here rather than passed in, so every caller of this
    // function gets the client's own rate month without having to know the rule.
    // Staff sessions receive no versions (they are owner-only), so the fallback
    // chain lands them exactly where it always has.
    const built = buildInvoiceLines({
      client,
      entries,
      plans,
      billingPeriod,
      reimbursements,
      recurringReimbursements,
      employees,
      defaultHourlyRate,
      billRateVersions,
      ratePeriod: ratePeriodAsOf(client, billingPeriod),
    })
  ```

  Add the import near the existing `lib/invoice-lines.js` import in `src/lib/utils.ts` (`:576`):

  ```ts
  import { ratePeriodAsOf, type BillRateVersion } from '../../lib/rate-history.js'
  ```

  and re-export the type so pages can use it:

  ```ts
  export type { BillRateVersion, CostRateVersion } from '../../lib/rate-history.js'
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run db/store-staleness.test.mjs lib/invoice-draft.test.mjs src/__tests__/get-invoice.test.ts
  npx tsc -b
  npx eslint db/store.js lib/invoice-draft.js src/lib/utils.ts
  ```

  Expected: all green; the new `its own pin` test passes; `tsc -b` reports no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/invoice-draft.js lib/invoice-draft.d.ts db/store.js db/store-staleness.test.mjs src/lib/utils.ts
  git commit -m "$(cat <<'EOF'
Generate every draft at the client's own pinned rates

buildInvoiceDraft passes billRateVersions and ratePeriod through to the line
builder, the month run loads the version list once and resolves each target's
own pin with ratePeriodAsOf, and getInvoice resolves the pin itself so no UI
caller has to know the rule. A sub on a master's consolidated invoice is priced
at its own pin before the merge, the same way the merge already refuses to blend
rates.

Proven on the file backend: one generate, two hourly clients on different pins,
the same person's hour billed at 40 on one and 55 on the other.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---
### Task 9: Client Recap revenue and firm analytics revenue

**Files:**
- Modify: `lib/client-recap.js` (`:458-462` opts, `:769-792` revenue, `:865-869` `billRateOf`, `:1054-1063` projection)
- Modify: `lib/firm-analytics.js` (`:55-60`, `:81`)
- Test: `lib/rate-history-recap.test.mjs` (create)

**Interfaces:**
- Consumes: `billRateFor`, `ratePeriodAsOf` from `lib/rate-history.js`
- Produces:
  - `buildClientRecap(data, { …, billRateVersions = [], costRateVersions = [] })` — `costRates` is REMOVED
  - `clientProfitability(data, { month, billRateVersions = [], costRateVersions = [], lowRealizationThreshold })` — `costRates` is REMOVED

  Cost is Task 11; this task changes only the REVENUE side and threads the new opts in.

- [ ] **Step 1: Write the failing test**

  Create `lib/rate-history-recap.test.mjs`:

  ```js
  import { describe, expect, it } from 'vitest'
  import { buildClientRecap } from './client-recap.js'
  import { clientProfitability } from './firm-analytics.js'

  const billRateVersions = [
    { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
    { userId: 'emp-lisa', effectivePeriod: '2026-09', rate: 55 },
  ]

  const data = {
    clients: [
      {
        id: 'c1',
        name: 'Acme',
        billingMode: 'hourly',
        hourlyRate: 100,
        // Moved to September's rates in August, so July still bills at June's.
        hourlyRatePeriod: '2026-09',
        hourlyRateHistory: [
          { from: null, to: '2026-06', changedAt: '2026-06-01T00:00:00.000Z', changedBy: 'u' },
          { from: '2026-06', to: '2026-09', changedAt: '2026-08-20T00:00:00.000Z', changedBy: 'u' },
        ],
      },
    ],
    employees: [{ id: 'emp-lisa', name: 'Lisa', role: 'Bookkeeper' }],
    plans: [],
    reimbursements: [],
    recurringReimbursements: [],
    timeEntries: [
      { id: 't-jul', clientId: 'c1', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-07-10' },
      { id: 't-sep', clientId: 'c1', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-10' },
    ],
    checklists: [],
  }

  describe('a quarterly recap prices each month at the pin that applied THEN', () => {
    it('bills July at the old pin and September at the new one', () => {
      const recap = buildClientRecap(data, {
        clientId: 'c1',
        periodType: 'quarter',
        period: '2026-Q3',
        today: '2026-10-01',
        includeFinancials: true,
        billRateVersions,
      })
      // July 40 + August 0 + September 55.
      expect(recap.billing.revenue).toBe(95)
    })

    it('a monthly recap of July still reads 40, not today’s 55', () => {
      const recap = buildClientRecap(data, {
        clientId: 'c1',
        periodType: 'month',
        period: '2026-07',
        today: '2026-10-01',
        includeFinancials: true,
        billRateVersions,
      })
      expect(recap.billing.revenue).toBe(40)
    })
  })

  describe('clientProfitability prices hourly revenue through the resolver', () => {
    it('uses the pin that applied in the month asked about', () => {
      const july = clientProfitability(data, { month: '2026-07', billRateVersions })
      expect(july.clients.find((row) => row.client === 'Acme').revenue).toBe(40)
      const september = clientProfitability(data, { month: '2026-09', billRateVersions })
      expect(september.clients.find((row) => row.client === 'Acme').revenue).toBe(55)
    })

    it('still falls back to the client’s own rate when there is no history', () => {
      const plain = clientProfitability(data, { month: '2026-09' })
      expect(plain.clients.find((row) => row.client === 'Acme').revenue).toBe(100)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run lib/rate-history-recap.test.mjs
  ```

  Expected: `expected 200 to be 95` on the quarterly test (both months priced at the client's $100 fallback) and similar on the others.

- [ ] **Step 3: Write minimal implementation**

  **(a) `lib/client-recap.js`.** Add the import beside the `invoice-lines.js` one:

  ```js
  // THE rate resolver — the pin that applied in a given month, and the rate that
  // applied under it. A multi-month recap is the surface this exists for.
  import { billRateFor, costRateFor, latestCostRate, ratePeriodAsOf } from './rate-history.js'
  ```

  (`costRateFor` and `latestCostRate` are used in Task 11; import them now so that task touches one file less.)

  Replace the JSDoc line `@param {Record<string, number|null>} [opts.costRates]` (`:458`) with:

  ```
   * @param {Array} [opts.billRateVersions]  dated bill rates (lib/rate-history.js)
   * @param {Array} [opts.costRateVersions]  dated cost rates
  ```

  Replace the destructure (`:462`) with:

  ```js
    const {
      clientId,
      periodType,
      period,
      today,
      includeFinancials,
      billRateVersions = [],
      costRateVersions = [],
      salesTaxRecord = null,
    } = opts
  ```

  Replace the revenue reducer (`:769-792`). Keep the whole existing comment block above it and replace only its last two paragraphs — the ones beginning "OVER A QUARTER OR A YEAR IT IS A RESTATEMENT" — with:

  ```
     * OVER A QUARTER OR A YEAR EACH MONTH IS PRICED AT THE PIN THAT APPLIED IN
     * IT. `hourly_rate_history` records every time the owner moved this client
     * to current rates, so a client moved in March has January and February
     * priced at the old rates and this figure reconciles against the invoices
     * actually issued. That is the guarantee the rate history exists for; the
     * "today's rates" caption it replaces is gone from the page for hourly
     * clients. A MONTHLY recap is, as before, the invoice's number.
  ```

  and change the body to:

  ```js
    const revenue = round2(
      monthsInRange(start, end).reduce((sum, month) => {
        const built = buildInvoiceLines({
          client,
          entries: data.timeEntries ?? [],
          plans: data.plans ?? [],
          billingPeriod: month,
          employees: data.employees ?? [],
          defaultHourlyRate: Number(client.hourlyRate) || 0,
          billRateVersions,
          // THE PIN AS IT STOOD IN THAT MONTH, not today's. This one argument is
          // what turns a restatement into a reconciliation.
          ratePeriod: ratePeriodAsOf(client, month),
        })
  ```

  (the `.filter(...).reduce(...)` tail is unchanged).

  Replace `billRateOf` (`:866-869`) with:

  ```js
    // The rate an ESTIMATE is priced at — this client's pin as it stands for the
    // period being looked at, falling back to the person's live mirror. An
    // estimate is a forecast of work not yet done, so the pin is the defensible
    // price of the plan.
    const estimateRatePeriod = ratePeriodAsOf(client, String(start).slice(0, 7))
    const billRateOf = (employeeId) => {
      const versioned = billRateFor(billRateVersions, employeeId, estimateRatePeriod)
      if (versioned !== null) return versioned
      const employee = employeeById.get(employeeId)
      return isNumber(employee?.billRate) ? employee.billRate : null
    }
  ```

  Add to the projection's `buildInvoiceLines({ … })` call (`:1054-1063`), after `defaultHourlyRate: Number(client.hourlyRate) || 0,`:

  ```js
        billRateVersions,
        ratePeriod: ratePeriodAsOf(client, period),
  ```

  **(b) `lib/firm-analytics.js`.** Add the import beside the `payroll-cost.js` one:

  ```js
  import { billRateFor, costRateFor, ratePeriodAsOf } from './rate-history.js'
  ```

  Change the signature (`:55`) to:

  ```js
  export function clientProfitability(
    data,
    { month, billRateVersions = [], costRateVersions = [], lowRealizationThreshold = 50 },
  ) {
  ```

  Delete the `costRateOf` line at `:59` (Task 11 replaces it) and change the revenue line (`:81`) from

  ```js
      const revenue = isHourly ? round2(billableHours * (Number(client.hourlyRate) || 0)) : fee
  ```

  to

  ```js
      /**
       * Hourly revenue, at last, through the SAME rule the invoice bills by.
       *
       * This used to be `billableHours × client.hourlyRate` — the retired
       * per-client rate, which invoices stopped using at the June 2026 cutover.
       * It is the known inconsistency the rate-history build closes (spec §3):
       * one rate per client, applied to everybody's hours, could disagree with
       * the invoice in both directions and did on 16 of 19 hourly clients in
       * July 2026.
       *
       * The fallback chain is `buildInvoiceLines`'s, in the same order, so a
       * client with no versions and people with no bill rates still reads
       * exactly what it read before.
       */
      const ratePeriod = ratePeriodAsOf(client, month)
      const billRateOf = (employeeId) => {
        const versioned = billRateFor(billRateVersions, employeeId, ratePeriod ?? month)
        if (versioned !== null) return versioned
        const employee = (data.employees ?? []).find((entry) => entry.id === employeeId)
        return isNumber(employee?.billRate) ? employee.billRate : Number(client.hourlyRate) || 0
      }
      const hourlyRevenue = () => {
        const rowsByEmployee = new Map()
        for (const entry of mine) {
          if (!entry.billable) continue
          const rows = rowsByEmployee.get(entry.employeeId)
          if (rows) rows.push(entry.minutes)
          else rowsByEmployee.set(entry.employeeId, [entry.minutes])
        }
        return sumPersonCosts(
          [...rowsByEmployee].map(([employeeId, minutesPerRow]) =>
            periodMoney(minutesPerRow, billRateOf(employeeId)),
          ),
        )
      }
      const revenue = isHourly ? round2(hourlyRevenue()) : fee
  ```

  Extend the `payroll-cost.js` import at `lib/firm-analytics.js:25` to:

  ```js
  import {
    displayHours,
    laborCost,
    periodMoney,
    sumDisplayHours,
    sumPersonCosts,
  } from './payroll-cost.js'
  ```

  **(c)** `lib/firm-analytics.js` still computes `anyCostRates` from `costRates` (near the end of `clientProfitability`). Change it to:

  ```js
    const anyCostRates = (costRateVersions ?? []).length > 0
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run lib/rate-history-recap.test.mjs lib/client-recap.test.mjs lib/client-recap-estimates.test.mjs lib/firm-analytics.test.mjs
  npx eslint lib/client-recap.js lib/firm-analytics.js lib/rate-history-recap.test.mjs
  ```

  Expected: the 4 new tests pass. `lib/firm-analytics.test.mjs` will FAIL on its `costRates: { e1: 30, e2: 50 }` calls — that is Task 11's work; leave those failures and say so in the commit body, OR (preferred) run only the four new tests here and let Task 11 green the file. Do NOT weaken an existing assertion to make it pass.

  If `lib/client-recap.test.mjs` fails because it passes `costRates`, the same applies: Task 11 converts it.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/client-recap.js lib/firm-analytics.js lib/rate-history-recap.test.mjs
  git commit -m "$(cat <<'EOF'
Price every month of a recap at the pin that applied in that month

buildClientRecap and clientProfitability take billRateVersions / costRateVersions
instead of a live cost-rate map. The recap's revenue loop asks ratePeriodAsOf for
the client's pin as it stood in each month it prices, so a client moved in March
has January and February at the old rates and a quarterly figure reconciles
against the invoices actually issued.

clientProfitability's hourly revenue stops using the retired per-client
hourlyRate and goes through the same per-person rule the invoice bills by — the
known inconsistency spec section 3 closes.

The cost side is still a one-rate-per-person map; the next commit moves it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 10: The AI hours summary

**Files:**
- Modify: `server.js` (`:1496-1555` `buildInvoiceHoursSummary`, and its call site `:1670`)
- Test: `lib/rate-history-server.test.mjs` (append)

**Interfaces:**
- Consumes: `billRateFor`, `ratePeriodAsOf`
- Produces: `buildInvoiceHoursSummary(data, client, period, billRateVersions = [])` — its `rateFor` mirrors `buildInvoiceLines`'s three-step chain exactly, resolved at the client's own pin. `buildMasterInvoiceHoursSummary` threads the list through to each sub.

- [ ] **Step 1: Write the failing test**

  Append to `lib/rate-history-server.test.mjs`:

  ```js
  describe('the AI hours summary mirrors the invoice’s rate rule', () => {
    it('takes the version list and resolves the client’s own pin', () => {
      const start = source.indexOf('function buildInvoiceHoursSummary(data, client, period')
      expect(start, 'buildInvoiceHoursSummary is gone').toBeGreaterThan(-1)
      const body = source.slice(start, start + 2400)
      expect(body).toContain('billRateVersions = []')
      expect(body).toContain('ratePeriodAsOf(client, period)')
      expect(body).toContain('billRateFor(billRateVersions, employeeId')
    })

    it('threads the same list into the master variant’s per-sub calls', () => {
      const start = source.indexOf('function buildMasterInvoiceHoursSummary(')
      const body = source.slice(start, start + 1400)
      expect(body).toContain('buildInvoiceHoursSummary(data, sub, period, billRateVersions)')
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run lib/rate-history-server.test.mjs -t "AI hours summary"
  ```

  Expected: both fail — the helper takes three parameters and reads `employee.billRate` directly.

- [ ] **Step 3: Write minimal implementation**

  Add `billRateFor` and `ratePeriodAsOf` to the `lib/rate-history.js` import in `server.js` (create the import beside the `lib/invoice-lines.js` one if there is none yet):

  ```js
  import { billRateFor, ratePeriodAsOf } from './lib/rate-history.js'
  ```

  Change `buildInvoiceHoursSummary` (`server.js:1507-1525`). Replace its signature and `rateFor`:

  ```js
  function buildInvoiceHoursSummary(data, client, period, billRateVersions = []) {
    if (!client) return null
    if (client.isBillingMaster === true) {
      return buildMasterInvoiceHoursSummary(data, client, period, billRateVersions)
    }
    const employees = data.employees ?? []
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
    const defaultHourlyRate = Number(client.hourlyRate) || 0
    // The SAME three-step chain `buildInvoiceLines.rateFor` uses, in the same
    // order, resolved at THIS client's own pin. A summary that resolved rates
    // differently from the lines would have the model reporting real lines as
    // arithmetic errors — which is the one thing this function exists not to do.
    const ratePeriod = ratePeriodAsOf(client, period)
    const rateFor = (employeeId) => {
      const versioned = billRateFor(billRateVersions, employeeId, ratePeriod ?? period)
      if (versioned !== null) return versioned
      const employee = employeeById.get(employeeId)
      return employee && typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
        ? employee.billRate
        : defaultHourlyRate
    }
  ```

  Update the doc comment's last sentence from "the employee's own `billRate` or the client's hourly rate" to:

  ```
   * fallback are mirrored exactly (billable, in-period, this client; the rate
   * the RESOLVER gives for this client's pin, then the employee's own
   * `billRate`, then the client's hourly rate) so a mismatch the model reports
   * is a real one rather than two different definitions of "hours".
  ```

  Change `buildMasterInvoiceHoursSummary`'s signature to `(data, master, period, billRateVersions = [])` and its inner call (`server.js:1585`) to:

  ```js
      for (const row of buildInvoiceHoursSummary(data, sub, period, billRateVersions)?.employees ?? []) {
  ```

  At the call site (`server.js:1670`), the enclosing function is already async and has a session in scope; change:

  ```js
      hoursSummary: buildInvoiceHoursSummary(data, client, invoice.period),
  ```

  to load the list first. Immediately before the object literal that contains that line, add:

  ```js
    // Owner-only by construction — the AI review route is owner-gated, and
    // `loadRateVersions` hands anyone else two empty lists anyway, in which case
    // the summary falls back exactly as it did before rate history existed.
    const { billRateVersions } = await loadRateVersions(session)
  ```

  and change the line to:

  ```js
      hoursSummary: buildInvoiceHoursSummary(data, client, invoice.period, billRateVersions),
  ```

  If `session` is not in scope at that point, read upward to the enclosing route handler and thread it in as a parameter — do not synthesize an owner session here.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run lib/rate-history-server.test.mjs
  npx eslint server.js
  node --check server.js
  ```

  Expected: 12 passing tests, eslint silent.

- [ ] **Step 5: Commit**

  ```bash
  git add server.js lib/rate-history-server.test.mjs
  git commit -m "$(cat <<'EOF'
Check an invoice's arithmetic against the rates it was actually billed at

buildInvoiceHoursSummary takes the bill-rate version list and resolves the
client's own pin, mirroring buildInvoiceLines' fallback chain step for step. The
master variant threads the same list into each sub's summary, so a person
billing two companies at two pins stays two rows with two rates rather than a
blended one. Without this the model would have read every pinned client's lines
as an arithmetic error and "corrected" a line that was right.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 11: Cost by the day the work was done

**Files:**
- Modify: `lib/payroll-cost.js` (`:239-314` `laborCost`), `lib/payroll-cost.d.ts` (`:10-17` `PayrollSlice`, `:58-62` `laborCost`)
- Modify: `lib/client-recap.js` (`:826`, `:926`, `:942`), `lib/firm-analytics.js` (the deleted `costRateOf`, `:91`)
- Test: `lib/rate-history-cost.test.mjs` (create); convert `lib/firm-analytics.test.mjs` and any `costRates` caller in `lib/client-recap.test.mjs` / `lib/client-recap-estimates.test.mjs`

**Interfaces:**
- Consumes: `costRateFor`, `latestCostRate`
- Produces: `laborCost(entries, costRateOf, duplicates?)` where `costRateOf` is `(employeeId: string, entryDate?: string) => number | null | undefined`. Rows are grouped by employee AND resolved rate, so a mid-period raise produces two correctly-rounded groups; with one rate per person the answer is bit-for-bit what it was.

- [ ] **Step 1: Write the failing test**

  Create `lib/rate-history-cost.test.mjs`:

  ```js
  import { describe, expect, it } from 'vitest'
  import { laborCost } from './payroll-cost.js'
  import { costRateFor } from './rate-history.js'

  const versions = [
    { userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 },
    { userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 },
  ]
  const resolver = (employeeId, entryDate) => costRateFor(versions, employeeId, entryDate)

  describe('laborCost by the day the work was done', () => {
    it('costs the day before a raise at the old rate and the day of it at the new', () => {
      const before = laborCost(
        [{ id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-14' }],
        resolver,
      )
      const after = laborCost(
        [{ id: 'b', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-15' }],
        resolver,
      )
      expect(before).toBe(20)
      expect(after).toBe(24)
    })

    it('splits ONE person’s period across the raise instead of picking a side', () => {
      const total = laborCost(
        [
          { id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-14' },
          { id: 'b', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-16' },
        ],
        resolver,
      )
      expect(total).toBe(44)
    })

    it('is unchanged for a resolver that ignores the date — every existing caller', () => {
      const flat = laborCost(
        [
          { id: 'a', employeeId: 'emp-lisa', minutes: 10, billable: true, date: '2026-09-01' },
          { id: 'b', employeeId: 'emp-lisa', minutes: 10, billable: true, date: '2026-09-02' },
          { id: 'c', employeeId: 'emp-lisa', minutes: 45, billable: true, date: '2026-09-03' },
        ],
        () => 30,
      )
      // 0.17 + 0.17 + 0.75 = 1.09h × 30 — the summed-rows rule, unchanged.
      expect(flat).toBe(32.7)
    })

    it('still counts a full-mode group once', () => {
      const total = laborCost(
        [
          { id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-16', groupId: 'g1', groupAllocation: 'full' },
          { id: 'b', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-16', groupId: 'g1', groupAllocation: 'full' },
        ],
        resolver,
      )
      expect(total).toBe(24)
    })

    it('a person with no rate on that day costs nothing, never $0.00 by accident', () => {
      expect(
        laborCost(
          [{ id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '1969-12-31' }],
          resolver,
        ),
      ).toBe(0)
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run lib/rate-history-cost.test.mjs
  ```

  Expected: the first four fail — `laborCost` calls `costRateOf(employeeId)` with one argument, so every resolver answers `null` and every total is 0.

- [ ] **Step 3: Write minimal implementation**

  Replace `laborCost` (`lib/payroll-cost.js:298-314`) and its doc comment (`:239-244`) with:

  ```js
  /**
   * Labor cost for a set of slices: hours actually worked × the person's cost
   * rate ON THE DAY THEY WORKED THEM, deduped the same way tracked time is, and
   * — because it is a total — assembled under {@link periodMoney}.
   *
   * `costRateOf` is `(employeeId, entryDate) => number | null`. The date is what
   * makes a raise land on a payday instead of rewriting history: a September
   * recap costs September's entries at the rate in force on each entry's own
   * day, so a raise never changes what a past recap says the work cost.
   *
   * SLICES ARE GROUPED BY PERSON **AND RESOLVED RATE**, not by person alone.
   * That is the whole change: the costing hours are the sum of a set of rows'
   * two-decimal hours, and rows at two different rates are two different sums.
   * Grouping by person and picking one rate would price half the month wrong;
   * grouping per ROW would round every row separately and stop the column adding
   * up (see {@link periodDisplayHours}).
   *
   * For a resolver that ignores the date — every caller before rate history, and
   * any test passing `() => 30` — there is exactly one group per person and the
   * answer is what it has always been, to the cent.
   */
  export function laborCost(entries, costRateOf, duplicates = duplicateFullSliceIds(entries)) {
    // Each (person, rate) pair's ROW MINUTES, not a running total: the costing
    // hours are the sum of the rows' two-decimal hours, so collapsing them here
    // would throw away the very thing being summed.
    const groups = new Map()
    for (const entry of entries) {
      if (duplicates.has(entry.id)) continue
      const rate = costRateOf(entry.employeeId, entry.date)
      const key = `${entry.employeeId} ${rate === null || rate === undefined ? '' : rate}`
      const found = groups.get(key)
      if (found) found.minutes.push(entry.minutes)
      else groups.set(key, { rate, minutes: [entry.minutes] })
    }
    return sumPersonCosts(
      [...groups.values()].map((group) => periodMoney(group.minutes, group.rate)),
    )
  }
  ```

  In `lib/payroll-cost.d.ts`, add `date?: string` to `PayrollSlice` and change the `laborCost` declaration to:

  ```ts
  export declare function laborCost(
    entries: readonly PayrollSlice[],
    costRateOf: (employeeId: string, entryDate?: string) => number | null | undefined,
    duplicates?: ReadonlySet<string>,
  ): number
  ```

  **`lib/client-recap.js`.** Replace `costRateOf` (`:826`) with:

  ```js
    // The rate this person was PAID ON THE DAY they worked each entry. Keyed by
    // date rather than by period because a raise lands on a payday — and because
    // a recap that changed when somebody got a raise is exactly what this
    // feature was built to stop.
    const costRateOf = (employeeId, entryDate) =>
      costRateFor(costRateVersions, employeeId, entryDate)
    // An ESTIMATE has no entries and therefore no dates, so a tier's estimated
    // cost is priced at each person's CURRENT rate. Forecasting at a historical
    // rate would be forecasting the past.
    const latestCostRateOf = (employeeId) => latestCostRate(costRateVersions, employeeId)
  ```

  Change `resolveTierRate(row.tier, costRateOf)` (`:926`) to `resolveTierRate(row.tier, latestCostRateOf)`, and likewise any other `resolveTierRate(…, costRateOf)` call in the file (search for `resolveTierRate(`). `laborCost(entries, costRateOf)` (`:848`) and `laborCost(tierEntries, costRateOf)` (`:942`) are unchanged — they now get the date automatically.

  **`lib/firm-analytics.js`.** Where `costRateOf` was deleted in Task 9, add back:

  ```js
    const costRateOf = (employeeId, entryDate) =>
      costRateFor(costRateVersions, employeeId, entryDate)
  ```

  `laborCost(mine, costRateOf)` at `:91` is unchanged.

  **Existing tests.** Convert every `costRates: { … }` call site in `lib/firm-analytics.test.mjs`, `lib/client-recap.test.mjs` and `lib/client-recap-estimates.test.mjs` to the new opt, preserving the asserted numbers exactly. For example, `{ month: '2026-06', costRates: { e1: 30, e2: 50 }, lowRealizationThreshold: 50 }` becomes:

  ```js
  {
    month: '2026-06',
    costRateVersions: [
      { userId: 'e1', effectiveDate: '1970-01-01', rate: 30 },
      { userId: 'e2', effectiveDate: '1970-01-01', rate: 50 },
    ],
    lowRealizationThreshold: 50,
  }
  ```

  A 1970 floor is what the migration writes, so this is the same data shape production has. Do NOT change any expected value; if one moves, the implementation is wrong. One expectation WILL legitimately move: `firm-analytics.test.mjs`'s `expect(c2.revenue).toBe(400)` stays 400 (no bill-rate versions, no `billRate` on e1, so it falls through to `client.hourlyRate` of 100 × 4h) — verify rather than assume.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run lib/rate-history-cost.test.mjs lib/firm-analytics.test.mjs lib/client-recap.test.mjs lib/client-recap-estimates.test.mjs lib/rate-history-recap.test.mjs src/__tests__/payroll-aggregation.test.ts src/__tests__/payroll-round-four.test.ts src/__tests__/payroll-cost-reconciliation.test.tsx
  npx eslint lib/payroll-cost.js lib/client-recap.js lib/firm-analytics.js lib/rate-history-cost.test.mjs
  ```

  Expected: everything green, including Task 9's four tests which now have a working cost side.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/payroll-cost.js lib/payroll-cost.d.ts lib/client-recap.js lib/firm-analytics.js lib/rate-history-cost.test.mjs lib/firm-analytics.test.mjs lib/client-recap.test.mjs lib/client-recap-estimates.test.mjs
  git commit -m "$(cat <<'EOF'
Cost every hour at the rate the person was paid on the day they worked it

laborCost's resolver contract becomes (employeeId, entryDate), and slices are
grouped by person AND resolved rate rather than by person alone — a mid-period
raise is two correctly-rounded sums, not one sum at a guessed rate. A resolver
that ignores the date produces exactly one group per person, so every caller
from before this change lands on the same cent.

The Client Recap and the assistant's margin analytics resolve by entry date. A
tier ESTIMATE has no entries and therefore no dates, so it prices at each
person's current rate — forecasting at a historical rate would be forecasting
the past.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 12: The Client Recap's two captions

**Files:**
- Modify: `src/pages/ClientRecapPage.tsx` (`:53-55` `LABOR_COST_BASIS_NOTE`, `:400-413` the multi-month caption)
- Modify: `src/lib/api.ts` (`:2853-2861` the `laborCost` doc comment)
- Test: `src/__tests__/recap-page-sections.test.tsx` (append)

**Interfaces:**
- Consumes: `recap.billing.billingMode`, `recap.monthsInPeriod`, `recap.periodType`
- Produces: no new exports — copy only

- [ ] **Step 1: Write the failing test**

  Append to `src/__tests__/recap-page-sections.test.tsx` (reuse that file's existing render helper — read the top of the file and follow it exactly):

  ```tsx
  describe('the multi-month caption after rate history', () => {
    it('tells an HOURLY client the months were priced at the rates in force each month', () => {
      renderRecap({ billingMode: 'hourly', monthsInPeriod: 3, periodType: 'quarter' })
      expect(screen.getByText(/the rates in force each month/i)).toBeInTheDocument()
      expect(screen.queryByText(/current rates and plans/i)).not.toBeInTheDocument()
    })

    it('still warns a MONTHLY client that plans are restated at today’s', () => {
      renderRecap({ billingMode: 'subscription', monthsInPeriod: 3, periodType: 'quarter' })
      expect(screen.getByText(/current rates and plans/i)).toBeInTheDocument()
    })

    it('says cost uses the rate on the day worked', () => {
      renderRecap({ billingMode: 'hourly', monthsInPeriod: 1, periodType: 'month' })
      expect(screen.getByText(/the rate they were paid on the day they worked it/i)).toBeInTheDocument()
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run src/__tests__/recap-page-sections.test.tsx -t "after rate history"
  ```

  Expected: `Unable to find an element with the text: /the rates in force each month/i`.

- [ ] **Step 3: Write minimal implementation**

  Replace `LABOR_COST_BASIS_NOTE` (`src/pages/ClientRecapPage.tsx:53-55`) with:

  ```tsx
  const LABOR_COST_BASIS_NOTE =
    'Labor cost counts team members who have a pay rate on file, owners included; time from ' +
    'anyone without a rate carries no hourly cost. Each hour is costed at the rate they were ' +
    'paid on the day they worked it, so a raise never changes a past recap.'
  ```

  Replace the multi-month caption block (`src/pages/ClientRecapPage.tsx:400-413`) with:

  ```tsx
              {/* A multi-month period used to reprice every month at the
                  client's CURRENT rates, because no rate history was kept.
                  For an HOURLY client that is no longer true: each month is
                  priced at the pin that applied in it (hourly_rate_history),
                  so the figure reconciles against the invoices actually
                  issued. A MONTHLY or ANNUAL client still has no history —
                  its fee and its plans are single live values — so the old
                  warning stands for them, unchanged. */}
              {recap.monthsInPeriod > 1 ? (
                recap.billing.billingMode === 'hourly' ? (
                  <p className="recap-estimate-caption">
                    Priced at the rates in force each month — the rate month this client was on
                    at the time, not today's. A rate change part-way through the{' '}
                    {recap.periodType === 'year' ? 'year' : 'quarter'} shows up where it
                    happened, so this reconciles against the invoices actually issued.
                  </p>
                ) : (
                  <p className="recap-estimate-caption">
                    Priced at the client's current rates and plans, not the rates in force each
                    month. A rate or plan change part-way through the{' '}
                    {recap.periodType === 'year' ? 'year' : 'quarter'} is applied to all{' '}
                    {recap.monthsInPeriod} months, so this can differ from the invoices actually
                    issued.
                  </p>
                )
              ) : null}
  ```

  Update the `laborCost` doc comment in `src/lib/api.ts` (`:2853-2861`) — replace the sentence beginning "`laborCost` counts only team members who have a cost rate on file" with:

  ```ts
     * `laborCost` counts only team members who have a cost rate on file for the
     * day each entry was worked — someone
  ```

  (keep the rest of the existing sentence intact).

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run src/__tests__/recap-page-sections.test.tsx src/__tests__/recap-estimate-vs-actual.test.tsx src/__tests__/client-recap-master.test.tsx
  npx tsc -b
  npx eslint src/pages/ClientRecapPage.tsx src/lib/api.ts
  ```

  Expected: green.

- [ ] **Step 5: Commit**

  ```bash
  git add src/pages/ClientRecapPage.tsx src/lib/api.ts src/__tests__/recap-page-sections.test.tsx
  git commit -m "$(cat <<'EOF'
Stop telling an hourly client's recap it was repriced at today's rates

A multi-month recap of an hourly client now says it was priced at the rates in
force each month, because it was — the caption was true only while no rate
history existed. A monthly or annual client still has a single live fee and a
single plan list, so the old warning stands for them unchanged.

The labor-cost note now says cost uses each person's rate on the day worked.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---
### Task 13: The browser's door onto rate history

**Files:**
- Modify: `src/lib/types.ts` (the `Client` type, `:68+`)
- Modify: `src/lib/api.ts` (new calls beside `setTeamMemberBillRate`, `:1193-1223`)
- Test: `src/__tests__/rate-version-routes.test.ts` (create)

**Interfaces:**
- Consumes: the Task 6 endpoints
- Produces:
  - `Client.hourlyRatePeriod?: string | null`, `Client.hourlyRateHistory?: RateHistoryEntry[]`
  - `type BillRateVersion`, `type CostRateVersion`, `type RateHistoryEntry` re-exported from `src/lib/types.ts`
  - `fetchRateVersions(signal?): Promise<{ billRateVersions: BillRateVersion[]; costRateVersions: CostRateVersion[] }>`
  - `upsertBillRateVersion(userId, effectivePeriod, rate): Promise<{ ok: boolean; userId: string; versions: BillRateVersion[] }>`
  - `deleteBillRateVersion(userId, effectivePeriod): Promise<{ ok: boolean; userId: string; versions: BillRateVersion[] }>`
  - `upsertCostRateVersion(userId, effectiveDate, rate): Promise<{ ok: boolean; userId: string; versions: CostRateVersion[] }>`
  - `deleteCostRateVersion(userId, effectiveDate): Promise<{ ok: boolean; userId: string; versions: CostRateVersion[] }>`
  - `setClientHourlyRatePeriod(clientId, period): Promise<Client>`

- [ ] **Step 1: Write the failing test**

  Create `src/__tests__/rate-version-routes.test.ts`, modeled on `src/__tests__/package-routes.test.ts` (read it first and copy its `fetchMock` scaffolding verbatim):

  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
  import {
    deleteBillRateVersion,
    deleteCostRateVersion,
    fetchRateVersions,
    setClientHourlyRatePeriod,
    upsertBillRateVersion,
    upsertCostRateVersion,
  } from '../lib/api'
  import { ApiError } from '../lib/types'

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  let fetchMock: ReturnType<typeof vi.fn>

  const requestedUrl = (call = 0) => {
    const input = fetchMock.mock.calls[call][0] as RequestInfo | URL
    return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  }
  const requestInit = (call = 0) => fetchMock.mock.calls[call][1] as RequestInit
  const sentBody = (call = 0) => JSON.parse(String(requestInit(call).body))

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('fetchRateVersions', () => {
    it('unwraps both lists', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          billRateVersions: [{ userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 }],
          costRateVersions: [{ userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 }],
        }),
      )
      const result = await fetchRateVersions()
      expect(requestedUrl()).toContain('/api/rate-versions')
      expect(result.billRateVersions).toHaveLength(1)
      expect(result.costRateVersions).toHaveLength(1)
    })

    it('answers two empty lists rather than throwing when a staff session is refused', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'Only owners can see rate history' }, 403))
      await expect(fetchRateVersions()).resolves.toEqual({
        billRateVersions: [],
        costRateVersions: [],
      })
    })
  })

  describe('the four version writes', () => {
    it('PUTs a bill-rate version', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'emp-lisa', versions: [] }))
      await upsertBillRateVersion('emp-lisa', '2026-10', 60)
      expect(requestedUrl()).toContain('/api/team/bill-rate-version')
      expect(requestInit().method).toBe('PUT')
      expect(sentBody()).toEqual({ userId: 'emp-lisa', effectivePeriod: '2026-10', rate: 60 })
    })

    it('DELETEs a bill-rate version and surfaces the 409 sentence', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: 'rate_version_locked', message: 'A client is pinned at or after this month, so it is still billing at this rate. Move that client first.' }, 409),
      )
      await expect(deleteBillRateVersion('emp-lisa', '2026-10')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('Move that client first'),
      })
      expect(requestInit().method).toBe('DELETE')
    })

    it('PUTs a cost-rate version keyed by date', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'emp-lisa', versions: [] }))
      await upsertCostRateVersion('emp-lisa', '2026-10-01', 26)
      expect(requestedUrl()).toContain('/api/team/cost-rate-version')
      expect(sentBody()).toEqual({ userId: 'emp-lisa', effectiveDate: '2026-10-01', rate: 26 })
    })

    it('DELETEs a cost-rate version', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'emp-lisa', versions: [] }))
      await deleteCostRateVersion('emp-lisa', '2026-10-01')
      expect(requestInit().method).toBe('DELETE')
      expect(sentBody()).toEqual({ userId: 'emp-lisa', effectiveDate: '2026-10-01' })
    })
  })

  describe('setClientHourlyRatePeriod', () => {
    it('PUTs to the targeted route with the id encoded', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'client a', hourlyRatePeriod: '2026-10' }))
      const updated = await setClientHourlyRatePeriod('client a', '2026-10')
      expect(requestedUrl()).toContain('/api/clients/client%20a/hourly-rate-period')
      expect(requestInit().method).toBe('PUT')
      expect(sentBody()).toEqual({ period: '2026-10' })
      expect(updated.hourlyRatePeriod).toBe('2026-10')
    })

    it('throws an ApiError carrying the server’s sentence', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: 'not_hourly', message: 'Only Hourly clients bill at a person’s rate, so only they have a rate month.' }, 400),
      )
      await expect(setClientHourlyRatePeriod('c1', '2026-10')).rejects.toBeInstanceOf(ApiError)
      await expect(setClientHourlyRatePeriod('c1', '2026-10')).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Only Hourly clients'),
      })
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run src/__tests__/rate-version-routes.test.ts
  ```

  Expected: collection fails — `"fetchRateVersions" is not exported by "src/lib/api.ts"`.

- [ ] **Step 3: Write minimal implementation**

  **(a) `src/lib/types.ts`.** Add near the top, beside the other shared type re-exports:

  ```ts
  export type {
    BillRateVersion,
    CostRateVersion,
    RateHistoryEntry,
  } from '../../lib/rate-history.js'
  ```

  Add to the `Client` type (after `hourlyRate: number`):

  ```ts
    /**
     * THE PIN: the month whose bill rates this client is charged at. Only
     * meaningful when `billingMode` is 'hourly'; null on every other client and
     * on every client a STAFF session receives (rates are owner-only, blanked in
     * `scopeAppDataForSession`).
     */
    hourlyRatePeriod?: string | null
    /**
     * Every time the owner moved this client to current rates. Append-only —
     * `ratePeriodAsOf` reads it to price a PAST month at the pin that applied
     * then. Blanked for staff alongside the pin.
     */
    hourlyRateHistory?: Array<{
      from: string | null
      to: string
      changedAt: string
      changedBy: string
    }>
  ```

  **(b) `src/lib/api.ts`.** Add after `setTeamMemberBillRate` (`:1223`):

  ```ts
  /**
   * Owner-only: the whole rate history, both sides.
   *
   * A 403 answers two EMPTY LISTS rather than throwing. Rates are owner-only and
   * every caller of this is an owner-gated surface, so a 403 here means a staff
   * session reached a page it should not have — and the resolver's answer for an
   * empty list is exactly the fallback that session already gets. A thrown error
   * would turn that into a broken page instead of a redacted one.
   */
  export async function fetchRateVersions(signal?: AbortSignal) {
    const response = await apiFetch('/api/rate-versions', { credentials: 'same-origin', signal })
    if (response.status === 403) return { billRateVersions: [], costRateVersions: [] }
    if (!response.ok) {
      const message = await safeErrorMessage(response)
      throw new ApiError(response.status, message || `Failed to load rate history (${response.status})`)
    }
    return (await response.json()) as {
      billRateVersions: BillRateVersion[]
      costRateVersions: CostRateVersion[]
    }
  }

  /** Owner-only: save one person's bill rate for one month ('YYYY-MM'). */
  export async function upsertBillRateVersion(
    userId: string,
    effectivePeriod: string,
    rate: number,
  ) {
    const response = await apiFetch('/api/team/bill-rate-version', {
      credentials: 'same-origin',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, effectivePeriod, rate }),
    })
    if (!response.ok) {
      const message = await safeErrorMessage(response)
      throw new ApiError(response.status, message || `Failed to save the rate (${response.status})`)
    }
    return (await response.json()) as { ok: boolean; userId: string; versions: BillRateVersion[] }
  }

  /**
   * Owner-only: remove one bill-rate version. 409 means the store refused —
   * either it is not the newest, or a client is still pinned at or after it. The
   * SENTENCE is what the page prints; `safeErrorMessage` already prefers
   * `message` over `error`.
   */
  export async function deleteBillRateVersion(userId: string, effectivePeriod: string) {
    const response = await apiFetch('/api/team/bill-rate-version', {
      credentials: 'same-origin',
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, effectivePeriod }),
    })
    if (!response.ok) {
      const message = await safeErrorMessage(response)
      throw new ApiError(response.status, message || `Failed to remove the rate (${response.status})`)
    }
    return (await response.json()) as { ok: boolean; userId: string; versions: BillRateVersion[] }
  }

  /** Owner-only: save one person's cost rate from one day on ('YYYY-MM-DD'). */
  export async function upsertCostRateVersion(
    userId: string,
    effectiveDate: string,
    rate: number,
  ) {
    const response = await apiFetch('/api/team/cost-rate-version', {
      credentials: 'same-origin',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, effectiveDate, rate }),
    })
    if (!response.ok) {
      const message = await safeErrorMessage(response)
      throw new ApiError(response.status, message || `Failed to save the rate (${response.status})`)
    }
    return (await response.json()) as { ok: boolean; userId: string; versions: CostRateVersion[] }
  }

  /** Owner-only: remove one cost-rate version — the newest only. */
  export async function deleteCostRateVersion(userId: string, effectiveDate: string) {
    const response = await apiFetch('/api/team/cost-rate-version', {
      credentials: 'same-origin',
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, effectiveDate }),
    })
    if (!response.ok) {
      const message = await safeErrorMessage(response)
      throw new ApiError(response.status, message || `Failed to remove the rate (${response.status})`)
    }
    return (await response.json()) as { ok: boolean; userId: string; versions: CostRateVersion[] }
  }

  /**
   * Owner-only: "Move to current rates from <month>".
   *
   * A TARGETED endpoint, not part of the bulk save — which is the point. The
   * owner tab autosaves the whole workspace; if the pin rode that payload, a tab
   * left open since yesterday would put a client back on the rates she moved it
   * off this morning.
   */
  export async function setClientHourlyRatePeriod(clientId: string, period: string) {
    const response = await apiFetch(
      `/api/clients/${encodeURIComponent(clientId)}/hourly-rate-period`,
      {
        credentials: 'same-origin',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period }),
      },
    )
    if (!response.ok) {
      const message = await safeErrorMessage(response)
      throw new ApiError(response.status, message || `Failed to move the rates (${response.status})`)
    }
    return (await response.json()) as Client
  }
  ```

  Add `type BillRateVersion` and `type CostRateVersion` to the `./types` import block at the top of `src/lib/api.ts`.

  Confirm `safeErrorMessage` prefers a `message` field over `error`; if it does not, read it (`src/lib/api.ts`, search `function safeErrorMessage`) and follow whatever `fetchClientRecap` does with the master 409 — that call already needs both halves, so the pattern exists.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run src/__tests__/rate-version-routes.test.ts
  npx tsc -b
  npx eslint src/lib/api.ts src/lib/types.ts src/__tests__/rate-version-routes.test.ts
  ```

  Expected: 8 passing tests, `tsc -b` clean.

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/api.ts src/lib/types.ts src/__tests__/rate-version-routes.test.ts
  git commit -m "$(cat <<'EOF'
Give the browser a door onto rate history

Six API calls: fetchRateVersions plus a save and a remove for each side, and the
targeted setClientHourlyRatePeriod. A 403 on the read answers two empty lists
rather than throwing — that is exactly the fallback a staff session already
resolves to, so a redacted page stays a page. A refused delete carries the
store's sentence through to the person who pressed it.

Client gains hourlyRatePeriod and hourlyRateHistory; BillRateVersion and
CostRateVersion are re-exported from the resolver so there is one definition.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 14: Team page — effective-from inputs and history

**Files:**
- Modify: `src/pages/TeamPage.tsx` (imports `:8-31`, state `:57-60`, handlers `:62-110`, Bill rate box `:473-509`, Cost rate box `:519-555`)
- Test: `src/__tests__/team-rate-history.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchRateVersions`, `upsertBillRateVersion`, `deleteBillRateVersion`, `upsertCostRateVersion`, `deleteCostRateVersion`, types `BillRateVersion` / `CostRateVersion`
- Produces: no exports — UI only

- [ ] **Step 1: Write the failing test**

  Create `src/__tests__/team-rate-history.test.tsx`. Copy the render scaffolding from `src/__tests__/team-assigned-clients.test.tsx` verbatim (it already mounts `TeamPage` with a mocked `../lib/api` and an owner `AppContext`); add `fetchRateVersions`, `upsertBillRateVersion` and `deleteBillRateVersion` to that file's `vi.mock('../lib/api', …)` factory.

  ```tsx
  describe('Team page rate history', () => {
    it('defaults the bill rate’s effective-from to the current month', async () => {
      await renderTeamPage()
      await userEvent.click(screen.getByRole('button', { name: /Lisa/ }))
      const input = screen.getByLabelText(/Effective from/i, { selector: 'input[type="month"]' })
      expect(input).toHaveValue(new Date().toISOString().slice(0, 7))
    })

    it('saves the rate through the version endpoint, not the old one', async () => {
      await renderTeamPage()
      await userEvent.click(screen.getByRole('button', { name: /Lisa/ }))
      const rate = screen.getByLabelText(/^Bill rate$/i)
      await userEvent.clear(rate)
      await userEvent.type(rate, '60')
      const month = screen.getByLabelText(/Effective from/i, { selector: 'input[type="month"]' })
      await userEvent.clear(month)
      await userEvent.type(month, '2026-10')
      await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])
      expect(upsertBillRateVersion).toHaveBeenCalledWith('emp-lisa', '2026-10', 60)
      expect(setTeamMemberBillRate).not.toHaveBeenCalled()
    })

    it('lists prior versions and offers Remove on the NEWEST only', async () => {
      await renderTeamPage()
      await userEvent.click(screen.getByRole('button', { name: /Lisa/ }))
      await userEvent.click(screen.getByText(/Rate history/i))
      expect(screen.getByText('2026-06')).toBeInTheDocument()
      expect(screen.getByText('2026-09')).toBeInTheDocument()
      // One Remove button across both rows — the newest.
      const removes = screen.getAllByRole('button', { name: /Remove/i })
      expect(removes).toHaveLength(1)
      await userEvent.click(removes[0])
      expect(deleteBillRateVersion).toHaveBeenCalledWith('emp-lisa', '2026-09')
    })

    it('prints the server’s sentence when a removal is refused', async () => {
      vi.mocked(deleteBillRateVersion).mockRejectedValueOnce(
        new ApiError(409, 'A client is pinned at or after this month, so it is still billing at this rate. Move that client first.'),
      )
      await renderTeamPage()
      await userEvent.click(screen.getByRole('button', { name: /Lisa/ }))
      await userEvent.click(screen.getByText(/Rate history/i))
      await userEvent.click(screen.getByRole('button', { name: /Remove/i }))
      expect(await screen.findByText(/Move that client first/)).toBeInTheDocument()
    })

    it('defaults the cost rate’s effective-from to today', async () => {
      await renderTeamPage()
      await userEvent.click(screen.getByRole('button', { name: /Lisa/ }))
      const input = screen.getByLabelText(/Effective from/i, { selector: 'input[type="date"]' })
      expect(input).toHaveValue(new Date().toISOString().slice(0, 10))
    })
  })
  ```

  Have the mocked `fetchRateVersions` resolve:

  ```ts
  {
    billRateVersions: [
      { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
      { userId: 'emp-lisa', effectivePeriod: '2026-09', rate: 55 },
    ],
    costRateVersions: [{ userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 }],
  }
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run src/__tests__/team-rate-history.test.tsx
  ```

  Expected: `Unable to find a label with the text of: /Effective from/i`.

- [ ] **Step 3: Write minimal implementation**

  Add to the `../lib/api` import block (`src/pages/TeamPage.tsx:8-21`):

  ```ts
    deleteBillRateVersion,
    deleteCostRateVersion,
    fetchRateVersions,
    upsertBillRateVersion,
    upsertCostRateVersion,
  ```

  Add to the `../lib/types` import block:

  ```ts
    type BillRateVersion,
    type CostRateVersion,
  ```

  Add state beside the existing drafts (`src/pages/TeamPage.tsx:57-60`):

  ```tsx
    /**
     * THE RATE HISTORY, fetched rather than read off the workspace snapshot:
     * `read()` deliberately does not select rate data, so it never reaches a
     * staff session at all. Same reasoning as ReportsPage's cost-rate map.
     */
    const [billVersions, setBillVersions] = useState<BillRateVersion[]>([])
    const [costVersions, setCostVersions] = useState<CostRateVersion[]>([])
    const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})
    const [rateError, setRateError] = useState<Record<string, string>>({})
    // The common edit is a raise starting NOW, so the default is this month /
    // today and the owner types one number, exactly as before. Picking a
    // different month is the rarer case and costs one extra glance.
    const thisMonth = new Date().toISOString().slice(0, 7)
    const todayIso = new Date().toISOString().slice(0, 10)
    const [billFromDraft, setBillFromDraft] = useState<Record<string, string>>({})
    const [costFromDraft, setCostFromDraft] = useState<Record<string, string>>({})

    useEffect(() => {
      const controller = new AbortController()
      void fetchRateVersions(controller.signal)
        .then(({ billRateVersions, costRateVersions }) => {
          setBillVersions(billRateVersions)
          setCostVersions(costRateVersions)
        })
        // Non-fatal: the boxes still save, the history list is simply empty.
        .catch(() => {})
      return () => controller.abort()
    }, [])

    const billVersionsFor = (userId: string) =>
      billVersions.filter((row) => row.userId === userId)
    const costVersionsFor = (userId: string) =>
      costVersions.filter((row) => row.userId === userId)
    /** Replace one person's slice wholesale — the endpoint returns their list. */
    const replaceBillVersions = (userId: string, rows: BillRateVersion[]) =>
      setBillVersions((current) => [...current.filter((row) => row.userId !== userId), ...rows])
    const replaceCostVersions = (userId: string, rows: CostRateVersion[]) =>
      setCostVersions((current) => [...current.filter((row) => row.userId !== userId), ...rows])
  ```

  Replace `handleSaveBillRate` (`:62-85`) with:

  ```tsx
    const handleSaveBillRate = async (member: TeamMember) => {
      const raw = billDraft[member.id]
      const value = raw === undefined ? '' : raw.trim()
      const billRate = value === '' ? null : Number(value)
      if (billRate === null || !Number.isFinite(billRate) || billRate < 0) return
      const effectivePeriod = billFromDraft[member.id] ?? thisMonth
      if (!/^\d{4}-\d{2}$/.test(effectivePeriod)) return
      setBillSavingId(member.id)
      setRateError((current) => ({ ...current, [member.id]: '' }))
      try {
        const result = await upsertBillRateVersion(member.id, effectivePeriod, billRate)
        replaceBillVersions(member.id, result.versions)
        // `users.bill_rate` mirrors the NEWEST version, which a backfill does not
        // move — so the card reads the mirror off the list rather than assuming
        // the rate just typed is now the current one.
        const newest = result.versions[result.versions.length - 1] ?? null
        setMembers((current) =>
          current.map((entry) =>
            entry.id === member.id ? { ...entry, billRate: newest?.rate ?? null } : entry,
          ),
        )
        setBillDraft((current) => {
          const next = { ...current }
          delete next[member.id]
          return next
        })
      } catch (error) {
        setRateError((current) => ({
          ...current,
          [member.id]: error instanceof ApiError ? error.message : 'Could not save the rate.',
        }))
      } finally {
        setBillSavingId(null)
      }
    }

    const handleRemoveBillVersion = async (member: TeamMember, effectivePeriod: string) => {
      setRateError((current) => ({ ...current, [member.id]: '' }))
      try {
        const result = await deleteBillRateVersion(member.id, effectivePeriod)
        replaceBillVersions(member.id, result.versions)
        const newest = result.versions[result.versions.length - 1] ?? null
        setMembers((current) =>
          current.map((entry) =>
            entry.id === member.id ? { ...entry, billRate: newest?.rate ?? null } : entry,
          ),
        )
      } catch (error) {
        setRateError((current) => ({
          ...current,
          [member.id]: error instanceof ApiError ? error.message : 'Could not remove the rate.',
        }))
      }
    }
  ```

  Write `handleSaveCostRate` / `handleRemoveCostVersion` as the exact twins, substituting `costFromDraft` / `todayIso` / `/^\d{4}-\d{2}-\d{2}$/` / `upsertCostRateVersion` / `deleteCostRateVersion` / `replaceCostVersions` / `costRate` / `effectiveDate`.

  Add `ApiError` to the `../lib/types` import if it is not already there (it is — `:23`).

  In the Bill rate box (`:473-509`), insert between the `team-cost-input-row` div and the closing `</div>`:

  ```tsx
                          <div className="team-cost-input-row">
                            <label htmlFor={`bill-from-${member.id}`} className="team-cost-hint">
                              Effective from
                            </label>
                            <input
                              id={`bill-from-${member.id}`}
                              type="month"
                              value={billFromDraft[member.id] ?? thisMonth}
                              onChange={(event) =>
                                setBillFromDraft((current) => ({
                                  ...current,
                                  [member.id]: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <RateHistoryList
                            open={historyOpen[`bill-${member.id}`] === true}
                            onToggle={() =>
                              setHistoryOpen((current) => ({
                                ...current,
                                [`bill-${member.id}`]: !current[`bill-${member.id}`],
                              }))
                            }
                            rows={billVersionsFor(member.id).map((row) => ({
                              key: row.effectivePeriod,
                              when: row.effectivePeriod,
                              rate: row.rate,
                            }))}
                            onRemoveNewest={(key) => void handleRemoveBillVersion(member, key)}
                          />
                          {rateError[member.id] ? (
                            <p className="form-error">{rateError[member.id]}</p>
                          ) : null}
  ```

  Mirror it in the Cost rate box with `type="date"`, `costFromDraft`, `todayIso`, `cost-from-${member.id}`, `cost-${member.id}` and `costVersionsFor` / `handleRemoveCostVersion`.

  Add the shared disclosure component at the bottom of `src/pages/TeamPage.tsx`:

  ```tsx
  /**
   * The prior versions of one rate, behind a disclosure.
   *
   * REMOVE IS OFFERED ON THE NEWEST ROW ONLY, because that is the only one the
   * server will delete: an older version is what past months were billed or
   * costed at, and removing it would silently reprice them. The server refuses
   * regardless — this just stops the page offering a button that cannot work.
   */
  function RateHistoryList({
    open,
    onToggle,
    rows,
    onRemoveNewest,
  }: {
    open: boolean
    onToggle: () => void
    rows: Array<{ key: string; when: string; rate: number }>
    onRemoveNewest: (key: string) => void
  }) {
    if (rows.length === 0) return null
    const newest = rows[rows.length - 1]
    return (
      <div className="team-rate-history">
        <button type="button" className="team-icon-button" onClick={onToggle}>
          Rate history ({rows.length})
        </button>
        {open ? (
          <ul className="recap-list">
            {rows.map((row) => (
              <li key={row.key}>
                <span>{row.when}</span>
                <span>
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    row.rate,
                  )}
                  /hr
                </span>
                {row.key === newest.key ? (
                  <button
                    type="button"
                    className="team-icon-button"
                    onClick={() => onRemoveNewest(row.key)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }
  ```

  `rows` arrive from the server already sorted oldest-first per person — do not re-sort.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run src/__tests__/team-rate-history.test.tsx src/__tests__/team-assigned-clients.test.tsx
  npx tsc -b
  npx eslint src/pages/TeamPage.tsx src/__tests__/team-rate-history.test.tsx
  ```

  Expected: 5 new tests pass, the existing Team page suite untouched.

- [ ] **Step 5: Commit**

  ```bash
  git add src/pages/TeamPage.tsx src/__tests__/team-rate-history.test.tsx
  git commit -m "$(cat <<'EOF'
Give each rate on the Team page a date it starts from

The Bill rate box gains an effective-from month and the Cost rate box a date,
both defaulting to now, so the common edit is still one number and one press.
Each box gains a history disclosure listing prior versions, with Remove offered
on the newest row only — the server refuses anything else, and the page should
not offer a button that cannot work. A refused removal prints the server's
sentence.

The card's headline rate follows users.bill_rate, which mirrors the newest
version, so backfilling a forgotten change does not make it look like today's
rate moved.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 15: Client page — the "Hourly rates" block

**Files:**
- Modify: `src/pages/ClientDetailPage.tsx` (`BillingSectionBody` `:927-1005`; new component below it)
- Test: `src/__tests__/client-hourly-rates-block.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchRateVersions`, `setClientHourlyRatePeriod`, `billRateFor` and `ratePeriodAsOf` from `lib/rate-history.js`, `useAppContext().ownerMode`
- Produces: `HourlyRatesField({ client })` — rendered from `BillingSectionBody` for hourly clients

- [ ] **Step 1: Write the failing test**

  Create `src/__tests__/client-hourly-rates-block.test.tsx`, copying the render scaffolding from `src/__tests__/packages-ui.test.tsx` (it already mounts `ClientDetailPage` pieces with a mocked `../lib/api` and an owner context). Mock `fetchRateVersions` to resolve the two-version list from Task 14 and `setClientHourlyRatePeriod` to echo the client.

  ```tsx
  describe('the Hourly rates block', () => {
    const hourly = {
      id: 'c1',
      name: 'Acme',
      billingMode: 'hourly',
      hourlyRate: 100,
      hourlyRatePeriod: '2026-06',
      hourlyRateHistory: [
        { from: null, to: '2026-06', changedAt: '2026-06-01T00:00:00.000Z', changedBy: 'emp-patrice' },
      ],
    }

    it('shows each member’s rate AT THE PIN, not today’s', async () => {
      await renderBilling(hourly)
      expect(await screen.findByText('Lisa')).toBeInTheDocument()
      expect(screen.getByText('$40.00/hr')).toBeInTheDocument()
      expect(screen.queryByText('$55.00/hr')).not.toBeInTheDocument()
    })

    it('says which month the rates date from, and how old that is', async () => {
      await renderBilling(hourly, { today: '2026-09-22' })
      expect(await screen.findByText(/Rates from June 2026/i)).toBeInTheDocument()
      expect(screen.getByText(/3 months/i)).toBeInTheDocument()
    })

    it('moves the client on press, defaulting to next month', async () => {
      await renderBilling(hourly)
      const month = await screen.findByLabelText(/Move to current rates from/i)
      expect(month).toHaveValue('2026-10')
      await userEvent.click(screen.getByRole('button', { name: /Move to current rates/i }))
      expect(setClientHourlyRatePeriod).toHaveBeenCalledWith('c1', '2026-10')
    })

    it('lists the moves', async () => {
      await renderBilling(hourly)
      await userEvent.click(await screen.findByText(/Rate month history/i))
      expect(screen.getByText(/2026-06/)).toBeInTheDocument()
    })

    it('renders nothing for a MONTHLY client', async () => {
      await renderBilling({ ...hourly, billingMode: 'subscription' })
      expect(screen.queryByText(/Hourly rates/i)).not.toBeInTheDocument()
    })

    it('renders nothing for a staff session', async () => {
      await renderBilling(hourly, { ownerMode: false })
      expect(screen.queryByText(/Hourly rates/i)).not.toBeInTheDocument()
    })
  })
  ```

  Pin "today" however that test file's scaffolding already does it (`vi.setSystemTime`); default to `2026-09-22` so the age assertion is stable.

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run src/__tests__/client-hourly-rates-block.test.tsx
  ```

  Expected: `Unable to find an element with the text: Lisa` — the block does not exist.

- [ ] **Step 3: Write minimal implementation**

  Render it from `BillingSectionBody` (`src/pages/ClientDetailPage.tsx:994`), immediately before `<EstimatedRoleHours …>`:

  ```tsx
        <HourlyRatesField client={client} />
  ```

  Add below `BillingSectionBody`:

  ```tsx
  /* -------------------------------------------------------------------------- */
  /* Hourly rates — the client's pin (docs/plans/rate-history-2026-09.md §5)     */
  /* -------------------------------------------------------------------------- */

  /**
   * What this client bills each person at, and the one control that changes it.
   *
   * Hourly clients only: Monthly and Annual bill a fee, so a person's rate says
   * nothing about them and the block is simply absent. Owner-only: rates are
   * between the owner and the client, and a staff session receives a null pin
   * and an empty ledger anyway (`scopeAppDataForSession`).
   *
   * The rates are resolved CLIENT-SIDE through `billRateFor` — the same function
   * the invoice prices with — rather than asking the server for a computed list.
   * Two implementations of "what does this client pay for Lisa's hour" is the
   * thing this whole build exists to avoid.
   *
   * The AGE line is the feature Brittany actually asked for: she does a yearly
   * rate review per client and wants to see, at a glance, which ones are overdue
   * one. An anniversary reminder engine is explicitly out of scope (spec §6).
   */
  export function HourlyRatesField({ client }: { client: Client }) {
    const { data, ownerMode } = useAppContext()
    const [billRateVersions, setBillRateVersions] = useState<BillRateVersion[]>([])
    const [historyOpen, setHistoryOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [moveTo, setMoveTo] = useState('')

    const hidden = !ownerMode || client.billingMode !== 'hourly'

    useEffect(() => {
      if (hidden) return
      const controller = new AbortController()
      void fetchRateVersions(controller.signal)
        .then(({ billRateVersions: rows }) => setBillRateVersions(rows))
        .catch(() => {})
      return () => controller.abort()
    }, [hidden])

    if (hidden) return null

    const pin = client.hourlyRatePeriod ?? null
    const history = client.hourlyRateHistory ?? []
    // NEXT month, because a rate change the owner agrees with a client almost
    // always starts at the next billing period — moving the CURRENT month would
    // reprice work already done at the old rate.
    const now = new Date()
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      .toISOString()
      .slice(0, 7)
    const chosen = moveTo || nextMonth

    const rows = (data.employees ?? [])
      .map((employee) => ({
        id: employee.id,
        name: employee.name,
        rate: billRateFor(billRateVersions, employee.id, pin),
      }))
      .filter((row) => row.rate !== null)
      .sort((a, b) => a.name.localeCompare(b.name))

    const monthsOld = (() => {
      if (!pin) return null
      const [year, month] = pin.split('-').map(Number)
      return (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month)
    })()

    const move = async () => {
      if (!/^\d{4}-\d{2}$/.test(chosen)) return
      setBusy(true)
      setError('')
      try {
        await setClientHourlyRatePeriod(client.id, chosen)
        // The next /api/app-data refresh brings the updated client back; nothing
        // is patched locally, so a failed move leaves no phantom pin behind.
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not move the rates.')
      } finally {
        setBusy(false)
      }
    }

    return (
      <div className="field full-row">
        <span>Hourly rates</span>
        <small className="field-helper">
          What this client is billed for each person's time. Changing a person's rate on the Team
          page does not move this client — press Move to current rates at their review.
        </small>
        {rows.length === 0 ? (
          <p className="muted-text">
            Nobody has a bill rate on file for {pin ? getBillingPeriodLabel(pin) : 'this client'} —
            hours bill at the client's own rate instead.
          </p>
        ) : (
          <ul className="recap-list">
            {rows.map((row) => (
              <li key={row.id}>
                <span>{row.name}</span>
                <span>
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    row.rate as number,
                  )}
                  /hr
                </span>
              </li>
            ))}
          </ul>
        )}
        {pin ? (
          <p className="muted-text">
            Rates from {getBillingPeriodLabel(pin)}
            {monthsOld === null ? '' : ` — ${monthsOld} ${monthsOld === 1 ? 'month' : 'months'} ago`}
          </p>
        ) : null}
        <div className="team-cost-input-row">
          <label htmlFor={`rate-move-${client.id}`} className="team-cost-hint">
            Move to current rates from
          </label>
          <input
            id={`rate-move-${client.id}`}
            type="month"
            value={chosen}
            onChange={(event) => setMoveTo(event.target.value)}
          />
          <button
            type="button"
            className="team-icon-button"
            disabled={busy}
            onClick={() => void move()}
          >
            {busy ? 'Moving…' : 'Move to current rates'}
          </button>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {history.length > 0 ? (
          <div className="team-rate-history">
            <button
              type="button"
              className="team-icon-button"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              Rate month history ({history.length})
            </button>
            {historyOpen ? (
              <ul className="recap-list">
                {history.map((entry, index) => (
                  <li key={`${entry.to}-${index}`}>
                    <span>
                      {entry.from ? `${entry.from} → ${entry.to}` : entry.to}
                    </span>
                    <span>{String(entry.changedAt).slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }
  ```

  Add to `src/pages/ClientDetailPage.tsx`'s imports:

  ```ts
  import { fetchRateVersions, setClientHourlyRatePeriod } from '../lib/api'
  import { billRateFor } from '../../lib/rate-history.js'
  import type { BillRateVersion } from '../lib/types'
  ```

  and `getBillingPeriodLabel` from wherever that page already imports invoice-line helpers (check first; `src/lib/utils` re-exports it).

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run src/__tests__/client-hourly-rates-block.test.tsx src/__tests__/packages-ui.test.tsx
  npx tsc -b
  npx eslint src/pages/ClientDetailPage.tsx src/__tests__/client-hourly-rates-block.test.tsx
  ```

  Expected: 6 new tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/pages/ClientDetailPage.tsx src/__tests__/client-hourly-rates-block.test.tsx
  git commit -m "$(cat <<'EOF'
Show an hourly client which rates it is on and how old they are

The Billing card gains an Hourly rates block for owner sessions on hourly
clients: each team member's rate at this client's pin, the month those rates
date from with its age in months, a month picker defaulting to next month, and
the list of past moves. The rates are resolved in the browser through
billRateFor — the same function the invoice prices with — rather than a second
server-computed list.

The age line is the yearly-review prompt Brittany asked for. An anniversary
reminder engine stays out of scope.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 16: Reports page — cost by entry date

**Files:**
- Modify: `src/pages/ReportsPage.tsx` (`:91-103` the cost-rate effect, `:622`, `:631`, `:655`, `:1116`)
- Test: `src/__tests__/payroll-cost-reconciliation.test.tsx` (append)

**Interfaces:**
- Consumes: `fetchRateVersions`, `costRateFor`, `latestCostRate`
- Produces: no exports

- [ ] **Step 1: Write the failing test**

  Append to `src/__tests__/payroll-cost-reconciliation.test.tsx` (follow its existing render helper):

  ```tsx
  describe('Reports costs a raise on the day it landed', () => {
    it('splits one person’s period across the raise in the detail total', async () => {
      // Two 1-hour entries, one either side of a 2026-09-15 raise from 20 to 24.
      await renderReports({
        entries: [
          { id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-14' },
          { id: 'b', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-16' },
        ],
        costRateVersions: [
          { userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 },
          { userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 },
        ],
      })
      expect(await screen.findByText('$44.00')).toBeInTheDocument()
    })
  })
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run src/__tests__/payroll-cost-reconciliation.test.tsx -t "day it landed"
  ```

  Expected: `Unable to find an element with the text: $44.00` — the page costs both hours at the mirrored 24 and shows $48.00.

- [ ] **Step 3: Write minimal implementation**

  Replace the cost-rate effect (`src/pages/ReportsPage.tsx:91-103`) with:

  ```tsx
    /**
     * THE COST RATE HISTORY, not one live rate per person.
     *
     * Sourced from /api/rate-versions rather than app-data ON PURPOSE, for the
     * same reason the old /api/team read was: rate data is owner-only and
     * `read()` deliberately does not select it, so it never enters the workspace
     * blob a staff session receives. This page is owner-only and the endpoint is
     * owner-gated, so reading it here adds no new exposure.
     *
     * An empty list means NO rates loaded, which is not an error — every Cost
     * cell reads "—", exactly as it did for a person with no rate on file.
     */
    const [costRateVersions, setCostRateVersions] = useState<CostRateVersion[]>([])
    useEffect(() => {
      const controller = new AbortController()
      void fetchRateVersions(controller.signal)
        .then(({ costRateVersions: rows }) => setCostRateVersions(rows))
        // Non-fatal: the Cost column simply reads "—" if rates can't be loaded.
        .catch(() => {})
      return () => controller.abort()
    }, [])
    /**
     * The rate on the DAY each entry was worked — the rule the Client Recap and
     * the assistant's margin analytics now share.
     */
    const costRateOn = (employeeId: string, entryDate?: string) =>
      costRateFor(costRateVersions, employeeId, entryDate ?? null)
    /**
     * A PERIOD figure has no single day, so the per-person period columns price
     * at that person's CURRENT rate — which is what this page has always shown.
     * The per-entry and per-day figures below, which do have dates, use
     * `costRateOn` and are the ones a raise actually moves.
     */
    const costRates: Record<string, number | null> = Object.fromEntries(
      [...new Set(costRateVersions.map((row) => row.userId))].map((userId) => [
        userId,
        latestCostRate(costRateVersions, userId),
      ]),
    )
  ```

  Change `detailCost` (`:631`) to:

  ```tsx
    const detailCost = laborCost(detailRows, costRateOn)
  ```

  Change the per-entry allocation (`:645-660`) to group by resolved rate as well as person — replace the `rowsByEmployee` loop key with `${row.employeeId} ${costRateOn(row.employeeId, row.date)}` and pass that group's rate into `allocatePersonCost`:

  ```tsx
    const detailCostByRowId = (() => {
      // Grouped by person AND the rate that applied on the day — the same
      // grouping `laborCost` now uses, so the column sums to the total under it
      // even when a raise lands mid-period.
      const groups = new Map<string, { rate: number | null; rows: { id: string; minutes: number }[] }>()
      for (const row of detailRows) {
        if (row.countedElsewhere) continue
        const rate = costRateOn(row.employeeId, row.date)
        const key = `${row.employeeId} ${rate ?? ''}`
        const found = groups.get(key)
        if (found) found.rows.push({ id: row.id, minutes: row.minutes })
        else groups.set(key, { rate, rows: [{ id: row.id, minutes: row.minutes }] })
      }
      const byRowId = new Map<string, number | null>()
      for (const group of groups.values()) {
        const costs = allocatePersonCost(
          group.rows.map((row) => row.minutes),
          group.rate,
        )
        group.rows.forEach((row, index) => byRowId.set(row.id, costs[index]))
      }
      return byRowId
    })()
  ```

  `costFor` (`:622`) and `overviewCostFor` (`:1116`) keep reading `costRates` — they are period figures with no single day, and the comment above `costRates` says so. The `costRates` prop threaded to the two child components (`:273`, `:285`, `:368-375`, `:1069-1087`) is unchanged.

  Add the imports:

  ```ts
  import { costRateFor, latestCostRate } from '../../lib/rate-history.js'
  import { fetchRateVersions } from '../lib/api'
  import type { CostRateVersion } from '../lib/types'
  ```

  and drop `fetchTeam` from the import list if nothing else on the page uses it.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run src/__tests__/payroll-cost-reconciliation.test.tsx src/__tests__/payroll-round-four.test.ts src/__tests__/payroll-period.test.ts
  npx tsc -b
  npx eslint src/pages/ReportsPage.tsx
  ```

  Expected: green, including the new `day it landed` test.

- [ ] **Step 5: Commit**

  ```bash
  git add src/pages/ReportsPage.tsx src/__tests__/payroll-cost-reconciliation.test.tsx
  git commit -m "$(cat <<'EOF'
Cost the payroll report's rows at the rate that applied on each day

The page reads the cost-rate version list instead of one live rate per person.
The per-entry and per-day figures resolve by entry date, grouped by person and
resolved rate so the column still sums exactly to the total under it when a
raise lands mid-period. The per-person PERIOD columns keep pricing at the
current rate — a period has no single day — and say so.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 17: Capability manifest

**Files:**
- Modify: `docs/capability-manifest.md` (`:1498-1505`, `:2468-2474`, `:2745-2756`, plus a new entry in the Clients section)
- Test: none (documentation). Verification is `npm run lint` plus reading the diff.

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

  No test. Instead, confirm each block to be replaced still reads exactly as quoted:

  ```bash
  sed -n '1498,1506p;2468,2475p;2745,2757p' docs/capability-manifest.md
  ```

  Expected: the three blocks quoted in Step 3 below, verbatim. If any differs, re-read and adapt the replacement rather than pasting over something else.

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  grep -c "rate month" docs/capability-manifest.md
  ```

  Expected: `0` — the manifest has no concept of a rate month yet.

- [ ] **Step 3: Write minimal implementation**

  **(a) The Client Recap paragraph (`:1498-1505`).** Replace, verbatim:

  ```
  - **A quarterly or yearly recap's revenue is a restatement, not a
    reconciliation.** Every month in the period is priced with the client's rates
    and plans **as they stand now** — no rate history is kept — so a client whose
    rate changed part-way through has the earlier months repriced at the new rate,
    and the figure will not match the invoices actually issued. It answers "what
    is this work worth at today's rates", which is the right question for a
    plan-vs-actual read. The Billing panel says so on screen whenever the period
    spans more than one month. A monthly recap has no such gap.
  ```

  with:

  ```
  - **An HOURLY client's quarterly or yearly recap reconciles.** Every month in
    the period is priced at the **rate month that client was on at the time** —
    the pin it held then, read back from its rate-month history — so a client
    moved to current rates in March has January and February priced at the old
    rates and the figure matches the invoices actually issued. Cost is priced at
    each person's rate on the day they worked, for the same reason. A **Monthly
    or Annual** client still has a single live fee and a single plan list, so its
    multi-month revenue IS a restatement at today's numbers, and the Billing
    panel says so on screen whenever the period spans more than one month.
  ```

  **(b) The per-employee billing paragraph (`:2468-2474`).** Replace, verbatim:

  ```
  - Per-client invoice drafts for the selected billing month: subscription
    plans and/or billable hours become line items; total due computed. For
    Hourly clients, billable hours are charged per team member at that person's
    own bill rate — the invoice shows one "Billable hours — <name>" line each.
    This per-employee billing applies from June 2026 onward; invoices for earlier
    months keep computing at the client's prior per-client hourly rate, so already
    -sent historical invoices stay exact and never change retroactively.
  ```

  with:

  ```
  - Per-client invoice drafts for the selected billing month: subscription
    plans and/or billable hours become line items; total due computed. For
    Hourly clients, billable hours are charged per team member at that person's
    own bill rate **as it stood in the rate month that client is pinned to** —
    the invoice shows one "Billable hours — <name>" line each. So raising
    someone's bill rate does NOT raise every hourly client next month: a new
    client starts on the current rates while existing clients stay where they are
    until you move them at their review (Client page → Billing → Hourly rates).
    This per-employee billing applies from June 2026 onward; invoices for earlier
    months keep computing at the client's prior per-client hourly rate, so already
    -sent historical invoices stay exact and never change retroactively. Nothing
    already sent is ever repriced — a sent invoice carries its own rates.
  ```

  **(c) The Team page entries (`:2745-2756`).** Replace the two bullets with:

  ```
  - Bill rate (expand a member): the $/hour charged to clients for this person's
    billable hours on Hourly-billed clients. Set for ANY member including the
    owner (so the owner's own hours bill). Leave blank to fall back to the firm's
    default hourly rate. Owner-only to edit. **Every saved rate carries an
    "effective from" month**, defaulting to the current month — so a raise starts
    the month you pick and leaves every earlier month alone. Saving a month that
    already has a rate corrects it; saving an earlier month backfills a change
    you forgot to record. "Rate history" lists the prior rates; only the newest
    can be removed, and not while a client is still pinned at or after it.
  - Cost rate (expand a member): optional $/hour pay/cost rate per member. Set
    for ANY member including an owner — an owner who wants her own hours in the
    firm's labor cost (for budgeting) enters her rate here, and from then on her
    time is costed exactly like anyone else's on the Client Recap, the payroll
    and employee reports, and the assistant's margin analytics. Owner-only to
    edit, informational — it is NEVER billed and never shown to staff. Leave it
    blank and that person's time simply costs nothing: their Cost cells read "—"
    and the assistant reports realization only. (Distinct from bill rate above.)
    **Every saved cost rate carries an "effective from" date**, defaulting to
    today, and time is costed at the rate in force **on the day it was worked** —
    so a raise lands on its payday and never changes what a past recap says the
    work cost. "Rate history" lists the prior rates; only the newest can be
    removed.
  ```

  **(d) A new entry in the Clients section** (`## Clients`, `:1151`). Add near the other Billing-card bullets:

  ```
  - **Hourly rates (Hourly clients, owner only).** The Billing card lists what
    this client is billed for each team member's time, the **rate month** those
    rates date from ("Rates from June 2026") and how long ago that was ("15
    months"), so a client overdue a rate review is visible at a glance. **Move to
    current rates from (month)** — defaulting to next month — puts the client on
    that month's rates from then on; earlier months keep billing at the old ones,
    and every move is listed underneath with the date it was made. Raising
    someone's rate on the Team page never moves a client by itself. A new client
    starts on the current rates automatically. Monthly and Annual clients show
    nothing here — they bill a fee, not a person's rate.
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  grep -c "rate month" docs/capability-manifest.md
  git diff --stat docs/capability-manifest.md
  ```

  Expected: a count of at least 5, and a diff touching only `docs/capability-manifest.md`. Read the diff in full before committing — this file is the assistant's knowledge base and a wrong sentence here becomes a wrong answer in Britt's Brain.

- [ ] **Step 5: Commit**

  ```bash
  git add docs/capability-manifest.md
  git commit -m "$(cat <<'EOF'
Describe rate months and effective-from dates in the assistant's knowledge base

Four entries updated and one added: the Team page's bill and cost rate boxes now
carry an effective-from date and a history list; per-employee billing prices at
the client's pinned rate month, so a raise no longer raises every hourly client
next month; an hourly client's multi-month recap reconciles rather than
restates; and the Client page gains an Hourly rates entry describing the pin,
its age and Move to current rates.

The voice agent needs re-provisioning after this deploys.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
  ```

---

### Task 18: Read-only production reproduction

**Files:**
- Create: `$SCRATCH/rate-history-repro.mjs` in the OS temp scratchpad — **NOT in the repo** (`tmp/` is not eslint-ignored, and a scratch script in the tree fails `npm run lint`)
- Modify: nothing

**Interfaces:**
- Consumes: `DATABASE_PUBLIC_URL` via the Railway CLI (HANDOFF §4), `lib/invoice-lines.js`, `lib/rate-history.js`
- Produces: a printed diff. **Zero differences is the gate.**

- [ ] **Step 1: Write the failing test**

  This task's "test" is the script itself, and it is expected to print differences only if the migration is wrong. Write it to the scratchpad:

  ```bash
  SCRATCH="$(node -e "console.log(require('os').tmpdir())")/rate-history-repro"
  mkdir -p "$SCRATCH"
  ```

  Create `$SCRATCH/rate-history-repro.mjs`:

  ```js
  /**
   * READ-ONLY production reproduction for the rate-history build (spec §7).
   *
   * THE GATE: after the migration, every hourly client's August and September
   * 2026 lines must price IDENTICALLY with the new path and the old one. If a
   * single line moves by a cent, the migration's floors are wrong and nothing
   * ships.
   *
   * Nothing here writes. There is no INSERT, UPDATE, DELETE or BEGIN in this
   * file — the migration is built IN MEMORY from the live rows, exactly as
   * initialize() would write it, and thrown away when the process exits.
   *
   * Run from the repo root so the lib imports resolve:
   *   export NODE_PATH="$PWD/node_modules"
   *   DBURL=$(npx @railway/cli@latest variables --service Postgres --json \
   *     | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(v.DATABASE_PUBLIC_URL)')
   *   DBURL="$DBURL" node "$SCRATCH/rate-history-repro.mjs"
   */
  import pg from 'pg'
  import { pathToFileURL } from 'node:url'
  import path from 'node:path'

  const repo = process.cwd()
  const { buildInvoiceLines } = await import(
    pathToFileURL(path.join(repo, 'lib', 'invoice-lines.js')).href
  )
  const { ratePeriodAsOf } = await import(
    pathToFileURL(path.join(repo, 'lib', 'rate-history.js')).href
  )

  const PERIODS = ['2026-08', '2026-09']

  const pool = new pg.Pool({
    connectionString: process.env.DBURL,
    ssl: { rejectUnauthorized: false },
  })

  const { rows: users } = await pool.query(
    `select id, name, bill_rate from users where inactive_at is null`,
  )
  const { rows: clients } = await pool.query(
    `select id, name, billing_mode, hourly_rate, plan_ids, monthly_rate, annual_rate,
            annual_billing_month, monthly_service_tier, invoice_time_breakdown_mode,
            invoice_time_breakdown_amounts, lifecycle_stage, bill_to_client_id,
            is_billing_master, platform_invoicing_opt_out
       from clients
      where billing_mode = 'hourly'`,
  )
  const { rows: entries } = await pool.query(
    `select id, user_id, client_id, to_char(entry_date, 'YYYY-MM-DD') as entry_date,
            minutes, billable, is_adhoc, description
       from time_entries
      where to_char(entry_date, 'YYYY-MM') = any($1::text[])`,
    [PERIODS],
  )
  const { rows: plans } = await pool.query(`select id, name from subscription_plans`)

  // ---- The migration, in memory. Spec §4 steps 2 and 4. ----
  const billRateVersions = users
    .filter((user) => user.bill_rate !== null && user.bill_rate !== undefined)
    .map((user) => ({ userId: user.id, effectivePeriod: '2026-06', rate: Number(user.bill_rate) }))
  const pinned = clients.map((client) => ({
    ...client,
    hourlyRatePeriod: '2026-06',
    hourlyRateHistory: [],
  }))

  // ---- The two shapes the builder wants. ----
  const employees = users.map((user) => ({
    id: user.id,
    name: user.name,
    billRate: user.bill_rate === null ? undefined : Number(user.bill_rate),
  }))
  const appEntries = entries.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    employeeId: row.user_id,
    date: row.entry_date,
    minutes: Number(row.minutes),
    billable: row.billable,
    isAdhoc: row.is_adhoc,
    description: row.description ?? '',
  }))
  const appClient = (row) => ({
    id: row.id,
    name: row.name,
    billingMode: row.billing_mode,
    hourlyRate: Number(row.hourly_rate),
    planIds: Array.isArray(row.plan_ids) ? row.plan_ids : [],
    monthlyRate: row.monthly_rate === null ? undefined : Number(row.monthly_rate),
    annualRate: row.annual_rate === null ? undefined : Number(row.annual_rate),
    annualBillingMonth: row.annual_billing_month ?? undefined,
    monthlyServiceTier: row.monthly_service_tier ?? undefined,
    invoiceTimeBreakdownMode: row.invoice_time_breakdown_mode ?? 'off',
    invoiceTimeBreakdownAmounts: row.invoice_time_breakdown_amounts === true,
    hourlyRatePeriod: row.hourlyRatePeriod,
    hourlyRateHistory: row.hourlyRateHistory,
  })

  const cents = (n) => Math.round((Number(n) || 0) * 100)
  const differences = []
  let compared = 0

  for (const row of pinned) {
    for (const period of PERIODS) {
      const client = appClient(row)
      const common = {
        client,
        entries: appEntries,
        plans,
        billingPeriod: period,
        employees,
        defaultHourlyRate: Number(row.hourly_rate) || 0,
      }
      // OLD: no versions, no pin — the exact call today's code makes.
      const before = buildInvoiceLines(common)
      // NEW: the migrated versions, at the migrated pin.
      const after = buildInvoiceLines({
        ...common,
        billRateVersions,
        ratePeriod: ratePeriodAsOf(client, period),
      })

      compared += 1
      if (cents(before.total) !== cents(after.total)) {
        differences.push({
          client: row.name,
          period,
          field: 'total',
          before: before.total,
          after: after.total,
        })
      }
      if (before.lines.length !== after.lines.length) {
        differences.push({
          client: row.name,
          period,
          field: 'line count',
          before: before.lines.length,
          after: after.lines.length,
        })
        continue
      }
      before.lines.forEach((line, index) => {
        const other = after.lines[index]
        if (cents(line.amount) !== cents(other.amount) || line.label !== other.label) {
          differences.push({
            client: row.name,
            period,
            field: `line ${index} (${line.label})`,
            before: `${line.label} ${line.amount}`,
            after: `${other.label} ${other.amount}`,
          })
        }
      })
    }
  }

  console.log(`hourly clients: ${pinned.length}`)
  console.log(`client-months priced both ways: ${compared}`)
  console.log(`bill-rate versions built in memory: ${billRateVersions.length}`)
  console.log(`time entries in ${PERIODS.join(' / ')}: ${appEntries.length}`)
  console.log('')
  if (differences.length === 0) {
    console.log('ZERO DIFFERENCES — the migration reprices nothing. Gate passed.')
  } else {
    console.log(`${differences.length} DIFFERENCE(S) — DO NOT SHIP:`)
    for (const diff of differences) {
      console.log(`  ${diff.client} ${diff.period} ${diff.field}: ${diff.before} -> ${diff.after}`)
    }
  }

  await pool.end()
  process.exit(differences.length === 0 ? 0 : 1)
  ```

- [ ] **Step 2: Run test to verify it fails**

  There is nothing to make fail here — this script's job is to pass. Prove instead that it can FAIL, by deliberately breaking the pin and confirming the diff appears:

  ```bash
  cd "$(git rev-parse --show-toplevel)"
  export NODE_PATH="$PWD/node_modules"
  DBURL=$(npx @railway/cli@latest variables --service Postgres --json \
    | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(v.DATABASE_PUBLIC_URL)')
  SCRATCH="$(node -e "console.log(require('os').tmpdir())")/rate-history-repro"
  sed 's/2026-06.\{0,2\}$/2027-01'"'"',/' "$SCRATCH/rate-history-repro.mjs" > "$SCRATCH/broken.mjs"
  DBURL="$DBURL" node "$SCRATCH/broken.mjs" | tail -5
  ```

  Expected: a nonzero difference count, proving the comparison is live rather than vacuously true. (If the `sed` does not land, edit `$SCRATCH/broken.mjs` by hand: change the in-memory `effectivePeriod` to `'2027-01'`.)

- [ ] **Step 3: Write minimal implementation**

  No code change. Run the real script:

  ```bash
  DBURL="$DBURL" node "$SCRATCH/rate-history-repro.mjs"
  ```

  If it reports any difference, STOP — the migration floors are wrong, and the fix belongs in Task 2, not here. Report the exact diff lines to the orchestrator.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  DBURL="$DBURL" node "$SCRATCH/rate-history-repro.mjs"; echo "exit=$?"
  git status --porcelain
  ```

  Expected: `ZERO DIFFERENCES — the migration reprices nothing. Gate passed.` and `exit=0`. `git status --porcelain` must be EMPTY — no scratch file may have landed in the repo.

- [ ] **Step 5: Commit**

  Nothing to commit. Record the numbers the script printed (hourly client count, client-months compared, version count, entry count) in the message you hand to the orchestrator — those four figures are the evidence the gate was actually run against production rather than against an empty result set.

  ```bash
  git status --porcelain && echo "nothing to commit — reproduction is read-only, script lives in $SCRATCH"
  ```

---

### Task 19: Verify, then hand the push over

**Files:** none.

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

  No new test. This task runs the ones that exist.

- [ ] **Step 2: Run test to verify it fails**

  Not applicable — proceed to Step 3.

- [ ] **Step 3: Write minimal implementation**

  Nothing to implement. If `npm run verify` is red, fix the cause in the task that owns the file and re-run; do not patch around it here, and do not weaken an assertion.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npm run verify
  ```

  Expected: eslint silent, `tsc -b && vite build` clean, and the vitest run green with roughly 55 more tests than the 3458 the handoff recorded (the exact number depends on how many existing `costRates` call sites Task 11 converted). Any failure is a real one.

  Then confirm nothing stray is in the tree:

  ```bash
  git status --porcelain
  git log --oneline -18
  ```

  Expected: a clean tree and 17 commits from Tasks 1–17 (Task 18 commits nothing).

- [ ] **Step 5: Commit**

  **Nothing to commit, and DO NOT PUSH.** Stop here and hand off. Report to the orchestrator:

  1. `npm run verify` result and the test/file counts;
  2. the four figures the production reproduction printed (Task 18);
  3. the commit range to push (`git log --oneline` first and last SHA);
  4. that `docs/capability-manifest.md` changed, so the voice agent must be re-provisioned **after** the deploy is live.

  The orchestrator does the rest: `git push origin main`, poll `curl -s https://app.pbjsa.com/health` until the body's `commit` matches the pushed SHA, run `node scripts/provision-voice-agent.mjs`, and flip `featreq-23351561` with the note in spec §8:

  > Hourly rates now keep their history. On the Team page each person's bill rate and cost rate carry an "effective from" date, so a raise or a price change starts on the date you pick and leaves everything before it alone. Each hourly client's page shows the rates that client is on and the month they date from; when you review a client, press "Move to current rates from" and pick the month. New clients start on the current rates. The Client Recap costs each person's time at the rate they were paid on the day they worked it, so a raise never changes a past recap. Nothing already sent has changed.

## Open items for the orchestrator

Three things in the spec that this plan does not fully close. They are recorded
rather than invented — each needs a decision, not a guess.

1. **The estimate tier rate, bill side (spec §3).** `resolveTierRate`
   (`lib/client-recap.js:904`) is invoked once, with `costRateOf`. The bill-side
   invocation the spec names does not exist in the current source. Task 9 routes
   `billRateOf` (`lib/client-recap.js:866`) through the resolver at the client's
   pin, which is the substance of the ask — but if a second call site is
   intended, it has to be added rather than converted. Check this while doing
   Task 9.

2. **Reports page "Billable $" (spec §3, final billing bullet).** The spec asks
   the server to price each entry at its client's pin for that entry's period
   and return per-person totals. That is a new server-side aggregation with no
   existing endpoint behind it, and building it would push Task 16 past 90
   minutes and four files. **Task 16 is scoped to the COST side only**, which is
   the correctness defect. `billRateOf` on ReportsPage (`:590-595`) still reads
   the live `employee.billRate` mirror — not wrong (it is "today's rates", which
   is what that column has always shown) but not the spec's answer either.
   Recommend a separate follow-up task rather than stretching this plan.

3. **`db/schema.sql`.** Untouched by every task here. It appears to be
   reference-only — `initialize()` is the real DDL, and that is how the
   `packages` table was added — but confirm before Task 2 whether it should be
   kept in step with the two new tables and two new columns.

One more, smaller: Task 8's test calls `generateInvoicesForPeriod` without my
having read that method's signature end to end. The task instructs the agent to
copy the call shape from the existing `consolidated billing:
generateInvoicesForPeriod merges the subs` suite
(`db/store-staleness.test.mjs:11689`) verbatim rather than guess it.
