import { describe, expect, it } from 'vitest'
import {
  boardChecklistStatus,
  buildActiveBoard,
  boardPeriodRange,
  effectiveDue,
  isChecklistComplete,
  weekRange,
  UNCATEGORIZED_ID,
} from '../lib/activeBoard'
import type { Checklist } from '../lib/types'

// Minimal checklist factory — only the fields the board engine reads.
const open = (over: Partial<Checklist>): Checklist =>
  ({
    id: 'x',
    title: 't',
    clientId: 'c1',
    assigneeId: 'e1',
    dueDate: '2026-06-20',
    viewerIds: [],
    editorIds: [],
    items: [{ id: 'i', label: 'l', done: false }],
    ...over,
  }) as Checklist

describe('weekRange', () => {
  it('returns the Sun–Sat week containing a midweek day', () => {
    expect(weekRange('2026-06-16')).toEqual({ start: '2026-06-14', end: '2026-06-20' })
  })
  it('keeps a Sunday as start and a Saturday as end', () => {
    expect(weekRange('2026-06-14')).toEqual({ start: '2026-06-14', end: '2026-06-20' })
    expect(weekRange('2026-06-20')).toEqual({ start: '2026-06-14', end: '2026-06-20' })
  })
  it('spans a month boundary', () => {
    expect(weekRange('2026-07-01')).toEqual({ start: '2026-06-28', end: '2026-07-04' })
  })
})

describe('boardPeriodRange', () => {
  it('week / month / quarter', () => {
    expect(boardPeriodRange('week', '2026-06-16')).toEqual({ start: '2026-06-14', end: '2026-06-20' })
    expect(boardPeriodRange('month', '2026-06-16')).toEqual({ start: '2026-06-01', end: '2026-06-30' })
    expect(boardPeriodRange('quarter', '2026-06-16')).toEqual({ start: '2026-04-01', end: '2026-06-30' })
  })
})

