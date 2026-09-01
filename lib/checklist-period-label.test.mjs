import { describe, expect, it } from 'vitest'

import { formatCoverageRange, nextCoverageRange } from './expense-coverage.js'
import {
  coverageStepsBetween,
  periodLabelForInstance,
  periodWindowFor,
  sanitizeCoverageDate,
  sanitizePeriodLabel,
} from './checklist-period-label.js'

/**
 * The period label — featreq-81429ad1, second version.
 *
 * The first shipped with an OFFSET picker and she sent it back:
 *
 *   "The period covers should allow me to pick dates and then the how often
 *   should determine the next period"
 *
 * So the window is now hers to type and the recurrence carries it forward —
 * which is exactly the reimbursed-expense interaction she already uses. These
 * tests lean on that on purpose: several of them assert the label agrees with
 * `formatCoverageRange` / `nextCoverageRange` directly, so if the two features
 * ever drift apart, this fails rather than her noticing on an invoice.
 *
 * Her ORIGINAL constraint still stands and still has its own block below:
 * "purely a label not to change anything we have already done."
 */

const monthly = (over = {}) => ({
  periodLabelEnabled: true,
  frequency: 'monthly',
  periodCoverageStart: '2026-07-13',
  periodCoverageEnd: '2026-08-13',
  periodCoverageAnchorDue: '2026-08-31',
  ...over,
})

describe('she picks the window; the recurrence moves it', () => {
  it('shows exactly the dates she typed on the occurrence she set them for', () => {
    expect(periodLabelForInstance(monthly(), '2026-08-31')).toBe('July 13 – August 13, 2026')
  })

  it('advances a month at a time for a monthly task', () => {
    const dues = ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']
    expect(dues.map((due) => periodLabelForInstance(monthly(), due))).toEqual([
      'July 13 – August 13, 2026',
      'August 13 – September 13, 2026',
      'September 13 – October 13, 2026',
      'October 13 – November 13, 2026',
    ])
  })

  it('advances a quarter at a time for a quarterly task', () => {
    const template = monthly({
      frequency: 'quarterly',
      periodCoverageStart: '2026-04-01',
      periodCoverageEnd: '2026-07-01',
      periodCoverageAnchorDue: '2026-07-15',
    })
    expect(
      ['2026-07-15', '2026-10-15', '2027-01-15'].map((due) =>
        periodLabelForInstance(template, due),
      ),
    ).toEqual(['April 1 – July 1, 2026', 'July 1 – October 1, 2026', 'October 1, 2026 – January 1, 2027'])
  })

  it('advances a year at a time for an annual task', () => {
    const template = monthly({
      frequency: 'annually',
      periodCoverageStart: '2025-01-01',
      periodCoverageEnd: '2026-01-01',
      periodCoverageAnchorDue: '2026-03-15',
    })
    expect(periodLabelForInstance(template, '2027-03-15')).toBe(
      'January 1, 2026 – January 1, 2027',
    )
  })

  // The window spans a new year, so BOTH ends print their year — otherwise
  // "December 13 – January 13, 2027" would be ambiguous about the first date.
  it('spells both years when the window crosses one', () => {
    expect(periodLabelForInstance(monthly(), '2027-01-31')).toBe(
      'December 13, 2026 – January 13, 2027',
    )
  })
})

describe('it is the same machinery a reimbursed expense uses', () => {
  /**
   * Not a restatement of the implementation — the point is that the two
   * features cannot drift. If `nextCoverageRange` ever changes how a window
   * steps, a period label has to change with it, and this is what says so.
   */
  it('steps a window exactly as the invoice coverage does', () => {
    const first = { start: '2026-07-13', end: '2026-08-13' }
    const second = nextCoverageRange(first, { months: 1, anchorDay: 13 })
    expect(periodWindowFor(monthly(), '2026-09-30')).toEqual(second)
  })

  it('renders a window exactly as the invoice coverage does', () => {
    const window = periodWindowFor(monthly(), '2026-10-31')
    expect(periodLabelForInstance(monthly(), '2026-10-31')).toBe(
      formatCoverageRange(window.start, window.end),
    )
  })
})

