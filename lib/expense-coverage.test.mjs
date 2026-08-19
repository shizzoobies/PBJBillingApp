import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COVERAGE_TEMPLATE,
  addMonthsClamped,
  anchorDayFromRange,
  anchorDayOf,
  normalizeRecurringReimbursement,
  applyCoverageTemplate,
  coverageLineLabel,
  coverageStepMonths,
  formatCoverageDate,
  formatCoverageRange,
  hasUnconfirmedCoverage,
  nextCoverageRange,
  resolveCoverageForPeriod,
  withDayClamped,
} from './expense-coverage.js'
import { buildInvoiceLines } from './invoice-lines.js'

/**
 * Covered-date windows on reimbursed expenses.
 *
 * THE CHORE THIS ENDS: the QuickBooks subscription runs the 13th of one month
 * to the 13th of the next, and its invoice line has to say so. The wording never
 * changes; only the two dates inside it do, and retyping them every cycle is the
 * whole of the job being removed.
 *
 * THE THING THAT MUST NOT HAPPEN: a window advancing twice for one month, or
 * striding silently across months nobody billed. The first would tell a client
 * they are paying for September when the invoice is August's; the second would
 * bill a window nobody checked. Idempotency and the confirmation gate are what
 * these tests are really about — everything else is arithmetic in service of
 * them.
 */

const QBO = {
  id: 'recur-qbo',
  clientId: 'c1',
  description: 'QuickBooks Online',
  amount: 90,
  frequency: 'monthly',
  startDate: '2026-07-01',
  coverageEnabled: true,
  coverageTemplate: DEFAULT_COVERAGE_TEMPLATE,
  coverageStart: '2026-07-13',
  coverageEnd: '2026-08-13',
  coverageHistory: {},
}

const withHistory = (history, overrides = {}) => ({ ...QBO, coverageHistory: history, ...overrides })

describe('the cycle steps a month at a time, anchored on a day', () => {
  it('walks the 13th to the 13th', () => {
    expect(nextCoverageRange({ start: '2026-07-13', end: '2026-08-13' }, { months: 1, anchorDay: 13 }))
      .toEqual({ start: '2026-08-13', end: '2026-09-13' })
  })

  it('rolls over the year end', () => {
    expect(nextCoverageRange({ start: '2026-11-13', end: '2026-12-13' }, { months: 1, anchorDay: 13 }))
      .toEqual({ start: '2026-12-13', end: '2027-01-13' })
  })

  it('clamps into a short month rather than spilling into the next one', () => {
    // Jan 31 + a month is the end of February, not the 3rd of March.
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29')
  })

  // The anchor is the POINT of "13th to 13th". A cycle that clamped to the 28th
  // in February and then stayed there would have quietly moved the client's
  // billing day, permanently, because of one short month.
  it('comes back to the anchor day after a short month clamped it', () => {
    const february = nextCoverageRange(
      { start: '2025-12-31', end: '2026-01-31' },
      { months: 1, anchorDay: 31 },
    )
    expect(february).toEqual({ start: '2026-01-31', end: '2026-02-28' })

    const march = nextCoverageRange(february, { months: 1, anchorDay: 31 })
    expect(march).toEqual({ start: '2026-02-28', end: '2026-03-31' })
  })

  it('leaves a mid-month anchor untouched by the clamping', () => {
    expect(withDayClamped('2026-02-13', 13)).toBe('2026-02-13')
  })

  // THE STORED ANCHOR. Deriving it from the seed window meant a range the owner
  // had CONFIRMED onto another day snapped back on the next advance — moving an
  // end from the 13th to the 20th and then proposing the 13th again bills a
  // 23-day period at the full monthly price, silently.
  it('advances on the stored anchor, not on the seed window’s day', () => {
    const moved = {
      ...QBO,
      coverageAnchorDay: 20,
      coverageHistory: { '2026-11': { start: '2026-10-20', end: '2026-11-20' } },
    }
    expect(resolveCoverageForPeriod(moved, '2026-12')).toMatchObject({
      start: '2026-11-20',
      end: '2026-12-20',
    })
  })

  it('falls back to the seed window’s day for a row written before the anchor existed', () => {
    const legacy = {
      ...QBO,
      coverageAnchorDay: null,
      coverageHistory: { '2026-08': { start: '2026-07-13', end: '2026-08-13' } },
    }
    expect(anchorDayOf(legacy)).toBe(13)
    expect(resolveCoverageForPeriod(legacy, '2026-09')).toMatchObject({ end: '2026-09-13' })
  })

  it('reads the anchor a confirmed window implies', () => {
    expect(anchorDayFromRange('2026-11-20')).toBe(20)
    expect(anchorDayFromRange('nope')).toBeNull()
  })

  it('steps by the expense’s own frequency', () => {
    expect(coverageStepMonths('monthly')).toBe(1)
    expect(coverageStepMonths('quarterly')).toBe(3)
    expect(coverageStepMonths('annually')).toBe(12)
    expect(
      nextCoverageRange({ start: '2026-01-13', end: '2026-04-13' }, { months: 3, anchorDay: 13 }),
    ).toEqual({ start: '2026-04-13', end: '2026-07-13' })
  })

  // The windows TOUCH. A gap or an overlap between two invoices is a question
  // from the client, and there is no good answer to it.
  it('starts the next window on the day the last one ended', () => {
    const first = { start: '2026-07-13', end: '2026-08-13' }
    const second = nextCoverageRange(first, { months: 1, anchorDay: 13 })
    expect(second.start).toBe(first.end)
  })
})

