import { describe, expect, it } from 'vitest'
import {
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
