import { describe, expect, it } from 'vitest'
import {
  PLAN_CADENCES,
  bundlingPlan,
  cadenceFromPlanName,
  cadenceSchedule,
  effectivePlanCadence,
  normalizePlanCadence,
  planCadenceLabel,
  preservedPlanCadence,
  scheduleDiffers,
} from './plan-cadence.js'

/**
 * How often a plan's checklists run (featreq-acdd0c84, stage B1). Nothing is
 * written to old plans, so the name's suffix has to be read the way Brittany
 * types it - trailing spaces, any case, "Yearly" for annual.
 */
describe('cadenceFromPlanName', () => {
  it.each([
    ['Client Meeting - Quarterly', 'quarterly'],
    ['Review and Prepare Reports - Quarterly ', 'quarterly'],
    ['Bookkeeping - Weekly', 'weekly'],
    ['Reconciliations with Review - Monthly', 'monthly'],
    ['Taxes - Annual', 'annual'],
    ['Taxes - Yearly', 'annual'],
    ['Taxes - YEARLY', 'annual'],
    ['Review and Prepare Reports - Annually', 'annual'],
    ['Review and Prepare Reports - annually ', 'annual'],
    ['Client Meeting - Monthlly', null],
    ['Payroll - bi-weekly', null],
    ['client meeting - quarterly', 'quarterly'],
    ['Client Meeting -  Quarterly', 'quarterly'],
    ['Client Meeting \u2013 Quarterly', 'quarterly'],
    ['Client Meeting \u2014 Weekly', 'weekly'],
    ['Pre\u2013Weekly', null],
    ['Bookkeeping', null],
    ['Monthly Reconciliations', null],
    ['Pre-Weekly', null],
    ['Client Meeting - Quarterly Review', null],
    ['Client Meeting - Biweekly', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
  ])('%j reads as %j', (name, expected) => {
    expect(cadenceFromPlanName(name)).toBe(expected)
  })
})

describe('effectivePlanCadence', () => {
  it('stored wins over the name', () => {
    expect(effectivePlanCadence({ name: 'Client Meeting - Quarterly', cadence: 'weekly' })).toBe('weekly')
    expect(effectivePlanCadence({ name: 'Client Meeting - Quarterly', cadence: 'blueprint' })).toBe('blueprint')
  })

  it('null or junk falls through to the name, then to blueprint', () => {
    expect(effectivePlanCadence({ name: 'Client Meeting - Quarterly', cadence: null })).toBe('quarterly')
    expect(effectivePlanCadence({ name: 'Client Meeting - Quarterly', cadence: 'fortnightly' })).toBe('quarterly')
    expect(effectivePlanCadence({ name: 'Bookkeeping' })).toBe('blueprint')
    expect(effectivePlanCadence(null)).toBe('blueprint')
  })
})

describe('normalizePlanCadence', () => {
  it('accepts exactly the five values', () => {
    expect(PLAN_CADENCES).toEqual(['weekly', 'monthly', 'quarterly', 'annual', 'blueprint'])
    for (const value of PLAN_CADENCES) expect(normalizePlanCadence(value)).toBe(value)
    for (const value of ['Weekly', 'yearly', '', null, undefined, 3, {}]) {
      expect(normalizePlanCadence(value)).toBeNull()
    }
  })
})

describe('preservedPlanCadence (the bulk-save rule)', () => {
  it('a valid payload value sets it', () => {
    expect(preservedPlanCadence({ cadence: 'weekly' }, 'quarterly')).toBe('weekly')
    expect(preservedPlanCadence({ cadence: 'blueprint' }, null)).toBe('blueprint')
  })

  it('omitted, null and invalid all keep the stored value', () => {
    expect(preservedPlanCadence({}, 'quarterly')).toBe('quarterly')
    expect(preservedPlanCadence({ cadence: null }, 'quarterly')).toBe('quarterly')
    expect(preservedPlanCadence({ cadence: 'fortnightly' }, 'quarterly')).toBe('quarterly')
  })

  it('nothing valid on either side is null', () => {
    expect(preservedPlanCadence({}, undefined)).toBeNull()
    expect(preservedPlanCadence({ cadence: 'x' }, 'also-bad')).toBeNull()
  })
})

/**
 * Stage B2: what a NEW client copy of a plan's checklist carries. Quarterly runs
 * January / April / July / October (Brittany); yearly runs in the blueprint's own
 * month, else January. Both are specific-months on purpose - a stale blueprint
 * `nextDueDate` walked by 'quarterly' would land in the wrong months.
 */
describe('cadenceSchedule', () => {
  const TODAY = '2026-10-13'
  const monthly = (over = {}) => ({ frequency: 'monthly', nextDueDate: '2026-01-15', ...over })

  it("'blueprint', null and junk copy as today (null)", () => {
    expect(cadenceSchedule('blueprint', monthly(), TODAY)).toBeNull()
    expect(cadenceSchedule(null, monthly(), TODAY)).toBeNull()
    expect(cadenceSchedule('fortnightly', monthly(), TODAY)).toBeNull()
  })

  it('weekly and monthly set only the frequency', () => {
    expect(cadenceSchedule('weekly', monthly(), TODAY)).toEqual({ frequency: 'weekly' })
    expect(cadenceSchedule('monthly', { frequency: 'specific-months', scheduledMonths: [3] }, TODAY)).toEqual({
      frequency: 'monthly',
    })
  })

  it('quarterly is specific-months Jan/Apr/Jul/Oct, keeping the next-due day when the blueprint had no due day', () => {
    expect(cadenceSchedule('quarterly', monthly(), TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      dueDayOfMonth: 15,
      nextDueDate: '2026-10-15',
    })
  })

  it("quarterly keeps a blueprint's own due day (the copy carries it) and floors to the next designated month", () => {
    expect(cadenceSchedule('quarterly', monthly({ dueDayOfMonth: 5 }), TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: '2027-01-05',
    })
  })

  it('a specific-months blueprint keeps its per-month and shared days; no next-due day is invented', () => {
    const blueprint = {
      frequency: 'specific-months',
      scheduledMonths: [3, 6, 9, 12],
      dueDayOfMonth: 20,
      monthlyDueDays: { 10: 25 },
      nextDueDate: '2026-06-01',
    }
    expect(cadenceSchedule('quarterly', blueprint, TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: '2026-10-25',
    })
    // No day anywhere: the materializer's last-day-of-month rule.
    expect(cadenceSchedule('quarterly', { frequency: 'specific-months', scheduledMonths: [2] }, TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: '2026-10-31',
    })
  })

  it("annual runs in a specific-months blueprint's FIRST month", () => {
    const blueprint = { frequency: 'specific-months', scheduledMonths: [6, 3], dueDayOfMonth: 15 }
    expect(cadenceSchedule('annual', blueprint, TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [3],
      nextDueDate: '2027-03-15',
    })
  })

  it("annual otherwise runs in the month of the blueprint's next due date", () => {
    expect(cadenceSchedule('annual', monthly({ nextDueDate: '2026-05-31' }), TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [5],
      dueDayOfMonth: 31,
      nextDueDate: '2027-05-31',
    })
    expect(cadenceSchedule('annual', monthly({ nextDueDate: '2025-12-20' }), TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [12],
      dueDayOfMonth: 20,
      nextDueDate: '2026-12-20',
    })
  })

  it('annual with no month anywhere is January', () => {
    expect(cadenceSchedule('annual', { frequency: 'monthly' }, TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1],
      nextDueDate: '2027-01-31',
    })
    expect(cadenceSchedule('annual', { frequency: 'specific-months', scheduledMonths: [] }, TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1],
      nextDueDate: '2027-01-31',
    })
  })

  it('missing or malformed fields never throw', () => {
    expect(cadenceSchedule('quarterly', null, TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: '2026-10-31',
    })
    expect(cadenceSchedule('quarterly', { nextDueDate: 'soon', dueDayOfMonth: 'x' }, TODAY)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: '2026-10-31',
    })
    expect(cadenceSchedule('weekly', undefined, TODAY)).toEqual({ frequency: 'weekly' })
  })

  it('without a valid today there is no nextDueDate (the caller floors)', () => {
    expect(cadenceSchedule('quarterly', monthly(), undefined)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      dueDayOfMonth: 15,
    })
  })

  it("a due day is clamped to the month's length", () => {
    expect(cadenceSchedule('quarterly', monthly({ nextDueDate: '2026-01-31' }), '2027-02-01')).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      dueDayOfMonth: 31,
      nextDueDate: '2027-04-30',
    })
  })

  it("today's own occurrence counts (on or after today)", () => {
    expect(cadenceSchedule('quarterly', monthly({ nextDueDate: '2026-01-13' }), TODAY).nextDueDate).toBe('2026-10-13')
  })

  it("Match plan: the day comes from the existing copy (the target), the months from the blueprint", () => {
    const blueprint = monthly({ nextDueDate: '2026-03-15' })
    const copy = { frequency: 'monthly', nextDueDate: '2026-11-20' }
    expect(cadenceSchedule('annual', blueprint, TODAY, copy)).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [3],
      dueDayOfMonth: 20,
      nextDueDate: '2027-03-20',
    })
    expect(cadenceSchedule('quarterly', blueprint, TODAY, { ...copy, dueDayOfMonth: 2 })).toEqual({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: '2027-01-02',
    })
  })
})