describe('the dates read as American English', () => {
  it('prints one year when both ends share it', () => {
    expect(formatCoverageRange('2026-07-13', '2026-08-13')).toBe('July 13 – August 13, 2026')
  })

  it('prints both years when the window crosses one', () => {
    expect(formatCoverageRange('2026-12-13', '2027-01-13')).toBe(
      'December 13, 2026 – January 13, 2027',
    )
  })

  it('gives a lone date its year', () => {
    expect(formatCoverageDate('2026-08-13')).toBe('August 13, 2026')
  })
})

describe('the wording is written once and filled in per cycle', () => {
  const values = { start: '2026-07-13', end: '2026-08-13', description: 'QuickBooks Online' }

  it('substitutes the collapsed range', () => {
    expect(applyCoverageTemplate('{description} — {range}', values)).toBe(
      'QuickBooks Online — July 13 – August 13, 2026',
    )
  })

  // `{start}` and `{end}` are FULL dates, so a template using only one of them
  // still says which year.
  it('substitutes full dates for the separate placeholders', () => {
    expect(applyCoverageTemplate('Covering {start} through {end}', values)).toBe(
      'Covering July 13, 2026 through August 13, 2026',
    )
  })

  it('leaves text with no placeholders alone', () => {
    expect(applyCoverageTemplate('QuickBooks subscription', values)).toBe(
      'QuickBooks subscription',
    )
  })

  it('falls back to the default wording when none was saved', () => {
    expect(coverageLineLabel({ ...QBO, coverageTemplate: '' }, { start: '2026-07-13', end: '2026-08-13' }))
      .toBe('QuickBooks Online — July 13 – August 13, 2026')
  })
})

describe('what window does this period cover', () => {
  it('uses the range she typed for the first cycle, and does not ask', () => {
    expect(resolveCoverageForPeriod(QBO, '2026-08')).toMatchObject({
      start: '2026-07-13',
      end: '2026-08-13',
      needsConfirmation: false,
      source: 'seed',
    })
  })

  it('steps forward from the last billed window', () => {
    const expense = withHistory({ '2026-08': { start: '2026-07-13', end: '2026-08-13' } })
    expect(resolveCoverageForPeriod(expense, '2026-09')).toMatchObject({
      start: '2026-08-13',
      end: '2026-09-13',
      needsConfirmation: false,
      source: 'advance',
    })
  })

  // THE IDEMPOTENCY GUARANTEE, at the level of the pure resolver. Void and
  // regenerate August and the window must be August's again, not September's.
  it('hands back the stored window for a period already billed', () => {
    const expense = withHistory({ '2026-08': { start: '2026-07-13', end: '2026-08-13' } })
    const first = resolveCoverageForPeriod(expense, '2026-08')
    const second = resolveCoverageForPeriod(expense, '2026-08')
    expect(first).toMatchObject({ start: '2026-07-13', end: '2026-08-13', source: 'ledger' })
    expect(second).toEqual(first)
  })

  it('does not care which order the ledger’s periods were written in', () => {
    const expense = withHistory({
      '2026-09': { start: '2026-08-13', end: '2026-09-13' },
      '2026-07': { start: '2026-06-13', end: '2026-07-13' },
      '2026-08': { start: '2026-07-13', end: '2026-08-13' },
    })
    // September is the latest, so October steps from IT.
    expect(resolveCoverageForPeriod(expense, '2026-10')).toMatchObject({
      start: '2026-09-13',
      end: '2026-10-13',
      needsConfirmation: false,
    })
  })

  it('carries nothing at all when the expense has no coverage configured', () => {
    expect(resolveCoverageForPeriod({ ...QBO, coverageEnabled: false }, '2026-08')).toBeNull()
    expect(resolveCoverageForPeriod({ ...QBO, coverageStart: null }, '2026-08')).toBeNull()
  })
})

