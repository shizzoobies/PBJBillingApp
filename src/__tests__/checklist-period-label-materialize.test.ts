/**
 * The period label as the MATERIALIZER produces it — featreq-81429ad1.
 *
 * `lib/checklist-period-label.test.mjs` pins the arithmetic. What is pinned here
 * is the wiring: a template that opted in stamps every instance it generates
 * with the period that instance covers, a template that did not opted in stamps
 * nothing, and — the constraint she actually gave — turning the label on changes
 * NOTHING else about the instance.
 *
 * Brittany's words: "purely a label not to change anything we have already
 * done." The last test is that sentence, executed: generate the same cycle with
 * the label off and on, and every other field must be byte-identical.
 */
// @ts-expect-error - plain-JS module without type declarations
import { materializeRecurringChecklists } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

function dateOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
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

/** The month before `dueDate`, spelled the way the label spells it. */
function expectedLabelFor(dueDate: string) {
  const [year, month] = dueDate.split('-').map(Number)
  const absolute = year * 12 + (month - 1) - 1
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return `${names[absolute % 12]} ${Math.floor(absolute / 12)}`
}

describe('a template that carries a period label', () => {
  it('stamps the period the generated instance covers', () => {
    const result = run(template({ periodLabelEnabled: true, periodLabelOffset: 1 }))
    const created = result.data.checklists
    expect(created.length).toBeGreaterThan(0)
    for (const checklist of created) {
      expect(checklist.periodLabel).toBe(expectedLabelFor(checklist.dueDate))
    }
  })

  it('honors an offset of 0 — the period it is due in', () => {
    const result = run(template({ periodLabelEnabled: true, periodLabelOffset: 0 }))
    const first = result.data.checklists[0]
    const [year, month] = first.dueDate.split('-').map(Number)
    const names = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ]
    expect(first.periodLabel).toBe(`${names[month - 1]} ${year}`)
  })
})

describe('a template that does not', () => {
  // "not all checklist/task would have it" — and the default is off, so an
  // untouched recipe keeps generating exactly what it generated before.
  it('stamps nothing at all', () => {
    for (const tpl of [template(), template({ periodLabelEnabled: false })]) {
      for (const checklist of run(tpl).data.checklists) {
        expect(checklist.periodLabel).toBeNull()
      }
    }
  })
})

describe('“purely a label not to change anything we have already done”', () => {
  /**
   * HER CONSTRAINT, executed. Generate the same cycle twice — once with the
   * label off, once on — and every field except `periodLabel` (and the random
   * instance id) must match. If switching this on ever moves a due date, an
   * assignee, an item, a stage or a category, this fails.
   */
  it('changes nothing else about the generated instance', () => {
    const withoutLabel = run(template()).data.checklists
    const withLabel = run(template({ periodLabelEnabled: true, periodLabelOffset: 1 })).data
      .checklists

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
