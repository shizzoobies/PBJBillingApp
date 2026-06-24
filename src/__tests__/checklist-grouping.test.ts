import { describe, expect, it } from 'vitest'
import { groupChecklist } from '../lib/utils'
import type { Checklist } from '../lib/types'

const TODAY = '2026-06-24'

function mk(dueDate: string, items: Array<{ done: boolean }> = []): Checklist {
  return {
    id: 't',
    clientId: 'c',
    title: 'T',
    assigneeId: 'e',
    dueDate,
    frequency: 'monthly',
    items: items.map((it, i) => ({ id: `i${i}`, label: 'x', done: it.done })),
  } as unknown as Checklist
}

describe('groupChecklist due-date buckets', () => {
  it('past due → overdue', () => {
    expect(groupChecklist(mk('2026-06-20'), TODAY)).toBe('overdue')
  })

  it('within 7 days → week', () => {
    expect(groupChecklist(mk('2026-06-26'), TODAY)).toBe('week')
  })

  // Regression: a task due ~8 days out that falls in the NEXT calendar month
  // used to land in the collapsed "Later" bucket (calendar-month check), so
  // staff saw it on the Gantt but not under "Due this week/month".
  it('8 days out into next calendar month → month (not later)', () => {
    expect(groupChecklist(mk('2026-07-02'), TODAY)).toBe('month')
  })

  it('within ~31 days → month', () => {
    expect(groupChecklist(mk('2026-07-20'), TODAY)).toBe('month')
  })

  it('beyond 31 days → later', () => {
    expect(groupChecklist(mk('2026-08-15'), TODAY)).toBe('later')
  })

  it('all steps done → completed', () => {
    expect(groupChecklist(mk('2026-06-26', [{ done: true }]), TODAY)).toBe('completed')
  })
})
