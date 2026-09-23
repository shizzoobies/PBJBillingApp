import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientRecap } from '../lib/api'
import { ClientRecapPage } from '../pages/ClientRecapPage'

/**
 * featreq-926862e2 rework — the SHAPE of the Client Recap page.
 *
 * The firm owner returned the shipped page with the layout redrawn on it:
 * Tasks & workflow dropped to the bottom, the hours tiles replaced by a table,
 * the Profitability tiles replaced by a table, the separate "Estimated vs.
 * actual" panel struck out entirely, and a Yearly view added next to Monthly
 * and Quarterly.
 *
 * Every one of those is a decision about ORDER and PRESENCE, which no unit test
 * of the calculator can see and which a tidy-up would silently undo. This file
 * renders the whole page and checks them.
 */

vi.mock('../lib/api', () => ({ fetchClientRecap: vi.fn() }))

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    visibleClients: [{ id: 'c1', name: '17 Signature' }],
  }),
}))

import { fetchClientRecap } from '../lib/api'

const mockFetch = vi.mocked(fetchClientRecap)

const RECAP: ClientRecap = {
  client: { id: 'c1', name: '17 Signature', billingMode: 'hourly' },
  periodType: 'quarter',
  period: '2026-Q1',
  periodLabel: 'Q1 2026',
  range: { start: '2026-01-01', end: '2026-03-31' },
  monthsInPeriod: 3,
  includeFinancials: true,
  time: {
    totalHours: 18.35,
    billableHours: 18.35,
    adminHours: 0,
    priorHours: 12,
    deltaHours: 6.35,
    byStaff: [
      { name: 'Brittany Ferguson', tier: 'CFO', hours: 8.13, billableHours: 8.13 },
      { name: 'Lisa Mockabee', tier: 'Bookkeeper', hours: 10.22, billableHours: 10.22 },
    ],
    byRole: [
      {
        tier: 'CFO',
        people: ['Brittany Ferguson'],
        estimatedHours: 9,
        actualHours: 8.13,
        deltaHours: -0.87,
        direction: 'under',
      },
      {
        tier: 'Bookkeeper',
        people: ['Lisa Mockabee'],
        estimatedHours: 9,
        actualHours: 10.22,
        deltaHours: 1.22,
        direction: 'over',
      },
    ],
    roleTotals: { estimatedHours: 18, actualHours: 18.35, deltaHours: 0.35, direction: 'over' },
    estimatesVisible: true,
    hasEstimate: true,
    unestimatedRoles: [],
    whereToSetEstimates: 'Client page → Estimated monthly hours',
  },
  tasks: {
    dueThisPeriod: [],
    dueCount: 0,
    completedCount: 0,
    overdueCount: 0,
    openCount: 0,
  },
  salesTax: { status: 'not_started', taskTitle: null, dueDate: null, figures: null },
  billing: {
    billingMode: 'hourly',
    hourlyRate: 120,
    monthlyRate: null,
    monthsInPeriod: 3,
    planNames: [],
    revenue: 2202,
    reimbursements: [],
    reimbursementTotal: 0,
  },
  profitability: { realizedRate: 120, laborCost: 480, margin: 1722 },
  estimates: {
    hasEstimate: true,
    monthsInPeriod: 3,
    whereToSet: 'Client page → Estimated monthly hours',
    byTier: [],
    cost: { estimated: 360, actual: 480, delta: 120, direction: 'over' },
    hours: { estimated: 18, actual: 18.35, delta: 0.35, direction: 'over' },
    profit: {
      estimatedRevenue: 2160,
      estimatedCost: 360,
      estimatedProfit: 1800,
      actualRevenue: 2202,
      actualCost: 480,
      actualProfit: 1722,
      delta: -78,
      direction: 'under',
      revenueDelta: 42,
      revenueDirection: 'over',
    },
  },
  projection: null,
}

const sectionHeadings = () =>
  screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)

describe('Client Recap page layout', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(RECAP)
  })

  it('puts Tasks & workflow LAST, below Billing and Profitability', async () => {
    render(<ClientRecapPage />)
    await waitFor(() => expect(sectionHeadings().length).toBeGreaterThan(0))
    expect(sectionHeadings()).toEqual([
      'Time & hours',
      'Billing',
      'Profitability',
      'Tasks & workflow',
    ])
  })

  it('has no separate "Estimated vs. actual" panel — it was absorbed', async () => {
    render(<ClientRecapPage />)
    await waitFor(() => expect(screen.getByText('Time & hours')).toBeInTheDocument())
    expect(screen.queryByText('Estimated vs. actual')).not.toBeInTheDocument()
  })

  it('shows hours and profit as tables, not as the stat tiles she struck out', async () => {
    render(<ClientRecapPage />)
    await waitFor(() => expect(screen.getByText('Time & hours')).toBeInTheDocument())
    // Time & hours and Profitability each get one; Billing and Tasks keep theirs.
    expect(screen.getAllByRole('table')).toHaveLength(2)
    expect(screen.queryByText('Total hours')).not.toBeInTheDocument()
    expect(screen.queryByText('Administrative')).not.toBeInTheDocument()
    expect(screen.queryByText(/Realized rate/)).not.toBeInTheDocument()
    expect(screen.queryByText('Margin')).not.toBeInTheDocument()
    // Billing still uses tiles — now her three: Estimated | Actual | Over/Under
    // (round two of this feature renamed them off the sent-back printout).
    expect(screen.getByText('Estimated invoice')).toBeInTheDocument()
    expect(screen.getByText('Actual invoice')).toBeInTheDocument()
  })
})

