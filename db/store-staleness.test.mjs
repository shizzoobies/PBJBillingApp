import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AppDataStore,
  BillingMasterError,
  CHECKLIST_ITEM_SELECT_COLUMNS,
  CREATED_AT_PRESERVED_TABLES,
  INVOICE_SELECT_COLUMNS,
  InvoiceLockedError,
  mapChecklistItemRow,
  mapInvoiceRow,
  mapRecurringReimbursementRow,
  sanitizeAppData,
  sanitizeClientBillingLinks,
} from './store.js'
import {
  BULK_SAVE_TABLES,
  StaleWorkspaceError,
  fileWorkspaceVersion,
  tableVersionSql,
  workspaceVersionSql,
} from '../lib/workspace-version.js'
import { normalizeRecurringReimbursement } from '../lib/expense-coverage.js'

/**
 * End-to-end `appDataStore.write()` contracts on the FILE backend: the
 * staleness guard, and the sub-minute precision of `timeEntries[].minutes`.
 *
 * Both live here (rather than in a second .mjs file) because they exercise the
 * one real `tmp/app-data.json` path — tests in separate files run in parallel
 * workers and would clobber each other's workspace.
 *
 * Cardinal rule 1: `db/store.js` has two backends and any persisted change must
 * touch both. Production is Postgres, so this file cannot prove the Postgres
 * path — that one is validated separately with a rolled-back transaction
 * against production data (HANDOFF §4). What it DOES pin is the contract both
 * branches implement: a save carrying an out-of-date fingerprint is refused and
 * writes NOTHING.
 *
 * These tests share the real file-backend path (`tmp/app-data.json`), so any
 * pre-existing local workspace is snapshotted and restored around the run.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localDataPath = path.join(projectRoot, 'tmp', 'app-data.json')
// `splitTimeEntry` writes an activity-log row, which on the file backend lives
// in this second file — snapshot/restore it for the same reason.
const localAuthPath = path.join(projectRoot, 'tmp', 'auth-state.json')

let savedContents = null
let savedAuthContents = null
let savedDatabaseUrl

function workspace(overrides = {}) {
  return {
    clients: [{ id: 'c1', name: 'Acme' }],
    employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper' }],
    timeEntries: [{ id: 't1', minutes: 30, clientId: 'c1' }],
    checklists: [],
    checklistTemplates: [],
    recycledChecklists: [],
    plans: [],
    contacts: [],
    reimbursements: [],
    recurringReimbursements: [],
    timesheetLocks: [],
    weeklySubmissions: [],
    ...overrides,
  }
}

/**
 * Empty the two endpoint-managed invoice-confidence tables.
 *
 * They live in `tmp/auth-state.json`, which the outer `beforeEach` never
 * touches (it resets app-data only) — so without this every test in a run would
 * inherit the previous one's events and ratings, and the counts below would be
 * whatever order vitest happened to pick.
 */
async function clearInvoiceIntelligence() {
  const authState = existsSync(localAuthPath)
    ? JSON.parse(await readFile(localAuthPath, 'utf8'))
    : {}
  authState.invoiceReviewEvents = []
  authState.invoiceAiReviews = []
  await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
}

beforeAll(async () => {
  // DATABASE_URL must be absent or the store would construct a Pool and take
  // the Postgres branch.
  savedDatabaseUrl = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  if (existsSync(localDataPath)) {
    savedContents = await readFile(localDataPath, 'utf8')
  }
  if (existsSync(localAuthPath)) {
    savedAuthContents = await readFile(localAuthPath, 'utf8')
  }
})

afterAll(async () => {
  if (savedDatabaseUrl !== undefined) {
    process.env.DATABASE_URL = savedDatabaseUrl
  }
  if (savedContents !== null) {
    await writeFile(localDataPath, savedContents)
  } else if (existsSync(localDataPath)) {
    await rm(localDataPath)
  }
  if (savedAuthContents !== null) {
    await writeFile(localAuthPath, savedAuthContents)
  } else if (existsSync(localAuthPath)) {
    await rm(localAuthPath)
  }
})

let store

beforeEach(async () => {
  store = new AppDataStore()
  expect(store.mode).toBe('file')
  // Boot it the way server.js does. Not optional: `initialize()` is what
  // creates the `tmp/` directory (the mkdir in store.js), and without it
  // write() throws ENOENT on any checkout that doesn't already have one.
  // Skipping this passed locally and failed the first CI run, because a clean
  // clone has no tmp/ — a test that depended on ambient machine state.
  await store.initialize()
  // Baseline, unguarded (server-authoritative writes pass no expectedVersion).
  await store.write(workspace())
})

describe('bulk save staleness guard (file backend)', () => {
  it('accepts a save carrying the current fingerprint', async () => {
    const version = await store.computeWorkspaceVersion()
    await expect(
      store.write(workspace({ clients: [{ id: 'c1', name: 'Acme Renamed' }] }), {
        expectedVersion: version,
      }),
    ).resolves.toBeUndefined()

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(persisted.clients[0].name).toBe('Acme Renamed')
  })

  it('REFUSES a save carrying a fingerprint from before another change', async () => {
    // A tab loads and captures the fingerprint...
    const staleVersion = await store.computeWorkspaceVersion()
    // ...then something else lands (a second owner, an import, a timer save).
    await store.write(
      workspace({
        timeEntries: [
          { id: 't1', minutes: 30, clientId: 'c1' },
          { id: 't2', minutes: 45, clientId: 'c1' },
        ],
      }),
    )

    // The stale tab now autosaves its old snapshot — which is missing t2.
    await expect(
      store.write(workspace(), { expectedVersion: staleVersion }),
    ).rejects.toBeInstanceOf(StaleWorkspaceError)
  })

  it('writes NOTHING when it refuses — the wipe never happens', async () => {
    const staleVersion = await store.computeWorkspaceVersion()
    const imported = workspace({
      timeEntries: Array.from({ length: 50 }, (_, index) => ({
        id: `imported-${index}`,
        minutes: 60,
        clientId: 'c1',
      })),
    })
    await store.write(imported)

    // The stale snapshot carries only the single original entry. Before this
    // guard, this exact call is what erased the historical import.
    await expect(
      store.write(workspace(), { expectedVersion: staleVersion }),
    ).rejects.toThrow('stale_workspace')

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(persisted.timeEntries).toHaveLength(50)
  })

  it('reports the server-side current version on the refusal', async () => {
    const staleVersion = await store.computeWorkspaceVersion()
    await store.write(workspace({ clients: [{ id: 'c1', name: 'Moved On' }] }))
    const currentVersion = await store.computeWorkspaceVersion()

    await expect(
      store.write(workspace(), { expectedVersion: staleVersion }),
    ).rejects.toMatchObject({ currentVersion })
  })

  it('lets an unguarded write through — internal read-modify-write helpers are not gated', async () => {
    await store.write(workspace({ clients: [{ id: 'c1', name: 'Changed' }] }))

    // No expectedVersion => no guard at all. The internal read-modify-write
    // helpers (createStandardTemplate, copyTemplateToClient, …) write this way
    // and accept last-writer-wins. `read()`'s materializer write-back used to
    // as well — it now passes the fingerprint it read under (see the guarded
    // write-back suites at the bottom of this file).
    await expect(
      store.write(workspace({ clients: [{ id: 'c1', name: 'Materialized' }] })),
    ).resolves.toBeUndefined()

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(persisted.clients[0].name).toBe('Materialized')
  })

  it('is content-addressed: identical data hashes identically', async () => {
    // Worth pinning because it looks surprising — reverting the workspace
    // reverts the fingerprint. It is also harmless: a "stale" save whose
    // payload matches what is already stored writes the same bytes anyway.
    const original = await store.computeWorkspaceVersion()
    await store.write(workspace({ clients: [{ id: 'c1', name: 'Detour' }] }))
    expect(await store.computeWorkspaceVersion()).not.toBe(original)

    await store.write(workspace())
    expect(await store.computeWorkspaceVersion()).toBe(original)
  })

  it('moves the fingerprint after every accepted save', async () => {
    const first = await store.computeWorkspaceVersion()
    await store.write(workspace({ clients: [{ id: 'c1', name: 'Second' }] }), {
      expectedVersion: first,
    })
    const second = await store.computeWorkspaceVersion()
    expect(second).not.toBe(first)

    // Re-using the consumed fingerprint is refused — this is what stops a tab
    // from saving twice off one token.
    await expect(
      store.write(workspace(), { expectedVersion: first }),
    ).rejects.toBeInstanceOf(StaleWorkspaceError)
  })
})

/**
 * Sub-minute precision survives a real bulk save. `sanitizeAppData` runs at the
 * top of `write()` for BOTH backends, and the owner-tab autosave re-inserts
 * every time entry through it — so an integer coercion there rewrote the whole
 * table's durations on each save (confirmed in production: 501 of 673
 * session-backed rows stored round(session-sum) instead of the exact value).
 */
describe('time entry minutes precision (file backend)', () => {
  const entriesFrom = (persisted) =>
    Object.fromEntries(persisted.timeEntries.map((entry) => [entry.id, entry.minutes]))

  it('round-trips fractional minutes through a bulk save unchanged', async () => {
    await store.write(
      workspace({
        timeEntries: [
          // 14m 33s — the shape normalizeWorkSessions produces from `sessions`.
          { id: 't-frac', minutes: 14.55, clientId: 'c1' },
          // 45s. Must NOT become 1 minute.
          { id: 't-sub', minutes: 0.75, clientId: 'c1' },
          { id: 't-whole', minutes: 30, clientId: 'c1' },
        ],
      }),
    )

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(entriesFrom(persisted)).toEqual({
      't-frac': 14.55,
      't-sub': 0.75,
      't-whole': 30,
    })
  })

  it('survives repeated autosaves without drifting toward whole minutes', async () => {
    const exact = 872 / 60 // 14m 32s
    let payload = workspace({ timeEntries: [{ id: 't-1', minutes: exact, clientId: 'c1' }] })
    for (let i = 0; i < 5; i += 1) {
      await store.write(payload)
      payload = workspace({ timeEntries: JSON.parse(await readFile(localDataPath, 'utf8')).timeEntries })
    }

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(persisted.timeEntries[0].minutes).toBe(exact)
  })

  it('still floors bad values at 1 minute and clamps the ceiling', async () => {
    await store.write(
      workspace({
        timeEntries: [
          { id: 't-zero', minutes: 0, clientId: 'c1' },
          { id: 't-neg', minutes: -30, clientId: 'c1' },
          { id: 't-nan', minutes: 'not-a-number', clientId: 'c1' },
          { id: 't-huge', minutes: 5_000_000, clientId: 'c1' },
        ],
      }),
    )

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(entriesFrom(persisted)).toEqual({
      't-zero': 1,
      't-neg': 1,
      't-nan': 1,
      't-huge': 100000,
    })
  })
})

/**
 * `splitTimeEntry` — replacing an unsplit group holding entry with one billable
 * slice per client, atomically.
 *
 * What this pins (all real defects of the old client-side create-loop):
 *   - each slice keeps the block's `sessions` VERBATIM, so a split no longer
 *     blanks the clock-in/out on the Raw report;
 *   - the holding entry is gone, never left behind double-counting;
 *   - the split is written to the activity log;
 *   - a refused split (already split / gone / empty allocation) writes NOTHING;
 *   - the allocation mode is persisted on every slice.
 */
describe('splitTimeEntry (file backend)', () => {
  const SESSIONS = [
    { startAt: '2026-07-01T14:00:00.000Z', endAt: '2026-07-01T14:30:00.000Z' },
    { startAt: '2026-07-01T15:00:00.000Z', endAt: '2026-07-01T15:18:30.000Z' },
  ]

  const holdingEntry = (overrides = {}) => ({
    id: 'hold-1',
    employeeId: 'emp-1',
    clientId: '',
    isAdministrative: false,
    date: '2026-07-01',
    minutes: 48.5,
    category: 'General',
    description: 'Quarterly review call',
    billable: false,
    taskId: null,
    approvalStatus: 'approved',
    entryMethod: 'timer',
    startAt: SESSIONS[0].startAt,
    endAt: SESSIONS[1].endAt,
    sessions: SESSIONS,
    groupClientIds: ['c1', 'c2'],
    ...overrides,
  })

  const seedHolding = async (overrides = {}) => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
        timeEntries: [holdingEntry(overrides)],
      }),
    )
  }

  const persisted = async () => JSON.parse(await readFile(localDataPath, 'utf8'))

  it('replaces the holding entry with one slice per client', async () => {
    await seedHolding()

    const result = await store.splitTimeEntry(
      'hold-1',
      [
        { clientId: 'c1', minutes: 24.25 },
        { clientId: 'c2', minutes: 24.25 },
      ],
      'owner-1',
      'grp-abc',
      'even',
    )

    expect(result.deletedId).toBe('hold-1')
    expect(result.created).toHaveLength(2)

    const data = await persisted()
    expect(data.timeEntries.find((entry) => entry.id === 'hold-1')).toBeUndefined()
    expect(data.timeEntries).toHaveLength(2)
    expect(data.timeEntries.map((entry) => entry.clientId).sort()).toEqual(['c1', 'c2'])
    // The block's minutes are fully accounted for, on the seconds grid.
    const totalSeconds = data.timeEntries.reduce(
      (sum, entry) => sum + Math.round(entry.minutes * 60),
      0,
    )
    expect(totalSeconds).toBe(Math.round(48.5 * 60))
  })

  it('copies the block sessions + envelope + description onto every slice', async () => {
    await seedHolding()

    const { created } = await store.splitTimeEntry(
      'hold-1',
      [
        { clientId: 'c1', minutes: 24.25 },
        { clientId: 'c2', minutes: 24.25 },
      ],
      'owner-1',
      'grp-abc',
      'even',
    )

    for (const slice of created) {
      // The whole point: a split no longer loses the original clock-in/out.
      expect(slice.sessions).toEqual(SESSIONS)
      expect(slice.startAt).toBe(SESSIONS[0].startAt)
      expect(slice.endAt).toBe(SESSIONS[1].endAt)
      expect(slice.description).toBe('Quarterly review call')
      expect(slice.date).toBe('2026-07-01')
      expect(slice.employeeId).toBe('emp-1')
      expect(slice.entryMethod).toBe('timer')
      expect(slice.billable).toBe(true)
      expect(slice.isAdministrative).toBe(false)
      expect(slice.groupId).toBe('grp-abc')
      expect(slice.groupClientIds).toEqual([])
      // Sessions are copied, not shared — mutating a slice can't corrupt a sibling.
      expect(slice.sessions).not.toBe(SESSIONS)
    }
  })

  it('queues every slice as pending — split allocations are typed time', async () => {
    await seedHolding()
    const { created } = await store.splitTimeEntry(
      'hold-1',
      [{ clientId: 'c1', minutes: 48.5 }],
      'owner-1',
      'grp-abc',
      'full',
    )
    // Mirrors createTimeEntry: `entryMethod === 'timer' && !groupId` auto-approves,
    // and a slice ALWAYS carries a groupId.
    expect(created.every((slice) => slice.approvalStatus === 'pending')).toBe(true)
  })

  it('inherits the manual reason when the block was a manual entry', async () => {
    await seedHolding({ entryMethod: 'manual', manualReason: 'Forgot to start the timer' })
    const { created } = await store.splitTimeEntry(
      'hold-1',
      [{ clientId: 'c1', minutes: 48.5 }],
      'owner-1',
      'grp-abc',
      'even',
    )
    expect(created[0].entryMethod).toBe('manual')
    expect(created[0].manualReason).toBe('Forgot to start the timer')
  })

  it('stores the allocation mode on each slice', async () => {
    await seedHolding()
    await store.splitTimeEntry(
      'hold-1',
      [
        { clientId: 'c1', minutes: 48.5 },
        { clientId: 'c2', minutes: 48.5 },
      ],
      'owner-1',
      'grp-full',
      'full',
    )
    const data = await persisted()
    expect(data.timeEntries.map((entry) => entry.groupAllocation)).toEqual(['full', 'full'])
  })

  it('records the split in the activity log', async () => {
    await seedHolding()
    // The activity log lives in its own file and is NOT reset between tests, so
    // measure the delta rather than the absolute count.
    const splitRows = async () => {
      if (!existsSync(localAuthPath)) return []
      const auth = JSON.parse(await readFile(localAuthPath, 'utf8'))
      return (auth.activityLog ?? []).filter((row) => row.action === 'time_entry_split')
    }
    const before = await splitRows()
    await store.splitTimeEntry(
      'hold-1',
      [
        { clientId: 'c1', minutes: 24.25 },
        { clientId: 'c2', minutes: 24.25 },
      ],
      'owner-1',
      'grp-abc',
      'even',
    )
    const after = await splitRows()
    expect(after).toHaveLength(before.length + 1)
    const logged = after[after.length - 1]
    expect(logged.userId).toBe('owner-1')
    expect(logged.target).toContain('Quarterly review call')
    expect(logged.target).toContain('2 clients')
  })

  it('writes NOTHING when the allocation is empty', async () => {
    await seedHolding()
    const before = await persisted()

    await expect(store.splitTimeEntry('hold-1', [], 'owner-1', 'grp-abc', 'even')).rejects.toThrow()
    await expect(
      store.splitTimeEntry('hold-1', [{ clientId: 'c1', minutes: 0 }], 'owner-1', 'grp-abc', 'even'),
    ).rejects.toThrow()

    expect(await persisted()).toEqual(before)
  })

  it('fails cleanly on a second split of the same block (no duplicates)', async () => {
    await seedHolding()
    await store.splitTimeEntry(
      'hold-1',
      [
        { clientId: 'c1', minutes: 24.25 },
        { clientId: 'c2', minutes: 24.25 },
      ],
      'owner-1',
      'grp-abc',
      'even',
    )
    const afterFirst = await persisted()

    await expect(
      store.splitTimeEntry(
        'hold-1',
        [
          { clientId: 'c1', minutes: 24.25 },
          { clientId: 'c2', minutes: 24.25 },
        ],
        'owner-1',
        'grp-def',
        'even',
      ),
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(await persisted()).toEqual(afterFirst)
  })

  it('refuses an entry with neither a client nor group members', async () => {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme' }],
        timeEntries: [holdingEntry({ id: 'orphan-1', clientId: '', groupClientIds: [] })],
      }),
    )
    const before = await persisted()

    await expect(
      store.splitTimeEntry(
        'orphan-1',
        [
          { clientId: 'c1', minutes: 24.25 },
          { clientId: 'c2', minutes: 24.25 },
        ],
        'owner-1',
        'g',
        'even',
      ),
    ).rejects.toMatchObject({ code: 'not_holding' })

    expect(await persisted()).toEqual(before)
  })
})

/**
 * `splitTimeEntry` on a REGULAR client entry — the firm owner's report that
 * editing time to split clients "will only let me if I pick one client".
 * Splitting used to be a group-timer-only path; ordinary time (including a
 * slice from an earlier split) can now be divided across clients too.
 *
 * What this pins beyond the holding-block suite above:
 *   - a regular entry splits and its sessions survive verbatim;
 *   - an APPROVED original becomes PENDING slices (same rule as any edit to an
 *     approved entry) and the original is gone;
 *   - the entry's own billable flag carries over — a split must not start
 *     billing internal time;
 *   - administrative time is refused (`not_splittable`), and a ONE-allocation
 *     "split" is refused (`single_allocation`) because that's the edit form's
 *     client dropdown, not a split;
 *   - a slice can be re-split.
 */
describe('splitTimeEntry on a regular client entry (file backend)', () => {
  const SESSIONS = [
    { startAt: '2026-07-02T13:00:00.000Z', endAt: '2026-07-02T13:40:00.000Z' },
    { startAt: '2026-07-02T14:00:00.000Z', endAt: '2026-07-02T14:20:30.000Z' },
  ]

  const regularEntry = (overrides = {}) => ({
    id: 'reg-1',
    employeeId: 'emp-1',
    clientId: 'c1',
    isAdministrative: false,
    date: '2026-07-02',
    minutes: 60.5,
    category: 'General',
    description: 'Month-end cleanup',
    billable: true,
    taskId: null,
    approvalStatus: 'approved',
    entryMethod: 'timer',
    startAt: SESSIONS[0].startAt,
    endAt: SESSIONS[1].endAt,
    sessions: SESSIONS,
    groupClientIds: [],
    ...overrides,
  })

  const seedRegular = async (overrides = {}) => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
        timeEntries: [regularEntry(overrides)],
      }),
    )
  }

  const persisted = async () => JSON.parse(await readFile(localDataPath, 'utf8'))

  it('splits an ordinary client entry across clients, sessions intact', async () => {
    await seedRegular()

    const { created, deletedId } = await store.splitTimeEntry(
      'reg-1',
      [
        { clientId: 'c1', minutes: 30.25 },
        { clientId: 'c2', minutes: 30.25 },
      ],
      'owner-1',
      'grp-reg',
      'even',
    )

    expect(deletedId).toBe('reg-1')
    expect(created).toHaveLength(2)
    for (const slice of created) {
      expect(slice.sessions).toEqual(SESSIONS)
      expect(slice.startAt).toBe(SESSIONS[0].startAt)
      expect(slice.endAt).toBe(SESSIONS[1].endAt)
      expect(slice.description).toBe('Month-end cleanup')
      expect(slice.date).toBe('2026-07-02')
      expect(slice.employeeId).toBe('emp-1')
      expect(slice.groupId).toBe('grp-reg')
      expect(slice.groupAllocation).toBe('even')
    }

    const data = await persisted()
    expect(data.timeEntries.find((entry) => entry.id === 'reg-1')).toBeUndefined()
    expect(data.timeEntries.map((entry) => entry.clientId).sort()).toEqual(['c1', 'c2'])
    const totalSeconds = data.timeEntries.reduce(
      (sum, entry) => sum + Math.round(entry.minutes * 60),
      0,
    )
    expect(totalSeconds).toBe(Math.round(60.5 * 60))
  })

  it('sends an approved original back through approval as pending slices', async () => {
    await seedRegular({ approvalStatus: 'approved' })
    const { created } = await store.splitTimeEntry(
      'reg-1',
      [
        { clientId: 'c1', minutes: 30.25 },
        { clientId: 'c2', minutes: 30.25 },
      ],
      'owner-1',
      'grp-reg',
      'even',
    )
    expect(created.every((slice) => slice.approvalStatus === 'pending')).toBe(true)
  })

  it('carries the entry own billable flag over — internal time stays internal', async () => {
    await seedRegular({ billable: false })
    const { created } = await store.splitTimeEntry(
      'reg-1',
      [
        { clientId: 'c1', minutes: 30.25 },
        { clientId: 'c2', minutes: 30.25 },
      ],
      'owner-1',
      'grp-reg',
      'even',
    )
    expect(created.every((slice) => slice.billable === false)).toBe(true)
  })

  it('refuses administrative time — there is no client to divide', async () => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
        timeEntries: [regularEntry({ id: 'admin-1', clientId: '', isAdministrative: true })],
      }),
    )
    const before = await persisted()

    await expect(
      store.splitTimeEntry(
        'admin-1',
        [
          { clientId: 'c1', minutes: 30.25 },
          { clientId: 'c2', minutes: 30.25 },
        ],
        'owner-1',
        'grp-reg',
        'even',
      ),
    ).rejects.toMatchObject({ code: 'not_splittable' })

    expect(await persisted()).toEqual(before)
  })

  it('refuses a one-allocation split — that is the edit form client dropdown', async () => {
    await seedRegular()
    const before = await persisted()

    await expect(
      store.splitTimeEntry('reg-1', [{ clientId: 'c2', minutes: 60.5 }], 'owner-1', 'g', 'even'),
    ).rejects.toMatchObject({ code: 'single_allocation' })

    expect(await persisted()).toEqual(before)
  })

  it('re-splits a slice from an earlier split', async () => {
    await seedRegular()
    const { created } = await store.splitTimeEntry(
      'reg-1',
      [
        { clientId: 'c1', minutes: 30.25 },
        { clientId: 'c2', minutes: 30.25 },
      ],
      'owner-1',
      'grp-reg',
      'even',
    )
    const slice = created[0]
    expect(slice.groupId).toBe('grp-reg')

    const second = await store.splitTimeEntry(
      slice.id,
      [
        { clientId: 'c1', minutes: 15.125 },
        { clientId: 'c2', minutes: 15.125 },
      ],
      'owner-1',
      'grp-reg-2',
      'even',
    )
    expect(second.deletedId).toBe(slice.id)
    expect(second.created).toHaveLength(2)
    // A fresh groupId replaces the old one, and the sessions still ride along.
    expect(second.created.every((row) => row.groupId === 'grp-reg-2')).toBe(true)
    expect(second.created[0].sessions).toEqual(SESSIONS)

    const data = await persisted()
    expect(data.timeEntries.find((entry) => entry.id === slice.id)).toBeUndefined()
    expect(data.timeEntries).toHaveLength(3)
  })

  it('leaves the holding-block path alone — a group block still splits', async () => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
        timeEntries: [
          regularEntry({ id: 'hold-x', clientId: '', groupClientIds: ['c1', 'c2'], billable: false }),
        ],
      }),
    )
    const { created } = await store.splitTimeEntry(
      'hold-x',
      [
        { clientId: 'c1', minutes: 30.25 },
        { clientId: 'c2', minutes: 30.25 },
      ],
      'owner-1',
      'grp-hold',
      'even',
    )
    // A holding block parks `billable: false` until split; its slices bill.
    expect(created.every((slice) => slice.billable === true)).toBe(true)
  })
})

/**
 * EDIT THEN SPLIT — "still will not let me edit the time before I split it".
 *
 * The two halves have to compose: adjusting a session-backed entry's billed
 * duration must actually stick, and the split that follows must divide the
 * EDITED total rather than re-deriving the original from the untouched clock
 * spans. Both are exercised here through the same store calls the PATCH handler
 * and the split endpoint make, on the file backend, to the second.
 *
 * The minutes rule itself is `minutesAfterEntryEdit`, unit-tested in
 * lib/group-allocation.test.mjs; what this pins is that the store persists its
 * result and that `splitTimeEntry` divides what was persisted.
 */
describe('edit a session-backed entry, then split it (file backend)', () => {
  // A single 60-minute timer session. The number to watch: the split below
  // divides 45, not 60.
  const SESSIONS = [{ startAt: '2026-07-03T13:00:00.000Z', endAt: '2026-07-03T14:00:00.000Z' }]

  const seed = async (overrides = {}) => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
        timeEntries: [
          {
            id: 'edit-1',
            employeeId: 'emp-1',
            clientId: 'c1',
            isAdministrative: false,
            date: '2026-07-03',
            minutes: 60,
            category: 'General',
            description: 'Bank rec',
            billable: true,
            taskId: null,
            approvalStatus: 'pending',
            entryMethod: 'timer',
            startAt: SESSIONS[0].startAt,
            endAt: SESSIONS[0].endAt,
            sessions: SESSIONS,
            groupClientIds: [],
            ...overrides,
          },
        ],
      }),
    )
  }

  const persisted = async () => JSON.parse(await readFile(localDataPath, 'utf8'))
  const entryById = async (id) => (await persisted()).timeEntries.find((e) => e.id === id)
  const seconds = (minutes) => Math.round(Number(minutes) * 60)

  it('keeps a typed duration that disagrees with the clock spans', async () => {
    await seed()
    // What the PATCH handler stores when the user typed 45 minutes: the billed
    // minutes change, the sessions stay verbatim as the audit trail.
    await store.updateTimeEntry('edit-1', { minutes: 45, sessions: SESSIONS })

    const saved = await entryById('edit-1')
    expect(saved.minutes).toBe(45)
    expect(saved.sessions).toEqual(SESSIONS)
  })

  it('divides the EDITED total across clients, to the second', async () => {
    await seed()
    await store.updateTimeEntry('edit-1', { minutes: 45, sessions: SESSIONS })

    const { created, deletedId } = await store.splitTimeEntry(
      'edit-1',
      [
        { clientId: 'c1', minutes: 20 },
        { clientId: 'c2', minutes: 25 },
      ],
      'owner-1',
      'grp-edit',
      'custom',
    )

    expect(deletedId).toBe('edit-1')
    expect(created.map((slice) => slice.minutes).sort((a, b) => a - b)).toEqual([20, 25])
    // The 60-minute clock is NOT what got divided.
    const totalSeconds = created.reduce((sum, slice) => sum + seconds(slice.minutes), 0)
    expect(totalSeconds).toBe(seconds(45))
    // Every slice still carries the clock-in/out of when the work happened.
    for (const slice of created) {
      expect(slice.sessions).toEqual(SESSIONS)
      expect(slice.startAt).toBe(SESSIONS[0].startAt)
      expect(slice.endAt).toBe(SESSIONS[0].endAt)
    }
  })

  it('survives seconds-exact edits — 45m 20s splits into 20m 20s + 25m', async () => {
    await seed()
    const edited = 45 + 20 / 60
    await store.updateTimeEntry('edit-1', { minutes: edited, sessions: SESSIONS })
    expect((await entryById('edit-1')).minutes).toBe(edited)

    const { created } = await store.splitTimeEntry(
      'edit-1',
      [
        { clientId: 'c1', minutes: 20 + 20 / 60 },
        { clientId: 'c2', minutes: 25 },
      ],
      'owner-1',
      'grp-edit-2',
      'custom',
    )
    const totalSeconds = created.reduce((sum, slice) => sum + seconds(slice.minutes), 0)
    expect(totalSeconds).toBe(seconds(edited))
  })

  it('keeps an edited SLICE at its typed minutes, split intact', async () => {
    // A 60-minute block already split 20/40. Retyping one slice's duration must
    // change that slice only — not blow it back up to the whole block.
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
        timeEntries: [
          {
            id: 'slice-a',
            employeeId: 'emp-1',
            clientId: 'c1',
            date: '2026-07-03',
            minutes: 20,
            description: 'Bank rec',
            billable: true,
            approvalStatus: 'pending',
            entryMethod: 'timer',
            startAt: SESSIONS[0].startAt,
            endAt: SESSIONS[0].endAt,
            sessions: SESSIONS,
            groupId: 'grp-live',
            groupAllocation: 'custom',
          },
          {
            id: 'slice-b',
            employeeId: 'emp-1',
            clientId: 'c2',
            date: '2026-07-03',
            minutes: 40,
            description: 'Bank rec',
            billable: true,
            approvalStatus: 'pending',
            entryMethod: 'timer',
            startAt: SESSIONS[0].startAt,
            endAt: SESSIONS[0].endAt,
            sessions: SESSIONS,
            groupId: 'grp-live',
            groupAllocation: 'custom',
          },
        ],
      }),
    )

    await store.updateTimeEntry('slice-a', { minutes: 15, sessions: SESSIONS })

    expect((await entryById('slice-a')).minutes).toBe(15)
    expect((await entryById('slice-a')).sessions).toEqual(SESSIONS)
    // The sibling is untouched — an edit on one slice is not a re-division.
    expect((await entryById('slice-b')).minutes).toBe(40)
  })
})

/**
 * A minimal stand-in for a `pg` Pool, enough to drive the POSTGRES branch of
 * `write()` without a database. Every statement is recorded so a test can
 * assert on what the transaction actually issued and in what order.
 *
 * `write()` only ever consumes the result of three queries â€” the users
 * pre-check, the (optional) version fingerprint, and the invoice-drafts
 * snapshot â€” so returning an empty row set for everything else is faithful.
 */
function fakePostgres({
  invoices = [],
  groupSlices = [],
  clientRows = [],
  userRows = [],
  createdAtRows = {},
  priorItemRows = [],
  templateRows = [],
  templateStageRows = [],
  templateItemRows = [],
  versionResponses = null,
  recurringRows = [],
  aiReviewRows = [],
  aiReviewUpdateRowCount = 1,
} = {}) {
  const statements = []
  const record = (text, params) => {
    const trimmed = String(text).trim()
    statements.push({ text: trimmed, params })
    // The workspace fingerprint (lib/workspace-version.js) — read()'s
    // pre-capture and write()'s in-transaction re-check issue the same SQL.
    // `versionResponses` scripts the answers in order, so a test can make the
    // fingerprint MOVE between the capture and the check (i.e. simulate a
    // concurrent write landing mid-read). Default: empty tables, stable value.
    if (/md5\(coalesce\(string_agg/i.test(trimmed) && /union all/i.test(trimmed)) {
      return { rows: Array.isArray(versionResponses) ? (versionResponses.shift() ?? []) : [] }
    }
    if (/^select\b[\s\S]*\bfrom invoices\b/i.test(trimmed)) {
      return { rows: invoices }
    }
    // read()'s template/stage/item selects — column-anchored so the bulk
    // save's bare `select id, created_at from checklist_templates` snapshot
    // (handled below) never matches these.
    if (/\bnext_due_date\b[\s\S]*from checklist_templates\b/i.test(trimmed)) {
      return { rows: templateRows }
    }
    if (/\boffset_days\b[\s\S]*from checklist_template_stages\b/i.test(trimmed)) {
      return { rows: templateStageRows }
    }
    if (/select id, template_id, label\b[\s\S]*from checklist_template_items\b/i.test(trimmed)) {
      return { rows: templateItemRows }
    }
    // `update invoices … returning id` — the void pass reads its OWN output to
    // decide which retainers to hand back, so the fake has to answer with the
    // rows it claims to have touched or that second statement never runs.
    if (/^update invoices\b[\s\S]*\breturning id$/i.test(trimmed)) {
      return { rows: invoices.map((invoice) => ({ id: invoice.id })) }
    }
    // The bulk save's created_at snapshots — one bare select per table in
    // CREATED_AT_PRESERVED_TABLES, taken before the wipe.
    const createdAtSnapshot = /^select id, created_at from (\w+)$/i.exec(trimmed)
    if (createdAtSnapshot) {
      return { rows: createdAtRows[createdAtSnapshot[1]] ?? [] }
    }
    // The sibling snapshot of what was already complete — and, since the wait
    // preservation, of what waiting state each row already carried.
    if (/^select id, done, completed_at[\s\S]*from checklist_items$/i.test(trimmed)) {
      return { rows: priorItemRows }
    }
    // `_refuseBillingMasterWrite`'s single-row lookup, and `createClient`'s
    // roster read for the bill-to rules. Both answer out of `clientRows` so one
    // fixture drives the read mapper and the guards alike. Anchored on their
    // exact column lists: without these two branches the Postgres half of every
    // master guard falls through to the empty default and is never exercised,
    // which is precisely the "passes CI, wrong in production" shape cardinal
    // rule 1 exists for.
    if (/^select name, is_billing_master from clients where id = \$1$/i.test(trimmed)) {
      const found = clientRows.find((row) => row.id === params?.[0])
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 }
    }
    if (/^select id, name, is_billing_master as "isBillingMaster"/i.test(trimmed)) {
      return {
        rows: clientRows.map((row) => ({
          id: row.id,
          name: row.name,
          isBillingMaster: row.is_billing_master === true,
          billToClientId: row.bill_to_client_id ?? null,
        })),
      }
    }
    // The clients read inside read() — lets a test exercise the row mapper.
    if (/^select\b[\s\S]*\bfrom clients\b[\s\S]*order by name asc/i.test(trimmed)) {
      return { rows: clientRows }
    }
    // The `for update` read a split adjustment starts with.
    if (/^select\b[\s\S]*\bfrom time_entries where group_id\b/i.test(trimmed)) {
      return { rows: groupSlices, rowCount: groupSlices.length }
    }
    // The bare id-validation query `setClientAssignedTeam` issues. Anchored to
    // the exact bare statement (no trailing `where`) so a reintroduced
    // `where role <> 'owner'` filter falls through to the empty default below
    // instead — the same empty-`valid` failure a live regression would cause.
    if (/^select id from users\s*$/i.test(trimmed)) {
      return { rows: userRows }
    }
    // Recurring reimbursements, for the covered-date tests — both the read
    // inside `read()` and the single-row read the update path starts with.
    if (/^select\b[\s\S]*\bfrom recurring_reimbursements\b/i.test(trimmed)) {
      return { rows: recurringRows, rowCount: recurringRows.length }
    }
    if (/^update recurring_reimbursements set[\s\S]*returning/i.test(trimmed)) {
      return { rows: recurringRows, rowCount: recurringRows.length }
    }
    // Invoice AI ratings. The answer path's guarded update needs a scriptable
    // rowCount: matching NO row is the re-rate race, and the store turns that
    // into a 409 rather than a silent success.
    if (/^select\b[\s\S]*\bfrom invoice_ai_reviews\b/i.test(trimmed)) {
      return { rows: aiReviewRows, rowCount: aiReviewRows.length }
    }
    if (/^update invoice_ai_reviews set questions/i.test(trimmed)) {
      return { rows: [], rowCount: aiReviewUpdateRowCount }
    }
    return { rows: [] }
  }
  const client = {
    async query(text, params) {
      return record(text, params)
    },
    release() {},
  }
  const pool = {
    async connect() {
      return client
    },
    async query(text, params) {
      return record(text, params)
    },
  }
  const matching = (pattern) => statements.filter((s) => pattern.test(s.text))
  const indexOf = (pattern) => statements.findIndex((s) => pattern.test(s.text))
  return { pool, statements, matching, indexOf }
}

function postgresStore(fake) {
  const pgStore = new AppDataStore()
  pgStore.pool = fake.pool
  pgStore.mode = 'postgres'
  return pgStore
}

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

const existingInvoice = {
  id: 'inv-1',
  client_id: 'c1',
  period: '2026-08',
  number: 'INV-2026-08-001',
  status: 'sent',
  line_items: [{ kind: 'plan', label: 'August work', detail: 'Monthly service', amount: 250 }],
  subtotal: '250.00',
  total: '250.00',
  due_date: '2026-09-30',
  blurb: '',
  scope_flags: [],
  sent_at: new Date('2026-09-01T12:00:00.000Z'),
  paid_at: null,
  stripe_checkout_session_id: 'cs_ach_1',
  stripe_card_session_id: 'cs_card_1',
  stripe_payment_intent_id: null,
  payment_method: null,
  email_log: [],
  created_at: new Date('2026-08-01T12:00:00.000Z'),
}

/**
 * `invoices` is the one table the bulk save wipes without re-inserting from the
 * payload — the other fourteen appear in both lists, this one only in the
 * deletes. It replaces the empty `invoice_drafts` placeholder, and unlike that
 * placeholder it holds real money: the first invoice Brittany generates would
 * be erased by the next owner autosave if the restore were ever dropped.
 *
 * The delete itself cannot simply go away: `invoices.client_id` is
 * `on delete restrict`, so `delete from clients` refuses to run while any
 * invoice exists. `write()` therefore snapshots the rows and puts them back.
 */
describe('bulk save preserves invoices (postgres branch)', () => {
  it('re-inserts a pre-existing invoice that the wipe removed', async () => {
    const fake = fakePostgres({ invoices: [existingInvoice] })
    await postgresStore(fake).write(workspace())

    const inserts = fake.matching(/^insert into invoices/i)
    expect(inserts).toHaveLength(1)
    // Every column restored verbatim — a SENT invoice must come back exactly
    // as it was, not regenerated from current data. `kind` sits between the
    // number and the status; a fixture written before that column existed
    // restores as 'monthly', which is what it is.
    expect(inserts[0].params.slice(0, 6)).toEqual([
      'inv-1',
      'c1',
      '2026-08',
      'INV-2026-08-001',
      'monthly',
      'sent',
    ])
    expect(inserts[0].params).toContain(existingInvoice.created_at)
    expect(inserts[0].params).toContain(existingInvoice.sent_at)
  })

  it('still deletes first — the clients wipe cannot run past the FK otherwise', async () => {
    const fake = fakePostgres({ invoices: [existingInvoice] })
    await postgresStore(fake).write(workspace())

    const deleteAt = fake.indexOf(/^delete from invoices$/i)
    const clientsWipedAt = fake.indexOf(/^delete from clients$/i)
    expect(deleteAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeLessThan(clientsWipedAt)
  })

  it('restores AFTER the clients are back, so the FK is satisfied', async () => {
    const fake = fakePostgres({ invoices: [existingInvoice] })
    await postgresStore(fake).write(workspace())

    const clientInsertAt = fake.indexOf(/^insert into clients/i)
    const restoreAt = fake.indexOf(/^insert into invoices/i)
    expect(clientInsertAt).toBeGreaterThan(-1)
    expect(restoreAt).toBeGreaterThan(clientInsertAt)
  })

  it('drops an invoice whose client is gone from the payload', async () => {
    const fake = fakePostgres({
      invoices: [existingInvoice, { ...existingInvoice, id: 'inv-2', client_id: 'deleted' }],
    })
    await postgresStore(fake).write(workspace())

    const restoredIds = fake.matching(/^insert into invoices/i).map((s) => s.params[0])
    expect(restoredIds).toEqual(['inv-1'])
  })
  it('issues no restore at all when there were no invoices', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(workspace())

    expect(fake.matching(/^insert into invoices/i)).toHaveLength(0)
  })

  /**
   * The card session id is the newest column on this table, and a column added
   * to the restore's INSERT but not to its snapshot SELECT (or the other way
   * round) loses the id silently. Losing it means the card link a client is
   * holding can never be expired when they pay by bank transfer — two live ways
   * to pay one invoice, which is the exact thing the sibling expiry prevents.
   */
  it('carries both channels’ session ids through the wipe', async () => {
    const fake = fakePostgres({ invoices: [existingInvoice] })
    await postgresStore(fake).write(workspace())

    const snapshot = fake.matching(/^select[\s\S]*from invoices$/i)[0]
    expect(snapshot.text).toMatch(/stripe_card_session_id/)

    const restore = fake.matching(/^insert into invoices/i)[0]
    expect(restore.text).toMatch(/stripe_card_session_id/)
    expect(restore.params).toContain('cs_ach_1')
    expect(restore.params).toContain('cs_card_1')
  })
})

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

/**
 * `applyInvoicePayment` — the ONE path a webhook can take into an invoice.
 *
 * It was deliberately unable to touch money at all. The card fee forces one
 * exception: a client who pays by card is charged the invoice plus a fee, and
 * the invoice of record has to show what actually arrived or History, the month
 * run and the QBO export all disagree with the bank. The rules that make that
 * exception safe are what this pins — it can only ADD, it recomputes the totals
 * itself rather than trusting a caller, and it cannot add the same fee twice.
 *
 * File backend; the Postgres statement shapes are pinned separately below.
 */
describe('applyInvoicePayment and the card fee (file backend)', () => {
  const feeLine = {
    kind: 'card-fee',
    label: 'Card processing fee',
    detail: 'Paid by card',
    amount: 3.3,
  }

  async function seedInvoice(overrides = {}) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-card',
        clientId: 'c1',
        period: '2026-08',
        number: 'INV-2026-08-001',
        status: 'sent',
        lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 100 }],
        subtotal: 100,
        total: 100,
        dueDate: '2026-09-15',
        blurb: '',
        scopeFlags: [],
        sentAt: '2026-08-05T00:00:00.000Z',
        paidAt: null,
        paymentMethod: null,
        stripeCheckoutSessionId: 'cs_ach',
        stripeCardSessionId: 'cs_card',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...overrides,
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  it('appends the fee and recomputes the total when a card payment lands', async () => {
    await seedInvoice()

    const updated = await store.applyInvoicePayment('inv-card', {
      status: 'paid',
      paymentMethod: 'card',
      paidAt: '2026-08-20T00:00:00.000Z',
      appendLines: [feeLine],
    })

    expect(updated.lineItems).toHaveLength(2)
    expect(updated.lineItems[1]).toMatchObject({ kind: 'card-fee', amount: 3.3 })
    // Recomputed from the lines, not handed in by the caller.
    expect(updated.total).toBe(103.3)
    expect(updated.subtotal).toBe(103.3)
    expect(updated.status).toBe('paid')
  })

  // One card payment fires both `checkout.session.completed` and
  // `payment_intent.succeeded`. Two fee lines would be an overcharge on the record.
  it('does not append a second fee when the second event arrives', async () => {
    await seedInvoice()
    await store.applyInvoicePayment('inv-card', { status: 'processing', appendLines: [feeLine] })
    const updated = await store.applyInvoicePayment('inv-card', {
      status: 'paid',
      appendLines: [feeLine],
    })

    expect(updated.lineItems.filter((line) => line.kind === 'card-fee')).toHaveLength(1)
    expect(updated.total).toBe(103.3)
  })

  it('leaves an ACH payment’s lines and totals exactly as they were', async () => {
    await seedInvoice()

    const updated = await store.applyInvoicePayment('inv-card', {
      status: 'processing',
      checkoutSessionId: 'cs_ach',
      paymentIntentId: 'pi_1',
    })

    expect(updated.lineItems).toHaveLength(1)
    expect(updated.total).toBe(100)
    expect(updated.subtotal).toBe(100)
  })

  it('records the card session without disturbing the ACH one', async () => {
    await seedInvoice({ stripeCardSessionId: null })

    const updated = await store.applyInvoicePayment('inv-card', {
      cardCheckoutSessionId: 'cs_card_new',
    })

    expect(updated.stripeCardSessionId).toBe('cs_card_new')
    expect(updated.stripeCheckoutSessionId).toBe('cs_ach')
  })

  /**
   * `statusChanged` — the fact the webhook's client emails turn on.
   *
   * "The invoice is now paid" and "the invoice just became paid" are different
   * statements, and only the second one earns a receipt. Stripe replays events,
   * so without this a client can be thanked twice for one payment.
   */
  it('reports that the status moved', async () => {
    await seedInvoice()
    const updated = await store.applyInvoicePayment('inv-card', { status: 'processing' })
    expect(updated.statusChanged).toBe(true)
  })

  it('reports that a replay of the same status moved nothing', async () => {
    await seedInvoice({ status: 'processing' })
    const updated = await store.applyInvoicePayment('inv-card', { status: 'processing' })
    expect(updated.statusChanged).toBe(false)
  })

  // It is a fact about the WRITE, not a column. It must never reach the API as
  // though it were part of the invoice, nor land in the stored record.
  it('keeps statusChanged out of the JSON and off the stored row', async () => {
    await seedInvoice()
    const updated = await store.applyInvoicePayment('inv-card', { status: 'processing' })

    expect(JSON.parse(JSON.stringify(updated))).not.toHaveProperty('statusChanged')
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(data.invoices[0]).not.toHaveProperty('statusChanged')
  })

  // The narrow-by-design rule still holds: this is not a way to edit an invoice.
  it('refuses to append anything to a voided invoice', async () => {
    await seedInvoice({ status: 'void' })

    const result = await store.applyInvoicePayment('inv-card', {
      status: 'paid',
      appendLines: [feeLine],
    })

    expect(result).toBeNull()
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    const stored = data.invoices.find((entry) => entry.id === 'inv-card')
    expect(stored.status).toBe('void')
    expect(stored.lineItems).toHaveLength(1)
    expect(stored.total).toBe(100)
  })
})

/**
 * The same contract's POSTGRES statement shapes — the branch production runs.
 *
 * The one worth naming: the money columns must be ABSENT from the update unless
 * a line was actually appended. Writing them on every payment event would turn
 * this into a read-modify-write over the lines, and an edit made between the
 * read and the update would be silently reverted by a webhook.
 */
describe('applyInvoicePayment statement shape (postgres branch)', () => {
  const row = {
    ...existingInvoice,
    id: 'inv-1',
    status: 'sent',
    line_items: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 100 }],
    subtotal: '100.00',
    total: '100.00',
  }

  it('leaves line_items out of the update when nothing was appended', async () => {
    const fake = fakePostgres({ invoices: [row] })
    await postgresStore(fake).applyInvoicePayment('inv-1', {
      status: 'processing',
      checkoutSessionId: 'cs_ach_1',
    })

    const update = fake.matching(/^update invoices/i)[0]
    expect(update.text).not.toMatch(/line_items/)
    expect(update.text).toMatch(/stripe_card_session_id/)
  })

  it('writes the recomputed lines and totals when a fee was appended', async () => {
    const fake = fakePostgres({ invoices: [row] })
    await postgresStore(fake).applyInvoicePayment('inv-1', {
      status: 'paid',
      appendLines: [{ kind: 'card-fee', label: 'Card processing fee', detail: '', amount: 3.3 }],
    })

    const update = fake.matching(/^update invoices/i)[0]
    expect(update.text).toMatch(/line_items = \$9::jsonb/)
    expect(update.text).toMatch(/subtotal = \$10/)
    expect(update.text).toMatch(/total = \$11/)
    expect(JSON.parse(update.params[8])).toHaveLength(2)
    expect(update.params[9]).toBe(103.3)
    expect(update.params[10]).toBe(103.3)
  })

  it('surfaces the transition on this branch too', async () => {
    const fake = fakePostgres({ invoices: [row] })
    const updated = await postgresStore(fake).applyInvoicePayment('inv-1', { status: 'paid' })
    expect(updated.statusChanged).toBe(true)
  })
})

/**
 * Every field the Add-client form collects must survive `createClient` and come
 * back on the next read. Client creation moved off the debounced bulk save onto
 * `POST /api/clients`, and the first version of that endpoint inserted twelve
 * of the thirty-three columns `write()` writes â€” so the monthly/annual rate,
 * the estimated role hours, the invoice preferences and the entire team
 * selection were entered on the form and silently thrown away.
 *
 * File backend (cardinal rule 1: the Postgres branch is the one production
 * runs, and is validated separately against real data with a rolled-back
 * transaction â€” HANDOFF section 4). What this pins is the contract both
 * branches implement: nothing the form sends is dropped.
 */
describe('createClient keeps every field the Add-client form sends (file backend)', () => {
  // Exactly what the ClientBuilder onCreate call emits with every input filled
  // in. The monthly and annual fields are mutually exclusive on the form
  // itself, but the store must not drop either one.
  const formValues = {
    name: 'Northwind Traders',
    contact: 'Dana Reyes',
    billingMode: 'subscription',
    hourlyRate: 125,
    planIds: ['plan-1'],
    contactIds: ['contact-1'],
    monthlyRate: 900,
    annualRate: 4800,
    annualBillingMonth: 7,
    estimatedBookkeeperHours: 12.5,
    estimatedAccountantHours: 4,
    estimatedCfoHours: 1.5,
    paymentTerms: 'Net 15',
    footerNote: 'Thanks for your business.',
    invoiceShowTimeBreakdown: false,
    invoiceHideInternalHours: false,
    invoiceGroupByCategory: true,
    cardPaymentsEnabled: true,
    lifecycleStage: 'proposal',
    assignedEmployeeIds: ['emp-1'],
  }

  it('returns the created record with every field intact', async () => {
    const created = await store.createClient(formValues)
    expect(created).toMatchObject(formValues)
    expect(created.id).toMatch(/^client-/)
  })

  it('reads every field back after the create', async () => {
    const created = await store.createClient(formValues)
    const data = await store.read()
    const stored = data.clients.find((c) => c.id === created.id)
    expect(stored).toBeTruthy()
    expect(stored).toMatchObject(formValues)
  })

  it('does not coerce a chosen-false invoice preference back to true', async () => {
    const created = await store.createClient(formValues)
    const data = await store.read()
    const stored = data.clients.find((c) => c.id === created.id)
    expect(stored.invoiceShowTimeBreakdown).toBe(false)
    expect(stored.invoiceHideInternalHours).toBe(false)
    expect(stored.invoiceGroupByCategory).toBe(true)
    // Same rule for the card toggle: chosen-true must not read back as the
    // default false, or a client would silently lose the option she gave them.
    expect(stored.cardPaymentsEnabled).toBe(true)
  })

  it('keeps the team selection in the field that drives client visibility', async () => {
    const created = await store.createClient(formValues)
    const data = await store.read()
    const stored = data.clients.find((c) => c.id === created.id)
    // Both names, one value. `assignedBookkeeperIds` is what
    // `visibleClientIdSet` reads; `assignedEmployeeIds` is its alias.
    expect(stored.assignedBookkeeperIds).toEqual(['emp-1'])
    expect(stored.assignedEmployeeIds).toEqual(['emp-1'])
  })

  it('still refuses a nameless client', async () => {
    expect(await store.createClient({ ...formValues, name: '   ' })).toBeNull()
  })
})

/**
 * The same contract on the POSTGRES branch â€” and the branch that was actually
 * broken. The file backend spreads the whole incoming object onto the record,
 * so it never lost a field; the Postgres insert named its columns explicitly
 * and named only twelve of them, which is why the fields vanished in
 * production and nowhere else.
 *
 * Driven through a fake pool rather than a live database, so what it pins is
 * the statement `createClient` issues: every field the form sends reaches a
 * column.
 */
describe('createClient writes every form field to Postgres', () => {
  // Same payload as the file-backend suite above.
  const formValues = {
    name: 'Northwind Traders',
    contact: 'Dana Reyes',
    billingMode: 'subscription',
    hourlyRate: 125,
    planIds: ['plan-1'],
    contactIds: ['contact-1'],
    monthlyRate: 900,
    annualRate: 4800,
    annualBillingMonth: 7,
    estimatedBookkeeperHours: 12.5,
    estimatedAccountantHours: 4,
    estimatedCfoHours: 1.5,
    paymentTerms: 'Net 15',
    footerNote: 'Thanks for your business.',
    invoiceShowTimeBreakdown: false,
    invoiceHideInternalHours: false,
    invoiceGroupByCategory: true,
    cardPaymentsEnabled: true,
    lifecycleStage: 'proposal',
    assignedEmployeeIds: ['emp-1'],
  }

  // Zip the statement's column list against its bound parameters, so a test can
  // assert per COLUMN instead of by positional index. `updated_at` is last in
  // the column list and is `now()` rather than a parameter, so it simply falls
  // off the end of the shorter params array.
  const boundColumns = (statement) => {
    const match = /insert into clients\s*\(([\s\S]*?)\)\s*values/i.exec(statement.text)
    const columns = match[1].split(',').map((column) => column.trim())
    const bound = {}
    statement.params.forEach((value, index) => {
      bound[columns[index]] = value
    })
    return bound
  }

  it('binds every column the form fills', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient(formValues)

    const inserts = fake.matching(/^insert into clients/i)
    expect(inserts).toHaveLength(1)
    expect(boundColumns(inserts[0])).toMatchObject({
      name: 'Northwind Traders',
      contact: 'Dana Reyes',
      billing_mode: 'subscription',
      hourly_rate: 125,
      plan_ids: ['plan-1'],
      contact_ids: ['contact-1'],
      monthly_rate: 900,
      annual_rate: 4800,
      annual_billing_month: 7,
      estimated_bookkeeper_hours: 12.5,
      estimated_accountant_hours: 4,
      estimated_cfo_hours: 1.5,
      payment_terms: 'Net 15',
      footer_note: 'Thanks for your business.',
      invoice_show_time_breakdown: false,
      invoice_hide_internal_hours: false,
      invoice_group_by_category: true,
      card_payments_enabled: true,
      lifecycle_stage: 'proposal',
    })
  })

  it('does not touch client_assignments — the team lives on the client row', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient(formValues)

    expect(fake.matching(/client_assignments/i)).toEqual([])
  })

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

  it('leaves an unfilled optional column null rather than 0', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient({ name: 'Bare Co', contact: 'Someone' })

    const bound = boundColumns(fake.matching(/^insert into clients/i)[0])
    expect(bound.monthly_rate).toBeNull()
    expect(bound.annual_rate).toBeNull()
    expect(bound.annual_billing_month).toBeNull()
    expect(bound.estimated_bookkeeper_hours).toBeNull()
    expect(bound.lifecycle_stage).toBe('active')
  })

  it('refuses an unsafe pay URL instead of persisting it', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient({
      name: 'Sketchy Co',
      contact: 'Someone',
      quickbooksPayUrl: 'javascript:alert(1)',
    })

    expect(boundColumns(fake.matching(/^insert into clients/i)[0]).quickbooks_pay_url).toBe('')
  })
})

/**
 * `setChecklistTemplateActive` — the write behind the assistant's one Tier 0
 * config action ("turn a switched-off recurring checklist back on"). A
 * switched-off recipe is one of the two historical causes of "my recurring
 * checklist stopped appearing", and the materializer skips it silently.
 *
 * Cardinal rule 1: both backends. The file branch is exercised end-to-end
 * below; the Postgres branch is pinned by the statement it emits.
 */
const templateWorkspace = () =>
  workspace({
    checklistTemplates: [
      {
        id: 'tmpl-off',
        title: 'Annual Reports',
        clientId: 'c1',
        assigneeId: 'emp-1',
        frequency: 'annually',
        nextDueDate: '2026-12-01',
        active: false,
        viewerIds: [],
        editorIds: [],
        stages: [
          {
            id: 'stage-1',
            name: 'Stage 1',
            assigneeId: 'emp-1',
            offsetDays: 0,
            viewerIds: [],
            editorIds: [],
            items: [{ id: 'ti-1', label: 'File the report' }],
          },
        ],
      },
    ],
  })

describe('setChecklistTemplateActive (file backend)', () => {
  beforeEach(async () => {
    await store.write(templateWorkspace())
  })

  it('switches a recurring checklist back on and persists it', async () => {
    const updated = await store.setChecklistTemplateActive('tmpl-off', true)
    expect(updated).toMatchObject({ id: 'tmpl-off', active: true })

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(persisted.checklistTemplates[0].active).toBe(true)
  })

  it('switches one back off again — the change is reversible', async () => {
    await store.setChecklistTemplateActive('tmpl-off', true)
    await store.setChecklistTemplateActive('tmpl-off', false)

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(persisted.checklistTemplates[0].active).toBe(false)
  })

  it('returns null for an unknown id without touching the file', async () => {
    const before = await readFile(localDataPath, 'utf8')
    expect(await store.setChecklistTemplateActive('tmpl-nope', true)).toBeNull()
    expect(await readFile(localDataPath, 'utf8')).toBe(before)
  })
})

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

/**
 * `setClientAssignedTeam` — the Postgres branch specifically. This is the one
 * behavior change in the batch that lives ONLY in Postgres: the id-validation
 * query used to be `select id from users where role <> 'owner'`; it is now the
 * bare `select id from users`, so an explicitly picked owner survives.
 *
 * The file backend can't regress this — it validates against the local
 * `employees` array, which was never role-filtered — so only a statement-level
 * Postgres test catches a reintroduced filter. If it regressed, the id-validation
 * query would come back empty, `safe` would become `[]`, and the update would
 * wipe the client's team, silently revoking visibility for every assigned
 * non-owner.
 */
describe('setClientAssignedTeam (postgres branch)', () => {
  const userRows = [{ id: 'emp-1' }, { id: 'owner-1' }]

  it('keeps an explicitly picked owner in the bound params', async () => {
    const fake = fakePostgres({ userRows })
    await postgresStore(fake).setClientAssignedTeam('c1', ['emp-1', 'owner-1'])

    const updates = fake.matching(/^update clients set assigned_bookkeeper_ids/i)
    expect(updates).toHaveLength(1)
    expect(updates[0].params).toEqual(['c1', ['emp-1', 'owner-1']])
  })

  it('still drops an id that belongs to nobody', async () => {
    const fake = fakePostgres({ userRows })
    await postgresStore(fake).setClientAssignedTeam('c1', ['emp-1', 'ghost-9'])

    const updates = fake.matching(/^update clients set assigned_bookkeeper_ids/i)
    expect(updates[0].params).toEqual(['c1', ['emp-1']])
  })
})

describe('setChecklistTemplateActive (postgres branch)', () => {
  it('updates the single row instead of rewriting the workspace', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).setChecklistTemplateActive('tmpl-off', true)

    const updates = fake.matching(/^update checklist_templates\s+set active/i)
    expect(updates).toHaveLength(1)
    expect(updates[0].params).toEqual(['tmpl-off', true])
    // A one-flag fix must never take the bulk-save path.
    expect(fake.matching(/^delete from clients/i)).toHaveLength(0)
  })

  it('coerces a truthy/falsy flag to a real boolean for the column', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).setChecklistTemplateActive('tmpl-off', 0)
    expect(fake.matching(/^update checklist_templates\s+set active/i)[0].params).toEqual([
      'tmpl-off',
      false,
    ])
  })
})

/**
 * `adjustSplitGroup` — re-dividing a split that already exists.
 *
 * Splitting used to be one-way: once time was divided the amounts were frozen,
 * and the only way to change them was to delete every slice and retype the
 * time. That is the firm owner's "still will not let me adjust my time entry
 * without losing the client split I chose".
 *
 * What this pins:
 *   - the group is replaced wholesale and keeps its SAME group id, so the raw
 *     data still shows one split rather than a trail of abandoned ones;
 *   - the block's `sessions` and envelope survive the adjustment — re-dividing
 *     the billing never rewrites what the timer recorded;
 *   - the total is ALLOWED to change (an adjustment is a correction), and going
 *     down to a single client is allowed too, unlike creating a split;
 *   - the new slices re-enter the approval queue as pending;
 *   - a refused adjustment (unknown group / nothing allocated) writes NOTHING.
 */
describe('adjustSplitGroup (file backend)', () => {
  const SESSIONS = [
    { startAt: '2026-07-03T13:00:00.000Z', endAt: '2026-07-03T13:40:00.000Z' },
    { startAt: '2026-07-03T14:00:00.000Z', endAt: '2026-07-03T14:20:00.000Z' },
  ]

  const slice = (id, clientId, minutes, overrides = {}) => ({
    id,
    employeeId: 'emp-1',
    clientId,
    isAdministrative: false,
    date: '2026-07-03',
    minutes,
    category: 'General',
    description: 'Payroll cleanup',
    billable: true,
    taskId: null,
    approvalStatus: 'approved',
    entryMethod: 'timer',
    startAt: SESSIONS[0].startAt,
    endAt: SESSIONS[1].endAt,
    sessions: SESSIONS,
    groupId: 'grp-live',
    groupClientIds: [],
    groupAllocation: 'custom',
    taskLabel: 'Payroll',
    ...overrides,
  })

  const seedGroup = async (slices, extraEntries = []) => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
          { id: 'c3', name: 'Initech' },
        ],
        timeEntries: [...slices, ...extraEntries],
      }),
    )
  }

  const persisted = async () => JSON.parse(await readFile(localDataPath, 'utf8'))
  const grouped = async () =>
    (await persisted()).timeEntries.filter((entry) => entry.groupId === 'grp-live')

  it('replaces the whole group with the new distribution, under the same group id', async () => {
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)])

    const result = await store.adjustSplitGroup(
      'grp-live',
      [
        { clientId: 'c1', minutes: 45 },
        { clientId: 'c2', minutes: 15 },
      ],
      'owner-1',
      'custom',
    )

    expect(result.deletedIds.sort()).toEqual(['s1', 's2'])
    expect(result.groupId).toBe('grp-live')
    const rows = await grouped()
    expect(rows).toHaveLength(2)
    // Same group id — the split stays ONE group in the raw data.
    expect(rows.every((row) => row.groupId === 'grp-live')).toBe(true)
    expect(rows.every((row) => row.groupAllocation === 'custom')).toBe(true)
    expect(
      Object.fromEntries(rows.map((row) => [row.clientId, row.minutes])),
    ).toEqual({ c1: 45, c2: 15 })
    // The old rows are gone, not left behind double-counting.
    expect((await persisted()).timeEntries.some((row) => row.id === 's1')).toBe(false)
  })

  it('carries the sessions, envelope and description across untouched', async () => {
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)])

    const { created } = await store.adjustSplitGroup(
      'grp-live',
      [
        { clientId: 'c1', minutes: 20 },
        { clientId: 'c3', minutes: 40 },
      ],
      'owner-1',
      'custom',
    )

    for (const row of created) {
      // The point of the group: the original clock-in/out is the audit trail
      // and an adjustment must not rewrite it.
      expect(row.sessions).toEqual(SESSIONS)
      expect(row.startAt).toBe(SESSIONS[0].startAt)
      expect(row.endAt).toBe(SESSIONS[1].endAt)
      expect(row.description).toBe('Payroll cleanup')
      expect(row.date).toBe('2026-07-03')
      expect(row.employeeId).toBe('emp-1')
      expect(row.entryMethod).toBe('timer')
      expect(row.taskLabel).toBe('Payroll')
      expect(row.billable).toBe(true)
      expect(row.isAdministrative).toBe(false)
      // Copied, not shared — editing one slice can't corrupt a sibling.
      expect(row.sessions).not.toBe(SESSIONS)
    }
    expect(created.map((row) => row.clientId)).toEqual(['c1', 'c3'])
  })

  it('lets the TOTAL change — an adjustment is a correction, not a re-division', async () => {
    await seedGroup([slice('s1', 'c1', 20), slice('s2', 'c2', 20), slice('s3', 'c3', 20)])

    await store.adjustSplitGroup(
      'grp-live',
      [
        { clientId: 'c1', minutes: 15 },
        { clientId: 'c2', minutes: 15 },
      ],
      'owner-1',
      'even',
    )

    const rows = await grouped()
    expect(rows.reduce((sum, row) => sum + row.minutes, 0)).toBe(30)
    // The sessions still say 60 minutes were worked — that record is untouched.
    expect(rows[0].sessions).toEqual(SESSIONS)
  })

  it('adjusts down to ONE client — pulling a client back out of a split', async () => {
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)])

    const { created } = await store.adjustSplitGroup(
      'grp-live',
      [{ clientId: 'c1', minutes: 60 }],
      'owner-1',
      'custom',
    )

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ clientId: 'c1', minutes: 60, groupId: 'grp-live' })
    expect(await grouped()).toHaveLength(1)
  })

  it('sends every adjusted slice back through approval', async () => {
    // Seeded APPROVED — an edit to approved time has to be re-approved rather
    // than keep its old sign-off, and an adjustment is an edit.
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)])

    const { created } = await store.adjustSplitGroup(
      'grp-live',
      [
        { clientId: 'c1', minutes: 25 },
        { clientId: 'c2', minutes: 35 },
      ],
      'owner-1',
      'custom',
    )
    expect(created.every((row) => row.approvalStatus === 'pending')).toBe(true)
  })

  it('leaves every OTHER entry alone', async () => {
    const other = slice('other-1', 'c3', 10, { id: 'other-1', groupId: undefined })
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)], [other])

    await store.adjustSplitGroup('grp-live', [{ clientId: 'c1', minutes: 60 }], 'owner-1', 'custom')

    const untouched = (await persisted()).timeEntries.find((row) => row.id === 'other-1')
    expect(untouched).toMatchObject({ clientId: 'c3', minutes: 10 })
  })

  it('records the adjustment in the activity log, old total → new total', async () => {
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)])
    // The activity log lives in its own file and is NOT reset between tests, so
    // measure the delta rather than the absolute count.
    const adjustRows = async () => {
      if (!existsSync(localAuthPath)) return []
      const auth = JSON.parse(await readFile(localAuthPath, 'utf8'))
      return (auth.activityLog ?? []).filter((row) => row.action === 'time_entry_split_adjusted')
    }
    const before = await adjustRows()

    await store.adjustSplitGroup(
      'grp-live',
      [
        { clientId: 'c1', minutes: 45 },
        { clientId: 'c2', minutes: 45 },
      ],
      'owner-1',
      'full',
    )

    const after = await adjustRows()
    expect(after).toHaveLength(before.length + 1)
    const logged = after[after.length - 1]
    expect(logged.userId).toBe('owner-1')
    expect(logged.target).toContain('Payroll cleanup')
    expect(logged.target).toContain('2 clients')
    expect(logged.target).toContain('1h → 1.5h')
  })

  it('fails cleanly on an unknown group and writes NOTHING', async () => {
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)])
    const before = await persisted()

    await expect(
      store.adjustSplitGroup('grp-gone', [{ clientId: 'c1', minutes: 30 }], 'owner-1', 'custom'),
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(await persisted()).toEqual(before)
  })

  it('refuses an empty allocation and writes NOTHING', async () => {
    await seedGroup([slice('s1', 'c1', 30), slice('s2', 'c2', 30)])
    const before = await persisted()

    await expect(
      store.adjustSplitGroup('grp-live', [], 'owner-1', 'custom'),
    ).rejects.toMatchObject({ code: 'invalid_allocation' })
    await expect(
      store.adjustSplitGroup('grp-live', [{ clientId: 'c1', minutes: 0 }], 'owner-1', 'custom'),
    ).rejects.toMatchObject({ code: 'invalid_allocation' })

    expect(await persisted()).toEqual(before)
  })
})

/**
 * The Postgres branch of the same call. Cardinal rule 1: both backends have to
 * implement the contract, and production is Postgres — so pin the statements
 * this branch issues (one delete of the whole group, one insert per new slice
 * carrying the SAME group id, and the audit row) rather than trusting that the
 * file-backend suite above covers it.
 */
describe('adjustSplitGroup (postgres branch)', () => {
  const row = (id, clientId, minutes) => ({
    id,
    user_id: 'emp-1',
    client_id: clientId,
    entry_date: new Date('2026-07-03T00:00:00.000Z'),
    minutes,
    category: 'General',
    description: 'Payroll cleanup',
    billable: true,
    entry_method: 'timer',
    manual_reason: null,
    started_at: new Date('2026-07-03T13:00:00.000Z'),
    ended_at: new Date('2026-07-03T14:00:00.000Z'),
    sessions: [{ startAt: '2026-07-03T13:00:00.000Z', endAt: '2026-07-03T14:00:00.000Z' }],
    task_label: 'Payroll',
  })

  it('deletes the group once and re-inserts it under the same group id', async () => {
    const fake = fakePostgres({ groupSlices: [row('s1', 'c1', 30), row('s2', 'c2', 30)] })
    const result = await postgresStore(fake).adjustSplitGroup(
      'grp-live',
      [
        { clientId: 'c1', minutes: 45 },
        { clientId: 'c3', minutes: 15 },
      ],
      'owner-1',
      'custom',
    )

    expect(fake.matching(/^select\b[\s\S]*for update$/i)).toHaveLength(1)
    const deletes = fake.matching(/^delete from time_entries where group_id/i)
    expect(deletes).toHaveLength(1)
    expect(deletes[0].params).toEqual(['grp-live'])

    const inserts = fake.matching(/^insert into time_entries/i)
    expect(inserts).toHaveLength(2)
    // group_id ($18) is the same one, and it is set on every new slice.
    expect(inserts.map((statement) => statement.params[17])).toEqual(['grp-live', 'grp-live'])
    expect(inserts.map((statement) => statement.params[2])).toEqual(['c1', 'c3'])
    expect(inserts.map((statement) => statement.params[4])).toEqual([45, 15])
    // approval_status ($10): back in the queue.
    expect(inserts.map((statement) => statement.params[9])).toEqual(['pending', 'pending'])
    // sessions ($17) carried across verbatim as JSON.
    expect(JSON.parse(inserts[0].params[16])).toEqual(row('s1', 'c1', 30).sessions)

    const audit = fake.matching(/^insert into activity_log/i)
    expect(audit).toHaveLength(1)
    expect(audit[0].params[2]).toBe('time_entry_split_adjusted')
    expect(audit[0].params[3]).toContain('1h → 1h')
    expect(fake.matching(/^commit$/i)).toHaveLength(1)
    expect(result.deletedIds).toEqual(['s1', 's2'])
  })

  it('rolls back and reports not_found when the group is gone', async () => {
    const fake = fakePostgres({ groupSlices: [] })
    await expect(
      postgresStore(fake).adjustSplitGroup(
        'grp-gone',
        [{ clientId: 'c1', minutes: 30 }],
        'owner-1',
        'custom',
      ),
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(fake.matching(/^rollback$/i)).toHaveLength(1)
    expect(fake.matching(/^insert into time_entries/i)).toHaveLength(0)
    expect(fake.matching(/^commit$/i)).toHaveLength(0)
  })
})

/**
 * `recordInvoiceSent` — the append-only send log behind I4 (emailing an
 * invoice).
 *
 * Invoices sit deliberately outside the workspace bulk save, so they are seeded
 * straight into the file the store reads rather than through `write()`.
 *
 * File backend (cardinal rule 1: Postgres is the branch production runs, and is
 * validated separately against real data with a rolled-back transaction —
 * HANDOFF section 4). What this pins is the contract both branches implement: a
 * failed attempt is kept but never claims the invoice was sent, `sentAt` holds
 * the FIRST send because that is when the payment clock started, and the entry
 * records what was billed at the time.
 */
describe('recordInvoiceSent (file backend)', () => {
  const seedInvoice = {
    id: 'inv-1',
    clientId: 'c1',
    period: '2026-08',
    number: '1042',
    status: 'reviewed',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: '2026-09-15',
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }

  async function seed(overrides = {}) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [{ ...seedInvoice, ...overrides }]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  it('logs a failed attempt without claiming the invoice was sent', async () => {
    await seed()
    const updated = await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Invoice 1042',
      ok: false,
      error: 'The domain is not verified.',
    })

    expect(updated.emailLog).toHaveLength(1)
    expect(updated.emailLog[0]).toMatchObject({
      ok: false,
      error: 'The domain is not verified.',
      to: ['ann@acme.com'],
    })
    // The two fields that would tell Brittany a failed send succeeded.
    expect(updated.sentAt).toBeNull()
    expect(updated.status).toBe('reviewed')
  })

  it('keeps every attempt and flips the status on a successful send', async () => {
    await seed()
    await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Invoice 1042',
      ok: true,
    })
    const second = await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com', 'ap@acme.com'],
      subject: 'Invoice 1042',
      ok: true,
    })

    expect(second.emailLog).toHaveLength(2)
    expect(second.status).toBe('sent')
    expect(second.sentAt).toBe(second.emailLog[0].at)
    expect(second.emailLog[1].to).toEqual(['ann@acme.com', 'ap@acme.com'])
  })

  it('leaves an earlier sentAt alone on a re-send', async () => {
    // Seeded rather than sent twice in a row: two sends in the same millisecond
    // would make "kept the first" true by accident.
    await seed({
      status: 'sent',
      sentAt: '2026-08-09T12:00:00.000Z',
      emailLog: [
        { at: '2026-08-09T12:00:00.000Z', to: ['ann@acme.com'], subject: 'Invoice 1042', ok: true, total: 400 },
      ],
    })
    const updated = await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Invoice 1042',
      ok: true,
    })

    expect(updated.sentAt).toBe('2026-08-09T12:00:00.000Z')
    expect(updated.emailLog).toHaveLength(2)
  })

  it('records what was billed, so a later edit cannot rewrite what went out', async () => {
    await seed()
    await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Invoice 1042',
      ok: true,
    })

    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    const stored = data.invoices.find((entry) => entry.id === 'inv-1')
    expect(stored.emailLog[0].total).toBe(400)
  })

  /**
   * The payment-side emails ride the SAME append-only log, tagged with a
   * `kind`. That tag is what stops a webhook retry sending a second receipt —
   * and what stops a receipt being mistaken for the invoice going out.
   */
  it('tags a payment email and leaves sentAt and the status alone', async () => {
    await seed({ status: 'processing', sentAt: '2026-08-09T12:00:00.000Z' })
    const updated = await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Receipt for invoice 1042',
      ok: true,
      kind: 'receipt',
    })

    expect(updated.emailLog[0].kind).toBe('receipt')
    expect(updated.emailLog[0].ok).toBe(true)
    expect(updated.status).toBe('processing')
    expect(updated.sentAt).toBe('2026-08-09T12:00:00.000Z')
  })

  // A receipt must never be the thing that starts the payment clock.
  it('does not stamp sentAt on an invoice that never actually went out', async () => {
    await seed()
    const updated = await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Payment received',
      ok: true,
      kind: 'ack',
    })

    expect(updated.emailLog).toHaveLength(1)
    expect(updated.sentAt).toBeNull()
    expect(updated.status).toBe('reviewed')
  })

  it('leaves an ordinary invoice send untagged, exactly as before', async () => {
    await seed()
    const updated = await store.recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Invoice 1042',
      ok: true,
    })

    expect(updated.emailLog[0]).not.toHaveProperty('kind')
    expect(updated.status).toBe('sent')
  })
})

/**
 * The Postgres statement behind the same contract. No NEW shape: the payment
 * emails reuse the existing `email_log` append verbatim, and the only thing
 * that changes is the boolean deciding whether this entry marks the invoice
 * sent — false for anything with a kind.
 */
describe('recordInvoiceSent statement shape (postgres branch)', () => {
  it('reuses the email_log append and refuses to call a receipt a send', async () => {
    const fake = fakePostgres({ invoices: [{ ...existingInvoice, status: 'processing' }] })
    await postgresStore(fake).recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Receipt for invoice INV-2026-08-001',
      ok: true,
      kind: 'receipt',
    })

    const update = fake.matching(/^update invoices/i)[0]
    expect(update.text).toMatch(/email_log = coalesce\(email_log, '\[\]'::jsonb\) \|\| \$2::jsonb/)
    expect(JSON.parse(update.params[1])[0]).toMatchObject({ kind: 'receipt', ok: true })
    // $3 is "this marks the invoice sent" — false for a payment email.
    expect(update.params[2]).toBe(false)
  })

  it('still marks a real invoice send as sent', async () => {
    const fake = fakePostgres({ invoices: [existingInvoice] })
    await postgresStore(fake).recordInvoiceSent('inv-1', {
      to: ['ann@acme.com'],
      subject: 'Invoice INV-2026-08-001',
      ok: true,
    })

    const update = fake.matching(/^update invoices/i)[0]
    expect(update.params[2]).toBe(true)
    expect(JSON.parse(update.params[1])[0]).not.toHaveProperty('kind')
  })
})

/**
 * Column parity between the invoice SELECT and the row mapper.
 *
 * This is the Postgres guard for the whole invoice read path, and it has to be
 * one, because nothing else can be: every test in this file runs the FILE
 * backend, and the file backend returns whatever it stored — it cannot notice a
 * missing column. The Postgres branch can, silently. `email_log` was left out
 * of the select for the life of the feature, so `mapInvoiceRow` read
 * `row.email_log` as `undefined`, mapped it to `[]`, and production served an
 * empty send log that the UI faithfully rendered as "never sent" while
 * `recordInvoiceSent` rebuilt the log from it and threw the earlier sends away.
 *
 * A missing column has no error to catch; the only thing to test is that the
 * two lists agree. The mapper is handed a recording Proxy so the check is on
 * what it actually reads rather than on a copy of the list that would drift.
 */
describe('listInvoices selects every column mapInvoiceRow reads', () => {
  it('has no column the mapper reads but the select omits', () => {
    const readColumns = new Set()
    mapInvoiceRow(
      new Proxy(
        {},
        {
          get(_target, key) {
            if (typeof key === 'string') readColumns.add(key)
            return undefined
          },
        },
      ),
    )

    const selected = new Set(
      INVOICE_SELECT_COLUMNS.split(',')
        .map((column) => column.trim())
        .filter(Boolean),
    )

    // Sanity: a mapper that read nothing would pass the real assertion.
    expect(readColumns.size).toBeGreaterThan(10)
    expect([...readColumns].filter((column) => !selected.has(column))).toEqual([])
    // Named outright, because this is the one that got out.
    expect(selected.has('email_log')).toBe(true)
  })
})

/**
 * The void guard on the two invoice WRITERS.
 *
 * "Void & regenerate" made a race real that used to be unreachable: a send or a
 * Stripe webhook can already be in the air when the invoice it names is voided.
 * Letting that late write land would flip a void row back to sent/paid — which
 * on Postgres collides with the live-per-(client, period) partial index (a 500
 * raised AFTER the email has gone out, taking the send log with it) and on the
 * file backend silently leaves the client with two live invoices for one month.
 *
 * Both writers therefore refuse a void row outright and change nothing.
 */
describe('invoice writers refuse a voided invoice (file backend)', () => {
  const voidInvoice = {
    id: 'inv-void',
    clientId: 'c1',
    period: '2026-08',
    number: 'INV-2026-08-001',
    status: 'void',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: '2026-09-15',
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }

  beforeEach(async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [{ ...voidInvoice }]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  })

  async function storedVoidInvoice() {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.invoices.find((entry) => entry.id === 'inv-void')
  }

  it('recordInvoiceSent leaves it void and writes nothing', async () => {
    const result = await store.recordInvoiceSent('inv-void', {
      to: ['ann@acme.com'],
      subject: 'Invoice INV-2026-08-001',
      ok: true,
    })

    expect(result).toBeNull()
    const stored = await storedVoidInvoice()
    expect(stored.status).toBe('void')
    expect(stored.sentAt).toBeNull()
    expect(stored.emailLog).toBeUndefined()
    expect(stored.updatedAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('applyInvoicePayment leaves it void and writes nothing', async () => {
    const result = await store.applyInvoicePayment('inv-void', {
      status: 'paid',
      paymentIntentId: 'pi_123',
      paidAt: '2026-08-20T00:00:00.000Z',
    })

    expect(result).toBeNull()
    const stored = await storedVoidInvoice()
    expect(stored.status).toBe('void')
    expect(stored.paidAt).toBeNull()
    expect(stored.stripePaymentIntentId).toBeUndefined()
    expect(stored.updatedAt).toBe('2026-08-01T00:00:00.000Z')
  })
})

/**
 * `voidUnsentInvoicesForPeriod` — the voiding half of "Void & regenerate".
 *
 * The one thing this must never do is touch an invoice the client has already
 * seen. Everything else about the feature is recoverable (press Generate
 * again); rewriting a sent or paid invoice is not, so each protected status
 * gets its own row here rather than a single representative one.
 *
 * File backend, same reasoning as the block above: Postgres is what production
 * runs and is validated separately with a rolled-back transaction (HANDOFF §4);
 * what is pinned here is the contract both branches implement.
 */
describe('voidUnsentInvoicesForPeriod (file backend)', () => {
  function invoice(id, overrides = {}) {
    return {
      id,
      clientId: `c-${id}`,
      period: '2026-08',
      number: id,
      status: 'draft',
      lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
      subtotal: 400,
      total: 400,
      dueDate: '2026-09-15',
      blurb: '',
      scopeFlags: [],
      sentAt: null,
      paidAt: null,
      paymentMethod: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    }
  }

  async function seedInvoices(rows) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = rows
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  async function storedStatuses() {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return Object.fromEntries(data.invoices.map((entry) => [entry.id, entry.status]))
  }

  it('voids the drafts and the reviewed invoices, and counts them', async () => {
    await seedInvoices([
      invoice('a', { status: 'draft' }),
      invoice('b', { status: 'reviewed' }),
      invoice('c', { status: 'draft' }),
    ])

    const result = await store.voidUnsentInvoicesForPeriod('2026-08')

    expect(result.voided).toBe(3)
    expect(result.ids.sort()).toEqual(['a', 'b', 'c'])
    expect(await storedStatuses()).toEqual({ a: 'void', b: 'void', c: 'void' })
  })

  it('never touches an invoice that has left the building', async () => {
    await seedInvoices([
      invoice('sent', { status: 'sent', sentAt: '2026-08-05T00:00:00.000Z' }),
      invoice('processing', { status: 'processing' }),
      invoice('paid', { status: 'paid', paidAt: '2026-08-06T00:00:00.000Z' }),
      invoice('overdue', { status: 'overdue' }),
      invoice('void', { status: 'void' }),
      invoice('draft', { status: 'draft' }),
    ])

    const result = await store.voidUnsentInvoicesForPeriod('2026-08')

    // Only the draft moved; the already-void row is not re-voided or counted.
    expect(result.voided).toBe(1)
    expect(result.ids).toEqual(['draft'])
    expect(await storedStatuses()).toEqual({
      sent: 'sent',
      processing: 'processing',
      paid: 'paid',
      overdue: 'overdue',
      void: 'void',
      draft: 'void',
    })
  })

  it('leaves every other month alone', async () => {
    await seedInvoices([
      invoice('july', { period: '2026-07', status: 'draft' }),
      invoice('august', { period: '2026-08', status: 'reviewed' }),
      invoice('september', { period: '2026-09', status: 'draft' }),
    ])

    const result = await store.voidUnsentInvoicesForPeriod('2026-08')

    expect(result.voided).toBe(1)
    expect(await storedStatuses()).toEqual({
      july: 'draft',
      august: 'void',
      september: 'draft',
    })
  })

  it('reports nothing voided for a month with no unsent invoices', async () => {
    await seedInvoices([invoice('sent', { status: 'sent' })])
    expect(await store.voidUnsentInvoicesForPeriod('2026-08')).toEqual({ voided: 0, ids: [] })
  })
})

/**
 * Single-client generation — `generateInvoicesForPeriod(period, { clientId })`,
 * behind the per-client "Email invoice" button offering to build the one
 * invoice that is missing.
 *
 * The point of the scope is blast radius: a click on one client's header must
 * not quietly create invoices for everyone else. The idempotence check is the
 * same rule the month run relies on — a second run must not rewrite a draft
 * that has already been edited.
 */
describe('generateInvoicesForPeriod with a single client (file backend)', () => {
  const period = '2026-08'

  async function seedBillableWorkspace() {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 },
          { id: 'c2', name: 'Globex', billingMode: 'hourly', hourlyRate: 100 },
          { id: 'c3', name: 'Initech', billingMode: 'hourly', hourlyRate: 100 },
        ],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [
          {
            id: 't1',
            clientId: 'c1',
            employeeId: 'emp-1',
            date: `${period}-04`,
            minutes: 120,
            billable: true,
          },
          {
            id: 't2',
            clientId: 'c2',
            employeeId: 'emp-1',
            date: `${period}-05`,
            minutes: 60,
            billable: true,
          },
        ],
      }),
    )
    // Invoices live outside the bulk save, so start the period genuinely empty.
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  it('creates that client’s invoice and nobody else’s', async () => {
    await seedBillableWorkspace()

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    expect(result.created).toHaveLength(1)
    expect(result.created[0].clientId).toBe('c1')
    // c2 also has billable time this month and must still have no invoice.
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(data.invoices.map((entry) => entry.clientId)).toEqual(['c1'])
  })

  it('is idempotent — a second run skips rather than rewriting', async () => {
    await seedBillableWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    const second = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    expect(second.created).toHaveLength(0)
    expect(second.skipped).toEqual([{ clientId: 'c1', reason: 'already-generated' }])
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(data.invoices).toHaveLength(1)
  })

  it('says why when the client has nothing to bill', async () => {
    await seedBillableWorkspace()

    // c3 has no time, no plan and no reimbursements this month.
    const result = await store.generateInvoicesForPeriod(period, { clientId: 'c3' })

    expect(result.created).toHaveLength(0)
    expect(result.skipped).toEqual([{ clientId: 'c3', reason: 'nothing-to-bill' }])
  })

  it('reports the existing invoice, not the lifecycle, when both apply', async () => {
    await seedBillableWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    // c1 is then moved back to prospect — the invoice it already has is still
    // the more useful answer than "not billable yet".
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.clients.find((entry) => entry.id === 'c1').lifecycleStage = 'proposal'
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    expect(result.skipped).toEqual([{ clientId: 'c1', reason: 'already-generated' }])
  })

  it('says why when the client is not on file at all', async () => {
    await seedBillableWorkspace()
    const result = await store.generateInvoicesForPeriod(period, { clientId: 'ghost' })
    expect(result.created).toHaveLength(0)
    expect(result.skipped).toEqual([{ clientId: 'ghost', reason: 'no-such-client' }])
  })

  it('still builds every billable client when no clientId is given', async () => {
    await seedBillableWorkspace()

    const result = await store.generateInvoicesForPeriod(period)

    expect(result.created.map((entry) => entry.clientId).sort()).toEqual(['c1', 'c2'])
    // The month run passes prospects over in silence; only c3 (nothing to bill)
    // is worth a reason.
    expect(result.skipped).toEqual([{ clientId: 'c3', reason: 'nothing-to-bill' }])
  })

  /** Retire a seeded client without disturbing anything else about them. */
  async function retire(clientId) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.clients.find((entry) => entry.id === clientId).lifecycleStage = 'inactive'
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  it('skips a retired client on the month run, even with billable time', async () => {
    await seedBillableWorkspace()
    await retire('c1')

    const result = await store.generateInvoicesForPeriod(period)

    // c1 has two hours of billable time and would otherwise have invoiced.
    expect(result.created.map((entry) => entry.clientId)).toEqual(['c2'])
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(data.invoices.map((entry) => entry.clientId)).toEqual(['c2'])
  })

  it('names the retirement, not "not billable yet", when asked for that client', async () => {
    await seedBillableWorkspace()
    await retire('c1')

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    expect(result.created).toHaveLength(0)
    expect(result.skipped).toEqual([{ clientId: 'c1', reason: 'client-inactive' }])
  })

  it('leaves a retired client’s existing invoices untouched', async () => {
    await seedBillableWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const before = JSON.parse(await readFile(localDataPath, 'utf8')).invoices
    await retire('c1')

    await store.generateInvoicesForPeriod(period)

    const after = JSON.parse(await readFile(localDataPath, 'utf8')).invoices
    expect(after.filter((entry) => entry.clientId === 'c1')).toEqual(
      before.filter((entry) => entry.clientId === 'c1'),
    )
  })

  it('invoices the client again once they are reactivated', async () => {
    await seedBillableWorkspace()
    await retire('c1')
    expect(await store.generateInvoicesForPeriod(period, { clientId: 'c1' })).toMatchObject({
      created: [],
    })

    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.clients.find((entry) => entry.id === 'c1').lifecycleStage = 'active'
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    expect(result.created).toHaveLength(1)
    expect(result.created[0].clientId).toBe('c1')
  })
})

/**
 * Stage validation. `lifecycle_stage` decides whether a client appears in ANY
 * picker in the app, so a value neither backend recognizes is a client who
 * silently disappears — or a retirement that silently undoes itself on the
 * next save. One `coerceLifecycleStage` guards all three write paths.
 */
describe('lifecycle stage validation (file backend)', () => {
  it('accepts all four real stages through a bulk save', async () => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Prospect', billingMode: 'hourly', lifecycleStage: 'proposal' },
          { id: 'c2', name: 'Starting', billingMode: 'hourly', lifecycleStage: 'onboarding' },
          { id: 'c3', name: 'Working', billingMode: 'hourly', lifecycleStage: 'active' },
          { id: 'c4', name: 'Former', billingMode: 'hourly', lifecycleStage: 'inactive' },
        ],
      }),
    )

    const data = await store.read()
    expect(data.clients.map((entry) => entry.lifecycleStage)).toEqual([
      'proposal',
      'onboarding',
      'active',
      'inactive',
    ])
  })

  it('clamps a garbage stage to active rather than hiding the client', async () => {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme', billingMode: 'hourly', lifecycleStage: 'retired' },
          { id: 'c2', name: 'Globex', billingMode: 'hourly', lifecycleStage: null },
        ],
      }),
    )

    const data = await store.read()
    expect(data.clients.map((entry) => entry.lifecycleStage)).toEqual(['active', 'active'])
  })

  it('leaves a client with no stage field alone — absent already reads as active', async () => {
    await store.write(
      workspace({ clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly' }] }),
    )

    const data = await store.read()
    expect(data.clients[0].lifecycleStage).toBeUndefined()
  })

  it('setClientLifecycleStage retires and reactivates, touching nothing else', async () => {
    await store.write(
      workspace({
        clients: [
          {
            id: 'c1',
            name: 'Acme',
            billingMode: 'hourly',
            hourlyRate: 125,
            planIds: ['plan-1'],
            assignedBookkeeperIds: ['emp-1'],
          },
        ],
        plans: [{ id: 'plan-1', name: 'Classic', monthlyFee: 500 }],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper' }],
      }),
    )
    const before = (await store.read()).clients[0]

    const retired = await store.setClientLifecycleStage('c1', 'inactive')
    expect(retired.lifecycleStage).toBe('inactive')
    // Everything that decides how this client is worked survives the round trip.
    expect(retired).toMatchObject({
      hourlyRate: before.hourlyRate,
      planIds: before.planIds,
      assignedBookkeeperIds: before.assignedBookkeeperIds,
    })

    const back = await store.setClientLifecycleStage('c1', 'active')
    expect({ ...back, lifecycleStage: before.lifecycleStage }).toEqual(before)
  })

  it('setClientLifecycleStage refuses a stage that is not real', async () => {
    await store.write(
      workspace({ clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly' }] }),
    )

    // Rejected outright rather than coerced to 'active': a silent coercion here
    // would look like a retirement that succeeded and did nothing.
    expect(await store.setClientLifecycleStage('c1', 'archived')).toBeNull()
    expect((await store.read()).clients[0].lifecycleStage).toBeUndefined()
  })

  it('setClientLifecycleStage returns null for a client that is not on file', async () => {
    await store.write(workspace({ clients: [] }))
    expect(await store.setClientLifecycleStage('ghost', 'inactive')).toBeNull()
  })
})

/**
 * "Just spitballing" brainstorm sessions.
 *
 * The client reported that the assistant "stops partway through a brainstorming
 * session, and its memory does not persist across separate conversations". The
 * modal held the whole conversation in React state, so closing the window threw
 * it away. The conversation now lives in `spitball_sessions`; these pin the
 * store contract both backends implement.
 */
describe('spitball sessions (file backend)', () => {
  beforeEach(async () => {
    // These share the one real tmp/auth-state.json, so clear the slice first —
    // otherwise an earlier test's active session leaks into the next one.
    if (existsSync(localAuthPath)) {
      const auth = JSON.parse(await readFile(localAuthPath, 'utf8'))
      auth.spitballSessions = []
      await writeFile(localAuthPath, JSON.stringify(auth, null, 2))
    }
  })

  it('creates exactly one active session per user and reuses it', async () => {
    expect(await store.getActiveSpitballSession('emp-patrice')).toBeNull()

    const first = await store.ensureActiveSpitballSession('emp-patrice')
    expect(first.status).toBe('active')
    expect(first.messages).toEqual([])

    const second = await store.ensureActiveSpitballSession('emp-patrice')
    expect(second.id).toBe(first.id)

    // A second owner gets her own, not Brittany's.
    const other = await store.ensureActiveSpitballSession('emp-alex')
    expect(other.id).not.toBe(first.id)
  })

  it('round-trips a turn — the conversation survives a fresh store instance', async () => {
    const session = await store.ensureActiveSpitballSession('emp-patrice')
    await store.appendSpitballTurn(session.id, [
      { role: 'user', text: 'what if clients could see their own checklist' },
      { role: 'assistant', text: 'Ooh — who would use it?' },
    ])

    // A brand new store reading the same files is the closest stand-in for
    // "she closed the window and came back".
    const reopened = new AppDataStore()
    await reopened.initialize()
    const loaded = await reopened.getActiveSpitballSession('emp-patrice')

    expect(loaded.id).toBe(session.id)
    expect(loaded.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(loaded.messages[0].text).toContain('own checklist')
    expect(loaded.messages[0].at).toBeTruthy()
  })

  it('refuses to append to an archived session', async () => {
    const session = await store.ensureActiveSpitballSession('emp-patrice')
    await store.appendSpitballTurn(session.id, [{ role: 'user', text: 'an idea' }])
    await store.archiveSpitballSession(session.id, 'She wants client-visible checklists.')

    expect(await store.appendSpitballTurn(session.id, [{ role: 'user', text: 'more' }])).toBeNull()
  })

  it('compaction keeps the recent turns verbatim and folds the rest into a summary', async () => {
    const session = await store.ensureActiveSpitballSession('emp-patrice')
    const turns = Array.from({ length: 32 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `turn ${index}`,
    }))
    await store.appendSpitballTurn(session.id, turns)

    const compacted = await store.compactSpitballSession(session.id, {
      summary: 'She is circling client-visible checklists.',
      keepRecent: 12,
    })

    expect(compacted.summary).toBe('She is circling client-visible checklists.')
    expect(compacted.messages).toHaveLength(12)
    // The RECENT end is what survives verbatim — turns 20..31.
    expect(compacted.messages[0].text).toBe('turn 20')
    expect(compacted.messages[11].text).toBe('turn 31')
  })

  it('archives with a summary and recalls it, newest first', async () => {
    const first = await store.ensureActiveSpitballSession('emp-patrice')
    await store.appendSpitballTurn(first.id, [{ role: 'user', text: 'idea one' }])
    await store.archiveSpitballSession(first.id, 'Session one: client-visible checklists.')

    const second = await store.ensureActiveSpitballSession('emp-patrice')
    expect(second.id).not.toBe(first.id)
    await store.appendSpitballTurn(second.id, [{ role: 'user', text: 'idea two' }])
    await store.archiveSpitballSession(second.id, 'Session two: reminder emails.')

    const summaries = await store.listSpitballSummaries('emp-patrice', 5)
    expect(summaries.map((entry) => entry.summary)).toEqual([
      'Session two: reminder emails.',
      'Session one: client-visible checklists.',
    ])
  })

  it('skips archived sessions that have no summary — there is nothing to recall', async () => {
    const session = await store.ensureActiveSpitballSession('emp-patrice')
    await store.appendSpitballTurn(session.id, [{ role: 'user', text: 'idea' }])
    await store.archiveSpitballSession(session.id, '')

    expect(await store.listSpitballSummaries('emp-patrice', 5)).toEqual([])
  })

  it('survives a bulk save — the session is not part of the workspace payload', async () => {
    const session = await store.ensureActiveSpitballSession('emp-patrice')
    await store.appendSpitballTurn(session.id, [{ role: 'user', text: 'mid-brainstorm' }])

    // Exactly the write that wiped the historical import: a full workspace
    // save. A live brainstorm must be untouched by it.
    await store.write(workspace())

    const after = await store.getActiveSpitballSession('emp-patrice')
    expect(after.id).toBe(session.id)
    expect(after.messages[0].text).toBe('mid-brainstorm')
  })

  it('is not part of the staleness fingerprint', async () => {
    const before = await store.computeWorkspaceVersion()
    const session = await store.ensureActiveSpitballSession('emp-patrice')
    await store.appendSpitballTurn(session.id, [{ role: 'user', text: 'typing away' }])

    // Brainstorming while another tab is open must not invalidate that tab for
    // writes — same reasoning as `invoices` (invoicing-handoff, gotcha #3).
    expect(await store.computeWorkspaceVersion()).toBe(before)
    expect(BULK_SAVE_TABLES).not.toContain('spitball_sessions')
    expect(workspaceVersionSql()).not.toMatch(/spitball/i)
  })
})

/**
 * A recorder pool for the spitball statements. `fakePostgres` above answers
 * every select with no rows, which would make `ensureActiveSpitballSession`
 * look like a lost insert race; this one lets a test script the reads.
 */
function fakeSpitballPostgres(responder = () => null) {
  const statements = []
  const pool = {
    async query(text, params) {
      const trimmed = String(text).trim()
      statements.push({ text: trimmed, params })
      return responder(trimmed, params) ?? { rows: [], rowCount: 0 }
    },
  }
  return {
    pool,
    statements,
    matching: (pattern) => statements.filter((s) => pattern.test(s.text)),
  }
}

const spitballRow = (overrides = {}) => ({
  id: 'spit-1',
  user_id: 'emp-patrice',
  status: 'active',
  messages: [{ role: 'user', text: 'an idea', at: '2026-08-11T12:00:00.000Z' }],
  summary: null,
  created_at: new Date('2026-08-11T12:00:00.000Z'),
  updated_at: new Date('2026-08-11T12:00:00.000Z'),
  ...overrides,
})

/**
 * Production is Postgres, so the file tests above cannot prove the shipped
 * path. These pin the SQL shapes that matter — the ones a rolled-back
 * validation against production then confirms for real (HANDOFF §4).
 */
describe('spitball sessions (postgres branch)', () => {
  it('inserts against the PARTIAL unique index, and re-reads the winner on a race', async () => {
    let selects = 0
    const fake = fakeSpitballPostgres((text) => {
      if (/^select\b[\s\S]*from spitball_sessions/i.test(text)) {
        selects += 1
        // First read: no session. Second read (after the lost insert race):
        // whatever the other tab created.
        return selects === 1 ? { rows: [], rowCount: 0 } : { rows: [spitballRow()], rowCount: 1 }
      }
      // The insert loses the race.
      return { rows: [], rowCount: 0 }
    })

    const session = await postgresStore(fake).ensureActiveSpitballSession('emp-patrice')

    const insert = fake.matching(/^insert into spitball_sessions/i)[0]
    expect(insert.text).toMatch(/on conflict \(user_id\) where status = 'active' do nothing/i)
    expect(session.id).toBe('spit-1')
  })

  it('appends IN the row, so two turns in flight cannot clobber each other', async () => {
    const fake = fakeSpitballPostgres(() => ({ rows: [spitballRow()], rowCount: 1 }))

    await postgresStore(fake).appendSpitballTurn('spit-1', [
      { role: 'user', text: 'an idea' },
      { role: 'assistant', text: 'say more?' },
    ])

    const update = fake.matching(/^update spitball_sessions/i)[0]
    expect(update.text).toMatch(/set messages = messages \|\| \$2::jsonb/i)
    expect(update.text).toMatch(/where id = \$1 and status = 'active'/i)
    expect(JSON.parse(update.params[1])).toHaveLength(2)
  })

  it('compacts by trimming the row in SQL, not by rewriting a stale array', async () => {
    const fake = fakeSpitballPostgres(() => ({ rows: [spitballRow()], rowCount: 1 }))

    await postgresStore(fake).compactSpitballSession('spit-1', {
      summary: 'the gist so far',
      keepRecent: 12,
    })

    const update = fake.matching(/^update spitball_sessions/i)[0]
    expect(update.text).toMatch(/jsonb_array_elements\(spitball_sessions\.messages\)/i)
    expect(update.text).toMatch(/with ordinality as t\(elem, ord\)/i)
    expect(update.params).toEqual(['spit-1', 'the gist so far', 12])
  })

  it('archives the active session and prunes the old end of the archive', async () => {
    const fake = fakeSpitballPostgres(() => ({
      rows: [spitballRow({ status: 'archived', summary: 'the gist' })],
      rowCount: 1,
    }))

    await postgresStore(fake).archiveSpitballSession('spit-1', 'the gist')

    expect(fake.matching(/^update spitball_sessions/i)[0].text).toMatch(
      /set status = 'archived', summary = \$2/i,
    )
    expect(fake.matching(/^delete from spitball_sessions/i)).toHaveLength(1)
  })

  it('recalls only archived sessions that actually carry a summary', async () => {
    const fake = fakeSpitballPostgres(() => ({ rows: [], rowCount: 0 }))

    await postgresStore(fake).listSpitballSummaries('emp-patrice', 5)

    const select = fake.matching(/^select\b[\s\S]*from spitball_sessions/i)[0]
    expect(select.text).toMatch(/status = 'archived'/i)
    expect(select.text).toMatch(/summary is not null/i)
    expect(select.params).toEqual(['emp-patrice', 5])
  })

  it('the bulk save never touches the table', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(workspace())
    expect(fake.matching(/spitball_sessions/i)).toHaveLength(0)
  })
})

/**
 * The two-party waiting-on hand-off, end to end on the file backend.
 *
 * Her report (featreq-b05a2f3a): "A received the notification and clicked
 * Confirmed on the waiting task and it disappeared." These tests pin the half
 * of that which lives in the store — CONFIRMING IS NOT A DELETE. The record has
 * to survive `waiting → resolved → verified` with every name and date on it,
 * because those five fields are the whole receipt for a hand-off between two
 * people.
 *
 * Cancel is the deliberate exception and is pinned here too, so the difference
 * between "this finished" and "this never needed to happen" can't blur.
 */
const WAITING_WORKSPACE = {
  clients: [{ id: 'c1', name: 'Acme' }],
  employees: [
    { id: 'emp-brit', name: 'Brittany', role: 'owner' },
    { id: 'emp-lisa', name: 'Lisa', role: 'bookkeeper' },
  ],
  checklists: [
    {
      id: 'cl-1',
      title: 'August close',
      clientId: 'c1',
      items: [
        { id: 'it-1', label: 'Reconcile the operating account', done: false },
        {
          id: 'it-2',
          label: 'Payroll',
          done: false,
          subItems: [{ id: 'sub-1', title: 'Confirm the hours', done: false }],
        },
      ],
    },
  ],
}

/** The one entry on a node, straight off a fresh read. */
async function readWaitingOns(store, { itemId, subItemId }) {
  const data = await store.read()
  const item = data.checklists.find((c) => c.id === 'cl-1').items.find((i) => i.id === itemId)
  const node = subItemId ? item.subItems.find((s) => s.id === subItemId) : item
  return node.waitingOns ?? []
}

describe('the waiting-on hand-off round-trips (file backend)', () => {
  beforeEach(async () => {
    await store.write(workspace(WAITING_WORKSPACE))
  })

  it('keeps the record through both stages, with every name and date', async () => {
    const added = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-lisa', requestedBy: 'emp-brit', note: 'the bank statements' },
    )
    expect(added.entry.id).toMatch(/^wo-/)

    await store.markWaitingOnDone('cl-1', added.entry.id, { userId: 'emp-lisa' })
    const afterDone = await readWaitingOns(store, { itemId: 'it-1' })
    // Stage 1 already used to delete this. It must not.
    expect(afterDone).toHaveLength(1)
    expect(afterDone[0]).toMatchObject({ resolvedBy: 'emp-lisa', blockerId: 'emp-lisa' })
    expect(afterDone[0].verifiedAt).toBeUndefined()

    await store.markWaitingOnVerified('cl-1', added.entry.id, { userId: 'emp-brit' })
    const afterVerify = await readWaitingOns(store, { itemId: 'it-1' })

    // THE regression: confirming keeps the row. It is the record of who did the
    // check, and it is what the step renders as a completed sub-item.
    expect(afterVerify).toHaveLength(1)
    expect(afterVerify[0]).toMatchObject({
      id: added.entry.id,
      blockerId: 'emp-lisa',
      requestedBy: 'emp-brit',
      note: 'the bank statements',
      resolvedBy: 'emp-lisa',
      verifiedBy: 'emp-brit',
    })
    expect(typeof afterVerify[0].createdAt).toBe('string')
    expect(typeof afterVerify[0].resolvedAt).toBe('string')
    expect(typeof afterVerify[0].verifiedAt).toBe('string')
  })

  it('never touches the step it was blocking — confirming is not completing', async () => {
    const added = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-lisa', requestedBy: 'emp-brit' },
    )
    await store.markWaitingOnDone('cl-1', added.entry.id, { userId: 'emp-lisa' })
    await store.markWaitingOnVerified('cl-1', added.entry.id, { userId: 'emp-brit' })

    const data = await store.read()
    const item = data.checklists.find((c) => c.id === 'cl-1').items.find((i) => i.id === 'it-1')
    expect(item.done).toBe(false)
  })

  it('round-trips on a SUB-item too (it rides the parent item, not its own column)', async () => {
    const added = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-2', subItemId: 'sub-1' },
      { blockerId: 'emp-lisa', requestedBy: 'emp-brit' },
    )
    await store.markWaitingOnDone('cl-1', added.entry.id, { userId: 'emp-lisa' })
    await store.markWaitingOnVerified('cl-1', added.entry.id, { userId: 'emp-brit' })

    const entries = await readWaitingOns(store, { itemId: 'it-2', subItemId: 'sub-1' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ resolvedBy: 'emp-lisa', verifiedBy: 'emp-brit' })
  })

  it('closes a CLIENT wait in one press, straight to verified', async () => {
    const added = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'c1', requestedBy: 'emp-brit', blockerType: 'client' },
    )
    // No second party exists to hand back to, so Done carries `alsoVerify`.
    await store.markWaitingOnDone('cl-1', added.entry.id, {
      userId: 'emp-brit',
      alsoVerify: true,
    })

    const entries = await readWaitingOns(store, { itemId: 'it-1' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ blockerType: 'client', verifiedBy: 'emp-brit' })
  })

  /**
   * Her fifth round: "User should not be able to remove the information once it
   * is saved." Cancel used to delete the row outright; the store now has no way
   * to remove one at all, which is what makes the server-side refusal more than
   * a hidden button.
   */
  it('has no removal path left — the record cannot be deleted', async () => {
    expect(store.resolveWaitingOn).toBeUndefined()

    const added = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-lisa', requestedBy: 'emp-brit' },
    )
    // The walk that every stage transition rides refuses to drop an entry, so a
    // future mutation that returns nothing fails loudly instead of erasing it.
    await expect(
      store._mutateWaitingOn('cl-1', added.entry.id, () => null),
    ).rejects.toThrow(/never removed/)

    expect(await readWaitingOns(store, { itemId: 'it-1' })).toHaveLength(1)
  })

  it('keeps the record through a send-back and back again', async () => {
    const added = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-lisa', requestedBy: 'emp-brit', note: 'the bank statements' },
    )
    await store.markWaitingOnDone('cl-1', added.entry.id, { userId: 'emp-lisa' })
    await store.markWaitingOnSentBack('cl-1', added.entry.id, {
      userId: 'emp-brit',
      note: 'the March page is missing',
    })
    // Sent back = the blocker's move again. Locking deletion must not wedge it.
    const midFlight = await readWaitingOns(store, { itemId: 'it-1' })
    expect(midFlight).toHaveLength(1)
    expect(midFlight[0].resolvedAt).toBeUndefined()
    expect(midFlight[0].sendBacks).toHaveLength(1)

    await store.markWaitingOnDone('cl-1', added.entry.id, { userId: 'emp-lisa' })
    await store.markWaitingOnVerified('cl-1', added.entry.id, { userId: 'emp-brit' })

    const closed = await readWaitingOns(store, { itemId: 'it-1' })
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({
      note: 'the bank statements',
      resolvedBy: 'emp-lisa',
      verifiedBy: 'emp-brit',
    })
    expect(closed[0].sendBacks).toHaveLength(1)
  })
})

/**
 * THE invariant. Client assignment was stored twice — `assigned_bookkeeper_ids`
 * and the `client_assignments` table — and only the first gated visibility, so
 * the two could disagree without anything failing. They are one value now, and
 * every mutation path has to keep them one value.
 *
 * On the file backend below, this alone does NOT catch a reintroduced second
 * source: `read()` maps every client through `normalizeClientProfile`, which
 * assigns one computed value to both `assignedBookkeeperIds` and
 * `assignedEmployeeIds` unconditionally, so the two names are trivially equal
 * here no matter what a regression wrote. The real regression power is each
 * test's companion assertion on the actual value (e.g.
 * `assignedBookkeeperIds` equals what was set) — never add a test that calls
 * this helper without one.
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
    expect((await clientFromDisk()).assignedBookkeeperIds).toEqual(['emp-2'])
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

  it('holds after deactivateUser removes someone from the team', async () => {
    await store.setClientAssignedTeam('c1', ['emp-1', 'emp-2'])

    // The plan docs refer to this cleanup informally as "deactivateUser"; the
    // actual store method is `deleteTeamMember(userId, ownerId)` (db/store.js)
    // — same behavior (soft-deactivates, strips the user from every client's
    // assigned team), different name. It needs a real, ACTIVE user in the auth
    // file to act on, and emp-2 is not one of the seeded auth users, so add it
    // here. This suite's top-level beforeAll/afterAll already snapshot and
    // restore tmp/auth-state.json around the whole file, so no extra cleanup
    // is needed beyond what's already in place.
    const authState = JSON.parse(await readFile(localAuthPath, 'utf8'))
    if (!authState.users.some((user) => user.id === 'emp-2')) {
      authState.users.push({
        id: 'emp-2',
        name: 'Dana',
        email: 'dana@pbj.local',
        staffRole: 'Bookkeeper',
        role: 'bookkeeper',
      })
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    }

    const result = await store.deleteTeamMember('emp-2', 'owner-1')
    expect(result).toEqual({ ok: true })

    const client = await clientFromDisk()
    expectOneTeamSource(client)
    expect(client.assignedBookkeeperIds).not.toContain('emp-2')
  })
})

/**
 * SEND BACK — "a button to not approve and send back with another note"
 * (featreq-b05a2f3a, the firm owner's fourth round on the waiting-on flow).
 *
 * The transition that makes the hand-off a loop rather than a line:
 *
 *   waiting --B's Done--> resolved --A's Send back--> waiting --B's Done--> ...
 *
 * What makes it safe is that it MOVES rather than deletes. `resolvedAt` /
 * `resolvedBy` have to be cleared or the wait would still read as `resolved`
 * and never return to B's queue — so they are stashed on the `sendBacks[]`
 * event that cleared them, alongside A's new note. The ORIGINAL note, the
 * requester and the creation date are never touched.
 *
 * File backend here; the Postgres statement shape is pinned separately below.
 */
describe('markWaitingOnSentBack (file backend)', () => {
  const ASKED = 'emp-brit' // A, who asked
  const BLOCKER = 'emp-lisa' // B, who was waited on

  const seedWait = async (overrides = {}) => {
    await store.write(
      workspace({
        employees: [
          { id: ASKED, name: 'Brittany', role: 'owner' },
          { id: BLOCKER, name: 'Lisa', role: 'bookkeeper' },
        ],
        checklists: [
          {
            id: 'cl-1',
            clientId: 'c1',
            title: 'August close',
            items: [
              {
                id: 'it-1',
                label: 'Bank rec',
                done: false,
                assigneeId: ASKED,
                waitingOns: [
                  {
                    id: 'wo-1',
                    blockerId: BLOCKER,
                    requestedBy: ASKED,
                    note: 'the bank statements',
                    createdAt: '2026-08-05T15:00:00.000Z',
                    ...overrides,
                  },
                ],
                subItems: [],
              },
            ],
          },
        ],
      }),
    )
  }

  const RESOLVED = { resolvedAt: '2026-08-07T15:00:00.000Z', resolvedBy: BLOCKER }

  const entryFromDisk = async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.checklists[0].items[0].waitingOns[0]
  }

  it('returns a resolved wait to the blocker and keeps BOTH notes', async () => {
    await seedWait(RESOLVED)

    const result = await store.markWaitingOnSentBack('cl-1', 'wo-1', {
      userId: ASKED,
      note: 'the March page is missing',
    })
    expect(result).not.toBeNull()

    const entry = await entryFromDisk()
    // Back to B's move.
    expect(entry.resolvedAt).toBeUndefined()
    expect(entry.resolvedBy).toBeUndefined()
    expect(entry.verifiedAt).toBeUndefined()
    // The original note is NOT overwritten — that was the whole instruction.
    expect(entry.note).toBe('the bank statements')
    expect(entry.requestedBy).toBe(ASKED)
    expect(entry.createdAt).toBe('2026-08-05T15:00:00.000Z')
    // ...and the rejected resolution survives on the event that cleared it.
    expect(entry.sendBacks).toHaveLength(1)
    expect(entry.sendBacks[0]).toMatchObject({
      by: ASKED,
      note: 'the March page is missing',
      resolvedAt: RESOLVED.resolvedAt,
      resolvedBy: BLOCKER,
    })
    expect(typeof entry.sendBacks[0].at).toBe('string')
  })

  it('appends on every lap, oldest first', async () => {
    await seedWait(RESOLVED)
    await store.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'first pass' })
    await store.markWaitingOnDone('cl-1', 'wo-1', { userId: BLOCKER })
    await store.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'second pass' })

    const entry = await entryFromDisk()
    expect(entry.sendBacks.map((event) => event.note)).toEqual(['first pass', 'second pass'])
    expect(entry.note).toBe('the bank statements')
  })

  it('survives the read() round-trip — normalizeWaitingOns must not eat it', async () => {
    await seedWait(RESOLVED)
    await store.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'not yet' })

    // read() re-normalizes every node and writes its materialized output back;
    // a field the normalizer drops is erased on the next page load.
    const data = await store.read()
    const entry = data.checklists[0].items[0].waitingOns[0]
    expect(entry.sendBacks).toEqual([
      expect.objectContaining({ by: ASKED, note: 'not yet', resolvedBy: BLOCKER }),
    ])
    expect(entry.resolvedAt).toBeUndefined()
  })

  it('closes out normally after the lap, keeping the whole history', async () => {
    await seedWait(RESOLVED)
    await store.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'redo it' })
    await store.markWaitingOnDone('cl-1', 'wo-1', { userId: BLOCKER })
    await store.markWaitingOnVerified('cl-1', 'wo-1', { userId: ASKED })

    const entry = await entryFromDisk()
    expect(entry.verifiedBy).toBe(ASKED)
    expect(entry.resolvedBy).toBe(BLOCKER)
    expect(entry.note).toBe('the bank statements')
    expect(entry.sendBacks).toHaveLength(1)
  })

  it('never touches the step own done flag', async () => {
    await seedWait(RESOLVED)
    await store.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'again please' })

    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    expect(data.checklists[0].items[0].done).toBe(false)
  })

  it('returns null for a wait that is not there', async () => {
    await seedWait()
    expect(
      await store.markWaitingOnSentBack('cl-1', 'wo-nope', { userId: ASKED, note: 'x' }),
    ).toBeNull()
  })
})

/**
 * The same transition's POSTGRES shape — the branch production runs.
 *
 * NO new statement is introduced: send-back rides the existing
 * `_persistItemWaitingOns` update, the same one Done and Approve use. What IS
 * new is a key inside that JSONB payload (`sendBacks[]`), and a JSONB field the
 * normalizer doesn't carry is erased on the next read — which is why this
 * asserts on the parameter, not just the SQL text.
 */
describe('markWaitingOnSentBack statement shape (postgres branch)', () => {
  const ASKED = 'emp-brit'
  const BLOCKER = 'emp-lisa'

  const resolvedEntry = () => ({
    id: 'wo-1',
    blockerId: BLOCKER,
    requestedBy: ASKED,
    note: 'the bank statements',
    createdAt: '2026-08-05T15:00:00.000Z',
    resolvedAt: '2026-08-07T15:00:00.000Z',
    resolvedBy: BLOCKER,
  })

  /** `_mutateWaitingOn` reads through `read()`; stub it to the row under test. */
  function pgStoreFor(items) {
    const fake = fakePostgres()
    const pgStore = postgresStore(fake)
    pgStore.read = async () => ({
      checklists: [{ id: 'cl-1', clientId: 'c1', title: 'August close', items }],
    })
    return { fake, pgStore }
  }

  const itemLevel = () => [
    {
      id: 'it-1',
      label: 'Bank rec',
      done: false,
      assigneeId: ASKED,
      waitingOns: [resolvedEntry()],
      subItems: [],
    },
  ]

  it('writes through the existing waiting_ons update — no new statement', async () => {
    const { fake, pgStore } = pgStoreFor(itemLevel())
    await pgStore.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'the March page' })

    const updates = fake.matching(/^update checklist_items set waiting_ons = \$3::jsonb/i)
    expect(updates).toHaveLength(1)
    expect(updates[0].params.slice(0, 2)).toEqual(['cl-1', 'it-1'])
    // Nothing else in the schema is touched by a send-back.
    expect(fake.matching(/^update checklist_items set sub_items/i)).toHaveLength(0)
  })

  it('carries sendBacks[] into the JSONB, with the resolution it cleared', async () => {
    const { fake, pgStore } = pgStoreFor(itemLevel())
    await pgStore.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'the March page' })

    const written = JSON.parse(
      fake.matching(/^update checklist_items set waiting_ons/i)[0].params[2],
    )
    expect(written).toHaveLength(1)
    expect(written[0].note).toBe('the bank statements')
    expect(written[0].resolvedAt).toBeUndefined()
    expect(written[0].resolvedBy).toBeUndefined()
    expect(written[0].sendBacks).toEqual([
      expect.objectContaining({
        by: ASKED,
        note: 'the March page',
        resolvedAt: '2026-08-07T15:00:00.000Z',
        resolvedBy: BLOCKER,
      }),
    ])
  })

  it('rewrites the sub_items JSONB instead when the wait is on a sub-item', async () => {
    const { fake, pgStore } = pgStoreFor([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: ASKED,
        waitingOns: [],
        subItems: [
          {
            id: 'sub-1',
            title: 'Pull statements',
            done: false,
            waitingOns: [resolvedEntry()],
          },
        ],
      },
    ])
    await pgStore.markWaitingOnSentBack('cl-1', 'wo-1', { userId: ASKED, note: 'the March page' })

    const updates = fake.matching(/^update checklist_items set sub_items = \$3::jsonb/i)
    expect(updates).toHaveLength(1)
    const subItems = JSON.parse(updates[0].params[2])
    expect(subItems[0].waitingOns[0].sendBacks).toHaveLength(1)
    expect(subItems[0].waitingOns[0].resolvedAt).toBeUndefined()
  })
})

/**
 * `created_at` through the bulk save.
 *
 * Every re-insert in the Postgres branch used to OMIT `created_at`, so the
 * column's `default now()` fired again on each wipe-and-rewrite. In production
 * that meant all 753 checklists claimed to have been created on the day of the
 * most recent owner autosave — the creation dates were being destroyed on a
 * schedule, silently, and the historical ones are gone for good.
 *
 * The fix is the technique the invoice restore already used: snapshot inside the
 * transaction BEFORE the deletes, then supply the value. Deliberately NOT taken
 * from the payload — `read()` does not even send most of these, and a stale tab
 * that did carry one could rewrite history.
 *
 * These are STATEMENT-SHAPE tests. The file backend cannot see this bug at all
 * (it re-writes whole records and has no column defaults), so a shape assertion
 * on what the transaction issues is the only guard CI can offer.
 */
describe('bulk save preserves created_at (postgres branch)', () => {
  const ORIGINAL = new Date('2026-01-15T10:00:00.000Z')

  /** One row per created_at-carrying table, all claiming the same old date. */
  const snapshotRows = {
    subscription_plans: [{ id: 'plan-1', created_at: ORIGINAL }],
    contacts: [{ id: 'contact-1', created_at: ORIGINAL }],
    clients: [{ id: 'c1', created_at: ORIGINAL }],
    reimbursements: [{ id: 'reim-1', created_at: ORIGINAL }],
    recurring_reimbursements: [{ id: 'rec-1', created_at: ORIGINAL }],
    checklist_templates: [{ id: 'tpl-1', created_at: ORIGINAL }],
    checklist_template_items: [{ id: 'tpl-item-1', created_at: ORIGINAL }],
    checklists: [{ id: 'cl-1', created_at: ORIGINAL }],
    checklist_items: [{ id: 'item-1', created_at: ORIGINAL }],
  }

  /** A payload carrying exactly one row for each of those tables. */
  const historyWorkspace = () =>
    workspace({
      clients: [{ id: 'c1', name: 'Acme' }],
      plans: [{ id: 'plan-1', name: 'Basic', templateIds: [] }],
      contacts: [{ id: 'contact-1', name: 'Pat' }],
      reimbursements: [
        { id: 'reim-1', clientId: 'c1', date: '2026-02-01', description: 'Stamps', amount: 10 },
      ],
      recurringReimbursements: [
        {
          id: 'rec-1',
          clientId: 'c1',
          description: 'Software',
          amount: 20,
          frequency: 'monthly',
          startDate: '2026-01-01',
        },
      ],
      checklistTemplates: [
        {
          id: 'tpl-1',
          title: 'Monthly close',
          clientId: 'c1',
          assigneeId: 'emp-1',
          frequency: 'monthly',
          nextDueDate: '2026-02-28',
          active: true,
          stages: [
            {
              id: 'stage-1',
              name: 'Stage 1',
              assigneeId: 'emp-1',
              offsetDays: 0,
              items: [{ id: 'tpl-item-1', label: 'Reconcile' }],
            },
          ],
        },
      ],
      checklists: [
        {
          id: 'cl-1',
          title: 'January close',
          clientId: 'c1',
          assigneeId: 'emp-1',
          dueDate: '2026-01-31',
          items: [{ id: 'item-1', label: 'Reconcile', done: false }],
        },
      ],
    })

  it('snapshots every affected table BEFORE the first delete', async () => {
    const fake = fakePostgres({ createdAtRows: snapshotRows })
    await postgresStore(fake).write(historyWorkspace())

    const firstDeleteAt = fake.indexOf(/^delete from /i)
    expect(firstDeleteAt).toBeGreaterThan(-1)
    for (const table of CREATED_AT_PRESERVED_TABLES) {
      const at = fake.indexOf(new RegExp(`^select id, created_at from ${table}$`, 'i'))
      expect(at, `${table} is never snapshotted`).toBeGreaterThan(-1)
      expect(at, `${table} is snapshotted after the wipe`).toBeLessThan(firstDeleteAt)
    }
  })

  it('names created_at on the re-insert for every one of them', async () => {
    const fake = fakePostgres({ createdAtRows: snapshotRows })
    await postgresStore(fake).write(historyWorkspace())

    for (const table of CREATED_AT_PRESERVED_TABLES) {
      const inserts = fake.matching(new RegExp(`^insert into ${table}\\b`, 'i'))
      expect(inserts.length, `${table} never re-inserted by this payload`).toBeGreaterThan(0)
      // The column has to be NAMED — omitting it is exactly the bug, and the
      // `default now()` behind it makes the omission invisible at runtime.
      expect(inserts[0].text, `${table} insert omits created_at`).toMatch(/\bcreated_at\b/)
    }
  })

  it('supplies the ORIGINAL timestamp, not the default', async () => {
    const fake = fakePostgres({ createdAtRows: snapshotRows })
    await postgresStore(fake).write(historyWorkspace())

    for (const table of CREATED_AT_PRESERVED_TABLES) {
      const insert = fake.matching(new RegExp(`^insert into ${table}\\b`, 'i'))[0]
      expect(insert.params, `${table} lost its original created_at`).toContain(ORIGINAL)
    }
  })

  it('falls back to a fresh timestamp for a genuinely new row', async () => {
    // No snapshot at all: every row in this payload is new.
    const fake = fakePostgres()
    const before = Date.now()
    await postgresStore(fake).write(historyWorkspace())

    const insert = fake.matching(/^insert into checklists\b/i)[0]
    const supplied = insert.params.find((param) => param instanceof Date)
    expect(supplied).toBeInstanceOf(Date)
    expect(supplied.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('ignores a createdAt the payload carries — a stale tab cannot rewrite history', async () => {
    const fake = fakePostgres({ createdAtRows: snapshotRows })
    const payload = historyWorkspace()
    payload.checklists[0].createdAt = '2019-01-01T00:00:00.000Z'
    await postgresStore(fake).write(payload)

    const insert = fake.matching(/^insert into checklists\b/i)[0]
    expect(insert.params).toContain(ORIGINAL)
    expect(insert.params).not.toContain('2019-01-01T00:00:00.000Z')
  })
})

/**
 * `checklist_items.completed_at` — the record of WHEN a step was finished.
 *
 * `done` is a bare boolean and always was, so nothing in the product recorded
 * the moment anything was completed. The Completed tasks tab is an audit
 * surface, so the rule has to hold in both directions: a completion is stamped,
 * an un-tick clears the stamp, and no unrelated write may invent or erase one.
 */
describe('completed_at on checklist items (postgres branch)', () => {
  const itemRow = (over = {}) => ({
    id: 'item-1',
    checklist_id: 'cl-1',
    label: 'Reconcile',
    done: false,
    sub_items: [],
    ...over,
  })

  /**
   * A Postgres store whose per-item read returns `row`, so the read-modify-write
   * toggle path has something to toggle. Everything else falls through to the
   * recording fake.
   */
  function pgStoreWithItem(row) {
    const fake = fakePostgres()
    const store = postgresStore(fake)
    const inner = fake.pool.query.bind(fake.pool)
    fake.pool.query = async (text, params) => {
      const result = await inner(text, params)
      if (/^select (id, done|done|sub_items).*from checklist_items/is.test(String(text).trim())) {
        return { rows: [row], rowCount: 1 }
      }
      return result
    }
    return { fake, store }
  }

  it('stamps the completion in the same UPDATE that sets done', async () => {
    const { fake, store } = pgStoreWithItem(itemRow())
    await store.toggleChecklistItem('cl-1', 'item-1')

    const update = fake.matching(/^update checklist_items\s+set done = \$3/i)[0]
    expect(update).toBeDefined()
    expect(update.text).toMatch(
      /completed_at = case when \$3 then coalesce\(completed_at, now\(\)\)/,
    )
    expect(update.text).toMatch(/else null end/)
    // $3 is the new `done` — the one expression covers both directions.
    expect(update.params[2]).toBe(true)
  })

  it('clears it when the step is un-ticked', async () => {
    const { fake, store } = pgStoreWithItem(itemRow({ done: true }))
    await store.toggleChecklistItem('cl-1', 'item-1')

    const update = fake.matching(/^update checklist_items\s+set done = \$3/i)[0]
    expect(update.params[2]).toBe(false)
    expect(update.text).toMatch(/else null end/)
  })

  it('follows the roll-up when a sub-item is added', async () => {
    // Every sub-item write recomputes the parent `done`; the stamp has to move
    // with it or a task can be "complete" with no completion date.
    const { fake, store } = pgStoreWithItem(itemRow({ done: true }))
    await store.addChecklistSubItem('cl-1', 'item-1', 'Pull statements')

    const update = fake.matching(
      /^update checklist_items\s+set sub_items = \$3::jsonb, done = \$4/i,
    )[0]
    expect(update).toBeDefined()
    expect(update.text).toMatch(/completed_at = case when \$4 then/)
  })

  it('bulk save keeps the stored stamp and ignores the payload', async () => {
    const stamped = new Date('2026-03-02T15:30:00.000Z')
    const fake = fakePostgres({
      priorItemRows: [{ id: 'item-1', done: true, completed_at: stamped }],
    })
    await postgresStore(fake).write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme' }],
        checklists: [
          {
            id: 'cl-1',
            title: 'January close',
            clientId: 'c1',
            assigneeId: 'emp-1',
            dueDate: '2026-01-31',
            items: [
              {
                id: 'item-1',
                label: 'Reconcile',
                done: true,
                // A stale tab's idea of when this finished. Must not win.
                completedAt: '2019-01-01T00:00:00.000Z',
              },
            ],
          },
        ],
      }),
    )

    const insert = fake.matching(/^insert into checklist_items\b/i)[0]
    expect(insert.text).toMatch(/\bcompleted_at\b/)
    expect(insert.params).toContain(stamped)
    expect(insert.params).not.toContain('2019-01-01T00:00:00.000Z')
  })

  it('bulk save writes null for a step that is not done', async () => {
    const fake = fakePostgres({
      priorItemRows: [
        { id: 'item-1', done: true, completed_at: new Date('2026-03-02T15:30:00.000Z') },
      ],
    })
    await postgresStore(fake).write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme' }],
        checklists: [
          {
            id: 'cl-1',
            title: 'January close',
            clientId: 'c1',
            assigneeId: 'emp-1',
            dueDate: '2026-01-31',
            items: [{ id: 'item-1', label: 'Reconcile', done: false }],
          },
        ],
      }),
    )

    const insert = fake.matching(/^insert into checklist_items\b/i)[0]
    expect(insert.params[14]).toBeNull()
  })

  it('leaves a legacy complete-but-unstamped row unstamped rather than backdating it', async () => {
    // The row was already done before the column existed. Stamping it now would
    // put today's date on work finished months ago, on an AUDIT screen.
    const fake = fakePostgres({
      priorItemRows: [{ id: 'item-1', done: true, completed_at: null }],
    })
    await postgresStore(fake).write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme' }],
        checklists: [
          {
            id: 'cl-1',
            title: 'January close',
            clientId: 'c1',
            assigneeId: 'emp-1',
            dueDate: '2026-01-31',
            items: [{ id: 'item-1', label: 'Reconcile', done: true }],
          },
        ],
      }),
    )

    const insert = fake.matching(/^insert into checklist_items\b/i)[0]
    expect(insert.params[14]).toBeNull()
  })
})

/**
 * Column parity between the checklist-item SELECT and its row mapper — the same
 * guard, and for the same reason, as the invoice one above. `completed_at` is
 * the newest column on `checklist_items`; left out of the select it would read
 * as `undefined` on Postgres and correctly on the file backend, so every test
 * here would pass while production showed no completion dates at all.
 */
describe('read() selects every column mapChecklistItemRow reads', () => {
  it('has no column the mapper reads but the select omits', () => {
    const readColumns = new Set()
    mapChecklistItemRow(
      new Proxy(
        {},
        {
          get(_target, key) {
            if (typeof key === 'string') readColumns.add(key)
            return undefined
          },
        },
      ),
    )

    const selected = new Set(
      CHECKLIST_ITEM_SELECT_COLUMNS.split(',')
        .map((column) => column.trim())
        .filter(Boolean),
    )

    expect(readColumns.size).toBeGreaterThan(8)
    expect([...readColumns].filter((column) => !selected.has(column))).toEqual([])
    expect(selected.has('completed_at')).toBe(true)
  })

  it('emits completedAt only when the row carries one', () => {
    const stamped = mapChecklistItemRow({
      id: 'item-1',
      label: 'Reconcile',
      done: true,
      completed_at: new Date('2026-03-02T15:30:00.000Z'),
    })
    expect(stamped.completedAt).toBe('2026-03-02T15:30:00.000Z')

    const legacy = mapChecklistItemRow({
      id: 'item-2',
      label: 'Reconcile',
      done: true,
      completed_at: null,
    })
    expect(legacy).not.toHaveProperty('completedAt')
  })
})

/**
 * The FILE backend's half of the same two contracts (cardinal rule 1).
 *
 * This backend re-writes each record WHOLE, which is often assumed to be
 * protection in itself. It is not: whatever the payload omits is gone, and
 * whatever it carries is believed. So the same rule is enforced here — the
 * persisted value wins over the payload's, and only a step this save actually
 * completes gets a fresh stamp.
 */
describe('bulk save preserves checklist history (file backend)', () => {
  const checklistWith = (items, over = {}) => ({
    id: 'cl-1',
    title: 'January close',
    clientId: 'c1',
    assigneeId: 'emp-1',
    dueDate: '2026-01-31',
    items,
    ...over,
  })

  const persisted = async () => JSON.parse(await readFile(localDataPath, 'utf8'))

  it('keeps a checklist createdAt the payload dropped', async () => {
    await store.write(
      workspace({
        checklists: [
          checklistWith([{ id: 'item-1', label: 'Reconcile', done: false }], {
            createdAt: '2026-01-02T09:00:00.000Z',
          }),
        ],
      }),
    )

    // The next save has no createdAt at all — the shape `read()` actually sends.
    await store.write(
      workspace({
        checklists: [checklistWith([{ id: 'item-1', label: 'Reconcile', done: false }])],
      }),
    )

    expect((await persisted()).checklists[0].createdAt).toBe('2026-01-02T09:00:00.000Z')
  })

  it('stamps a completion, and keeps it across the next bulk save', async () => {
    await store.write(
      workspace({
        checklists: [checklistWith([{ id: 'item-1', label: 'Reconcile', done: false }])],
      }),
    )
    await store.toggleChecklistItem('cl-1', 'item-1')

    const stamped = (await persisted()).checklists[0].items[0].completedAt
    expect(stamped).toBeTruthy()

    // A save whose payload carries a DIFFERENT stamp must not rewrite it.
    await store.write(
      workspace({
        checklists: [
          checklistWith([
            {
              id: 'item-1',
              label: 'Reconcile',
              done: true,
              completedAt: '2019-01-01T00:00:00.000Z',
            },
          ]),
        ],
      }),
    )

    expect((await persisted()).checklists[0].items[0].completedAt).toBe(stamped)
  })

  it('clears the stamp when the step is un-ticked', async () => {
    await store.write(
      workspace({
        checklists: [checklistWith([{ id: 'item-1', label: 'Reconcile', done: false }])],
      }),
    )
    await store.toggleChecklistItem('cl-1', 'item-1')
    expect((await persisted()).checklists[0].items[0].completedAt).toBeTruthy()

    await store.toggleChecklistItem('cl-1', 'item-1')
    const item = (await persisted()).checklists[0].items[0]
    expect(item.done).toBe(false)
    expect(item).not.toHaveProperty('completedAt')
  })

  it('does not backdate a step that was already done before stamps existed', async () => {
    // The legacy state, written straight to the file: complete, never stamped.
    // (It cannot be produced through `write()` — that path stamps a new item
    // arriving complete, which is the right answer for a NEW item.)
    await writeFile(
      localDataPath,
      JSON.stringify(
        workspace({
          checklists: [checklistWith([{ id: 'item-1', label: 'Reconcile', done: true }])],
        }),
        null,
        2,
      ),
    )

    // Still done, still unstamped — a bulk save is not a completion event, and
    // today's date on work finished months ago would be a lie on an audit view.
    await store.write(
      workspace({
        checklists: [checklistWith([{ id: 'item-1', label: 'Reconcile', done: true }])],
      }),
    )

    expect((await persisted()).checklists[0].items[0]).not.toHaveProperty('completedAt')
  })

  it('stamps a step the bulk save itself completes', async () => {
    await store.write(
      workspace({
        checklists: [checklistWith([{ id: 'item-1', label: 'Reconcile', done: false }])],
      }),
    )
    await store.write(
      workspace({
        checklists: [checklistWith([{ id: 'item-1', label: 'Reconcile', done: true }])],
      }),
    )

    expect((await persisted()).checklists[0].items[0].completedAt).toBeTruthy()
  })
})

/**
 * Quiet skip — the FILE backend, end to end.
 *
 * Cardinal rule 1: `db/store.js` has two backends and any persisted change must
 * touch both. This half proves the shape both branches implement (the marker on
 * the checklist row, the record in its own store, and the review stamp). The
 * Postgres half is the statement-shape suite below, plus the rolled-back
 * production validation that runs before shipping (HANDOFF §4).
 */
describe('quiet skip (file backend)', () => {
  const persisted = async () => JSON.parse(await readFile(localDataPath, 'utf8'))
  const authPersisted = async () => JSON.parse(await readFile(localAuthPath, 'utf8'))

  const skippableTemplate = {
    id: 'tmpl-skip',
    title: 'Monthly close',
    clientId: 'c1',
    assigneeId: 'emp-1',
    frequency: 'monthly',
    nextDueDate: '2026-08-31',
    active: true,
    skipAllowed: true,
    viewerIds: [],
    editorIds: [],
    stages: [],
  }

  const instance = (over = {}) => ({
    id: 'cl-1',
    title: 'Monthly close',
    clientId: 'c1',
    assigneeId: 'emp-1',
    templateId: 'tmpl-skip',
    dueDate: '2026-08-31',
    viewerIds: [],
    editorIds: [],
    items: [{ id: 'item-1', label: 'Reconcile', done: false }],
    ...over,
  })

  beforeEach(async () => {
    await store.write(
      workspace({ checklists: [instance()], checklistTemplates: [skippableTemplate] }),
    )
  })

  it('round-trips skipAllowed on the template', async () => {
    expect((await persisted()).checklistTemplates[0].skipAllowed).toBe(true)
  })

  it('stamps the instance without soft-deleting it', async () => {
    const updated = await store.skipChecklistInstance('cl-1', 'emp-1')
    expect(updated.skippedAt).toBeTruthy()
    expect(updated.skippedBy).toBe('emp-1')

    const row = (await persisted()).checklists.find((entry) => entry.id === 'cl-1')
    expect(row.skippedAt).toBeTruthy()
    // NOT a soft delete: the row must stay in the active list so the
    // materializer's identity tuple still sees it and does not respawn the
    // cycle that was deliberately stepped past.
    expect(row.deletedAt ?? null).toBeNull()
  })

  it('refuses to skip the same occurrence twice', async () => {
    expect(await store.skipChecklistInstance('cl-1', 'emp-1')).not.toBeNull()
    expect(await store.skipChecklistInstance('cl-1', 'emp-1')).toBeNull()
  })

  it('survives a bulk save — an autosave must not un-skip a task', async () => {
    await store.skipChecklistInstance('cl-1', 'emp-1')
    const stamped = (await persisted()).checklists[0].skippedAt

    // The owner's tab round-trips the workspace it was served.
    await store.write(
      workspace({
        checklists: [instance({ skippedAt: stamped, skippedBy: 'emp-1' })],
        checklistTemplates: [skippableTemplate],
      }),
    )

    expect((await persisted()).checklists[0].skippedAt).toBe(stamped)
  })

  it.each(['me', 'colleague', 'client'])(
    'persists the %s category with its note',
    async (category) => {
      const record = await store.createChecklistSkip({
        checklistId: 'cl-1',
        templateId: 'tmpl-skip',
        clientId: 'c1',
        title: 'Monthly close',
        skippedBy: 'emp-1',
        skippedByName: 'Lisa Chen',
        reasonCategory: category,
        reasonNote: 'Bank feed was down.',
      })

      const stored = (await authPersisted()).checklistSkips.find((entry) => entry.id === record.id)
      expect(stored.reasonCategory).toBe(category)
      expect(stored.reasonNote).toBe('Bank feed was down.')
      expect(stored.reviewedAt).toBeNull()
    },
  )

  it('lists skips newest first', async () => {
    const older = await store.createChecklistSkip({
      checklistId: 'cl-1',
      title: 'Older',
      reasonCategory: 'me',
      reasonNote: 'a',
    })
    // The file backend stamps from the clock, so force a distinguishable order.
    const authState = await authPersisted()
    const olderRecord = authState.checklistSkips.find((entry) => entry.id === older.id)
    olderRecord.skippedAt = '2026-01-01T00:00:00.000Z'
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))

    const newer = await store.createChecklistSkip({
      checklistId: 'cl-1',
      title: 'Newer',
      reasonCategory: 'client',
      reasonNote: 'b',
    })

    // Filtered to this test's two records: the auth-state file accumulates the
    // records earlier tests in this suite filed, and their order is not what
    // this test is about.
    const list = (await store.listChecklistSkips()).filter((entry) =>
      [older.id, newer.id].includes(entry.id),
    )
    expect(list.map((entry) => entry.id)).toEqual([newer.id, older.id])
  })

  it('reviewing stamps the record and keeps it forever', async () => {
    const record = await store.createChecklistSkip({
      checklistId: 'cl-1',
      title: 'Monthly close',
      reasonCategory: 'client',
      reasonNote: 'No statements.',
    })

    const reviewed = await store.reviewChecklistSkip(record.id, 'emp-owner')
    expect(reviewed.reviewedBy).toBe('emp-owner')
    expect(reviewed.reviewedAt).toBeTruthy()

    // Still there. Reviewing clears it from the DASHBOARD, never from the trail.
    const list = await store.listChecklistSkips()
    expect(list.find((entry) => entry.id === record.id)).toBeTruthy()
  })

  it('refuses to re-review a decision that was already made', async () => {
    const record = await store.createChecklistSkip({
      checklistId: 'cl-1',
      title: 'Monthly close',
      reasonCategory: 'me',
      reasonNote: 'Ran out of week.',
    })
    await store.reviewChecklistSkip(record.id, 'emp-owner')
    expect(await store.reviewChecklistSkip(record.id, 'emp-other')).toBeNull()
  })
})

/**
 * Quiet skip — the POSTGRES branch, at statement level.
 *
 * NEW SQL SHAPES, flagged for the rolled-back production validation:
 *   - alter table checklist_templates add column if not exists skip_allowed
 *       boolean not null default false
 *   - alter table checklists add column if not exists skipped_at timestamptz
 *   - alter table checklists add column if not exists skipped_by text
 *   - create table if not exists checklist_skips (...) + checklist_skips_skipped_at_idx
 *
 * The file backend cannot regress the two things pinned here — it has no
 * columns and no WHERE clause — so only a statement-level test catches them:
 * the skip UPDATE must be guarded on `skipped_at is null` (or a double-submit
 * files two records for one cycle), and the review UPDATE must be guarded on
 * `reviewed_at is null` (or a second owner overwrites the first one's decision).
 */
describe('quiet skip (postgres branch)', () => {
  it('guards the skip UPDATE so one cycle can only be skipped once', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).skipChecklistInstance('cl-1', 'emp-1')

    const [statement] = fake.matching(/^update checklists set skipped_at/i)
    expect(statement).toBeTruthy()
    expect(statement.text).toMatch(/skipped_at is null/i)
    // And never touches a row already in the recycle bin.
    expect(statement.text).toMatch(/deleted_at is null/i)
    expect(statement.params).toEqual(['cl-1', 'emp-1'])
  })

  it('inserts the audit record into checklist_skips with its category and note', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createChecklistSkip({
      checklistId: 'cl-1',
      templateId: 'tmpl-skip',
      clientId: 'c1',
      title: 'Monthly close',
      skippedBy: 'emp-1',
      skippedByName: 'Lisa Chen',
      reasonCategory: 'client',
      reasonNote: 'No statements.',
    })

    const [statement] = fake.matching(/insert into checklist_skips/i)
    expect(statement).toBeTruthy()
    expect(statement.params).toContain('client')
    expect(statement.params).toContain('No statements.')
    expect(statement.params).toContain('Monthly close')
  })

  it('guards the review UPDATE so a decision cannot be overwritten', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).reviewChecklistSkip('skip-1', 'emp-owner')

    const [statement] = fake.matching(/^update checklist_skips set reviewed_by/i)
    expect(statement).toBeTruthy()
    expect(statement.text).toMatch(/reviewed_at is null/i)
    expect(statement.params).toEqual(['skip-1', 'emp-owner'])
  })

  it('never issues a DELETE against checklist_skips — the trail is permanent', async () => {
    const fake = fakePostgres()
    const pgStore = postgresStore(fake)
    await pgStore.createChecklistSkip({
      checklistId: 'cl-1',
      title: 'Monthly close',
      reasonCategory: 'me',
      reasonNote: 'Ran out of week.',
    })
    await pgStore.reviewChecklistSkip('skip-1', 'emp-owner')

    expect(fake.matching(/delete from checklist_skips/i)).toHaveLength(0)
  })

  it('carries skipped_at / skipped_by through the bulk save', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(
      workspace({
        checklists: [
          {
            id: 'cl-1',
            title: 'Monthly close',
            clientId: 'c1',
            assigneeId: 'emp-1',
            dueDate: '2026-08-31',
            items: [],
            skippedAt: '2026-08-14T10:00:00.000Z',
            skippedBy: 'emp-1',
          },
        ],
      }),
    )

    const [statement] = fake.matching(/insert into checklists \(/i)
    expect(statement.text).toMatch(/skipped_at, skipped_by/i)
    expect(statement.params).toContain('2026-08-14T10:00:00.000Z')
  })

  it('carries skip_allowed through the bulk save, defaulting to false', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(
      workspace({
        checklistTemplates: [
          {
            id: 'tmpl-a',
            title: 'On',
            clientId: 'c1',
            assigneeId: 'emp-1',
            frequency: 'monthly',
            nextDueDate: '2026-08-31',
            active: true,
            skipAllowed: true,
            stages: [],
          },
          {
            id: 'tmpl-b',
            title: 'Unset',
            clientId: 'c1',
            assigneeId: 'emp-1',
            frequency: 'monthly',
            nextDueDate: '2026-08-31',
            active: true,
            stages: [],
          },
        ],
      }),
    )

    const inserts = fake.matching(/insert into checklist_templates/i)
    expect(inserts).toHaveLength(2)
    expect(inserts[0].text).toMatch(/skip_allowed/i)
    // Anything other than an explicit true is off — skipping is opt-in.
    expect(inserts[0].params.at(-2)).toBe(true)
    expect(inserts[1].params.at(-2)).toBe(false)
  })
})

/**
 * Ad hoc time and the ad hoc invoice line — the persistence half of
 * featreq-d0f2da14.
 *
 * The flag decides HOW a piece of time bills (its own line, at the employee's
 * rate, instead of inside the month's hours), so a backend that quietly drops
 * it changes money. Cardinal rule 1 applies in full: the file-backend contracts
 * are below, and the Postgres statement shapes are pinned underneath them,
 * because CI only ever runs the file branch.
 */
describe('ad hoc time entries (file backend)', () => {
  it('persists the flag and reads it back', async () => {
    const created = await store.createTimeEntry({
      employeeId: 'emp-1',
      clientId: 'c1',
      date: '2026-08-04',
      minutes: 30,
      description: 'Rush 1099 question',
      billable: true,
      isAdhoc: true,
      entryMethod: 'manual',
      manualReason: 'forgot the timer',
    })

    expect(created.isAdhoc).toBe(true)
    expect((await store.getTimeEntry(created.id)).isAdhoc).toBe(true)
    expect((await store.read()).timeEntries.find((e) => e.id === created.id).isAdhoc).toBe(true)
  })

  // Postgres has `not null default false`, so an entry logged without the flag
  // reads back as `false` there. The file backend has to say the same thing, or
  // a test passes on data production would never produce.
  it('stores a real false rather than nothing when the flag is not set', async () => {
    const created = await store.createTimeEntry({
      employeeId: 'emp-1',
      clientId: 'c1',
      date: '2026-08-04',
      minutes: 30,
      description: 'Scoped work',
      billable: true,
      entryMethod: 'timer',
    })
    expect(created.isAdhoc).toBe(false)
    expect((await store.getTimeEntry(created.id)).isAdhoc).toBe(false)
  })

  // The owner's backstop at review: flagging one that was missed, and taking
  // the flag off one that should never have had it.
  it('lets an update set and clear the flag', async () => {
    const created = await store.createTimeEntry({
      employeeId: 'emp-1',
      clientId: 'c1',
      date: '2026-08-04',
      minutes: 30,
      description: 'Scoped work',
      billable: true,
      entryMethod: 'timer',
    })

    expect((await store.updateTimeEntry(created.id, { isAdhoc: true })).isAdhoc).toBe(true)
    expect((await store.updateTimeEntry(created.id, { isAdhoc: false })).isAdhoc).toBe(false)
  })

  it('carries the flag onto every slice when the time is split across clients', async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.clients = [
      { id: 'c1', name: 'Acme' },
      { id: 'c2', name: 'Beta' },
    ]
    data.timeEntries = [
      {
        id: 't-adhoc',
        employeeId: 'emp-1',
        clientId: 'c1',
        date: '2026-08-04',
        minutes: 60,
        description: 'One-off cleanup for two clients',
        billable: true,
        isAdhoc: true,
        approvalStatus: 'approved',
        entryMethod: 'timer',
        sessions: [],
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const { created } = await store.splitTimeEntry(
      't-adhoc',
      [
        { clientId: 'c1', minutes: 30 },
        { clientId: 'c2', minutes: 30 },
      ],
      'emp-1',
      'grp-1',
      'even',
    )

    expect(created).toHaveLength(2)
    expect(created.every((slice) => slice.isAdhoc === true)).toBe(true)
  })
})

describe('ad hoc invoice lines (file backend)', () => {
  async function seedAdhocInvoice() {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-adhoc',
        clientId: 'c1',
        period: '2026-08',
        number: 'INV-2026-08-002',
        status: 'draft',
        lineItems: [
          { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
          {
            kind: 'adhoc',
            label: 'Adhoc — Rush 1099 question',
            detail: 'Aug 4, 2026 · Lisa · 0.50h at $100.00/hr',
            amount: 50,
            adhocMode: 'billed',
            adhocAmount: 50,
          },
        ],
        subtotal: 250,
        total: 250,
        dueDate: '2026-09-30',
        blurb: '',
        scopeFlags: [],
        sentAt: null,
        paidAt: null,
        paymentMethod: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  it('keeps the kind and the choice through a save', async () => {
    await seedAdhocInvoice()
    const updated = await store.updateInvoice('inv-adhoc', {
      lineItems: [
        { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
        {
          kind: 'adhoc',
          label: 'Adhoc — Rush 1099 question',
          detail: '',
          amount: 50,
          adhocMode: 'billed',
          adhocAmount: 50,
        },
      ],
    })

    expect(updated.lineItems[1]).toMatchObject({
      kind: 'adhoc',
      adhocMode: 'billed',
      adhocAmount: 50,
      amount: 50,
    })
    expect(updated.total).toBe(250)
  })

  // "Show detail only" — the line stays on the client's invoice, at nothing.
  it('zeroes a courtesy line and drops it out of the total', async () => {
    await seedAdhocInvoice()
    const updated = await store.updateInvoice('inv-adhoc', {
      lineItems: [
        { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
        {
          kind: 'adhoc',
          label: 'Adhoc — Rush 1099 question',
          detail: '',
          amount: 50,
          adhocMode: 'courtesy',
          adhocAmount: 50,
        },
      ],
    })

    expect(updated.lineItems[1].amount).toBe(0)
    // Held in reserve, which is what makes the choice reversible.
    expect(updated.lineItems[1].adhocAmount).toBe(50)
    expect(updated.total).toBe(200)
  })

  // An omitted line is worth nothing and still has to SURVIVE, or she could
  // never put it back.
  it('keeps an omitted line on the draft at zero', async () => {
    await seedAdhocInvoice()
    const updated = await store.updateInvoice('inv-adhoc', {
      lineItems: [
        { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
        {
          kind: 'adhoc',
          label: 'Adhoc — Rush 1099 question',
          detail: '',
          amount: 0,
          adhocMode: 'omitted',
          adhocAmount: 50,
        },
      ],
    })

    expect(updated.lineItems).toHaveLength(2)
    expect(updated.lineItems[1]).toMatchObject({ adhocMode: 'omitted', amount: 0, adhocAmount: 50 })
    expect(updated.total).toBe(200)
  })

  // She overtyped the figure. The reserve follows it, so flipping the line to
  // courtesy and back gives her number back rather than the rate calculation's.
  it('lets the owner overtype a billed amount, and remembers it', async () => {
    await seedAdhocInvoice()
    const overtyped = await store.updateInvoice('inv-adhoc', {
      lineItems: [
        {
          kind: 'adhoc',
          label: 'Adhoc — Rush 1099 question',
          detail: '',
          amount: 40,
          adhocMode: 'billed',
          adhocAmount: 50,
        },
      ],
    })
    expect(overtyped.lineItems[0]).toMatchObject({ amount: 40, adhocAmount: 40 })
  })

  // The line at $0.00 is $0.00 BY DECISION and still holds what it would
  // charge. Resting its survival on the label alone meant clearing that box
  // deleted the reserve for good.
  it('keeps a courtesy line whose label was cleared', async () => {
    await seedAdhocInvoice()
    const updated = await store.updateInvoice('inv-adhoc', {
      lineItems: [
        { kind: 'adhoc', label: '', detail: '', amount: 0, adhocMode: 'courtesy', adhocAmount: 50 },
      ],
    })

    expect(updated.lineItems).toHaveLength(1)
    expect(updated.lineItems[0].adhocAmount).toBe(50)
  })

  // ...but a genuinely empty row still goes, adhoc or not.
  it('still drops an adhoc row with nothing on it at all', async () => {
    await seedAdhocInvoice()
    const updated = await store.updateInvoice('inv-adhoc', {
      lineItems: [
        { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
        { kind: 'adhoc', label: '', detail: '', amount: 0, adhocMode: 'omitted', adhocAmount: 0 },
      ],
    })

    expect(updated.lineItems).toHaveLength(1)
  })

  it('reads a line with no stated choice as billed', async () => {
    await seedAdhocInvoice()
    const updated = await store.updateInvoice('inv-adhoc', {
      lineItems: [{ kind: 'adhoc', label: 'Adhoc — legacy', detail: '', amount: 25 }],
    })
    expect(updated.lineItems[0]).toMatchObject({ adhocMode: 'billed', amount: 25, adhocAmount: 25 })
  })
})

describe('ad hoc time on the postgres branch', () => {
  it('writes is_adhoc on create', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createTimeEntry({
      employeeId: 'emp-1',
      clientId: 'c1',
      date: '2026-08-04',
      minutes: 30,
      description: 'Rush 1099 question',
      billable: true,
      isAdhoc: true,
      entryMethod: 'timer',
    })

    const inserts = fake.matching(/insert into time_entries/i)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].text).toMatch(/is_administrative,\s*is_adhoc/i)
    // Positional, one past is_administrative. `toContain(true)` would pass on
    // the fixture's `billable: true` no matter where the flag actually landed.
    expect(inserts[0].params[13]).toBe(true)
  })

  it('writes is_adhoc on the bulk save, defaulting to false', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(
      workspace({
        timeEntries: [
          {
            id: 't1',
            employeeId: 'emp-1',
            clientId: 'c1',
            date: '2026-08-04',
            minutes: 30,
            isAdhoc: true,
          },
          {
            id: 't2',
            employeeId: 'emp-1',
            clientId: 'c1',
            date: '2026-08-05',
            minutes: 30,
          },
        ],
      }),
    )

    const inserts = fake.matching(/insert into time_entries/i)
    expect(inserts).toHaveLength(2)
    expect(inserts[0].text).toMatch(/is_administrative,\s*\n?\s*is_adhoc/i)
    // Positional, one past is_administrative — the bug this catches is a value
    // landing in the wrong column when someone adds the next one.
    expect(inserts[0].params[16]).toBe(true)
    expect(inserts[1].params[16]).toBe(false)
  })

  it('sets is_adhoc when an update carries it', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).updateTimeEntry('t1', { isAdhoc: true })

    const updates = fake.matching(/update time_entries set/i)
    expect(updates).toHaveLength(1)
    expect(updates[0].text).toMatch(/is_adhoc = \$2/)
    expect(updates[0].params).toEqual(['t1', true])
  })
})

/**
 * Retainers — the invoice at the start of an engagement, and the credit that
 * gives it back at the end.
 *
 * Two invariants live here, and both are about a SECOND ROW rather than about
 * arithmetic (the arithmetic is pinned in lib/retainer-invoicing.test.mjs):
 *
 *   1. The unique index learned kinds. It used to say "one live invoice per
 *      (client, period)", which would have refused a retainer issued in a month
 *      the client already had an invoice for — and `_insertInvoice` reads a
 *      refusal as "someone else got there first", so it would have been silent.
 *   2. A retainer can be spent ONCE. The fact lives on the retainer row
 *      (`appliedToInvoiceId`), set and cleared by the save that adds or removes
 *      the credit line, so there is no window where the two disagree.
 */
describe('retainer invoices (file backend)', () => {
  const period = '2026-08'

  async function seedClients() {
    await store.write(
      workspace({
        clients: [
          {
            id: 'c1',
            name: 'Acme',
            billingMode: 'hourly',
            hourlyRate: 100,
            paymentTerms: 'Net 30',
          },
          { id: 'c2', name: 'Globex', billingMode: 'hourly', hourlyRate: 100 },
        ],
        timeEntries: [],
      }),
    )
  }

  async function storedInvoices() {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.invoices ?? []
  }

  it('issues a draft with its own kind, number and line', async () => {
    await seedClients()
    const retainer = await store.createRetainerInvoice({
      clientId: 'c1',
      amount: 2500,
      note: 'Signed 2026-08-12',
      period,
    })

    expect(retainer).toMatchObject({
      clientId: 'c1',
      period,
      kind: 'retainer',
      status: 'draft',
      number: 'INV-RET-2026-001',
      subtotal: 2500,
      total: 2500,
      appliedToInvoiceId: null,
    })
    expect(retainer.lineItems).toEqual([
      { kind: 'retainer', label: 'Retainer', detail: 'Signed 2026-08-12', amount: 2500 },
    ])
  })

  it('refuses an amount that is not real money', async () => {
    await seedClients()
    expect(await store.createRetainerInvoice({ clientId: 'c1', amount: 0 })).toBeNull()
    expect(await store.createRetainerInvoice({ clientId: 'c1', amount: -50 })).toBeNull()
    expect(await store.createRetainerInvoice({ clientId: 'c1', amount: 'lots' })).toBeNull()
    expect(await store.createRetainerInvoice({ clientId: 'ghost', amount: 500 })).toBeNull()
    expect(await storedInvoices()).toHaveLength(0)
  })

  it('continues the retainer sequence across clients and months', async () => {
    await seedClients()
    await store.createRetainerInvoice({ clientId: 'c1', amount: 500, period: '2026-08' })
    const second = await store.createRetainerInvoice({
      clientId: 'c2',
      amount: 500,
      period: '2026-09',
    })
    expect(second.number).toBe('INV-RET-2026-002')
  })

  // The landmine. Before the index learned kinds this insert came back null and
  // the retainer simply never appeared.
  it('coexists with the same client monthly invoice for the same month', async () => {
    await seedClients()
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-monthly',
        clientId: 'c1',
        period,
        number: 'INV-2026-08-001',
        kind: 'monthly',
        status: 'draft',
        lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
        subtotal: 400,
        total: 400,
        dueDate: null,
        blurb: '',
        scopeFlags: [],
        sentAt: null,
        paidAt: null,
        paymentMethod: null,
        appliedToInvoiceId: null,
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const retainer = await store.createRetainerInvoice({ clientId: 'c1', amount: 2500, period })
    expect(retainer).not.toBeNull()
    expect(await storedInvoices()).toHaveLength(2)
  })

  // A second engagement is a second retainer. Nothing about them is unique.
  it('allows two live retainers for one client', async () => {
    await seedClients()
    expect(
      await store.createRetainerInvoice({ clientId: 'c1', amount: 500, period }),
    ).not.toBeNull()
    expect(
      await store.createRetainerInvoice({ clientId: 'c1', amount: 750, period }),
    ).not.toBeNull()
    expect(await storedInvoices()).toHaveLength(2)
  })

  // The other half of the same rule: MONTHLY invoices are still unique, and a
  // retainer in the month must not be mistaken for one.
  it('still refuses a second live monthly invoice, and builds one beside a retainer', async () => {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 }],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [
          {
            id: 't1',
            employeeId: 'emp-1',
            clientId: 'c1',
            date: '2026-08-04',
            minutes: 120,
            billable: true,
            approvalStatus: 'approved',
          },
        ],
      }),
    )
    await store.createRetainerInvoice({ clientId: 'c1', amount: 2500, period })

    // The retainer does not count as "already billed for August".
    const first = await store.generateInvoicesForPeriod(period)
    expect(first.created).toHaveLength(1)
    expect(first.created[0].kind).toBe('monthly')

    // ...but the monthly invoice it just made does.
    const second = await store.generateInvoicesForPeriod(period)
    expect(second.created).toHaveLength(0)
    expect(second.skipped).toEqual([{ clientId: 'c1', reason: 'already-generated' }])
  })

  // "Void & regenerate" only rebuilds MONTHLY invoices, so voiding a hand-issued
  // retainer would throw it away with nothing to put it back.
  it('leaves a draft retainer alone when the month is regenerated', async () => {
    await seedClients()
    const retainer = await store.createRetainerInvoice({ clientId: 'c1', amount: 2500, period })

    const result = await store.voidUnsentInvoicesForPeriod(period)

    expect(result.voided).toBe(0)
    expect((await store.listInvoices()).find((i) => i.id === retainer.id).status).toBe('draft')
  })

  it('reads a row written before the columns existed as an unapplied monthly invoice', async () => {
    await seedClients()
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-legacy',
        clientId: 'c1',
        period,
        number: 'INV-2026-08-001',
        status: 'sent',
        lineItems: [],
        subtotal: 0,
        total: 0,
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const [legacy] = await store.listInvoices()
    expect(legacy.kind).toBe('monthly')
    expect(legacy.appliedToInvoiceId).toBeNull()
  })
})

describe('applying a retainer credit (file backend)', () => {
  const period = '2026-08'
  const hoursLine = { kind: 'hourly', label: 'Billable hours', detail: '', amount: 600 }

  function invoiceRow(id, overrides = {}) {
    return {
      id,
      clientId: 'c1',
      period,
      number: id,
      kind: 'monthly',
      status: 'draft',
      lineItems: [{ ...hoursLine }],
      subtotal: 600,
      total: 600,
      dueDate: null,
      blurb: '',
      scopeFlags: [],
      sentAt: null,
      paidAt: null,
      paymentMethod: null,
      appliedToInvoiceId: null,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      ...overrides,
    }
  }

  function retainerRow(overrides = {}) {
    return invoiceRow('inv-ret', {
      kind: 'retainer',
      number: 'INV-RET-2026-001',
      status: 'paid',
      period: '2026-01',
      lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
      subtotal: 500,
      total: 500,
      ...overrides,
    })
  }

  /** The line the editor sends. Its amount is a PREVIEW — the server re-sizes it. */
  function creditLine(amount = -500, retainerInvoiceId = 'inv-ret') {
    return {
      kind: 'retainer_credit',
      label: 'Retainer applied — credit',
      detail: 'Retainer INV-RET-2026-001',
      amount,
      retainerInvoiceId,
    }
  }

  async function seed(rows) {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 },
          { id: 'c2', name: 'Globex', billingMode: 'hourly', hourlyRate: 100 },
        ],
        timeEntries: [],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = rows
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  const byId = async (id) => (await store.listInvoices()).find((invoice) => invoice.id === id)

  it('records the application on the retainer, not just on the lines', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])

    const updated = await store.updateInvoice('inv-final', {
      lineItems: [{ ...hoursLine }, creditLine()],
    })

    expect(updated.total).toBe(100)
    // The subtotal is what the month was WORTH; the credit sits outside it.
    expect(updated.subtotal).toBe(600)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-final')
  })

  it('is offered only while it is unspent', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])
    expect(await store.listUnappliedRetainers()).toHaveLength(1)

    await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] })

    expect(await store.listUnappliedRetainers()).toHaveLength(0)
  })

  it('a retainer that was only SENT is not on offer, and cannot be credited', async () => {
    await seed([retainerRow({ status: 'sent' }), invoiceRow('inv-final')])
    expect(await store.listUnappliedRetainers()).toHaveLength(0)

    await expect(
      store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] }),
    ).rejects.toThrow(/not been paid/i)
  })

  // NEVER TWICE. The second invoice's save is refused outright rather than
  // quietly crediting money that has already been given back.
  it('refuses a second invoice trying to spend the same retainer', async () => {
    await seed([retainerRow(), invoiceRow('inv-final'), invoiceRow('inv-other')])
    await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] })

    await expect(
      store.updateInvoice('inv-other', { lineItems: [{ ...hoursLine }, creditLine()] }),
    ).rejects.toThrow(/already been applied/i)

    // And nothing of that save survived.
    expect((await byId('inv-other')).total).toBe(600)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-final')
  })

  it('lets the SAME invoice be saved again without tripping the never-twice rule', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])
    await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] })

    const again = await store.updateInvoice('inv-final', {
      lineItems: [{ ...hoursLine }, creditLine()],
      blurb: 'Final invoice — thank you!',
    })

    expect(again.total).toBe(100)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-final')
  })

  // Removing the line hands the money back, on the same save. Symmetric with
  // applying it — she can change her mind about which invoice is the last one.
  it('frees the retainer when the credit line is removed', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])
    await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] })

    const cleared = await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }] })

    expect(cleared.total).toBe(600)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBeNull()
    expect(await store.listUnappliedRetainers()).toHaveLength(1)
  })

  // The floor, enforced server-side rather than trusted from the page.
  it('clamps the credit to what the invoice comes to', async () => {
    const small = { kind: 'hourly', label: 'Billable hours', detail: '', amount: 200 }
    await seed([
      retainerRow(),
      invoiceRow('inv-small', { lineItems: [{ ...small }], subtotal: 200, total: 200 }),
    ])

    const updated = await store.updateInvoice('inv-small', {
      lineItems: [{ ...small }, creditLine(-500)],
    })

    expect(updated.lineItems[1].amount).toBe(-200)
    expect(updated.total).toBe(0)
  })

  it('ignores an amount the page made up', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])

    const updated = await store.updateInvoice('inv-final', {
      lineItems: [{ ...hoursLine }, creditLine(-9999)],
    })

    expect(updated.lineItems[1].amount).toBe(-500)
    expect(updated.total).toBe(100)
  })

  it('refuses a retainer belonging to somebody else', async () => {
    await seed([retainerRow({ clientId: 'c2' }), invoiceRow('inv-final')])

    await expect(
      store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] }),
    ).rejects.toThrow(/different client/i)
  })

  it('refuses a credit naming a retainer we do not hold', async () => {
    await seed([invoiceRow('inv-final')])

    await expect(
      store.updateInvoice('inv-final', {
        lineItems: [{ ...hoursLine }, creditLine(-500, 'inv-nope')],
      }),
    ).rejects.toThrow(/does not name a retainer/i)
  })

  it('refuses two credits on one invoice', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])

    await expect(
      store.updateInvoice('inv-final', {
        lineItems: [{ ...hoursLine }, creditLine(), creditLine()],
      }),
    ).rejects.toThrow(/only one retainer credit/i)
  })

  it('refuses a credit on an invoice with nothing left to credit', async () => {
    await seed([retainerRow(), invoiceRow('inv-empty', { lineItems: [], subtotal: 0, total: 0 })])

    await expect(
      store.updateInvoice('inv-empty', { lineItems: [creditLine()] }),
    ).rejects.toThrow(/nothing on this invoice left to credit/i)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBeNull()
  })

  it('keeps the retainer id through a save, so removing the line can find it', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])

    const updated = await store.updateInvoice('inv-final', {
      lineItems: [{ ...hoursLine }, creditLine()],
    })

    expect(updated.lineItems[1].retainerInvoiceId).toBe('inv-ret')
  })
})

describe('retainer writes on the postgres branch', () => {
  const finalRow = {
    id: 'inv-final',
    client_id: 'c1',
    period: '2026-08',
    number: 'INV-2026-08-001',
    kind: 'monthly',
    status: 'draft',
    line_items: [{ kind: 'hourly', label: 'Hours', detail: '', amount: 600 }],
    subtotal: 600,
    total: 600,
  }
  const retainerRow = {
    id: 'inv-ret',
    client_id: 'c1',
    period: '2026-01',
    number: 'INV-RET-2026-001',
    kind: 'retainer',
    status: 'paid',
    line_items: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
    subtotal: 500,
    total: 500,
  }

  it('scopes the live-invoice index to monthly, dropping the old one first', async () => {
    const fake = fakePostgres()
    // `initialize()` issues the DDL and then seeds. The fake answers every
    // select with nothing, so the SEEDING half throws — by which point the DDL
    // has already been issued, and the DDL is the whole point here.
    await postgresStore(fake)
      .initialize()
      .catch(() => {})

    expect(fake.matching(/alter table invoices add column if not exists kind text/i)).toHaveLength(
      1,
    )
    expect(
      fake.matching(/alter table invoices add column if not exists applied_to_invoice_id/i),
    ).toHaveLength(1)
    // Order matters: a new index created while the strict one still exists
    // would never get a chance to be the rule.
    const dropped = fake.indexOf(/drop index if exists invoices_client_period_live/i)
    const created = fake.indexOf(
      /create unique index if not exists invoices_client_period_monthly_live/i,
    )
    expect(dropped).toBeGreaterThan(-1)
    expect(created).toBeGreaterThan(dropped)
    expect(fake.statements[created].text).toMatch(/where kind = 'monthly' and status <> 'void'/i)
  })

  it('names the same predicate on the insert, so a retainer can never conflict', async () => {
    const fake = fakePostgres()
    await postgresStore(fake)._insertInvoice({
      id: 'inv-ret',
      clientId: 'c1',
      period: '2026-08',
      number: 'INV-RET-2026-001',
      kind: 'retainer',
      status: 'draft',
      lineItems: [],
      subtotal: 500,
      total: 500,
      dueDate: null,
      blurb: '',
      scopeFlags: [],
    })

    const inserts = fake.matching(/insert into invoices/i)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].text).toMatch(
      /on conflict \(client_id, period\) where kind = 'monthly' and status <> 'void'/i,
    )
    // Positional, one past `number` — the bug this catches is the kind landing
    // in the status column when someone adds the next one.
    expect(inserts[0].params[4]).toBe('retainer')
  })

  it('marks the retainer inside the same transaction as the lines', async () => {
    const fake = fakePostgres({ invoices: [finalRow, retainerRow] })

    await postgresStore(fake).updateInvoice('inv-final', {
      lineItems: [
        { kind: 'hourly', label: 'Hours', detail: '', amount: 600 },
        {
          kind: 'retainer_credit',
          label: 'Retainer applied — credit',
          detail: '',
          amount: -500,
          retainerInvoiceId: 'inv-ret',
        },
      ],
    })

    const begin = fake.indexOf(/^BEGIN$/i)
    const applied = fake.indexOf(/set applied_to_invoice_id = \$2/i)
    const commit = fake.indexOf(/^COMMIT$/i)
    expect(begin).toBeGreaterThan(-1)
    expect(applied).toBeGreaterThan(begin)
    expect(commit).toBeGreaterThan(applied)
    // The never-twice rule as a WHERE clause: two racing saves both read the
    // column as null, and only the one that gets here first matches a row.
    expect(fake.statements[applied].text).toMatch(
      /applied_to_invoice_id is null or applied_to_invoice_id = \$2/i,
    )
    expect(fake.statements[applied].params).toEqual(['inv-ret', 'inv-final'])
  })

  // An ordinary edit used to be a single statement outside any transaction.
  // It is no longer, and the reason is the review-event capture: the record of
  // what she changed has to land with the change or not at all. What still
  // holds — and is what this test was really about — is that no RETAINER
  // statement is issued for an edit that moves no credit.
  it('moves no retainer on an ordinary edit, and records the edit with it', async () => {
    const fake = fakePostgres({ invoices: [finalRow] })

    await postgresStore(fake).updateInvoice('inv-final', { blurb: 'Thank you!' })

    expect(fake.matching(/set applied_to_invoice_id/i)).toHaveLength(0)
    const update = fake.indexOf(/^update invoices\s+set line_items/i)
    const event = fake.indexOf(/^insert into invoice_review_events/i)
    const commit = fake.indexOf(/^COMMIT$/i)
    expect(update).toBeGreaterThan(fake.indexOf(/^BEGIN$/i))
    expect(event).toBeGreaterThan(update)
    expect(commit).toBeGreaterThan(event)
  })

  // A save that rewrites the same values is not an edit. No event, and
  // therefore nothing needing a transaction — the single-statement path stays.
  it('leaves a no-op save as one statement, with no transaction at all', async () => {
    const fake = fakePostgres({ invoices: [finalRow] })

    await postgresStore(fake).updateInvoice('inv-final', {})

    expect(fake.matching(/^BEGIN$/i)).toHaveLength(0)
    expect(fake.matching(/^insert into invoice_review_events/i)).toHaveLength(0)
  })

  it('carries kind and the applied fact through the bulk-save restore', async () => {
    const fake = fakePostgres({
      invoices: [
        {
          ...retainerRow,
          scope_flags: [],
          email_log: [],
          applied_to_invoice_id: 'inv-final',
          created_at: '2026-01-05T00:00:00.000Z',
        },
      ],
    })
    await postgresStore(fake).write(workspace())

    const restores = fake.matching(/insert into invoices \(/i)
    expect(restores).toHaveLength(1)
    expect(restores[0].text).toMatch(/number, kind, status/i)
    expect(restores[0].text).toMatch(
      /email_log, applied_to_invoice_id, original_line_items, created_at/i,
    )
    // A retainer that came back as 'monthly' would collide with that client's
    // real invoice on the very next generate; one that came back unapplied
    // would be spendable a second time.
    expect(restores[0].params[4]).toBe('retainer')
    expect(restores[0].params[19]).toBe('inv-final')
  })
})

/**
 * The lifecycle edges of a retainer credit — what happens when the invoice
 * holding it, or the retainer behind it, moves on.
 *
 * The invariant is that a retainer is in exactly ONE of two states at all times:
 * on account, or spent on a live invoice. Every test here is a way the pair
 * could otherwise end up in a third state — spent on a document nobody is
 * paying, where the money is neither creditable nor recoverable and nothing on
 * screen would ever say so.
 */
describe('retainer credits at the lifecycle edges (file backend)', () => {
  const period = '2026-08'
  const hoursLine = { kind: 'hourly', label: 'Billable hours', detail: '', amount: 600 }

  function invoiceRow(id, overrides = {}) {
    return {
      id,
      clientId: 'c1',
      period,
      number: id,
      kind: 'monthly',
      status: 'draft',
      lineItems: [{ ...hoursLine }],
      subtotal: 600,
      total: 600,
      dueDate: null,
      blurb: '',
      scopeFlags: [],
      sentAt: null,
      paidAt: null,
      paymentMethod: null,
      appliedToInvoiceId: null,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      ...overrides,
    }
  }

  function retainerRow(overrides = {}) {
    return invoiceRow('inv-ret', {
      kind: 'retainer',
      number: 'INV-RET-2026-001',
      status: 'paid',
      period: '2026-01',
      lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
      subtotal: 500,
      total: 500,
      ...overrides,
    })
  }

  function creditLine(amount = -500, retainerInvoiceId = 'inv-ret') {
    return {
      kind: 'retainer_credit',
      label: 'Retainer applied — credit',
      detail: 'Retainer INV-RET-2026-001',
      amount,
      retainerInvoiceId,
    }
  }

  async function seed(rows) {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 }],
        timeEntries: [],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = rows
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  const byId = async (id) => (await store.listInvoices()).find((invoice) => invoice.id === id)

  // ---- Voiding the invoice hands the retainer back -------------------------

  it('frees the retainer when the invoice holding it is voided', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])
    await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] })
    expect(await store.listUnappliedRetainers()).toHaveLength(0)

    await store.updateInvoice('inv-final', { status: 'void' })

    expect((await byId('inv-ret')).appliedToInvoiceId).toBeNull()
    expect(await store.listUnappliedRetainers()).toHaveLength(1)
  })

  // The likeliest way a credited invoice gets voided: she rebuilds the month.
  it('frees the retainer when the month is voided and regenerated', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])
    await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] })

    const result = await store.voidUnsentInvoicesForPeriod(period)

    expect(result.voided).toBe(1)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBeNull()
    expect(await store.listUnappliedRetainers()).toHaveLength(1)
  })

  it('leaves a retainer spent on an invoice in ANOTHER month alone', async () => {
    await seed([
      retainerRow(),
      invoiceRow('inv-july', { period: '2026-07' }),
      invoiceRow('inv-final'),
    ])
    await store.updateInvoice('inv-july', { lineItems: [{ ...hoursLine }, creditLine()] })

    await store.voidUnsentInvoicesForPeriod(period)

    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-july')
  })

  // ---- Review comes before the money moves ---------------------------------

  it('refuses a NEW credit on an invoice that has already gone out', async () => {
    await seed([retainerRow(), invoiceRow('inv-sent', { status: 'sent' })])

    await expect(
      store.updateInvoice('inv-sent', { lineItems: [{ ...hoursLine }, creditLine()] }),
    ).rejects.toThrow(/draft or reviewed/i)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBeNull()
  })

  // ...but a credit that was applied BEFORE the invoice went out travels with
  // it. Re-checking the status on every later save would make a legitimately
  // credited invoice unsaveable the moment it was sent.
  it('keeps saving an invoice that already carried its credit when it went out', async () => {
    await seed([
      retainerRow({ appliedToInvoiceId: 'inv-sent' }),
      invoiceRow('inv-sent', {
        status: 'sent',
        lineItems: [{ ...hoursLine }, creditLine()],
        total: 100,
      }),
    ])

    const updated = await store.updateInvoice('inv-sent', {
      lineItems: [{ ...hoursLine }, creditLine()],
      blurb: 'Thanks for a great year.',
    })

    expect(updated.total).toBe(100)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-sent')
  })

  // Same rule, the other side: the RETAINER's own status is only a bar to
  // spending it, not to saving an invoice that already spent it.
  it('keeps saving a credited invoice after the retainer’s status moves on', async () => {
    await seed([
      retainerRow({ appliedToInvoiceId: 'inv-final', status: 'overdue' }),
      invoiceRow('inv-final', { lineItems: [{ ...hoursLine }, creditLine()], total: 100 }),
    ])

    const updated = await store.updateInvoice('inv-final', {
      lineItems: [{ ...hoursLine }, creditLine()],
    })

    expect(updated.total).toBe(100)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-final')
  })

  // ---- An unrelated PATCH is not a statement about the credit --------------

  it('marks a credited invoice reviewed even when its retainer was voided', async () => {
    await seed([
      retainerRow({ appliedToInvoiceId: 'inv-final', status: 'void' }),
      invoiceRow('inv-final', { lineItems: [{ ...hoursLine }, creditLine()], total: 100 }),
    ])

    const updated = await store.updateInvoice('inv-final', {
      blurb: 'Final invoice — thank you!',
    })

    expect(updated.blurb).toBe('Final invoice — thank you!')
    expect(updated.total).toBe(100)
    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-final')
  })

  it('still settles the credit when the save DOES carry lines', async () => {
    await seed([retainerRow(), invoiceRow('inv-final')])

    await store.updateInvoice('inv-final', { lineItems: [{ ...hoursLine }, creditLine()] })

    expect((await byId('inv-ret')).appliedToInvoiceId).toBe('inv-final')
  })

  // ---- Voiding a spent retainer is refused, with somewhere to go -----------

  it('refuses to void a retainer that has been given back, and says where', async () => {
    await seed([
      retainerRow({ appliedToInvoiceId: 'inv-final' }),
      invoiceRow('inv-final', { number: 'INV-2026-08-004' }),
    ])

    await expect(store.updateInvoice('inv-ret', { status: 'void' })).rejects.toThrow(
      /applied to INV-2026-08-004 — remove the credit from that invoice first/i,
    )
    expect((await byId('inv-ret')).status).toBe('paid')
  })

  it('voids a retainer that is still on account', async () => {
    await seed([retainerRow()])
    expect((await store.updateInvoice('inv-ret', { status: 'void' })).status).toBe('void')
  })

  // ---- Kinds that do not belong on this document --------------------------

  it('will not let a monthly invoice claim a retainer LINE', async () => {
    await seed([invoiceRow('inv-final')])

    const updated = await store.updateInvoice('inv-final', {
      lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 2500 }],
    })

    // Demoted, not dropped — the charge survives as an ordinary line rather
    // than the save failing on her.
    expect(updated.lineItems[0]).toMatchObject({ kind: 'custom', amount: 2500 })
  })

  // Seeded as a DRAFT deliberately. What this pins is the line-kind sanitizer —
  // that 'retainer' survives on a retainer invoice where a monthly one demotes
  // it — and `retainerRow()` merely happens to default to paid because that is
  // the realistic state to find one in. Since the paid lock (featreq-ead3a215)
  // that default would refuse the save before the sanitizer ever ran, and the
  // test would be passing for the wrong reason. The paid case is its own test
  // below.
  it('keeps the retainer line on an actual retainer invoice', async () => {
    await seed([retainerRow({ appliedToInvoiceId: null, status: 'draft' })])

    const updated = await store.updateInvoice('inv-ret', {
      lineItems: [{ kind: 'retainer', label: 'Retainer', detail: 'Signed', amount: 2500 }],
    })

    expect(updated.lineItems[0].kind).toBe('retainer')
  })

  /**
   * The retainer half of Brittany's rule, and the reason it needed no separate
   * calculation. A retainer must be PAID before it can be credited anywhere
   * (`listUnappliedRetainers`), and this is what stops its total moving after
   * that — so the credit on the final invoice can never drift away from the
   * money that actually came in.
   */
  it('refuses to re-price a retainer once it has been paid', async () => {
    await seed([retainerRow({ appliedToInvoiceId: null })])

    await expect(
      store.updateInvoice('inv-ret', {
        lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 2000 }],
      }),
    ).rejects.toBeInstanceOf(InvoiceLockedError)

    // The figure a future credit would be sized from is untouched.
    expect((await byId('inv-ret')).total).toBe(500)
  })

  it('refuses to credit a retainer against another retainer', async () => {
    await seed([
      retainerRow(),
      retainerRow({ id: 'inv-ret-2', number: 'INV-RET-2026-002', status: 'draft' }),
    ])

    await expect(
      store.updateInvoice('inv-ret-2', {
        lineItems: [
          { kind: 'retainer', label: 'Retainer', detail: '', amount: 500 },
          creditLine(),
        ],
      }),
    ).rejects.toThrow(/belongs on a monthly invoice/i)
  })
})

describe('retainer lifecycle edges on the postgres branch', () => {
  it('swaps the index inside one transaction, so uniqueness is never off', async () => {
    const fake = fakePostgres()
    // See the sibling DDL test: the seeding half of initialize() throws against
    // a fake that answers every select with nothing. The DDL has already run.
    await postgresStore(fake)
      .initialize()
      .catch(() => {})

    const dropped = fake.indexOf(/drop index if exists invoices_client_period_live/i)
    const created = fake.indexOf(
      /create unique index if not exists invoices_client_period_monthly_live/i,
    )
    expect(dropped).toBeGreaterThan(-1)
    // ADJACENT, not merely ordered: between the drop and the create there is no
    // index enforcing one live invoice per client per month, and this is the
    // invoice of record. `create index` is transactional in Postgres, so the gap
    // can simply be closed — and nothing may be issued inside it.
    expect(fake.statements[dropped - 1].text).toMatch(/^BEGIN$/i)
    expect(created).toBe(dropped + 1)
    expect(fake.statements[created + 1].text).toMatch(/^COMMIT$/i)
  })

  it('frees the stranded retainers in the same transaction as the voids', async () => {
    const fake = fakePostgres({ invoices: [{ id: 'inv-final' }] })
    await postgresStore(fake).voidUnsentInvoicesForPeriod('2026-08')

    const voided = fake.indexOf(/set status = 'void'/i)
    const freed = fake.indexOf(/set applied_to_invoice_id = null/i)
    const begin = fake.indexOf(/^BEGIN$/i)
    const commit = fake.indexOf(/^COMMIT$/i)

    expect(begin).toBeLessThan(voided)
    expect(freed).toBeGreaterThan(voided)
    expect(commit).toBeGreaterThan(freed)
    // Scoped to exactly the ids that were just voided — a retainer spent on a
    // live invoice in another month must not be handed back.
    expect(fake.statements[freed].text).toMatch(/applied_to_invoice_id = any\(\$1::text\[\]\)/i)
    expect(fake.statements[freed].params).toEqual([['inv-final']])
  })

  it('does not run the freeing statement when nothing was voided', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).voidUnsentInvoicesForPeriod('2026-08')

    expect(fake.matching(/set applied_to_invoice_id = null/i)).toHaveLength(0)
  })
})

/**
 * `read()`'s materializer write-back is GUARDED.
 *
 * The write-back is a full bulk save (wipe-and-reinsert of every workspace
 * table), and it used to run with no `expectedVersion` at all — so anything
 * created between read()'s snapshot and its write-back (a waiting-on entry, a
 * checklist edit, a time entry) was silently erased whenever a new recurring
 * cycle happened to spawn on the same page load. That was the one honest
 * asterisk on "nothing removes a saved wait": the record IS permanent, unless
 * the materializer's unguarded write-back raced you.
 *
 * The contract now: read() fingerprints the persisted workspace, re-reads, and
 * hands the fingerprint to write(). If anything landed in between, the
 * write-back is REFUSED (StaleWorkspaceError, nothing written), the freshly
 * materialized data is served from memory, and the next read retries. A
 * refused write-back loses nothing — a skipped spawn re-spawns; an erased wait
 * is gone forever.
 *
 * Scope: the fingerprint covers BULK_SAVE_SLICES + employees
 * (lib/workspace-version.js). A mid-read write to a slice OUTSIDE that set
 * (invoices, firmSettings, serviceCategories) does not move it, so on the
 * FILE backend such a write is still overwritten by the whole-file save.
 * Postgres doesn't share that hole — its write() only touches the
 * fingerprinted tables and restores invoices explicitly.
 */
describe("read()'s materializer write-back is guarded (file backend)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The materializer compares date-only strings from toISOString(), so "due
  // yesterday, UTC" is always <= today and the template spawns on next read.
  const utcDaysAgo = (days) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const spawnableWorkspace = () =>
    workspace({
      clients: [{ id: 'c1', name: 'Acme' }],
      checklists: [
        {
          id: 'chk-1',
          title: 'Existing task',
          clientId: 'c1',
          assigneeId: 'emp-1',
          templateId: null,
          frequency: 'once',
          dueDate: utcDaysAgo(1),
          caseId: 'chk-1',
          stageId: null,
          stageIndex: 0,
          stageCount: 1,
          items: [{ id: 'item-1', label: 'Reconcile the bank feed', done: false }],
        },
      ],
      checklistTemplates: [
        {
          id: 'tpl-1',
          title: 'Monthly bookkeeping',
          clientId: 'c1',
          assigneeId: 'emp-1',
          frequency: 'monthly',
          nextDueDate: utcDaysAgo(1),
          active: true,
          isStandard: false,
          viewerIds: [],
          editorIds: [],
          stages: [
            {
              id: 'stage-1',
              name: 'Stage 1',
              assigneeId: 'emp-1',
              offsetDays: 0,
              viewerIds: [],
              editorIds: [],
              items: [{ id: 'ti-1', label: 'Close the month' }],
            },
          ],
        },
      ],
    })

  const persisted = async () => JSON.parse(await readFile(localDataPath, 'utf8'))
  const waitingOnsOnDisk = async () =>
    (await persisted()).checklists
      .find((c) => c.id === 'chk-1')
      .items.find((i) => i.id === 'item-1').waitingOns ?? []

  it('persists the spawn when nothing landed mid-read, exactly once', async () => {
    await store.write(spawnableWorkspace())

    const served = await store.read()
    expect(served.checklists.filter((c) => c.templateId === 'tpl-1')).toHaveLength(1)

    const afterFirst = await persisted()
    expect(afterFirst.checklists.filter((c) => c.templateId === 'tpl-1')).toHaveLength(1)

    // Idempotent: the next read spawns nothing new.
    await store.read()
    const afterSecond = await persisted()
    expect(afterSecond.checklists.filter((c) => c.templateId === 'tpl-1')).toHaveLength(1)
  })

  it("hands write() the fingerprint of the workspace it actually read", async () => {
    await store.write(spawnableWorkspace())
    const preReadVersion = fileWorkspaceVersion(await persisted())

    const writeSpy = vi.spyOn(store, 'write')
    await store.read()

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0][1]).toMatchObject({ expectedVersion: preReadVersion })
  })

  it('refuses the write-back when a wait was saved mid-read — the wait survives', async () => {
    await store.write(spawnableWorkspace())

    // Deterministic interleaving: the moment read() hands its materialized
    // snapshot to write(), land a waiting-on entry — the same shape as a
    // bookkeeper saving a wait while an owner's page load spawns the new
    // cycle. Without the guard, the write-back's wipe-and-reinsert erases it.
    const realWrite = AppDataStore.prototype.write
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let interleaved = false
    vi.spyOn(store, 'write').mockImplementation(async function (data, options) {
      if (!interleaved) {
        interleaved = true
        await store.addWaitingOn(
          'chk-1',
          { itemId: 'item-1' },
          { blockerId: 'emp-1', requestedBy: 'emp-1', note: 'client statements' },
        )
      }
      return realWrite.call(store, data, options)
    })

    const served = await store.read()

    // The read still serves the spawned checklist from memory...
    expect(served.checklists.some((c) => c.templateId === 'tpl-1')).toBe(true)
    // ...but persisted NOTHING: the wait saved mid-read is still on disk and
    // the stale snapshot (which never contained it) was refused wholesale.
    expect(await waitingOnsOnDisk()).toHaveLength(1)
    expect((await persisted()).checklists.some((c) => c.templateId === 'tpl-1')).toBe(false)
    expect(warn).toHaveBeenCalled()

    // The next read retries with nothing in flight: the spawn lands AND the
    // wait is still there. Nothing was lost on either side.
    await store.read()
    expect((await persisted()).checklists.some((c) => c.templateId === 'tpl-1')).toBe(true)
    expect(await waitingOnsOnDisk()).toHaveLength(1)
  })

  it('the guard check and the write share one queue slot', async () => {
    // The file equivalent of "the check runs inside the transaction": check and
    // write share ONE queue slot, so a save that lands after the check cannot
    // be erased by a write whose check predates it. Called in this order, the
    // guarded write runs first (its fingerprint still current, it SUCCEEDS) and
    // the unguarded one lands after — the final state must be the LATER write,
    // not a stale snapshot that checked early and wrote late (which is exactly
    // what the old three-slot shape produced here).
    const version = await store.computeWorkspaceVersion()
    const guarded = store.write(workspace({ clients: [{ id: 'c1', name: 'Guarded' }] }), {
      expectedVersion: version,
    })
    const unguarded = store.write(workspace({ clients: [{ id: 'c1', name: 'Unguarded' }] }))
    await expect(guarded).resolves.toBeUndefined()
    await expect(unguarded).resolves.toBeUndefined()

    const final = await persisted()
    expect(final.clients[0].name).toBe('Unguarded')
  })
})

/**
 * Covered-date windows on reimbursed expenses — the store's half.
 *
 * The arithmetic is pinned in lib/expense-coverage.test.mjs. What lives here is
 * the part that is a fact about STORED ROWS rather than about dates:
 *
 *   - generation writes the window it billed into the expense's ledger, and
 *     only after the invoice actually landed;
 *   - regenerating a month reuses that window instead of stepping the cycle a
 *     second time — the guarantee that makes "void & regenerate" safe;
 *   - a window the owner has not confirmed stands between the invoice and being
 *     reviewed, and confirming it moves the ledger, not just the line.
 */
describe('reimbursed-expense covered dates (file backend)', () => {
  const period = '2026-08'

  async function seedCoverageWorkspace(overrides = {}) {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 500 }],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [],
        recurringReimbursements: [
          {
            id: 'recur-qbo',
            clientId: 'c1',
            description: 'QuickBooks Online',
            amount: 90,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageTemplate: '{description} — {range}',
            coverageStart: '2026-07-13',
            coverageEnd: '2026-08-13',
            coveragePaused: false,
            coverageResumePending: false,
            coverageHistory: {},
            ...overrides,
          },
        ],
      }),
    )
    // Invoices live outside the bulk save, so start the period genuinely empty.
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  const readExpense = async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.recurringReimbursements.find((entry) => entry.id === 'recur-qbo')
  }

  const recurringLineOf = (invoice) => invoice.lineItems.find((line) => line.kind === 'recurring')

  it('bills the first window she typed, and records it against the period', async () => {
    await seedCoverageWorkspace()

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    const line = recurringLineOf(result.created[0])
    expect(line.label).toBe('QuickBooks Online — July 13 – August 13, 2026')
    expect(line).toMatchObject({
      recurringId: 'recur-qbo',
      coverageStart: '2026-07-13',
      coverageEnd: '2026-08-13',
    })
    // The ledger now answers for August, which is what the next run reads.
    expect((await readExpense()).coverageHistory['2026-08']).toMatchObject({
      start: '2026-07-13',
      end: '2026-08-13',
      needsConfirmation: false,
    })
  })

  it('walks the window forward on the next month, with no confirmation asked', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    const september = await store.generateInvoicesForPeriod('2026-09', { clientId: 'c1' })

    const line = recurringLineOf(september.created[0])
    expect(line.label).toBe('QuickBooks Online — August 13 – September 13, 2026')
    expect(line.needsCoverageConfirmation).toBeFalsy()
  })

  // THE ONE THAT MATTERS. Voiding a month and building it again must give the
  // client the same covered period — not next month's, which is what a cycle
  // that advanced on every generation would print.
  it('reuses the same window when a month is voided and regenerated', async () => {
    await seedCoverageWorkspace()
    const first = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const before = recurringLineOf(first.created[0])

    await store.voidUnsentInvoicesForPeriod(period)
    const rebuilt = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const after = recurringLineOf(rebuilt.created[0])

    expect(after.coverageStart).toBe(before.coverageStart)
    expect(after.coverageEnd).toBe(before.coverageEnd)
    expect(after.label).toBe(before.label)
    // And the ledger still holds exactly one answer for August.
    expect(Object.keys((await readExpense()).coverageHistory)).toEqual(['2026-08'])
  })

  // A client who was skipped must not have their window moved. The invoice is
  // what advances the cycle, so no invoice means no advance.
  it('leaves the ledger alone when nothing was generated', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const afterFirst = await readExpense()

    // Second run skips — the client already has a live invoice for the period.
    const second = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    expect(second.created).toHaveLength(0)

    expect((await readExpense()).coverageHistory).toEqual(afterFirst.coverageHistory)
  })

  it('asks about the window when a cycle was skipped', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    // September and October never billed. November must not stride across them.
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })

    expect(recurringLineOf(november.created[0])).toMatchObject({
      needsCoverageConfirmation: true,
      coverageReason: 'gap',
      coverageStart: '2026-08-13',
      coverageEnd: '2026-09-13',
    })
  })

  it('asks about the window on the first invoice after a pause is lifted', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    await store.updateRecurringReimbursement('recur-qbo', { coveragePaused: true })
    // Paused: September bills the plan and nothing else.
    const paused = await store.generateInvoicesForPeriod('2026-09', { clientId: 'c1' })
    expect(recurringLineOf(paused.created[0])).toBeUndefined()

    await store.updateRecurringReimbursement('recur-qbo', { coveragePaused: false })
    expect((await readExpense()).coverageResumePending).toBe(true)

    const resumed = await store.generateInvoicesForPeriod('2026-10', { clientId: 'c1' })
    expect(recurringLineOf(resumed.created[0])).toMatchObject({
      needsCoverageConfirmation: true,
      coverageReason: 'resumed',
    })
    // Spent by the invoice that asked — the month after must not ask again.
    expect((await readExpense()).coverageResumePending).toBe(false)
  })

  it('refuses to mark an invoice reviewed while its dates are unanswered', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })

    await expect(
      store.updateInvoice(november.created[0].id, { status: 'reviewed' }),
    ).rejects.toThrow(/confirm the covered dates/i)
  })

  // Voiding is deliberately still allowed: withdrawing an invoice she does not
  // want to answer for is the right way out, not a dead end.
  it('still lets her void an invoice she has not answered for', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })

    const voided = await store.updateInvoice(november.created[0].id, { status: 'void' })
    expect(voided.status).toBe('void')
  })

  it('keeps the window and the expense id through an ordinary line save', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })
    const invoice = november.created[0]

    // She retypes the label — the dates and the id must survive it, or the line
    // would lose the very thing being confirmed.
    const saved = await store.updateInvoice(invoice.id, {
      lineItems: invoice.lineItems.map((line) =>
        line.kind === 'recurring' ? { ...line, label: 'QBO subscription' } : line,
      ),
    })

    expect(recurringLineOf(saved)).toMatchObject({
      label: 'QBO subscription',
      recurringId: 'recur-qbo',
      coverageStart: '2026-08-13',
      coverageEnd: '2026-09-13',
      needsCoverageConfirmation: true,
    })
  })

  it('accepts the proposed window and unblocks review', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })
    const invoiceId = november.created[0].id

    const confirmed = await store.confirmExpenseCoverage(invoiceId, 'recur-qbo')

    expect(recurringLineOf(confirmed).needsCoverageConfirmation).toBe(false)
    const reviewed = await store.updateInvoice(invoiceId, { status: 'reviewed' })
    expect(reviewed.status).toBe('reviewed')
  })

  // Correcting the window must reach the LEDGER, or the following month would
  // step from the range she corrected away from — the same retyping this
  // feature removes, arriving a month later.
  it('carries an edited window into the ledger, and the next cycle steps from it', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })

    const confirmed = await store.confirmExpenseCoverage(november.created[0].id, 'recur-qbo', {
      start: '2026-10-13',
      end: '2026-11-13',
    })

    // The wording is re-rendered around the dates she actually approved.
    expect(recurringLineOf(confirmed).label).toBe(
      'QuickBooks Online — October 13 – November 13, 2026',
    )
    expect((await readExpense()).coverageHistory['2026-11']).toMatchObject({
      start: '2026-10-13',
      end: '2026-11-13',
      needsConfirmation: false,
    })

    const december = await store.generateInvoicesForPeriod('2026-12', { clientId: 'c1' })
    expect(recurringLineOf(december.created[0])).toMatchObject({
      coverageStart: '2026-11-13',
      coverageEnd: '2026-12-13',
      needsCoverageConfirmation: false,
    })
  })

  it('refuses a window that ends before it starts', async () => {
    await seedCoverageWorkspace()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })

    await expect(
      store.confirmExpenseCoverage(november.created[0].id, 'recur-qbo', {
        start: '2026-11-13',
        end: '2026-10-13',
      }),
    ).rejects.toThrow(/must come after/i)
  })

  it('refuses to confirm an expense that is not on the invoice', async () => {
    await seedCoverageWorkspace()
    const august = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    await expect(store.confirmExpenseCoverage(august.created[0].id, 'recur-ghost')).rejects.toThrow(
      /not on this invoice/i,
    )
  })

  it('refuses to switch coverage on without a first window', async () => {
    await seedCoverageWorkspace()
    expect(
      await store.updateRecurringReimbursement('recur-qbo', {
        coverageStart: null,
        coverageEnd: null,
      }),
    ).toBeNull()
    expect(
      await store.addRecurringReimbursement({
        clientId: 'c1',
        description: 'Payroll service',
        amount: 25,
        frequency: 'monthly',
        startDate: '2026-08-01',
        coverageEnabled: true,
      }),
    ).toBeNull()
  })

  it('refuses a first window that ends before it starts', async () => {
    await seedCoverageWorkspace()
    expect(
      await store.addRecurringReimbursement({
        clientId: 'c1',
        description: 'Payroll service',
        amount: 25,
        frequency: 'monthly',
        startDate: '2026-08-01',
        coverageEnabled: true,
        coverageStart: '2026-09-05',
        coverageEnd: '2026-08-05',
      }),
    ).toBeNull()
  })

  it('stores the covered dates a create was given', async () => {
    await seedCoverageWorkspace()
    const created = await store.addRecurringReimbursement({
      clientId: 'c1',
      description: 'Payroll service',
      amount: 25,
      frequency: 'monthly',
      startDate: '2026-08-01',
      coverageEnabled: true,
      coverageTemplate: 'Payroll — {range}',
      coverageStart: '2026-08-05',
      coverageEnd: '2026-09-05',
    })

    expect(created).toMatchObject({
      coverageEnabled: true,
      coverageTemplate: 'Payroll — {range}',
      coverageStart: '2026-08-05',
      coverageEnd: '2026-09-05',
      coverageHistory: {},
    })
  })
})

/**
 * The Postgres half of the same feature. Cardinal rule 1: this store has two
 * backends and a Postgres-only omission passes CI in silence, because the tests
 * above run the file backend and production runs this one.
 */
describe('reimbursed-expense covered dates (postgres branch)', () => {
  const COVERAGE_COLUMNS = [
    'coverage_enabled',
    'coverage_template',
    'coverage_start',
    'coverage_end',
    'coverage_paused',
    'coverage_resume_pending',
    'coverage_history',
  ]

  it('adds every coverage column to the existing table', async () => {
    const fake = fakePostgres()
    // See the sibling DDL tests: the seeding half of initialize() throws against
    // a fake that answers every select with nothing. The DDL has already run.
    await postgresStore(fake)
      .initialize()
      .catch(() => {})

    for (const column of COVERAGE_COLUMNS) {
      expect(
        fake.matching(
          new RegExp(
            `alter table recurring_reimbursements add column if not exists ${column}\\b`,
            'i',
          ),
        ),
      ).toHaveLength(1)
    }
  })

  // The read is what feeds the resolver. A select that forgot the ledger would
  // make every month look like the first one — and would therefore advance the
  // window on every single generation, in production only.
  it('reads every coverage column the row mapper needs', async () => {
    const fake = fakePostgres()
    await postgresStore(fake)
      .read()
      .catch(() => {})

    const select = fake.statements.find((statement) =>
      /^select[\s\S]*from recurring_reimbursements/i.test(statement.text),
    )
    expect(select).toBeDefined()
    for (const column of COVERAGE_COLUMNS) {
      expect(select.text).toMatch(new RegExp(`\\b${column}\\b`))
    }
  })

  // node-pg materializes a `date` column as a JS Date at LOCAL midnight — which
  // is why these fixtures use `new Date(y, m, d)` and not an ISO string with a
  // Z. Reading such a Date back through `toISOString()` would slide the day
  // backwards on any host east of Greenwich, and `coverage_end` is what seeds
  // the cycle's anchor, so a one-day slip would move a client's billing date.
  const pgDate = (year, month, day) => new Date(year, month - 1, day)

  it('maps a row into the shape the resolver reads', () => {
    expect(
      mapRecurringReimbursementRow({
        id: 'recur-qbo',
        client_id: 'c1',
        description: 'QuickBooks Online',
        amount: '90.00',
        frequency: 'monthly',
        start_date: pgDate(2026, 7, 1),
        coverage_enabled: true,
        coverage_template: '{description} — {range}',
        coverage_start: pgDate(2026, 7, 13),
        coverage_end: pgDate(2026, 8, 13),
        coverage_anchor_day: 13,
        coverage_paused: false,
        coverage_resume_pending: false,
        coverage_history: { '2026-08': { start: '2026-07-13', end: '2026-08-13' } },
      }),
    ).toEqual({
      id: 'recur-qbo',
      clientId: 'c1',
      description: 'QuickBooks Online',
      // pg hands numerics back as strings; money is coerced by the mapper.
      amount: 90,
      frequency: 'monthly',
      startDate: '2026-07-01',
      coverageEnabled: true,
      coverageTemplate: '{description} — {range}',
      coverageStart: '2026-07-13',
      coverageEnd: '2026-08-13',
      coverageAnchorDay: 13,
      coveragePaused: false,
      coverageResumePending: false,
      coverageHistory: { '2026-08': { start: '2026-07-13', end: '2026-08-13' } },
    })
  })

  // A row written before this feature has none of the coverage columns. It must
  // come back in the SAME shape the file backend produces, or the resolver sees
  // `coverageHistory: undefined` on one backend and `{}` on the other.
  it('gives a pre-feature row the same shape both backends produce', () => {
    expect(
      mapRecurringReimbursementRow({
        id: 'recur-old',
        client_id: 'c1',
        description: 'Annual filing fee',
        amount: '40.00',
        frequency: 'monthly',
        start_date: pgDate(2026, 1, 1),
      }),
    ).toEqual(
      normalizeRecurringReimbursement({
        id: 'recur-old',
        clientId: 'c1',
        description: 'Annual filing fee',
        amount: 40,
        frequency: 'monthly',
        startDate: '2026-01-01',
      }),
    )
  })

  // MERGED into the ledger, never assigned over it. `coverage_history = $2`
  // would erase every earlier period the moment one more was billed — and the
  // gap detection reads exactly those earlier periods.
  it('merges one period into the ledger without disturbing the others', async () => {
    const fake = fakePostgres()
    await postgresStore(fake)._writeCoverageLedgerEntry('recur-qbo', '2026-09', {
      start: '2026-08-13',
      end: '2026-09-13',
      needsConfirmation: false,
    })

    const written = fake.matching(/^update recurring_reimbursements/i)
    expect(written).toHaveLength(1)
    expect(written[0].text).toMatch(/jsonb_set\(/i)
    expect(written[0].text).toMatch(/coalesce\(coverage_history/i)
    // The resume flag is spent by the invoice that asked.
    expect(written[0].text).toMatch(/coverage_resume_pending = false/i)
    expect(written[0].params[1]).toBe('2026-09')
    expect(JSON.parse(written[0].params[2])).toMatchObject({
      start: '2026-08-13',
      end: '2026-09-13',
      needsConfirmation: false,
    })
  })

  it('writes the coverage columns an update was given', async () => {
    const fake = fakePostgres({
      recurringRows: [
        {
          id: 'recur-qbo',
          client_id: 'c1',
          description: 'QuickBooks Online',
          amount: '90.00',
          frequency: 'monthly',
          start_date: new Date('2026-07-01T00:00:00Z'),
          coverage_enabled: false,
          coverage_template: null,
          coverage_start: null,
          coverage_end: null,
          coverage_paused: false,
          coverage_resume_pending: false,
          coverage_history: {},
        },
      ],
    })

    await postgresStore(fake).updateRecurringReimbursement('recur-qbo', {
      coverageEnabled: true,
      coverageTemplate: 'Payroll — {range}',
      coverageStart: '2026-08-05',
      coverageEnd: '2026-09-05',
    })

    const updates = fake.matching(/^update recurring_reimbursements set/i)
    expect(updates).toHaveLength(1)
    for (const column of [
      'coverage_enabled',
      'coverage_template',
      'coverage_start',
      'coverage_end',
    ]) {
      expect(updates[0].text).toMatch(new RegExp(`${column} = \\$\\d+`))
    }
    // The anchor rides along: re-typing the first window in SETUP is her saying
    // where the cycle stands, and the 5th is the day it turns.
    expect(updates[0].params).toEqual([
      'recur-qbo',
      true,
      'Payroll — {range}',
      '2026-08-05',
      '2026-09-05',
      5,
    ])
  })

  // The bulk save wipes and rewrites these rows. An insert that forgot the
  // ledger would erase every client's billing history on the next full save —
  // and every expense would restart at its seed window.
  it('carries the ledger through the bulk save', async () => {
    const fake = fakePostgres()
    await postgresStore(fake)
      .write({
        clients: [{ id: 'c1', name: 'Acme' }],
        employees: [],
        timeEntries: [],
        checklists: [],
        checklistTemplates: [],
        recycledChecklists: [],
        plans: [],
        contacts: [],
        reimbursements: [],
        recurringReimbursements: [
          {
            id: 'recur-qbo',
            clientId: 'c1',
            description: 'QuickBooks Online',
            amount: 90,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageTemplate: '{description} — {range}',
            coverageStart: '2026-07-13',
            coverageEnd: '2026-08-13',
            coveragePaused: false,
            coverageResumePending: false,
            coverageHistory: { '2026-08': { start: '2026-07-13', end: '2026-08-13' } },
          },
        ],
        timesheetLocks: [],
        weeklySubmissions: [],
      })
      .catch(() => {})

    const insert = fake.matching(/^insert into recurring_reimbursements/i)
    expect(insert).toHaveLength(1)
    for (const column of COVERAGE_COLUMNS) {
      expect(insert[0].text).toMatch(new RegExp(`\\b${column}\\b`))
    }
    expect(JSON.parse(insert[0].params[13])).toEqual({
      '2026-08': { start: '2026-07-13', end: '2026-08-13' },
    })
  })

  // The other half of the same promise: when the row ALREADY EXISTS, the stored
  // ledger wins over whatever the payload carries. A tab that loaded this
  // morning holds an empty ledger; its autosave this afternoon, after a month
  // run, would otherwise restart every expense at its seed window and re-bill
  // windows the client has already been sent.
  it('keeps the STORED ledger when a stale tab saves an empty one', async () => {
    const fake = fakePostgres({
      recurringRows: [
        {
          id: 'recur-qbo',
          coverage_anchor_day: 20,
          coverage_resume_pending: true,
          coverage_history: { '2026-08': { start: '2026-07-13', end: '2026-08-13' } },
        },
      ],
    })
    await postgresStore(fake)
      .write({
        clients: [{ id: 'c1', name: 'Acme' }],
        employees: [],
        timeEntries: [],
        checklists: [],
        checklistTemplates: [],
        recycledChecklists: [],
        plans: [],
        contacts: [],
        reimbursements: [],
        recurringReimbursements: [
          {
            id: 'recur-qbo',
            clientId: 'c1',
            description: 'QuickBooks Online',
            amount: 90,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageStart: '2026-07-13',
            coverageEnd: '2026-08-13',
            // What a tab loaded before the month run would send back.
            coverageAnchorDay: 13,
            coverageResumePending: false,
            coverageHistory: {},
          },
        ],
        timesheetLocks: [],
        weeklySubmissions: [],
      })
      .catch(() => {})

    const insert = fake.matching(/^insert into recurring_reimbursements/i)[0]
    expect(insert.params[10]).toBe(20)
    expect(insert.params[12]).toBe(true)
    expect(JSON.parse(insert.params[13])).toEqual({
      '2026-08': { start: '2026-07-13', end: '2026-08-13' },
    })
  })
})

/**
 * The same guarded write-back on the POSTGRES branch — the one production runs.
 * The fake can't prove transaction isolation, but it CAN pin the mechanics:
 * the fingerprint is captured, the snapshot handed to write() is read AFTER
 * the capture (never before — a snapshot older than its fingerprint is how a
 * concurrent write gets erased with the guard still passing), and a moved
 * fingerprint aborts the write-back before any delete is issued.
 */
describe("read()'s materializer write-back is guarded (postgres branch)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const spawnTemplateRow = {
    id: 'tpl-mat',
    title: 'Monthly bookkeeping',
    client_id: 'c1',
    assignee_id: 'emp-1',
    frequency: 'monthly',
    next_due_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    active: true,
    is_standard: false,
    category_id: null,
    skip_allowed: false,
    onboarding_for_client_id: null,
    source_template_id: null,
    viewer_ids: [],
    editor_ids: [],
    scheduled_months: null,
    due_day_of_month: null,
    monthly_due_days: null,
    repeat_annually: true,
    schedule_year: null,
    lead_days: null,
  }

  const stageRow = {
    id: 'stage-1',
    template_id: 'tpl-mat',
    name: 'Stage 1',
    assignee_id: 'emp-1',
    offset_days: 0,
    due_date: null,
    due_day_of_month: null,
    position: 0,
    viewer_ids: [],
    editor_ids: [],
  }

  const templateItemRow = {
    id: 'ti-1',
    template_id: 'tpl-mat',
    label: 'Close the month',
    sort_order: 0,
    due_date: null,
    due_day_of_month: null,
    assignee_id: null,
    stage_id: 'stage-1',
    sub_items: [],
  }

  const clientRow = {
    id: 'c1',
    name: 'Acme',
    contact: 'Pat',
    billing_mode: 'hourly',
    hourly_rate: 0,
    plan_id: null,
    plan_ids: [],
    contact_ids: [],
    assigned_bookkeeper_ids: [],
    lifecycle_stage: 'active',
  }

  const spawnableFake = (overrides = {}) =>
    fakePostgres({
      clientRows: [clientRow],
      templateRows: [spawnTemplateRow],
      templateStageRows: [stageRow],
      templateItemRows: [templateItemRow],
      ...overrides,
    })

  const VERSION_SQL = /md5\(coalesce\(string_agg/i
  const nthIndexOf = (fake, pattern, n) => {
    let seen = 0
    for (let i = 0; i < fake.statements.length; i += 1) {
      if (pattern.test(fake.statements[i].text)) {
        seen += 1
        if (seen === n) return i
      }
    }
    return -1
  }

  it('captures the fingerprint, re-reads, and re-checks inside the transaction', async () => {
    const fake = spawnableFake()
    const data = await postgresStore(fake).read()

    // The spawn happened and was written back.
    expect(data.checklists.some((c) => c.templateId === 'tpl-mat')).toBe(true)
    expect(fake.matching(/^insert into checklists\b/i).length).toBeGreaterThan(0)

    // Fingerprint captured BEFORE the snapshot that gets written: the template
    // table is read once to detect the spawn, then again AFTER the capture.
    const captureAt = nthIndexOf(fake, VERSION_SQL, 1)
    const secondTemplateReadAt = nthIndexOf(
      fake,
      /\bnext_due_date\b[\s\S]*from checklist_templates\b/i,
      2,
    )
    expect(captureAt).toBeGreaterThan(-1)
    expect(secondTemplateReadAt).toBeGreaterThan(-1)
    expect(captureAt).toBeLessThan(secondTemplateReadAt)

    // And write() re-checked it INSIDE the transaction.
    const beginAt = fake.indexOf(/^begin$/i)
    const recheckAt = nthIndexOf(fake, VERSION_SQL, 2)
    const firstDeleteAt = fake.indexOf(/^delete from /i)
    expect(beginAt).toBeGreaterThan(-1)
    expect(recheckAt).toBeGreaterThan(beginAt)
    expect(recheckAt).toBeLessThan(firstDeleteAt)
  })

  it('a moved fingerprint aborts the write-back before any delete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = spawnableFake({
      versionResponses: [
        [{ t: 'clients', h: 'before' }],
        [{ t: 'clients', h: 'after-a-concurrent-write' }],
      ],
    })

    const data = await postgresStore(fake).read()

    // Served from memory, nothing wiped, transaction rolled back.
    expect(data.checklists.some((c) => c.templateId === 'tpl-mat')).toBe(true)
    expect(fake.matching(/^delete from /i)).toEqual([])
    expect(fake.matching(/^insert into checklists\b/i)).toEqual([])
    expect(fake.indexOf(/^rollback$/i)).toBeGreaterThan(-1)
    expect(warn).toHaveBeenCalled()
  })
})

/**
 * The enforcement around covered-date windows, as opposed to the arithmetic
 * inside them. Every test here was written against a hole a review reproduced:
 * a gate whose condition the caller supplied, a void that left the ledger
 * claiming a window nobody billed, a confirm that answered for a withdrawn
 * invoice or overwrote wording the owner had typed, and a cycle anchor that
 * snapped back to the seed the month after she moved it.
 */
describe('covered dates — the gate cannot be talked around (file backend)', () => {
  const period = '2026-08'

  async function seedTwoExpenses() {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 500 }],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [],
        recurringReimbursements: [
          {
            id: 'recur-qbo',
            clientId: 'c1',
            description: 'QuickBooks Online',
            amount: 90,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageTemplate: '{description} — {range}',
            coverageStart: '2026-07-13',
            coverageEnd: '2026-08-13',
            coverageAnchorDay: 13,
            coveragePaused: false,
            coverageResumePending: false,
            coverageHistory: {},
          },
          {
            id: 'recur-payroll',
            clientId: 'c1',
            description: 'Payroll service',
            amount: 25,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageTemplate: '{description} — {range}',
            coverageStart: '2026-07-05',
            coverageEnd: '2026-08-05',
            coverageAnchorDay: 5,
            coveragePaused: false,
            coverageResumePending: false,
            coverageHistory: {},
          },
        ],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  const readExpense = async (id) => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.recurringReimbursements.find((entry) => entry.id === id)
  }

  const lineFor = (invoice, recurringId) =>
    invoice.lineItems.find((line) => line.kind === 'recurring' && line.recurringId === recurringId)

  // THE CRITICAL ONE. The flag arrives on the line, so a hand-rolled PATCH can
  // simply not send it. A gate whose condition the caller supplies is not a
  // gate — the answer has to come from the store's own ledger.
  it('refuses review even when the PATCH strips the flag off the line', async () => {
    await seedTwoExpenses()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })
    const invoice = november.created[0]
    expect(lineFor(invoice, 'recur-qbo').needsCoverageConfirmation).toBe(true)

    // Exactly what a stale or forged tab would send: the same lines, minus the
    // inconvenient field, plus the status it wants.
    const stripped = invoice.lineItems.map((line) => {
      const { needsCoverageConfirmation: _flag, coverageReason: _why, ...rest } = line
      return rest
    })

    await expect(
      store.updateInvoice(invoice.id, { status: 'reviewed', lineItems: stripped }),
    ).rejects.toThrow(/confirm the covered dates/i)
  })

  // ...and the flag is put BACK on the stored line, so the next reader of that
  // invoice sees the question too rather than inheriting the stripped copy.
  it('restores the flag the PATCH tried to drop', async () => {
    await seedTwoExpenses()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })
    const invoice = november.created[0]

    const saved = await store.updateInvoice(invoice.id, {
      lineItems: invoice.lineItems.map((line) => {
        const { needsCoverageConfirmation: _flag, ...rest } = line
        return rest
      }),
    })

    expect(lineFor(saved, 'recur-qbo')).toMatchObject({
      needsCoverageConfirmation: true,
      coverageReason: 'gap',
    })
  })

  // The mirror image: a stale line still CLAIMING the question after she has
  // answered it must not keep the invoice hostage.
  it('clears a stale flag the caller sent after the answer landed', async () => {
    await seedTwoExpenses()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })
    const invoice = november.created[0]
    await store.confirmExpenseCoverage(invoice.id, 'recur-qbo')
    await store.confirmExpenseCoverage(invoice.id, 'recur-payroll')

    // A tab that loaded before the confirm re-sends the old lines.
    const reviewed = await store.updateInvoice(invoice.id, {
      status: 'reviewed',
      lineItems: invoice.lineItems,
    })

    expect(reviewed.status).toBe('reviewed')
    expect(lineFor(reviewed, 'recur-qbo').needsCoverageConfirmation).toBeUndefined()
  })

  it('keeps two expenses on one client in separate ledgers', async () => {
    await seedTwoExpenses()
    const august = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const invoice = august.created[0]

    expect(lineFor(invoice, 'recur-qbo').label).toBe(
      'QuickBooks Online — July 13 – August 13, 2026',
    )
    expect(lineFor(invoice, 'recur-payroll').label).toBe('Payroll service — July 5 – August 5, 2026')

    const september = await store.generateInvoicesForPeriod('2026-09', { clientId: 'c1' })
    // Each walks on its OWN anchor — the 13th and the 5th, not one shared day.
    expect(lineFor(september.created[0], 'recur-qbo')).toMatchObject({
      coverageStart: '2026-08-13',
      coverageEnd: '2026-09-13',
    })
    expect(lineFor(september.created[0], 'recur-payroll')).toMatchObject({
      coverageStart: '2026-08-05',
      coverageEnd: '2026-09-05',
    })
  })
})

describe('covered dates — voiding un-bills the window (file backend)', () => {
  const period = '2026-08'

  async function seedOne() {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 500 }],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [],
        recurringReimbursements: [
          {
            id: 'recur-qbo',
            clientId: 'c1',
            description: 'QuickBooks Online',
            amount: 90,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageTemplate: '{description} — {range}',
            coverageStart: '2026-07-13',
            coverageEnd: '2026-08-13',
            coverageAnchorDay: 13,
            coveragePaused: false,
            coverageResumePending: false,
            coverageHistory: {},
          },
        ],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  const readExpense = async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.recurringReimbursements.find((entry) => entry.id === 'recur-qbo')
  }

  const recurringLineOf = (invoice) => invoice.lineItems.find((line) => line.kind === 'recurring')

  it('drops the period from the ledger when the month is voided', async () => {
    await seedOne()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    expect((await readExpense()).coverageHistory['2026-08']).toBeDefined()

    await store.voidUnsentInvoicesForPeriod(period)

    expect((await readExpense()).coverageHistory['2026-08']).toBeUndefined()
  })

  it('drops it for a single invoice voided on its own', async () => {
    await seedOne()
    const august = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    await store.updateInvoice(august.created[0].id, { status: 'void' })

    expect((await readExpense()).coverageHistory['2026-08']).toBeUndefined()
  })

  // THE BUG THIS CLOSES. August voided and never rebuilt used to leave 2026-08
  // in the ledger; September then read it, saw the consecutive period it
  // expected, and advanced in silence — so August's window was billed to nobody
  // and never mentioned again.
  it('makes the next month ASK when a voided month was never rebuilt', async () => {
    await seedOne()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    await store.voidUnsentInvoicesForPeriod(period)

    const september = await store.generateInvoicesForPeriod('2026-09', { clientId: 'c1' })

    // Nothing has ever been billed, so this is the seed window again — August's
    // period, offered for September, which is exactly the thing to look at.
    expect(recurringLineOf(september.created[0])).toMatchObject({
      coverageStart: '2026-07-13',
      coverageEnd: '2026-08-13',
    })
  })

  // The idempotency promise is UNCHANGED by the release: void and regenerate
  // still lands on the same window, because it is recomputed from the same
  // inputs rather than remembered.
  it('still gives the same window on void and regenerate', async () => {
    await seedOne()
    const first = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const before = recurringLineOf(first.created[0])

    await store.voidUnsentInvoicesForPeriod(period)
    const rebuilt = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    expect(recurringLineOf(rebuilt.created[0])).toMatchObject({
      coverageStart: before.coverageStart,
      coverageEnd: before.coverageEnd,
      label: before.label,
    })
  })

  it('refuses to confirm dates on a voided invoice', async () => {
    await seedOne()
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })
    const invoiceId = november.created[0].id
    await store.updateInvoice(invoiceId, { status: 'void' })

    await expect(store.confirmExpenseCoverage(invoiceId, 'recur-qbo')).rejects.toThrow(
      /voided/i,
    )
  })

  // Generating a month BEHIND one already billed cannot be reasoned forward
  // from anything — the cycle has moved past it — so it is proposed and asked
  // about rather than assumed.
  it('asks when a month behind one already billed is generated', async () => {
    await seedOne()
    await store.generateInvoicesForPeriod('2026-09', { clientId: 'c1' })

    const august = await store.generateInvoicesForPeriod(period, { clientId: 'c1' })

    expect(recurringLineOf(august.created[0])).toMatchObject({
      needsCoverageConfirmation: true,
      coverageReason: 'backfill',
    })
  })
})

describe('covered dates — confirming respects what she typed (file backend)', () => {
  const period = '2026-08'

  async function seedOne() {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 500 }],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [],
        recurringReimbursements: [
          {
            id: 'recur-qbo',
            clientId: 'c1',
            description: 'QuickBooks Online',
            amount: 90,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageTemplate: '{description} — {range}',
            coverageStart: '2026-07-13',
            coverageEnd: '2026-08-13',
            coverageAnchorDay: 13,
            coveragePaused: false,
            coverageResumePending: false,
            coverageHistory: {},
          },
        ],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  const readExpense = async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.recurringReimbursements.find((entry) => entry.id === 'recur-qbo')
  }

  const recurringLineOf = (invoice) => invoice.lineItems.find((line) => line.kind === 'recurring')

  /** Generate August, then November — which lands unconfirmed on the gap. */
  async function throughToTheQuestion() {
    await store.generateInvoicesForPeriod(period, { clientId: 'c1' })
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'c1' })
    return november.created[0]
  }

  it('leaves wording the owner typed herself alone', async () => {
    await seedOne()
    const invoice = await throughToTheQuestion()

    // She rewrites the line for this client's contract.
    const edited = await store.updateInvoice(invoice.id, {
      lineItems: invoice.lineItems.map((line) =>
        line.kind === 'recurring'
          ? { ...line, label: 'QBO subscription (per contract)' }
          : line,
      ),
    })
    expect(recurringLineOf(edited).label).toBe('QBO subscription (per contract)')

    const confirmed = await store.confirmExpenseCoverage(invoice.id, 'recur-qbo', {
      start: '2026-10-13',
      end: '2026-11-13',
    })

    // Her sentence survives; only the dates behind it move.
    expect(recurringLineOf(confirmed).label).toBe('QBO subscription (per contract)')
    expect(recurringLineOf(confirmed)).toMatchObject({
      coverageStart: '2026-10-13',
      coverageEnd: '2026-11-13',
    })
  })

  it('still refreshes wording that is still the generated sentence', async () => {
    await seedOne()
    const invoice = await throughToTheQuestion()

    const confirmed = await store.confirmExpenseCoverage(invoice.id, 'recur-qbo', {
      start: '2026-10-13',
      end: '2026-11-13',
    })

    expect(recurringLineOf(confirmed).label).toBe(
      'QuickBooks Online — October 13 – November 13, 2026',
    )
  })

  // THE ANCHOR. She moves the end to the 20th; the cycle now turns on the 20th.
  // Snapping back to the 13th would bill a 23-day period at the full monthly
  // price and say nothing about it.
  it('moves the cycle when she moves the end onto a different day', async () => {
    await seedOne()
    const invoice = await throughToTheQuestion()

    await store.confirmExpenseCoverage(invoice.id, 'recur-qbo', {
      start: '2026-10-20',
      end: '2026-11-20',
    })
    expect((await readExpense()).coverageAnchorDay).toBe(20)

    const december = await store.generateInvoicesForPeriod('2026-12', { clientId: 'c1' })
    expect(recurringLineOf(december.created[0])).toMatchObject({
      coverageStart: '2026-11-20',
      coverageEnd: '2026-12-20',
    })
  })

  it('leaves the anchor alone when she just accepts the proposal', async () => {
    await seedOne()
    const invoice = await throughToTheQuestion()

    await store.confirmExpenseCoverage(invoice.id, 'recur-qbo')

    expect((await readExpense()).coverageAnchorDay).toBe(13)
  })

  // The anchor is what makes a short month a detour rather than a permanent
  // move. Confirmed onto the 31st, February clamps to the 28th and March comes
  // back to the 31st.
  // The CONFIRMED anchor survives a short month rather than being consumed by
  // it: moved to the 31st, February clamps to the 28th and March comes back to
  // the 31st. Before the anchor was stored, the confirm was forgotten entirely
  // and every cycle re-derived the 13th from the seed.
  it('carries a confirmed anchor across a short month', async () => {
    await seedOne()
    const invoice = await throughToTheQuestion()
    await store.confirmExpenseCoverage(invoice.id, 'recur-qbo', {
      start: '2026-11-30',
      end: '2026-12-31',
    })
    expect((await readExpense()).coverageAnchorDay).toBe(31)

    const walked = []
    for (const month of ['2026-12', '2027-01', '2027-02']) {
      const run = await store.generateInvoicesForPeriod(month, { clientId: 'c1' })
      const line = recurringLineOf(run.created[0])
      walked.push([line.coverageStart, line.coverageEnd, Boolean(line.needsCoverageConfirmation)])
    }

    expect(walked).toEqual([
      // Consecutive all the way, so nothing is ever asked about.
      ['2026-12-31', '2027-01-31', false],
      // February is short: clamped, not spilled into March.
      ['2027-01-31', '2027-02-28', false],
      // ...and March returns to the 31st rather than keeping February's day.
      ['2027-02-28', '2027-03-31', false],
    ])
  })
})

describe('covered dates — the send route and the derived gate (postgres branch)', () => {
  const recurringRow = (history) => ({
    id: 'recur-qbo',
    client_id: 'c1',
    description: 'QuickBooks Online',
    amount: '90.00',
    frequency: 'monthly',
    start_date: new Date(2026, 6, 1),
    coverage_enabled: true,
    coverage_template: '{description} — {range}',
    coverage_start: new Date(2026, 6, 13),
    coverage_end: new Date(2026, 7, 13),
    coverage_anchor_day: 13,
    coverage_paused: false,
    coverage_resume_pending: false,
    coverage_history: history,
  })

  const invoiceRow = {
    id: 'inv-1',
    client_id: 'c1',
    period: '2026-11',
    number: 'INV-2026-11-001',
    kind: 'monthly',
    status: 'reviewed',
    // Stored WITHOUT the flag — an invoice reviewed before the question existed.
    line_items: [
      {
        kind: 'recurring',
        label: 'QuickBooks Online — August 13 – September 13, 2026',
        detail: 'monthly',
        amount: 90,
        recurringId: 'recur-qbo',
        coverageStart: '2026-08-13',
        coverageEnd: '2026-09-13',
      },
    ],
    subtotal: 90,
    total: 90,
  }

  it('reports an unanswered window even when the stored line does not', async () => {
    const fake = fakePostgres({
      recurringRows: [
        recurringRow({
          '2026-11': {
            start: '2026-08-13',
            end: '2026-09-13',
            needsConfirmation: true,
            reason: 'gap',
          },
        }),
      ],
    })

    expect(
      await postgresStore(fake).invoiceHasUnconfirmedCoverage({
        period: '2026-11',
        lineItems: invoiceRow.line_items,
      }),
    ).toBe(true)
  })

  it('reports nothing to answer once the ledger says confirmed', async () => {
    const fake = fakePostgres({
      recurringRows: [
        recurringRow({
          '2026-11': { start: '2026-08-13', end: '2026-09-13', needsConfirmation: false },
        }),
      ],
    })

    expect(
      await postgresStore(fake).invoiceHasUnconfirmedCoverage({
        period: '2026-11',
        lineItems: invoiceRow.line_items.map((line) => ({
          ...line,
          // Even a line SHOUTING that it is unconfirmed loses to the ledger.
          needsCoverageConfirmation: true,
        })),
      }),
    ).toBe(false)
  })

  it('removes the period from the ledger with a jsonb subtraction on void', async () => {
    const fake = fakePostgres()
    await postgresStore(fake)._clearCoverageLedgerForPeriod('2026-08', ['recur-qbo'])

    const cleared = fake.matching(/^update recurring_reimbursements/i)
    expect(cleared).toHaveLength(1)
    expect(cleared[0].text).toMatch(/coverage_history\s*=\s*coalesce\(coverage_history[^)]*\)\s*-\s*\$2/i)
    expect(cleared[0].params).toEqual([['recur-qbo'], '2026-08'])
  })

  // The insert and the ledger write are ONE transaction: an invoice on file
  // whose expense never advanced would re-bill the same window next month.
  it('generates the invoice and moves the window inside one transaction', async () => {
    const fake = fakePostgres({ clientRows: [{ id: 'c1' }] })
    await postgresStore(fake)
      .generateInvoicesForPeriod('2026-08')
      .catch(() => {})

    const begin = fake.indexOf(/^BEGIN$/i)
    // No clients come back from this fake, so nothing is generated and no
    // transaction is opened — the shape assertion belongs with a real insert.
    if (begin === -1) {
      expect(fake.matching(/^insert into invoices/i)).toHaveLength(0)
      return
    }
    const inserted = fake.indexOf(/^insert into invoices/i)
    const ledger = fake.indexOf(/jsonb_set\(/i)
    const commit = fake.indexOf(/^COMMIT$/i)
    expect(begin).toBeLessThan(inserted)
    expect(ledger).toBeGreaterThan(inserted)
    expect(commit).toBeGreaterThan(ledger)
  })
})

describe('the fingerprint ignores the columns a bulk save cannot write', () => {
  it('drops the covered-date ledger, anchor and resume flag from the digest SQL', () => {
    const sql = tableVersionSql('recurring_reimbursements')
    for (const column of ['coverage_history', 'coverage_anchor_day', 'coverage_resume_pending']) {
      expect(sql).toContain(`- '${column}'`)
    }
    // Setup fields a tab CAN legitimately change stay in — dropping those would
    // reopen the wipe this guard exists for.
    expect(sql).not.toContain(`- 'coverage_start'`)
    expect(sql).not.toContain(`- 'coverage_template'`)
  })

  it('still drops only the timestamps from a table with nothing server-owned', () => {
    expect(tableVersionSql('clients')).toBe(
      `select md5(coalesce(string_agg(x, ',' order by x), '')) as h
            from (select (to_jsonb(t) - 'updated_at' - 'created_at')::text as x
                    from clients t) s`,
    )
  })

  // The point of the exclusion: a month run writes ledgers, and that must not
  // strand every tab Brittany has open on the invoices she is working through.
  it('does not change when only the ledger moves (file backend)', () => {
    const base = {
      recurringReimbursements: [
        {
          id: 'recur-qbo',
          clientId: 'c1',
          description: 'QuickBooks Online',
          amount: 90,
          coverageHistory: {},
          coverageAnchorDay: 13,
          coverageResumePending: false,
        },
      ],
    }
    const afterGeneration = {
      recurringReimbursements: [
        {
          ...base.recurringReimbursements[0],
          coverageHistory: { '2026-08': { start: '2026-07-13', end: '2026-08-13' } },
          coverageAnchorDay: 20,
          coverageResumePending: true,
        },
      ],
    }
    expect(fileWorkspaceVersion(afterGeneration)).toBe(fileWorkspaceVersion(base))
  })

  it('DOES change when a field a tab can write moves', () => {
    const base = {
      recurringReimbursements: [{ id: 'recur-qbo', amount: 90, coverageHistory: {} }],
    }
    const edited = {
      recurringReimbursements: [{ id: 'recur-qbo', amount: 95, coverageHistory: {} }],
    }
    expect(fileWorkspaceVersion(edited)).not.toBe(fileWorkspaceVersion(base))
  })
})

describe('sanitizeAppData guards the covered-date columns', () => {
  const payload = (recurring) => ({
    clients: [],
    employees: [],
    timeEntries: [],
    checklists: [],
    checklistTemplates: [],
    plans: [],
    contacts: [],
    reimbursements: [],
    recurringReimbursements: [recurring],
    timesheetLocks: [],
    weeklySubmissions: [],
  })

  // A malformed date reaches a `date` column and fails the INSERT — taking the
  // whole bulk save down on every autosave, on Postgres only, while the file
  // backend accepts it and CI stays green. That is the plan-refs outage shape.
  it('drops a covered date that is not a date', () => {
    const clean = sanitizeAppData(
      payload({
        id: 'recur-qbo',
        clientId: 'c1',
        amount: 90,
        coverageStart: 'whenever',
        coverageEnd: '2026-08-13',
      }),
    )
    expect(clean.recurringReimbursements[0].coverageStart).toBeUndefined()
    expect(clean.recurringReimbursements[0].coverageEnd).toBe('2026-08-13')
  })

  it('coerces a ledger that is not a map into an empty one', () => {
    for (const bad of [[], 'nope', 7, null]) {
      const clean = sanitizeAppData(
        payload({ id: 'recur-qbo', clientId: 'c1', amount: 90, coverageHistory: bad }),
      )
      expect(clean.recurringReimbursements[0].coverageHistory).toEqual({})
    }
  })

  it('nulls an anchor day that is not a day of the month', () => {
    for (const bad of [0, 32, 'the 13th', 4.5]) {
      const clean = sanitizeAppData(
        payload({ id: 'recur-qbo', clientId: 'c1', amount: 90, coverageAnchorDay: bad }),
      )
      expect(clean.recurringReimbursements[0].coverageAnchorDay).toBeNull()
    }
    const good = sanitizeAppData(
      payload({ id: 'recur-qbo', clientId: 'c1', amount: 90, coverageAnchorDay: 13 }),
    )
    expect(good.recurringReimbursements[0].coverageAnchorDay).toBe(13)
  })
})

/**
 * WHERE THE TWO PROTECTIONS MEET: the materializer's guarded write-back
 * (d3a386a) and the covered-date ledger's preserve-on-save.
 *
 * These landed independently and overlap on one code path — `write()`
 * re-inserting `recurring_reimbursements` from a snapshot that may be stale.
 * Each covers a different half of the row, and the split is deliberate:
 *
 *   - the STALENESS GUARD protects every field a tab is allowed to write
 *     (description, amount, frequency, the covered-date SETUP). A save whose
 *     fingerprint has moved is refused outright.
 *   - the PRESERVE protects the three fields a tab may NOT write — the ledger,
 *     the cycle's anchor day, the pending-resume flag. Those are excluded from
 *     the fingerprint (`VERSION_IGNORED_FIELDS`), so a month run writing
 *     ledgers does not move the version at all.
 *
 * Why the exclusion is not a hole: the guard never sees those fields, but the
 * preserve reads them back off the persisted file inside the same queue slot
 * and puts them back. Why the preserve is not enough on its own: it only
 * covers those three fields; everything else still needs the guard.
 *
 * The failure mode if either half is removed is the same shape and invisible
 * either way — a month run's covered windows quietly reverting to the seed on
 * the next page load that happens to spawn a checklist.
 */
describe('the guarded write-back and the covered-date ledger (file backend)', () => {
  const expense = (overrides = {}) => ({
    id: 'recur-qbo',
    clientId: 'c1',
    description: 'QuickBooks Online',
    amount: 90,
    frequency: 'monthly',
    startDate: '2026-07-01',
    coverageEnabled: true,
    coverageTemplate: '{description} — {range}',
    coverageStart: '2026-07-13',
    coverageEnd: '2026-08-13',
    coverageAnchorDay: 13,
    coveragePaused: false,
    coverageResumePending: false,
    coverageHistory: {},
    ...overrides,
  })

  const snapshot = (overrides = {}) =>
    workspace({ recurringReimbursements: [expense()], ...overrides })

  const persistedExpense = async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.recurringReimbursements.find((entry) => entry.id === 'recur-qbo')
  }

  /** What a month run writes: one billed window onto the expense's ledger. */
  const billAugust = () =>
    store._writeCoverageLedgerEntry('recur-qbo', '2026-08', {
      start: '2026-07-13',
      end: '2026-08-13',
      needsConfirmation: false,
    })

  beforeEach(async () => {
    await store.write(snapshot())
  })

  // The exclusion doing its job. If the ledger moved the fingerprint, every
  // month run would make the next materializer write-back refuse itself — and
  // strand every tab Brittany has open on the invoices she is working through.
  it('a month run does not move the workspace fingerprint', async () => {
    const before = await store.computeWorkspaceVersion()
    await billAugust()
    expect(await store.computeWorkspaceVersion()).toBe(before)
  })

  // ...so the write-back is NOT refused — and must therefore not erase it.
  it('the write-back is allowed through, and the ledger survives it', async () => {
    const pageLoadVersion = await store.computeWorkspaceVersion()
    await billAugust()

    // Exactly what read() now does: replay the snapshot it read, under the
    // fingerprint it captured. That snapshot predates the month run.
    await expect(
      store.write(snapshot(), { expectedVersion: pageLoadVersion }),
    ).resolves.toBeUndefined()

    expect((await persistedExpense()).coverageHistory).toEqual({
      '2026-08': {
        start: '2026-07-13',
        end: '2026-08-13',
        needsConfirmation: false,
        reason: null,
      },
    })
  })

  it('keeps the anchor and the resume flag through the same write-back', async () => {
    await store.updateRecurringReimbursement('recur-qbo', { coveragePaused: true })
    await store.updateRecurringReimbursement('recur-qbo', { coveragePaused: false })
    await store._writeCoverageLedgerEntry('recur-qbo', '2026-08', {
      start: '2026-10-20',
      end: '2026-11-20',
      needsConfirmation: false,
    })
    // The ledger write spends the resume flag; move the anchor separately so
    // both server-owned fields differ from what the stale snapshot carries.
    await store.updateRecurringReimbursement('recur-qbo', { coverageEnd: '2026-08-20' })
    const stored = await persistedExpense()
    expect(stored.coverageAnchorDay).toBe(20)

    const version = await store.computeWorkspaceVersion()
    await store.write(snapshot(), { expectedVersion: version })

    const after = await persistedExpense()
    expect(after.coverageAnchorDay).toBe(20)
    expect(after.coverageHistory['2026-08']).toBeDefined()
  })

  // The other half of the pair, unweakened: a field a tab CAN write still
  // moves the fingerprint and still refuses a stale write-back. Excluding the
  // three server-owned fields must not have opened the door generally.
  it('still refuses the write-back when a tab-writable field moved', async () => {
    const pageLoadVersion = await store.computeWorkspaceVersion()
    // A concurrent save changes the amount — squarely a tab's business.
    await store.write(snapshot({ recurringReimbursements: [expense({ amount: 95 })] }))

    await expect(
      store.write(snapshot(), { expectedVersion: pageLoadVersion }),
    ).rejects.toBeInstanceOf(StaleWorkspaceError)

    // Refused means nothing written: the concurrent amount stands.
    expect((await persistedExpense()).amount).toBe(95)
  })

  // A brand-new expense in the payload has no persisted row to preserve from,
  // so the payload is all there is — and its anchor comes from the first
  // window she typed rather than coming back null.
  it('seeds a genuinely new expense rather than preserving nothing', async () => {
    const version = await store.computeWorkspaceVersion()
    await store.write(
      snapshot({
        recurringReimbursements: [
          expense(),
          {
            id: 'recur-payroll',
            clientId: 'c1',
            description: 'Payroll service',
            amount: 25,
            frequency: 'monthly',
            startDate: '2026-08-01',
            coverageEnabled: true,
            coverageStart: '2026-08-05',
            coverageEnd: '2026-09-05',
          },
        ],
      }),
      { expectedVersion: version },
    )

    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    const added = data.recurringReimbursements.find((entry) => entry.id === 'recur-payroll')
    expect(added.coverageAnchorDay).toBe(5)
    expect(added.coverageHistory).toEqual({})
  })
})

/**
 * The waiting-on record's two newest facts, on the file backend (Cardinal rule
 * 1: the Postgres branch runs the identical walk through `_mutateWaitingOn` and
 * the identical `normalizeWaitingOns`, so what is pinned here is the contract
 * both implement).
 *
 *   1. A wait is created by ONE write carrying who, the message AND the task it
 *      waits for. The editor holds all three as an unsaved draft, and after
 *      Save every one of them is locked — a link that half-saved would be
 *      unrepairable (featreq-8b7d06d7).
 *   2. A QUESTION appends a message and moves NOTHING. "Sending does not
 *      complete the wait."
 */
describe('a saved wait carries its task link and its questions (file backend)', () => {
  const checklists = () => [
    {
      id: 'cl-1',
      clientId: 'c1',
      title: 'August close',
      items: [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: false,
          subItems: [{ id: 'sub-1', title: 'Statements', done: false }],
        },
      ],
    },
  ]

  const step = async () => {
    const data = await store.read()
    return data.checklists.find((c) => c.id === 'cl-1').items[0]
  }

  beforeEach(async () => {
    await store.write(workspace({ checklists: checklists() }))
  })

  it('writes the wait and the waited-for task together', async () => {
    const result = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      {
        blockerId: 'emp-1',
        requestedBy: 'emp-2',
        note: 'the bank statements',
        waitingForChecklistId: 'cl-other',
      },
    )
    expect(result).not.toBeNull()

    const item = await step()
    expect(item.waitingOns).toHaveLength(1)
    expect(item.waitingOns[0]).toMatchObject({
      blockerId: 'emp-1',
      requestedBy: 'emp-2',
      note: 'the bank statements',
    })
    expect(item.waitingForChecklistId).toBe('cl-other')
  })

  it('leaves an existing task link alone when none is supplied', async () => {
    await store.updateChecklistItem('cl-1', 'it-1', { waitingForChecklistId: 'cl-kept' })
    await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-1', requestedBy: 'emp-2' },
    )
    expect((await step()).waitingForChecklistId).toBe('cl-kept')
  })

  it('clears the link when the draft chose no task', async () => {
    await store.updateChecklistItem('cl-1', 'it-1', { waitingForChecklistId: 'cl-old' })
    await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-1', requestedBy: 'emp-2', waitingForChecklistId: '' },
    )
    expect((await step()).waitingForChecklistId).toBeUndefined()
  })

  it('carries the link onto a SUB-item, where it rides the sub_items JSONB', async () => {
    await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1', subItemId: 'sub-1' },
      { blockerId: 'emp-1', requestedBy: 'emp-2', waitingForChecklistId: 'cl-other' },
    )
    const sub = (await step()).subItems[0]
    expect(sub.waitingOns).toHaveLength(1)
    expect(sub.waitingForChecklistId).toBe('cl-other')
  })

  it('appends a question and moves no stage at all', async () => {
    const created = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-1', requestedBy: 'emp-2', note: 'the bank statements' },
    )
    await store.addWaitingOnQuestion('cl-1', created.entry.id, {
      userId: 'emp-1',
      note: '  which account?  ',
    })

    const entry = (await step()).waitingOns[0]
    expect(entry.questions).toEqual([
      { at: expect.any(String), by: 'emp-1', note: 'which account?' },
    ])
    // Untouched: it is still theirs to finish, and the original ask survives.
    expect(entry.resolvedAt).toBeUndefined()
    expect(entry.verifiedAt).toBeUndefined()
    expect(entry.note).toBe('the bank statements')
  })

  // Every read re-normalizes, so a key the normalizer does not list is erased
  // on the next load — which is how this shape can silently vanish.
  it('keeps every question through the normalizer, in order', async () => {
    const created = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-1', requestedBy: 'emp-2' },
    )
    await store.addWaitingOnQuestion('cl-1', created.entry.id, {
      userId: 'emp-1',
      note: 'which account?',
    })
    await store.addWaitingOnQuestion('cl-1', created.entry.id, {
      userId: 'emp-1',
      note: 'and which month?',
    })

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    const stored = persisted.checklists[0].items[0].waitingOns[0]
    expect(stored.questions.map((q) => q.note)).toEqual(['which account?', 'and which month?'])
    // …and again after a full read, which re-normalizes everything.
    expect((await step()).waitingOns[0].questions.map((q) => q.note)).toEqual([
      'which account?',
      'and which month?',
    ])
  })

  it('never removes a wait — questions accumulate beside the send-backs', async () => {
    const created = await store.addWaitingOn(
      'cl-1',
      { itemId: 'it-1' },
      { blockerId: 'emp-1', requestedBy: 'emp-2' },
    )
    await store.addWaitingOnQuestion('cl-1', created.entry.id, {
      userId: 'emp-1',
      note: 'which account?',
    })
    await store.markWaitingOnDone('cl-1', created.entry.id, { userId: 'emp-1' })
    await store.markWaitingOnSentBack('cl-1', created.entry.id, {
      userId: 'emp-2',
      note: 'the March page is missing',
    })

    const entry = (await step()).waitingOns[0]
    expect(entry.questions).toHaveLength(1)
    expect(entry.sendBacks).toHaveLength(1)
    expect(entry.resolvedAt).toBeUndefined()
  })
})

/**
 * WAIT PERMANENCE, MADE STRUCTURAL ON THE BULK WRITE.
 *
 * Her rule is that a saved wait cannot be removed, and the routes enforce it —
 * but `write()` re-inserts every checklist row from whatever snapshot the
 * calling tab holds, so a payload that never meant to touch a wait could still
 * flatten one. The staleness guard normally stops that; this is the belt to its
 * braces, and there is a live scenario where the braces are thin: a scoped GET
 * hands back the FULL-workspace fingerprint, so a tab that only saw part of the
 * workspace can still present a "current" token.
 *
 * The rule (`preservedNodeWaits`, both backends): what is STORED wins for
 * `waitingOns` always, and for the free-text trio while a live wait sits on the
 * node — the same fields, in the same window, that `waitingLockRefusal` freezes
 * on the PATCH routes.
 */
describe('a bulk save cannot touch a saved wait (file backend)', () => {
  const savedWait = {
    id: 'wo-keep',
    blockerId: 'emp-1',
    requestedBy: 'emp-2',
    note: 'the bank statements',
    createdAt: '2026-08-05T15:00:00.000Z',
  }

  const withWaits = (over = {}) => [
    {
      id: 'cl-1',
      clientId: 'c1',
      title: 'August close',
      items: [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: false,
          waiting: true,
          waitingOn: 'Lisa to send them',
          waitingForChecklistId: 'cl-other',
          waitingOns: [savedWait],
          subItems: [
            {
              id: 'sub-1',
              title: 'Statements',
              done: false,
              waitingOns: [{ ...savedWait, id: 'wo-sub' }],
            },
          ],
          ...over,
        },
      ],
    },
  ]

  const storedItem = async () => {
    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    return persisted.checklists[0].items[0]
  }

  beforeEach(async () => {
    // The wait exists on disk first — as if the waiting-on route had written it.
    await store.write(workspace({ checklists: withWaits() }))
  })

  it('ignores a payload that dropped the wait entirely', async () => {
    await store.write(
      workspace({
        checklists: [
          {
            id: 'cl-1',
            clientId: 'c1',
            title: 'August close',
            items: [
              {
                id: 'it-1',
                label: 'Bank rec',
                done: false,
                subItems: [{ id: 'sub-1', title: 'Statements', done: false }],
              },
            ],
          },
        ],
      }),
    )

    const item = await storedItem()
    expect(item.waitingOns).toHaveLength(1)
    expect(item.waitingOns[0].id).toBe('wo-keep')
    // …and the SUB-item's wait, which rides the same JSONB.
    expect(item.subItems[0].waitingOns).toHaveLength(1)
    expect(item.subItems[0].waitingOns[0].id).toBe('wo-sub')
  })

  it('ignores a payload that rewrote the wait', async () => {
    await store.write(
      workspace({
        checklists: withWaits({
          waitingOns: [{ ...savedWait, note: 'something else entirely', blockerId: 'emp-9' }],
        }),
      }),
    )

    const entry = (await storedItem()).waitingOns[0]
    expect(entry.note).toBe('the bank statements')
    expect(entry.blockerId).toBe('emp-1')
  })

  it('ignores a payload that resolved or approved it', async () => {
    await store.write(
      workspace({
        checklists: withWaits({
          waitingOns: [
            {
              ...savedWait,
              resolvedAt: '2026-08-09T00:00:00.000Z',
              resolvedBy: 'emp-1',
              verifiedAt: '2026-08-09T00:00:00.000Z',
              verifiedBy: 'emp-2',
            },
          ],
        }),
      }),
    )

    const entry = (await storedItem()).waitingOns[0]
    expect(entry.resolvedAt).toBeUndefined()
    expect(entry.verifiedAt).toBeUndefined()
  })

  // The same three fields the PATCH routes freeze, frozen here for the same
  // window — a bulk save is exactly the stale write that rule exists for.
  it('keeps the note, the task link and the amber flag while the wait is live', async () => {
    await store.write(
      workspace({
        checklists: withWaits({
          waiting: false,
          waitingOn: 'never mind',
          waitingForChecklistId: 'cl-somewhere-else',
        }),
      }),
    )

    const item = await storedItem()
    expect(item.waiting).toBe(true)
    expect(item.waitingOn).toBe('Lisa to send them')
    expect(item.waitingForChecklistId).toBe('cl-other')
  })

  /**
   * The lock is not forever. Once every wait is approved the step is ordinary
   * again and a tab may edit its note and un-flag it — otherwise a finished
   * hand-off would leave the step amber with nothing able to quiet it.
   */
  it('lets the payload edit those fields again once the wait is approved', async () => {
    const approved = {
      ...savedWait,
      resolvedAt: '2026-08-09T00:00:00.000Z',
      resolvedBy: 'emp-1',
      verifiedAt: '2026-08-10T00:00:00.000Z',
      verifiedBy: 'emp-2',
    }
    // Straight to disk: only the waiting-on routes can approve a wait, and this
    // stands in for them having done so.
    const onDisk = JSON.parse(await readFile(localDataPath, 'utf8'))
    onDisk.checklists[0].items[0].waitingOns = [approved]
    await writeFile(localDataPath, JSON.stringify(onDisk, null, 2))

    await store.write(
      workspace({
        checklists: withWaits({
          waiting: false,
          waitingOn: '',
          waitingForChecklistId: '',
          waitingOns: [approved],
        }),
      }),
    )

    const item = await storedItem()
    // The payload's own values, kept verbatim — nothing is being preserved over
    // them any more.
    expect(item.waiting).toBeFalsy()
    expect(item.waitingOn).toBeFalsy()
    expect(item.waitingForChecklistId).toBeFalsy()
    // The record itself is still there. It always is.
    expect(item.waitingOns[0].verifiedAt).toBe('2026-08-10T00:00:00.000Z')
  })

  it('takes the payload at its word for a brand-new step', async () => {
    await store.write(
      workspace({
        checklists: [
          {
            id: 'cl-1',
            clientId: 'c1',
            title: 'August close',
            items: [
              ...withWaits()[0].items,
              { id: 'it-new', label: 'New step', done: false, waiting: true, waitingOn: 'a note' },
            ],
          },
        ],
      }),
    )

    const persisted = JSON.parse(await readFile(localDataPath, 'utf8'))
    const fresh = persisted.checklists[0].items.find((item) => item.id === 'it-new')
    expect(fresh.waiting).toBe(true)
    expect(fresh.waitingOn).toBe('a note')
  })
})

/** Cardinal rule 1: the same guarantee, stated against the Postgres statements. */
describe('a bulk save cannot touch a saved wait (postgres branch)', () => {
  const storedWait = {
    id: 'wo-keep',
    blockerId: 'emp-1',
    requestedBy: 'emp-2',
    note: 'the bank statements',
    createdAt: '2026-08-05T15:00:00.000Z',
  }
  const priorRow = {
    id: 'item-1',
    done: false,
    completed_at: null,
    waiting: true,
    waiting_on: 'Lisa to send them',
    waiting_for_checklist_id: 'cl-other',
    waiting_ons: [storedWait],
    sub_items: [
      {
        id: 'sub-1',
        title: 'Statements',
        done: false,
        waitingOns: [{ ...storedWait, id: 'wo-sub' }],
      },
    ],
  }
  const payload = (over = {}) =>
    workspace({
      clients: [{ id: 'c1', name: 'Acme' }],
      checklists: [
        {
          id: 'cl-1',
          title: 'August close',
          clientId: 'c1',
          dueDate: '2026-08-31',
          items: [
            {
              id: 'item-1',
              label: 'Bank rec',
              done: false,
              subItems: [{ id: 'sub-1', title: 'Statements', done: false }],
              ...over,
            },
          ],
        },
      ],
    })

  const itemSnapshot = /^select id, done, completed_at[\s\S]*from checklist_items$/i

  it('snapshots the waiting columns before the wipe', async () => {
    const fake = fakePostgres({ priorItemRows: [priorRow] })
    await postgresStore(fake).write(payload())

    const snapshot = fake.matching(itemSnapshot)[0]
    expect(snapshot.text).toMatch(/waiting_ons/)
    expect(snapshot.text).toMatch(/sub_items/)
    // Taken BEFORE the delete, or there would be nothing left to preserve.
    expect(fake.indexOf(itemSnapshot)).toBeLessThan(fake.indexOf(/^delete from checklist_items$/i))
  })

  it('re-inserts the STORED waits rather than the payload copy', async () => {
    const fake = fakePostgres({ priorItemRows: [priorRow] })
    await postgresStore(fake).write(payload({ waitingOns: [] }))

    const insert = fake.matching(/^insert into checklist_items\b/i)[0]
    const waitingOns = JSON.parse(insert.params[11])
    expect(waitingOns).toHaveLength(1)
    expect(waitingOns[0].id).toBe('wo-keep')
    // The sub-item's wait rides the sub_items JSONB and survives the same way.
    expect(String(insert.params[12])).toContain('wo-sub')
  })

  it('re-inserts the stored note, task link and flag while the wait is live', async () => {
    const fake = fakePostgres({ priorItemRows: [priorRow] })
    await postgresStore(fake).write(
      payload({
        waiting: false,
        waitingOn: 'never mind',
        waitingForChecklistId: 'cl-somewhere-else',
        waitingOns: [],
      }),
    )

    const insert = fake.matching(/^insert into checklist_items\b/i)[0]
    expect(insert.params[8]).toBe('Lisa to send them')
    expect(insert.params[9]).toBe(true)
    expect(insert.params[10]).toBe('cl-other')
  })

  it('lets the payload win once the stored wait is approved', async () => {
    const fake = fakePostgres({
      priorItemRows: [
        {
          ...priorRow,
          waiting_ons: [
            {
              ...storedWait,
              resolvedAt: '2026-08-09T00:00:00.000Z',
              resolvedBy: 'emp-1',
              verifiedAt: '2026-08-10T00:00:00.000Z',
              verifiedBy: 'emp-2',
            },
          ],
        },
      ],
    })
    await postgresStore(fake).write(
      payload({ waiting: false, waitingOn: '', waitingForChecklistId: '' }),
    )

    const insert = fake.matching(/^insert into checklist_items\b/i)[0]
    expect(insert.params[8]).toBeNull()
    expect(insert.params[9]).toBe(false)
    expect(insert.params[10]).toBeNull()
    // The record is still restored — it is never the thing that goes.
    expect(JSON.parse(insert.params[11])[0].id).toBe('wo-keep')
  })
})

/**
 * featreq-cbb7efe8: "the submit button remains clickable even after a week or
 * pay period has already been submitted, which can allow duplicate or erroneous
 * submissions."
 *
 * The button is now grayed out (see `submitTimesheetButtonState`), but a UI-only
 * guard is not a guard. These pin what the store already does, so the guarantee
 * survives whatever the client sends: `weekly_submissions` is keyed on
 * (user, weekStart), so a re-submit can never produce a SECOND row — and an
 * already-approved week is returned untouched rather than knocked back to
 * pending.
 *
 * The one re-submit that deliberately does something is a REJECTED week: it
 * upgrades the same row back to 'pending' and clears the reviewer fields. That
 * is the resubmit path the whole rejection flow depends on, so it is pinned
 * here as behavior to preserve, not as a hole to close.
 */
describe('duplicate weekly submits (file backend)', () => {
  const USER = 'emp-1'
  const WEEK = '2026-08-09'

  const submissions = async () =>
    JSON.parse(await readFile(localDataPath, 'utf8')).weeklySubmissions ?? []

  it('records a first submit as one pending row', async () => {
    const result = await store.submitWeeklyTimesheet(USER, WEEK)

    expect(result.status).toBe('pending')
    expect(await submissions()).toHaveLength(1)
  })

  it('never writes a SECOND row for the same user and week', async () => {
    const first = await store.submitWeeklyTimesheet(USER, WEEK)
    const second = await store.submitWeeklyTimesheet(USER, WEEK)

    const rows = await submissions()
    expect(rows).toHaveLength(1)
    expect(second.id).toBe(first.id)
  })

  it('leaves an APPROVED week approved — a re-submit cannot knock it back to pending', async () => {
    await store.submitWeeklyTimesheet(USER, WEEK)
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.weeklySubmissions[0].status = 'approved'
    data.weeklySubmissions[0].reviewedBy = 'owner-1'
    data.weeklySubmissions[0].reviewedAt = '2026-08-17T00:00:00.000Z'
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const result = await store.submitWeeklyTimesheet(USER, WEEK)

    expect(result.status).toBe('approved')
    expect(result.reviewedBy).toBe('owner-1')
    const rows = await submissions()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('approved')
  })

  it('re-opens a REJECTED week on the same row — the resubmit path must survive', async () => {
    await store.submitWeeklyTimesheet(USER, WEEK)
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.weeklySubmissions[0].status = 'rejected'
    data.weeklySubmissions[0].reviewedBy = 'owner-1'
    data.weeklySubmissions[0].reviewNote = 'Fix Tuesday'
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const result = await store.submitWeeklyTimesheet(USER, WEEK)

    expect(result.status).toBe('pending')
    expect(result.reviewedBy).toBeUndefined()
    expect(result.reviewNote).toBeUndefined()
    expect(await submissions()).toHaveLength(1)
  })

  it('keeps a different week, and a different user, on their own rows', async () => {
    await store.submitWeeklyTimesheet(USER, WEEK)
    await store.submitWeeklyTimesheet(USER, '2026-08-02')
    await store.submitWeeklyTimesheet('emp-2', WEEK)

    expect(await submissions()).toHaveLength(3)
  })
})

/**
 * The Postgres half of the same guarantee. Cardinal rule 1: production is
 * Postgres, so the file-backend suite above proves nothing about it. The guard
 * there is one statement — `on conflict (user_id, week_start) do update`, with
 * the status held at 'approved' when it already was — so that is what gets
 * pinned. Drop the conflict clause and a duplicate submit becomes a duplicate
 * ROW; drop the `case` and it demotes an approved week.
 */
describe('duplicate weekly submits (postgres branch)', () => {
  it('upserts on (user_id, week_start) and holds an approved week approved', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).submitWeeklyTimesheet('emp-1', '2026-08-09')

    const insert = fake.matching(/^insert into weekly_submissions\b/i)[0]
    expect(insert).toBeDefined()
    // One row per (user, week) — the conflict target IS the no-duplicates rule.
    expect(insert.text).toMatch(/on conflict \(user_id, week_start\) do update/i)
    // …and the update refuses to demote an approved week back to pending.
    expect(insert.text).toMatch(
      /set status = case when weekly_submissions\.status = 'approved'[\s\S]*then weekly_submissions\.status/i,
    )
  })
})

/**
 * ===========================================================================
 * Invoice confidence — the store layer
 * (docs/plans/invoice-confidence-2026-08.md)
 * ===========================================================================
 *
 * Three persisted things, all of them append-only records rather than state the
 * app acts on: the lines an invoice was GENERATED with, the events describing
 * what a human then did to it, and the ratings a model wrote about it.
 *
 * The failure this whole section guards against is the one that has happened
 * three times in this file's history — a column that lives through the code
 * path being tested and dies in the bulk save, or in a backend nobody ran.
 */

/**
 * `invoices.original_line_items` — set once at insert, never written again.
 *
 * The value is only useful if it stays still. An `updateInvoice` that also
 * refreshed the snapshot would produce a diff of every invoice against itself:
 * always empty, always confident, and wrong.
 */
describe('original line items are frozen at generate (file backend)', () => {
  const period = '2026-08'

  async function seedBillableWorkspace() {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 }],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [
          {
            id: 't1',
            clientId: 'c1',
            employeeId: 'emp-1',
            date: `${period}-04`,
            minutes: 120,
            billable: true,
          },
        ],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  it('snapshots the generated lines onto the new invoice', async () => {
    await seedBillableWorkspace()

    const { created } = await store.generateInvoicesForPeriod(period)

    expect(created).toHaveLength(1)
    expect(created[0].originalLineItems).toEqual(created[0].lineItems)
    // And it is on the PERSISTED row, not just the return value.
    const stored = (await store.listInvoices({ period }))[0]
    expect(stored.originalLineItems).toEqual(stored.lineItems)
  })

  it('leaves the snapshot alone when the lines are edited', async () => {
    await seedBillableWorkspace()
    const { created } = await store.generateInvoicesForPeriod(period)
    const original = created[0].originalLineItems

    const edited = await store.updateInvoice(created[0].id, {
      lineItems: [{ kind: 'custom', label: 'Agreed flat fee', detail: '', amount: 150 }],
    })

    expect(edited.lineItems).toHaveLength(1)
    expect(edited.lineItems[0].amount).toBe(150)
    // The before-side is untouched — this is the whole point of the column.
    expect(edited.originalLineItems).toEqual(original)
    expect(edited.originalLineItems).not.toEqual(edited.lineItems)
  })

  it('snapshots the retainer’s one line too', async () => {
    await seedBillableWorkspace()

    const retainer = await store.createRetainerInvoice({ clientId: 'c1', amount: 2500, period })

    expect(retainer.originalLineItems).toEqual(retainer.lineItems)
  })

  it('reads a pre-feature row as null, never as an empty list', async () => {
    await seedBillableWorkspace()
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-old',
        clientId: 'c1',
        period,
        number: 'INV-2026-08-001',
        status: 'draft',
        lineItems: [{ kind: 'custom', label: 'Work', detail: '', amount: 100 }],
        subtotal: 100,
        total: 100,
        dueDate: '2026-09-30',
        blurb: '',
        scopeFlags: [],
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    // `[]` would read as "she deleted every line"; null is "we never knew".
    expect((await store.listInvoices({ period }))[0].originalLineItems).toBeNull()
  })
})

/**
 * The bulk save's snapshot/restore pair, for the new column.
 *
 * `invoices` is the one table `write()` wipes without re-inserting from the
 * payload, so a column added to the DDL but not to BOTH halves of that pair is
 * silently dropped on the next owner autosave. Three past data-loss bugs were
 * exactly this. The select and the insert are asserted separately because
 * getting one and missing the other is the actual failure mode.
 */
describe('bulk save round-trips original_line_items (postgres branch)', () => {
  const generated = [{ kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 250 }]
  const withOriginal = { ...existingInvoice, original_line_items: generated }

  it('snapshots the column before the wipe', async () => {
    const fake = fakePostgres({ invoices: [withOriginal] })
    await postgresStore(fake).write(workspace())

    const snapshot = fake.matching(/^select[\s\S]*from invoices$/i)[0]
    expect(snapshot.text).toMatch(/original_line_items/)
  })

  it('puts the same value back', async () => {
    const fake = fakePostgres({ invoices: [withOriginal] })
    await postgresStore(fake).write(workspace())

    const restore = fake.matching(/^insert into invoices \(/i)[0]
    expect(restore.text).toMatch(/original_line_items/)
    expect(restore.params).toContain(JSON.stringify(generated))
  })

  it('restores a pre-feature row’s NULL as NULL, not as []', async () => {
    const fake = fakePostgres({ invoices: [{ ...existingInvoice, original_line_items: null }] })
    await postgresStore(fake).write(workspace())

    const restore = fake.matching(/^insert into invoices \(/i)[0]
    // The column sits one before created_at in the parameter list. NULL, not
    // the '[]' that `scope_flags` and `email_log` legitimately carry — an empty
    // array here would read as "she deleted every line".
    expect(restore.params[20]).toBeNull()
    expect(restore.params[21]).toBe(existingInvoice.created_at)
  })

  it('writes the snapshot on insert and never on update', async () => {
    const fake = fakePostgres({ invoices: [existingInvoice] })
    const pg = postgresStore(fake)

    await pg._insertInvoice({
      id: 'inv-new',
      clientId: 'c1',
      period: '2026-08',
      number: 'INV-2026-08-009',
      status: 'draft',
      lineItems: generated,
      subtotal: 250,
      total: 250,
      dueDate: '2026-09-30',
      blurb: '',
      scopeFlags: [],
    })
    await pg.updateInvoice('inv-1', { blurb: 'Thank you!' })

    const insert = fake.matching(/^insert into invoices \(/i)[0]
    expect(insert.text).toMatch(/original_line_items/)
    expect(insert.params).toContain(JSON.stringify(generated))
    // THE POINT: no update statement may name the column.
    for (const statement of fake.matching(/^update invoices\b/i)) {
      expect(statement.text).not.toMatch(/original_line_items/)
    }
  })
})

/**
 * `invoice_review_events` — the record of what a human did.
 *
 * Two properties matter more than the rest. The diff is COMPACT: only fields
 * that moved, because this feeds a prompt and a whole-invoice dump per edit
 * would crowd out the draft being judged. And a save that changed nothing
 * writes nothing — an event per autosave would fill the corpus with noise that
 * looks exactly like a correction.
 */
describe('invoice review events (file backend)', () => {
  async function seedInvoice(overrides = {}) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-1',
        clientId: 'c1',
        period: '2026-08',
        number: 'INV-2026-08-001',
        status: 'draft',
        lineItems: [{ kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 }],
        originalLineItems: [
          { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
        ],
        subtotal: 200,
        total: 200,
        dueDate: '2026-09-30',
        blurb: '',
        scopeFlags: [],
        ...overrides,
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  beforeEach(async () => {
    await clearInvoiceIntelligence()
    await seedInvoice()
  })

  it('records only the fields that moved', async () => {
    await store.updateInvoice('inv-1', { blurb: 'Thanks!' })

    const [event] = await store.listInvoiceReviewEvents({ invoiceId: 'inv-1' })
    expect(Object.keys(event.changes)).toEqual(['blurb'])
    expect(event.changes.blurb).toEqual({ before: '', after: 'Thanks!' })
    expect(event.event).toBe('edited')
    expect(event.clientId).toBe('c1')
    expect(event.period).toBe('2026-08')
  })

  it('carries the before and after of a line edit', async () => {
    await store.updateInvoice('inv-1', {
      lineItems: [{ kind: 'custom', label: 'Agreed flat fee', detail: '', amount: 150 }],
    })

    const [event] = await store.listInvoiceReviewEvents({ invoiceId: 'inv-1' })
    expect(Object.keys(event.changes)).toEqual(['lineItems'])
    expect(event.changes.lineItems.before[0].amount).toBe(200)
    expect(event.changes.lineItems.after[0].label).toBe('Agreed flat fee')
  })

  it('writes NOTHING when the save changed nothing', async () => {
    await store.updateInvoice('inv-1', {})
    await store.updateInvoice('inv-1', { blurb: '' })

    expect(await store.listInvoiceReviewEvents({ invoiceId: 'inv-1' })).toEqual([])
  })

  it('names the approval rather than the edit that rode along with it', async () => {
    await store.updateInvoice('inv-1', {
      status: 'reviewed',
      lineItems: [{ kind: 'custom', label: 'Agreed flat fee', detail: '', amount: 150 }],
    })

    const [event] = await store.listInvoiceReviewEvents({ invoiceId: 'inv-1' })
    expect(event.event).toBe('reviewed')
    // …and the lines she fixed on the way are still in the payload.
    expect(event.changes.lineItems).toBeDefined()
    expect(event.changes.status).toEqual({ before: 'draft', after: 'reviewed' })
  })

  it('names an un-approval and a void', async () => {
    await store.updateInvoice('inv-1', { status: 'reviewed' })
    await store.updateInvoice('inv-1', { status: 'draft' })
    await store.updateInvoice('inv-1', { status: 'void' })

    const events = await store.listInvoiceReviewEvents({ invoiceId: 'inv-1' })
    expect(events.map((event) => event.event)).toEqual(['voided', 'unreviewed', 'reviewed'])
  })

  it('takes the actor from the caller, never from the patch body', async () => {
    await store.updateInvoice(
      'inv-1',
      { blurb: 'Thanks!', actorUserId: 'emp-impostor' },
      { actorUserId: 'emp-patrice' },
    )

    const [event] = await store.listInvoiceReviewEvents({ invoiceId: 'inv-1' })
    expect(event.actorUserId).toBe('emp-patrice')
  })

  it('defaults the actor to null when no session user is passed', async () => {
    await store.updateInvoice('inv-1', { blurb: 'Thanks!' })

    const [event] = await store.listInvoiceReviewEvents({ invoiceId: 'inv-1' })
    expect(event.actorUserId).toBeNull()
  })

  it('filters by client and caps the list', async () => {
    await store.updateInvoice('inv-1', { blurb: 'One' })
    await store.updateInvoice('inv-1', { blurb: 'Two' })
    await store.updateInvoice('inv-1', { blurb: 'Three' })

    expect(await store.listInvoiceReviewEvents({ clientId: 'c1' })).toHaveLength(3)
    expect(await store.listInvoiceReviewEvents({ clientId: 'nobody' })).toEqual([])
    expect(await store.listInvoiceReviewEvents({ invoiceId: 'inv-1', limit: 2 })).toHaveLength(2)
  })

  it('leaves original_line_items alone through every one of those saves', async () => {
    await store.updateInvoice('inv-1', {
      lineItems: [{ kind: 'custom', label: 'Agreed flat fee', detail: '', amount: 150 }],
    })
    await store.updateInvoice('inv-1', { status: 'reviewed' })

    const stored = (await store.listInvoices({ period: '2026-08' }))[0]
    expect(stored.originalLineItems[0].amount).toBe(200)
  })
})

/**
 * `invoice_ai_reviews` — what the model said, and what Brittany answered back.
 *
 * The supersede rule is the load-bearing part: history is kept, but exactly one
 * row per invoice is CURRENT. Two current rows would put two verdicts on one
 * badge, decided by whichever the sort reached first.
 */
describe('invoice AI reviews (file backend)', () => {
  const rating = (overrides = {}) => ({
    invoiceId: 'inv-1',
    clientId: 'c1',
    period: '2026-08',
    model: 'claude-opus-5',
    confidence: 'high',
    score: 92,
    summary: 'Lines match the month’s billable hours.',
    concerns: [{ line: 'Billable hours — Lisa', issue: 'Rounded up', severity: 'info' }],
    questions: [
      { id: 'q1', question: 'Should the rush job be billed?', answer: null, skipped: false },
    ],
    linesFingerprint: 'sha-a',
    ...overrides,
  })

  beforeEach(clearInvoiceIntelligence)

  it('stores a rating and hands it back as the current one', async () => {
    const saved = await store.createInvoiceAiReview(rating())

    expect(saved.id).toMatch(/^airev-/)
    expect(saved.superseded).toBe(false)
    expect(await store.getInvoiceAiReview('inv-1')).toMatchObject({
      id: saved.id,
      confidence: 'high',
      score: 92,
    })
  })

  it('sanitizes a band and a score the model got wrong', async () => {
    const saved = await store.createInvoiceAiReview(
      rating({ confidence: 'extremely high', score: 4200 }),
    )

    expect(saved.confidence).toBe('medium')
    expect(saved.score).toBe(100)
    expect((await store.createInvoiceAiReview(rating({ score: -5 }))).score).toBe(0)
  })

  it('refuses a rating with no invoice to be about', async () => {
    expect(await store.createInvoiceAiReview({ confidence: 'high' })).toBeNull()
  })

  it('supersedes the prior rating rather than replacing it', async () => {
    const first = await store.createInvoiceAiReview(rating())
    const second = await store.createInvoiceAiReview(rating({ score: 55, confidence: 'low' }))

    expect((await store.getInvoiceAiReview('inv-1')).id).toBe(second.id)
    // History kept: the old row is still on file, marked.
    const authState = JSON.parse(await readFile(localAuthPath, 'utf8'))
    const stored = authState.invoiceAiReviews.find((entry) => entry.id === first.id)
    expect(stored.superseded).toBe(true)
  })

  it('lists only the current rating for the period, one per invoice', async () => {
    await store.createInvoiceAiReview(rating())
    const current = await store.createInvoiceAiReview(rating({ score: 55 }))
    await store.createInvoiceAiReview(rating({ invoiceId: 'inv-2', score: 70 }))
    await store.createInvoiceAiReview(rating({ invoiceId: 'inv-3', period: '2026-07' }))

    const listed = await store.listInvoiceAiReviews({ period: '2026-08' })

    expect(listed.map((entry) => entry.invoiceId).sort()).toEqual(['inv-1', 'inv-2'])
    expect(listed.find((entry) => entry.invoiceId === 'inv-1').id).toBe(current.id)
  })

  it('answers the question that was asked, and only that one', async () => {
    await store.createInvoiceAiReview(
      rating({
        questions: [
          { id: 'q1', question: 'Bill the rush job?', answer: null, skipped: false },
          { id: 'q2', question: 'Is the March true-up still owed?', answer: null, skipped: false },
        ],
      }),
    )

    const updated = await store.answerInvoiceAiReviewQuestion('inv-1', 'q2', {
      answer: 'No — she paid it in April.',
    })

    expect(updated.questions[1]).toMatchObject({
      id: 'q2',
      answer: 'No — she paid it in April.',
      skipped: false,
    })
    expect(updated.questions[1].answeredAt).toBeTruthy()
    // The other question is untouched, including its null answer.
    expect(updated.questions[0]).toMatchObject({ id: 'q1', answer: null, skipped: false })
    // And it persisted, rather than only being returned.
    expect((await store.getInvoiceAiReview('inv-1')).questions[1].answer).toBe(
      'No — she paid it in April.',
    )
  })

  it('records a skip as a skip', async () => {
    await store.createInvoiceAiReview(rating())

    const updated = await store.answerInvoiceAiReviewQuestion('inv-1', 'q1', { skipped: true })

    expect(updated.questions[0]).toMatchObject({ skipped: true, answer: null })
    expect(updated.questions[0].answeredAt).toBeTruthy()
  })

  it('throws on a question id that isn’t there', async () => {
    await store.createInvoiceAiReview(rating())

    await expect(
      store.answerInvoiceAiReviewQuestion('inv-1', 'q99', { answer: 'Yes' }),
    ).rejects.toThrow(/no question by that id/i)
  })

  it('throws when the invoice has no current rating at all', async () => {
    await expect(
      store.answerInvoiceAiReviewQuestion('inv-nope', 'q1', { answer: 'Yes' }),
    ).rejects.toThrow(/no current AI review/i)
  })

  it('fills in a missing question id so the answer has something to name', async () => {
    const saved = await store.createInvoiceAiReview(
      rating({ questions: [{ question: 'Bill the rush job?' }] }),
    )

    expect(saved.questions[0].id).toBe('q1')
    await expect(
      store.answerInvoiceAiReviewQuestion('inv-1', 'q1', { answer: 'Yes' }),
    ).resolves.toBeTruthy()
  })
})

/**
 * The learning context — the corpus the rating prompt reads before judging the
 * next draft.
 *
 * It is a SUMMARY on purpose. Two full line arrays per correction would crowd
 * out the invoice being rated, so corrections arrive as removed/added/changed
 * label lists and answers arrive as question-and-answer pairs. The client's own
 * history leads; a few firm-wide entries follow, and never the same client
 * twice.
 */
describe('invoice learning context (file backend)', () => {
  async function seedTwoClientInvoices() {
    await store.write(
      workspace({
        clients: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-1',
        clientId: 'c1',
        period: '2026-08',
        number: 'INV-2026-08-001',
        status: 'draft',
        lineItems: [
          { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
          { kind: 'custom', label: 'Cleanup', detail: '', amount: 75 },
        ],
        subtotal: 275,
        total: 275,
        dueDate: '2026-09-30',
        blurb: '',
        scopeFlags: [],
      },
      {
        id: 'inv-2',
        clientId: 'c2',
        period: '2026-08',
        number: 'INV-2026-08-002',
        status: 'draft',
        lineItems: [{ kind: 'custom', label: 'Monthly service', detail: '', amount: 500 }],
        subtotal: 500,
        total: 500,
        dueDate: '2026-09-30',
        blurb: '',
        scopeFlags: [],
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  beforeEach(async () => {
    await clearInvoiceIntelligence()
    await seedTwoClientInvoices()
  })

  it('returns this client’s answered questions and her corrections', async () => {
    await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      confidence: 'medium',
      score: 70,
      questions: [
        { id: 'q1', question: 'Bill the cleanup?' },
        { id: 'q2', question: 'Is the rate still $100?' },
      ],
    })
    await store.answerInvoiceAiReviewQuestion('inv-1', 'q1', { answer: 'No — it was quoted flat.' })
    await store.answerInvoiceAiReviewQuestion('inv-1', 'q2', { skipped: true })
    // …and the correction itself: the cleanup line goes, the hours are re-priced.
    await store.updateInvoice('inv-1', {
      lineItems: [{ kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 180 }],
    })

    const context = await store.listInvoiceLearningContext('c1')

    expect(context.answeredQuestions).toHaveLength(1)
    expect(context.answeredQuestions[0]).toMatchObject({
      scope: 'client',
      period: '2026-08',
      answer: 'No — it was quoted flat.',
    })
    expect(context.corrections).toHaveLength(1)
    expect(context.corrections[0]).toMatchObject({ scope: 'client', invoiceId: 'inv-1' })
    expect(context.corrections[0].removed).toEqual(['Cleanup ($75)'])
    expect(context.corrections[0].changed).toEqual(['Billable hours — Lisa: $200 → $180'])
    expect(context.corrections[0].added).toEqual([])
  })

  it('does not count a skipped question as an answer', async () => {
    await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Bill the cleanup?' }],
    })
    await store.answerInvoiceAiReviewQuestion('inv-1', 'q1', { skipped: true })

    expect((await store.listInvoiceLearningContext('c1')).answeredQuestions).toEqual([])
  })

  it('does not count an approval as a correction', async () => {
    await store.updateInvoice('inv-1', { status: 'reviewed' })

    expect((await store.listInvoiceLearningContext('c1')).corrections).toEqual([])
  })

  it('adds a few firm-wide entries, and never this client twice', async () => {
    await store.createInvoiceAiReview({
      invoiceId: 'inv-2',
      clientId: 'c2',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Does Globex still get the discount?' }],
    })
    await store.answerInvoiceAiReviewQuestion('inv-2', 'q1', { answer: 'Yes, through December.' })
    await store.updateInvoice('inv-2', {
      lineItems: [{ kind: 'custom', label: 'Monthly service', detail: '', amount: 450 }],
    })

    const context = await store.listInvoiceLearningContext('c1')

    expect(context.answeredQuestions).toHaveLength(1)
    expect(context.answeredQuestions[0].scope).toBe('firm')
    expect(context.corrections).toHaveLength(1)
    expect(context.corrections[0]).toMatchObject({ scope: 'firm', clientId: 'c2' })
    // The firm slice EXCLUDES this client, so nothing is said twice.
    expect(context.corrections.filter((entry) => entry.clientId === 'c1')).toEqual([])
  })

  it('caps both scopes', async () => {
    for (let round = 0; round < 6; round += 1) {
      await store.updateInvoice('inv-1', {
        lineItems: [
          { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 - round },
        ],
      })
      await store.updateInvoice('inv-2', {
        lineItems: [{ kind: 'custom', label: 'Monthly service', detail: '', amount: 500 - round }],
      })
    }

    const context = await store.listInvoiceLearningContext('c1', { limit: 2, firmLimit: 1 })

    expect(context.corrections.filter((entry) => entry.scope === 'client')).toHaveLength(2)
    expect(context.corrections.filter((entry) => entry.scope === 'firm')).toHaveLength(1)
  })

  it('keeps an answer that a later re-rate superseded', async () => {
    await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Bill the cleanup?' }],
    })
    await store.answerInvoiceAiReviewQuestion('inv-1', 'q1', { answer: 'No — quoted flat.' })
    // Re-rated after her edits; the row holding her answer is now superseded.
    await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Bill the cleanup?' }],
    })

    const context = await store.listInvoiceLearningContext('c1')

    // Her answer is still her answer — it is not a property of the verdict.
    expect(context.answeredQuestions.map((entry) => entry.answer)).toEqual(['No — quoted flat.'])
  })
})

/**
 * The two ways a second rating landing at the wrong moment corrupts the first.
 *
 * Both are real here rather than theoretical: the generate hook rates a whole
 * month in the background while the owner can press Re-rate on any row of it,
 * so a background write and a manual one racing on ONE invoice is the ordinary
 * case, not the edge.
 */
describe('invoice AI reviews under concurrency (postgres branch)', () => {
  const aiReviewRow = {
    id: 'airev-1',
    invoice_id: 'inv-1',
    client_id: 'c1',
    period: '2026-08',
    model: 'claude-opus-5',
    confidence: 'high',
    score: 92,
    summary: 'Lines match the month’s billable hours.',
    concerns: [],
    questions: [
      { id: 'q1', question: 'Bill the rush job?', answer: null, skipped: false, answeredAt: null },
    ],
    lines_fingerprint: 'sha-a',
    superseded: false,
    created_at: new Date('2026-08-20T00:00:00.000Z'),
  }

  /**
   * `update … where superseded = false` re-checks only the rows the statement's
   * own snapshot can see, so under READ COMMITTED two interleaved ratings each
   * supersede what they saw and then insert — leaving TWO current rows and a
   * badge that changes between page loads. The per-invoice advisory lock is
   * what makes the existing order correct, and it is only correct if it is
   * taken FIRST.
   */
  it('takes a per-invoice advisory lock before superseding anything', async () => {
    const fake = fakePostgres()

    await postgresStore(fake).createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      confidence: 'high',
      score: 92,
    })

    const begin = fake.indexOf(/^BEGIN$/i)
    const lock = fake.indexOf(/pg_advisory_xact_lock/i)
    const supersede = fake.indexOf(/^update invoice_ai_reviews set superseded = true/i)
    const insert = fake.indexOf(/^insert into invoice_ai_reviews/i)
    const commit = fake.indexOf(/^COMMIT$/i)

    expect(begin).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(begin)
    expect(supersede).toBeGreaterThan(lock)
    expect(insert).toBeGreaterThan(supersede)
    expect(commit).toBeGreaterThan(insert)
    // Keyed on the invoice, so two DIFFERENT invoices still rate in parallel —
    // the generate hook rates a whole month at once.
    expect(fake.statements[lock].params).toEqual(['inv-1'])
  })

  it('guards the answer write on the row still being current', async () => {
    const fake = fakePostgres({ aiReviewRows: [aiReviewRow] })

    await postgresStore(fake).answerInvoiceAiReviewQuestion('inv-1', 'q1', { answer: 'Yes' })

    const update = fake.matching(/^update invoice_ai_reviews set questions/i)[0]
    expect(update.text).toMatch(/where id = \$1 and superseded = false/i)
    expect(update.params[0]).toBe('airev-1')
  })

  it('refuses the answer, 409, when a re-rate got there first', async () => {
    // The read saw a current review; by the time the update ran, a newer rating
    // had superseded it — so the guarded statement matches no row.
    const fake = fakePostgres({ aiReviewRows: [aiReviewRow], aiReviewUpdateRowCount: 0 })

    const failure = await postgresStore(fake)
      .answerInvoiceAiReviewQuestion('inv-1', 'q1', { answer: 'Yes' })
      .catch((error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.name).toBe('InvoiceAiReviewError')
    expect(failure.message).toMatch(/replaced by a newer rating/i)
    // The route answers `error.statusCode ?? 404`; this one is not "gone", it
    // is "you are looking at an old copy", and refreshing fixes it.
    expect(failure.statusCode).toBe(409)
  })
})

/**
 * Cardinal rule 1 for the same guard: the file backend has no WHERE clause, so
 * it re-checks the stored row itself. The race is staged by making the read
 * return a review that is superseded on disk — which is exactly what a re-rate
 * landing between the read and the write produces.
 */
describe('answering a superseded review (file backend)', () => {
  beforeEach(clearInvoiceIntelligence)

  it('refuses with the same 409 rather than writing into a dead row', async () => {
    const first = await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Bill the rush job?' }],
    })
    // The re-rate lands, superseding the row the page is holding.
    await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Bill the rush job?' }],
    })
    // …and her answer arrives naming the old one.
    vi.spyOn(store, 'getInvoiceAiReview').mockResolvedValue(first)

    const failure = await store
      .answerInvoiceAiReviewQuestion('inv-1', 'q1', { answer: 'Yes' })
      .catch((error) => error)

    expect(failure.name).toBe('InvoiceAiReviewError')
    expect(failure.statusCode).toBe(409)
    vi.restoreAllMocks()

    // Nothing was written: the superseded row still holds an unanswered question.
    const authState = JSON.parse(await readFile(localAuthPath, 'utf8'))
    const stale = authState.invoiceAiReviews.find((entry) => entry.id === first.id)
    expect(stale.questions[0].answer).toBeNull()
  })

  it('still answers normally when the row is the current one', async () => {
    await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Bill the rush job?' }],
    })

    const updated = await store.answerInvoiceAiReviewQuestion('inv-1', 'q1', { answer: 'Yes' })

    expect(updated.questions[0].answer).toBe('Yes')
  })

  it('keeps 404 on the two not-found refusals — only the race is a 409', async () => {
    await store.createInvoiceAiReview({
      invoiceId: 'inv-1',
      clientId: 'c1',
      period: '2026-08',
      questions: [{ id: 'q1', question: 'Bill the rush job?' }],
    })

    const noQuestion = await store
      .answerInvoiceAiReviewQuestion('inv-1', 'q99', { answer: 'Yes' })
      .catch((error) => error)
    const noReview = await store
      .answerInvoiceAiReviewQuestion('inv-nope', 'q1', { answer: 'Yes' })
      .catch((error) => error)

    expect(noQuestion.statusCode).toBe(404)
    expect(noReview.statusCode).toBe(404)
  })
})

/**
 * THE PAID LOCK — `updateInvoice` refuses to rewrite an invoice the client has
 * paid, or is in the middle of paying.
 *
 * Brittany's rule verbatim (featreq-ead3a215): "invoices should not be editable
 * once paid all invoices should lock after paid." She wrote it answering a
 * narrower question about retainer credits and gave the general rule instead.
 *
 * File backend, same reasoning as the two blocks above: production is Postgres
 * and is validated separately with a rolled-back transaction (HANDOFF §4). What
 * is pinned here is the contract BOTH branches implement — and they implement
 * one guard, not two, which the source assertion at the end is what protects.
 */
describe('the paid lock (file backend)', () => {
  function invoice(id, status, overrides = {}) {
    return {
      id,
      clientId: 'c1',
      period: '2026-08',
      kind: 'monthly',
      number: `INV-2026-08-${id.slice(-3)}`,
      status,
      lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
      subtotal: 400,
      total: 400,
      dueDate: '2026-09-15',
      blurb: 'Thanks for your business.',
      scopeFlags: [],
      sentAt: null,
      paidAt: status === 'paid' ? '2026-08-20T00:00:00.000Z' : null,
      paymentMethod: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    }
  }

  beforeEach(async () => {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      invoice('inv-paid', 'paid'),
      invoice('inv-processing', 'processing'),
      invoice('inv-sent', 'sent'),
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  })

  async function stored(id) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    return data.invoices.find((entry) => entry.id === id)
  }

  it('refuses a line edit on a paid invoice and writes NOTHING', async () => {
    await expect(
      store.updateInvoice('inv-paid', {
        lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 1 }],
      }),
    ).rejects.toBeInstanceOf(InvoiceLockedError)

    // The refusal is only half of it — a guard that threw AFTER writing would
    // pass an assertion on the error alone.
    const after = await stored('inv-paid')
    expect(after.total).toBe(400)
    expect(after.lineItems[0].amount).toBe(400)
    expect(after.updatedAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('refuses the note to the client on a paid invoice', async () => {
    await expect(store.updateInvoice('inv-paid', { blurb: 'rewritten' })).rejects.toBeInstanceOf(
      InvoiceLockedError,
    )
    expect((await stored('inv-paid')).blurb).toBe('Thanks for your business.')
  })

  // Money in flight. Days can pass in this state, and the row locks afterwards
  // anyway — with whatever was typed into it baked in.
  it('refuses an edit while a payment is still settling', async () => {
    await expect(
      store.updateInvoice('inv-processing', { blurb: 'rewritten' }),
    ).rejects.toBeInstanceOf(InvoiceLockedError)
    expect((await stored('inv-processing')).blurb).toBe('Thanks for your business.')
  })

  it('refuses being walked back to draft', async () => {
    await expect(store.updateInvoice('inv-paid', { status: 'draft' })).rejects.toBeInstanceOf(
      InvoiceLockedError,
    )
    expect((await stored('inv-paid')).status).toBe('paid')
  })

  // THE ESCAPE HATCH. Without this a wrong paid invoice would be permanent, and
  // the lock would be a trap rather than a record.
  it('still allows voiding a paid invoice', async () => {
    const result = await store.updateInvoice('inv-paid', { status: 'void' })
    expect(result).not.toBeNull()
    expect((await stored('inv-paid')).status).toBe('void')
  })

  // THE DELIBERATE BOUNDARY. Nobody has paid a sent invoice yet, and correcting
  // one before they do is ordinary bookkeeping she never asked to lose.
  it('still allows editing a sent invoice', async () => {
    const result = await store.updateInvoice('inv-sent', { blurb: 'corrected' })
    expect(result).not.toBeNull()
    expect((await stored('inv-sent')).blurb).toBe('corrected')
  })

  /**
   * POSITION, not behavior — the thing this feature will actually rot on.
   *
   * Cardinal rule 1: any persisted change must touch both backends. The guard
   * satisfies that by sitting ABOVE the `if (this.pool)` split, so one check
   * covers Postgres and the file alike. Move it inside either branch and every
   * test above still passes while production loses the lock, silently — which is
   * exactly the shape of bug that rule exists to catch.
   */
  it('guards above the backend split, so one check covers both', async () => {
    const source = await readFile(
      path.join(projectRoot, 'db', 'store.js'),
      'utf8',
    )
    const start = source.indexOf('async updateInvoice(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('async ', start + 40))

    const guard = body.indexOf('invoiceLockRefusal(')
    const split = body.indexOf('if (this.pool)')
    expect(guard).toBeGreaterThan(-1)
    expect(split).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(split)
  })
})

/**
 * The time-breakdown settings survive a bulk save.
 *
 * This is the test the last three data-loss bugs did not have. Minutes
 * precision, invoice drafts and creation dates were all the same shape: the
 * bulk save wipes `clients` and re-inserts every row from the payload, and a
 * column missing from that INSERT is gone with no error anywhere — green tests,
 * green deploy, and a client complaint weeks later.
 *
 * Two new columns went into that statement for featreq-… , so they get pinned
 * here on the way in rather than discovered on the way out.
 */
describe('invoice time-breakdown settings round-trip the bulk save (file backend)', () => {
  const settings = { invoiceTimeBreakdownMode: 'week', invoiceTimeBreakdownAmounts: true }

  it('keeps the mode and the amounts flag across write -> read', async () => {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', ...settings }],
      }),
    )

    const back = await store.read()
    const client = back.clients.find((entry) => entry.id === 'c1')
    expect(client).toMatchObject(settings)
  })

  it('defaults to off for a client that has never been given one', async () => {
    await store.write(workspace({ clients: [{ id: 'c1', name: 'Acme' }] }))

    const client = (await store.read()).clients.find((entry) => entry.id === 'c1')
    expect(client.invoiceTimeBreakdownMode).toBe('off')
    expect(client.invoiceTimeBreakdownAmounts).toBe(false)
  })

  // A payload is not a promise. Off is the safe direction, so anything the
  // store does not recognize lands there instead of starting to print hours.
  it('refuses an unrecognized mode rather than storing it', async () => {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme', invoiceTimeBreakdownMode: 'everything' }],
      }),
    )

    const client = (await store.read()).clients.find((entry) => entry.id === 'c1')
    expect(client.invoiceTimeBreakdownMode).toBe('off')
  })

  it('carries them through createClient too', async () => {
    const created = await store.createClient({
      name: 'Northwind',
      contact: '',
      billingMode: 'subscription',
      hourlyRate: 0,
      ...settings,
    })
    expect(created).toMatchObject(settings)

    const client = (await store.read()).clients.find((entry) => entry.id === created.id)
    expect(client).toMatchObject(settings)
  })

  /**
   * POSITION, the same way the paid lock pins its guard: both `clients` INSERTs
   * are positional, so a column added to one list and not the other silently
   * writes the wrong value into the wrong column. Counting them is what catches
   * an edit that looks right and is off by one.
   */
  it('keeps both clients INSERT statements balanced', async () => {
    const source = await readFile(path.join(projectRoot, 'db', 'store.js'), 'utf8')
    const re = /insert into clients\s*\(([\s\S]*?)\)\s*\n?\s*values\s*\(([\s\S]*?)\)/g
    let match
    let statements = 0
    while ((match = re.exec(source))) {
      statements += 1
      const columns = match[1]
        .split(',')
        .map((column) => column.replace(/\/\/[^\n]*/g, '').trim())
        .filter(Boolean)
      const values = match[2].split(',').map((value) => value.trim()).filter(Boolean)
      expect(values.length, `statement ${statements} columns vs values`).toBe(columns.length)
      expect(columns).toContain('invoice_time_breakdown_mode')
      expect(columns).toContain('invoice_time_breakdown_amounts')
      // Consolidated billing (featreq-65f5eac1) — same reason, same test. A
      // client's bill-to link surviving one statement and not the other would
      // silently un-group four companies on the next owner autosave.
      expect(columns).toContain('bill_to_client_id')
      expect(columns).toContain('is_billing_master')
      expect(columns).toContain('invoice_recipient_client_id')
    }
    expect(statements).toBeGreaterThan(0)
  })
})

/**
 * CONSOLIDATED BILLING — one invoice to a BILLING MASTER carrying several
 * companies' work. featreq-65f5eac1, plan of record
 * `docs/plans/consolidated-billing-2026-08.md`.
 *
 * Brittany's shape, verbatim: "KLC Master Client - no data enterered or
 * collected but shows data for the 4 combined sends invoice to sub client you
 * choose". So there are three new client columns, a `sourceClientId` on every
 * line, a merge in the generator, and four write paths that now REFUSE a master
 * rather than accepting work it could never show anywhere.
 *
 * The bulk save's `clients` INSERT is POSITIONAL and three past data-loss bugs
 * were all the same shape — a column added to one of the two statements and not
 * the other. That is why the round-trips below come first and why the
 * column-count test above names these columns too.
 */
describe('consolidated billing: the three client columns (file backend)', () => {
  const roster = () => [
    {
      id: 'klc-master',
      name: 'KLC Master',
      isBillingMaster: true,
      invoiceRecipientClientId: 'sub-klc',
    },
    { id: 'sub-klc', name: 'KLC Floors & More', billToClientId: 'klc-master' },
    { id: 'sub-x', name: 'XAct', billToClientId: 'klc-master' },
  ]

  const storedClient = async (id) =>
    (await store.read()).clients.find((client) => client.id === id)

  it('round-trips all three across the bulk save', async () => {
    await store.write(workspace({ clients: roster(), timeEntries: [] }))

    expect(await storedClient('klc-master')).toMatchObject({
      isBillingMaster: true,
      billToClientId: null,
      invoiceRecipientClientId: 'sub-klc',
    })
    expect(await storedClient('sub-x')).toMatchObject({
      isBillingMaster: false,
      billToClientId: 'klc-master',
      invoiceRecipientClientId: null,
    })
  })

  it('answers null/false for a client that has never had one', async () => {
    await store.write(workspace({ clients: [{ id: 'c1', name: 'Acme' }], timeEntries: [] }))

    expect(await storedClient('c1')).toMatchObject({
      billToClientId: null,
      isBillingMaster: false,
      invoiceRecipientClientId: null,
    })
  })

  it('carries them through createClient too', async () => {
    await store.write(workspace({ clients: roster(), timeEntries: [] }))

    const created = await store.createClient({
      name: 'Chemtrex',
      contact: '',
      billingMode: 'hourly',
      hourlyRate: 100,
      billToClientId: 'klc-master',
    })

    expect(created.billToClientId).toBe('klc-master')
    expect((await storedClient(created.id)).billToClientId).toBe('klc-master')
  })
})

/**
 * The sanitizer, which is `sanitizeClientPlanRefs`'s twin and exists for the
 * same reason: neither id column has a foreign key, and the last time an FK-free
 * client column held a reference to a row that was gone it crashed every bulk
 * write and took the app offline for a day (2026-06-17).
 */
describe('consolidated billing: bill-to links are resolved on write', () => {
  const links = (clients) => sanitizeClientBillingLinks(clients)

  const master = { id: 'm', name: 'KLC Master', isBillingMaster: true }

  it('drops a bill-to pointing at a client that is not there', () => {
    const out = links([master, { id: 's', billToClientId: 'ghost' }])
    expect(out.get('s').billToClientId).toBeNull()
  })

  it('drops a bill-to pointing at itself', () => {
    const out = links([master, { id: 's', billToClientId: 's' }])
    expect(out.get('s').billToClientId).toBeNull()
  })

  it('drops a bill-to pointing at a client that is not a master', () => {
    const out = links([master, { id: 's', billToClientId: 'other' }, { id: 'other' }])
    expect(out.get('s').billToClientId).toBeNull()
  })

  // ONE LEVEL ONLY. A master that could itself be billed elsewhere is a chain,
  // and a chain is a loop waiting to happen.
  it('drops a master’s own bill-to, so there are no chains', () => {
    const out = links([
      master,
      { id: 'm2', name: 'Second master', isBillingMaster: true, billToClientId: 'm' },
    ])
    expect(out.get('m2').billToClientId).toBeNull()
    expect(out.get('m2').isBillingMaster).toBe(true)
  })

  it('drops a recipient that is not one of the master’s own subs', () => {
    const out = links([
      { ...master, invoiceRecipientClientId: 'stranger' },
      { id: 's', billToClientId: 'm' },
      { id: 'stranger' },
    ])
    expect(out.get('m').invoiceRecipientClientId).toBeNull()
  })

  it('drops a recipient named on a client that is not a master', () => {
    const out = links([master, { id: 's', billToClientId: 'm', invoiceRecipientClientId: 's2' }])
    expect(out.get('s').invoiceRecipientClientId).toBeNull()
  })

  it('keeps the links that hold', () => {
    const out = links([
      { ...master, invoiceRecipientClientId: 's' },
      { id: 's', billToClientId: 'm' },
    ])
    expect(out.get('m').invoiceRecipientClientId).toBe('s')
    expect(out.get('s').billToClientId).toBe('m')
  })

  /**
   * The bulk save CLEANS rather than refuses. It is the owner tab's autosave and
   * it re-inserts the whole workspace; a save that throws because a stale tab
   * still remembers a deleted master is the plan-refs outage in a new column.
   */
  it('nulls a dangling link on the bulk save without refusing the save', async () => {
    await expect(
      store.write(
        workspace({
          clients: [{ id: 'c1', name: 'Acme', billToClientId: 'deleted-master' }],
          timeEntries: [],
        }),
      ),
    ).resolves.toBeUndefined()

    const stored = (await store.read()).clients.find((client) => client.id === 'c1')
    expect(stored.billToClientId).toBeNull()
    // And the rest of the client survived — cleaning one field must not cost a row.
    expect(stored.name).toBe('Acme')
  })

  // `sanitizeAppData`'s standing contract: a clean save passes through
  // UNCHANGED. A client that never mentioned a bill-to must not come out of it
  // having grown one — absence is given its meaning by the read mappers, and
  // three fields quietly added to fifty clients on every autosave is churn the
  // staleness fingerprint would feel.
  it('does not grow the fields on a client that never had them', () => {
    const client = { id: 'c1', name: 'Acme' }
    sanitizeAppData({ clients: [client] })
    expect('billToClientId' in client).toBe(false)
    expect('isBillingMaster' in client).toBe(false)
    expect('invoiceRecipientClientId' in client).toBe(false)
  })

  it('strips a master’s estimated hours on the bulk save', async () => {
    await store.write(
      workspace({
        clients: [
          {
            id: 'klc-master',
            name: 'KLC Master',
            isBillingMaster: true,
            estimatedBookkeeperHours: 12,
            estimatedAccountantHours: 3,
          },
        ],
        timeEntries: [],
      }),
    )

    const stored = (await store.read()).clients.find((client) => client.id === 'klc-master')
    expect(stored.estimatedBookkeeperHours).toBeUndefined()
    expect(stored.estimatedAccountantHours).toBeUndefined()
  })
})

/**
 * The create path says the SAME rules out loud. One deliberate create has a
 * person waiting on the answer, and a silently-nulled field would leave her
 * looking at a "Bills to" she set and the app did not keep.
 */
describe('consolidated billing: createClient refuses a link that does not hold', () => {
  beforeEach(async () => {
    await store.write(
      workspace({
        clients: [
          { id: 'klc-master', name: 'KLC Master', isBillingMaster: true },
          { id: 'sub-x', name: 'XAct', billToClientId: 'klc-master' },
          { id: 'plain', name: 'Acme' },
        ],
        timeEntries: [],
      }),
    )
  })

  const create = (overrides) =>
    store.createClient({
      name: 'Chemtrex',
      contact: '',
      billingMode: 'hourly',
      hourlyRate: 100,
      ...overrides,
    })

  it('refuses a bill-to that is not on file', async () => {
    await expect(create({ billToClientId: 'ghost' })).rejects.toBeInstanceOf(BillingMasterError)
    await expect(create({ billToClientId: 'ghost' })).rejects.toThrow(/no longer on file/i)
  })

  it('refuses a bill-to pointing at an ordinary client', async () => {
    await expect(create({ billToClientId: 'plain' })).rejects.toThrow(/not a billing master/i)
  })

  it('refuses a master that is itself billed elsewhere', async () => {
    await expect(
      create({ isBillingMaster: true, billToClientId: 'klc-master' }),
    ).rejects.toThrow(/cannot itself be billed/i)
  })

  it('refuses a recipient that is not one of this master’s subs', async () => {
    await expect(
      create({ isBillingMaster: true, invoiceRecipientClientId: 'sub-x' }),
    ).rejects.toThrow(/own sub clients/i)
  })

  it('refuses estimated hours on a master', async () => {
    await expect(
      create({ isBillingMaster: true, estimatedBookkeeperHours: 8 }),
    ).rejects.toThrow(/holds no work of its own/i)
  })

  it('allows the link that holds', async () => {
    const created = await create({ billToClientId: 'klc-master' })
    expect(created.billToClientId).toBe('klc-master')
  })
})

/**
 * "No data enterered or collected." The app REFUSES rather than
 * allows-and-ignores: a master has no Recap of its own beyond the roll-up of its
 * subs and its invoice is built entirely from their drafts, so an hour logged
 * against it would simply stop existing.
 *
 * Four paths, deliberately. A guard on a path nobody uses is a guard nobody
 * maintains.
 */
describe('consolidated billing: a billing master refuses work of its own', () => {
  beforeEach(async () => {
    await store.write(
      workspace({
        clients: [
          { id: 'klc-master', name: 'KLC Master', isBillingMaster: true },
          { id: 'sub-x', name: 'XAct', billToClientId: 'klc-master' },
        ],
        timeEntries: [],
        checklistTemplates: [
          {
            id: 'tpl-1',
            title: 'Monthly close',
            clientId: '',
            isStandard: true,
            frequency: 'monthly',
            nextDueDate: '2026-09-01',
            stages: [{ id: 'stage-1', name: 'Stage 1', assigneeId: 'emp-1', offsetDays: 0, items: [] }],
          },
        ],
      }),
    )
  })

  it('refuses a time entry', async () => {
    await expect(
      store.createTimeEntry({ clientId: 'klc-master', employeeId: 'emp-1', minutes: 30 }),
    ).rejects.toBeInstanceOf(BillingMasterError)
    await expect(
      store.createTimeEntry({ clientId: 'klc-master', employeeId: 'emp-1', minutes: 30 }),
    ).rejects.toThrow(/KLC Master is a billing master/)
  })

  it('refuses a checklist', async () => {
    await expect(
      store.createChecklist({ title: 'Close', clientId: 'klc-master', assigneeId: 'emp-1', items: [] }),
    ).rejects.toBeInstanceOf(BillingMasterError)
  })

  it('refuses a recurring recipe copied onto it', async () => {
    await expect(
      store.copyTemplateToClient('tpl-1', { clientId: 'klc-master' }),
    ).rejects.toBeInstanceOf(BillingMasterError)
  })

  it('refuses a recurring reimbursement', async () => {
    await expect(
      store.addRecurringReimbursement({
        clientId: 'klc-master',
        description: 'QuickBooks Online',
        amount: 90,
        frequency: 'monthly',
        startDate: '2026-08-01',
      }),
    ).rejects.toBeInstanceOf(BillingMasterError)
  })

  // Re-targeting is the same write as creating. The endpoint validates that a
  // target exists and is visible, which a billing master both is.
  it('refuses a time entry moved onto it', async () => {
    const entry = await store.createTimeEntry({
      clientId: 'sub-x',
      employeeId: 'emp-1',
      minutes: 30,
    })
    await expect(
      store.updateTimeEntry(entry.id, { clientId: 'klc-master' }),
    ).rejects.toBeInstanceOf(BillingMasterError)
    // Nothing moved.
    expect((await store.getTimeEntry(entry.id)).clientId).toBe('sub-x')
  })

  it('refuses a split that allocates any time to it', async () => {
    const entry = await store.createTimeEntry({
      clientId: 'sub-x',
      employeeId: 'emp-1',
      date: '2026-08-04',
      minutes: 60,
      billable: true,
      description: 'Bank rec',
      sessions: [],
    })
    await expect(
      store.splitTimeEntry(
        entry.id,
        [
          { clientId: 'sub-x', minutes: 30 },
          { clientId: 'klc-master', minutes: 30 },
        ],
        'emp-1',
        'grp-1',
        'custom',
      ),
    ).rejects.toBeInstanceOf(BillingMasterError)
    // Refused before a single slice was written — the source is untouched.
    expect((await store.getTimeEntry(entry.id)).minutes).toBe(60)
  })

  it('refuses a split ADJUSTMENT that allocates any time to it', async () => {
    await expect(
      store.adjustSplitGroup(
        'grp-1',
        [
          { clientId: 'sub-x', minutes: 30 },
          { clientId: 'klc-master', minutes: 30 },
        ],
        'emp-1',
        'custom',
      ),
    ).rejects.toBeInstanceOf(BillingMasterError)
    // The control: the same call naming only subs gets the ordinary answer for
    // a group that is not there, which is what proves the guard did not fire.
    await expect(
      store.adjustSplitGroup('grp-1', [{ clientId: 'sub-x', minutes: 30 }], 'emp-1', 'custom'),
    ).rejects.not.toBeInstanceOf(BillingMasterError)
  })

  it('refuses a one-off reimbursement', async () => {
    await expect(
      store.addReimbursement({
        clientId: 'klc-master',
        date: '2026-08-04',
        description: 'Courier',
        amount: 40,
      }),
    ).rejects.toBeInstanceOf(BillingMasterError)
  })

  // The control. All of them still work on the SUB — the guard is about the payer
  // row, not about being part of a group.
  it('leaves the subs alone', async () => {
    expect(
      await store.createTimeEntry({ clientId: 'sub-x', employeeId: 'emp-1', minutes: 30 }),
    ).toMatchObject({ clientId: 'sub-x' })
    expect(
      await store.addRecurringReimbursement({
        clientId: 'sub-x',
        description: 'QuickBooks Online',
        amount: 90,
        frequency: 'monthly',
        startDate: '2026-08-01',
      }),
    ).toMatchObject({ clientId: 'sub-x' })
    expect(
      await store.addReimbursement({
        clientId: 'sub-x',
        date: '2026-08-04',
        description: 'Courier',
        amount: 40,
      }),
    ).toMatchObject({ clientId: 'sub-x' })
    // A missing source template is the ordinary null, not a refusal — proof the
    // guard did not fire on the way past.
    expect(await store.copyTemplateToClient('nope', { clientId: 'sub-x' })).toBeNull()
  })
})

/**
 * The merge. One invoice, the master's number, every line stamped with the sub
 * it came from.
 */
describe('consolidated billing: generateInvoicesForPeriod merges the subs', () => {
  const period = '2026-08'

  async function seedGroup(overrides = {}) {
    await store.write(
      workspace({
        clients: [
          { id: 'plain', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 },
          { id: 'sub-b', name: 'Bright Tower', billingMode: 'hourly', hourlyRate: 100 },
          { id: 'sub-x', name: 'XAct', billingMode: 'hourly', hourlyRate: 100 },
          { id: 'klc-master', name: 'KLC Master', isBillingMaster: true, billingMode: 'hourly', hourlyRate: 0 },
        ].map((client) =>
          client.id === 'sub-b' || client.id === 'sub-x'
            ? { ...client, billToClientId: 'klc-master' }
            : client,
        ),
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [
          { id: 't-plain', clientId: 'plain', employeeId: 'emp-1', date: `${period}-02`, minutes: 60, billable: true },
          { id: 't-b', clientId: 'sub-b', employeeId: 'emp-1', date: `${period}-04`, minutes: 120, billable: true },
          { id: 't-x', clientId: 'sub-x', employeeId: 'emp-1', date: `${period}-05`, minutes: 60, billable: true },
        ],
        ...overrides,
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  it('skips each sub with a reason that names its master', async () => {
    await seedGroup()

    const result = await store.generateInvoicesForPeriod(period)

    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { clientId: 'sub-b', reason: 'billed-to-other', billedToClientId: 'klc-master' },
        { clientId: 'sub-x', reason: 'billed-to-other', billedToClientId: 'klc-master' },
      ]),
    )
    // And nothing was generated FOR them — the whole point.
    expect(result.created.map((invoice) => invoice.clientId).sort()).toEqual([
      'klc-master',
      'plain',
    ])
  })

  it('says so when a master has nobody pointing at it', async () => {
    await store.write(
      workspace({
        clients: [{ id: 'klc-master', name: 'KLC Master', isBillingMaster: true }],
        timeEntries: [],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const result = await store.generateInvoicesForPeriod(period)

    expect(result.skipped).toEqual([{ clientId: 'klc-master', reason: 'master-without-subs' }])
  })

  it('builds ONE invoice for the master, sharing the month’s number sequence', async () => {
    await seedGroup()

    const result = await store.generateInvoicesForPeriod(period)

    const merged = result.created.filter((invoice) => invoice.clientId === 'klc-master')
    expect(merged).toHaveLength(1)
    // Acme is first in the roster, so the master takes the second number of the
    // month. One sequence, no special case.
    expect(result.created.map((invoice) => invoice.number)).toEqual([
      'INV-2026-08-001',
      'INV-2026-08-002',
    ])
    expect(merged[0].number).toBe('INV-2026-08-002')
  })

  it('stamps every line with the sub it came from, in client-name order', async () => {
    await seedGroup()

    const result = await store.generateInvoicesForPeriod(period)
    const merged = result.created.find((invoice) => invoice.clientId === 'klc-master')

    // Bright Tower before XAct — name order, so the document reads the same way
    // every month.
    expect(merged.lineItems.map((line) => line.sourceClientId)).toEqual(['sub-b', 'sub-x'])
    // Two hours and one hour at $100.
    expect(merged.subtotal).toBe(300)
    expect(merged.total).toBe(300)
  })

  it('carries a sub’s AD HOC line onto the merge', async () => {
    // A sub no longer gets an invoice of its own, so ad hoc work left behind
    // would be billed ZERO times rather than exactly once.
    await seedGroup({
      timeEntries: [
        { id: 't-b', clientId: 'sub-b', employeeId: 'emp-1', date: `${period}-04`, minutes: 120, billable: true },
        {
          id: 't-x-adhoc',
          clientId: 'sub-x',
          employeeId: 'emp-1',
          date: `${period}-05`,
          minutes: 60,
          billable: true,
          isAdhoc: true,
        },
      ],
    })

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'klc-master' })
    const merged = result.created[0]

    const adhoc = merged.lineItems.filter((line) => line.kind === 'adhoc')
    expect(adhoc.length).toBeGreaterThan(0)
    expect(adhoc.every((line) => line.sourceClientId === 'sub-x')).toBe(true)
  })

  /**
   * A sub's own billing history, derived from the lines rather than kept as a
   * second money record. "One payment lands on one invoice, so a company is paid
   * when the invoice is" (plan §2).
   */
  it('reports each sub’s own subtotal off the master’s invoice', async () => {
    await seedGroup()
    await store.generateInvoicesForPeriod(period)

    const brightTower = await store.listBilledOnInvoices('sub-b', { period })
    const xact = await store.listBilledOnInvoices('sub-x')

    expect(brightTower).toEqual([
      {
        invoiceId: expect.any(String),
        number: 'INV-2026-08-002',
        period,
        status: 'draft',
        masterClientId: 'klc-master',
        masterClientName: 'KLC Master',
        subtotal: 200,
        paidAt: null,
      },
    ])
    expect(xact[0].subtotal).toBe(100)
    // An ordinary client is on nobody else's invoice.
    expect(await store.listBilledOnInvoices('plain')).toEqual([])
  })

  /** Put an invoice on a sub directly — the generator will no longer make one. */
  async function giveOwnInvoice(clientId, overrides = {}) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      ...(data.invoices ?? []),
      {
        id: `inv-${clientId}`,
        clientId,
        period,
        number: `INV-${period}-050`,
        kind: 'monthly',
        status: 'sent',
        lineItems: [{ kind: 'hourly', label: 'August', amount: 200 }],
        subtotal: 200,
        total: 200,
        dueDate: '2026-09-30',
        blurb: '',
        scopeFlags: [],
        sentAt: null,
        paidAt: null,
        ...overrides,
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  /**
   * THE MIGRATION MONTH. August is already billed per-company; the master starts
   * at the first unbilled month Alex chooses (plan §0). A first run against an
   * already-billed month must not issue a second payable document for work a
   * client has already been invoiced for.
   */
  it('leaves a sub that already holds its own live invoice off the merge', async () => {
    await seedGroup()
    await giveOwnInvoice('sub-b')

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'klc-master' })

    expect(result.skipped).toContainEqual({
      clientId: 'sub-b',
      reason: 'already-billed-on-own-invoice',
    })
    const merged = result.created[0]
    // XAct alone. Bright Tower's two hours are on the invoice it already has.
    expect(merged.lineItems.map((line) => line.sourceClientId)).toEqual(['sub-x'])
    expect(merged.subtotal).toBe(100)
  })

  it('does not double-bill a VOIDED sub invoice — that one merges', async () => {
    await seedGroup()
    await giveOwnInvoice('sub-b', { status: 'void' })

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'klc-master' })

    // A withdrawn invoice bills nobody, so the work is still owed and belongs on
    // the merge — the same rule `liveClientIds` applies everywhere else.
    expect(result.created[0].lineItems.map((line) => line.sourceClientId)).toEqual([
      'sub-b',
      'sub-x',
    ])
  })

  /**
   * A true-up on a sub's last per-company invoice is real money. After the
   * migration the master's invoice is the only place left for it to land, so the
   * sub's draft is built with the SUB's own prior invoice.
   */
  it('carries a sub’s own prior-month true-up onto the master’s invoice', async () => {
    await seedGroup()
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = [
      {
        id: 'inv-prior-b',
        clientId: 'sub-b',
        period: '2026-07',
        number: 'INV-2026-07-001',
        kind: 'monthly',
        status: 'paid',
        lineItems: [],
        subtotal: 0,
        total: 0,
        scopeFlags: [],
        adjustmentForNextPeriod: 25,
      },
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const merged = (await store.generateInvoicesForPeriod(period, { clientId: 'klc-master' }))
      .created[0]

    expect(merged.lineItems.find((line) => line.kind === 'adjustment')).toMatchObject({
      amount: 25,
      sourceClientId: 'sub-b',
    })
    // And she is TOLD: a sub-level true-up on a merged invoice means the sub was
    // still invoicing on its own when it should not have been.
    expect(merged.scopeFlags.map((flag) => flag.kind)).toContain('sub-adjustment')
    // Outside the subtotal, inside the total — an adjustment's ordinary place.
    expect(merged.subtotal).toBe(300)
    expect(merged.total).toBe(325)
  })

  /** Move a seeded client's lifecycle without disturbing anything else. */
  async function setStage(clientId, lifecycleStage) {
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.clients.find((entry) => entry.id === clientId).lifecycleStage = lifecycleStage
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  // A retired sub is on NO invoice — the merge leaves it out for the same reason
  // this loop does — so "billed on the master's invoice" would be a false
  // answer, and a confident one.
  it('reports a retired sub as retired, not as billed on the master', async () => {
    await seedGroup()
    await setStage('sub-b', 'inactive')

    expect(
      (await store.generateInvoicesForPeriod(period, { clientId: 'sub-b' })).skipped,
    ).toEqual([{ clientId: 'sub-b', reason: 'client-inactive' }])
  })

  it('reports a prospect sub as not billable yet', async () => {
    await seedGroup()
    await setStage('sub-b', 'proposal')

    expect(
      (await store.generateInvoicesForPeriod(period, { clientId: 'sub-b' })).skipped,
    ).toEqual([{ clientId: 'sub-b', reason: 'not-billable-yet' }])
  })

  it('stays silent about a retired sub on the month run', async () => {
    await seedGroup()
    await setStage('sub-b', 'inactive')

    const result = await store.generateInvoicesForPeriod(period)

    expect(result.skipped.filter((row) => row.clientId === 'sub-b')).toEqual([])
    // And its hours are off the merge.
    const merged = result.created.find((invoice) => invoice.clientId === 'klc-master')
    expect(merged.lineItems.map((line) => line.sourceClientId)).toEqual(['sub-x'])
  })

  it('leaves a VOIDED master invoice off the sub’s history', async () => {
    await seedGroup()
    await store.generateInvoicesForPeriod(period)
    const [billed] = await store.listBilledOnInvoices('sub-b')

    await store.updateInvoice(billed.invoiceId, { status: 'void' })

    // A withdrawn invoice billed nobody; on a sub's page it would read as money
    // owed. It stays in the master's own History as the withdrawal it is.
    expect(await store.listBilledOnInvoices('sub-b')).toEqual([])
  })
})

/**
 * The GROUP-DISSOLVING AUTOSAVE. A payload that clears `isBillingMaster` on the
 * payer while its subs still point at it silently un-groups every one of them.
 * Warned, never refused — the bulk save must not throw — and Railway's log is
 * where the last outage was reconstructed from.
 */
describe('consolidated billing: a dissolved group is logged, not refused', () => {
  it('warns and names every link it dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await store.write(
        workspace({
          clients: [
            { id: 'klc-master', name: 'KLC Master', isBillingMaster: false },
            { id: 'sub-x', name: 'XAct', billToClientId: 'klc-master' },
          ],
          timeEntries: [],
        }),
      )

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('dropped 1 bill-to link'),
        [{ id: 'sub-x', billToClientId: 'klc-master' }],
      )
    } finally {
      warn.mockRestore()
    }
    // And the save landed: the group is gone, the clients are not.
    const clients = (await store.read()).clients
    expect(clients.map((client) => client.id).sort()).toEqual(['klc-master', 'sub-x'])
  })

  it('says nothing when every link holds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await store.write(
        workspace({
          clients: [
            { id: 'klc-master', name: 'KLC Master', isBillingMaster: true },
            { id: 'sub-x', name: 'XAct', billToClientId: 'klc-master' },
          ],
          timeEntries: [],
        }),
      )
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes('bill-to link')),
      ).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

/**
 * COVERAGE ACROSS THE MERGE. Each company has its own QBO recurring charge with
 * its own covered-date ledger; the line must still be generated and the window
 * still advanced — on somebody else's invoice (plan §1).
 *
 * `_commitCoverageForInvoice` and `_deriveCoverageFlags` both key off the LINE's
 * `recurringId` rather than the invoice's client, which is what makes this work.
 * These pin that, because a "scope it to the invoice's client" tidy-up would
 * look reasonable and would silently stop four cycles.
 */
describe('consolidated billing: a sub’s covered-date ledger rides the master’s invoice', () => {
  const period = '2026-08'

  async function seedGroupWithCoverage() {
    await store.write(
      workspace({
        clients: [
          { id: 'sub-b', name: 'Bright Tower', billingMode: 'subscription', monthlyRate: 500, billToClientId: 'klc-master' },
          { id: 'klc-master', name: 'KLC Master', isBillingMaster: true },
        ],
        employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper', billRate: 100 }],
        timeEntries: [],
        recurringReimbursements: [
          {
            id: 'recur-qbo',
            clientId: 'sub-b',
            description: 'QuickBooks Online',
            amount: 90,
            frequency: 'monthly',
            startDate: '2026-07-01',
            coverageEnabled: true,
            coverageTemplate: '{description} — {range}',
            coverageStart: '2026-07-13',
            coverageEnd: '2026-08-13',
            coveragePaused: false,
            coverageResumePending: false,
            coverageHistory: {},
          },
        ],
      }),
    )
    const data = JSON.parse(await readFile(localDataPath, 'utf8'))
    data.invoices = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  const readExpense = async () =>
    (await store.read()).recurringReimbursements.find((entry) => entry.id === 'recur-qbo')

  it('commits the sub’s window when the MASTER’s invoice is generated', async () => {
    await seedGroupWithCoverage()

    const result = await store.generateInvoicesForPeriod(period, { clientId: 'klc-master' })

    const line = result.created[0].lineItems.find((entry) => entry.recurringId === 'recur-qbo')
    expect(line).toBeTruthy()
    expect(line.sourceClientId).toBe('sub-b')
    // The first window is the one she typed on the expense; the ledger entry is
    // written against the MASTER's invoice all the same, which is the point.
    expect((await readExpense()).coverageHistory[period]).toMatchObject({
      start: '2026-07-13',
      end: '2026-08-13',
    })
  })

  it('still refuses to mark the MASTER’s invoice reviewed while dates are unanswered', async () => {
    await seedGroupWithCoverage()
    await store.generateInvoicesForPeriod(period, { clientId: 'klc-master' })
    // September and October never billed — November must not stride across them.
    const november = await store.generateInvoicesForPeriod('2026-11', { clientId: 'klc-master' })

    expect(
      november.created[0].lineItems.find((line) => line.recurringId === 'recur-qbo'),
    ).toMatchObject({ needsCoverageConfirmation: true, sourceClientId: 'sub-b' })
    await expect(
      store.updateInvoice(november.created[0].id, { status: 'reviewed' }),
    ).rejects.toThrow(/confirm the covered dates/i)
  })

  it('keeps sourceClientId through an editor save', async () => {
    // `sanitizeInvoiceLines` strips props it does not name, so one round trip
    // through the editor would un-attribute the whole merged invoice.
    await seedGroupWithCoverage()
    const [invoice] = (await store.generateInvoicesForPeriod(period, { clientId: 'klc-master' }))
      .created

    const saved = await store.updateInvoice(invoice.id, { lineItems: invoice.lineItems })

    expect(saved.lineItems.every((line) => line.sourceClientId === 'sub-b')).toBe(true)
  })
})

/**
 * The POSTGRES statements. Production is Postgres and these tests run the file
 * backend, so a column that reaches one and not the other passes CI in silence —
 * cardinal rule 1. Driven through the fake pool, which pins the SQL rather than
 * the database.
 */
describe('consolidated billing: the Postgres statements', () => {
  const boundClientColumns = (statement) => {
    const match = /insert into clients\s*\(([\s\S]*?)\)\s*\n?\s*values/i.exec(statement.text)
    const columns = match[1]
      .split(',')
      .map((column) => column.replace(/\/\/[^\n]*/g, '').trim())
      .filter(Boolean)
    const bound = {}
    statement.params.forEach((value, index) => {
      bound[columns[index]] = value
    })
    return bound
  }

  it('creates the three columns on boot', async () => {
    const fake = fakePostgres()
    // The fake cannot answer every probe `initialize()` makes (it returns no
    // rows for the migration counts), so it is run for the DDL it ISSUES — which
    // all lands before the first of those.
    await postgresStore(fake).initialize().catch(() => {})

    expect(
      fake.matching(/^alter table clients add column if not exists bill_to_client_id text$/i),
    ).toHaveLength(1)
    expect(
      fake.matching(
        /^alter table clients add column if not exists is_billing_master boolean not null default false$/i,
      ),
    ).toHaveLength(1)
    expect(
      fake.matching(
        /^alter table clients add column if not exists invoice_recipient_client_id text$/i,
      ),
    ).toHaveLength(1)
  })

  it('binds them on the bulk save’s positional insert', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(
      workspace({
        clients: [
          { id: 'klc-master', name: 'KLC Master', isBillingMaster: true, invoiceRecipientClientId: 'sub-x' },
          { id: 'sub-x', name: 'XAct', billToClientId: 'klc-master' },
        ],
        timeEntries: [],
      }),
    )

    const inserts = fake.matching(/^insert into clients/i)
    expect(inserts).toHaveLength(2)
    expect(boundClientColumns(inserts[0])).toMatchObject({
      id: 'klc-master',
      is_billing_master: true,
      bill_to_client_id: null,
      invoice_recipient_client_id: 'sub-x',
    })
    expect(boundClientColumns(inserts[1])).toMatchObject({
      id: 'sub-x',
      is_billing_master: false,
      bill_to_client_id: 'klc-master',
      invoice_recipient_client_id: null,
    })
  })

  it('binds them on createClient', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).createClient({
      name: 'Chemtrex',
      contact: '',
      billingMode: 'hourly',
      hourlyRate: 100,
    })

    const [insert] = fake.matching(/^insert into clients/i)
    expect(boundClientColumns(insert)).toMatchObject({
      bill_to_client_id: null,
      is_billing_master: false,
      invoice_recipient_client_id: null,
    })
  })

  it('reads them back in read()', async () => {
    const fake = fakePostgres({
      clientRows: [
        {
          id: 'sub-x',
          name: 'XAct',
          contact: '',
          billing_mode: 'hourly',
          hourly_rate: 100,
          bill_to_client_id: 'klc-master',
          is_billing_master: false,
          invoice_recipient_client_id: null,
        },
      ],
    })
    const data = await postgresStore(fake).read()

    expect(data.clients[0]).toMatchObject({
      billToClientId: 'klc-master',
      isBillingMaster: false,
      invoiceRecipientClientId: null,
    })
    // And the select actually asks for them.
    const [select] = fake.matching(/^select[\s\S]*from clients[\s\S]*order by name asc/i)
    expect(select.text).toMatch(/bill_to_client_id/)
    expect(select.text).toMatch(/is_billing_master/)
    expect(select.text).toMatch(/invoice_recipient_client_id/)
  })

  it('narrows listBilledOnInvoices with a jsonb containment match', async () => {
    const fake = fakePostgres({
      invoices: [
        {
          id: 'inv-1',
          client_id: 'klc-master',
          period: '2026-08',
          number: 'INV-2026-08-002',
          kind: 'monthly',
          status: 'sent',
          line_items: [
            { kind: 'hourly', label: 'Bright Tower', amount: 200, sourceClientId: 'sub-b' },
            { kind: 'hourly', label: 'XAct', amount: 100, sourceClientId: 'sub-x' },
          ],
          subtotal: 300,
          total: 300,
          master_client_name: 'KLC Master',
        },
      ],
    })

    const rows = await postgresStore(fake).listBilledOnInvoices('sub-b', { period: '2026-08' })

    expect(rows).toEqual([
      {
        invoiceId: 'inv-1',
        number: 'INV-2026-08-002',
        period: '2026-08',
        status: 'sent',
        masterClientId: 'klc-master',
        masterClientName: 'KLC Master',
        subtotal: 200,
        paidAt: null,
      },
    ])
    const [select] = fake.matching(/from invoices i/i)
    expect(select.text).toMatch(/line_items @> \$1::jsonb/)
    // A voided invoice billed nobody — filtered in the statement, not after it.
    expect(select.text).toMatch(/status <> 'void'/)
    expect(select.params[0]).toBe('[{"sourceClientId":"sub-b"}]')
    expect(select.params[1]).toBe('2026-08')
  })

  it('refuses a time entry on a master through the Postgres branch', async () => {
    const fake = fakePostgres({
      clientRows: [{ id: 'klc-master', name: 'KLC Master', is_billing_master: true }],
    })

    await expect(
      postgresStore(fake).createTimeEntry({
        clientId: 'klc-master',
        employeeId: 'emp-1',
        minutes: 30,
      }),
    ).rejects.toThrow(/KLC Master is a billing master/)
    // Refused BEFORE the insert — the refusal is the whole of what happened.
    expect(fake.matching(/^\s*insert into time_entries/i)).toHaveLength(0)
  })

  it('lets an ordinary client through the same Postgres guard', async () => {
    const fake = fakePostgres({
      clientRows: [{ id: 'plain', name: 'Acme', is_billing_master: false }],
    })

    await postgresStore(fake).createTimeEntry({
      clientId: 'plain',
      employeeId: 'emp-1',
      minutes: 30,
    })

    expect(fake.matching(/^\s*insert into time_entries/i)).toHaveLength(1)
  })

  it('refuses a bad bill-to on createClient through the Postgres branch', async () => {
    const fake = fakePostgres({
      clientRows: [{ id: 'plain', name: 'Acme', is_billing_master: false }],
    })

    await expect(
      postgresStore(fake).createClient({
        name: 'Chemtrex',
        contact: '',
        billingMode: 'hourly',
        hourlyRate: 100,
        billToClientId: 'plain',
      }),
    ).rejects.toThrow(/not a billing master/i)
    expect(fake.matching(/^insert into clients/i)).toHaveLength(0)
  })

  it('accepts a bill-to naming a real master through the Postgres branch', async () => {
    const fake = fakePostgres({
      clientRows: [{ id: 'klc-master', name: 'KLC Master', is_billing_master: true }],
    })

    const created = await postgresStore(fake).createClient({
      name: 'Chemtrex',
      contact: '',
      billingMode: 'hourly',
      hourlyRate: 100,
      billToClientId: 'klc-master',
    })

    expect(created.billToClientId).toBe('klc-master')
    expect(boundClientColumns(fake.matching(/^insert into clients/i)[0])).toMatchObject({
      bill_to_client_id: 'klc-master',
    })
  })

  /**
   * The bulk save's invoice SNAPSHOT/RESTORE. Lines are jsonb, so they ride the
   * pair whole — but "whole" is a claim, and the three past data-loss bugs were
   * all a column that rode nothing. This pins that a merged invoice comes back
   * with its attribution intact.
   */
  it('restores sourceClientId through the bulk save’s invoice snapshot', async () => {
    const fake = fakePostgres({
      invoices: [
        {
          id: 'inv-1',
          client_id: 'klc-master',
          period: '2026-08',
          number: 'INV-2026-08-002',
          kind: 'monthly',
          status: 'sent',
          line_items: [{ kind: 'hourly', label: 'Bright Tower', amount: 200, sourceClientId: 'sub-b' }],
          subtotal: 200,
          total: 200,
        },
      ],
    })
    await postgresStore(fake).write(
      workspace({ clients: [{ id: 'klc-master', name: 'KLC Master', isBillingMaster: true }], timeEntries: [] }),
    )

    const [restore] = fake.matching(/^insert into invoices/i)
    const lineItems = JSON.parse(restore.params[6])
    expect(lineItems[0].sourceClientId).toBe('sub-b')
  })
})
