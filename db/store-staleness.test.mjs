import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AppDataStore, INVOICE_SELECT_COLUMNS, mapInvoiceRow } from './store.js'
import {
  BULK_SAVE_TABLES,
  StaleWorkspaceError,
  workspaceVersionSql,
} from '../lib/workspace-version.js'

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

  it('lets an unguarded write through — read()\'s materializer must not be gated', async () => {
    await store.write(workspace({ clients: [{ id: 'c1', name: 'Changed' }] }))

    // No expectedVersion => no guard at all. `read()` writes its materialized
    // output back this way, and gating that would deadlock it against itself.
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
function fakePostgres({ invoices = [], groupSlices = [] } = {}) {
  const statements = []
  const record = (text, params) => {
    const trimmed = String(text).trim()
    statements.push({ text: trimmed, params })
    if (/^select\b[\s\S]*\bfrom invoices\b/i.test(trimmed)) {
      return { rows: invoices }
    }
    // The `for update` read a split adjustment starts with.
    if (/^select\b[\s\S]*\bfrom time_entries where group_id\b/i.test(trimmed)) {
      return { rows: groupSlices, rowCount: groupSlices.length }
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
  stripe_checkout_session_id: null,
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
    // as it was, not regenerated from current data.
    expect(inserts[0].params.slice(0, 5)).toEqual([
      'inv-1',
      'c1',
      '2026-08',
      'INV-2026-08-001',
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
  })

  it('keeps the team selection, which is what drives client visibility', async () => {
    const created = await store.createClient(formValues)
    const data = await store.read()
    const stored = data.clients.find((c) => c.id === created.id)
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
      lifecycle_stage: 'proposal',
    })
  })

  it('derives client_assignments from the team the form picked', async () => {
    const fake = fakePostgres()
    const created = await postgresStore(fake).createClient(formValues)

    const assignments = fake.matching(/^insert into client_assignments/i)
    expect(assignments.map((statement) => statement.params)).toEqual([[created.id, 'emp-1']])
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
    // group_id ($17) is the same one, and it is set on every new slice.
    expect(inserts.map((statement) => statement.params[16])).toEqual(['grp-live', 'grp-live'])
    expect(inserts.map((statement) => statement.params[2])).toEqual(['c1', 'c3'])
    expect(inserts.map((statement) => statement.params[4])).toEqual([45, 15])
    // approval_status ($10): back in the queue.
    expect(inserts.map((statement) => statement.params[9])).toEqual(['pending', 'pending'])
    // sessions ($16) carried across verbatim as JSON.
    expect(JSON.parse(inserts[0].params[15])).toEqual(row('s1', 'c1', 30).sessions)

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
