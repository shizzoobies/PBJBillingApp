import { describe, expect, it } from 'vitest'
import {
  BILLING_PERIOD_MAX_MONTHS,
  billingPeriodSentence,
  hasBillingPeriod,
  nextPrepaymentMonth,
  normalizeBillingPeriodMonths,
  normalizePeriodAnchorMonth,
  periodAnchorFor,
  prepaymentLabel,
  prepaymentLines,
  prepaymentMonthsFor,
  validateBillingPeriod,
} from './billing-period.js'

const client = (over = {}) => ({
  id: 'client-q',
  billingMode: 'subscription',
  monthlyRate: 500,
  billingPeriodMonths: 3,
  periodAnchorMonth: '2026-10',
  ...over,
})

describe('normalizeBillingPeriodMonths', () => {
  it('keeps a whole number from 1 to 24', () => {
    expect(normalizeBillingPeriodMonths(1)).toBe(1)
    expect(normalizeBillingPeriodMonths(3)).toBe(3)
    expect(normalizeBillingPeriodMonths('6')).toBe(6)
    expect(normalizeBillingPeriodMonths(BILLING_PERIOD_MAX_MONTHS)).toBe(24)
  })

  it('answers 1 (monthly) for anything else', () => {
    for (const bad of [0, -2, 25, 2.5, '', 'abc', null, undefined, NaN, {}]) {
      expect(normalizeBillingPeriodMonths(bad)).toBe(1)
    }
  })
})

describe('normalizePeriodAnchorMonth', () => {
  it('keeps a real YYYY-MM and nothing else', () => {
    expect(normalizePeriodAnchorMonth('2026-10')).toBe('2026-10')
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-10', '', null, undefined, 202610, '2026-10-01']) {
      expect(normalizePeriodAnchorMonth(bad)).toBeNull()
    }
  })
})

describe('validateBillingPeriod', () => {
  it('accepts monthly with no anchor', () => {
    expect(validateBillingPeriod({ months: 1, anchor: '' })).toEqual({ ok: true })
  })

  it('requires a whole number from 1 to 24', () => {
    expect(validateBillingPeriod({ months: 0, anchor: '2026-10' }).ok).toBe(false)
    expect(validateBillingPeriod({ months: 25, anchor: '2026-10' }).ok).toBe(false)
    expect(validateBillingPeriod({ months: 2.5, anchor: '2026-10' }).ok).toBe(false)
  })

  it('requires the first month of a period when billing less often than monthly', () => {
    const refused = validateBillingPeriod({ months: 3, anchor: '' })
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/first month/i)
    expect(validateBillingPeriod({ months: 3, anchor: '2026-10' })).toEqual({ ok: true })
  })
})

describe('hasBillingPeriod', () => {
  it('is true only for a subscription client with a rate, N above 1 and an anchor', () => {
    expect(hasBillingPeriod(client())).toBe(true)
    expect(hasBillingPeriod(client({ billingPeriodMonths: 1 }))).toBe(false)
    expect(hasBillingPeriod(client({ periodAnchorMonth: null }))).toBe(false)
    expect(hasBillingPeriod(client({ monthlyRate: 0 }))).toBe(false)
    expect(hasBillingPeriod(client({ monthlyRate: undefined }))).toBe(false)
    expect(hasBillingPeriod(client({ billingMode: 'hourly' }))).toBe(false)
    expect(hasBillingPeriod(client({ billingMode: 'annual' }))).toBe(false)
    expect(hasBillingPeriod({})).toBe(false)
  })
})

describe('periodAnchorFor', () => {
  it('names the first month of the period a month falls in', () => {
    const c = client()
    expect(periodAnchorFor(c, '2026-10')).toBe('2026-10')
    expect(periodAnchorFor(c, '2026-11')).toBe('2026-10')
    expect(periodAnchorFor(c, '2026-12')).toBe('2026-10')
    expect(periodAnchorFor(c, '2027-01')).toBe('2027-01')
    expect(periodAnchorFor(c, '2027-03')).toBe('2027-01')
  })

  it('is null before the anchor, and for a client with no period', () => {
    expect(periodAnchorFor(client(), '2026-09')).toBeNull()
    expect(periodAnchorFor(client({ billingPeriodMonths: 1 }), '2026-11')).toBeNull()
  })
})

