import { describe, expect, it } from 'vitest'
import { filterInProgressChecklists, statusForChecklist, waitingStepCount } from '../lib/inProgressFilter'
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

describe('waiting steps and the status filter', () => {
  const open = (extra: Record<string, unknown> = {}) => ({ id: 'i', label: 'x', done: false, ...extra })
  const withItems = (dueDate: string, items: unknown[]) =>
    mk('a', dueDate, { items } as unknown as Partial<Checklist>)

  const FILTER_PERIOD = period('2026-01-01', '2026-12-31')
  const idsFor = (list: Checklist[], status: string) =>
    filterInProgressChecklists(list, { reportPeriod: FILTER_PERIOD, today: TODAY, status }).map((x) => x.id)

  it('statusForChecklist ignores waiting: a waiting checklist is still Active or Overdue', () => {
    expect(statusForChecklist(withItems('2026-12-01', [open({ waiting: true })]), TODAY)).toBe('active')
    expect(statusForChecklist(withItems('2026-07-01', [open({ waiting: true })]), TODAY)).toBe('overdue')
  })

  it('a waiting AND overdue checklist shows under Overdue and Waiting, NOT Active', () => {
    const both = mk('both', '2026-07-01', { items: [open({ waiting: true })] } as unknown as Partial<Checklist>)
    expect(idsFor([both], 'overdue')).toEqual(['both'])
    expect(idsFor([both], 'waiting')).toEqual(['both'])
    expect(idsFor([both], 'active')).toEqual([])
    expect(idsFor([both], 'completed')).toEqual([])
  })

  it('a plain overdue checklist does not show under Active (regression)', () => {
    const overdue = mk('late', '2026-07-01', { items: [open()] } as unknown as Partial<Checklist>)
    expect(idsFor([overdue], 'active')).toEqual([])
    expect(idsFor([overdue], 'overdue')).toEqual(['late'])
    expect(idsFor([overdue], 'waiting')).toEqual([])
  })

  it('the Active count is what it was before Waiting existed', () => {
    const list = [
      mk('fresh', '2026-12-01', { items: [open()] } as unknown as Partial<Checklist>),
      mk('late', '2026-07-01', { items: [open()] } as unknown as Partial<Checklist>),
      mk('waits', '2026-12-01', { items: [open({ waiting: true })] } as unknown as Partial<Checklist>),
      mk('late-waits', '2026-07-01', { items: [open({ waiting: true })] } as unknown as Partial<Checklist>),
      mk('done', '2026-07-01', { items: [open({ done: true })] } as unknown as Partial<Checklist>),
    ]
    const legacyActive = list.filter((c) => statusForChecklist(c, TODAY) === 'active').map((c) => c.id)
    expect(idsFor(list, 'active')).toEqual(legacyActive)
    expect(idsFor(list, 'active')).toEqual(['fresh', 'waits'])
  })

  it('a waiting, not-overdue checklist shows under Active and Waiting, not Overdue', () => {
    const only = mk('only', '2026-12-01', { items: [open({ waiting: true })] } as unknown as Partial<Checklist>)
    expect(idsFor([only], 'active')).toEqual(['only'])
    expect(idsFor([only], 'waiting')).toEqual(['only'])
    expect(idsFor([only], 'overdue')).toEqual([])
  })

  it('a complete checklist is never Waiting', () => {
    const c = withItems('2026-07-01', [open({ done: true, waiting: true })])
    expect(statusForChecklist(c, TODAY)).toBe('completed')
    expect(idsFor([c], 'waiting')).toEqual([])
    expect(idsFor([c], 'completed')).toEqual(['a'])
    expect(idsFor([c], 'overdue')).toEqual([])
    expect(idsFor([c], 'active')).toEqual([])
  })

  it('a DONE waiting step does not count while another step is open', () => {
    const c = withItems('2026-12-01', [open({ id: 'a', done: true, waiting: true }), open({ id: 'b' })])
    expect(waitingStepCount(c)).toBe(0)
    expect(statusForChecklist(c, TODAY)).toBe('active')
  })

  it('a parent stored done with an open waiting sub-step is OPEN by the roll-up, so the wait counts', () => {
    // The same reading Push and the progress badge use: a step is done only when
    // every sub-step is.
    const c = withItems('2026-12-01', [
      open({ id: 'a', done: true, subItems: [{ id: 's', label: 's', done: false, waiting: true }] }),
      open({ id: 'b' }),
    ])
    expect(waitingStepCount(c)).toBe(1)
    expect(idsFor([c], 'waiting')).toEqual(['a'])
  })

  it('a parent whose sub-steps are all done is done by the roll-up even if its own flag lags, so its wait is not counted', () => {
    const c = withItems('2026-12-01', [
      open({ id: 'a', done: false, waiting: true, subItems: [{ id: 's', label: 's', done: true }] }),
      open({ id: 'b' }),
    ])
    expect(waitingStepCount(c)).toBe(0)
  })

  it('a waiting sub-step and a waiting sub-sub-step count', () => {
    const sub = withItems('2026-12-01', [open({ subItems: [{ id: 's', label: 's', done: false, waiting: true }] })])
    expect(waitingStepCount(sub)).toBe(1)
    const subSub = withItems('2026-12-01', [
      open({
        subItems: [
          {
            id: 's',
            label: 's',
            done: false,
            subItems: [{ id: 'ss', label: 'ss', done: false, waitingOns: [{ id: 'w', blockerId: 'emp-pat', requestedBy: 'emp-lisa', createdAt: '2026-07-20T00:00:00Z' }] }],
          },
        ],
      }),
    ])
    expect(waitingStepCount(subSub)).toBe(1)
    expect(idsFor([subSub], 'waiting')).toEqual(['a'])
  })

  it('a verified wait does not count: clearing it returns the checklist to Active', () => {
    const verified = withItems('2026-12-01', [
      open({ waitingOns: [{ id: 'w', blockerId: 'emp-pat', requestedBy: 'emp-lisa', createdAt: '2026-07-19T00:00:00Z', resolvedAt: '2026-07-20T00:00:00Z', verifiedAt: '2026-07-21T00:00:00Z' }] }),
    ])
    expect(idsFor([verified], 'waiting')).toEqual([])
    expect(statusForChecklist(verified, TODAY)).toBe('active')
    expect(statusForChecklist(withItems('2026-12-01', [open({ waiting: false })]), TODAY)).toBe('active')
  })

  it('counts every waiting step and the status filter picks the checklist out', () => {
    const c = withItems('2026-12-01', [open({ id: 'a', waiting: true }), open({ id: 'b', waiting: true })])
    expect(waitingStepCount(c)).toBe(2)
    const quiet = mk('q', '2026-12-01', { items: [open()] } as unknown as Partial<Checklist>)
    const out = filterInProgressChecklists([c, quiet], {
      reportPeriod: period('2026-01-01', '2026-12-31'),
      today: TODAY,
      status: 'waiting',
    })
    expect(out.map((x) => x.id)).toEqual(['a'])
  })
})
