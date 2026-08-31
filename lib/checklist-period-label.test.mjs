import { describe, expect, it } from 'vitest'

import {
  normalizePeriodLabelOffset,
  periodGrainForFrequency,
  periodLabelFor,
  periodLabelForInstance,
  sanitizePeriodLabel,
} from './checklist-period-label.js'

/**
 * The period label — featreq-81429ad1.
 *
 * Brittany: *"I need a time period area - like the period the task is due for so
 * you can keep it straight, but not all checklist/task would have it and then
 * the next would spring forward."* Asked to confirm one concrete reading, she
 * answered:
 *
 *   1. - next to the title
 *   2. purely a label not to change anything we have already done
 *
 * Point 2 is the constraint the last block here exists to defend: this is a
 * string beside a title and nothing else. It is not a due date, not a period
 * key, not a filter. The label a task is BORN with is stored on the instance, so
 * the derivation below runs exactly once per task and never again.
 */

describe('which period the label names', () => {
  // The bookkeeping default and the reason the offset exists at all: July's
  // books are done in August.
  it('names the month before the due date by default', () => {
    expect(periodLabelFor('2026-08-15', 'monthly', 1)).toBe('July 2026')
  })

  it('can name the month it is due in instead', () => {
    expect(periodLabelFor('2026-08-15', 'monthly', 0)).toBe('August 2026')
  })

  it('rolls back over a year boundary', () => {
    expect(periodLabelFor('2026-01-10', 'monthly', 1)).toBe('December 2025')
    expect(periodLabelFor('2026-01-10', 'monthly', 13)).toBe('December 2024')
  })

  it('names quarters and years off the template’s own frequency', () => {
    expect(periodLabelFor('2026-08-15', 'quarterly', 1)).toBe('Q2 2026')
    expect(periodLabelFor('2026-01-15', 'quarterly', 1)).toBe('Q4 2025')
    expect(periodLabelFor('2026-08-15', 'annually', 1)).toBe('2025')
  })

  // "The week of Aug 3" is a due date, not a period of books. Sub-monthly
  // cadences fall to the month deliberately.
  it('falls to the month for daily, weekly and specific-months', () => {
    for (const frequency of ['daily', 'weekly', 'specific-months', undefined]) {
      expect(periodLabelFor('2026-08-15', frequency, 1), String(frequency)).toBe('July 2026')
    }
    expect(periodGrainForFrequency('quarterly')).toBe('quarter')
    expect(periodGrainForFrequency('annually')).toBe('year')
    expect(periodGrainForFrequency('monthly')).toBe('month')
  })
})

describe('nothing to say is said as nothing', () => {
  // "not all checklist/task would have it" — an absent label must be null so
  // the UI can render nothing at all rather than an empty chip.
  it('returns null rather than a placeholder', () => {
    expect(periodLabelFor('nonsense', 'monthly', 1)).toBeNull()
    expect(periodLabelFor('', 'monthly', 1)).toBeNull()
    expect(periodLabelFor(null, 'monthly', 1)).toBeNull()
    expect(periodLabelFor('2026-13-01', 'monthly', 1)).toBeNull()
    expect(sanitizePeriodLabel('   ')).toBeNull()
    expect(sanitizePeriodLabel(undefined)).toBeNull()
  })

  it('gives a template that has not opted in no label', () => {
    expect(periodLabelForInstance({ frequency: 'monthly' }, '2026-08-15')).toBeNull()
    expect(
      periodLabelForInstance({ periodLabelEnabled: false, frequency: 'monthly' }, '2026-08-15'),
    ).toBeNull()
    expect(periodLabelForInstance(null, '2026-08-15')).toBeNull()
  })

  it('gives an opted-in template the resolved string', () => {
    expect(
      periodLabelForInstance(
        { periodLabelEnabled: true, frequency: 'monthly', periodLabelOffset: 1 },
        '2026-08-15',
      ),
    ).toBe('July 2026')
  })

  it('refuses an offset that would name a period that has not happened', () => {
    expect(normalizePeriodLabelOffset(-5)).toBe(0)
    expect(normalizePeriodLabelOffset(99)).toBe(24)
    expect(normalizePeriodLabelOffset('nonsense')).toBe(1)
    expect(normalizePeriodLabelOffset(undefined)).toBe(1)
  })
})

describe('“purely a label not to change anything we have already done”', () => {
  /**
   * THE CONSTRAINT, tested directly rather than assumed.
   *
   * Every one of these is a thing the label must NOT be, and each has a real
   * failure behind it: a label that equalled the due date would invite someone
   * to sort by it; one that produced a period key ("2026-07") would invite a
   * report to group by it. It is prose for a human, and it is shaped like prose
   * so nothing is tempted to parse it.
   */
  it('is never the due date it came from', () => {
    for (const due of ['2026-08-15', '2026-01-01', '2026-12-31']) {
      expect(periodLabelFor(due, 'monthly', 1)).not.toBe(due)
      expect(periodLabelFor(due, 'monthly', 0)).not.toBe(due)
    }
  })

  it('is never a machine-shaped period key', () => {
    const keyish = /^\d{4}-\d{2}$/
    for (const [due, freq] of [
      ['2026-08-15', 'monthly'],
      ['2026-08-15', 'quarterly'],
      ['2026-08-15', 'annually'],
    ]) {
      expect(periodLabelFor(due, freq, 1)).not.toMatch(keyish)
    }
  })

  it('is pure — the same inputs always give the same answer, and no input is mutated', () => {
    const template = Object.freeze({
      periodLabelEnabled: true,
      frequency: 'monthly',
      periodLabelOffset: 1,
    })
    const first = periodLabelForInstance(template, '2026-08-15')
    const second = periodLabelForInstance(template, '2026-08-15')
    expect(first).toBe(second)
    expect(template.periodLabelOffset).toBe(1)
  })

  it('caps a hand-typed label rather than letting it become a paragraph', () => {
    expect(sanitizePeriodLabel(' Q3 books ')).toBe('Q3 books')
    expect(sanitizePeriodLabel('x'.repeat(200))).toHaveLength(60)
  })
})

describe('“and then the next would spring forward”', () => {
  /**
   * There is no counter and nothing to migrate: the label is derived from the
   * INSTANCE's own due date, so a template that keeps producing later instances
   * produces later labels for free. This walks a year of a monthly recipe.
   */
  it('advances by itself as the materializer moves the due date on', () => {
    const template = { periodLabelEnabled: true, frequency: 'monthly', periodLabelOffset: 1 }
    const dues = [
      '2026-08-15',
      '2026-09-15',
      '2026-10-15',
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
    ]
    expect(dues.map((due) => periodLabelForInstance(template, due))).toEqual([
      'July 2026',
      'August 2026',
      'September 2026',
      'October 2026',
      'November 2026',
      'December 2026',
    ])
  })

  it('advances a quarterly recipe a quarter at a time', () => {
    const template = { periodLabelEnabled: true, frequency: 'quarterly', periodLabelOffset: 1 }
    expect(
      ['2026-04-15', '2026-07-15', '2026-10-15', '2027-01-15'].map((due) =>
        periodLabelForInstance(template, due),
      ),
    ).toEqual(['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026'])
  })
})
