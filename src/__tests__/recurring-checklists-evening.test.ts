// Pins the evening bug: from 8pm Eastern the UTC date is already "tomorrow", and
// ensureRecurringChecklists used to read that UTC date as "today" while taking
// the month from local getters. A specific-months instance due TODAY was then
// born with every step done. The zone is fixed here, before anything reads a
// date, so the suite means the same thing on a UTC CI runner and on a laptop.
process.env.TZ = 'America/New_York'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureRecurringChecklists, localDateOnly } from '../lib/utils'
import type { AppData, ChecklistTemplate } from '../lib/types'

const template: ChecklistTemplate = {
  id: 'tmpl-evening',
  title: 'Month-end close',
  clientId: 'client-1',
  assigneeId: 'emp-1',
  frequency: 'specific-months',
  nextDueDate: '',
  scheduledMonths: [9],
  // No per-month day: the default is the last day of the month, 2026-09-30.
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
      items: [
        {
          id: 'ti-1',
          label: 'Reconcile bank feed',
          subItems: [
            { id: 'tsi-1', title: 'Match deposits', subItems: [{ id: 'tssi-1', title: 'Pull statement' }] },
          ],
        },
      ],
    },
  ],
}

function makeData(): AppData {
  return {
    employees: [{ id: 'emp-1', name: 'Avery', role: 'Bookkeeper' }],
    clients: [
      {
        id: 'client-1',
        name: 'Acme',
        contact: 'A. Person',
        billingMode: 'hourly',
        hourlyRate: 100,
        planIds: [],
        contactIds: [],
      },
    ],
    plans: [],
    contacts: [],
    timeEntries: [],
    checklistTemplates: [structuredClone(template)],
    checklists: [],
    recycledChecklists: [],
    timesheetLocks: [],
    weeklySubmissions: [],
    reimbursements: [],
    recurringReimbursements: [],
    inactiveEmployees: [],
  }
}

type Born = {
  dueDate: string
  createdAt?: string
  items: Array<{
    done: boolean
    subItems?: Array<{ done: boolean; subItems?: Array<{ done: boolean }> }>
  }>
}

const septemberInstance = (result: ReturnType<typeof ensureRecurringChecklists>): Born => {
  const found = result.data.checklists.filter((c) => c.templateId === 'tmpl-evening')
  expect(found).toHaveLength(1)
  return found[0] as unknown as Born
}

const everyLevelDone = (checklist: Born, expected: boolean) =>
  checklist.items.every(
    (item) =>
      item.done === expected &&
      (item.subItems ?? []).every(
        (sub) => sub.done === expected && (sub.subItems ?? []).every((s) => s.done === expected),
      ),
  )

describe('ensureRecurringChecklists — the evening of the last day of the month', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is the clock mix the bug needs: UTC says Oct 1 while the wall clock says Sep 30', () => {
    // 2026-09-30 21:00 Eastern (EDT, UTC-4) is 2026-10-01T01:00Z.
    vi.setSystemTime(new Date('2026-10-01T01:00:00.000Z'))
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-01')
    expect(localDateOnly()).toBe('2026-09-30')
  })

  it('creates a September instance due today OPEN, with no step done at any level', () => {
    vi.setSystemTime(new Date('2026-10-01T01:00:00.000Z'))
    const instance = septemberInstance(ensureRecurringChecklists(makeData()))
    expect(instance.dueDate).toBe('2026-09-30')
    expect(everyLevelDone(instance, false)).toBe(true)
  })

  it('creates the same instance OPEN when the local date is passed explicitly', () => {
    // Independent of the system clock entirely.
    vi.setSystemTime(new Date('2030-01-15T12:00:00.000Z'))
    const instance = septemberInstance(ensureRecurringChecklists(makeData(), '2026-09-30'))
    expect(everyLevelDone(instance, false)).toBe(true)
  })

  it('creates it already completed one local day later, once the due date has passed', () => {
    // 2026-10-01 21:00 Eastern is 2026-10-02T01:00Z.
    vi.setSystemTime(new Date('2026-10-02T01:00:00.000Z'))
    const instance = septemberInstance(ensureRecurringChecklists(makeData()))
    expect(instance.dueDate).toBe('2026-09-30')
    expect(everyLevelDone(instance, true)).toBe(true)
    // And an explicit date agrees with the ambient one.
    const explicit = septemberInstance(ensureRecurringChecklists(makeData(), '2026-10-01'))
    expect(everyLevelDone(explicit, true)).toBe(true)
  })

  it('stamps the new instance with the full instant, like the server spawn', () => {
    // A bare day would sort before every timestamp of the same day in the
    // pending-notes attach rule, so the stamp is the instant itself, not a day
    // read off either the UTC or the local clock.
    vi.setSystemTime(new Date('2026-10-01T01:00:00.000Z'))
    const instance = septemberInstance(ensureRecurringChecklists(makeData()))
    expect(instance.createdAt).toBe('2026-10-01T01:00:00.000Z')
  })

  it('stamps an instance later than a note written earlier that evening', () => {
    // The "next checklist after this note" rule compares the two as instants. A
    // bare day on the instance would sort before the note's timestamp.
    const note = { createdAt: '2026-10-01T00:30:00.000Z' } // 8:30 pm Eastern, Sept 30
    vi.setSystemTime(new Date('2026-10-01T01:00:00.000Z')) // 9 pm Eastern
    const instance = septemberInstance(ensureRecurringChecklists(makeData()))
    expect(instance.createdAt! > note.createdAt).toBe(true)
  })

  it('gives a recipe set up that evening its September occurrence', () => {
    // Its stamp reads 2026-10-01 in UTC. Read that way the floor is October and
    // September, the month it was created in, never generates.
    vi.setSystemTime(new Date('2026-10-01T01:00:00.000Z'))
    const data = makeData()
    data.checklistTemplates[0].createdAt = new Date().toISOString()
    const instance = septemberInstance(ensureRecurringChecklists(data))
    expect(instance.dueDate).toBe('2026-09-30')
    expect(everyLevelDone(instance, false)).toBe(true)
  })
})
