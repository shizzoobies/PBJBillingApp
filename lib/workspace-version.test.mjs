import { describe, expect, it } from 'vitest'
import {
  BULK_SAVE_TABLES,
  StaleWorkspaceError,
  VERSION_PART_ORDER,
  fileWorkspaceVersion,
  foldVersionRows,
  workspaceVersionSql,
} from './workspace-version.js'

/**
 * The staleness guard's fingerprint. These tests pin the two properties the
 * guard actually depends on:
 *
 *   1. STABILITY — the same workspace must hash the same every time, or live
 *      tabs get refused at random.
 *   2. SENSITIVITY — anything a bulk save would overwrite must change the hash,
 *      or the guard silently fails open and we are back to the June wipe.
 */

function workspace(overrides = {}) {
  return {
    clients: [{ id: 'c1', name: 'Acme' }],
    timeEntries: [{ id: 't1', minutes: 30, clientId: 'c1' }],
    checklists: [{ id: 'k1', title: 'Monthly', items: [{ id: 'i1', done: false }] }],
    employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper' }],
    ...overrides,
  }
}

describe('fileWorkspaceVersion', () => {
  it('is stable across repeated calls on identical data', () => {
    expect(fileWorkspaceVersion(workspace())).toBe(fileWorkspaceVersion(workspace()))
  })

  it('ignores the order records arrive in', () => {
    const ascending = workspace({
      clients: [
        { id: 'c1', name: 'Acme' },
        { id: 'c2', name: 'Beta' },
      ],
    })
    const descending = workspace({
      clients: [
        { id: 'c2', name: 'Beta' },
        { id: 'c1', name: 'Acme' },
      ],
    })
    expect(fileWorkspaceVersion(ascending)).toBe(fileWorkspaceVersion(descending))
  })

  it('ignores object key order within a record', () => {
    const a = workspace({ clients: [{ id: 'c1', name: 'Acme' }] })
    const b = workspace({ clients: [{ name: 'Acme', id: 'c1' }] })
    expect(fileWorkspaceVersion(a)).toBe(fileWorkspaceVersion(b))
  })

  it('ignores updatedAt / createdAt churn', () => {
    const before = workspace({ clients: [{ id: 'c1', name: 'Acme', updatedAt: '2026-01-01' }] })
    const after = workspace({ clients: [{ id: 'c1', name: 'Acme', updatedAt: '2026-07-26' }] })
    expect(fileWorkspaceVersion(before)).toBe(fileWorkspaceVersion(after))
  })

  it('changes when a record is added', () => {
    const grown = workspace({
      clients: [
        { id: 'c1', name: 'Acme' },
        { id: 'c2', name: 'Beta' },
      ],
    })
    expect(fileWorkspaceVersion(grown)).not.toBe(fileWorkspaceVersion(workspace()))
  })

  it('changes when a record is REMOVED — the wipe case', () => {
    // This is the June incident in miniature: a stale snapshot missing time
    // entries that exist on the server.
    const wiped = workspace({ timeEntries: [] })
    expect(fileWorkspaceVersion(wiped)).not.toBe(fileWorkspaceVersion(workspace()))
  })

  it('changes when a field is edited in place', () => {
    const renamed = workspace({ clients: [{ id: 'c1', name: 'Acme Corp' }] })
    expect(fileWorkspaceVersion(renamed)).not.toBe(fileWorkspaceVersion(workspace()))
  })

  it('changes when a nested checklist item changes', () => {
    const ticked = workspace({
      checklists: [{ id: 'k1', title: 'Monthly', items: [{ id: 'i1', done: true }] }],
    })
    expect(fileWorkspaceVersion(ticked)).not.toBe(fileWorkspaceVersion(workspace()))
  })

  it('tracks an employee RENAME (the one field a bulk save can overwrite)', () => {
    const renamed = workspace({ employees: [{ id: 'emp-1', name: 'Lisa M', role: 'bookkeeper' }] })
    expect(fileWorkspaceVersion(renamed)).not.toBe(fileWorkspaceVersion(workspace()))
  })

  it('IGNORES employee fields a bulk save cannot overwrite', () => {
    // role / email / password_hash are preserved by write()'s ON CONFLICT, so
    // hashing them would let unrelated user writes invalidate every open tab.
    const rerolled = workspace({
      employees: [{ id: 'emp-1', name: 'Lisa', role: 'owner', email: 'x@y.z' }],
    })
    expect(fileWorkspaceVersion(rerolled)).toBe(fileWorkspaceVersion(workspace()))
  })

  it('handles an empty or malformed workspace without throwing', () => {
    expect(typeof fileWorkspaceVersion({})).toBe('string')
    expect(typeof fileWorkspaceVersion(null)).toBe('string')
    expect(fileWorkspaceVersion({})).toBe(fileWorkspaceVersion(null))
  })
})

describe('foldVersionRows', () => {
  it('does not depend on row arrival order (union all makes no promise)', () => {
    const rows = VERSION_PART_ORDER.map((t, index) => ({ t, h: `h${index}` }))
    expect(foldVersionRows([...rows].reverse())).toBe(foldVersionRows(rows))
  })

  it('changes when any single table digest changes', () => {
    const rows = VERSION_PART_ORDER.map((t) => ({ t, h: 'same' }))
    const moved = rows.map((row, index) => (index === 0 ? { ...row, h: 'different' } : row))
    expect(foldVersionRows(moved)).not.toBe(foldVersionRows(rows))
  })

  it('tolerates missing rows', () => {
    expect(typeof foldVersionRows([])).toBe('string')
    expect(typeof foldVersionRows(undefined)).toBe('string')
  })
})

describe('workspaceVersionSql', () => {
  it('covers every bulk-save-owned table plus users', () => {
    const sql = workspaceVersionSql()
    for (const table of BULK_SAVE_TABLES) {
      expect(sql).toContain(`from ${table} t`)
    }
    expect(sql).toContain('from users')
  })

  it('strips the churn-only timestamp columns', () => {
    expect(workspaceVersionSql()).toContain("- 'updated_at' - 'created_at'")
  })

  it('orders deterministically so the digest is order-insensitive', () => {
    expect(workspaceVersionSql()).toContain("order by x")
  })

  it('does not fingerprint invoice_drafts (preserved across a bulk save)', () => {
    expect(BULK_SAVE_TABLES).not.toContain('invoice_drafts')
  })
})

describe('StaleWorkspaceError', () => {
  it('carries the server-side current version for the 409 response', () => {
    const error = new StaleWorkspaceError('abc123')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('StaleWorkspaceError')
    expect(error.currentVersion).toBe('abc123')
  })
})