describe('a skipped cycle asks before it bills', () => {
  // The owner's decision: do NOT stride across the gap. Propose ONE step and
  // make her look at it.
  it('flags a period that is not the one after the last billed', () => {
    const expense = withHistory({ '2026-08': { start: '2026-07-13', end: '2026-08-13' } })
    const resolved = resolveCoverageForPeriod(expense, '2026-11')
    expect(resolved).toMatchObject({
      start: '2026-08-13',
      end: '2026-09-13',
      needsConfirmation: true,
      reason: 'gap',
    })
  })

  it('does not flag the ordinary consecutive cycle', () => {
    const expense = withHistory({ '2026-08': { start: '2026-07-13', end: '2026-08-13' } })
    expect(resolveCoverageForPeriod(expense, '2026-09').needsConfirmation).toBe(false)
  })

  // A quarterly expense's "next" is three months on, so August->November is
  // consecutive for it and must not be mistaken for a gap.
  it('measures the gap in the expense’s own cycle length', () => {
    const quarterly = withHistory(
      { '2026-08': { start: '2026-05-13', end: '2026-08-13' } },
      { frequency: 'quarterly' },
    )
    expect(resolveCoverageForPeriod(quarterly, '2026-11').needsConfirmation).toBe(false)
    expect(resolveCoverageForPeriod(quarterly, '2027-02').needsConfirmation).toBe(true)
  })

  it('flags the first invoice after a pause is lifted', () => {
    const resumed = withHistory(
      { '2026-08': { start: '2026-07-13', end: '2026-08-13' } },
      { coverageResumePending: true },
    )
    expect(resolveCoverageForPeriod(resumed, '2026-09')).toMatchObject({
      needsConfirmation: true,
      reason: 'resumed',
    })
  })

  it('keeps a stored question a question until it is answered', () => {
    const asked = withHistory({
      '2026-11': { start: '2026-08-13', end: '2026-09-13', needsConfirmation: true, reason: 'gap' },
    })
    expect(resolveCoverageForPeriod(asked, '2026-11')).toMatchObject({
      needsConfirmation: true,
      reason: 'gap',
      source: 'ledger',
    })
  })

  // Generating a month BEHIND one already billed cannot be reasoned forward
  // from anything — the cycle has moved past it. Proposed and asked about.
  it('flags a period generated behind one already billed', () => {
    const expense = withHistory({ '2026-09': { start: '2026-08-13', end: '2026-09-13' } })
    expect(resolveCoverageForPeriod(expense, '2026-07')).toMatchObject({
      needsConfirmation: true,
      reason: 'backfill',
      source: 'seed',
    })
  })

  it('flags a backfill that also lands mid-history', () => {
    const expense = withHistory({
      '2026-07': { start: '2026-06-13', end: '2026-07-13' },
      '2026-10': { start: '2026-09-13', end: '2026-10-13' },
    })
    expect(resolveCoverageForPeriod(expense, '2026-08')).toMatchObject({
      needsConfirmation: true,
      reason: 'backfill',
      source: 'advance',
    })
  })

  it('spots an unconfirmed window among a set of lines', () => {
    expect(hasUnconfirmedCoverage([{ kind: 'hourly' }, { kind: 'recurring' }])).toBe(false)
    expect(
      hasUnconfirmedCoverage([
        { kind: 'hourly' },
        { kind: 'recurring', needsCoverageConfirmation: true },
      ]),
    ).toBe(true)
  })
})

