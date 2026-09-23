import { render, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from '../pages/ReportsPage'
import { DEFAULT_FIRM_SETTINGS } from '../lib/types'
import type { AppContextValue } from '../AppContext'

/**
 * Projected billing on the Client report follows the client's pin.
 *
 * This page prices every client with the same `getInvoice` the month run uses,
 * so it has the same blind spot: with no rate versions in hand it fell back to
 * each person's LIVE bill rate and projected a raise onto clients that had not
 * been reviewed yet. Acme is pinned to June, so its September hour is $40 here
 * — the number the invoice will actually carry.
 */

vi.mock('../lib/api', () => ({
  fetchRateVersions: vi.fn(),
  fetchTeam: vi.fn(),
}))
vi.mock('../lib/csv', () => ({ downloadCsv: vi.fn() }))
vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

import { fetchRateVersions, fetchTeam } from '../lib/api'

const mockFetchTeam = vi.mocked(fetchTeam)
const mockRateVersions = vi.mocked(fetchRateVersions)

const client = {
  id: 'client-acme',
  name: 'Acme',
  contact: '',
  billingMode: 'hourly',
  hourlyRate: 0,
  hourlyRatePeriod: '2026-06',
  planIds: [],
  contactIds: [],
}

let contextValue: AppContextValue

beforeEach(() => {
  mockFetchTeam.mockReset()
  mockFetchTeam.mockResolvedValue({
    users: [{ id: 'emp-avery', costRate: null }],
  } as unknown as Awaited<ReturnType<typeof fetchTeam>>)

  mockRateVersions.mockReset()
  mockRateVersions.mockResolvedValue({
    billRateVersions: [
      { userId: 'emp-avery', effectivePeriod: '2026-06', rate: 40 },
      { userId: 'emp-avery', effectivePeriod: '2026-09', rate: 60 },
    ],
    costRateVersions: [],
  } as unknown as Awaited<ReturnType<typeof fetchRateVersions>>)

  contextValue = {
    ownerMode: true,
    billingPeriod: '2026-09',
    firmSettings: DEFAULT_FIRM_SETTINGS,
    data: {
      // The live bill rate mirrors the newest version, which is what this page
      // used to project onto every client regardless of its pin.
      employees: [{ id: 'emp-avery', name: 'Avery Stone', billRate: 60 }],
      inactiveEmployees: [],
      timeEntries: [
        {
          id: 'entry-1',
          date: '2026-09-10',
          clientId: 'client-acme',
          employeeId: 'emp-avery',
          minutes: 60,
          billable: true,
          isAdministrative: false,
          taskId: null,
          taskLabel: 'Bookkeeping',
          description: 'Monthly close',
          workSessions: [],
        },
      ],
      clients: [client],
      plans: [],
      checklists: [],
      reimbursements: [],
      recurringReimbursements: [],
    },
  } as unknown as AppContextValue
})

/** The Client report's row for Acme, as plain text cells. */
function clientRow(container: HTMLElement) {
  const heading = within(container).getByText('Client report')
  const table = heading.closest('section')?.querySelector('table') as HTMLTableElement
  const row = table.querySelector('tbody tr') as HTMLTableRowElement
  return [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')
}

describe('ReportsPage projects a pinned client at its pin', () => {
  it('bills a June-pinned client at June money for September hours', async () => {
    const { container } = render(<ReportsPage />)
    await waitFor(() => expect(mockRateVersions).toHaveBeenCalled())

    await waitFor(() => expect(clientRow(container)).toContain('$40.00'))
    // Not today's $60 rate. (Scoped to this row on purpose: the Employee report
    // above values a person's billable hours at their live rate, which is a
    // firm-wide figure with no client — and no pin — behind it.)
    expect(clientRow(container)).not.toContain('$60.00')
  })
})
