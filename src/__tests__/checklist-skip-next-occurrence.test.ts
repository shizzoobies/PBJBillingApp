/**
 * The two things a quiet skip must not break: the next occurrence, and the
 * meaning of "overdue".
 *
 * A skipped instance is deliberately NOT soft-deleted — it stays in the active
 * `checklists` list carrying `skippedAt`. That choice is what these tests pin:
 *
 *   1. The materializer's identity tuple (templateId, dueDate, stageIndex) still
 *      sees the skipped row, so this period is not respawned as a duplicate…
 *   2. …while the NEXT period's different due date generates exactly as before.
 *   3. And every active surface filters skipped rows out BEFORE bucketing, so a
 *      skipped task can never land in the overdue bucket. The overdue rule
 *      itself (`groupChecklist`) is untouched and is asserted here unchanged.
 */
// @ts-expect-error - plain-JS module without type declarations
import { materializeRecurringChecklists } from '../../db/store.js'
import { isChecklistSkipped } from '../../lib/checklist-skip.js'
import { groupChecklist } from '../lib/utils'
import type { Checklist } from '../lib/types'
import { describe, expect, it } from 'vitest'

function dateOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

const TEMPLATE_ID = 'tpl-skippable'

function makeTemplate(nextDueDate: string) {
  return {
    id: TEMPLATE_ID,
    title: 'Monthly Close',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    frequency: 'monthly',
    nextDueDate,
    active: true,
    isStandard: false,
    skipAllowed: true,
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
    items: [],
  }
}

function skippedInstance(dueDate: string) {
  return {
    id: 'cl-skipped',
    title: 'Monthly Close',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    templateId: TEMPLATE_ID,
    frequency: 'monthly',
    dueDate,
    viewerIds: [],
    editorIds: [],
    caseId: 'case-skipped',
    stageId: 'stage-1',
    stageIndex: 0,
    stageCount: 1,
    skippedAt: new Date().toISOString(),
    skippedBy: 'emp-1',
    items: [{ id: 'item-1', label: 'Reconcile bank feed', done: false }],
  }
}

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    employees: [{ id: 'emp-1', name: 'Avery', role: 'Bookkeeper' }],
    clients: [{ id: 'client-1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100 }],
    plans: [],
    timeEntries: [],
    checklistTemplates: [],
    checklists: [],
    recycledChecklists: [],
    timesheetLocks: [],
    weeklySubmissions: [],
    reimbursements: [],
    recurringReimbursements: [],
    inactiveEmployees: [],
    ...overrides,
  }
}

describe('a skipped occurrence and the materializer', () => {
  it('does not duplicate the cycle that was skipped', () => {
    const dueDate = dateOffset(-3)
    const data = makeData({
      checklistTemplates: [makeTemplate(dueDate)],
      checklists: [skippedInstance(dueDate)],
    })

    const result = materializeRecurringChecklists(data)
    const sameCycle = result.data.checklists.filter(
      (c: { templateId?: string; dueDate?: string }) =>
        c.templateId === TEMPLATE_ID && c.dueDate === dueDate,
    )
    expect(sameCycle).toHaveLength(1)
    expect(isChecklistSkipped(sameCycle[0])).toBe(true)
  })

  it('still generates the next occurrence, and generates it OPEN', () => {
    // The template's schedule has already rolled past the skipped cycle, which
    // is the ordinary state after a month's worth of reads.
    const skippedDue = dateOffset(-3)
    const data = makeData({
      checklistTemplates: [makeTemplate(skippedDue)],
      checklists: [skippedInstance(skippedDue)],
    })

    const result = materializeRecurringChecklists(data)
    const forTemplate = result.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === TEMPLATE_ID,
    )
    // The template advanced past the skipped cycle, so at least the skipped row
    // survives and nothing was lost.
    expect(forTemplate.some((c: { id: string }) => c.id === 'cl-skipped')).toBe(true)
    expect(result.data.checklistTemplates[0].nextDueDate > skippedDue).toBe(true)

    // Now let the clock reach the next cycle: it materializes normally, is NOT
    // skipped, and is a different instance from the one that was stepped past.
    const nextCycle = materializeRecurringChecklists({
      ...result.data,
      checklistTemplates: [makeTemplate(dateOffset(-1))],
    })
    const fresh = nextCycle.data.checklists.filter(
      (c: { templateId?: string; id: string }) =>
        c.templateId === TEMPLATE_ID && c.id !== 'cl-skipped',
    )
    expect(fresh.length).toBeGreaterThanOrEqual(1)
    expect(fresh.every((c: { skippedAt?: string }) => !c.skippedAt)).toBe(true)
  })

  it('is idempotent — a second read adds nothing', () => {
    const dueDate = dateOffset(-3)
    const first = materializeRecurringChecklists(
      makeData({
        checklistTemplates: [makeTemplate(dueDate)],
        checklists: [skippedInstance(dueDate)],
      }),
    )
    const second = materializeRecurringChecklists(first.data)
    expect(second.data.checklists).toHaveLength(first.data.checklists.length)
  })
})

describe('a skipped occurrence and the overdue bucket', () => {
  const overdue = {
    id: 'cl-skipped',
    title: 'Monthly Close',
    dueDate: dateOffset(-10),
    items: [{ id: 'i1', label: 'Step', done: false }],
  } as unknown as Checklist

  it('would otherwise read as overdue — the RULE is unchanged', () => {
    expect(groupChecklist(overdue, dateOffset(0))).toBe('overdue')
  })

  it('never reaches the rule once skipped, because the active list drops it', () => {
    // This mirrors exactly what `visibleChecklists` in App.tsx does: filter
    // first, bucket second. The overdue view is not modified; it simply is not
    // handed a task that was deliberately moved to its next occurrence.
    const skipped = { ...overdue, skippedAt: new Date().toISOString() } as Checklist
    const active = [skipped].filter((checklist) => !isChecklistSkipped(checklist))

    expect(active).toHaveLength(0)
    expect(active.map((checklist) => groupChecklist(checklist, dateOffset(0)))).not.toContain(
      'overdue',
    )
  })
})
