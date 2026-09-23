import { describe, expect, it } from 'vitest'
import { cloneChecklistTemplate, duplicateTemplateDraft } from '../lib/cloneChecklistTemplate'
import { dateOffset, ensureRecurringChecklists, localDateOnly } from '../lib/utils'
import type { AppData, ChecklistTemplate } from '../lib/types'

/**
 * Duplicating a repeating task — featreq-0bc2437e.
 *
 * Brittany: "I duplicated a repeating checklist and changed the client from
 * Let's Eat to I-95 and it will not populate for I-95 it keeps creating one for
 * Let's Eat."
 *
 * What happened, in order: Duplicate was a `{ ...source }` spread, so the copy
 * inherited the SOURCE's creation stamp (the start floor both materializers
 * measure against, which is month-granular) and its stale next due date, and
 * was switched on the instant it landed. Two instances for Let's Eat were born
 * within a minute. She changed the client five minutes later — but an
 * instance's client is a snapshot, and the "already generated" key is
 * client-blind, so those two rows kept Let's Eat AND occupied the months I-95
 * needed. Nothing ever appeared for I-95.
 *
 * Dates here are relative to the real today (`dateOffset`), like
 * recurring-checklists.test.ts: `ensureRecurringChecklists` reads `new Date()`
 * and takes no clock.
 */

function makeTemplate(overrides: Partial<ChecklistTemplate> = {}): ChecklistTemplate {
  return {
    id: 'tpl-lets-eat',
    title: 'Monthly bookkeeping',
    clientId: 'client-lets-eat',
    assigneeId: 'emp-1',
    frequency: 'monthly',
    nextDueDate: dateOffset(-40),
    // Set up last month — the stamp the copy must NOT inherit.
    createdAt: `${dateOffset(-40)}T09:00:00.000Z`,
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
      { id: 'client-lets-eat', name: "Let's Eat, LLC" },
      { id: 'client-i95', name: 'I-95 Signature, LLC' },
    ],
    plans: [],
    contacts: [],
    timeEntries: [],
    checklistTemplates: templates,
    checklists: [],
    recycledChecklists: [],
    timesheetLocks: [],
    weeklySubmissions: [],
  } as unknown as AppData
}

describe('duplicating a repeating task', () => {
  it('stamps the copy with today, not the source’s creation date', () => {
    const source = makeTemplate()
    const copy = duplicateTemplateDraft(source)

    // A template's creation stamp is a UTC ISO timestamp, like the one App.tsx
    // puts on a brand-new recipe and the one the server stores and reads back;
    // the start floor is its first ten characters, the UTC day. So the expected
    // day is the UTC one (`dateOffset(0)`), not the local calendar date, which
    // is a day behind after 8pm Eastern.
    expect(copy.createdAt?.slice(0, 10)).toBe(dateOffset(0))
    expect(copy.createdAt).not.toBe(source.createdAt)
  })

  it('records where the copy came from', () => {
    const source = makeTemplate()
    const copy = duplicateTemplateDraft(source)

    expect(copy.sourceTemplateId).toBe(source.id)
    expect(copy.title).toBe('Monthly bookkeeping (copy)')
    // Still on the source's client: the owner re-aims it, and until they do it
    // generates nothing for anyone.
    expect(copy.clientId).toBe(source.clientId)
  })

  it('creates the copy switched OFF', () => {
    expect(duplicateTemplateDraft(makeTemplate({ active: true })).active).toBe(false)
  })

  it('generates nothing at all while it sits there switched off', () => {
    const source = makeTemplate()
    const copy = { ...duplicateTemplateDraft(source), id: 'tpl-copy' } as ChecklistTemplate
    // The source is off too, so anything that spawns came from the copy.
    const { data } = ensureRecurringChecklists(
      makeData([{ ...source, active: false }, copy]),
    )

    expect(data.checklists).toHaveLength(0)
  })

  it('back-fills no occurrence from before the copy existed, once it is turned on', () => {
    const source = makeTemplate()
    // The owner re-aims the copy at the new client and switches it on — the
    // whole point of duplicating.
    const copy = {
      ...duplicateTemplateDraft(source),
      id: 'tpl-copy',
      clientId: 'client-i95',
      active: true,
    } as ChecklistTemplate
    const { data } = ensureRecurringChecklists(makeData([{ ...source, active: false }, copy]))

    const spawned = data.checklists.filter((checklist) => checklist.templateId === 'tpl-copy')
    const thisMonth = localDateOnly().slice(0, 7)
    for (const checklist of spawned) {
      expect(checklist.dueDate.slice(0, 7) >= thisMonth).toBe(true)
      // And every one of them belongs to the client the copy was aimed at.
      expect(checklist.clientId).toBe('client-i95')
    }
  })

  it('floors a specific-months copy’s first cycle at today, however stale the source is', () => {
    const source = makeTemplate({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: dateOffset(-400),
    })
    const copy = duplicateTemplateDraft(source)

    expect(copy.nextDueDate >= localDateOnly()).toBe(true)
  })
})

describe('an instance’s client is decided at birth', () => {
  it('stamps each spawned task with its template’s client', () => {
    const template = makeTemplate({
      id: 'tpl-birth',
      clientId: 'client-i95',
      nextDueDate: dateOffset(-1),
      createdAt: `${dateOffset(-1)}T09:00:00.000Z`,
    })
    const { data } = ensureRecurringChecklists(makeData([template]))

    const spawned = data.checklists.filter((checklist) => checklist.templateId === 'tpl-birth')
    expect(spawned.length).toBeGreaterThan(0)
    // This is why re-aiming a recipe cannot fix the tasks it already made: the
    // client is copied down once, here, and never looked at again.
    for (const checklist of spawned) {
      expect(checklist.clientId).toBe('client-i95')
    }
  })
})

describe('the shared clone', () => {
  it('leaves the client-side copy ("Set up plan checklists") switched on', () => {
    // That path picks the client up front, so there is no window in which the
    // copy could generate for the wrong one.
    const copy = cloneChecklistTemplate(makeTemplate(), { clientId: 'client-i95', active: true })

    expect(copy.active).toBe(true)
    expect(copy.clientId).toBe('client-i95')
    expect(copy.title).toBe('Monthly bookkeeping')
    // UTC day, for the reason given on the Duplicate test above.
    expect(copy.createdAt?.slice(0, 10)).toBe(dateOffset(0))
  })

  it('gives the copy fresh ids at every level', () => {
    const source = makeTemplate()
    const copy = duplicateTemplateDraft(source)

    expect(copy.stages[0].id).not.toBe(source.stages[0].id)
    expect(copy.stages[0].items[0].id).not.toBe(source.stages[0].items[0].id)
    expect(copy.stages[0].items[0].label).toBe('Reconcile bank feed')
  })

  it('carries the settings a copy is expected to keep', () => {
    const source = makeTemplate({
      categoryId: 'cat-1',
      leadDays: 5,
      skipAllowed: true,
      periodLabelEnabled: true,
      periodCoverageStart: '2026-07-01',
      periodCoverageEnd: '2026-07-31',
      viewerIds: ['emp-2'],
    })
    const copy = duplicateTemplateDraft(source)

    expect(copy.categoryId).toBe('cat-1')
    expect(copy.leadDays).toBe(5)
    expect(copy.skipAllowed).toBe(true)
    expect(copy.periodLabelEnabled).toBe(true)
    expect(copy.periodCoverageStart).toBe('2026-07-01')
    expect(copy.viewerIds).toEqual(['emp-2'])
    // A copy is never a blueprint, whatever it was copied from.
    expect(copy.isStandard).toBe(false)
  })
})
