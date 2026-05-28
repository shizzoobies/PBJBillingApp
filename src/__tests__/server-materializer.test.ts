/**
 * Server-side regression tests for `materializeRecurringChecklists` —
 * the function that runs on every `appDataStore.read()` and auto-spawns
 * recurring checklist instances from templates.
 *
 * The bug we're hunting: a soft-deleted checklist (one moved to
 * `recycledChecklists` by the user) was being respawned by the
 * materializer on the next read, undoing the delete from the user's POV.
 *
 * The previous fix (commit ecd4cdc) folded `data.recycledChecklists` into
 * the `existingKeys` set so the materializer treats recycled instances
 * as "already exists" and refuses to respawn for the same templateId +
 * dueDate + stageIndex tuple. These tests pin that behavior down.
 *
 * NOTE: the test file is `.ts` only for consistency with the other
 * tests; the import target is `../../db/store.js` (plain JS) which
 * vitest resolves directly. The materializer takes a plain object so we
 * don't need to mock pg.
 */
// @ts-expect-error - plain-JS module without type declarations
import { materializeRecurringChecklists } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function makeData(overrides: Record<string, unknown> = {}) {
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

function makeMonthlyTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-monthly',
    title: 'Monthly Close',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    frequency: 'monthly',
    nextDueDate: daysAgo(3), // overdue, so materializer fires
    active: true,
    isStandard: false,
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
    ...overrides,
  }
}

describe('materializeRecurringChecklists — soft-delete respect', () => {
  it('materializes a fresh instance when the template is overdue and no instance exists', () => {
    const data = makeData({ checklistTemplates: [makeMonthlyTemplate()] })
    const result = materializeRecurringChecklists(data)

    expect(result.changed).toBe(true)
    const generated = result.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    expect(generated.length).toBeGreaterThanOrEqual(1)
  })

  it('does NOT respawn a soft-deleted instance for the same period', () => {
    // Setup: template's previous spawn was for daysAgo(3). The instance
    // is now in recycledChecklists (user deleted it). The template's
    // nextDueDate is the SAME period — exactly the scenario the user is
    // hitting on the dashboard.
    const dueDate = daysAgo(3)
    const recycledInstance = {
      id: 'cl-recycled-1',
      title: 'Monthly Close',
      clientId: 'client-1',
      assigneeId: 'emp-1',
      templateId: 'tpl-monthly',
      frequency: 'monthly',
      dueDate,
      viewerIds: [],
      editorIds: [],
      caseId: 'case-recycled',
      stageId: 'stage-1',
      stageIndex: 0,
      stageCount: 1,
      deletedAt: new Date().toISOString(),
      items: [{ id: 'item-1', label: 'Reconcile bank feed', done: false }],
    }
    const data = makeData({
      checklistTemplates: [makeMonthlyTemplate({ nextDueDate: dueDate })],
      checklists: [],
      recycledChecklists: [recycledInstance],
    })

    const result = materializeRecurringChecklists(data)
    const activeForTemplate = result.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )

    // The active list must NOT contain a respawn for the recycled period.
    // The materializer is allowed to advance nextDueDate and spawn for a
    // LATER period, but the deleted period must stay deleted.
    const respawnedForRecycledPeriod = activeForTemplate.find(
      (c: { dueDate?: string }) => c.dueDate === dueDate,
    )
    expect(respawnedForRecycledPeriod).toBeUndefined()
  })

  it('keeps the recycled instance in recycledChecklists after materialize', () => {
    const dueDate = daysAgo(3)
    const data = makeData({
      checklistTemplates: [makeMonthlyTemplate({ nextDueDate: dueDate })],
      recycledChecklists: [
        {
          id: 'cl-recycled-1',
          title: 'Monthly Close',
          clientId: 'client-1',
          assigneeId: 'emp-1',
          templateId: 'tpl-monthly',
          frequency: 'monthly',
          dueDate,
          viewerIds: [],
          editorIds: [],
          caseId: 'case-recycled',
          stageId: 'stage-1',
          stageIndex: 0,
          stageCount: 1,
          deletedAt: new Date().toISOString(),
          items: [],
        },
      ],
    })

    const result = materializeRecurringChecklists(data)
    expect(result.data.recycledChecklists).toHaveLength(1)
    expect(result.data.recycledChecklists[0].id).toBe('cl-recycled-1')
  })

  it('does not respawn even after multiple consecutive materialize passes', () => {
    // Idempotency check — running materialize a second time on its own
    // output should not introduce any new active instance for the
    // recycled period.
    const dueDate = daysAgo(3)
    const data = makeData({
      checklistTemplates: [makeMonthlyTemplate({ nextDueDate: dueDate })],
      recycledChecklists: [
        {
          id: 'cl-recycled-1',
          title: 'Monthly Close',
          clientId: 'client-1',
          assigneeId: 'emp-1',
          templateId: 'tpl-monthly',
          frequency: 'monthly',
          dueDate,
          viewerIds: [],
          editorIds: [],
          caseId: 'case-recycled',
          stageId: 'stage-1',
          stageIndex: 0,
          stageCount: 1,
          deletedAt: new Date().toISOString(),
          items: [],
        },
      ],
    })

    const first = materializeRecurringChecklists(data)
    const second = materializeRecurringChecklists(first.data)

    const activeForPeriod = second.data.checklists.filter(
      (c: { templateId?: string; dueDate?: string }) =>
        c.templateId === 'tpl-monthly' && c.dueDate === dueDate,
    )
    expect(activeForPeriod).toHaveLength(0)
  })

  it('the recycle-bin gate is tuple-specific (recycled period blocked, others allowed)', () => {
    // Proves the gate only blocks the matching (templateId, dueDate,
    // stageIndex) tuple — not the whole template. Setup: recycled
    // instance for period A, template's nextDueDate is for period B
    // (also overdue). Period B should spawn; period A should not.
    const recycledPeriod = daysAgo(30) // recycled tombstone
    const liveOverduePeriod = daysAgo(3) // what the template will spawn
    const data = makeData({
      checklistTemplates: [
        makeMonthlyTemplate({
          id: 'tpl-monthly',
          frequency: 'monthly',
          nextDueDate: liveOverduePeriod,
        }),
      ],
      recycledChecklists: [
        {
          id: 'cl-recycled-old',
          title: 'Stale month',
          clientId: 'client-1',
          assigneeId: 'emp-1',
          templateId: 'tpl-monthly',
          frequency: 'monthly',
          dueDate: recycledPeriod,
          viewerIds: [],
          editorIds: [],
          caseId: 'case-old',
          stageId: 'stage-1',
          stageIndex: 0,
          stageCount: 1,
          deletedAt: new Date().toISOString(),
          items: [],
        },
      ],
    })

    const result = materializeRecurringChecklists(data)
    const spawnedActive = result.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )

    // No respawn for the OLD recycled period.
    expect(
      spawnedActive.find((c: { dueDate?: string }) => c.dueDate === recycledPeriod),
    ).toBeUndefined()
    // But the live overdue period IS spawned.
    expect(
      spawnedActive.find((c: { dueDate?: string }) => c.dueDate === liveOverduePeriod),
    ).toBeDefined()
  })
})

