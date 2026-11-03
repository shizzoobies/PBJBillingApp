import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ClientRecap, ClientRecapEstimates } from '../lib/api'
import { ProfitabilityCard, TimeAndHoursCard } from '../pages/ClientRecapPage'
import {
  activeMonthsSentence,
  activeSpanLabel,
  scaledEstimateNote,
} from '../lib/recapActiveMonths'

/**
 * featreq-8dffdff7 (Client Recap): "the client started in August, but the
 * aggregate of data pulls as if the client was active all year". A quarter or
 * a year now counts only the months the client was active, and the page says
 * which months those were - the server decides (lib/client-recap.js); these
 * tests pin the words.
 */

const TIME: ClientRecap['time'] = {
  totalHours: 15,
  billableHours: 15,
  adminHours: 0,
  priorHours: 0,
  deltaHours: 15,
  byStaff: [{ name: 'Lisa Mockabee', tier: 'Bookkeeper', hours: 15, billableHours: 15 }],
  byRole: [
    {
      tier: 'Bookkeeper',
      people: ['Lisa Mockabee'],
      estimatedHours: 40,
      actualHours: 15,
      deltaHours: -25,
      direction: 'under',
    },
  ],
  roleTotals: { estimatedHours: 40, actualHours: 15, deltaHours: -25, direction: 'under' },
  estimatesVisible: true,
  hasEstimate: true,
  unestimatedRoles: [],
  whereToSetEstimates: 'Client page → Estimated monthly hours',
}

/** Bright Tower, viewed Yearly 2026 in November: August through November count. */
const AUGUST_STARTER = {
  monthsInPeriod: 4,
  calendarMonthsInPeriod: 12,
  activeMonths: ['2026-08', '2026-09', '2026-10', '2026-11'],
  activeInPeriod: true,
  clientSince: '2026-08',
  range: { start: '2026-01-01', end: '2026-12-31' },
}

const ESTIMATES: ClientRecapEstimates = {
  hasEstimate: true,
  monthsInPeriod: 4,
  whereToSet: 'Client page → Estimated monthly hours',
  byTier: [],
  cost: { estimated: 1600, actual: 600, delta: -1000, direction: 'under' },
  hours: { estimated: 40, actual: 15, delta: -25, direction: 'under' },
  profit: {
    estimatedRevenue: 3600,
    estimatedCost: 1600,
    estimatedProfit: 2000,
    actualRevenue: 3600,
    actualCost: 600,
    actualProfit: 3000,
    delta: 1000,
    direction: 'over',
    revenueDelta: 0,
    revenueDirection: 'on',
    serviceValue: 1800,
    serviceValueDelta: -1800,
    serviceValueDirection: 'under',
  },
}