describe('nothing to say is said as nothing', () => {
  // "not all checklist/task would have it" — an absent label has to be null so
  // the card renders nothing at all, not an empty chip.
  it('gives nothing when the switch is off', () => {
    expect(periodLabelForInstance(monthly({ periodLabelEnabled: false }), '2026-08-31')).toBeNull()
    expect(periodLabelForInstance({ frequency: 'monthly' }, '2026-08-31')).toBeNull()
    expect(periodLabelForInstance(null, '2026-08-31')).toBeNull()
  })

  it('gives nothing until BOTH dates are picked', () => {
    expect(periodLabelForInstance(monthly({ periodCoverageStart: null }), '2026-08-31')).toBeNull()
    expect(periodLabelForInstance(monthly({ periodCoverageEnd: '' }), '2026-08-31')).toBeNull()
    expect(
      periodLabelForInstance(monthly({ periodCoverageEnd: 'nonsense' }), '2026-08-31'),
    ).toBeNull()
  })

  it('keeps only real ISO dates', () => {
    expect(sanitizeCoverageDate('2026-07-13')).toBe('2026-07-13')
    expect(sanitizeCoverageDate('13/07/2026')).toBeNull()
    expect(sanitizeCoverageDate('')).toBeNull()
    expect(sanitizeCoverageDate(undefined)).toBeNull()
  })

  it('trims a hand-typed label and caps its length', () => {
    expect(sanitizePeriodLabel('  Q3 books ')).toBe('Q3 books')
    expect(sanitizePeriodLabel('   ')).toBeNull()
    expect(sanitizePeriodLabel('x'.repeat(200))).toHaveLength(80)
  })
})

describe('stepping is bounded and never runs backwards', () => {
  // An occurrence due BEFORE the window she typed shows the window she typed,
  // rather than one invented by walking backwards through dates she never saw.
  it('clamps at the window she set for earlier occurrences', () => {
    expect(coverageStepsBetween('2026-08-31', '2026-06-30', 'monthly')).toBe(0)
    expect(periodLabelForInstance(monthly(), '2026-06-30')).toBe('July 13 – August 13, 2026')
  })

  // A recipe whose anchor is years stale must not spin this into thousands of
  // iterations on every render.
  it('caps how far a stale anchor can step', () => {
    expect(coverageStepsBetween('1900-01-01', '2500-01-01', 'monthly')).toBe(600)
  })

  it('counts whole steps only, by the task’s own cadence', () => {
    expect(coverageStepsBetween('2026-08-31', '2026-09-30', 'monthly')).toBe(1)
    expect(coverageStepsBetween('2026-08-31', '2026-09-30', 'quarterly')).toBe(0)
    expect(coverageStepsBetween('2026-08-31', '2026-11-30', 'quarterly')).toBe(1)
    expect(coverageStepsBetween('2026-08-31', '2027-08-31', 'annually')).toBe(1)
  })
})

describe('“purely a label not to change anything we have already done”', () => {
  /**
   * HER FIRST CONSTRAINT, unchanged by the rework and still tested directly.
   * Each of these is a thing the label must not be, and each has a real failure
   * behind it: a label equal to a due date invites sorting by it; one shaped
   * like "2026-07" invites a report to group by it. It is prose for a human,
   * and it is shaped like prose so nothing is tempted to parse it.
   */
  it('is never the due date it came from', () => {
    for (const due of ['2026-08-31', '2026-09-30', '2027-01-31']) {
      expect(periodLabelForInstance(monthly(), due)).not.toBe(due)
    }
  })

  it('is never a machine-shaped period key', () => {
    for (const due of ['2026-08-31', '2026-09-30']) {
      expect(periodLabelForInstance(monthly(), due)).not.toMatch(/^\d{4}-\d{2}(-\d{2})?$/)
    }
  })

  it('is pure — same inputs, same answer, and it mutates nothing', () => {
    const template = Object.freeze(monthly())
    expect(periodLabelForInstance(template, '2026-09-30')).toBe(
      periodLabelForInstance(template, '2026-09-30'),
    )
    expect(template.periodCoverageStart).toBe('2026-07-13')
  })
})