/**
 * A multi-month recap of a MONTHLY or ANNUAL client prices every month at the
 * client's fee and plan list AS THEY STAND NOW — those are single live values
 * and no history is kept of them. So a client whose fee moved in March has
 * January repriced at the new fee, and the quarter's or year's revenue will NOT
 * reconcile against the invoices actually issued. That is a real trap for a
 * firm owner reading a yearly recap next to her books, so it is said on the
 * panel rather than left to be discovered.
 *
 * An HOURLY client outgrew this warning once rate history landed — see the
 * 'after rate history' block at the foot of this file — so these fixtures name
 * a monthly client, which is who the warning is still for.
 */
describe('Client Recap page — Billing says when it is a restatement', () => {
  const MONTHLY_RECAP: ClientRecap = {
    ...RECAP,
    client: { ...RECAP.client, billingMode: 'subscription' },
    billing: {
      ...(RECAP.billing as NonNullable<ClientRecap['billing']>),
      billingMode: 'subscription',
    },
  }

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(MONTHLY_RECAP)
  })

  it('warns on a quarterly recap that the rates are today’s', async () => {
    render(<ClientRecapPage />)
    const caption = await screen.findByText(/Priced at the client's current rates and plans/)
    expect(caption).toHaveTextContent(/not the rates in force each month/)
    expect(caption).toHaveTextContent(/all 3 months/)
    expect(caption).toHaveTextContent(/part-way through the quarter/)
  })

  it('warns on a yearly recap, naming the year and all twelve months', async () => {
    mockFetch.mockResolvedValue({
      ...MONTHLY_RECAP,
      periodType: 'year',
      period: '2026',
      periodLabel: '2026',
      monthsInPeriod: 12,
    })
    render(<ClientRecapPage />)
    const caption = await screen.findByText(/Priced at the client's current rates and plans/)
    expect(caption).toHaveTextContent(/part-way through the year/)
    expect(caption).toHaveTextContent(/all 12 months/)
  })

  it('says nothing of the sort on a MONTHLY recap, where the figure IS the invoice', async () => {
    mockFetch.mockResolvedValue({
      ...MONTHLY_RECAP,
      periodType: 'month',
      period: '2026-01',
      periodLabel: 'January 2026',
      monthsInPeriod: 1,
    })
    render(<ClientRecapPage />)
    await waitFor(() => expect(screen.getByText('Actual invoice')).toBeInTheDocument())
    expect(
      screen.queryByText(/Priced at the client's current rates and plans/),
    ).not.toBeInTheDocument()
  })
})

describe('Client Recap page — the Yearly period', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(RECAP)
  })

  it('offers Yearly beside Monthly and Quarterly', async () => {
    render(<ClientRecapPage />)
    const toggle = screen.getByRole('group', { name: 'Review period' })
    expect(
      Array.from(toggle.querySelectorAll('button')).map((node) => node.textContent),
    ).toEqual(['Monthly', 'Quarterly', 'Yearly'])
  })

  it('asks the server for a bare 4-digit year, and steps by whole years', async () => {
    render(<ClientRecapPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Yearly' }))
    await waitFor(() =>
      expect(mockFetch.mock.calls.at(-1)).toEqual([
        'c1',
        'year',
        String(new Date().getFullYear()),
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }))
    await waitFor(() =>
      expect(mockFetch.mock.calls.at(-1)).toEqual([
        'c1',
        'year',
        String(new Date().getFullYear() - 1),
      ]),
    )
  })
})

/**
 * Rate history (docs/plans/rate-history-2026-09.md §5) made half of the caption
 * above a lie. An HOURLY client's months are now each priced at the pin that
 * applied IN that month, so a quarterly or yearly figure reconciles against the
 * invoices actually issued — the old warning would send the owner hunting for a
 * discrepancy that no longer exists. A MONTHLY or ANNUAL client still has one
 * live fee and one live plan list and no history at all, so for them the
 * warning is still true and must survive untouched.
 */
describe('the multi-month caption after rate history', () => {
  const RECAP_BILLING = RECAP.billing as NonNullable<ClientRecap['billing']>

  const renderRecap = async ({
    billingMode,
    monthsInPeriod,
    periodType,
  }: {
    billingMode: string
    monthsInPeriod: number
    periodType: ClientRecap['periodType']
  }) => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({
      ...RECAP,
      client: { ...RECAP.client, billingMode },
      periodType,
      monthsInPeriod,
      billing: { ...RECAP_BILLING, billingMode, monthsInPeriod },
    })
    render(<ClientRecapPage />)
    await waitFor(() => expect(screen.getByText('Actual invoice')).toBeInTheDocument())
  }

  it('tells an HOURLY client the months were priced at the rates in force each month', async () => {
    await renderRecap({ billingMode: 'hourly', monthsInPeriod: 3, periodType: 'quarter' })
    expect(screen.getByText(/the rates in force each month/i)).toBeInTheDocument()
    expect(screen.queryByText(/current rates and plans/i)).not.toBeInTheDocument()
  })

  it('still warns a MONTHLY client that plans are restated at today’s', async () => {
    await renderRecap({ billingMode: 'subscription', monthsInPeriod: 3, periodType: 'quarter' })
    expect(screen.getByText(/current rates and plans/i)).toBeInTheDocument()
  })

  it('says cost uses the rate on the day worked', async () => {
    await renderRecap({ billingMode: 'hourly', monthsInPeriod: 1, periodType: 'month' })
    // The note prints twice — once under the hours table, once inside the
    // profit definition — so this asks for every copy, not the only one.
    expect(
      screen.getAllByText(/the rate they were paid on the day they worked it/i).length,
    ).toBeGreaterThan(0)
  })
})
