/**
 * MONTH-END CADENCE: a recipe due on the 29th-31st must stay in its own month.
 *
 * `addMonths` used to be `new Date(y, m - 1 + n, d)`, which OVERFLOWS when the
 * target month is shorter: 2027-01-31 + 3 months was "April 31" = May 1, and a
 * quarterly recipe ran May / Aug / Nov / Feb from then on. Production had 28
 * active quarterly recipes due 2027-01-31 and five monthly ones on 2026-11-30
 * when this was found (2026-10-26), and two "Monthly Review" recipes had
 * already slid onto the 1st of the month.
 *
 * The rule now (both copies): keep the day of the month, clamped to the target
 * month's length, and a date that IS the last day of its month goes to the last
 * day of the target month. The step never leaves the target month.
 *
 * `addMonths` exists twice - db/store.js (the server materializer) and
 * src/lib/utils.ts (the browser's) - and the two must agree to the day, so the
 * grid at the bottom runs both over three years of dates.
 */
import { describe, expect, it } from 'vitest'

import {
  addMonths as serverAddMonths,
  advanceChecklistFrequency as serverAdvance,
  materializeRecurringChecklists,
} from './store.js'
import {
  addMonths as browserAddMonths,
  advanceChecklistFrequency as browserAdvance,
  ensureRecurringChecklists,
} from '../src/lib/utils.ts'

const COPIES = [
  ['server (db/store.js)', serverAddMonths, serverAdvance],
  ['browser (src/lib/utils.ts)', browserAddMonths, browserAdvance],
]

/** Step `start` by `months` `count` times and return every date visited. */
function walk(addMonths, start, months, count) {
  const dates = [start]
  for (let i = 0; i < count; i += 1) dates.push(addMonths(dates[dates.length - 1], months))
  return dates
}

