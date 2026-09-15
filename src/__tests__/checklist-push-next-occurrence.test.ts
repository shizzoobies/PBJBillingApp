/**
 * THE trap this feature had to clear, pinned against the real materializer.
 *
 * Pushing an occurrence moves its `dueDate`. If identity were still read off
 * `dueDate`, two things would break at once, and the DEFAULT push date — the
 * next cycle — walks straight into both:
 *
 *   1. the cycle the task was pushed OUT of would no longer be represented by
 *      any row the materializer recognizes, so the next read would respawn it
 *      as a duplicate ("it came right back"), and
 *   2. the pushed row would be sitting on exactly the date the next occurrence
 *      is about to claim, so that occurrence would either collide with it or be
 *      silently swallowed.
 *
 * `cycleDueDate` is what prevents both: it holds the date the occurrence was
 * originally due, and `checklistIdentityDueDate` is what every key is built
 * from. These tests call the REAL `materializeRecurringChecklists` out of
 * db/store.js, exactly like `checklist-skip-next-occurrence.test.ts`, because a
 * re-implementation here would prove nothing about the code that ships.
 */
// @ts-expect-error - plain-JS module without type declarations
import { materializeRecurringChecklists } from '../../db/store.js'
import { isChecklistSkipped } from '../../lib/checklist-skip.js'
import { describe, expect, it } from 'vitest'

const TEMPLATE_ID = 'tpl-pushable'

type Row = {
  id: string
  templateId?: string
  dueDate?: string
  cycleDueDate?: string | null
  skippedAt?: string | null
  pushedAt?: string | null
}

function dateOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** `dateString` + n calendar months, the way the store's own helper steps. */
function addMonths(dateString: string, months: number): string {
  const [year, month, day] = dateString.split('-').map(Number)
  const date = new Date(year, month - 1 + months, day)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

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

/**
 * An instance that was pushed: `cycleDueDate` is where it belongs in the
 * schedule, `dueDate` is where the work now sits. This is exactly the row
 * `pushChecklistInstance` writes.
 */
function pushedInstance(cycleDueDate: string, newDueDate: string, over: Record<string, unknown> = {}) {
  return {
    id: 'cl-pushed',
    title: 'Monthly Close',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    templateId: TEMPLATE_ID,
    frequency: 'monthly',
    dueDate: newDueDate,
    cycleDueDate,
    pushedAt: new Date().toISOString(),
    pushedBy: 'emp-1',
    viewerIds: [],
    editorIds: [],
    caseId: 'case-pushed',
    stageId: 'stage-1',
    stageIndex: 0,
    stageCount: 1,
    items: [{ id: 'item-1', label: 'Reconcile bank feed', done: false }],
    ...over,
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

const forTemplate = (rows: Row[]) => rows.filter((row) => row.templateId === TEMPLATE_ID)

describe('a monthly occurrence pushed onto the next cycle', () => {
  // The worst case and the DEFAULT one: the dialog pre-fills exactly this date.
  // Both dates are in the past so a single materialize pass covers the cycle
  // that was pushed out of AND the cycle that was pushed onto.
  const cycleDue = dateOffset(-40)
  const nextCycleDue = addMonths(cycleDue, 1)

  it('does not respawn the cycle it was pushed out of', () => {
    const result = materializeRecurringChecklists(
      makeData({
        checklistTemplates: [makeTemplate(cycleDue)],
        checklists: [pushedInstance(cycleDue, nextCycleDue)],
      }),
    )

    const sameCycle = forTemplate(result.data.checklists).filter(
      (row) => (row.cycleDueDate ?? row.dueDate) === cycleDue,
    )
    expect(sameCycle).toHaveLength(1)
    expect(sameCycle[0].id).toBe('cl-pushed')
  })

  it('still generates the next cycle, as its own distinct row on the same date', () => {
    const result = materializeRecurringChecklists(
      makeData({
        checklistTemplates: [makeTemplate(cycleDue)],
        checklists: [pushedInstance(cycleDue, nextCycleDue)],
      }),
    )

    // The next cycle's own due date is the very date the pushed task now sits
    // on. It must STILL be created, as a different row that is not itself
    // pushed — the two are told apart by their cycle dates, not their due dates.
    const fresh = forTemplate(result.data.checklists).filter((row) => row.id !== 'cl-pushed')
    expect(fresh).toHaveLength(1)
    expect(fresh[0].dueDate).toBe(nextCycleDue)
    expect(fresh[0].cycleDueDate ?? null).toBeNull()
    expect(fresh[0].pushedAt ?? null).toBeNull()

    // And the pushed task is untouched, still parked where it was put.
    const pushed = result.data.checklists.find((row: Row) => row.id === 'cl-pushed')
    expect(pushed.dueDate).toBe(nextCycleDue)
    expect(pushed.cycleDueDate).toBe(cycleDue)
  })

  it('is idempotent — a second read adds nothing', () => {
    const first = materializeRecurringChecklists(
      makeData({
        checklistTemplates: [makeTemplate(cycleDue)],
        checklists: [pushedInstance(cycleDue, nextCycleDue)],
      }),
    )
    const second = materializeRecurringChecklists(first.data)
    expect(second.data.checklists).toHaveLength(first.data.checklists.length)
  })
})

describe('a specific-months occurrence pushed across a month boundary', () => {
  // A specific-months template is deduped per MONTH, so pushing into the next
  // month is precisely the move that would free its own month to respawn.
  const year = new Date().getFullYear()
  const month = new Date().getMonth() + 1
  const dayInMonth = `${year}-${String(month).padStart(2, '0')}-01`
  const nextMonth = addMonths(dayInMonth, 1)

  const specificTemplate = {
    ...makeTemplate(''),
    frequency: 'specific-months',
    scheduledMonths: [month],
    scheduleYear: year,
    repeatAnnually: true,
  }

  it('does not respawn the designated month it was pushed out of', () => {
    const result = materializeRecurringChecklists(
      makeData({
        checklistTemplates: [specificTemplate],
        checklists: [pushedInstance(dayInMonth, nextMonth)],
      }),
    )

    // Exactly one row for the template: the pushed one. Its month key still
    // reads off the CYCLE date, so the designated month counts as generated.
    expect(forTemplate(result.data.checklists)).toHaveLength(1)
    expect(result.data.checklists[0].id).toBe('cl-pushed')
  })

  it('stays idempotent across repeated reads', () => {
    const first = materializeRecurringChecklists(
      makeData({
        checklistTemplates: [specificTemplate],
        checklists: [pushedInstance(dayInMonth, nextMonth)],
      }),
    )
    const second = materializeRecurringChecklists(first.data)
    const third = materializeRecurringChecklists(second.data)
    expect(forTemplate(third.data.checklists)).toHaveLength(1)
  })
})

describe('what a push is NOT', () => {
  const cycleDue = dateOffset(-3)
  const newDue = dateOffset(20)

  it('is never read as skipped — the task is alive and still owed', () => {
    const row = pushedInstance(cycleDue, newDue)
    expect(isChecklistSkipped(row)).toBe(false)

    // Which is the whole difference on screen: the active list drops a skipped
    // row and keeps a pushed one.
    const active = [row].filter((entry) => !isChecklistSkipped(entry))
    expect(active).toHaveLength(1)
  })

  it('reads as due on the NEW date, not the cycle date', () => {
    const row = pushedInstance(cycleDue, newDue)
    expect(row.dueDate).toBe(newDue)
    expect(row.cycleDueDate).toBe(cycleDue)
  })

  it('completes nothing — every step is still open', () => {
    const row = pushedInstance(cycleDue, newDue)
    expect(row.items.every((item) => !item.done)).toBe(true)
  })
})
