import { describe, expect, it } from 'vitest'

import {
  TIME_BREAKDOWN_MODES,
  buildInvoiceLines,
  normalizeTimeBreakdownMode,
  timeBreakdownLines,
} from './invoice-lines.js'

/**
 * The optional time breakdown — Brittany, 2026-08-25:
 *
 *   "Time breakdown should be an auto off. As of now I just want the
 *   subscription line and price and the expense reimbursement line and price
 *   and then for the clients I choose I can click the time breakdown.
 *     For time breakdown
 *       It should be Show by person and total with amount for that person with
 *       the option to turn on billing amount for that person too.
 *         So basically, with our current group there would be a total of 3
 *         lines with total hours for the month.
 *       Next option by day/week by person same options as above.
 *       And then the option to have every entry for the month.
 *     All should only show total not like clock in clock out times just xx hours"
 *
 * THE INVARIANT EVERYTHING ELSE RESTS ON: these lines never carry money. The
 * breakdown explains an invoice, it does not price one — so no setting on this
 * feature, in any combination, can move a total. That is asserted directly
 * rather than inferred, because it is the only thing standing between an
 * informational display and a double bill.
 */

const employees = [
  { id: 'e-lisa', name: 'Lisa', billRate: 100 },
  { id: 'e-alli', name: 'Allison', billRate: 150 },
  { id: 'e-britt', name: 'Brittany', billRate: 200 },
]

const rateFor = (id) => employees.find((e) => e.id === id)?.billRate ?? 0

// A month with all three people, someone working twice in one day, and work in
// two different weeks — enough to tell the four modes apart.
const entries = [
  { employeeId: 'e-lisa', minutes: 90, date: '2026-08-03', description: 'Bank rec' },
  { employeeId: 'e-lisa', minutes: 30, date: '2026-08-03', description: 'Email' },
  { employeeId: 'e-lisa', minutes: 120, date: '2026-08-11', description: 'Payroll' },
  { employeeId: 'e-alli', minutes: 60, date: '2026-08-04', description: 'Review' },
  { employeeId: 'e-britt', minutes: 45, date: '2026-08-05', description: 'Call' },
]

const build = (mode, showAmounts = false) =>
  timeBreakdownLines({ entries, employees, mode, showAmounts, rateFor })

describe('the breakdown carries no money, in any mode', () => {
  it('every line is $0.00, always', () => {
    for (const mode of TIME_BREAKDOWN_MODES) {
      for (const showAmounts of [false, true]) {
        const lines = timeBreakdownLines({ entries, employees, mode, showAmounts, rateFor })
        for (const line of lines) {
          expect(line.amount, `${mode}/${showAmounts}: ${line.label}`).toBe(0)
        }
      }
    }
  })

  it('is tagged as its own kind, so nothing downstream mistakes it for a charge', () => {
    expect(build('person').every((line) => line.kind === 'time_detail')).toBe(true)
  })
})

describe('off is the default and the fallback', () => {
  it('produces nothing', () => {
    expect(build('off')).toEqual([])
  })

  // A bad value must never START printing a client's hours. Off is the safe
  // direction, so everything unrecognized lands there.
  it('treats anything unrecognized as off', () => {
    expect(normalizeTimeBreakdownMode(undefined)).toBe('off')
    expect(normalizeTimeBreakdownMode(null)).toBe('off')
    expect(normalizeTimeBreakdownMode('PERSON')).toBe('off')
    expect(normalizeTimeBreakdownMode('everything')).toBe('off')
    expect(build(undefined)).toEqual([])
  })
})

describe('by person — "3 lines with total hours for the month"', () => {
  it('gives one line per person, alphabetically, with their month total', () => {
    const lines = build('person')
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.label)).toEqual(['Allison', 'Brittany', 'Lisa'])
    // Lisa's three entries — 1.5 + 0.5 + 2 — add up on one line.
    expect(lines[2].detail).toBe('4.00 hours')
    expect(lines[0].detail).toBe('1.00 hours')
  })

  it('adds what the time was worth only when she asks for it', () => {
    expect(build('person', false)[2].detail).toBe('4.00 hours')
    expect(build('person', true)[2].detail).toBe('4.00 hours · $400.00')
  })
})

describe('by day and by week', () => {
  it('splits a person by day, folding two entries on the same day together', () => {
    const lines = build('day')
    const lisa = lines.filter((l) => l.label.startsWith('Lisa'))
    expect(lisa.map((l) => l.label)).toEqual(['Lisa — Aug 3, 2026', 'Lisa — Aug 11, 2026'])
    expect(lisa[0].detail).toBe('2.00 hours')
  })

  it('splits a person by week, using the same week anchor as the timesheet', () => {
    const lisa = build('week').filter((l) => l.label.startsWith('Lisa'))
    expect(lisa.map((l) => l.label)).toEqual([
      'Lisa — week of Aug 2, 2026',
      'Lisa — week of Aug 9, 2026',
    ])
    expect(lisa[0].detail).toBe('2.00 hours')
  })
})

