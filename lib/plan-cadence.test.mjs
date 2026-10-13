import { describe, expect, it } from 'vitest'
import {
  PLAN_CADENCES,
  cadenceFromPlanName,
  effectivePlanCadence,
  normalizePlanCadence,
  preservedPlanCadence,
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
