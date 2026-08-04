import { describe, expect, it } from 'vitest'
import {
  diagnoseRecurringChecklists,
  diagnoseTimeLogging,
  monthLabel,
  resolveTeamMember,
  summarizeRecentChanges,
} from './diagnostics.js'

// 2026-08-04 is a Tuesday; its Sun–Sat week starts 2026-08-02.
const TODAY = '2026-08-04'
const THIS_WEEK = '2026-08-02'

const baseData = (overrides = {}) => ({
  employees: [
    { id: 'emp-lisa', name: 'Lisa Hart', role: 'Bookkeeper' },
    { id: 'emp-britt', name: 'Brittany', role: 'Owner' },
  ],
  inactiveEmployees: [],
  clients: [{ id: 'client-1', name: 'Clover Farms' }],
  checklistTemplates: [],
  checklists: [],
  timeEntries: [],
  weeklySubmissions: [],
  timesheetLocks: [],
  ...overrides,
})

describe('resolveTeamMember', () => {
  it('matches by id, exact name, and partial name', () => {
    const data = baseData()
    expect(resolveTeamMember(data, 'emp-lisa').member.name).toBe('Lisa Hart')
    expect(resolveTeamMember(data, 'lisa hart').member.id).toBe('emp-lisa')
    expect(resolveTeamMember(data, 'lisa').member.id).toBe('emp-lisa')
  })

  it('returns candidates instead of guessing when a partial name is ambiguous', () => {
    const data = baseData({
      employees: [
        { id: 'emp-1', name: 'Lisa Hart', role: 'Bookkeeper' },
        { id: 'emp-2', name: 'Lisa Moore', role: 'Bookkeeper' },
      ],
    })
    const result = resolveTeamMember(data, 'lisa')
    expect(result.member).toBeNull()
    expect(result.candidates).toEqual(['Lisa Hart', 'Lisa Moore'])
  })
})

describe('diagnoseTimeLogging', () => {
  it('says nothing is blocking when the timesheet is clean', () => {
    const result = diagnoseTimeLogging(baseData(), { person: 'Lisa Hart', today: TODAY })
    expect(result.canLogTime).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.week).toBe(THIS_WEEK)
    expect(result.summary).toContain('Nothing is blocking Lisa Hart')
  })

  it('names the locked month and says only an owner can unlock it', () => {
    const data = baseData({
      timesheetLocks: [{ id: 'lock-1', userId: 'emp-lisa', period: '2026-08' }],
    })
    const result = diagnoseTimeLogging(data, { person: 'Lisa Hart', today: TODAY })
    expect(result.canLogTime).toBe(false)
    expect(result.blockers[0]).toMatchObject({ kind: 'locked-month', period: '2026-08' })
    expect(result.summary).toContain('August 2026')
    expect(result.summary).toContain('Only an owner can unlock it')
  })

  it('names an unsubmitted prior week that has logged time', () => {
    const data = baseData({
      timeEntries: [{ id: 't1', employeeId: 'emp-lisa', date: '2026-07-28' }],
    })
    const result = diagnoseTimeLogging(data, { person: 'Lisa Hart', today: TODAY })
    expect(result.canLogTime).toBe(false)
    expect(result.blockers).toEqual([
      {
        kind: 'unsubmitted-week',
        weekStart: '2026-07-26',
        fix: 'Lisa Hart submits the week of 2026-07-26 on the Timesheet page.',
      },
    ])
    expect(result.summary).toContain('2026-07-26')
  })

  it('distinguishes a REJECTED week from an unsubmitted one', () => {
    const data = baseData({
      timeEntries: [{ id: 't1', employeeId: 'emp-lisa', date: '2026-07-28' }],
      weeklySubmissions: [
        { id: 's1', userId: 'emp-lisa', weekStart: '2026-07-26', status: 'rejected' },
      ],
    })
    const result = diagnoseTimeLogging(data, { person: 'Lisa Hart', today: TODAY })
    expect(result.blockers[0].kind).toBe('rejected-week')
    expect(result.summary).toContain('sent back for changes')
  })

  it('does not treat a submitted prior week as a blocker', () => {
    const data = baseData({
      timeEntries: [{ id: 't1', employeeId: 'emp-lisa', date: '2026-07-28' }],
      weeklySubmissions: [
        { id: 's1', userId: 'emp-lisa', weekStart: '2026-07-26', status: 'submitted' },
      ],
    })
    expect(diagnoseTimeLogging(data, { person: 'Lisa Hart', today: TODAY }).canLogTime).toBe(true)
  })

  it('never gates a week inside a locked month (locking leaves no submission row)', () => {
    const data = baseData({
      timeEntries: [{ id: 't1', employeeId: 'emp-lisa', date: '2026-07-28' }],
      timesheetLocks: [{ id: 'lock-1', userId: 'emp-lisa', period: '2026-07' }],
    })
    const result = diagnoseTimeLogging(data, { person: 'Lisa Hart', today: TODAY })
    expect(result.canLogTime).toBe(true)
    expect(result.lockedMonths).toEqual(['2026-07'])
  })

  it('lists every blocking week at once, oldest first', () => {
    const data = baseData({
      timeEntries: [
        { id: 't1', employeeId: 'emp-lisa', date: '2026-07-28' },
        { id: 't2', employeeId: 'emp-lisa', date: '2026-07-21' },
      ],
    })
    const result = diagnoseTimeLogging(data, { person: 'Lisa Hart', today: TODAY })
    expect(result.blockers.map((b) => b.weekStart)).toEqual(['2026-07-19', '2026-07-26'])
    expect(result.summary).toContain('2 earlier weeks')
  })

  it('exempts owners from both gates', () => {
    const data = baseData({
      timeEntries: [{ id: 't1', employeeId: 'emp-britt', date: '2026-07-28' }],
      timesheetLocks: [{ id: 'lock-1', userId: 'emp-britt', period: '2026-08' }],
    })
    const result = diagnoseTimeLogging(data, { person: 'Brittany', today: TODAY })
    expect(result.canLogTime).toBe(true)
    expect(result.summary).toContain('owners are exempt')
  })

  it('reports a former team member rather than a gate', () => {
    const data = baseData({
      employees: [],
      inactiveEmployees: [{ id: 'emp-lisa', name: 'Lisa Hart', role: 'Bookkeeper' }],
    })
    const result = diagnoseTimeLogging(data, { person: 'Lisa Hart', today: TODAY })
    expect(result.canLogTime).toBe(false)
    expect(result.blockers[0].kind).toBe('former-member')
  })

  it('asks which person when the name is ambiguous, and says so when unknown', () => {
    const data = baseData({
      employees: [
        { id: 'emp-1', name: 'Lisa Hart', role: 'Bookkeeper' },
        { id: 'emp-2', name: 'Lisa Moore', role: 'Bookkeeper' },
      ],
    })
    expect(diagnoseTimeLogging(data, { person: 'Lisa', today: TODAY }).summary).toContain(
      'Lisa Hart and Lisa Moore',
    )
    expect(diagnoseTimeLogging(baseData(), { person: 'Nobody', today: TODAY })).toMatchObject({
      found: false,
    })
  })
})

