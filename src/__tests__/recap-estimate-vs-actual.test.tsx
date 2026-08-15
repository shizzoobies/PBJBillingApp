import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ClientRecap, ClientRecapEstimates, ClientRecapProjection } from '../lib/api'
import {
  EstimateVsActualCard,
  ProfitabilityCard,
  ProjectionCard,
} from '../pages/ClientRecapPage'

/**
 * TRACKER featreq-926862e2, the reading half.
 *
 * The maths is pinned in `lib/client-recap-estimates.test.mjs`. What is pinned
 * HERE is what the owner actually sees — specifically that a client with no
 * estimate (26 of 47 active clients) gets an honest label and not a red
 * variance against a zero nobody typed, and that an estimated figure never
 * appears without the sentence explaining how it was arrived at.
 */

const ESTIMATES: ClientRecapEstimates = {
  hasEstimate: true,
  monthsInPeriod: 1,
  whereToSet: 'Client page → Estimated monthly hours',
  byTier: [
    {
      tier: 'Bookkeeper',
      estimatedHours: 10,
      actualHours: 12,
      deltaHours: 2,
      direction: 'over',
      costRate: 40,
      costRateBasis: 'assigned',
      costRatePeopleCount: 1,
      estimatedCost: 400,
      actualCost: 480,
    },
  ],
  hours: { estimated: 10, actual: 12, delta: 2, direction: 'over' },
  profit: {
    estimatedRevenue: 1200,
    estimatedCost: 400,
    estimatedProfit: 800,
    actualRevenue: 1440,
    actualCost: 480,
    actualProfit: 960,
    delta: 160,
    direction: 'over',
  },
}

/** The same client with nothing filled in — the COMMON case in production. */
const NO_ESTIMATE: ClientRecapEstimates = {
  ...ESTIMATES,
  hasEstimate: false,
  byTier: [
    {
      ...ESTIMATES.byTier[0],
      estimatedHours: null,
      deltaHours: null,
      direction: null,
      estimatedCost: null,
    },
  ],
  hours: { estimated: null, actual: 12, delta: null, direction: null },
  profit: {
    ...ESTIMATES.profit,
    estimatedRevenue: 1200,
    estimatedCost: null,
    estimatedProfit: null,
    delta: null,
    direction: null,
  },
}

const bookkeeperRow = () => screen.getByRole('row', { name: /Bookkeeper/ })

/**
 * Labor cost counts only people with a pay rate, so a client the owner works
 * alone shows its whole fee as profit. That is intended and it is not
 * guessable, so the note has to be on screen wherever cost or profit is.
 */
const LABOR_COST_NOTE = /Labor cost counts team members who have a pay rate on file/

describe('the labor-cost basis is stated wherever cost or profit appears', () => {
  it('on the Profitability panel', () => {
    const profitability: NonNullable<ClientRecap['profitability']> = {
      realizedRate: 120,
      laborCost: 0,
      margin: 1500,
    }
    render(<ProfitabilityCard profitability={profitability} />)
    // Margin is a figure, never a withheld dash, even at zero cost.
    expect(screen.getByText('$1,500.00')).toBeInTheDocument()
    expect(screen.getByText(LABOR_COST_NOTE)).toBeInTheDocument()
  })

  it('on the Estimated vs. actual panel', () => {
    render(<EstimateVsActualCard estimates={ESTIMATES} periodType="month" />)
    expect(screen.getByText(LABOR_COST_NOTE)).toBeInTheDocument()
  })

  it('on the Estimated vs. actual panel even when no estimate is set', () => {
    render(<EstimateVsActualCard estimates={NO_ESTIMATE} periodType="month" />)
    expect(screen.getByText(LABOR_COST_NOTE)).toBeInTheDocument()
  })
})

describe('Estimated vs. actual card', () => {
  it('shows the owner’s example as 10 estimated, 12 worked, +2.00h over', () => {
    render(<EstimateVsActualCard estimates={ESTIMATES} periodType="month" />)
    const cells = within(bookkeeperRow()).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('10.00h')
    expect(cells[2]).toHaveTextContent('12.00h')
    expect(cells[3]).toHaveTextContent('+2.00h over')
  })

  it('states the definitions of estimated and actual profit on screen', () => {
    render(<EstimateVsActualCard estimates={ESTIMATES} periodType="month" />)
    expect(screen.getByText(/Estimated profit = expected revenue/)).toHaveTextContent(
      /estimated hours × that role's cost rate/,
    )
    expect(screen.getByText(/Estimated profit = expected revenue/)).toHaveTextContent(
      /Actual profit = invoiced service revenue/,
    )
  })

  it('says a quarterly view multiplied the monthly estimate out', () => {
    render(
      <EstimateVsActualCard
        estimates={{ ...ESTIMATES, monthsInPeriod: 3 }}
        periodType="quarter"
      />,
    )
    expect(screen.getByText(/monthly estimates × 3 months/)).toBeInTheDocument()
  })
})

describe('Estimated vs. actual card — no estimate set', () => {
  it('labels it honestly and points at where to set it', () => {
    render(<EstimateVsActualCard estimates={NO_ESTIMATE} periodType="month" />)
    expect(screen.getByText(/No estimate set for this client/)).toHaveTextContent(
      /Estimated monthly hours/,
    )
    expect(within(bookkeeperRow()).getAllByRole('cell')[1]).toHaveTextContent('No estimate set')
  })

  it('renders NO variance — not a zero, not a red number, not a direction', () => {
    render(<EstimateVsActualCard estimates={NO_ESTIMATE} periodType="month" />)
    const variance = within(bookkeeperRow()).getAllByRole('cell')[3]
    expect(variance).toHaveTextContent('—')
    expect(variance.className).not.toMatch(/recap-variance-(bad|good)/)
    expect(screen.queryByText(/over$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/under$/)).not.toBeInTheDocument()
  })

  it('still reports the actual hours it does know', () => {
    render(<EstimateVsActualCard estimates={NO_ESTIMATE} periodType="month" />)
    expect(within(bookkeeperRow()).getAllByRole('cell')[2]).toHaveTextContent('12.00h')
  })
})

describe('Projected invoice card', () => {
  const hourly: ClientRecapProjection = {
    basis: 'hourly',
    isEstimate: true,
    amount: 3024,
    serviceAmount: 3024,
    reimbursementsToDate: 0,
    hoursToDate: 12,
    businessDaysElapsed: 10,
    businessDaysInMonth: 21,
    method:
      'Estimate — projected from 12.00 billable hours over 10 of 21 business days. Reimbursements are only those already recorded.',
  }

  it('calls a projection an estimate and prints how it was projected', () => {
    render(<ProjectionCard projection={hourly} />)
    expect(screen.getByRole('heading', { name: /Projected end-of-month invoice/ })).toHaveTextContent(
      'Estimate',
    )
    expect(screen.getByText(/12.00 billable hours over 10 of 21 business days/)).toBeInTheDocument()
  })

  it('drops the estimate framing once the month is closed', () => {
    render(
      <ProjectionCard
        projection={{
          ...hourly,
          basis: 'actual',
          isEstimate: false,
          method: 'August 2026 is closed — this is the invoice as it stands, not a projection.',
        }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'End-of-month invoice' })).toBeInTheDocument()
    expect(screen.getByText(/Invoice total/)).toBeInTheDocument()
    expect(screen.queryByText('Estimate')).not.toBeInTheDocument()
  })
})
