import { describe, expect, it } from 'vitest'
import { projectUpcomingChecklists } from '../lib/projectRecurring'
import { dateOffset } from '../lib/utils'
import type { AppData, Checklist, ChecklistTemplate } from '../lib/types'

/**
 * `projectUpcomingChecklists` is PURE — it takes `fromDateOnly` explicitly (it
 * never reads the clock). To stay deterministic regardless of when the suite
 * runs, dates are still expressed relative to the real today via `dateOffset`,
 * and `fromDateOnly` is passed the same "today" the app would.
 */

const TODAY = dateOffset(0)

function makeTemplate(overrides: Partial<ChecklistTemplate>): ChecklistTemplate {
  return {
    id: 'tmpl-1',
    title: 'Recurring Task',
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
        items: [{ id: 'ti-1', label: 'Do the work' }],
      },
    ],
    ...overrides,
  }
}

function makeData(
  templates: ChecklistTemplate[],
  checklists: Checklist[] = [],
): AppData {
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
    checklistTemplates: templates,
    checklists,
    recycledChecklists: [],
    timesheetLocks: [],
    weeklySubmissions: [],
    reimbursements: [],
    recurringReimbursements: [],
    inactiveEmployees: [],
  }
}

describe('projectUpcomingChecklists', () => {
  it('returns [] when there are no templates', () => {
    const ghosts = projectUpcomingChecklists(makeData([]), {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(365),
    })
    expect(ghosts).toEqual([])
  })

  it('projects multiple future ghosts for weekly + monthly templates within a horizon', () => {
    const data = makeData([
      makeTemplate({ id: 'tmpl-weekly', frequency: 'weekly', nextDueDate: dateOffset(-1) }),
      makeTemplate({ id: 'tmpl-monthly', frequency: 'monthly', nextDueDate: dateOffset(-1) }),
    ])
    const ghosts = projectUpcomingChecklists(data, {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(120),
    })

    const weekly = ghosts.filter((g) => g.templateId === 'tmpl-weekly')
    const monthly = ghosts.filter((g) => g.templateId === 'tmpl-monthly')
    expect(weekly.length).toBeGreaterThan(1)
    expect(monthly.length).toBeGreaterThan(1)

    // All ghosts are flagged projected, have future due dates, all items open,
    // and the stable `projected:<templateId>:<dueDate>` id convention.
    for (const ghost of ghosts) {
      expect(ghost.projected).toBe(true)
      expect(ghost.dueDate > TODAY).toBe(true)
      expect(ghost.items.length).toBeGreaterThan(0)
      expect(ghost.items.every((item) => item.done === false)).toBe(true)
      expect(ghost.id).toBe(`projected:${ghost.templateId}:${ghost.dueDate}`)
    }
  })

  it('walks weekly ghosts in 7-day steps', () => {
    const data = makeData([
      makeTemplate({ id: 'tmpl-weekly', frequency: 'weekly', nextDueDate: dateOffset(-1) }),
    ])
    const ghosts = projectUpcomingChecklists(data, {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(60),
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate))

    expect(ghosts.length).toBeGreaterThanOrEqual(2)
    const first = new Date(`${ghosts[0].dueDate}T12:00:00`).getTime()
    const second = new Date(`${ghosts[1].dueDate}T12:00:00`).getTime()
    const dayGap = Math.round((second - first) / (1000 * 60 * 60 * 24))
    expect(dayGap).toBe(7)
  })

  it('does NOT project a due date that already exists as a real checklist', () => {
    // Real instance already materialized for the first future weekly occurrence.
    const realDue = dateOffset(6)
    const realChecklist: Checklist = {
      id: 'real-1',
      templateId: 'tmpl-weekly',
      title: 'Recurring Task',
      clientId: 'client-1',
      assigneeId: 'emp-1',
      dueDate: realDue,
      viewerIds: [],
      editorIds: [],
      items: [{ id: 'i-1', label: 'Do the work', done: false }],
      stageIndex: 0,
      stageCount: 1,
    }
    const data = makeData(
      [makeTemplate({ id: 'tmpl-weekly', frequency: 'weekly', nextDueDate: realDue })],
      [realChecklist],
    )
    const ghosts = projectUpcomingChecklists(data, {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(60),
    })

    // The occurrence that already exists must NOT be re-projected.
    expect(ghosts.some((g) => g.dueDate === realDue)).toBe(false)
    // Later occurrences (no real instance yet) are still projected.
    expect(ghosts.length).toBeGreaterThan(0)
  })

  it('projects nothing for inactive, standard, or empty-stage-1 templates', () => {
    const data = makeData([
      makeTemplate({ id: 'tmpl-inactive', active: false, nextDueDate: dateOffset(-1) }),
      makeTemplate({ id: 'tmpl-standard', isStandard: true, nextDueDate: dateOffset(-1) }),
      makeTemplate({
        id: 'tmpl-empty',
        nextDueDate: dateOffset(-1),
        stages: [
          {
            id: 'stage-empty',
            name: 'Stage 1',
            assigneeId: 'emp-1',
            offsetDays: 0,
            viewerIds: [],
            editorIds: [],
            items: [],
          },
        ],
      }),
    ])
    const ghosts = projectUpcomingChecklists(data, {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(365),
    })
    expect(ghosts).toEqual([])
  })

  it('caps the number of ghosts per template with maxPerTemplate', () => {
    const data = makeData([
      makeTemplate({ id: 'tmpl-weekly', frequency: 'weekly', nextDueDate: dateOffset(-1) }),
    ])
    const ghosts = projectUpcomingChecklists(data, {
      fromDateOnly: TODAY,
      // A full year would otherwise yield ~52 weekly ghosts.
      horizonEndDateOnly: dateOffset(365),
      maxPerTemplate: 3,
    })
    expect(ghosts.filter((g) => g.templateId === 'tmpl-weekly')).toHaveLength(3)
  })

  it('defaults to 6 ghosts per template when maxPerTemplate is omitted', () => {
    const data = makeData([
      makeTemplate({ id: 'tmpl-weekly', frequency: 'weekly', nextDueDate: dateOffset(-1) }),
    ])
    const ghosts = projectUpcomingChecklists(data, {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(365),
    })
    expect(ghosts.filter((g) => g.templateId === 'tmpl-weekly')).toHaveLength(6)
  })
})