const template = (overrides = {}) => ({
  id: 'tmpl-1',
  title: 'Monthly Bookkeeping',
  clientId: 'client-1',
  active: true,
  frequency: 'monthly',
  nextDueDate: '2026-09-01',
  categoryId: 'cat-1',
  stages: [{ id: 'stage-1', name: 'Stage 1', assigneeId: 'emp-lisa', items: [{ id: 'i1', label: 'Reconcile' }] }],
  ...overrides,
})

describe('diagnoseRecurringChecklists', () => {
  it('confirms a healthy recipe will generate', () => {
    const data = baseData({ checklistTemplates: [template()] })
    const result = diagnoseRecurringChecklists(data, { subject: 'Clover', today: TODAY })
    expect(result.templates).toHaveLength(1)
    expect(result.templates[0]).toMatchObject({
      willGenerate: true,
      missing: null,
      client: 'Clover Farms',
    })
    expect(result.summary).toContain('will generate on schedule')
  })

  it.each([
    ['no steps in the first stage', { stages: [{ id: 's', name: 'S', assigneeId: 'e', items: [] }] }, 'no-steps'],
    ['no stages at all', { stages: [] }, 'no-stages'],
    ['no client', { clientId: '' }, 'no-client'],
    ['no next due date', { nextDueDate: '' }, 'no-due-date'],
    ['switched off', { active: false }, 'inactive'],
    ['specific months with none chosen', { frequency: 'specific-months', scheduledMonths: [] }, 'no-months'],
    [
      'pinned to a past year',
      { frequency: 'specific-months', scheduledMonths: [3], repeatAnnually: false, scheduleYear: 2025 },
      'stale-year',
    ],
  ])('names the missing ingredient: %s', (_label, overrides, expected) => {
    const data = baseData({ checklistTemplates: [template(overrides)] })
    const result = diagnoseRecurringChecklists(data, { subject: 'Monthly', today: TODAY })
    expect(result.templates[0].willGenerate).toBe(false)
    expect(result.templates[0].missing).toBe(expected)
    expect(result.templates[0].problem).toBeTruthy()
    expect(result.templates[0].fix).toBeTruthy()
  })

  it('reports whether it has ever generated anything', () => {
    const data = baseData({
      checklistTemplates: [template({ stages: [{ id: 's', name: 'S', items: [] }] })],
      checklists: [{ id: 'c1', templateId: 'tmpl-1' }],
    })
    const result = diagnoseRecurringChecklists(data, { subject: 'Monthly', today: TODAY })
    expect(result.templates[0]).toMatchObject({ hasEverGenerated: true, generatedCount: 1 })
  })

  it('warns about a recipe that generates but lands on nobody', () => {
    const data = baseData({
      checklistTemplates: [
        template({ stages: [{ id: 's', name: 'S', items: [{ id: 'i1', label: 'x' }] }] }),
      ],
    })
    const result = diagnoseRecurringChecklists(data, { subject: 'Monthly', today: TODAY })
    expect(result.templates[0].willGenerate).toBe(true)
    expect(result.templates[0].warnings[0]).toContain('nobody')
  })

  it('with no subject, reports ONLY the ones that will never generate', () => {
    const data = baseData({
      checklistTemplates: [
        template(),
        template({ id: 'tmpl-2', title: 'Payroll', active: false }),
        // Standard blueprints are never scheduled, so they are not faults.
        template({ id: 'tmpl-3', title: 'Blueprint', isStandard: true, stages: [] }),
      ],
    })
    const result = diagnoseRecurringChecklists(data, { today: TODAY })
    expect(result.scope).toBe('all')
    expect(result.checked).toBe(2)
    expect(result.templates.map((t) => t.title)).toEqual(['Payroll'])
    expect(result.summary).toContain('Payroll')
  })

  it('says so plainly when everything is healthy or nothing matches', () => {
    const healthy = baseData({ checklistTemplates: [template()] })
    expect(diagnoseRecurringChecklists(healthy, { today: TODAY }).summary).toContain(
      'nothing is silently stuck',
    )
    expect(diagnoseRecurringChecklists(healthy, { subject: 'Nope', today: TODAY })).toMatchObject({
      checked: 0,
    })
  })
})

