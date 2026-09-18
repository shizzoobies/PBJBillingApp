import { describe, expect, it } from 'vitest'

import { formatCoverageRange, nextCoverageRange } from './expense-coverage.js'
import {
  coverageAnchorForTemplate,
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

/* -------------------------------------------------------------------------- */
/* featreq-053fccba — she typed August and the task said November              */
/* -------------------------------------------------------------------------- */

/**
 * "51 Beach Monthly Reconciliations": she set the period covered to
 * Aug 1 – Aug 31 and the occurrence due 2026-09-10 read
 * "October 31 – November 30, 2026". Three separate faults stacked up, and each
 * one alone was enough to move the label off her window:
 *
 *   (a) the ANCHOR saved was the recipe's `nextDueDate` — 2026-06-04, a date a
 *       specific-months recipe never runs on and the materializer ignores;
 *   (b) the STEPS were counted in calendar months (June to September is three)
 *       instead of in the occurrences the recipe actually has (August,
 *       September);
 *   (c) the STEP SHAPE started each window on the previous window's END, which
 *       is right for a subscription billed on the 13th and wrong for a month:
 *       Aug 1–31 became Aug 31 – Sep 30, then Sep 30 – Oct 31, then
 *       Oct 31 – Nov 30 — the label she reported, exactly.
 */

const beach = (over = {}) => ({
  periodLabelEnabled: true,
  frequency: 'specific-months',
  // Feb, Mar, May, Jun, Aug, Sep, Nov, Dec — production template-idbnnq2.
  scheduledMonths: [2, 3, 5, 6, 8, 9, 11, 12],
  periodCoverageStart: '2026-08-01',
  periodCoverageEnd: '2026-08-31',
  ...over,
})

describe('a month-long window walks by months, not by its own end date', () => {
  it('reads her August window on the occurrence she set it for', () => {
    // The anchor the fix writes when she sets the dates during September: the
    // first designated month that has not finished. So the instance in front of
    // her carries the window she just typed, which is the whole contract.
    const template = beach({ periodCoverageAnchorDue: '2026-09-01' })
    expect(periodLabelForInstance(template, '2026-09-10')).toBe('August 1 – August 31, 2026')
  })

  it('moves one whole month per occurrence after that', () => {
    const template = beach({ periodCoverageAnchorDue: '2026-08-01' })
    // Anchored on the August occurrence, September's reads September — NOT
    // "August 31 – September 30", which is what the reimbursement step gave it.
    expect(periodLabelForInstance(template, '2026-09-10')).toBe(
      'September 1 – September 30, 2026',
    )
    expect(periodLabelForInstance(template, '2026-11-30')).toBe('October 1 – October 31, 2026')
    expect(periodLabelForInstance(template, '2026-12-31')).toBe('November 1 – November 30, 2026')
  })

  /**
   * The production row as it stands TODAY, anchored to the stale June 4
   * `nextDueDate`. June IS a designated month, so nothing snaps it: the window
   * is two occurrences (August, September) past its anchor and reads October.
   * Nothing can rescue a window anchored to an occurrence it was never set on —
   * the row has to be re-saved, which re-anchors it to the next occurrence. This
   * is pinned so the difference between a fixed CYCLE and a fixed ANCHOR stays
   * visible: the stacked step/shape faults are gone (it is no longer November),
   * the bad anchor is not.
   */
  it('still counts a stale anchor honestly rather than guessing', () => {
    const template = beach({ periodCoverageAnchorDue: '2026-06-04' })
    expect(coverageStepsBetween('2026-06-04', '2026-09-10', 'specific-months', template)).toBe(2)
    expect(periodLabelForInstance(template, '2026-09-10')).toBe('October 1 – October 31, 2026')
  })

  it('counts occurrences, not the empty calendar months between them', () => {
    const template = beach()
    // June to September: three calendar months, two occurrences.
    expect(coverageStepsBetween('2026-06-04', '2026-09-10', 'specific-months', template)).toBe(2)
    // May to June: one calendar month and one occurrence — the pair runs
    // back to back, so this one agrees with the old count by accident.
    expect(coverageStepsBetween('2026-05-31', '2026-06-30', 'specific-months', template)).toBe(1)
    // September to November: two calendar months, one occurrence.
    expect(coverageStepsBetween('2026-09-30', '2026-11-30', 'specific-months', template)).toBe(1)
  })

  it('keeps counting across the turn of the year', () => {
    const template = beach()
    // December 2026 to March 2027: the occurrences are February and March.
    expect(coverageStepsBetween('2026-12-31', '2027-03-31', 'specific-months', template)).toBe(2)
    expect(
      periodLabelForInstance(
        beach({ periodCoverageAnchorDue: '2026-12-01' }),
        '2027-03-31',
      ),
    ).toBe('October 1 – October 31, 2026')
  })

  it('snaps an anchor that lands in a month the recipe never runs in', () => {
    // July is not designated. The window belongs to the next occurrence the
    // recipe actually makes — August — so September is one step on.
    const template = beach({ periodCoverageAnchorDue: '2026-07-15' })
    expect(periodLabelForInstance(template, '2026-09-10')).toBe(
      'September 1 – September 30, 2026',
    )
  })

  it('snaps an anchor that falls before the first designated month of a year', () => {
    // A recipe that only runs in the second half of the year, anchored in
    // January: the window belongs to its August occurrence, not to January.
    const template = beach({
      scheduledMonths: [8, 9],
      periodCoverageAnchorDue: '2026-01-15',
    })
    expect(periodLabelForInstance(template, '2026-08-31')).toBe('August 1 – August 31, 2026')
    expect(periodLabelForInstance(template, '2026-09-30')).toBe(
      'September 1 – September 30, 2026',
    )
  })

  it('steps a plain monthly recipe by whole months too', () => {
    const template = {
      periodLabelEnabled: true,
      frequency: 'monthly',
      periodCoverageStart: '2026-08-01',
      periodCoverageEnd: '2026-08-31',
      periodCoverageAnchorDue: '2026-08-31',
    }
    expect(periodLabelForInstance(template, '2026-09-30')).toBe(
      'September 1 – September 30, 2026',
    )
    // Through a 30-day month and out the other side — a whole month stays whole,
    // where day-of-month anchoring would have parked it on the 30th.
    expect(periodLabelForInstance(template, '2026-11-30')).toBe('November 1 – November 30, 2026')
    expect(periodLabelForInstance(template, '2027-01-31')).toBe('January 1 – January 31, 2027')
  })

  it('steps a quarterly whole-month window by whole quarters', () => {
    const template = {
      periodLabelEnabled: true,
      frequency: 'quarterly',
      periodCoverageStart: '2026-04-01',
      periodCoverageEnd: '2026-06-30',
      periodCoverageAnchorDue: '2026-07-15',
    }
    expect(periodLabelForInstance(template, '2026-10-15')).toBe('July 1 – September 30, 2026')
    expect(periodLabelForInstance(template, '2027-01-15')).toBe(
      'October 1 – December 31, 2026',
    )
  })

  /**
   * WEEKLY AND BIWEEKLY were decided the way the reimbursement side already
   * reads them: everything below quarterly is one month per cycle, because
   * reimbursements bill monthly. So a weekly task's occurrences inside one month
   * all name that month and the window turns over when the month does. Stepping
   * once per WEEK would run the label a month ahead every four occurrences,
   * which is the same class of drift this whole fix is about.
   */
  it('gives every occurrence inside a month the same window, for weekly work', () => {
    const weekly = {
      periodLabelEnabled: true,
      frequency: 'weekly',
      periodCoverageStart: '2026-08-01',
      periodCoverageEnd: '2026-08-31',
      periodCoverageAnchorDue: '2026-08-03',
    }
    const august = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31']
    expect(new Set(august.map((due) => periodLabelForInstance(weekly, due)))).toEqual(
      new Set(['August 1 – August 31, 2026']),
    )
    expect(periodLabelForInstance(weekly, '2026-09-07')).toBe(
      'September 1 – September 30, 2026',
    )
    expect(periodLabelForInstance({ ...weekly, frequency: 'biweekly' }, '2026-09-14')).toBe(
      'September 1 – September 30, 2026',
    )
  })
})

describe('the reimbursement shape is untouched', () => {
  /**
   * `nextCoverageRange` is what an INVOICE's covered dates are built from. The
   * whole-month step above had to be added beside it, never inside it: a
   * subscription billed on the 13th resumes on the 13th, and moving that to the
   * 1st would silently re-word live invoice lines. This is the tripwire.
   */
  it('still starts each window on the last one’s end, on its own anchor day', () => {
    expect(nextCoverageRange({ start: '2026-07-13', end: '2026-08-13' }, { months: 1, anchorDay: 13 })).toEqual({
      start: '2026-08-13',
      end: '2026-09-13',
    })
    // Month-end clamping and the return trip, the reimbursement's own behavior.
    expect(nextCoverageRange({ start: '2026-01-31', end: '2026-02-28' }, { months: 1, anchorDay: 31 })).toEqual({
      start: '2026-02-28',
      end: '2026-03-31',
    })
    // A whole calendar month handed to the REIMBURSEMENT function still steps
    // the reimbursement way. Only the checklist label reads it as a month.
    expect(nextCoverageRange({ start: '2026-08-01', end: '2026-08-31' }, { months: 1, anchorDay: 31 })).toEqual({
      start: '2026-08-31',
      end: '2026-09-30',
    })
  })

  it('leaves a mid-month checklist window on the reimbursement step', () => {
    const template = monthly()
    const first = nextCoverageRange({ start: '2026-07-13', end: '2026-08-13' }, { months: 1, anchorDay: 13 })
    const second = nextCoverageRange(first, { months: 1, anchorDay: 13 })
    expect(periodWindowFor(template, '2026-10-31')).toEqual(second)
    expect(periodLabelForInstance(template, '2026-10-31')).toBe(
      'September 13 – October 13, 2026',
    )
  })
})

describe('the anchor a window typed today belongs to', () => {
  const recipe = { frequency: 'specific-months', scheduledMonths: [2, 3, 5, 6, 8, 9, 11, 12] }

  it('is this month when the recipe runs in it', () => {
    expect(coverageAnchorForTemplate(recipe, '2026-09-18')).toBe('2026-09-01')
  })

  it('is the next designated month when it does not', () => {
    expect(coverageAnchorForTemplate(recipe, '2026-07-01')).toBe('2026-08-01')
    expect(coverageAnchorForTemplate(recipe, '2026-10-31')).toBe('2026-11-01')
  })

  it('wraps into next year past the last designated month', () => {
    expect(coverageAnchorForTemplate({ ...recipe, scheduledMonths: [2, 3] }, '2026-09-18')).toBe(
      '2027-02-01',
    )
  })

  it('stays on the recipe’s own next due date for every other frequency', () => {
    expect(coverageAnchorForTemplate({ frequency: 'monthly', nextDueDate: '2026-09-30' }, '2026-09-18')).toBe(
      '2026-09-30',
    )
    expect(coverageAnchorForTemplate({ frequency: 'monthly', nextDueDate: '' }, '2026-09-18')).toBeNull()
    expect(coverageAnchorForTemplate({ frequency: 'specific-months', scheduledMonths: [] }, '2026-09-18')).toBeNull()
  })
})

describe('the step says when the window moves, she says how long it is', () => {
  /**
   * Sizing the new window off the FREQUENCY rewrote the window itself. Each of
   * these is a shape the first version got wrong; the single-month cases above
   * are unchanged, which is the other half of the point.
   */
  it('keeps a three-month window three months long on a one-step recipe', () => {
    const template = {
      periodLabelEnabled: true,
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      periodCoverageStart: '2026-01-01',
      periodCoverageEnd: '2026-03-31',
      periodCoverageAnchorDue: '2026-01-01',
    }
    expect(periodLabelForInstance(template, '2026-04-30')).toBe('February 1 – April 30, 2026')
  })

  it('keeps a one-month window one month long on a quarterly recipe', () => {
    const template = {
      periodLabelEnabled: true,
      frequency: 'quarterly',
      periodCoverageStart: '2026-11-01',
      periodCoverageEnd: '2026-11-30',
      periodCoverageAnchorDue: '2026-11-15',
    }
    expect(periodLabelForInstance(template, '2027-02-15')).toBe(
      'February 1 – February 28, 2027',
    )
  })

  it('keeps a two-month window two months long on a monthly recipe', () => {
    const template = {
      periodLabelEnabled: true,
      frequency: 'monthly',
      periodCoverageStart: '2026-08-01',
      periodCoverageEnd: '2026-09-30',
      periodCoverageAnchorDue: '2026-09-30',
    }
    expect(periodLabelForInstance(template, '2026-10-31')).toBe(
      'September 1 – October 31, 2026',
    )
  })

  /**
   * A February window typed in a common year is 28 days long, and would fail a
   * strict last-day-of-month test the moment a leap year came round — dropping
   * onto the end-anchored step and drifting a day per cycle, in 2028, years
   * after anyone was looking at this.
   */
  it('reads February as a whole month in a leap year, typed either way', () => {
    const feb28 = {
      periodLabelEnabled: true,
      frequency: 'monthly',
      periodCoverageStart: '2028-02-01',
      periodCoverageEnd: '2028-02-28',
      periodCoverageAnchorDue: '2028-02-28',
    }
    expect(periodLabelForInstance(feb28, '2028-03-31')).toBe('March 1 – March 31, 2028')
    expect(
      periodLabelForInstance({ ...feb28, periodCoverageEnd: '2028-02-29' }, '2028-03-31'),
    ).toBe('March 1 – March 31, 2028')
    // And a whole month landing ON February comes back as the real 29 days.
    expect(
      periodLabelForInstance(
        {
          periodLabelEnabled: true,
          frequency: 'monthly',
          periodCoverageStart: '2028-01-01',
          periodCoverageEnd: '2028-01-31',
          periodCoverageAnchorDue: '2028-01-31',
        },
        '2028-02-29',
      ),
    ).toBe('February 1 – February 29, 2028')
  })

  it('holds the window still for a specific-months recipe with no months picked', () => {
    for (const months of [[], undefined, ['August', null, 13, 0]]) {
      const template = {
        periodLabelEnabled: true,
        frequency: 'specific-months',
        scheduledMonths: months,
        periodCoverageStart: '2026-08-01',
        periodCoverageEnd: '2026-08-31',
        periodCoverageAnchorDue: '2026-06-04',
      }
      expect(coverageStepsBetween('2026-06-04', '2026-12-31', 'specific-months', template)).toBe(0)
      expect(periodLabelForInstance(template, '2026-12-31')).toBe('August 1 – August 31, 2026')
    }
  })
})