describe('the Estimate header names the months it counted', () => {
  it('a client that started in August, by year', () => {
    render(<TimeAndHoursCard time={TIME} monthsInPeriod={4} activity={AUGUST_STARTER} />)
    expect(
      screen.getByRole('columnheader', {
        name: 'Estimate (monthly estimates × 4 months: Aug–Nov 2026, client since Aug 2026)',
      }),
    ).toBeInTheDocument()
  })

  it('keeps the old wording when every month of the period counted', () => {
    render(
      <TimeAndHoursCard
        time={TIME}
        monthsInPeriod={12}
        activity={{
          ...AUGUST_STARTER,
          monthsInPeriod: 12,
          activeMonths: Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`),
          clientSince: '2024-03',
          range: { start: '2025-01-01', end: '2025-12-31' },
        }}
      />,
    )
    expect(
      screen.getByRole('columnheader', { name: 'Estimate (monthly estimates × 12 months)' }),
    ).toBeInTheDocument()
  })

  it('leaves out "client since" for a client on file before the period began', () => {
    expect(
      scaledEstimateNote(11, {
        ...AUGUST_STARTER,
        monthsInPeriod: 11,
        // A 2026 yearly view in November: December has not begun.
        activeMonths: Array.from({ length: 11 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
        clientSince: '2025-05',
      }),
    ).toBe(' (monthly estimates × 11 months: Jan–Nov 2026)')
  })

  it('the Profitability estimate says the same, and the caption says which months', () => {
    render(
      <ProfitabilityCard
        profitability={{ realizedRate: 240, laborCost: 600, margin: 3000 }}
        estimates={ESTIMATES}
        monthsInPeriod={4}
        activity={AUGUST_STARTER}
      />,
    )
    expect(
      screen.getByRole('columnheader', { name: /monthly estimates × 4 months: Aug–Nov 2026/ }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Counted 4 of 12 months \(Aug–Nov 2026\)/)).toBeInTheDocument()
  })
})

describe('a period the client was not active in', () => {
  const NOT_ACTIVE = {
    monthsInPeriod: 0,
    calendarMonthsInPeriod: 3,
    activeMonths: [] as string[],
    activeInPeriod: false,
    clientSince: '2026-08',
    range: { start: '2026-01-01', end: '2026-03-31' },
  }

  it('says "Not active in this period" instead of "No estimate set"', () => {
    render(<TimeAndHoursCard time={{ ...TIME, hasEstimate: false }} monthsInPeriod={0} activity={NOT_ACTIVE} />)
    expect(screen.getByText(/Not active in this period — client since Aug 2026/)).toBeInTheDocument()
    expect(screen.queryByText(/No estimate set for this client/)).not.toBeInTheDocument()
  })

  it('the caption names the first month on record', () => {
    expect(activeMonthsSentence(NOT_ACTIVE)).toMatch(
      /Not active in this period — this client’s first activity on record is Aug 2026/,
    )
  })
})

describe('a billing master', () => {
  it('says each company was scaled by its own months', () => {
    const master = {
      isBillingMaster: true,
      monthsInPeriod: 11,
      calendarMonthsInPeriod: 12,
      activeMonths: ['2026-01', '2026-11'],
      activeMonthsUniform: false,
      subs: [
        { id: 'a', name: 'KLC Floors', monthsInPeriod: 11 },
        { id: 'b', name: 'KLC & More', monthsInPeriod: 4 },
      ],
    }
    expect(scaledEstimateNote(11, master)).toBe(' (monthly estimates × each company’s own active months)')
    expect(activeMonthsSentence(master)).toMatch(/KLC Floors 11 of 12, KLC & More 4 of 12/)
  })
})

describe('month spans', () => {
  it('reads as a short range', () => {
    expect(activeSpanLabel(['2026-08', '2026-09'])).toBe('Aug–Sep 2026')
    expect(activeSpanLabel(['2026-11'])).toBe('Nov 2026')
    expect(activeSpanLabel(['2025-12', '2026-01'])).toBe('Dec 2025–Jan 2026')
    expect(activeSpanLabel([])).toBe('')
  })
})

describe('why months were left out', () => {
  it('a client active all along, current year: December has simply not started', () => {
    const sentence = activeMonthsSentence({
      monthsInPeriod: 11,
      calendarMonthsInPeriod: 12,
      activeMonths: Array.from({ length: 11 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
      activeInPeriod: true,
      clientSince: '2025-05',
      uncountedMonths: { beforeStart: [], notYetBegun: ['2026-12'], afterLastActivity: [] },
      range: { start: '2026-01-01', end: '2026-12-31' },
    })
    expect(sentence).toBe('Counted 11 of 12 months (Jan–Nov 2026). Left out: Dec 2026 has not started yet.')
    expect(sentence).not.toMatch(/inactive|before the client/)
  })

  it('an August starter names both reasons', () => {
    expect(
      activeMonthsSentence({
        ...AUGUST_STARTER,
        uncountedMonths: {
          beforeStart: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'],
          notYetBegun: ['2026-12'],
          afterLastActivity: [],
        },
      }),
    ).toBe(
      'Counted 4 of 12 months (Aug–Nov 2026). Left out: Jan–Jul 2026 is before the client’s first activity on record; Dec 2026 has not started yet.',
    )
  })
})

describe('a period that has not started yet', () => {
  const NEXT_QUARTER = {
    monthsInPeriod: 0,
    calendarMonthsInPeriod: 3,
    activeMonths: [] as string[],
    activeInPeriod: false,
    periodNotStarted: true,
    clientSince: '2025-05',
    range: { start: '2027-01-01', end: '2027-03-31' },
  }

  it('says the period has not started, and never calls the client inactive', () => {
    render(
      <TimeAndHoursCard time={{ ...TIME, byRole: [], hasEstimate: false }} monthsInPeriod={0} activity={NEXT_QUARTER} />,
    )
    expect(screen.getByText(/This period hasn.t started yet/)).toBeInTheDocument()
    expect(screen.queryByText(/Not active/)).not.toBeInTheDocument()
    expect(activeMonthsSentence(NEXT_QUARTER)).toBe(
      'This period hasn’t started yet, so nothing is planned or priced for it.',
    )
  })

  it('the Profitability estimate reads "Not started yet", not "No estimate set"', () => {
    render(
      <ProfitabilityCard
        profitability={{ realizedRate: null, laborCost: 0, margin: 0 }}
        estimates={{
          ...ESTIMATES,
          hasEstimate: false,
          monthsInPeriod: 0,
          profit: { ...ESTIMATES.profit, estimatedRevenue: null, estimatedCost: null, estimatedProfit: null, delta: null, direction: null },
        }}
        monthsInPeriod={0}
        activity={NEXT_QUARTER}
      />,
    )
    expect(screen.getByText('Not started yet')).toBeInTheDocument()
    expect(screen.queryByText('No estimate set')).not.toBeInTheDocument()
  })
})
