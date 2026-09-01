/**
 * The period label as the MATERIALIZER produces it — featreq-81429ad1.
 *
 * The arithmetic is pinned in lib/checklist-period-label.test.mjs. What is
 * pinned here is the WIRING: a recipe carrying a covered window stamps every
 * instance it generates with that instance's own window, a recipe without one
 * stamps nothing, and — her original constraint — turning the label on changes
 * NOTHING else about the instance.
 *
 * Second version. She sent the first back:
 *
 *   "The period covers should allow me to pick dates and then the how often
 *   should determine the next period"
 *
 * so the recipe now carries a first window and the task's own recurrence
 * advances it, exactly as a reimbursed expense's covered dates already do.
 */
// @ts-expect-error - plain-JS module without type declarations
import { materializeRecurringChecklists } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

function dateOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The window a recipe carries, as the repeating-task screen sets it. */
const COVERED = {
  periodLabelEnabled: true,
  periodCoverageStart: '2026-07-13',
  periodCoverageEnd: '2026-08-13',
}

function template(over: Record<string, unknown> = {}) {
  return {
    id: 'tpl-period',
    title: 'Monthly Reconciliations',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    frequency: 'monthly',
    // Due today, so the materializer creates this cycle on any run.
    nextDueDate: dateOffset(0),
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
    ...over,
  }
}

const run = (tpl: Record<string, unknown>) =>
  materializeRecurringChecklists({
    clients: [{ id: 'client-1', name: 'Acme' }],
    employees: [{ id: 'emp-1', name: 'Lisa', role: 'bookkeeper' }],
    checklists: [],
    checklistTemplates: [tpl],
    timeEntries: [],
  })

/** Anchored to the occurrence being generated, so it reads her window exactly. */
const anchored = (over: Record<string, unknown> = {}) =>
  template({ ...COVERED, periodCoverageAnchorDue: dateOffset(0), ...over })

describe('a recipe that carries a covered window', () => {
  it('stamps every generated instance with the dates she picked', () => {
    const created = run(anchored()).data.checklists
    expect(created.length).toBeGreaterThan(0)
    for (const checklist of created) {
      expect(checklist.periodLabel).toBe('July 13 – August 13, 2026')
    }
  })

  // Stored as a real string on the instance, not recomputed at render time:
  // the label a task was born with can never move under it afterwards.
  it('stores a real string on the instance', () => {
    const first = run(anchored()).data.checklists[0]
    expect(typeof first.periodLabel).toBe('string')
    expect((first.periodLabel as string).length).toBeGreaterThan(0)
  })
})

describe('a recipe that does not', () => {
  // "not all checklist/task would have it" — and the switch defaults off, so an
  // untouched recipe keeps generating exactly what it generated before.
  it('stamps nothing at all', () => {
    const cases = [
      template(),
      template({ periodLabelEnabled: false }),
      // Switched on, but she has not picked the dates yet.
      template({ periodLabelEnabled: true }),
      // Only one end picked — not a window.
      template({ periodLabelEnabled: true, periodCoverageStart: '2026-07-13' }),
    ]
    for (const tpl of cases) {
      for (const checklist of run(tpl).data.checklists) {
        expect(checklist.periodLabel).toBeNull()
      }
    }
  })
})

describe('“purely a label not to change anything we have already done”', () => {
  /**
   * HER CONSTRAINT, executed. Generate the same cycle twice — once without a
   * window, once with — and every field except `periodLabel` (and the random
   * instance id) must match. If switching this on ever moved a due date, an
   * assignee, an item, a stage or a category, this fails.
   */
  it('changes nothing else about the generated instance', () => {
    const withoutLabel = run(template()).data.checklists
    const withLabel = run(anchored()).data.checklists

    expect(withLabel).toHaveLength(withoutLabel.length)

    const strip = (checklist: Record<string, unknown>) => {
      const copy = { ...checklist } as Record<string, unknown>
      delete copy.periodLabel
      delete copy.id
      delete copy.caseId // derived from the id
      copy.items = (copy.items as Array<Record<string, unknown>>).map((item) => {
        const itemCopy = { ...item }
        delete itemCopy.id
        return itemCopy
      })
      return copy
    }

    for (let i = 0; i < withLabel.length; i += 1) {
      expect(strip(withLabel[i]), `instance ${i}`).toEqual(strip(withoutLabel[i]))
    }
    // And the label really was applied, so the comparison above meant something.
    expect(withLabel[0].periodLabel).toBeTruthy()
    expect(withoutLabel[0].periodLabel).toBeNull()
  })
})
