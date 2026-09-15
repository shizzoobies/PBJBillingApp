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

/**
 * Pushed occurrences (featreq-68638ed2). A push moves `dueDate` forward and
 * keeps the cycle it belongs to in `cycleDueDate`, and the DEFAULT push date is
 * exactly the next occurrence's date. The overlay dedupes on the same identity
 * the materializer uses — the CYCLE date — or a single pushed task would hide
 * the ghost of a real occurrence that has not been generated yet.
 */
describe('projectUpcomingChecklists — pushed occurrences', () => {
  // Weekly from yesterday: the cycles land on dateOffset(6), (13), (20)…
  const template = makeTemplate({
    id: 'tmpl-weekly',
    frequency: 'weekly',
    nextDueDate: dateOffset(-1),
  })

  const pushed: Checklist = {
    id: 'check-pushed',
    title: 'Recurring Task',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    templateId: 'tmpl-weekly',
    frequency: 'weekly',
    // Pushed off yesterday's cycle onto the next cycle's date — the default the
    // dialog offers.
    dueDate: dateOffset(6),
    cycleDueDate: dateOffset(-1),
    pushedAt: '2026-09-14T12:00:00.000Z',
    pushedBy: 'emp-1',
    viewerIds: [],
    editorIds: [],
    stageIndex: 0,
    items: [],
  }

  it('still projects the cycle a pushed task happens to be parked on', () => {
    const ghosts = projectUpcomingChecklists(makeData([template], [pushed]), {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(21),
    })
    // The real occurrence due that day has NOT been generated yet — the pushed
    // row answers for yesterday's cycle, not for this one.
    expect(ghosts.map((ghost) => ghost.dueDate)).toContain(dateOffset(6))
  })

  it('suppresses nothing differently for an unpushed row', () => {
    // The control: the same row with no push is genuinely the dateOffset(6)
    // occurrence, so its ghost must NOT be emitted.
    const unpushed: Checklist = { ...pushed, cycleDueDate: undefined, pushedAt: undefined }
    const ghosts = projectUpcomingChecklists(makeData([template], [unpushed]), {
      fromDateOnly: TODAY,
      horizonEndDateOnly: dateOffset(21),
    })
    expect(ghosts.map((ghost) => ghost.dueDate)).not.toContain(dateOffset(6))
  })
})

/**
 * The Board/Gantt projection has to skip exactly what the materializer skips,
 * or the ghosts promise work that will never appear. A retired client is the
 * newest way those two could drift, so it is pinned here.
 */
describe('projectUpcomingChecklists — inactive clients', () => {
  const horizon = { fromDateOnly: TODAY, horizonEndDateOnly: dateOffset(60) }

  function retire(data: AppData): AppData {
    return {
      ...data,
      clients: data.clients.map((client) => ({ ...client, lifecycleStage: 'inactive' as const })),
    }
  }

  it('projects nothing for a retired client’s template', () => {
    const data = makeData([makeTemplate({})])
    expect(projectUpcomingChecklists(data, horizon).length).toBeGreaterThan(0)
    expect(projectUpcomingChecklists(retire(data), horizon)).toEqual([])
  })

  it('still projects for every other client', () => {
    const data = makeData([
      makeTemplate({}),
      makeTemplate({ id: 'tmpl-2', clientId: 'client-2' }),
    ])
    const withRetired: AppData = {
      ...data,
      clients: [
        { ...data.clients[0], lifecycleStage: 'inactive' },
        { ...data.clients[0], id: 'client-2', name: 'Beta' },
      ],
    }
    const ghosts = projectUpcomingChecklists(withRetired, horizon)
    expect(ghosts.length).toBeGreaterThan(0)
    expect([...new Set(ghosts.map((ghost) => ghost.clientId))]).toEqual(['client-2'])
  })
})
