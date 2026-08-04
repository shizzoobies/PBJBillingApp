import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AppDataStore } from './store.js'
import { StaleWorkspaceError } from '../lib/workspace-version.js'

/**
 * End-to-end staleness guard on the FILE backend.
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

let savedContents = null
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