describe('prepaymentMonthsFor', () => {
  it('lists the LATER months of the period on an anchor month only', () => {
    const c = client()
    expect(prepaymentMonthsFor(c, '2026-10')).toEqual(['2026-11', '2026-12'])
    expect(prepaymentMonthsFor(c, '2026-11')).toEqual([])
    expect(prepaymentMonthsFor(c, '2026-12')).toEqual([])
    expect(prepaymentMonthsFor(c, '2027-01')).toEqual(['2027-02', '2027-03'])
  })

  it('gives nothing before the anchor', () => {
    expect(prepaymentMonthsFor(client({ periodAnchorMonth: '2027-01' }), '2026-10')).toEqual([])
  })

  it('crosses a year end and handles a long period', () => {
    expect(prepaymentMonthsFor(client({ billingPeriodMonths: 2, periodAnchorMonth: '2026-12' }), '2026-12')).toEqual([
      '2027-01',
    ])
    expect(prepaymentMonthsFor(client({ billingPeriodMonths: 24, periodAnchorMonth: '2026-01' }), '2026-01')).toHaveLength(23)
  })

  it('is empty for a monthly, hourly or annual client', () => {
    expect(prepaymentMonthsFor(client({ billingPeriodMonths: 1 }), '2026-10')).toEqual([])
    expect(prepaymentMonthsFor(client({ billingMode: 'hourly' }), '2026-10')).toEqual([])
    expect(prepaymentMonthsFor(client({ billingMode: 'annual', annualRate: 1200 }), '2026-10')).toEqual([])
  })
})

describe('prepaymentLines', () => {
  it('builds one line per later month at the current monthly fee', () => {
    expect(prepaymentLines(client(), '2026-10')).toEqual([
      { kind: 'prepayment', label: 'Prepayment for November 2026', detail: '', amount: 500, period: '2026-11' },
      { kind: 'prepayment', label: 'Prepayment for December 2026', detail: '', amount: 500, period: '2026-12' },
    ])
    expect(prepaymentLines(client(), '2026-11')).toEqual([])
  })

  it('has a label helper the editor and the tests share', () => {
    expect(prepaymentLabel('2027-02')).toBe('Prepayment for February 2027')
  })
})

describe('nextPrepaymentMonth', () => {
  it('is the anchor itself while it is still ahead', () => {
    expect(nextPrepaymentMonth(client(), '2026-09')).toBe('2026-10')
  })

  it('is this month on an anchor month and the next anchor otherwise', () => {
    expect(nextPrepaymentMonth(client(), '2026-10')).toBe('2026-10')
    expect(nextPrepaymentMonth(client(), '2026-11')).toBe('2027-01')
    expect(nextPrepaymentMonth(client(), '2027-03')).toBe('2027-04')
  })

  it('is null for a client with no period', () => {
    expect(nextPrepaymentMonth(client({ billingPeriodMonths: 1 }), '2026-10')).toBeNull()
  })
})

describe('billingPeriodSentence', () => {
  it('says what the next prepayment is and what it covers', () => {
    expect(billingPeriodSentence({ months: 3, anchor: '2026-10', today: '2026-10-07' })).toBe(
      'The next prepayment is on the October 2026 invoice. It covers October through December 2026 and carries the estimated fee for November and December.',
    )
  })

  it('names the following period once the anchor month has passed', () => {
    expect(billingPeriodSentence({ months: 3, anchor: '2026-10', today: '2026-11-05' })).toBe(
      'The next prepayment is on the January 2027 invoice. It covers January through March 2027 and carries the estimated fee for February and March.',
    )
  })

  it('reads right for two months and for monthly', () => {
    expect(billingPeriodSentence({ months: 2, anchor: '2026-12', today: '2026-12-01' })).toBe(
      'The next prepayment is on the December 2026 invoice. It covers December 2026 through January 2027 and carries the estimated fee for January.',
    )
    expect(billingPeriodSentence({ months: 1, anchor: '', today: '2026-12-01' })).toBe(
      'Billed every month, as always. Nothing is prepaid.',
    )
  })

  it('asks for the first month while the anchor is missing', () => {
    expect(billingPeriodSentence({ months: 3, anchor: '', today: '2026-10-07' })).toMatch(/pick the first month/i)
  })
})
