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

  it('refuses an entry that is not an unsplit group block', async () => {
    await store.write(
      workspace({
        clients: [{ id: 'c1', name: 'Acme' }],
        timeEntries: [holdingEntry({ id: 'plain-1', clientId: 'c1', groupClientIds: [] })],
      }),
    )
    const before = await persisted()

    await expect(
      store.splitTimeEntry('plain-1', [{ clientId: 'c1', minutes: 48.5 }], 'owner-1', 'g', 'even'),
    ).rejects.toMatchObject({ code: 'not_holding' })

    expect(await persisted()).toEqual(before)
  })
})
