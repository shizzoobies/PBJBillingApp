import { describe, expect, it } from 'vitest'

import { formatCoverageRange, nextCoverageRange } from './expense-coverage.js'
import {
  caseOccurrenceKey,
  caseOccurrences,
  checklistMonthLabel,
  coverageAnchorForTemplate,
  coverageDatesFromLabel,
  coverageReference,
  coverageStepsBetween,
  occurrenceBeforeAnchor,
  occurrenceDateOf,
  openCaseOccurrences,
  openCases,
  periodLabelForCaseStep,
  periodLabelForInstance,
  periodLabelFromDates,
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
 *   (b) the STEPS were counted from that stale anchor, so they ran ahead of
 *       the task. (They were then counted in OCCURRENCES for a while, which
 *       featreq-6678d532 undid: see "moves with the calendar" below.)
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

  /**
   * featreq-6678d532. Counting one move per RUN was wrong for every schedule in
   * production: this recipe skips October, and its November checklist read
   * "September" - one run after September's, two months after it. The work a
   * checklist covers is set by the calendar, so the window moves by the months
   * that passed whether or not the recipe ran in them.
   */
  it('moves with the calendar after that, the skipped months included', () => {
    const template = beach({ periodCoverageAnchorDue: '2026-08-01' })
    // Anchored on the August occurrence, September's reads September — NOT
    // "August 31 – September 30", which is what the reimbursement step gave it.
    expect(periodLabelForInstance(template, '2026-09-10')).toBe(
      'September 1 – September 30, 2026',
    )
    expect(periodLabelForInstance(template, '2026-11-30')).toBe(
      'November 1 – November 30, 2026',
    )
    expect(periodLabelForInstance(template, '2026-12-31')).toBe(
      'December 1 – December 31, 2026',
    )
  })

  it('reads the month before on the reconciliations that skip the quarter months', () => {
    // Production, 2026-11-14: July's books set for the August checklist. The
    // November checklist covers October - there was no October checklist, and
    // October is still the month it covers.
    const template = beach({
      periodCoverageStart: '2026-07-01',
      periodCoverageEnd: '2026-07-31',
      periodCoverageAnchorDue: '2026-08-01',
    })
    expect(periodLabelForInstance(template, '2026-09-05')).toBe('August 1 – August 31, 2026')
    expect(periodLabelForInstance(template, '2026-11-05')).toBe('October 1 – October 31, 2026')
    expect(periodLabelForInstance(template, '2026-12-05')).toBe(
      'November 1 – November 30, 2026',
    )
    expect(periodLabelForInstance(template, '2027-02-05')).toBe('January 1 – January 31, 2027')
  })

  it('moves a quarter at a time on a recipe that runs in January, April, July and October', () => {
    // The 32 quarterly recipes: the third quarter set for the October checklist.
    // One move per run would have read "August 1 – October 31" in January.
    const template = beach({
      scheduledMonths: [1, 4, 7, 10],
      periodCoverageStart: '2026-07-01',
      periodCoverageEnd: '2026-09-30',
      periodCoverageAnchorDue: '2026-10-01',
    })
    expect(periodLabelForInstance(template, '2026-10-20')).toBe('July 1 – September 30, 2026')
    expect(periodLabelForInstance(template, '2027-01-20')).toBe(
      'October 1 – December 31, 2026',
    )
    expect(periodLabelForInstance(template, '2027-04-20')).toBe('January 1 – March 31, 2027')
  })

  it('moves a year at a time on a recipe that runs once a year', () => {
    const template = beach({
      scheduledMonths: [1],
      periodCoverageStart: '2026-01-01',
      periodCoverageEnd: '2026-12-31',
      periodCoverageAnchorDue: '2027-01-01',
    })
    expect(periodLabelForInstance(template, '2027-01-15')).toBe('January 1 – December 31, 2026')
    expect(periodLabelForInstance(template, '2028-01-15')).toBe('January 1 – December 31, 2027')
  })

  it('keeps a window that is not whole months the length she typed', () => {
    // "July 13 – October 13" on a quarterly-by-month recipe: both ends move by
    // the months that passed. The reimbursement step would have restarted it at
    // one month long.
    const template = beach({
      scheduledMonths: [1, 4, 7, 10],
      periodCoverageStart: '2026-07-13',
      periodCoverageEnd: '2026-10-13',
      periodCoverageAnchorDue: '2026-10-01',
    })
    expect(periodLabelForInstance(template, '2027-01-20')).toBe(
      'October 13, 2026 – January 13, 2027',
    )
  })

  it('keeps an end typed on the last day of a month on the last day', () => {
    // "January 15 – February 28" a month on ends March 31, not March 28; and a
    // start typed on a month end stays on month ends too.
    const midToEnd = beach({
      scheduledMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      periodCoverageStart: '2027-01-15',
      periodCoverageEnd: '2027-02-28',
      periodCoverageAnchorDue: '2027-03-01',
    })
    expect(periodLabelForInstance(midToEnd, '2027-04-05')).toBe('February 15 – March 31, 2027')
    expect(periodLabelForInstance(midToEnd, '2027-05-05')).toBe('March 15 – April 30, 2027')
    const endToThirtieth = beach({
      scheduledMonths: [1, 4, 7, 10],
      periodCoverageStart: '2026-07-31',
      periodCoverageEnd: '2026-10-30',
      periodCoverageAnchorDue: '2026-10-01',
    })
    expect(periodLabelForInstance(endToThirtieth, '2027-01-20')).toBe(
      'October 31, 2026 – January 30, 2027',
    )
    expect(periodLabelForInstance(endToThirtieth, '2027-07-20')).toBe(
      'April 30 – July 30, 2027',
    )
  })

  it('reads a 30th-to-30th or 28th-to-28th window as a day number, not as month ends', () => {
    // The other end says which it is: the same day number in a month where it
    // is NOT the last day. Read as month ends, these came back a day longer.
    const everyMonth = { scheduledMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }
    const thirtieth = beach({
      ...everyMonth,
      periodCoverageStart: '2026-09-30',
      periodCoverageEnd: '2026-10-30',
      periodCoverageAnchorDue: '2026-11-05',
    })
    expect(periodLabelForInstance(thirtieth, '2026-12-05')).toBe('October 30 – November 30, 2026')
    // Through February and out the other side, back on the 30th.
    expect(periodLabelForInstance(thirtieth, '2027-03-05')).toBe('January 30 – February 28, 2027')
    expect(periodLabelForInstance(thirtieth, '2027-04-05')).toBe('February 28 – March 30, 2027')
    const endsInFebruary = beach({
      ...everyMonth,
      periodCoverageStart: '2027-01-28',
      periodCoverageEnd: '2027-02-28',
      periodCoverageAnchorDue: '2027-03-05',
    })
    expect(periodLabelForInstance(endsInFebruary, '2027-04-05')).toBe('February 28 – March 28, 2027')
    const startsInFebruary = beach({
      ...everyMonth,
      periodCoverageStart: '2027-02-28',
      periodCoverageEnd: '2027-03-28',
      periodCoverageAnchorDue: '2027-04-05',
    })
    expect(periodLabelForInstance(startsInFebruary, '2027-05-05')).toBe('March 28 – April 28, 2027')
    // Both ends on month ends are still month ends.
    const monthEnds = beach({
      ...everyMonth,
      periodCoverageStart: '2027-01-31',
      periodCoverageEnd: '2027-02-28',
      periodCoverageAnchorDue: '2027-03-05',
    })
    expect(periodLabelForInstance(monthEnds, '2027-04-05')).toBe('February 28 – March 31, 2027')
  })

  /**
   * The production row as it stood in September, anchored to the stale June 4
   * `nextDueDate`. June IS a designated month, so nothing snaps it: the window
   * is three months past its anchor and reads November. Nothing can rescue a
   * window anchored to an occurrence it was never set on — the row has to be
   * re-saved, which re-anchors it. Pinned so the difference between a fixed
   * CYCLE and a fixed ANCHOR stays visible.
   */
  it('still counts a stale anchor honestly rather than guessing', () => {
    const template = beach({ periodCoverageAnchorDue: '2026-06-04' })
    expect(coverageStepsBetween('2026-06-04', '2026-09-10', 'specific-months', template)).toBe(3)
    expect(periodLabelForInstance(template, '2026-09-10')).toBe(
      'November 1 – November 30, 2026',
    )
  })

  it('counts calendar months, whether or not the recipe ran in them', () => {
    const template = beach()
    // June to September: three calendar months (two runs).
    expect(coverageStepsBetween('2026-06-04', '2026-09-10', 'specific-months', template)).toBe(3)
    // May to June: one calendar month and one run.
    expect(coverageStepsBetween('2026-05-31', '2026-06-30', 'specific-months', template)).toBe(1)
    // September to November: two calendar months (one run).
    expect(coverageStepsBetween('2026-09-30', '2026-11-30', 'specific-months', template)).toBe(2)
    // Never backwards.
    expect(coverageStepsBetween('2026-09-30', '2026-06-30', 'specific-months', template)).toBe(0)
  })

  it('keeps counting across the turn of the year', () => {
    const template = beach()
    // December 2026 to March 2027: three months, the January with no run included.
    expect(coverageStepsBetween('2026-12-31', '2027-03-31', 'specific-months', template)).toBe(3)
    expect(
      periodLabelForInstance(
        beach({ periodCoverageAnchorDue: '2026-12-01' }),
        '2027-03-31',
      ),
    ).toBe('November 1 – November 30, 2026')
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
   * WEEKLY AND BIWEEKLY with a MONTH-LONG window read the way the
   * reimbursement side does: a weekly task's occurrences inside one month all
   * name that month and the window turns over when the month does. (A pay
   * period - a window under four weeks - is the other case, and moves by the
   * week: see "a pay period moves by the week" below.)
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
    // One quarter on, and still three months long.
    expect(periodLabelForInstance(template, '2026-04-30')).toBe('April 1 – June 30, 2026')
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

describe('checklistMonthLabel', () => {
  it("prefers the checklist's own period label", () => {
    expect(
      checklistMonthLabel({ periodLabel: ' October 13 - November 13, 2026 ', cycleDueDate: '2026-11-30', dueDate: '2026-12-15' }),
    ).toBe('October 13 - November 13, 2026')
  })

  it('folds the whitespace inside a typed label', () => {
    expect(checklistMonthLabel({ periodLabel: 'July   13 -\t August 13, 2026' })).toBe('July 13 - August 13, 2026')
  })

  it('else names the month of the occurrence it belongs to (the cycle, not a pushed day)', () => {
    expect(checklistMonthLabel({ cycleDueDate: '2026-11-30', dueDate: '2026-12-03' })).toBe('November 2026')
    expect(checklistMonthLabel({ periodLabel: null, dueDate: '2027-01-31' })).toBe('January 2027')
    expect(checklistMonthLabel({ periodLabel: '  ', dueDate: '2026-09-30' })).toBe('September 2026')
  })

  it('is null when there is nothing to name it by', () => {
    expect(checklistMonthLabel(undefined)).toBeNull()
    expect(checklistMonthLabel({})).toBeNull()
    expect(checklistMonthLabel({ dueDate: 'soon' })).toBeNull()
    expect(checklistMonthLabel({ dueDate: '2026-13-01' })).toBeNull()
  })
})

/**
 * featreq-6678d532, part two. Payroll runs weekly or every two weeks and its
 * window is the pay period. Those recipes moved a month at a time on the
 * reimbursement step, which starts each window on the last one's end: production
 * read "October 5 – November 5, 2026" on a recipe given August 30 – September 5.
 */
describe('a pay period moves by the week', () => {
  // The two production shapes, as typed.
  const weeklyPayroll = {
    periodLabelEnabled: true,
    frequency: 'weekly',
    periodCoverageStart: '2026-08-30',
    periodCoverageEnd: '2026-09-05',
    periodCoverageAnchorDue: '2026-09-11',
  }
  const biweeklyPayroll = {
    periodLabelEnabled: true,
    frequency: 'biweekly',
    periodCoverageStart: '2026-08-23',
    periodCoverageEnd: '2026-09-05',
    periodCoverageAnchorDue: '2026-09-08',
  }

  it('reads the week she typed on the occurrence she set it for', () => {
    expect(periodLabelForInstance(weeklyPayroll, '2026-09-11')).toBe(
      'August 30 – September 5, 2026',
    )
  })

  it('moves a weekly window seven days per week, Sunday to Saturday every time', () => {
    expect(periodLabelForInstance(weeklyPayroll, '2026-09-18')).toBe(
      'September 6 – September 12, 2026',
    )
    expect(periodLabelForInstance(weeklyPayroll, '2026-11-20')).toBe(
      'November 8 – November 14, 2026',
    )
    for (const due of ['2026-10-02', '2026-11-20', '2027-01-01', '2027-03-05']) {
      const window = periodWindowFor(weeklyPayroll, due)
      expect(new Date(`${window.start}T12:00:00Z`).getUTCDay()).toBe(0)
      expect(new Date(`${window.end}T12:00:00Z`).getUTCDay()).toBe(6)
    }
  })

  it('moves a two-week window fourteen days per run', () => {
    expect(periodLabelForInstance(biweeklyPayroll, '2026-09-22')).toBe(
      'September 6 – September 19, 2026',
    )
    expect(periodLabelForInstance(biweeklyPayroll, '2026-11-17')).toBe(
      'November 1 – November 14, 2026',
    )
  })

  it('crosses a year end with both years spelled', () => {
    expect(periodLabelForInstance(weeklyPayroll, '2027-01-08')).toBe(
      'December 27, 2026 – January 2, 2027',
    )
  })

  it('keeps a step that is due a day or two off its cycle in that cycle', () => {
    // A second step due two days after the first, or a date nudged by a day.
    expect(periodLabelForInstance(weeklyPayroll, '2026-11-22')).toBe(
      'November 8 – November 14, 2026',
    )
    expect(periodLabelForInstance(weeklyPayroll, '2026-11-18')).toBe(
      'November 8 – November 14, 2026',
    )
    expect(periodLabelForInstance(biweeklyPayroll, '2026-11-19')).toBe(
      'November 1 – November 14, 2026',
    )
  })

  it('shows the window she typed on anything before the anchor, never an earlier one', () => {
    expect(periodLabelForInstance(weeklyPayroll, '2026-09-04')).toBe(
      'August 30 – September 5, 2026',
    )
    expect(coverageStepsBetween('2026-09-11', '2026-08-01', 'weekly', weeklyPayroll)).toBe(0)
  })

  it('leaves a weekly task with a month-long window on the month step', () => {
    const monthLong = {
      ...weeklyPayroll,
      periodCoverageStart: '2026-08-01',
      periodCoverageEnd: '2026-08-31',
      periodCoverageAnchorDue: '2026-08-03',
    }
    expect(periodLabelForInstance(monthLong, '2026-08-24')).toBe('August 1 – August 31, 2026')
    expect(periodLabelForInstance(monthLong, '2026-09-07')).toBe(
      'September 1 – September 30, 2026',
    )
  })

  it('does not touch monthly, quarterly or annual recipes', () => {
    // A two-week window on a MONTHLY recipe is not a pay period: it stays on
    // the reimbursement step, exactly as before.
    const monthlyShort = { ...biweeklyPayroll, frequency: 'monthly' }
    expect(periodWindowFor(monthlyShort, '2026-10-08')).toEqual(
      nextCoverageRange(
        { start: '2026-08-23', end: '2026-09-05' },
        { months: 1, anchorDay: 5 },
      ),
    )
  })
})

describe('which occurrences the window was not set for', () => {
  it('is by month for the recipes that move by months', () => {
    const template = beach({ periodCoverageAnchorDue: '2026-09-15' })
    expect(occurrenceBeforeAnchor(template, '2026-08-31')).toBe(true)
    // Earlier in the anchor's own month is the same occurrence.
    expect(occurrenceBeforeAnchor(template, '2026-09-02')).toBe(false)
    expect(occurrenceBeforeAnchor(template, '2026-11-05')).toBe(false)
  })

  it('is by whole cycles for a pay period', () => {
    const weekly = {
      frequency: 'weekly',
      periodCoverageStart: '2026-08-30',
      periodCoverageEnd: '2026-09-05',
      periodCoverageAnchorDue: '2026-09-11',
    }
    expect(occurrenceBeforeAnchor(weekly, '2026-09-04')).toBe(true)
    expect(occurrenceBeforeAnchor(weekly, '2026-09-09')).toBe(false)
    expect(occurrenceBeforeAnchor(weekly, '2026-09-18')).toBe(false)
  })

  it('is never true without an anchor', () => {
    expect(occurrenceBeforeAnchor(beach(), '2020-01-01')).toBe(false)
    expect(occurrenceBeforeAnchor(null, '2026-09-04')).toBe(false)
  })
})

describe('one case, one period', () => {
  const step = (over = {}) => ({
    id: 'chk-1',
    clientId: 'c1',
    caseId: 'case-1',
    stageIndex: 0,
    dueDate: '2026-10-20',
    ...over,
  })

  it('counts a checklist from the date it was FIRST due, not the date it was pushed to', () => {
    expect(occurrenceDateOf(step())).toBe('2026-10-20')
    expect(occurrenceDateOf(step({ cycleDueDate: '2026-10-20', dueDate: '2026-11-18' }))).toBe(
      '2026-10-20',
    )
    expect(occurrenceDateOf({})).toBeNull()
  })

  it('dates a case by its first step, whenever the later ones are due', () => {
    const steps = [
      step({ id: 'chk-3', stageIndex: 2, dueDate: '2026-12-01' }),
      step({ id: 'chk-1', stageIndex: 0, dueDate: '2026-10-20' }),
      step({ id: 'chk-2', stageIndex: 1, dueDate: '2026-11-10' }),
    ]
    expect(caseOccurrences(steps).get(caseOccurrenceKey(steps[0]))).toBe('2026-10-20')
  })

  it('keeps two clients that share a case id apart', () => {
    // The August import left case ids shared across clients.
    const steps = [step(), step({ id: 'chk-9', clientId: 'c2', dueDate: '2026-07-01' })]
    const occurrences = caseOccurrences(steps)
    expect(occurrences.get(caseOccurrenceKey(steps[0]))).toBe('2026-10-20')
    expect(occurrences.get(caseOccurrenceKey(steps[1]))).toBe('2026-07-01')
  })

  it('treats a checklist with no case as its own case', () => {
    const lone = { id: 'chk-solo', clientId: 'c1', dueDate: '2026-09-10' }
    expect(caseOccurrences([lone]).get(caseOccurrenceKey(lone))).toBe('2026-09-10')
  })

  it('gives a later step the period of its case, not of its own due date', () => {
    const quarterly = beach({
      scheduledMonths: [1, 4, 7, 10],
      periodCoverageStart: '2026-07-01',
      periodCoverageEnd: '2026-09-30',
      periodCoverageAnchorDue: '2026-10-01',
    })
    // Step 1 was due in October; step 2 is due in December. Production read
    // "December 1 – December 31" on steps like this one.
    expect(periodLabelForCaseStep(quarterly, [step({ dueDate: '2026-10-20' })])).toEqual({
      periodLabel: 'July 1 – September 30, 2026',
      periodLabelManual: false,
    })
  })

  it('carries dates set by hand onto the next step, still marked', () => {
    const steps = [
      step({ periodLabel: 'September 1 – September 15, 2026', periodLabelManual: true }),
    ]
    expect(periodLabelForCaseStep(beach(), steps)).toEqual({
      periodLabel: 'September 1 – September 15, 2026',
      periodLabelManual: true,
    })
  })

  it('gives a case that began before the anchor what its earliest step already says', () => {
    // The recipe's dates were set for December's checklist; this case began in
    // November and reads October. Working the dates out would hand its next
    // step November - the anchor's own window - and split the case.
    const lateAnchor = {
      periodLabelEnabled: true,
      frequency: 'monthly',
      periodCoverageStart: '2026-11-01',
      periodCoverageEnd: '2026-11-30',
      periodCoverageAnchorDue: '2026-12-05',
    }
    const steps = [
      step({ id: 'b', stageIndex: 1, dueDate: '2026-11-12', periodLabel: 'later words' }),
      step({ id: 'a', stageIndex: 0, dueDate: '2026-11-05', periodLabel: 'October 1 – October 31, 2026' }),
    ]
    expect(periodLabelForCaseStep(lateAnchor, steps)).toEqual({
      periodLabel: 'October 1 – October 31, 2026',
      periodLabelManual: false,
    })
    // With nothing said yet, it falls back to the window the recipe was given.
    expect(periodLabelForCaseStep(lateAnchor, [step({ dueDate: '2026-11-05' })])).toEqual({
      periodLabel: 'November 1 – November 30, 2026',
      periodLabelManual: false,
    })
    // And a case at or after the anchor is worked out as usual, whatever it said.
    expect(
      periodLabelForCaseStep(lateAnchor, [step({ dueDate: '2026-12-05', periodLabel: 'stale' })]),
    ).toEqual({ periodLabel: 'November 1 – November 30, 2026', periodLabelManual: false })
  })

  it('gives nothing when the recipe carries no dates', () => {
    expect(periodLabelForCaseStep({ periodLabelEnabled: false }, [step()])).toEqual({
      periodLabel: null,
      periodLabelManual: false,
    })
    expect(periodLabelForCaseStep(null, [])).toEqual({ periodLabel: null, periodLabelManual: false })
  })
})

/**
 * featreq-6678d532, part three: "there is not a way for us to update once it
 * becomes active" was half of it; the other half was that correcting the dates
 * on the recipe landed on the NEXT checklist, a month off, and skipped the one
 * she was looking at.
 */
describe('the checklist the dates on a recipe are for', () => {
  const monthlyRecipe = { frequency: 'monthly', nextDueDate: '2026-12-05' }

  it('is the earliest one still open', () => {
    expect(coverageReference(monthlyRecipe, ['2026-12-05', '2026-11-05'], '2026-11-14')).toEqual({
      date: '2026-11-05',
      open: true,
    })
  })

  it('is the next occurrence when nothing is open', () => {
    expect(coverageReference(monthlyRecipe, [], '2026-11-14')).toEqual({
      date: '2026-12-05',
      open: false,
    })
    expect(
      coverageReference(
        { frequency: 'specific-months', scheduledMonths: [1, 4, 7, 10] },
        [],
        '2026-11-14',
      ),
    ).toEqual({ date: '2027-01-01', open: false })
  })

  it('makes a correction land on the open checklist and carry on from it', () => {
    // The open November checklist should read October. She types October; the
    // dates are anchored to that checklist, so IT reads October and December's
    // reads November.
    const reference = coverageReference(monthlyRecipe, ['2026-11-05'], '2026-11-14')
    const corrected = {
      ...monthlyRecipe,
      periodLabelEnabled: true,
      periodCoverageStart: '2026-10-01',
      periodCoverageEnd: '2026-10-31',
      periodCoverageAnchorDue: reference.date,
    }
    expect(periodLabelForInstance(corrected, '2026-11-05')).toBe('October 1 – October 31, 2026')
    expect(periodLabelForInstance(corrected, '2026-12-05')).toBe(
      'November 1 – November 30, 2026',
    )
  })

  const live = (over = {}) => ({
    id: 'chk-1',
    templateId: 'tmpl-1',
    clientId: 'c1',
    caseId: 'case-1',
    stageIndex: 0,
    dueDate: '2026-11-05',
    done: false,
    ...over,
  })
  const finished = (checklist) => checklist.done === true

  it('lists the occurrences of the open cases, earliest first, once each', () => {
    const checklists = [
      live({ id: 'a', caseId: 'case-dec', dueDate: '2026-12-05' }),
      live({ id: 'b' }),
      // A second step of the November case, due later: still the November case.
      live({ id: 'c', stageIndex: 1, dueDate: '2026-11-20' }),
      // Another recipe's.
      live({ id: 'd', templateId: 'tmpl-2', caseId: 'case-x', dueDate: '2026-01-01' }),
    ]
    expect(openCaseOccurrences('tmpl-1', checklists, [], finished)).toEqual([
      '2026-11-05',
      '2026-12-05',
    ])
  })

  it('leaves out what is finished, skipped, binned, a push record or set by hand', () => {
    const checklists = [
      live({ id: 'done', caseId: 'c-done', dueDate: '2026-07-05', done: true }),
      live({ id: 'skipped', caseId: 'c-skip', dueDate: '2026-08-05', skippedAt: '2026-08-06T00:00:00Z' }),
      live({ id: 'binned', caseId: 'c-bin', dueDate: '2026-09-05', deletedAt: '2026-09-06T00:00:00Z' }),
      live({ id: 'record', caseId: 'c-rec', dueDate: '2026-09-15', pushedToChecklistId: 'x' }),
      live({ id: 'hand', caseId: 'c-hand', dueDate: '2026-10-05', periodLabelManual: true }),
      live({ id: 'open', caseId: 'c-open', dueDate: '2026-11-05' }),
    ]
    expect(openCaseOccurrences('tmpl-1', checklists, [], finished)).toEqual(['2026-11-05'])
  })

  it('dates an open later step by a first step that is finished or binned', () => {
    const first = live({ id: 'first', dueDate: '2026-10-28', done: true })
    const second = live({ id: 'second', stageIndex: 1, dueDate: '2026-11-04' })
    expect(openCaseOccurrences('tmpl-1', [first, second], [], finished)).toEqual(['2026-10-28'])
    expect(
      openCaseOccurrences('tmpl-1', [second], [{ ...first, deletedAt: '2026-11-01T00:00:00Z' }], finished),
    ).toEqual(['2026-10-28'])
  })
})

describe('the dates behind a label, and a label from two dates', () => {
  it('reads back every shape the app writes', () => {
    for (const [start, end] of [
      ['2026-07-13', '2026-08-13'],
      ['2026-08-01', '2026-08-31'],
      ['2026-12-13', '2027-01-13'],
      ['2026-11-08', '2026-11-14'],
      ['2028-02-01', '2028-02-29'],
      ['2026-09-05', '2026-09-05'],
    ]) {
      expect(coverageDatesFromLabel(formatCoverageRange(start, end))).toEqual({ start, end })
    }
  })

  it('gives nothing for a phrase the app did not write', () => {
    for (const text of [
      'July 2026',
      'Q3',
      '',
      null,
      undefined,
      'Smarch 1 – August 13, 2026',
      'July 13 - August 13, 2026',
      'February 30 – March 1, 2026',
    ]) {
      expect(coverageDatesFromLabel(text)).toBeNull()
    }
  })

  it('makes the label a recipe would have made for the same two dates', () => {
    expect(periodLabelFromDates('2026-10-01', '2026-10-31')).toBe('October 1 – October 31, 2026')
    expect(periodLabelFromDates('2026-10-04', '2026-10-04')).toBe('October 4 – October 4, 2026')
  })

  it('refuses dates that are not a window', () => {
    expect(periodLabelFromDates('2026-10-31', '2026-10-01')).toBeNull()
    expect(periodLabelFromDates('2026-10-01', '')).toBeNull()
    expect(periodLabelFromDates('', '')).toBeNull()
    expect(periodLabelFromDates('2026-02-30', '2026-03-01')).toBeNull()
    expect(periodLabelFromDates('10/01/2026', '10/31/2026')).toBeNull()
    expect(periodLabelFromDates(null, undefined)).toBeNull()
  })
})

describe('what each open case of a recipe shows', () => {
  const live = (over = {}) => ({
    id: 'chk-1',
    templateId: 'tmpl-1',
    clientId: 'c1',
    caseId: 'case-1',
    stageIndex: 0,
    dueDate: '2026-11-05',
    done: false,
    ...over,
  })
  const finished = (checklist) => checklist.done === true

  it('is one entry per case, earliest first, with the label of its earliest open step', () => {
    const checklists = [
      live({ id: 'dec', caseId: 'case-dec', dueDate: '2026-12-05', periodLabel: 'November 1 – November 30, 2026' }),
      // The November case: step 1 done, steps 2 and 3 open. Step 2 is the card in front of her.
      live({ id: 'n1', done: true, periodLabel: 'history' }),
      live({ id: 'n3', stageIndex: 2, dueDate: '2026-11-25', periodLabel: 'step three words' }),
      live({ id: 'n2', stageIndex: 1, dueDate: '2026-11-12', periodLabel: 'September 1 – September 30, 2026' }),
    ]
    expect(openCases('tmpl-1', checklists, [], finished)).toEqual([
      { occurrence: '2026-11-05', periodLabel: 'September 1 – September 30, 2026' },
      { occurrence: '2026-12-05', periodLabel: 'November 1 – November 30, 2026' },
    ])
  })

  it('gives null for a case that shows no label', () => {
    expect(openCases('tmpl-1', [live({ periodLabel: '  ' })], [], finished)).toEqual([
      { occurrence: '2026-11-05', periodLabel: null },
    ])
  })

  it('agrees with openCaseOccurrences on which cases are open', () => {
    const checklists = [
      live({ id: 'a' }),
      live({ id: 'b', caseId: 'case-b', dueDate: '2026-11-05' }),
      live({ id: 'c', caseId: 'case-c', dueDate: '2026-10-05', done: true }),
    ]
    expect(openCaseOccurrences('tmpl-1', checklists, [], finished)).toEqual(['2026-11-05'])
    expect(openCases('tmpl-1', checklists, [], finished)).toHaveLength(2)
  })
})
