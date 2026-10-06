import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientRecap } from '../lib/api'
import { ClientRecapPage } from '../pages/ClientRecapPage'

/**
 * Client Recap export (featreq-0f761138, Alex): a Download CSV button beside
 * the period controls hands the current recap - whichever client and period
 * are showing - to the shared CSV download, named by client and period.
 */

vi.mock('../lib/api', () => ({ fetchClientRecap: vi.fn() }))
vi.mock('../lib/csv', () => ({ downloadCsv: vi.fn() }))

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    visibleClients: [{ id: 'c1', name: '17 Signature' }],
  }),
}))

import { fetchClientRecap } from '../lib/api'
import { downloadCsv } from '../lib/csv'

const mockFetch = vi.mocked(fetchClientRecap)
const mockDownload = vi.mocked(downloadCsv)

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
    byStaff: [{ name: 'Lisa Mockabee', tier: 'Bookkeeper', hours: 18.35, billableHours: 18.35 }],
    byRole: [
      {
        tier: 'Bookkeeper',
        people: ['Lisa Mockabee'],
        estimatedHours: 18,
        actualHours: 18.35,
        deltaHours: 0.35,
        direction: 'over',
      },
    ],
    roleTotals: { estimatedHours: 18, actualHours: 18.35, deltaHours: 0.35, direction: 'over' },
    estimatesVisible: true,
    hasEstimate: true,
    unestimatedRoles: [],
    whereToSetEstimates: 'Client page → Estimated monthly hours',
  },
  tasks: { dueThisPeriod: [], dueCount: 0, completedCount: 0, overdueCount: 0, openCount: 0 },
  salesTax: null,
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
      serviceValue: 2202,
      serviceValueDelta: 0,
      serviceValueDirection: 'on',
    },
  },
  projection: null,
}

beforeEach(() => {
  mockFetch.mockReset()
  mockDownload.mockReset()
  mockFetch.mockResolvedValue(RECAP)
})

describe('Client Recap - Download CSV', () => {
  it('downloads the recap that is showing, named by client and period, with every figure in it', async () => {
    render(<ClientRecapPage />)
    await screen.findByText('Service value')

    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [filename, headers, rows] = mockDownload.mock.calls[0]
    expect(filename).toBe('client-recap-17-signature-2026-Q1.csv')
    expect(headers).toEqual(['Section', 'Row', 'Field', 'Value'])
    expect(rows).toContainEqual(['Billing', '', 'Service value', 2202])
    expect(rows).toContainEqual(['Period', '', 'Label', 'Q1 2026'])
    expect(rows).toContainEqual(['Time & hours', 'Bookkeeper', 'Actual (hours)', 18.35])
  })

  it('exports the recap on screen after the period changes, never the first one loaded', async () => {
    const NEXT: ClientRecap = {
      ...RECAP,
      period: '2026-Q2',
      periodLabel: 'Q2 2026',
      range: { start: '2026-04-01', end: '2026-06-30' },
      estimates: {
        ...RECAP.estimates!,
        profit: { ...RECAP.estimates!.profit, serviceValue: 999 },
      },
    }
    mockFetch.mockResolvedValueOnce(RECAP).mockResolvedValueOnce(NEXT)
    render(<ClientRecapPage />)
    await screen.findByText('Q1 2026')

    fireEvent.click(screen.getByRole('button', { name: 'Next period' }))
    await screen.findByText('Q2 2026')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    const [filename, , rows] = mockDownload.mock.calls[0]
    expect(filename).toBe('client-recap-17-signature-2026-Q2.csv')
    expect(rows).toContainEqual(['Billing', '', 'Service value', 999])
  })

  it('waits until the recap has loaded', async () => {
    let release: (value: ClientRecap) => void = () => {}
    mockFetch.mockReturnValue(
      new Promise<ClientRecap>((resolve) => {
        release = resolve
      }),
    )
    render(<ClientRecapPage />)
    const button = screen.getByRole('button', { name: 'Download CSV' })
    expect(button).toBeDisabled()
    release(RECAP)
    await waitFor(() => expect(button).toBeEnabled())
  })
})