describe('every entry', () => {
  it('gives one line per entry, with what was done', () => {
    const lines = build('entry')
    expect(lines).toHaveLength(entries.length)
    expect(lines.find((l) => l.detail.includes('Bank rec')).detail).toBe(
      'Aug 3, 2026 · Bank rec · 1.50 hours',
    )
  })

  it('does not fall over on an entry with no description', () => {
    const lines = timeBreakdownLines({
      entries: [{ employeeId: 'e-lisa', minutes: 60, date: '2026-08-03', description: '   ' }],
      employees,
      mode: 'entry',
      rateFor,
    })
    expect(lines[0].detail).toBe('Aug 3, 2026 · Work · 1.00 hours')
  })
})

describe('"just xx hours" — her rule about clock times', () => {
  // The one thing she was explicit about twice. A start/end time reaching a
  // client's invoice is the failure this whole block exists to prevent.
  it('never prints a clock time, in any mode', () => {
    const clockish = /\d{1,2}:\d{2}|\bam\b|\bpm\b|started|ended/i
    for (const mode of TIME_BREAKDOWN_MODES) {
      for (const line of build(mode, true)) {
        expect(`${line.label} ${line.detail}`, mode).not.toMatch(clockish)
      }
    }
  })

  it('always says hours to two decimals', () => {
    for (const line of build('person')) expect(line.detail).toMatch(/^\d+\.\d{2} hours$/)
  })
})

/* -------------------------------------------------------------------------- */
/* On a real invoice                                                          */
/* -------------------------------------------------------------------------- */

const timeEntries = entries.map((entry, index) => ({
  ...entry,
  id: `t${index}`,
  clientId: 'client-1',
  billable: true,
  date: entry.date,
}))

const subscriptionClient = (over = {}) => ({
  id: 'client-1',
  name: 'Acme',
  billingMode: 'subscription',
  monthlyRate: 500,
  hourlyRate: 0,
  planIds: [],
  ...over,
})

const hourlyClient = (over = {}) => ({
  id: 'client-1',
  name: 'Acme',
  billingMode: 'hourly',
  monthlyRate: 0,
  hourlyRate: 125,
  planIds: [],
  ...over,
})

const draft = (client) =>
  buildInvoiceLines({
    client,
    entries: timeEntries,
    employees,
    billingPeriod: '2026-08',
    defaultHourlyRate: 125,
  })

describe('a subscription invoice — the case she described', () => {
  it('shows the service line and nothing about time, by default', () => {
    const { lines, total } = draft(subscriptionClient())
    expect(lines.map((l) => l.kind)).toEqual(['plan'])
    expect(total).toBe(500)
  })

  it('adds the breakdown under the service line when she switches it on', () => {
    const { lines, total } = draft(
      subscriptionClient({ invoiceTimeBreakdownMode: 'person' }),
    )
    expect(lines[0].kind).toBe('plan')
    expect(lines.slice(1).map((l) => l.kind)).toEqual(['time_detail', 'time_detail', 'time_detail'])
    // THE POINT: she still owes exactly the monthly fee.
    expect(total).toBe(500)
  })

  it('leaves the total alone in every mode, with and without amounts', () => {
    for (const mode of TIME_BREAKDOWN_MODES) {
      for (const invoiceTimeBreakdownAmounts of [false, true]) {
        const { total } = draft(
          subscriptionClient({ invoiceTimeBreakdownMode: mode, invoiceTimeBreakdownAmounts }),
        )
        expect(total, `${mode}/${invoiceTimeBreakdownAmounts}`).toBe(500)
      }
    }
  })
})

describe('an hourly invoice', () => {
  it('bills per person as it always has, and adds no breakdown by default', () => {
    const { lines, total } = draft(hourlyClient())
    expect(lines.every((l) => l.kind === 'hourly')).toBe(true)
    expect(lines).toHaveLength(3)
    expect(total).toBeCloseTo(4 * 100 + 1 * 150 + 0.75 * 200, 10)
  })

  /**
   * 'person' is deliberately a NO-OP here. An hourly invoice's charge lines are
   * already one per person with hours and money on them; an informational copy
   * would print every name twice and read as a double bill.
   */
  it('does not repeat itself when the mode is per person', () => {
    const withMode = draft(hourlyClient({ invoiceTimeBreakdownMode: 'person' }))
    expect(withMode.lines.filter((l) => l.kind === 'time_detail')).toHaveLength(0)
    expect(withMode.lines).toHaveLength(3)
  })

  it('adds real detail for the finer modes, still without changing the total', () => {
    const plain = draft(hourlyClient())
    for (const mode of ['day', 'week', 'entry']) {
      const { lines, total } = draft(hourlyClient({ invoiceTimeBreakdownMode: mode }))
      expect(lines.filter((l) => l.kind === 'time_detail').length, mode).toBeGreaterThan(0)
      expect(total, mode).toBeCloseTo(plain.total, 10)
    }
  })
})
