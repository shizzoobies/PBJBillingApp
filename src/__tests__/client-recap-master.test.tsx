import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRecapPage } from '../pages/ClientRecapPage'
import { ApiError } from '../lib/types'
import type { ClientRecap } from '../lib/api'

/**
 * The Client Recap page for a BILLING MASTER.
 *
 * The master's recap is the roll-up of its subs' recaps — `buildMasterRecap`
 * SUMS what `buildClientRecap` already produced, it never re-derives anything
 * from rows. So the page's job is threefold and each part is pinned here:
 *
 *   1. render the rolled-up figures in the layout a normal recap already uses,
 *      so nothing about reading the page has to be relearned;
 *   2. list the companies behind those figures, each a way into its own recap —
 *      "how did we get this number" is answered by opening a company;
 *   3. be HONEST about the two figures that cannot be added. Sales tax and the
 *      projection come back null with stated reasons, and they render as em
 *      dashes WITH those reasons: a zero would be a lie and an omission would
 *      read as a page that failed to load.
 *
 * An ordinary client's recap is unchanged, which is asserted rather than
 * assumed — every branch above is new code on a page that already worked.
 */

vi.mock('../lib/api', () => ({
  fetchClientRecap: vi.fn(),
}))

const visibleClients = [
  { id: 'client-klc-master', name: 'KLC Master' },
  { id: 'client-chemtrex', name: 'Chemtrex' },
]

vi.mock('../AppContext', () => ({
  useAppContext: () => ({ visibleClients }),
}))

import { fetchClientRecap } from '../lib/api'

const mockRecap = vi.mocked(fetchClientRecap)

/** The parts every recap has, master or not. */
const baseRecap: ClientRecap = {
  client: { id: 'client-chemtrex', name: 'Chemtrex', billingMode: 'subscription' },
  periodType: 'month',
  period: '2026-09',
  periodLabel: 'September 2026',
  range: { start: '2026-09-01', end: '2026-09-30' },
  monthsInPeriod: 1,
  includeFinancials: true,
  time: {
    totalHours: 12,
    billableHours: 10,
    adminHours: 2,
    priorHours: 11,
    deltaHours: 1,
    byStaff: [],
    byRole: [
      {
        tier: 'Bookkeeper',
        people: ['Lisa'],
        estimatedHours: 10,
        actualHours: 12,
        deltaHours: 2,
        direction: 'over',
      },
    ],
    roleTotals: { estimatedHours: 10, actualHours: 12, deltaHours: 2, direction: 'over' },
    estimatesVisible: true,
    hasEstimate: true,
    unestimatedRoles: [],
    whereToSetEstimates: 'Client page',
  },
  tasks: { dueThisPeriod: [], dueCount: 0, completedCount: 0, overdueCount: 0, openCount: 0 },
  salesTax: { status: 'open', taskTitle: 'File sales tax', dueDate: '2026-10-20', figures: null },
  billing: {
    billingMode: 'subscription',
    hourlyRate: null,
    monthlyRate: 300,
    monthsInPeriod: 1,
    planNames: ['The Classic'],
    revenue: 300,
    reimbursements: [],
    reimbursementTotal: 0,
  },
  profitability: { realizedRate: 25, laborCost: 120, margin: 180 },
  estimates: null,
  projection: {
    basis: 'plan',
    isEstimate: true,
    amount: 300,
    serviceAmount: 300,
    reimbursementsToDate: 0,
    hoursToDate: 12,
    businessDaysElapsed: 20,
    businessDaysInMonth: 22,
    method: 'Fixed plan fee plus reimbursements recorded so far.',
  },
}

/** The roll-up: summed figures, the subs, and the two honest nulls. */
const masterRecap: ClientRecap = {
  ...baseRecap,
  client: { id: 'client-klc-master', name: 'KLC Master', billingMode: null },
  isBillingMaster: true,
  subs: [
    { id: 'client-klc', name: 'KLC Floors & More' },
    { id: 'client-chemtrex', name: 'Chemtrex' },
  ],
  billing: { ...baseRecap.billing!, billingMode: null, monthlyRate: null, revenue: 1250 },
  profitability: { realizedRate: 52.08, laborCost: 400, margin: 850 },
  salesTax: null,
  projection: null,
}

