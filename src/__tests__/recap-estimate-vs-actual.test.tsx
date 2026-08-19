import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ClientRecap, ClientRecapEstimates, ClientRecapProjection } from '../lib/api'
import {
  ProfitabilityCard,
  ProjectionCard,
  TimeAndHoursCard,
} from '../pages/ClientRecapPage'

/**
 * TRACKER featreq-926862e2, the reading half — reworked after the owner sent
 * the shipped version back with a marked-up printout.
 *
 * The separate "Estimated vs. actual" panel is gone; the comparison it made now
 * lives where the figures already were, as ESTIMATE | ACTUAL | OVER/UNDER
 * columns inside Time & hours (for hours) and Profitability (for profit).
 *
 * The maths is pinned in `lib/client-recap.js`'s tests. What is pinned HERE is
 * what the owner actually sees — specifically that a client with no estimate
 * (26 of 47 active clients) gets an honest label and not a red variance against
 * a zero nobody typed, that the Total row is really the rows added up, and that
 * an estimated figure never appears without the sentence explaining it.
 */

const TIME: ClientRecap['time'] = {
  totalHours: 18.35,
  billableHours: 18.35,
  adminHours: 0,
  priorHours: 12,
  deltaHours: 6.35,
  byStaff: [
    { name: 'Lisa Mockabee', tier: 'Bookkeeper', hours: 10.22, billableHours: 10.22 },
    { name: 'Jordan Reyes', tier: 'Accountant', hours: 8.13, billableHours: 8.13 },
  ],
  byRole: [
    {
      tier: 'Accountant',
      people: ['Jordan Reyes'],
      estimatedHours: 8,
      actualHours: 8.13,
      deltaHours: 0.13,
      direction: 'over',
    },
    {
      tier: 'Bookkeeper',
      people: ['Lisa Mockabee'],
      estimatedHours: 10,
      actualHours: 10.22,
      deltaHours: 0.22,
      direction: 'over',
    },
  ],
  roleTotals: { estimatedHours: 18, actualHours: 18.35, deltaHours: 0.35, direction: 'over' },
  estimatesVisible: true,
  hasEstimate: true,
  unestimatedRoles: [],
  whereToSetEstimates: 'Client page → Estimated monthly hours',
}

/**
 * A STAFF payload: same rows, same actual hours, estimates em-dashed because
 * they are owner-side planning data. `estimatesVisible: false` is what stops
 * the page offering "go set them on the Client page" to someone who can't.
 */
const TIME_STAFF: ClientRecap['time'] = {
  ...TIME,
  byRole: TIME.byRole.map((row) => ({
    ...row,
    estimatedHours: null,
    deltaHours: null,
    direction: null,
  })),
  roleTotals: { estimatedHours: null, actualHours: 18.35, deltaHours: null, direction: null },
  estimatesVisible: false,
  hasEstimate: false,
}

/** The same client with nothing filled in — the COMMON case in production. */
const TIME_NO_ESTIMATE: ClientRecap['time'] = {
  ...TIME,
  byRole: TIME.byRole.map((row) => ({
    ...row,
    estimatedHours: null,
    deltaHours: null,
    direction: null,
  })),
  roleTotals: { estimatedHours: null, actualHours: 18.35, deltaHours: null, direction: null },
  hasEstimate: false,
}

const PROFITABILITY: NonNullable<ClientRecap['profitability']> = {
  realizedRate: 120,
  laborCost: 480,
  margin: 960,
}

