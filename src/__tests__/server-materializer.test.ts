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

describe('materializeRecurringChecklists — due day-of-month survives the normalizer', () => {
  it('keeps a stage AND item dueDayOfMonth through ensureTemplateStages', () => {
    // Regression: the store-side ensureTemplateStages rebuilt each stage but
    // dropped its dueDayOfMonth, so picking "Day of the month" on a stage was
    // silently lost on save (it reverted to "no due date" on reload).
    const template = makeMonthlyTemplate({
      stages: [
        {
          id: 'stage-1',
          name: 'Stage 1',
          assigneeId: 'emp-1',
          offsetDays: 0,
          dueDayOfMonth: 15,
          viewerIds: [],
          editorIds: [],
          items: [{ id: 'ti-1', label: 'Reconcile', dueDayOfMonth: 10 }],
        },
      ],
    })
    const result = materializeRecurringChecklists(
      makeData({ checklistTemplates: [template] }),
    )
    const out = result.data.checklistTemplates.find(
      (t: { id: string }) => t.id === 'tpl-monthly',
    )
    expect(out.stages[0].dueDayOfMonth).toBe(15)
    expect(out.stages[0].items[0].dueDayOfMonth).toBe(10)
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

describe('materializeRecurringChecklists — specific-months per-month due dates', () => {
  const thisYear = new Date().getFullYear()

  function makeSpecificMonthsTemplate(overrides: Record<string, unknown> = {}) {
    // January has started by any date the test could run on, so an occurrence
    // in month 1 is always generated — keeps these assertions deterministic.
    return makeMonthlyTemplate({
      id: 'tpl-sm',
      frequency: 'specific-months',
      nextDueDate: '',
      scheduledMonths: [1],
      ...overrides,
    })
  }

  it('honors the per-month day and lifts the old 28-day cap (Jan 31)', () => {
    const data = makeData({
      checklistTemplates: [makeSpecificMonthsTemplate({ monthlyDueDays: { 1: 31 } })],
    })
    const result = materializeRecurringChecklists(data)
    const due = result.data.checklists
      .filter((c: { templateId?: string }) => c.templateId === 'tpl-sm')
      .map((c: { dueDate: string }) => c.dueDate)
    expect(due).toContain(`${thisYear}-01-31`)
  })

  it('clamps an out-of-range day down to the month length', () => {
    const data = makeData({
      checklistTemplates: [makeSpecificMonthsTemplate({ monthlyDueDays: { 1: 99 } })],
    })
    const result = materializeRecurringChecklists(data)
    const due = result.data.checklists
      .filter((c: { templateId?: string }) => c.templateId === 'tpl-sm')
      .map((c: { dueDate: string }) => c.dueDate)
    expect(due).toContain(`${thisYear}-01-31`)
  })

  it('falls back to the legacy shared dueDayOfMonth when no per-month entry exists', () => {
    const data = makeData({
      checklistTemplates: [makeSpecificMonthsTemplate({ dueDayOfMonth: 10, monthlyDueDays: {} })],
    })
    const result = materializeRecurringChecklists(data)
    const due = result.data.checklists
      .filter((c: { templateId?: string }) => c.templateId === 'tpl-sm')
      .map((c: { dueDate: string }) => c.dueDate)
    expect(due).toContain(`${thisYear}-01-10`)
  })
})

describe('materializeRecurringChecklists — specific-months auto-complete past months', () => {
  const thisYear = new Date().getFullYear()
  const today = new Date().toISOString().slice(0, 10)
  const currentMonth = new Date().getMonth() + 1 // 1–12

  type GenItem = {
    done: boolean
    subItems?: Array<{ done: boolean; subItems?: Array<{ done: boolean }> }>
  }
  type GenChecklist = { templateId?: string; dueDate: string; items: GenItem[] }

  const everyLevelDone = (checklist: GenChecklist): boolean =>
    checklist.items.every(
      (item) =>
        item.done &&
        (item.subItems ?? []).every(
          (sub) => sub.done && (sub.subItems ?? []).every((subSub) => subSub.done),
        ),
    )

  function makeSpecificMonthsTemplate(overrides: Record<string, unknown> = {}) {
    return makeMonthlyTemplate({
      id: 'tpl-sm-auto',
      frequency: 'specific-months',
      nextDueDate: '',
      // A deeply-nested step tree so we can assert all three levels flip.
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
              label: 'Top step',
              subItems: [
                {
                  id: 'sub-1',
                  title: 'Sub step',
                  subItems: [{ id: 'subsub-1', title: 'Sub-sub step' }],
                },
              ],
            },
          ],
        },
      ],
      ...overrides,
    })
  }

  it('generates a COMPLETED instance for a designated month whose due date is in the past', () => {
    // Month 1 with day 1 → its due date is clearly in the past for any run date
    // after Jan 1 (which is every possible run date except Jan 1 itself).
    const data = makeData({
      checklistTemplates: [makeSpecificMonthsTemplate({ scheduledMonths: [1], monthlyDueDays: { 1: 1 } })],
    })
    const result = materializeRecurringChecklists(data)
    const generated: GenChecklist[] = result.data.checklists.filter(
      (c: GenChecklist) => c.templateId === 'tpl-sm-auto',
    )
    const pastInstance = generated.find((c) => c.dueDate === `${thisYear}-01-01`)
    // Skip if the test happens to run exactly on Jan 1 (then it's not past).
    if (today !== `${thisYear}-01-01`) {
      expect(pastInstance).toBeDefined()
      expect(everyLevelDone(pastInstance as GenChecklist)).toBe(true)
    }
  })

  it('generates an OPEN instance (done:false everywhere) for the current month', () => {
    // Current month with NO per-month day → end-of-month due date, which is
    // always today-or-later within the current month, so it's never "strictly
    // before today" and must be born OPEN regardless of the run date.
    const data = makeData({
      checklistTemplates: [
        makeSpecificMonthsTemplate({ scheduledMonths: [currentMonth], monthlyDueDays: {} }),
      ],
    })
    const result = materializeRecurringChecklists(data)
    const generated: GenChecklist[] = result.data.checklists.filter(
      (c: GenChecklist) => c.templateId === 'tpl-sm-auto',
    )
    const presentInstance = generated.find(
      (c) => c.dueDate.slice(5, 7) === String(currentMonth).padStart(2, '0'),
    )
    expect(presentInstance).toBeDefined()
    // Sanity: the resolved end-of-month due date is on/after today.
    expect((presentInstance as GenChecklist).dueDate >= today).toBe(true)
    // Every item / sub-item / sub-sub-item is born open.
    const allOpen = (presentInstance as GenChecklist).items.every(
      (item) =>
        item.done === false &&
        (item.subItems ?? []).every(
          (sub) => sub.done === false && (sub.subItems ?? []).every((subSub) => subSub.done === false),
        ),
    )
    expect(allOpen).toBe(true)
  })
})