beforeEach(() => {
  mockRecap.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ClientRecapPage — a billing master', () => {
  it('renders the rolled-up figures in the ordinary recap layout', async () => {
    mockRecap.mockResolvedValue(masterRecap)
    render(<ClientRecapPage />)

    // Billing and profitability read exactly as they do for one company.
    expect(await screen.findByText('$1,250.00')).toBeInTheDocument()
    expect(screen.getByText('Revenue this period')).toBeInTheDocument()
    expect(screen.getByText('$850.00')).toBeInTheDocument()
    // …and the time table is the same ESTIMATE | ACTUAL | OVER/UNDER one.
    expect(screen.getByText('Time & hours')).toBeInTheDocument()
  })

  it('says the page is a roll-up, and of how many companies', async () => {
    mockRecap.mockResolvedValue(masterRecap)
    render(<ClientRecapPage />)

    expect(await screen.findByText('A monthly roll-up of 2 companies.')).toBeInTheDocument()
  })

  it('lists the companies behind the figures, each opening its own recap', async () => {
    mockRecap.mockResolvedValue(masterRecap)
    render(<ClientRecapPage />)

    expect(await screen.findByText('Companies in this roll-up')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open KLC Floors & More’s recap' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Chemtrex’s recap' })).toBeInTheDocument()
  })

  // A rate averaged across four companies would be a fifth number nobody pays.
  it('em-dashes the rate rather than printing $0.00/mo', async () => {
    mockRecap.mockResolvedValue(masterRecap)
    render(<ClientRecapPage />)

    expect(await screen.findByText('Rate — set per company')).toBeInTheDocument()
    expect(screen.queryByText('$0.00/mo')).not.toBeInTheDocument()
  })

  it('em-dashes sales tax and the projection, each with its reason', async () => {
    mockRecap.mockResolvedValue(masterRecap)
    render(<ClientRecapPage />)

    expect(await screen.findByText('Not rolled up')).toBeInTheDocument()
    expect(screen.getByText('Sales tax')).toBeInTheDocument()
    expect(screen.getByText('Projected end-of-month invoice')).toBeInTheDocument()
    expect(
      screen.getByText(/A filing per company, each with its own status and due date/),
    ).toBeInTheDocument()
    expect(screen.getByText(/A projection carries a basis/)).toBeInTheDocument()

    // The projection CARD — the one that would state a figure — is not on the
    // page at all; the row above is what stands in its place.
    expect(screen.queryByText('Projected total')).not.toBeInTheDocument()
  })

  // 409 master_without_subs: misconfigured, not broken. It gets a sentence, not
  // the alarm styling, and no stale recap is left underneath it.
  it('states the server’s sentence when the master has no companies yet', async () => {
    mockRecap.mockRejectedValue(
      new ApiError(
        409,
        'This billing master has no active sub clients yet, so there is nothing to roll up.',
        'master_without_subs',
      ),
    )
    render(<ClientRecapPage />)

    const notice = await screen.findByText(
      'This billing master has no active sub clients yet, so there is nothing to roll up.',
    )
    expect(notice).toBeInTheDocument()
    expect(document.querySelector('.auth-error')).toBeNull()
    expect(screen.queryByText('Companies in this roll-up')).not.toBeInTheDocument()
  })

  // 403 master_subs_not_visible: a bookkeeper assigned some of the group but
  // not all of it. A partial roll-up would look like the whole group's numbers,
  // so the server declines — but partial assignment is a normal way for a
  // workspace to be arranged, not that person doing anything wrong.
  it('states the server’s sentence when the caller cannot see every company', async () => {
    mockRecap.mockRejectedValue(
      new ApiError(
        403,
        'The combined view needs access to every company in the group.',
        'master_subs_not_visible',
      ),
    )
    render(<ClientRecapPage />)

    expect(
      await screen.findByText('The combined view needs access to every company in the group.'),
    ).toBeInTheDocument()
    expect(document.querySelector('.auth-error')).toBeNull()
  })

  it('still shows a real failure as an error', async () => {
    mockRecap.mockRejectedValue(new ApiError(500, 'Failed to load recap (500)'))
    render(<ClientRecapPage />)

    await waitFor(() => expect(document.querySelector('.auth-error')).not.toBeNull())
    expect(screen.getByText('Failed to load recap (500)')).toBeInTheDocument()
  })
})

describe('ClientRecapPage — an ordinary client is unchanged', () => {
  it('shows no roll-up furniture and keeps its own rate and projection', async () => {
    mockRecap.mockResolvedValue(baseRecap)
    render(<ClientRecapPage />)

    expect(await screen.findByText('A monthly review of one client.')).toBeInTheDocument()
    expect(screen.queryByText('Companies in this roll-up')).not.toBeInTheDocument()
    expect(screen.queryByText('Not rolled up')).not.toBeInTheDocument()
    expect(screen.getByText('Monthly rate')).toBeInTheDocument()
    expect(screen.getByText('$300.00/mo')).toBeInTheDocument()
    expect(screen.getByText('Projected total')).toBeInTheDocument()
  })
})