const ESTIMATES: ClientRecapEstimates = {
  hasEstimate: true,
  monthsInPeriod: 1,
  whereToSet: 'Client page → Estimated monthly hours',
  byTier: [],
  hours: { estimated: 18, actual: 18.35, delta: 0.35, direction: 'over' },
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

const NO_ESTIMATE: ClientRecapEstimates = {
  ...ESTIMATES,
  hasEstimate: false,
  profit: {
    ...ESTIMATES.profit,
    estimatedRevenue: null,
    estimatedCost: null,
    estimatedProfit: null,
    delta: null,
    direction: null,
  },
}

const roleRow = (tier: string) => screen.getByRole('row', { name: new RegExp(tier) })
const totalRow = () => screen.getByRole('row', { name: /^Total/ })

/**
 * Labor cost counts only people with a pay rate, so a client the owner works
 * alone shows its whole fee as profit. That is intended and it is not
 * guessable, so the note has to be on screen wherever cost or profit is.
 */
const LABOR_COST_NOTE = /Labor cost counts team members who have a pay rate on file/

describe('Time & hours — estimate, actual, over/under per role', () => {
  it('replaces the struck-out stat tiles with a per-role table', () => {
    render(<TimeAndHoursCard time={TIME} monthsInPeriod={1} />)
    // The four tiles she crossed out are gone, labels and all.
    expect(screen.queryByText('Total hours')).not.toBeInTheDocument()
    expect(screen.queryByText('Billable')).not.toBeInTheDocument()
    expect(screen.queryByText('Administrative')).not.toBeInTheDocument()
    expect(screen.queryByText(/vs\. prior/)).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Estimate' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Actual' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Over/Under' })).toBeInTheDocument()
  })

  it('names the row for the person who fills the role, and tags the role', () => {
    render(<TimeAndHoursCard time={TIME} monthsInPeriod={1} />)
    expect(roleRow('Bookkeeper')).toHaveTextContent('Lisa Mockabee')
    expect(roleRow('Accountant')).toHaveTextContent('Jordan Reyes')
  })

  it('reads 10.00 estimated, 10.22 worked, +0.22h over', () => {
    render(<TimeAndHoursCard time={TIME} monthsInPeriod={1} />)
    const cells = within(roleRow('Bookkeeper')).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('10.00h')
    expect(cells[2]).toHaveTextContent('10.22h')
    expect(cells[3]).toHaveTextContent('+0.22h over')
  })

  it('carries a Total row that is the rows added up, and subtracts', () => {
    render(<TimeAndHoursCard time={TIME} monthsInPeriod={1} />)
    const cells = within(totalRow()).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('18.00h') // 8 + 10
    expect(cells[2]).toHaveTextContent('18.35h') // 8.13 + 10.22
    expect(cells[3]).toHaveTextContent('+0.35h over') // 0.13 + 0.22
  })

  it('says a longer view multiplied the monthly estimate out', () => {
    render(<TimeAndHoursCard time={TIME} monthsInPeriod={12} />)
    expect(screen.getByRole('columnheader', { name: /monthly estimates × 12 months/ })).toBeInTheDocument()
  })

  it('explains why the Total can out-run the rows when a role has no estimate', () => {
    render(
      <TimeAndHoursCard
        time={{ ...TIME, unestimatedRoles: ['Other'] }}
        monthsInPeriod={1}
      />,
    )
    expect(screen.getByText(/hours but no estimate/)).toHaveTextContent(
      /count toward the Total's over\/under/,
    )
  })
})

describe('Time & hours — no estimate set', () => {
  it('banners it honestly and points at where to set it', () => {
    render(<TimeAndHoursCard time={TIME_NO_ESTIMATE} monthsInPeriod={1} />)
    expect(screen.getByText(/No estimate set for this client/)).toHaveTextContent(
      /Estimated monthly hours/,
    )
  })

  it('offers NO such banner to a staff member, who cannot act on it', () => {
    render(<TimeAndHoursCard time={TIME_STAFF} monthsInPeriod={1} />)
    expect(screen.queryByText(/No estimate set for this client/)).not.toBeInTheDocument()
    // The table itself is still there, with the hours they are entitled to see.
    expect(within(roleRow('Bookkeeper')).getAllByRole('cell')[2]).toHaveTextContent('10.22h')
    expect(within(roleRow('Bookkeeper')).getAllByRole('cell')[1]).toHaveTextContent(
      'No estimate set',
    )
    expect(within(totalRow()).getAllByRole('cell')[3]).toHaveTextContent('—')
  })

  it('renders NO variance — not a zero, not a red number, not a direction', () => {
    render(<TimeAndHoursCard time={TIME_NO_ESTIMATE} monthsInPeriod={1} />)
    const variance = within(roleRow('Bookkeeper')).getAllByRole('cell')[3]
    expect(variance).toHaveTextContent('—')
    expect(variance.className).not.toMatch(/recap-variance-(bad|good)/)
    expect(within(totalRow()).getAllByRole('cell')[3]).toHaveTextContent('—')
    expect(screen.queryByText(/over$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/under$/)).not.toBeInTheDocument()
  })

  it('still reports the actual hours it does know, row and Total', () => {
    render(<TimeAndHoursCard time={TIME_NO_ESTIMATE} monthsInPeriod={1} />)
    expect(within(roleRow('Bookkeeper')).getAllByRole('cell')[2]).toHaveTextContent('10.22h')
    expect(within(totalRow()).getAllByRole('cell')[2]).toHaveTextContent('18.35h')
  })
})

describe('Profitability — estimate, actual, over/under for profit', () => {
  it('drops the struck-out realized-rate and margin tiles for the three columns', () => {
    render(
      <ProfitabilityCard
        profitability={PROFITABILITY}
        estimates={ESTIMATES}
        monthsInPeriod={1}
      />,
    )
    expect(screen.queryByText(/Realized rate/)).not.toBeInTheDocument()
    expect(screen.queryByText('Margin')).not.toBeInTheDocument()
    const cells = within(screen.getByRole('row', { name: /Profit this period/ })).getAllByRole(
      'cell',
    )
    expect(cells[1]).toHaveTextContent('$800.00')
    expect(cells[2]).toHaveTextContent('$960.00') // the old margin, unchanged
    expect(cells[3]).toHaveTextContent('+$160.00 over')
  })

  it('shows the actual profit and no variance when there is no estimate', () => {
    render(
      <ProfitabilityCard
        profitability={PROFITABILITY}
        estimates={NO_ESTIMATE}
        monthsInPeriod={1}
      />,
    )
    const cells = within(screen.getByRole('row', { name: /Profit this period/ })).getAllByRole(
      'cell',
    )
    expect(cells[1]).toHaveTextContent('No estimate set')
    expect(cells[2]).toHaveTextContent('$960.00')
    expect(cells[3]).toHaveTextContent('—')
    expect(cells[3].className).not.toMatch(/recap-variance-(bad|good)/)
  })

  it('states the definitions of estimated and actual profit on screen', () => {
    render(
      <ProfitabilityCard
        profitability={PROFITABILITY}
        estimates={ESTIMATES}
        monthsInPeriod={1}
      />,
    )
    const caption = screen.getByText(/Estimated profit = expected revenue/)
    expect(caption).toHaveTextContent(/estimated hours × that role's cost rate/)
    expect(caption).toHaveTextContent(/Actual profit = invoiced service revenue/)
    expect(caption).toHaveTextContent(/Reimbursements are excluded from both sides/)
  })

  it('states the labor-cost basis, which is where cost and profit both appear', () => {
    render(
      <ProfitabilityCard
        profitability={PROFITABILITY}
        estimates={NO_ESTIMATE}
        monthsInPeriod={1}
      />,
    )
    expect(screen.getByText(LABOR_COST_NOTE)).toBeInTheDocument()
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