describe('boardChecklistStatus', () => {
  const TODAY = '2026-06-16'

  it('due when nothing waits and the due date is today or later', () => {
    expect(boardChecklistStatus(open({ dueDate: '2026-06-20' }), TODAY)).toEqual({
      kind: 'due',
      due: '2026-06-20',
    })
    expect(boardChecklistStatus(open({ dueDate: TODAY }), TODAY)).toEqual({
      kind: 'due',
      due: TODAY,
    })
  })

  it('overdue when past due and nothing waits', () => {
    expect(boardChecklistStatus(open({ dueDate: '2026-06-10' }), TODAY)).toEqual({
      kind: 'overdue',
      due: '2026-06-10',
    })
  })

  it('pending wins over overdue: a waiting step with its free-text reason', () => {
    const status = boardChecklistStatus(
      open({
        dueDate: '2026-06-10',
        items: [{ id: 'i', label: 'l', done: false, waiting: true, waitingOn: 'client bank statements' }],
      }),
      TODAY,
    )
    expect(status).toEqual({ kind: 'pending', reasons: ['client bank statements'], waitingCount: 1 })
  })

  it('done steps never count as waiting', () => {
    const status = boardChecklistStatus(
      open({
        items: [
          { id: 'a', label: 'a', done: true, waiting: true, waitingOn: 'stale flag on a done step' },
          { id: 'b', label: 'b', done: false },
        ],
      }),
      TODAY,
    )
    expect(status.kind).toBe('due')
  })

  it('structured person-blockers pend too, resolving the blocker name', () => {
    const status = boardChecklistStatus(
      open({
        items: [
          {
            id: 'i',
            label: 'l',
            done: false,
            waitingOns: [{ id: 'w', blockerId: 'e2', requestedBy: 'e1', createdAt: '2026-06-15T00:00:00Z' }],
          },
        ],
      }),
      TODAY,
      { e2: 'Allison Lehmann' },
    )
    expect(status).toEqual({
      kind: 'pending',
      reasons: ['waiting on Allison Lehmann'],
      waitingCount: 1,
    })
  })

  it('collects waits from sub-items and sub-sub-items', () => {
    const status = boardChecklistStatus(
      open({
        items: [
          {
            id: 'i',
            label: 'l',
            done: false,
            subItems: [
              {
                id: 's',
                title: 's',
                done: false,
                waiting: true,
                waitingOn: 'payroll report',
                subItems: [
                  {
                    id: 'ss',
                    title: 'ss',
                    done: false,
                    waitingOns: [
                      { id: 'w', blockerId: 'e9', requestedBy: 'e1', createdAt: '2026-06-15T00:00:00Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      TODAY,
    )
    expect(status.kind).toBe('pending')
    if (status.kind === 'pending') {
      expect(status.waitingCount).toBe(2)
      expect(status.reasons).toEqual(['payroll report', 'waiting on a teammate'])
    }
  })
})

describe('isChecklistComplete', () => {
  it('true only when every item is done; empty is not complete', () => {
    expect(isChecklistComplete(open({ items: [{ id: 'a', label: 'a', done: true }] }))).toBe(true)
    expect(
      isChecklistComplete(
        open({ items: [{ id: 'a', label: 'a', done: true }, { id: 'b', label: 'b', done: false }] }),
      ),
    ).toBe(false)
    expect(isChecklistComplete(open({ items: [] }))).toBe(false)
  })
})

describe('effectiveDue', () => {
  it('uses the soonest incomplete item due before the overall due', () => {
    expect(
      effectiveDue(
        open({
          dueDate: '2026-06-30',
          items: [
            { id: 'a', label: 'a', done: true, dueDate: '2026-06-01' },
            { id: 'b', label: 'b', done: false, dueDate: '2026-06-10' },
          ],
        }),
      ),
    ).toBe('2026-06-10')
  })
})

const categories = [
  { id: 'mb', name: 'Monthly Bookkeeping', sortOrder: 0 },
  { id: 'qb', name: 'Quarterly Bookkeeping', sortOrder: 1 },
  { id: 'st', name: 'Sales Tax', sortOrder: 2 },
  { id: 'pr', name: 'Payroll', sortOrder: 3 },
]
const clientNameById = { c1: 'Clover', c2: 'Northstar' }

describe('buildActiveBoard', () => {
  it('groups open checklists by category then client, in category order', () => {
    const board = buildActiveBoard({
      checklists: [
        open({ id: 'a', clientId: 'c1', categoryId: 'mb', dueDate: '2026-06-20' }),
        open({ id: 'b', clientId: 'c2', categoryId: 'mb', dueDate: '2026-06-25' }),
        open({ id: 'c', clientId: 'c1', categoryId: 'st', dueDate: '2026-06-15' }),
      ],
      categories,
      periodType: 'month',
      today: '2026-06-16',
      clientNameById,
    })
    expect(board.columns.map((c) => c.name)).toEqual([
      'Monthly Bookkeeping',
      'Quarterly Bookkeeping',
      'Sales Tax',
      'Payroll',
    ])
    const mb = board.columns.find((c) => c.id === 'mb')!
    expect(mb.openClientCount).toBe(2)
    expect(mb.clients.map((c) => c.name)).toEqual(['Clover', 'Northstar'])
    expect(board.columns.find((c) => c.id === 'qb')!.openClientCount).toBe(0)
  })

  it('drops a client once its checklist is complete', () => {
    const board = buildActiveBoard({
      checklists: [
        open({ id: 'done', clientId: 'c1', categoryId: 'mb', items: [{ id: 'i', label: 'l', done: true }] }),
        open({ id: 'live', clientId: 'c2', categoryId: 'mb' }),
      ],
      categories,
      periodType: 'month',
      today: '2026-06-16',
      clientNameById,
    })
    expect(board.columns.find((c) => c.id === 'mb')!.clients.map((c) => c.clientId)).toEqual(['c2'])
  })

  it('surfaces an Uncategorized column only when something lands there', () => {
    const none = buildActiveBoard({
      checklists: [open({ id: 'a', clientId: 'c1', categoryId: 'mb' })],
      categories,
      periodType: 'month',
      today: '2026-06-16',
      clientNameById,
    })
    expect(none.columns.some((c) => c.id === UNCATEGORIZED_ID)).toBe(false)

    const withOrphan = buildActiveBoard({
      checklists: [
        open({ id: 'a', clientId: 'c1', categoryId: 'deleted-cat' }),
        open({ id: 'b', clientId: 'c2' }),
      ],
      categories,
      periodType: 'month',
      today: '2026-06-16',
      clientNameById,
    })
    expect(withOrphan.columns.find((c) => c.id === UNCATEGORIZED_ID)!.openClientCount).toBe(2)
  })

  it('reflects re-tagging: an uncategorized checklist moves into its column (board-correction fix)', () => {
    // Before: no category → it sits in the Uncategorized column.
    const before = buildActiveBoard({
      checklists: [open({ id: 'x', clientId: 'c1', categoryId: null, dueDate: '2026-06-20' })],
      categories,
      periodType: 'month',
      today: '2026-06-16',
      clientNameById,
    })
    expect(before.columns.find((c) => c.id === UNCATEGORIZED_ID)!.openClientCount).toBe(1)
    expect(before.columns.find((c) => c.id === 'mb')!.openClientCount).toBe(0)

    // After: setting categoryId (what the card's new "Board column" editor
    // persists) re-renders it under that column, and Uncategorized disappears.
    const after = buildActiveBoard({
      checklists: [open({ id: 'x', clientId: 'c1', categoryId: 'mb', dueDate: '2026-06-20' })],
      categories,
      periodType: 'month',
      today: '2026-06-16',
      clientNameById,
    })
    expect(after.columns.some((c) => c.id === UNCATEGORIZED_ID)).toBe(false)
    expect(after.columns.find((c) => c.id === 'mb')!.clients.map((c) => c.clientId)).toEqual(['c1'])
  })

  it('honors the period horizon and keeps overdue visible', () => {
    const checklists = [
      open({ id: 'thisweek', clientId: 'c1', categoryId: 'mb', dueDate: '2026-06-18' }),
      open({ id: 'laterthismonth', clientId: 'c2', categoryId: 'mb', dueDate: '2026-06-28' }),
      open({ id: 'overdue', clientId: 'c1', categoryId: 'st', dueDate: '2026-05-30' }),
    ]
    const week = buildActiveBoard({ checklists, categories, periodType: 'week', today: '2026-06-16', clientNameById })
    expect(week.columns.find((c) => c.id === 'mb')!.clients.map((c) => c.clientId)).toEqual(['c1'])
    // overdue still shows under the narrow week horizon
    expect(week.columns.find((c) => c.id === 'st')!.openClientCount).toBe(1)

    const month = buildActiveBoard({ checklists, categories, periodType: 'month', today: '2026-06-16', clientNameById })
    expect(month.columns.find((c) => c.id === 'mb')!.openClientCount).toBe(2)
  })
})
