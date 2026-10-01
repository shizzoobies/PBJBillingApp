/**
 * The server materializer on the firm's clock.
 *
 * Production runs in UTC and the firm works in US Eastern. The materializer
 * used to take "today" from the UTC date and the year and month from the
 * host's local getters, so on Railway from 8 pm Eastern it already believed it
 * was tomorrow: the next month's occurrence spawned hours early, a
 * specific-months occurrence due today was born finished, and a recipe set up
 * that evening was dated to the next day — on the last evening of a month that
 * put the month it was created in below its own floor.
 *
 * It now takes ONE date, the firm's (America/New_York unless FIRM_TIME_ZONE
 * says otherwise), and every comparison is made against it. Each case below
 * runs under a UTC host and an Eastern host and must come out the same.
 */
// @ts-expect-error - plain-JS module without type declarations
import { materializeRecurringChecklists } from '../../db/store.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureRecurringChecklists } from '../lib/utils'
import type { AppData } from '../lib/types'

// 2026-09-30 21:00 Eastern (EDT, UTC-4).
const NINE_PM_EASTERN_SEP_30 = new Date('2026-10-01T01:00:00.000Z')

type Step = { done: boolean; subItems?: Step[] }
type Instance = { templateId?: string; dueDate: string; items: Step[] }
type Result = {
  changed: boolean
  data: { checklists: Instance[]; checklistTemplates: Array<{ id: string; nextDueDate: string }> }
}

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    title: 'Month-end close',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    frequency: 'specific-months',
    nextDueDate: '',
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
    ...overrides,
  }
}

function makeData(templates: unknown[]) {
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
    checklistTemplates: structuredClone(templates),
    checklists: [],
    recycledChecklists: [],
    timesheetLocks: [],
    weeklySubmissions: [],
    reimbursements: [],
    recurringReimbursements: [],
    inactiveEmployees: [],
  }
}

const allDone = (step: Step, expected: boolean): boolean =>
  step.done === expected && (step.subItems ?? []).every((sub) => allDone(sub, expected))

/**
 * What a run produced, minus the random ids: per instance its template, due
 * date and whether it was born open or finished, plus where each template's
 * cycle now stands. Two runs that agree on this agree on everything that is
 * persisted or shown.
 */
function outcome(result: Result) {
  return {
    instances: result.data.checklists
      .map((checklist) => ({
        templateId: checklist.templateId,
        dueDate: checklist.dueDate,
        state: checklist.items.every((item) => allDone(item, true))
          ? 'done'
          : checklist.items.every((item) => allDone(item, false))
            ? 'open'
            : 'mixed',
      }))
      .sort((a, b) => `${a.templateId}:${a.dueDate}`.localeCompare(`${b.templateId}:${b.dueDate}`)),
    cycles: result.data.checklistTemplates.map((template) => [template.id, template.nextDueDate]),
  }
}

// One workspace that exercises every date comparison the materializer makes.
const everyBranch = () =>
  makeData([
    // September is the current month, October has not started.
    makeTemplate({ id: 'tpl-sep-oct', scheduledMonths: [9, 10] }),
    // A recipe set up this very evening.
    makeTemplate({
      id: 'tpl-new-tonight',
      scheduledMonths: [8, 9, 10],
      createdAt: NINE_PM_EASTERN_SEP_30.toISOString(),
    }),
    // A weekly recipe set up this evening carrying a stale cycle date.
    makeTemplate({
      id: 'tpl-weekly-tonight',
      frequency: 'weekly',
      nextDueDate: '2026-09-16',
      createdAt: NINE_PM_EASTERN_SEP_30.toISOString(),
    }),
    // A monthly recipe with lead time, due tomorrow and next month.
    makeTemplate({ id: 'tpl-lead', frequency: 'monthly', nextDueDate: '2026-10-01', leadDays: 1 }),
    // A daily recipe due today.
    makeTemplate({ id: 'tpl-daily', frequency: 'daily', nextDueDate: '2026-09-30' }),
  ])

const HOST_ZONES = ['UTC', 'America/New_York'] as const
const savedTz = process.env.TZ
// Deleting TZ does not put a process back on its own zone, so the restores
// below name the zone the host started in.
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const savedFirmZone = process.env.FIRM_TIME_ZONE

