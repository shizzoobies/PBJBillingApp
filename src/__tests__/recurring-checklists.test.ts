import { describe, expect, it } from 'vitest'
import { ensureRecurringChecklists, dateOffset, isChecklistItemDone } from '../lib/utils'
import type { AppData, ChecklistTemplate } from '../lib/types'

/**
 * `ensureRecurringChecklists` reads `new Date()` internally for "today" and
 * cannot take an injected clock. To stay deterministic regardless of when the
 * suite runs, every template's `nextDueDate` is expressed RELATIVE to the real
 * today via the codebase's own `dateOffset` helper: a negative offset is
 * unambiguously in the past, a positive offset unambiguously in the future.
 */

function makeTemplate(overrides: Partial<ChecklistTemplate>): ChecklistTemplate {
  return {
    id: 'tmpl-1',
    title: 'Monthly Close',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    frequency: 'monthly',
    nextDueDate: dateOffset(-3),
    active: true,
    viewerIds: [],
    editorIds: [],
    stages: [
      {
        id: 'stage-1',
        name: 'Stage 1',
        assigneeId: 'emp-1',
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: [{ id: 'ti-1', label: 'Reconcile bank feed' }],
      },
    ],
    ...overrides,
  }
}

function makeData(templates: ChecklistTemplate[]): AppData {
  return {
    employees: [{ id: 'emp-1', name: 'Avery', role: 'Bookkeeper' }],
    clients: [
      {
        id: 'client-1',
        name: 'Acme',
        contact: 'A. Person',
        billingMode: 'hourly',
        hourlyRate: 100,
        planId: null,
      },
    ],
    plans: [],
    timeEntries: [],
    checklistTemplates: templates,
    checklists: [],
    recycledChecklists: [],
    timesheetLocks: [],
    weeklySubmissions: [],
  }
}