describe('materializeRecurringChecklists — mixed weekly + monthly coexistence', () => {
  // Regression guard (real bug fixed Jun 24, 2026): a due MONTHLY template must
  // NOT prevent a due WEEKLY template from generating in the same materialize
  // pass. Each template advances on its own cadence with a non-colliding
  // instance key (templateId + dueDate + stageIndex), so both must spawn.
  it('generates BOTH weekly and monthly instances when both are due in one pass', () => {
    const data = makeData({
      checklistTemplates: [
        makeMonthlyTemplate({ id: 'tpl-monthly', title: 'Monthly Close', frequency: 'monthly' }),
        makeMonthlyTemplate({ id: 'tpl-weekly', title: 'Weekly Bank Rec', frequency: 'weekly' }),
      ],
    })

    const result = materializeRecurringChecklists(data)

    const monthly = result.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    const weekly = result.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-weekly',
    )
    expect(monthly.length).toBeGreaterThanOrEqual(1)
    expect(weekly.length).toBeGreaterThanOrEqual(1)
  })

  it('still generates the weekly instance when the monthly template is listed FIRST', () => {
    // The original bug was order-sensitive — a monthly template earlier in the
    // list short-circuited the loop for the weekly one. Guard against that.
    const data = makeData({
      checklistTemplates: [
        makeMonthlyTemplate({ id: 'tpl-monthly', frequency: 'monthly' }),
        makeMonthlyTemplate({ id: 'tpl-weekly', frequency: 'weekly' }),
      ],
    })

    const result = materializeRecurringChecklists(data)
    const weekly = result.data.checklists.some(
      (c: { templateId?: string }) => c.templateId === 'tpl-weekly',
    )
    expect(weekly).toBe(true)
  })
})