describe.each(HOST_ZONES)('materializeRecurringChecklists at 9 pm Eastern on September 30th — host zone %s', (hostZone) => {
  beforeAll(() => {
    process.env.TZ = hostZone
    delete process.env.FIRM_TIME_ZONE
  })
  afterAll(() => {
    process.env.TZ = savedTz ?? hostZone
    if (savedFirmZone === undefined) delete process.env.FIRM_TIME_ZONE
    else process.env.FIRM_TIME_ZONE = savedFirmZone
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NINE_PM_EASTERN_SEP_30)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is the instant where a UTC day and the firm day disagree', () => {
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-01')
  })

  it('still treats it as September: September generates, October does not', () => {
    const result: Result = materializeRecurringChecklists(
      makeData([makeTemplate({ scheduledMonths: [9, 10] })]),
    )
    expect(outcome(result).instances).toEqual([
      // Due today, so it is OPEN — not born finished because UTC says tomorrow.
      { templateId: 'tpl-1', dueDate: '2026-09-30', state: 'open' },
    ])
  })

  it('gives a specific-months recipe created that evening its September occurrence', () => {
    const result: Result = materializeRecurringChecklists(
      makeData([
        makeTemplate({
          scheduledMonths: [8, 9, 10],
          createdAt: NINE_PM_EASTERN_SEP_30.toISOString(),
        }),
      ]),
    )
    // August ended before the recipe existed; October has not started.
    expect(outcome(result).instances).toEqual([
      { templateId: 'tpl-1', dueDate: '2026-09-30', state: 'open' },
    ])
  })

  it('starts a weekly recipe created that evening on its cycle today, not next week', () => {
    // 2026-09-16 and -23 are two cycles of history the recipe does not own; the
    // floor is the day it was set up, September 30th, which is a cycle date.
    const result: Result = materializeRecurringChecklists(
      makeData([
        makeTemplate({
          frequency: 'weekly',
          nextDueDate: '2026-09-16',
          createdAt: NINE_PM_EASTERN_SEP_30.toISOString(),
        }),
      ]),
    )
    expect(outcome(result)).toEqual({
      instances: [{ templateId: 'tpl-1', dueDate: '2026-09-30', state: 'open' }],
      cycles: [['tpl-1', '2026-10-07']],
    })
  })

  it('measures lead time from the firm day', () => {
    const result: Result = materializeRecurringChecklists(
      makeData([
        makeTemplate({ id: 'tpl-lead-1', frequency: 'monthly', nextDueDate: '2026-10-01', leadDays: 1 }),
        makeTemplate({ id: 'tpl-lead-2', frequency: 'monthly', nextDueDate: '2026-10-02', leadDays: 1 }),
      ]),
    )
    // One day of lead from September 30th reaches October 1st and no further.
    expect(outcome(result).instances).toEqual([
      { templateId: 'tpl-lead-1', dueDate: '2026-10-01', state: 'open' },
    ])
  })

  it('takes an explicit today over the clock', () => {
    const data = () => makeData([makeTemplate({ scheduledMonths: [9, 10] })])
    const october: Result = materializeRecurringChecklists(data(), { today: '2026-10-01' })
    expect(outcome(october).instances).toEqual([
      { templateId: 'tpl-1', dueDate: '2026-09-30', state: 'done' },
      { templateId: 'tpl-1', dueDate: '2026-10-31', state: 'open' },
    ])
    const august: Result = materializeRecurringChecklists(data(), { today: '2026-08-31' })
    expect(august.changed).toBe(false)
  })

  it('ignores a today that is not a date and falls back to the firm day', () => {
    const result: Result = materializeRecurringChecklists(
      makeData([makeTemplate({ scheduledMonths: [9, 10] })]),
      { today: 'tomorrow' },
    )
    expect(outcome(result).instances).toEqual([
      { templateId: 'tpl-1', dueDate: '2026-09-30', state: 'open' },
    ])
  })

  it('rolls into October at Eastern midnight', () => {
    vi.setSystemTime(new Date('2026-10-01T04:00:00.000Z'))
    const result: Result = materializeRecurringChecklists(
      makeData([makeTemplate({ scheduledMonths: [9, 10] })]),
    )
    expect(outcome(result).instances).toEqual([
      { templateId: 'tpl-1', dueDate: '2026-09-30', state: 'done' },
      { templateId: 'tpl-1', dueDate: '2026-10-31', state: 'open' },
    ])
  })

  it('agrees with the browser spawner given the same day', () => {
    // The browser passes its own local date; in the east that is the firm day.
    // Whatever one of them spawns the other must regard as already there.
    const server: Result = materializeRecurringChecklists(everyBranch())
    const browser = ensureRecurringChecklists(
      everyBranch() as unknown as AppData,
      '2026-09-30',
    ) as unknown as Result
    expect(outcome(browser)).toEqual(outcome(server))
    // And each is a fixed point of the other: nothing left to add.
    const serverAfterBrowser: Result = materializeRecurringChecklists(browser.data)
    expect(serverAfterBrowser.changed).toBe(false)
    const browserAfterServer = ensureRecurringChecklists(
      server.data as unknown as AppData,
      '2026-09-30',
    ) as unknown as Result
    expect(outcome(browserAfterServer)).toEqual(outcome(server))
  })
})