describe('scheduleDiffers', () => {
  it('a different frequency differs', () => {
    expect(scheduleDiffers({ frequency: 'monthly' }, { frequency: 'weekly' })).toBe(true)
    expect(scheduleDiffers({ frequency: 'weekly' }, { frequency: 'weekly' })).toBe(false)
  })

  it('months are compared as sets', () => {
    const quarterly = { frequency: 'specific-months', scheduledMonths: [1, 4, 7, 10] }
    expect(scheduleDiffers({ frequency: 'specific-months', scheduledMonths: [10, 7, 4, 1, 1] }, quarterly)).toBe(false)
    expect(scheduleDiffers({ frequency: 'specific-months', scheduledMonths: [3, 6, 9, 12] }, quarterly)).toBe(true)
    expect(scheduleDiffers({ frequency: 'specific-months' }, quarterly)).toBe(true)
  })

  it('stale months on a weekly/monthly copy do not count', () => {
    expect(scheduleDiffers({ frequency: 'monthly', scheduledMonths: [3] }, { frequency: 'monthly' })).toBe(false)
  })

  it('no mapped schedule never differs', () => {
    expect(scheduleDiffers({ frequency: 'monthly' }, null)).toBe(false)
  })
})

describe('bundlingPlan / planCadenceLabel', () => {
  it('the first plan in the list that bundles the template', () => {
    const plans = [
      { id: 'p1', templateIds: ['t2'] },
      { id: 'p2', templateIds: ['t1'] },
      { id: 'p3', templateIds: ['t1'] },
    ]
    expect(bundlingPlan('t1', plans)?.id).toBe('p2')
    expect(bundlingPlan('t9', plans)).toBeNull()
    expect(bundlingPlan('t1', [null, { id: 'p4' }])).toBeNull()
  })

  it('labels read like the Plans page', () => {
    expect(planCadenceLabel('weekly')).toBe('Weekly')
    expect(planCadenceLabel('monthly')).toBe('Monthly')
    expect(planCadenceLabel('quarterly')).toBe('Quarterly')
    expect(planCadenceLabel('annual')).toBe('Yearly')
  })
})