/** Every calendar day from `from` to `to`, inclusive, as YYYY-MM-DD. */
function everyDay(from, to) {
  const days = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

describe.each(COPIES)('addMonths keeps a month-end recipe in its month - %s', (_name, addMonths, advance) => {
  it('walks a quarterly January 31st through April 30th, July 31st and October 31st', () => {
    expect(walk(addMonths, '2027-01-31', 3, 4)).toEqual([
      '2027-01-31',
      '2027-04-30',
      '2027-07-31',
      '2027-10-31',
      '2028-01-31',
    ])
  })

  it('walks a monthly November 30th along the month ends, February included', () => {
    expect(walk(addMonths, '2026-11-30', 1, 4)).toEqual([
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ])
  })

  it('keeps a quarterly January 30th in January, April, July and October', () => {
    // April 30th is the last day of April, so from there the recipe follows
    // the month ends: the date alone cannot say whether it began on the 30th
    // or the 31st. What matters - the month - never changes.
    expect(walk(addMonths, '2027-01-30', 3, 4)).toEqual([
      '2027-01-30',
      '2027-04-30',
      '2027-07-31',
      '2027-10-31',
      '2028-01-31',
    ])
  })

  it('moves a monthly 28th to the month ends once it lands on February 28th (the chosen trade-off)', () => {
    // THE TRADE-OFF, decided 2026-10-26: addMonths sees only the date, and a
    // February 28th in a non-leap year is the last day of February, so it
    // cannot tell "the 28th" from "month-end". It takes month-end, so a
    // recipe on the 28th runs on month ends from March on. The month never
    // changes; keeping the exact 28th would need a stored anchor day on the
    // recipe (a schema change, left as a follow-up).
    expect(walk(addMonths, '2027-01-28', 1, 3)).toEqual([
      '2027-01-28',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ])
    // In a leap year February 28th is not the month end, so the 28th holds.
    expect(walk(addMonths, '2028-01-28', 1, 2)).toEqual(['2028-01-28', '2028-02-28', '2028-03-28'])
  })

  it('clamps a 29th or 30th that is not a month end, and keeps it where it fits', () => {
    expect(addMonths('2027-01-29', 1)).toBe('2027-02-28')
    expect(addMonths('2027-01-30', 1)).toBe('2027-02-28')
    expect(addMonths('2027-03-30', 1)).toBe('2027-04-30')
    expect(addMonths('2027-03-29', 1)).toBe('2027-04-29')
    expect(addMonths('2027-05-30', 3)).toBe('2027-08-30')
  })

  it('handles February 29th in a leap year', () => {
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2028-01-29', 1)).toBe('2028-02-29')
    // February 29th is the last day of its month.
    expect(addMonths('2028-02-29', 1)).toBe('2028-03-31')
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28')
    // In a leap year February 28th is NOT the month end, so it stays the 28th.
    expect(addMonths('2028-02-28', 1)).toBe('2028-03-28')
    expect(addMonths('2027-02-28', 12)).toBe('2028-02-29')
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29')
  })

  it('steps twelve months to the same day, and crosses a year end', () => {
    expect(addMonths('2027-01-31', 12)).toBe('2028-01-31')
    expect(addMonths('2026-06-15', 12)).toBe('2027-06-15')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31')
    expect(addMonths('2026-10-31', 3)).toBe('2027-01-31')
  })

  it('leaves an ordinary mid-month date alone', () => {
    expect(addMonths('2026-10-15', 1)).toBe('2026-11-15')
    expect(addMonths('2026-10-01', 3)).toBe('2027-01-01')
    expect(addMonths('2026-10-28', 4)).toBe('2027-02-28')
  })

  it('only changes the month steps: daily, weekly and every-two-weeks count days', () => {
    expect(advance('2027-01-31', 'daily')).toBe('2027-02-01')
    expect(advance('2027-01-31', 'weekly')).toBe('2027-02-07')
    expect(advance('2027-01-31', 'biweekly')).toBe('2027-02-14')
    expect(advance('2027-01-31', 'monthly')).toBe('2027-02-28')
    expect(advance('2027-01-31', 'quarterly')).toBe('2027-04-30')
    expect(advance('2027-01-31', 'annually')).toBe('2028-01-31')
  })

  it('never produces a date outside the target month', () => {
    for (const day of everyDay('2026-01-01', '2028-12-31')) {
      const [year, month] = day.split('-').map(Number)
      for (const months of [1, 3, 12]) {
        const index = year * 12 + (month - 1) + months
        const expectedMonth = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
        expect(addMonths(day, months).slice(0, 7), `${day} + ${months}`).toBe(expectedMonth)
      }
    }
  })
})

describe('the server and browser cadence steps agree to the day', () => {
  it('addMonths: every day of 2026-2028 stepped 1, 3 and 12 months', () => {
    const mismatches = []
    for (const day of everyDay('2026-01-01', '2028-12-31')) {
      for (const months of [1, 3, 12]) {
        const server = serverAddMonths(day, months)
        const browser = browserAddMonths(day, months)
        if (server !== browser) mismatches.push(`${day} + ${months}: server ${server}, browser ${browser}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('advanceChecklistFrequency: every day of 2026-2028 at every cadence', () => {
    const mismatches = []
    for (const day of everyDay('2026-01-01', '2028-12-31')) {
      for (const frequency of ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annually']) {
        const server = serverAdvance(day, frequency)
        const browser = browserAdvance(day, frequency)
        if (server !== browser) mismatches.push(`${day} ${frequency}: server ${server}, browser ${browser}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

/**
 * Both materializers, pure (no store): a quarterly recipe whose Next due is
 * 2027-01-31 generates its April occurrence in April, not May.
 */
describe('both materializers keep a January 31st quarterly recipe on January / April / July', () => {
  const quarterly = () => ({
    id: 'tpl-q-eom',
    title: 'Quarterly payroll filings',
    clientId: 'c1',
    assigneeId: 'emp-1',
    frequency: 'quarterly',
    nextDueDate: '2027-01-31',
    leadDays: 30,
    active: true,
    isStandard: false,
    createdAt: '2026-12-01T15:00:00.000Z',
    viewerIds: [],
    editorIds: [],
    stages: [
      {
        id: 'stage-q-1',
        name: 'Prepare',
        assigneeId: 'emp-1',
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: [{ id: 'item-q-1', label: 'File the returns' }],
      },
    ],
  })
  const data = () => ({ checklistTemplates: [quarterly()], checklists: [], clients: [{ id: 'c1', name: 'Acme' }] })

  const run = {
    server: (today) => materializeRecurringChecklists(data(), { today }).data,
    browser: (today) => ensureRecurringChecklists(data(), today).data,
  }

  describe.each(Object.keys(run))('%s', (side) => {
    it('on April 2nd, 30 days ahead: January and April occurrences, nothing in May', () => {
      const out = run[side]('2027-04-02')
      const dues = out.checklists.filter((c) => c.templateId === 'tpl-q-eom').map((c) => c.dueDate).sort()
      expect(dues).toEqual(['2027-01-31', '2027-04-30'])
      expect(out.checklistTemplates.find((t) => t.id === 'tpl-q-eom').nextDueDate).toBe('2027-07-31')
    })

    it('in February, before April is in reach: Next due is April 30th', () => {
      const out = run[side]('2027-02-15')
      const dues = out.checklists.filter((c) => c.templateId === 'tpl-q-eom').map((c) => c.dueDate)
      expect(dues).toEqual(['2027-01-31'])
      expect(out.checklistTemplates.find((t) => t.id === 'tpl-q-eom').nextDueDate).toBe('2027-04-30')
    })
  })
})