describe('materializeRecurringChecklists — one instant, any host zone', () => {
  afterEach(() => {
    vi.useRealTimers()
    process.env.TZ = savedTz ?? hostZone
    if (savedFirmZone === undefined) delete process.env.FIRM_TIME_ZONE
    else process.env.FIRM_TIME_ZONE = savedFirmZone
  })

  const runUnder = (hostZone: string, instant: Date) => {
    process.env.TZ = hostZone
    vi.useFakeTimers()
    vi.setSystemTime(instant)
    const result: Result = materializeRecurringChecklists(everyBranch())
    vi.useRealTimers()
    return outcome(result)
  }

  it.each([
    ['9 pm Eastern on the last day of the month', NINE_PM_EASTERN_SEP_30],
    ['Eastern midnight', new Date('2026-10-01T04:00:00.000Z')],
    ['an ordinary afternoon', new Date('2026-09-15T18:00:00.000Z')],
    ['9 pm Eastern on New Year’s Eve', new Date('2027-01-01T02:00:00.000Z')],
  ])('produces identical output under TZ=UTC and TZ=America/New_York: %s', (_label, instant) => {
    delete process.env.FIRM_TIME_ZONE
    const utc = runUnder('UTC', instant)
    const eastern = runUnder('America/New_York', instant)
    expect(utc).toEqual(eastern)
    expect(utc.instances.length).toBeGreaterThan(0)
  })

  it('pins what the evening run produces, so "identical" cannot mean identically wrong', () => {
    delete process.env.FIRM_TIME_ZONE
    expect(runUnder('UTC', NINE_PM_EASTERN_SEP_30)).toEqual({
      instances: [
        { templateId: 'tpl-daily', dueDate: '2026-09-30', state: 'open' },
        { templateId: 'tpl-lead', dueDate: '2026-10-01', state: 'open' },
        { templateId: 'tpl-new-tonight', dueDate: '2026-09-30', state: 'open' },
        { templateId: 'tpl-sep-oct', dueDate: '2026-09-30', state: 'open' },
        { templateId: 'tpl-weekly-tonight', dueDate: '2026-09-30', state: 'open' },
      ],
      cycles: [
        ['tpl-sep-oct', ''],
        ['tpl-new-tonight', ''],
        ['tpl-weekly-tonight', '2026-10-07'],
        ['tpl-lead', '2026-11-01'],
        ['tpl-daily', '2026-10-01'],
      ],
    })
  })

  it('follows FIRM_TIME_ZONE when the firm is somewhere else', () => {
    // 04:30Z on October 1st is past midnight in New York and 11:30 pm on
    // September 30th in Chicago.
    const instant = new Date('2026-10-01T04:30:00.000Z')
    delete process.env.FIRM_TIME_ZONE
    const eastern = runUnder('UTC', instant)
    process.env.FIRM_TIME_ZONE = 'America/Chicago'
    const central = runUnder('UTC', instant)
    const sepOct = (run: ReturnType<typeof outcome>) =>
      run.instances.filter((instance) => instance.templateId === 'tpl-sep-oct')
    expect(sepOct(eastern)).toEqual([
      { templateId: 'tpl-sep-oct', dueDate: '2026-09-30', state: 'done' },
      { templateId: 'tpl-sep-oct', dueDate: '2026-10-31', state: 'open' },
    ])
    expect(sepOct(central)).toEqual([
      { templateId: 'tpl-sep-oct', dueDate: '2026-09-30', state: 'open' },
    ])
  })
})
