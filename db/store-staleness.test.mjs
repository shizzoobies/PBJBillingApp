import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AppDataStore } from './store.js'
import { StaleWorkspaceError } from '../lib/workspace-version.js'

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
 * A minimal stand-in for a `pg` Pool, enough to drive the POSTGRES branch of
 * `write()` without a database. Every statement is recorded so a test can
 * assert on what the transaction actually issued and in what order.
 *
 * `write()` only ever consumes the result of three queries â€” the users
 * pre-check, the (optional) version fingerprint, and the invoice-drafts
 * snapshot â€” so returning an empty row set for everything else is faithful.
 */
function fakePostgres({ invoiceDrafts = [] } = {}) {
  const statements = []
  const record = (text, params) => {
    const trimmed = String(text).trim()
    statements.push({ text: trimmed, params })
    if (/^select\b[\s\S]*\bfrom invoice_drafts\b/i.test(trimmed)) {
      return { rows: invoiceDrafts }
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

const existingDraft = {
  id: 'draft-1',
  client_id: 'c1',
  billing_period: '2026-08',
  status: 'draft',
  total: '250.00',
  payload: { lines: [{ label: 'August work', amount: 250 }] },
  created_at: new Date('2026-08-01T12:00:00.000Z'),
}

/**
 * `invoice_drafts` was the one table the bulk save wiped without re-inserting â€”
 * fourteen others appeared in both lists, this one only in the deletes. Nothing
 * has ever written a draft (production has 0 rows), so nothing was lost yet,
 * but the first saved draft would have been erased by the next owner autosave.
 *
 * The delete itself cannot simply go away: `invoice_drafts.client_id` is
 * `on delete restrict`, so `delete from clients` refuses to run while any draft
 * exists. `write()` therefore snapshots the rows and puts them back.
 */
describe('bulk save preserves invoice_drafts (postgres branch)', () => {
  it('re-inserts a pre-existing draft that the wipe removed', async () => {
    const fake = fakePostgres({ invoiceDrafts: [existingDraft] })
    await postgresStore(fake).write(workspace())

    const inserts = fake.matching(/^insert into invoice_drafts/i)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].params).toEqual([
      'draft-1',
      'c1',
      '2026-08',
      'draft',
      '250.00',
      JSON.stringify(existingDraft.payload),
      existingDraft.created_at,
    ])
  })

  it('still deletes first â€” the clients wipe cannot run past the FK otherwise', async () => {
    const fake = fakePostgres({ invoiceDrafts: [existingDraft] })
    await postgresStore(fake).write(workspace())

    const deleteAt = fake.indexOf(/^delete from invoice_drafts$/i)
    const clientsWipedAt = fake.indexOf(/^delete from clients$/i)
    expect(deleteAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeLessThan(clientsWipedAt)
  })

  it('restores AFTER the clients are back, so the FK is satisfied', async () => {
    const fake = fakePostgres({ invoiceDrafts: [existingDraft] })
    await postgresStore(fake).write(workspace())

    const clientInsertAt = fake.indexOf(/^insert into clients/i)
    const draftRestoreAt = fake.indexOf(/^insert into invoice_drafts/i)
    expect(clientInsertAt).toBeGreaterThan(-1)
    expect(draftRestoreAt).toBeGreaterThan(clientInsertAt)
  })

  it('drops a draft whose client is gone from the payload', async () => {
    const fake = fakePostgres({
      invoiceDrafts: [existingDraft, { ...existingDraft, id: 'draft-2', client_id: 'deleted' }],
    })
    await postgresStore(fake).write(workspace())

    const restoredIds = fake.matching(/^insert into invoice_drafts/i).map((s) => s.params[0])
    expect(restoredIds).toEqual(['draft-1'])
  })

  it('issues no restore at all when there were no drafts', async () => {
    const fake = fakePostgres()
    await postgresStore(fake).write(workspace())

    expect(fake.matching(/^insert into invoice_drafts/i)).toHaveLength(0)
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