describe('materializeRecurringChecklists — biweekly cadence', () => {
  const addDaysIso = (iso: string, days: number) => {
    const d = new Date(`${iso}T12:00:00`)
    d.setDate(d.getDate() + days)
    return d.toISOString().slice(0, 10)
  }
  const dayGap = (a: string, b: string) =>
    Math.round(
      (new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000,
    )

  it('spawns biweekly instances exactly 14 days apart and advances nextDueDate by 14', () => {
    const start = daysAgo(28) // two full biweekly periods overdue
    const data = makeData({
      checklistTemplates: [
        makeMonthlyTemplate({ id: 'tpl-biweekly', frequency: 'biweekly', nextDueDate: start }),
      ],
    })

    const result = materializeRecurringChecklists(data)
    const dueDates: string[] = result.data.checklists
      .filter((c: { templateId?: string }) => c.templateId === 'tpl-biweekly')
      .map((c: { dueDate: string }) => c.dueDate)
      .sort()

    // First spawn is the original due date; the next is exactly 14 days later.
    expect(dueDates[0]).toBe(start)
    expect(dueDates).toContain(addDaysIso(start, 14))
    // Every consecutive spawn is a clean 14-day step — not 7 (weekly) or ~30 (monthly).
    for (let i = 1; i < dueDates.length; i += 1) {
      expect(dayGap(dueDates[i - 1], dueDates[i])).toBe(14)
    }
    // The template's own cursor advanced in whole 14-day steps into the future.
    const tpl = result.data.checklistTemplates.find((t: { id: string }) => t.id === 'tpl-biweekly')
    expect(dayGap(start, tpl.nextDueDate) % 14).toBe(0)
    expect(dayGap(start, tpl.nextDueDate)).toBeGreaterThan(0)
  })
})