describe('ensureRecurringChecklists', () => {
  it('materializes a live checklist for a template whose nextDueDate is in the past', () => {
    const data = makeData([makeTemplate({ nextDueDate: dateOffset(-5) })])
    const result = ensureRecurringChecklists(data)

    expect(result.changed).toBe(true)
    expect(result.data.checklists.length).toBeGreaterThanOrEqual(1)
    const generated = result.data.checklists.find((c) => c.templateId === 'tmpl-1')
    expect(generated).toBeDefined()
    expect(generated?.items.map((i) => i.label)).toContain('Reconcile bank feed')
    // Generated checklist items always start unchecked.
    expect(generated?.items.every((i) => i.done === false)).toBe(true)
  })

  it('does NOT materialize a checklist for a template due in the future', () => {
    const data = makeData([makeTemplate({ nextDueDate: dateOffset(30) })])
    const result = ensureRecurringChecklists(data)

    expect(result.data.checklists.filter((c) => c.templateId === 'tmpl-1')).toHaveLength(0)
  })

  it('never materializes a standard (client-agnostic blueprint) template', () => {
    const data = makeData([
      makeTemplate({
        id: 'tmpl-standard',
        isStandard: true,
        // Past due date — would otherwise generate if it were a real template.
        nextDueDate: dateOffset(-10),
      }),
    ])
    const result = ensureRecurringChecklists(data)

    expect(result.data.checklists.filter((c) => c.templateId === 'tmpl-standard')).toHaveLength(0)
  })

  it('does not materialize an inactive template even when overdue', () => {
    const data = makeData([
      makeTemplate({ active: false, nextDueDate: dateOffset(-10) }),
    ])
    const result = ensureRecurringChecklists(data)

    expect(result.data.checklists.filter((c) => c.templateId === 'tmpl-1')).toHaveLength(0)
  })

  it('advances nextDueDate past today after materializing', () => {
    const data = makeData([makeTemplate({ nextDueDate: dateOffset(-5) })])
    const result = ensureRecurringChecklists(data)

    const today = new Date().toISOString().slice(0, 10)
    const updated = result.data.checklistTemplates.find((t) => t.id === 'tmpl-1')
    expect(updated).toBeDefined()
    // After catch-up materialization the next due date is rolled into the future.
    expect(updated!.nextDueDate > today).toBe(true)
  })

  it('copies template sub-items AND sub-sub-items with fresh ids and done:false', () => {
    // A template item with one sub-item that itself has two sub-sub-items.
    const data = makeData([
      makeTemplate({
        nextDueDate: dateOffset(-5),
        stages: [
          {
            id: 'stage-1',
            name: 'Stage 1',
            assigneeId: 'emp-1',
            offsetDays: 0,
            viewerIds: [],
            editorIds: [],
            items: [
              {
                id: 'ti-1',
                label: 'Reconcile bank feed',
                subItems: [
                  {
                    id: 'tsi-1',
                    title: 'Match deposits',
                    subItems: [
                      { id: 'tssi-1', title: 'Pull statement' },
                      { id: 'tssi-2', title: 'Tick each line' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ])
    const result = ensureRecurringChecklists(data)
    const generated = result.data.checklists.find((c) => c.templateId === 'tmpl-1')
    expect(generated).toBeDefined()

    const item = generated!.items[0]
    expect(item.subItems).toHaveLength(1)
    const sub = item.subItems![0]
    expect(sub.title).toBe('Match deposits')
    // Fresh id — must not reuse the template's.
    expect(sub.id).not.toBe('tsi-1')

    const subSubItems = sub.subItems ?? []
    expect(subSubItems.map((s) => s.title)).toEqual(['Pull statement', 'Tick each line'])
    // Sub-sub-items copy with fresh ids and start unchecked.
    expect(subSubItems.every((s) => s.id !== 'tssi-1' && s.id !== 'tssi-2')).toBe(true)
    expect(subSubItems.every((s) => s.done === false)).toBe(true)
  })
})

describe('ensureRecurringChecklists — specific-months scheduling', () => {
  // Anchor the tests to the real clock so they stay deterministic regardless of
  // when the suite runs. The CURRENT calendar month has, by definition, already
  // started; a month several months in the future has not.
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1 // 1-12
  // A month that has unambiguously NOT started yet this year. When the current
  // month is late in the year we fall back to a small offset that is still in
  // the future relative to "today"; if no such month exists (December) we skip
  // the not-started assertion conditionally below.
  const futureMonth = currentMonth <= 9 ? currentMonth + 3 : currentMonth - 9 + 1

  function specificMonthsTemplate(
    overrides: Partial<ChecklistTemplate>,
  ): ChecklistTemplate {
    return makeTemplate({
      frequency: 'specific-months',
      // Specific-months templates carry no fixed next-due date.
      nextDueDate: '',
      scheduledMonths: [currentMonth],
      ...overrides,
    })
  }

  it('generates an instance for a designated month that has already started', () => {
    const data = makeData([specificMonthsTemplate({ scheduledMonths: [currentMonth] })])
    const result = ensureRecurringChecklists(data)

    expect(result.changed).toBe(true)
    const generated = result.data.checklists.filter((c) => c.templateId === 'tmpl-1')
    expect(generated).toHaveLength(1)
    expect(generated[0].dueDate.slice(0, 7)).toBe(
      `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
    )
    expect(generated[0].items.map((i) => i.label)).toContain('Reconcile bank feed')
    expect(generated[0].items.every((i) => i.done === false)).toBe(true)
  })

  it('does NOT generate for a designated month that has not started yet', () => {
    // Only meaningful when a clearly-future month exists this year.
    if (currentMonth > 9) return
    const data = makeData([specificMonthsTemplate({ scheduledMonths: [futureMonth] })])
    const result = ensureRecurringChecklists(data)

    expect(result.data.checklists.filter((c) => c.templateId === 'tmpl-1')).toHaveLength(0)
  })

  it('does not double-generate when materialization runs twice', () => {
    const data = makeData([specificMonthsTemplate({ scheduledMonths: [currentMonth] })])
    const first = ensureRecurringChecklists(data)
    expect(first.data.checklists.filter((c) => c.templateId === 'tmpl-1')).toHaveLength(1)

    // Re-running over the already-materialized data must be idempotent.
    const second = ensureRecurringChecklists(first.data)
    expect(second.data.checklists.filter((c) => c.templateId === 'tmpl-1')).toHaveLength(1)
  })

  it('respects dueDayOfMonth when set', () => {
    const data = makeData([
      specificMonthsTemplate({ scheduledMonths: [currentMonth], dueDayOfMonth: 12 }),
    ])
    const result = ensureRecurringChecklists(data)

    const generated = result.data.checklists.find((c) => c.templateId === 'tmpl-1')
    expect(generated).toBeDefined()
    expect(generated!.dueDate).toBe(
      `${currentYear}-${String(currentMonth).padStart(2, '0')}-12`,
    )
  })

  it('falls back to the last day of month when dueDayOfMonth is unset', () => {
    const data = makeData([specificMonthsTemplate({ scheduledMonths: [currentMonth] })])
    const result = ensureRecurringChecklists(data)

    const generated = result.data.checklists.find((c) => c.templateId === 'tmpl-1')
    expect(generated).toBeDefined()
    const lastDay = new Date(currentYear, currentMonth, 0).getDate()
    expect(generated!.dueDate).toBe(
      `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    )
  })

  it('still never materializes a standard specific-months template', () => {
    const data = makeData([
      specificMonthsTemplate({ isStandard: true, scheduledMonths: [currentMonth] }),
    ])
    const result = ensureRecurringChecklists(data)

    expect(result.data.checklists.filter((c) => c.templateId === 'tmpl-1')).toHaveLength(0)
  })
})

describe('isChecklistItemDone — sub-item roll-up', () => {
  it('an item with no sub-items keeps its own done flag', () => {
    expect(isChecklistItemDone({ done: true })).toBe(true)
    expect(isChecklistItemDone({ done: false })).toBe(false)
    expect(isChecklistItemDone({ done: true, subItems: [] })).toBe(true)
  })

  it('an item with sub-items is done only when every sub-item is done', () => {
    expect(
      isChecklistItemDone({
        done: false,
        subItems: [
          { done: true },
          { done: true },
        ],
      }),
    ).toBe(true)
  })

  it('an item with any incomplete sub-item is not done', () => {
    expect(
      isChecklistItemDone({
        done: true,
        subItems: [
          { done: true },
          { done: false },
        ],
      }),
    ).toBe(false)
  })
})

describe('isChecklistItemDone — three-level (sub-sub-item) roll-up', () => {
  it('a sub-item with sub-sub-items is done only when every sub-sub-item is done', () => {
    // The sub-item carries done:false, but its roll-up should win.
    expect(
      isChecklistItemDone({
        done: false,
        subItems: [{ done: true }, { done: true }],
      }),
    ).toBe(true)
  })

  it('checking every sub-sub-item completes its sub-item and then the top item', () => {
    // Top item → two sub-items, each with two sub-sub-items, all done.
    const item = {
      done: false,
      subItems: [
        { done: false, subItems: [{ done: true }, { done: true }] },
        { done: false, subItems: [{ done: true }, { done: true }] },
      ],
    }
    // Each sub-item rolls up to done...
    expect(isChecklistItemDone(item.subItems[0])).toBe(true)
    expect(isChecklistItemDone(item.subItems[1])).toBe(true)
    // ...and so the whole item rolls up to done.
    expect(isChecklistItemDone(item)).toBe(true)
  })

  it('a single incomplete sub-sub-item keeps its sub-item and the top item incomplete', () => {
    const item = {
      done: true,
      subItems: [
        { done: true, subItems: [{ done: true }, { done: false }] },
        { done: true, subItems: [{ done: true }, { done: true }] },
      ],
    }
    // The first sub-item has an incomplete sub-sub-item, so it is not done...
    expect(isChecklistItemDone(item.subItems[0])).toBe(false)
    // ...which keeps the top item incomplete even though its other branch is done.
    expect(isChecklistItemDone(item)).toBe(false)
  })

  it('a sub-item with an empty sub-sub-item list keeps its own done flag', () => {
    expect(isChecklistItemDone({ done: true, subItems: [] })).toBe(true)
    expect(isChecklistItemDone({ done: false, subItems: [] })).toBe(false)
  })
})
