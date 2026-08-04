import { describe, expect, it } from 'vitest'
import { filterInProgressChecklists, statusForChecklist } from '../lib/inProgressFilter'
import type { Checklist, Client } from '../lib/types'
import type { ReportPeriod } from '../lib/reportPeriod'

const TODAY = '2026-07-27'

const CLIENTS = [
  { id: 'c1', name: 'Acme Bakery' },
  { id: 'c2', name: 'Zenith Dental' },
] as unknown as Client[]

function mk(
  id: string,
  dueDate: string,
  extra: Partial<Checklist> = {},
): Checklist {
  return {
    id,
    clientId: 'c1',
    title: `Task ${id}`,
    assigneeId: 'e1',
    dueDate,
    frequency: 'monthly',
    items: [],
    ...extra,
  } as unknown as Checklist
}

const period = (from: string, to: string): ReportPeriod =>
  ({ preset: 'custom', from, to }) as ReportPeriod

describe('filterInProgressChecklists — report period', () => {
  const all = [
    mk('a', '2026-07-14'),
    mk('b', '2026-07-20'),
    mk('c', '2026-08-05'),
  ]

  /**
   * The reported bug, in miniature. The tab count used an UNFILTERED total
   * while the list applied the report period, so a one-day custom range showed
   * "568" above a body holding 13. Count and list now share this function, so
   * the only way they can disagree is if someone stops using it.
   */
  it('a single-day custom range admits only that day', () => {
    const scoped = filterInProgressChecklists(all, {
      reportPeriod: period('2026-07-14', '2026-07-14'),
      today: TODAY,
    })
    expect(scoped.map((c) => c.id)).toEqual(['a'])
  })

  it('a wide range admits everything in it', () => {
    const scoped = filterInProgressChecklists(all, {
      reportPeriod: period('2026-07-01', '2026-08-31'),
      today: TODAY,
    })
    expect(scoped).toHaveLength(3)
  })

  it('the count (no query) matches the list the section renders with no query', () => {
    const scope = { reportPeriod: period('2026-07-01', '2026-07-31'), today: TODAY }
    const listed = filterInProgressChecklists(all, { ...scope, clients: CLIENTS, query: '' })
    const counted = filterInProgressChecklists(all, scope)
    expect(counted.length).toBe(listed.length)
  })
})

describe('filterInProgressChecklists — filter bar', () => {
  const wide = period('2026-01-01', '2026-12-31')
  const all = [
    mk('a', '2026-07-14', { assigneeId: 'e1', clientId: 'c1' }),
    mk('b', '2026-07-15', { assigneeId: 'e2', clientId: 'c2' }),
  ]

  it('filters by assignee', () => {
    const out = filterInProgressChecklists(all, {
      reportPeriod: wide,
      today: TODAY,
      assignee: 'e2',
    })
    expect(out.map((c) => c.id)).toEqual(['b'])
  })

  it('filters by client', () => {
    const out = filterInProgressChecklists(all, {
      reportPeriod: wide,
      today: TODAY,
      client: 'c1',
    })
    expect(out.map((c) => c.id)).toEqual(['a'])
  })

  it("treats '' and 'all' as no status filter", () => {
    for (const status of ['', 'all']) {
      expect(
        filterInProgressChecklists(all, { reportPeriod: wide, today: TODAY, status }),
      ).toHaveLength(2)
    }
  })
})

describe('filterInProgressChecklists — search', () => {
  const wide = period('2026-01-01', '2026-12-31')
  const all = [
    mk('a', '2026-07-14', { clientId: 'c1', title: 'Monthly close' }),
    mk('b', '2026-07-15', { clientId: 'c2', title: 'Payroll run' }),
  ]
  const base = { reportPeriod: wide, today: TODAY, clients: CLIENTS }

  it('matches the BUSINESS name — the "jump to a business" case', () => {
    const out = filterInProgressChecklists(all, { ...base, query: 'zenith' })
    expect(out.map((c) => c.id)).toEqual(['b'])
  })

  it('matches the task title too', () => {
    const out = filterInProgressChecklists(all, { ...base, query: 'payroll' })
    expect(out.map((c) => c.id)).toEqual(['b'])
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(filterInProgressChecklists(all, { ...base, query: '  ACME  ' })).toHaveLength(1)
  })

  it('an empty / whitespace query filters nothing out', () => {
    expect(filterInProgressChecklists(all, { ...base, query: '   ' })).toHaveLength(2)
  })
})

describe('statusForChecklist', () => {
  it('all items done → completed', () => {
    const c = mk('a', '2026-07-14', {
      items: [{ id: 'i', label: 'x', done: true }],
    } as Partial<Checklist>)
    expect(statusForChecklist(c, TODAY)).toBe('completed')
  })

  it('past due with open items → overdue', () => {
    const c = mk('a', '2026-07-01', {
      items: [{ id: 'i', label: 'x', done: false }],
    } as Partial<Checklist>)
    expect(statusForChecklist(c, TODAY)).toBe('overdue')
  })

  it('an EMPTY checklist is not "completed" just because nothing is undone', () => {
    expect(statusForChecklist(mk('a', '2026-12-01'), TODAY)).toBe('active')
  })
})
