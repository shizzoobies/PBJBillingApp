import { describe, expect, it } from 'vitest'
import { groupHoursByTask } from '../lib/hoursByTask'
import type { Checklist, TimeEntry } from '../lib/types'

// featreq-e413267a: the Reports page's "Hours by task" panel grouped only by
// checklist id, so a typed task (a standard task such as "Payroll", or the
// person's own words — every group timer since Oct 8) fell under Unassigned
// even though the Time lists, approvals and the Raw/detail reports show it.

const checklist = (id: string, title: string): Checklist =>
  ({ id, title, clientId: 'c1', assigneeId: 'e1', dueDate: '2026-10-31', viewerIds: [], editorIds: [] }) as unknown as Checklist

let seq = 0
const entry = (minutes: number, extra: Partial<TimeEntry> = {}): TimeEntry =>
  ({
    id: `t${++seq}`,
    employeeId: 'e1',
    clientId: 'c1',
    date: '2026-10-05',
    minutes,
    description: '',
    billable: true,
    ...extra,
  }) as TimeEntry

describe('groupHoursByTask', () => {
  const checklists = [checklist('chk-1', 'Monthly close')]

  it('groups checklist time under the checklist title', () => {
    const rows = groupHoursByTask(
      [entry(30, { taskId: 'chk-1' }), entry(45, { taskId: 'chk-1' })],
      checklists,
    )
    expect(rows).toEqual([
      { key: 'task:chk-1', taskId: 'chk-1', taskTitle: 'Monthly close', minutes: 75, entryCount: 2 },
    ])
  })

  it('merges a typed task across casings and spacing, showing the first-seen casing', () => {
    const rows = groupHoursByTask(
      [
        entry(60, { taskId: null, taskLabel: 'Payroll' }),
        entry(30, { taskLabel: '  payroll ' }),
        entry(15, { taskLabel: 'PAYROLL' }),
      ],
      checklists,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ taskId: null, taskTitle: 'Payroll', minutes: 105, entryCount: 3 })
  })

  it('puts entries with no checklist and no typed task under Unassigned', () => {
    const rows = groupHoursByTask(
      [entry(20), entry(10, { taskId: null, taskLabel: '   ' }), entry(5, { taskLabel: '' })],
      checklists,
    )
    expect(rows).toEqual([
      { key: '__unassigned__', taskId: null, taskTitle: 'Unassigned', minutes: 35, entryCount: 3 },
    ])
  })

  it('lets the checklist win over a typed label on the same entry', () => {
    const rows = groupHoursByTask(
      [entry(40, { taskId: 'chk-1', taskLabel: 'Payroll' }), entry(20, { taskLabel: 'Payroll' })],
      checklists,
    )
    expect(rows.map((row) => [row.taskTitle, row.minutes, row.entryCount])).toEqual([
      ['Monthly close', 40, 1],
      ['Payroll', 20, 1],
    ])
  })

  it('keeps a typed task that matches a checklist title as its own row, and Unassigned apart from both', () => {
    const rows = groupHoursByTask(
      [
        entry(50, { taskId: 'chk-1' }),
        entry(30, { taskLabel: 'monthly close' }),
        entry(10),
      ],
      checklists,
    )
    expect(rows.map((row) => row.key)).toEqual(['task:chk-1', 'label:monthly close', '__unassigned__'])
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })

  it('sorts the rows by minutes, most first', () => {
    const rows = groupHoursByTask(
      [entry(10, { taskLabel: 'Small' }), entry(90, { taskLabel: 'Big' }), entry(40, { taskId: 'chk-1' })],
      checklists,
    )
    expect(rows.map((row) => row.taskTitle)).toEqual(['Big', 'Monthly close', 'Small'])
  })
})