/**
 * Duplicate-instance regressions (featreq-90809c87 — "Cooper got two monthly
 * due, I removed one").
 *
 * Production held 21 groups of ACTIVE checklists sharing an identical
 * (templateId, dueDate, stageIndex). The materializer's idempotency was
 * check-then-insert with nothing underneath it, and its key was derived from
 * the template's CYCLE date while the row it wrote back carried the STAGE's
 * resolved due date — so the two never matched again on the next run.
 */
describe('materializeRecurringChecklists — duplicate prevention', () => {
  const instanceKey = (c: { templateId?: string; dueDate?: string; stageIndex?: number }) =>
    `${c.templateId}:${c.dueDate}:${c.stageIndex ?? 0}`

  it('running it a second time on its own output adds nothing', () => {
    const first = materializeRecurringChecklists(
      makeData({ checklistTemplates: [makeMonthlyTemplate()] }),
    )
    const generated = first.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    expect(generated.length).toBe(1)

    // This is exactly what the next `read()` does: re-materialize the state the
    // previous read just wrote back.
    const second = materializeRecurringChecklists(first.data)
    const after = second.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    expect(after.length).toBe(1)
    expect(after[0].id).toBe(generated[0].id)
  })

  it('two readers starting from the same state land on the SAME instance identity', () => {
    // The concurrency shape from production: two simultaneous GET /api/app-data
    // reads, each materializing from the same persisted snapshot. Both create an
    // instance (different random ids) — but if their identity tuples match, the
    // shared guard and the UNIQUE partial index both collapse them to one row.
    const base = makeData({ checklistTemplates: [makeMonthlyTemplate()] })
    const readerA = materializeRecurringChecklists(structuredClone(base))
    const readerB = materializeRecurringChecklists(structuredClone(base))

    const a = readerA.data.checklists.find(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    const b = readerB.data.checklists.find(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a.id).not.toBe(b.id) // genuinely two separate creations
    expect(instanceKey(a)).toBe(instanceKey(b)) // …of the same instance

    // Whichever one lost the race, replaying the materializer over the winner's
    // state must not resurrect a second copy.
    const settled = materializeRecurringChecklists(readerA.data)
    expect(
      settled.data.checklists.filter((c: { templateId?: string }) => c.templateId === 'tpl-monthly')
        .length,
    ).toBe(1)
  })

  it('never spawns two instances on the same due date when stage 1 has a FIXED due date', () => {
    // A stage with a hard-coded `dueDate` resolves to the SAME date every cycle.
    // The old cycle-date-only key changed each pass through the catch-up loop, so
    // a template that was several periods overdue produced one identical
    // instance per missed period — the duplicate signature seen in production.
    const template = makeMonthlyTemplate({
      nextDueDate: daysAgo(75),
      stages: [
        {
          id: 'stage-1',
          name: 'Stage 1',
          assigneeId: 'emp-1',
          offsetDays: 0,
          dueDate: daysAgo(40),
          viewerIds: [],
          editorIds: [],
          items: [{ id: 'ti-1', label: 'Reconcile bank feed' }],
        },
      ],
    })
    const result = materializeRecurringChecklists(makeData({ checklistTemplates: [template] }))
    const generated = result.data.checklists.filter(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    expect(generated.length).toBe(1)
    expect(generated[0].dueDate).toBe(daysAgo(40))
  })

  it('a specific-months template generates one instance per designated month, once', () => {
    const thisMonth = new Date().getMonth() + 1
    const template = makeMonthlyTemplate({
      id: 'tpl-sm',
      frequency: 'specific-months',
      nextDueDate: undefined,
      scheduledMonths: [thisMonth],
      dueDayOfMonth: 15,
    })
    const first = materializeRecurringChecklists(makeData({ checklistTemplates: [template] }))
    const once = first.data.checklists.filter((c: { templateId?: string }) => c.templateId === 'tpl-sm')
    expect(once.length).toBe(1)

    const second = materializeRecurringChecklists(first.data)
    expect(
      second.data.checklists.filter((c: { templateId?: string }) => c.templateId === 'tpl-sm').length,
    ).toBe(1)
  })
})

/**
 * Board/category regression (featreq-c395c79a — "several are in uncategorized
 * but the recurring checklist shows the correct board"). Instances must carry
 * their template's service category from birth; the display-level fallback in
 * `src/lib/activeBoard.ts` covers the rows generated before this was true.
 */
describe('materializeRecurringChecklists — service category', () => {
  it('copies the template category onto every generated instance', () => {
    const data = makeData({
      checklistTemplates: [makeMonthlyTemplate({ categoryId: 'cat-bookkeeping' })],
    })
    const result = materializeRecurringChecklists(data)
    const generated = result.data.checklists.find(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    expect(generated.categoryId).toBe('cat-bookkeeping')
  })

  it('leaves the instance category null when the template has none', () => {
    const result = materializeRecurringChecklists(
      makeData({ checklistTemplates: [makeMonthlyTemplate()] }),
    )
    const generated = result.data.checklists.find(
      (c: { templateId?: string }) => c.templateId === 'tpl-monthly',
    )
    expect(generated.categoryId).toBeNull()
  })
})

/**
 * Retiring a client closes the tap on NEW work without touching a thing that
 * already exists. The gate lives in `lib/recurring-gate.js`
 * (`inactiveClientIds`) so the server materializer, the browser's
 * `ensureRecurringChecklists`, and the Board/Gantt projection cannot drift
 * apart on which clients have stopped producing.
 */
describe('materializeRecurringChecklists — inactive clients', () => {
  const retiredClient = [
    {
      id: 'client-1',
      name: 'Acme',
      contact: 'A. Person',
      billingMode: 'hourly',
      hourlyRate: 100,
      planId: null,
      lifecycleStage: 'inactive',
    },
  ]

  it('generates nothing for an overdue template whose client is inactive', () => {
    const data = makeData({
      clients: retiredClient,
      checklistTemplates: [makeMonthlyTemplate()],
    })
    const result = materializeRecurringChecklists(data)

    // Asserted on the instances rather than `changed`, which also flips for
    // the unrelated legacy backfills this function performs on every read.
    expect(
      result.data.checklists.filter((c: { templateId?: string }) => c.templateId === 'tpl-monthly'),
    ).toHaveLength(0)
  })

  it('leaves the retired client’s existing instances exactly where they are', () => {
    const existing = {
      id: 'cl-old-1',
      title: 'Monthly Close',
      clientId: 'client-1',
      assigneeId: 'emp-1',
      templateId: 'tpl-monthly',
      frequency: 'monthly',
      dueDate: daysAgo(40),
      viewerIds: [],
      editorIds: [],
      caseId: 'case-old',
      stageId: 'stage-1',
      stageIndex: 0,
      stageCount: 1,
      items: [{ id: 'item-1', label: 'Reconcile bank feed', done: true }],
    }
    const data = makeData({
      clients: retiredClient,
      checklistTemplates: [makeMonthlyTemplate()],
      checklists: [existing],
    })
    const result = materializeRecurringChecklists(data)

    expect(result.data.checklists).toHaveLength(1)
    expect(result.data.checklists[0]).toMatchObject({ id: 'cl-old-1', clientId: 'client-1' })
  })

  it('still generates for every other client in the same pass', () => {
    const data = makeData({
      clients: [
        ...retiredClient,
        {
          id: 'client-2',
          name: 'Beta',
          contact: 'B. Person',
          billingMode: 'hourly',
          hourlyRate: 100,
          planId: null,
        },
      ],
      checklistTemplates: [
        makeMonthlyTemplate(),
        makeMonthlyTemplate({ id: 'tpl-beta', clientId: 'client-2' }),
      ],
    })
    const result = materializeRecurringChecklists(data)

    const generatedFor = result.data.checklists.map((c: { clientId: string }) => c.clientId)
    expect(generatedFor).toEqual(['client-2'])
  })

  it('resumes generating once the client is reactivated', () => {
    const template = makeMonthlyTemplate()
    expect(
      materializeRecurringChecklists(
        makeData({ clients: retiredClient, checklistTemplates: [template] }),
      ).data.checklists,
    ).toHaveLength(0)

    // Reactivate = flip the one flag back. Nothing else about the workspace
    // needs restoring, which is the whole point of the design.
    const reactivated = [{ ...retiredClient[0], lifecycleStage: 'active' }]
    const result = materializeRecurringChecklists(
      makeData({ clients: reactivated, checklistTemplates: [template] }),
    )
    expect(result.changed).toBe(true)
    expect(
      result.data.checklists.filter((c: { templateId?: string }) => c.templateId === 'tpl-monthly')
        .length,
    ).toBeGreaterThanOrEqual(1)
  })
})
