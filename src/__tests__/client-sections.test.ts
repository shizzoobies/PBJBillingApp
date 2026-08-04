import { describe, expect, it } from 'vitest'
import {
  activeChecklistsForClient,
  CLIENT_SECTION_ANCHORS,
  CLIENT_SECTION_KEYS,
  CLIENT_SECTION_LEGACY_ANCHORS,
  resolveClientSection,
  summarizeClientMonthTime,
  type ClientSection,
} from '../lib/clientSections'
import type { Checklist, TimeEntry } from '../lib/types'

/** What a bookkeeper gets: every tab except Billing. */
const STAFF_TABS: ClientSection[] = ['overview', 'checklists', 'time']

describe('resolveClientSection', () => {
  it('opens Overview by default', () => {
    expect(resolveClientSection({})).toBe('overview')
    expect(resolveClientSection({ tabParam: null, hash: null })).toBe('overview')
    expect(resolveClientSection({ available: STAFF_TABS })).toBe('overview')
  })

  it('follows an explicit ?tab=', () => {
    expect(resolveClientSection({ tabParam: 'time' })).toBe('time')
    expect(resolveClientSection({ tabParam: 'billing' })).toBe('billing')
    expect(resolveClientSection({ tabParam: 'checklists' })).toBe('checklists')
  })

  it('ignores a tab param that names nothing', () => {
    expect(resolveClientSection({ tabParam: 'nope' })).toBe('overview')
    expect(resolveClientSection({ tabParam: '' })).toBe('overview')
  })

  it('sends staff to Overview instead of the Billing tab they do not have', () => {
    // A ?tab=billing link forwarded to a bookkeeper must not open an empty tab.
    expect(resolveClientSection({ tabParam: 'billing', available: STAFF_TABS })).toBe('overview')
    expect(
      resolveClientSection({ hash: '#client-section-invoice', available: STAFF_TABS }),
    ).toBe('overview')
    // The tabs they DO have still work.
    expect(resolveClientSection({ tabParam: 'time', available: STAFF_TABS })).toBe('time')
  })

  it('follows a hash link to the tab it anchors', () => {
    expect(resolveClientSection({ hash: `#${CLIENT_SECTION_ANCHORS.time}` })).toBe('time')
    expect(resolveClientSection({ hash: CLIENT_SECTION_ANCHORS.billing })).toBe('billing')
    // A bare tab key works too.
    expect(resolveClientSection({ hash: '#checklists' })).toBe('checklists')
    // An unrelated hash falls through to the default.
    expect(resolveClientSection({ hash: '#something-else' })).toBe('overview')
  })

  it('follows an old per-panel anchor to the tab that now holds it', () => {
    // These ids were the jump-nav targets before the page was tabbed; the panels
    // still carry them, but only inside their own tab.
    expect(resolveClientSection({ hash: '#client-section-invoice' })).toBe('billing')
    expect(resolveClientSection({ hash: '#client-section-recurring' })).toBe('checklists')
    expect(resolveClientSection({ hash: '#client-section-notes' })).toBe('overview')
    expect(resolveClientSection({ hash: '#client-section-plan-checklists' })).toBe('billing')
  })

  it('lets the tab param beat a hash', () => {
    expect(
      resolveClientSection({ tabParam: 'overview', hash: '#client-section-invoice' }),
    ).toBe('overview')
  })

  it('maps every legacy anchor and every tab to something real', () => {
    expect(CLIENT_SECTION_KEYS).toEqual(['overview', 'billing', 'checklists', 'time'])
    for (const key of CLIENT_SECTION_KEYS) {
      expect(CLIENT_SECTION_ANCHORS[key]).toBeTruthy()
    }
    for (const [anchor, section] of Object.entries(CLIENT_SECTION_LEGACY_ANCHORS)) {
      expect(anchor).toMatch(/^client-section-/)
      expect(CLIENT_SECTION_KEYS).toContain(section)
    }
  })
})

function checklist(overrides: Partial<Checklist> & { id: string }): Checklist {
  return {
    title: 'Task',
    clientId: 'client-a',
    assigneeId: 'emp-1',
    dueDate: '2026-08-31',
    items: [{ id: 'i1', label: 'Step', done: false }],
    viewerIds: [],
    editorIds: [],
    ...overrides,
  }
}

describe('activeChecklistsForClient', () => {
  const today = '2026-08-04'
  const rows = [
    checklist({ id: 'a' }),
    checklist({ id: 'b', items: [{ id: 'i1', label: 'Step', done: true }] }), // Done
    checklist({ id: 'c', deletedAt: '2026-07-01T00:00:00.000Z' }), // deleted
    checklist({ id: 'd', clientId: 'client-b' }), // another client
    checklist({ id: 'e', dueDate: '2026-01-01' }), // overdue, still active
  ]

  it('keeps this client’s unfinished, undeleted checklists', () => {
    expect(activeChecklistsForClient(rows, 'client-a', today).map((row) => row.id)).toEqual([
      'a',
      'e',
    ])
  })

  it('is the same source the tab count uses', () => {
    // The count on the tab IS the length of this list — the two cannot drift.
    const list = activeChecklistsForClient(rows, 'client-a', today)
    expect(list.length).toBe(2)
    expect(activeChecklistsForClient(rows, 'client-b', today)).toHaveLength(1)
    expect(activeChecklistsForClient(rows, 'client-missing', today)).toHaveLength(0)
  })
})

function timeEntry(overrides: Partial<TimeEntry> & { id: string }): TimeEntry {
  return {
    employeeId: 'emp-1',
    clientId: 'client-a',
    date: '2026-08-03',
    minutes: 60,
    description: '',
    billable: true,
    approvalStatus: 'pending',
    entryMethod: 'timer',
    ...overrides,
  }
}

describe('summarizeClientMonthTime', () => {
  const entries = [
    timeEntry({ id: '1', minutes: 90 }),
    timeEntry({ id: '2', minutes: 30, billable: false }),
    timeEntry({ id: '3', minutes: 45, date: '2026-07-31' }), // last month
    timeEntry({ id: '4', minutes: 120, clientId: 'client-b' }), // other client
    // An unsplit group holding block has no clientId, so it is never counted
    // against a client here.
    timeEntry({ id: '5', minutes: 240, clientId: '', groupClientIds: ['client-a', 'client-b'] }),
  ]

  it('totals tracked, billable, and the entry count for the month', () => {
    expect(summarizeClientMonthTime(entries, 'client-a', '2026-08')).toEqual({
      trackedMinutes: 120,
      billableMinutes: 90,
      entryCount: 2,
    })
  })

  it('reports zeros for a month or client with nothing logged', () => {
    expect(summarizeClientMonthTime(entries, 'client-a', '2026-09')).toEqual({
      trackedMinutes: 0,
      billableMinutes: 0,
      entryCount: 0,
    })
    expect(summarizeClientMonthTime(entries, 'client-z', '2026-08')).toEqual({
      trackedMinutes: 0,
      billableMinutes: 0,
      entryCount: 0,
    })
  })

  it('counts a prior month independently', () => {
    expect(summarizeClientMonthTime(entries, 'client-a', '2026-07')).toEqual({
      trackedMinutes: 45,
      billableMinutes: 45,
      entryCount: 1,
    })
  })
})
