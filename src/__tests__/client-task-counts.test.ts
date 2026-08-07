import { describe, expect, it } from 'vitest'
import { buildClientTaskCounts } from '../lib/clientTaskCounts'
import type { Checklist } from '../lib/types'

const TODAY = '2026-08-07'

function mk(
  id: string,
  clientId: string,
  dueDate: string,
  extra: Partial<Checklist> = {},
): Checklist {
  return {
    id,
    clientId,
    title: id,
    assigneeId: 'e1',
    dueDate,
    frequency: 'monthly',
    items: [{ id: `${id}-i`, label: 'step', done: false }],
    ...extra,
  } as unknown as Checklist
}

describe('buildClientTaskCounts', () => {
  it('counts open tasks per client', () => {
    const counts = buildClientTaskCounts(
      [mk('a', 'c1', '2026-09-01'), mk('b', 'c1', '2026-09-02'), mk('c', 'c2', '2026-09-01')],
      TODAY,
    )
    expect(counts.get('c1')?.active).toBe(2)
    expect(counts.get('c2')?.active).toBe(1)
  })

  it('counts a task due before today as past due', () => {
    const counts = buildClientTaskCounts([mk('a', 'c1', '2026-08-01')], TODAY)
    expect(counts.get('c1')).toEqual({ active: 1, pastDue: 1 })
  })

  it('today is NOT past due', () => {
    const counts = buildClientTaskCounts([mk('a', 'c1', TODAY)], TODAY)
    expect(counts.get('c1')).toEqual({ active: 1, pastDue: 0 })
  })

  /**
   * The invariant the label depends on: "3 active, 1 past due" must mean one of
   * those three is late — not four tasks in total.
   */
  it('pastDue is a SUBSET of active, never a separate total', () => {
    const counts = buildClientTaskCounts(
      [mk('a', 'c1', '2026-08-01'), mk('b', 'c1', '2026-08-02'), mk('c', 'c1', '2026-09-30')],
      TODAY,
    )
    const c1 = counts.get('c1')!
    expect(c1.active).toBe(3)
    expect(c1.pastDue).toBe(2)
    expect(c1.pastDue).toBeLessThanOrEqual(c1.active)
  })

  it('excludes fully completed tasks — they are not outstanding', () => {
    const done = mk('a', 'c1', '2026-08-01', {
      items: [{ id: 'i', label: 'step', done: true }],
    } as Partial<Checklist>)
    const counts = buildClientTaskCounts([done], TODAY)
    expect(counts.get('c1')).toBeUndefined()
  })

  it('a completed task that is also overdue counts as neither', () => {
    // Completion wins over lateness — a finished task is not outstanding work.
    const done = mk('a', 'c1', '2026-01-01', {
      items: [{ id: 'i', label: 'step', done: true }],
    } as Partial<Checklist>)
    expect(buildClientTaskCounts([done], TODAY).get('c1')).toBeUndefined()
  })

  it('excludes soft-deleted tasks (recycle bin)', () => {
    const deleted = mk('a', 'c1', '2026-08-01', { deletedAt: '2026-08-06' } as Partial<Checklist>)
    expect(buildClientTaskCounts([deleted], TODAY).get('c1')).toBeUndefined()
  })

  it('honors an earlier per-STEP due date, matching the Checklists page', () => {
    // groupChecklist reads effectiveChecklistDue: an open step due before the
    // checklist itself pulls the whole task earlier, so it is late here too.
    const withLateStep = mk('a', 'c1', '2026-09-30', {
      items: [{ id: 'i', label: 'step', done: false, dueDate: '2026-08-01' }],
    } as Partial<Checklist>)
    expect(buildClientTaskCounts([withLateStep], TODAY).get('c1')).toEqual({
      active: 1,
      pastDue: 1,
    })
  })

  it('ignores checklists with no client', () => {
    expect(buildClientTaskCounts([mk('a', '', '2026-08-01')], TODAY).size).toBe(0)
  })

  it('handles an empty or missing list without throwing', () => {
    expect(buildClientTaskCounts([], TODAY).size).toBe(0)
    expect(
      buildClientTaskCounts(undefined as unknown as Checklist[], TODAY).size,
    ).toBe(0)
  })
})