describe('the window reaches the invoice line', () => {
  const client = { id: 'c1', billingMode: 'subscription', monthlyRate: 500 }
  const build = (recurring, period = '2026-08') =>
    buildInvoiceLines({
      client,
      billingPeriod: period,
      recurringReimbursements: [recurring],
    })

  it('puts her wording, with this cycle’s dates, on the line', () => {
    const { lines } = build(QBO)
    const line = lines.find((entry) => entry.kind === 'recurring')
    expect(line.label).toBe('QuickBooks Online — July 13 – August 13, 2026')
    expect(line).toMatchObject({
      recurringId: 'recur-qbo',
      coverageStart: '2026-07-13',
      coverageEnd: '2026-08-13',
      needsCoverageConfirmation: false,
      amount: 90,
    })
  })

  it('carries the question onto the line when a cycle was skipped', () => {
    const skipped = withHistory({ '2026-08': { start: '2026-07-13', end: '2026-08-13' } })
    const { lines } = build(skipped, '2026-11')
    const line = lines.find((entry) => entry.kind === 'recurring')
    expect(line).toMatchObject({
      needsCoverageConfirmation: true,
      coverageReason: 'gap',
      coverageStart: '2026-08-13',
      coverageEnd: '2026-09-13',
    })
  })

  // The feature is opt-in. An expense that does not name its covered period
  // must produce byte-for-byte the line it always did.
  it('leaves an expense without coverage exactly as it was', () => {
    const plain = {
      id: 'recur-plain',
      clientId: 'c1',
      description: 'Annual filing fee',
      amount: 40,
      frequency: 'monthly',
      startDate: '2026-07-01',
    }
    const { lines } = build(plain)
    expect(lines.find((entry) => entry.kind === 'recurring')).toEqual({
      kind: 'recurring',
      label: 'Recurring: Annual filing fee',
      detail: 'monthly',
      amount: 40,
    })
  })

  it('bills nothing at all while the expense is paused', () => {
    const { lines, total } = build({ ...QBO, coveragePaused: true })
    expect(lines.some((entry) => entry.kind === 'recurring')).toBe(false)
    expect(total).toBe(500)
  })
})

describe('one definition of a stored expense’s shape', () => {
  // Cardinal rule 1 in miniature: a row written before this feature has none of
  // these fields, and the two backends were filling that absence differently.
  it('gives a pre-feature record every coverage field, switched off', () => {
    expect(
      normalizeRecurringReimbursement({
        id: 'recur-old',
        clientId: 'c1',
        description: 'Annual filing fee',
        amount: 40,
        frequency: 'monthly',
        startDate: '2026-01-01',
      }),
    ).toMatchObject({
      coverageEnabled: false,
      coverageTemplate: '',
      coverageStart: null,
      coverageEnd: null,
      coverageAnchorDay: null,
      coveragePaused: false,
      coverageResumePending: false,
      coverageHistory: {},
    })
  })

  it('refuses a ledger that is not a map, and an anchor that is not a day', () => {
    for (const bad of [[], 'nope', 7]) {
      expect(normalizeRecurringReimbursement({ coverageHistory: bad }).coverageHistory).toEqual({})
    }
    for (const bad of [0, 32, 'the 13th', 4.5, null]) {
      expect(
        normalizeRecurringReimbursement({ coverageAnchorDay: bad }).coverageAnchorDay,
      ).toBeNull()
    }
    expect(normalizeRecurringReimbursement({ coverageAnchorDay: 13 }).coverageAnchorDay).toBe(13)
  })

  it('leaves the fields it is not about alone', () => {
    expect(
      normalizeRecurringReimbursement({ id: 'recur-1', description: 'QBO', amount: 90 }),
    ).toMatchObject({ id: 'recur-1', description: 'QBO', amount: 90 })
  })
})

describe('a line with no expense behind it gets no invented wording', () => {
  // The default template leads with `{description}`, so rendering one anyway
  // titles the line "— August 13 – September 13, 2026" — a dangling dash where
  // the expense used to be.
  it('returns nothing when the expense has been deleted', () => {
    expect(coverageLineLabel(null, { start: '2026-08-13', end: '2026-09-13' })).toBeNull()
    expect(coverageLineLabel(undefined, { start: '2026-08-13', end: '2026-09-13' })).toBeNull()
  })

  it('still returns nothing when there is no window either', () => {
    expect(coverageLineLabel(QBO, null)).toBeNull()
  })
})
