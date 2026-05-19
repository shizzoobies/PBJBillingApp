import { describe, expect, it } from 'vitest'
import { ensureRecurringChecklists, dateOffset } from '../lib/utils'
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
    timesheetLocks: [],
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
})
