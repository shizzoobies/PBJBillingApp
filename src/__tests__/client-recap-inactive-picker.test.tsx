import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientRecap } from '../lib/api'
import type { Client } from '../lib/types'
import { ClientRecapPage } from '../pages/ClientRecapPage'

/**
 * featreq-60f24838 rework — the Client Recap picker hides retired clients.
 *
 * She sent the shipped "exclude inactive clients" work back with: "I can still
 * see inactive clients on client recap - I want to be able to recap old
 * clients but not on a regular basis." So the picker offers ACTIVE clients by
 * default and an "Include inactive clients" checkbox puts the retired ones
 * back, marked "(inactive)".
 *
 * Both halves of that need holding down. Hiding them is the request; still
 * being ABLE to reach them is the other half of the same sentence, and a
 * tidy-up that turned the filter into a prohibition would read as a fix. The
 * third case is the one that bites without a test: the page's default client
 * is a fallback to the first of the list, so a retired client whose name sorts
 * first would open the page on a company that left.
 */

vi.mock('../lib/api', () => ({ fetchClientRecap: vi.fn() }))

let mockVisibleClients: Client[] = []

vi.mock('../AppContext', () => ({
  useAppContext: () => ({ visibleClients: mockVisibleClients }),
}))

import { fetchClientRecap } from '../lib/api'

const mockFetch = vi.mocked(fetchClientRecap)

const client = (id: string, name: string, inactive = false) =>
  ({ id, name, ...(inactive ? { lifecycleStage: 'inactive' } : {}) }) as unknown as Client

/** Minimal, mirroring the fixture in recap-page-sections.test.tsx. */
const recapFor = (id: string, name: string): ClientRecap => ({
  client: { id, name, billingMode: 'hourly' },
  periodType: 'month',
  period: '2026-09',
  periodLabel: 'September 2026',
  range: { start: '2026-09-01', end: '2026-09-30' },
  monthsInPeriod: 1,
  includeFinancials: true,
  time: {
    totalHours: 4,
    billableHours: 4,
    adminHours: 0,
    priorHours: 4,
    deltaHours: 0,
    byStaff: [],
    byRole: [],
    roleTotals: { estimatedHours: 4, actualHours: 4, deltaHours: 0, direction: 'on' },
    estimatesVisible: true,
    hasEstimate: true,
    unestimatedRoles: [],
    whereToSetEstimates: 'Client page → Estimated monthly hours',
  },
  tasks: { dueThisPeriod: [], dueCount: 0, completedCount: 0, overdueCount: 0, openCount: 0 },
  salesTax: { status: 'not_started', taskTitle: null, dueDate: null, figures: null },
  billing: {
    billingMode: 'hourly',
    hourlyRate: 120,
    monthlyRate: null,
    monthsInPeriod: 1,
    planNames: [],
    revenue: 480,
    reimbursements: [],
    reimbursementTotal: 0,
  },
  profitability: { realizedRate: 120, laborCost: 0, margin: 480 },
  estimates: null,
  projection: null,
})

const optionLabels = () =>
  Array.from(
    (screen.getByLabelText('Client') as HTMLSelectElement).querySelectorAll('option'),
  ).map((node) => node.textContent)

const lastFetchedClientId = () => mockFetch.mock.calls.at(-1)?.[0]

describe('Client Recap picker — inactive clients (featreq-60f24838)', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((id: string) =>
      Promise.resolve(recapFor(id, id === 'c-gone' ? 'Zenith Dental' : 'Acme Bakery')),
    )
    mockVisibleClients = [
      client('c-acme', 'Acme Bakery'),
      client('c-gone', 'Zenith Dental', true),
      client('c-cove', 'Cove Coffee'),
    ]
  })

  it('offers only the active clients, and opens on the first of them', async () => {
    render(<ClientRecapPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())

    expect(optionLabels()).toEqual(['Acme Bakery', 'Cove Coffee'])
    expect(lastFetchedClientId()).toBe('c-acme')
  })

  it('puts the retired ones back — marked — when she ticks the box', async () => {
    render(<ClientRecapPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())

    fireEvent.click(screen.getByLabelText('Include inactive clients'))
    expect(optionLabels()).toEqual(['Acme Bakery', 'Zenith Dental (inactive)', 'Cove Coffee'])

    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c-gone' } })
    await waitFor(() => expect(lastFetchedClientId()).toBe('c-gone'))
  })

  it('drops back to the first active client when she unticks it', async () => {
    render(<ClientRecapPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())

    const box = screen.getByLabelText('Include inactive clients')
    fireEvent.click(box)
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c-gone' } })
    await waitFor(() => expect(lastFetchedClientId()).toBe('c-gone'))

    fireEvent.click(box)
    await waitFor(() => expect(lastFetchedClientId()).toBe('c-acme'))
    expect(optionLabels()).toEqual(['Acme Bakery', 'Cove Coffee'])
  })

  it('never opens on a retired client, even when one sorts first', async () => {
    mockVisibleClients = [
      client('c-gone', 'Zenith Dental', true),
      client('c-acme', 'Acme Bakery'),
    ]
    render(<ClientRecapPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())

    expect(lastFetchedClientId()).toBe('c-acme')
    expect(optionLabels()).toEqual(['Acme Bakery'])
  })
})