describe('summarizeRecentChanges', () => {
  const NOW = '2026-08-04T12:00:00.000Z'
  const entries = [
    { id: 'a1', userId: 'emp-britt', action: 'timesheet_locked', target: 'Lisa Hart 2026-07', timestamp: '2026-08-03T10:00:00.000Z' },
    { id: 'a2', userId: 'emp-lisa', action: 'checklist_created', target: 'Clover Farms — Monthly', timestamp: '2026-08-01T09:00:00.000Z' },
    { id: 'a3', userId: 'emp-britt', action: 'client_created', target: 'Old Co', timestamp: '2026-06-01T09:00:00.000Z' },
  ]
  const nameById = { 'emp-britt': 'Brittany', 'emp-lisa': 'Lisa Hart' }

  it('keeps only the window, newest first, in plain English', () => {
    const result = summarizeRecentChanges(entries, { days: 7, now: NOW, nameById })
    expect(result.count).toBe(2)
    expect(result.changes[0]).toMatchObject({
      who: 'Brittany',
      what: 'locked a timesheet month',
      detail: 'Lisa Hart 2026-07',
    })
    expect(result.summary).toBe('2 changes in the last 7 days.')
  })

  it('filters on a subject across actor, action, and target', () => {
    expect(summarizeRecentChanges(entries, { subject: 'Clover', days: 7, now: NOW, nameById }).count).toBe(1)
    expect(summarizeRecentChanges(entries, { subject: 'Brittany', days: 7, now: NOW, nameById }).count).toBe(1)
    expect(summarizeRecentChanges(entries, { subject: 'timesheet', days: 7, now: NOW, nameById }).count).toBe(1)
  })

  it('honors a wider window and says when nothing changed', () => {
    expect(summarizeRecentChanges(entries, { days: 90, now: NOW, nameById }).count).toBe(3)
    expect(summarizeRecentChanges([], { days: 7, now: NOW }).summary).toBe(
      'Nothing changed in the last 7 days.',
    )
  })

  it('humanizes an assistant action and falls back for unmapped codes', () => {
    const rows = [
      { id: 'x', userId: 'emp-britt', action: 'assistant_action:assign_client', target: '', timestamp: '2026-08-03T11:00:00.000Z' },
      { id: 'y', userId: 'emp-britt', action: 'sales_tax_recorded', target: '', timestamp: '2026-08-03T10:00:00.000Z' },
    ]
    const result = summarizeRecentChanges(rows, { days: 7, now: NOW, nameById })
    expect(result.changes.map((c) => c.what)).toEqual([
      'ran an assistant action (assign client)',
      'sales tax recorded',
    ])
  })
})

describe('monthLabel', () => {
  it('reads a period the way a person says it', () => {
    expect(monthLabel('2026-06')).toBe('June 2026')
    expect(monthLabel('nonsense')).toBe('nonsense')
  })
})
