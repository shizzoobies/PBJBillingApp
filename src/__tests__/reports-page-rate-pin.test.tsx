import { render, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from '../pages/ReportsPage'
import { DEFAULT_FIRM_SETTINGS } from '../lib/types'
import type { AppContextValue } from '../AppContext'
import type { TimeEntry } from '../lib/types'
import { localDateOnly } from '../lib/utils'

/**
 * Every dollar figure on the Reports page follows the client's pin.
 *
 * This page prices every client with the same `getInvoice` the month run uses,
 * so Projected billing had the same blind spot: with no rate versions in hand
 * it fell back to each person's LIVE bill rate and projected a raise onto
 * clients that had not been reviewed yet. The three Billable $ columns — the
 * Employee report, the payroll summary and the payroll detail — read
 * `employee.billRate` outright, which mirrors the NEWEST version, so they
 * disagreed with the invoice for any client still on older rates. Acme is
 * pinned to June, so its hour is $40 everywhere here — the number the invoice
 * will actually carry — and never today's $60.
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

/** A second hourly client, already moved to the current rates. */
const current = {
  ...client,
  id: 'client-birch',
  name: 'Birch',
  hourlyRatePeriod: '2026-09',
}

const entry = (over: Partial<TimeEntry> & { id: string }): TimeEntry =>
  ({
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
    ...over,
  }) as TimeEntry

let contextValue: AppContextValue

/** The page with these entries, versions 40 from June and 60 from September. */
function setup(timeEntries: TimeEntry[]) {
  contextValue = {
    ownerMode: true,
    billingPeriod: '2026-09',
    firmSettings: DEFAULT_FIRM_SETTINGS,
    data: {
      // The live bill rate mirrors the newest version, which is what this page
      // used to project onto every client regardless of its pin.
      employees: [{ id: 'emp-avery', name: 'Avery Stone', billRate: 60 }],
      inactiveEmployees: [],
      timeEntries,
      clients: [client, current],
      plans: [],
      checklists: [],
      reimbursements: [],
      recurringReimbursements: [],
    },
  } as unknown as AppContextValue
}

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

  setup([entry({ id: 'entry-1' })])
})

/** The first body row of the table under `heading`, as plain text cells. */
function firstRow(container: HTMLElement, heading: string, tableIndex = 0) {
  const title = within(container).getByText(heading)
  const tables = title.closest('section')?.querySelectorAll('table') ?? []
  const table = tables[tableIndex] as HTMLTableElement
  const row = table.querySelector('tbody tr') as HTMLTableRowElement
  return [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')
}

const clientRow = (container: HTMLElement) => firstRow(container, 'Client report')
const employeeRow = (container: HTMLElement) => firstRow(container, 'Employee report')

describe('ReportsPage projects a pinned client at its pin', () => {
  it('bills a June-pinned client at June money for September hours', async () => {
    const { container } = render(<ReportsPage />)
    await waitFor(() => expect(mockRateVersions).toHaveBeenCalled())

    await waitFor(() => expect(clientRow(container)).toContain('$40.00'))
    // Not today's $60 rate.
    expect(clientRow(container)).not.toContain('$60.00')
  })
})

describe('the Employee report’s Billable $ follows the pin too', () => {
  it('values a June-pinned client’s hour at $40, not the person’s newest $60', async () => {
    const { container } = render(<ReportsPage />)
    await waitFor(() => expect(mockRateVersions).toHaveBeenCalled())

    await waitFor(() => expect(employeeRow(container)).toContain('$40.00'))
    expect(employeeRow(container)).not.toContain('$60.00')
  })

  it('adds two clients on two pins at each one’s own rate', async () => {
    setup([
      entry({ id: 'entry-1' }),
      entry({ id: 'entry-2', clientId: 'client-birch', date: '2026-09-11' }),
    ])
    const { container } = render(<ReportsPage />)
    await waitFor(() => expect(mockRateVersions).toHaveBeenCalled())

    // $40 for Acme's hour + $60 for Birch's — not $120 (both at the newest
    // rate) and not $80 (both at the older one).
    await waitFor(() => expect(employeeRow(container)).toContain('$100.00'))
  })
})

describe('the payroll Hours report’s Billable $ follows the pin', () => {
  // The payroll window is anchored to today, so the hour is worked today; the
  // pin is June and the raise is dated September, so wherever today falls the
  // pinned rate is $40 and the live mirror is $60.
  const today = localDateOnly()

  it('prices the summary row at the client’s pin', async () => {
    setup([entry({ id: 'entry-today', date: today })])
    const { container } = render(<ReportsPage />)
    await waitFor(() => expect(mockRateVersions).toHaveBeenCalled())

    await waitFor(() => expect(firstRow(container, 'Hours report')).toContain('$40.00'))
    expect(firstRow(container, 'Hours report')).not.toContain('$60.00')
  })

  it('prices the detail row at the same rate, so the column ties to the total', async () => {
    setup([entry({ id: 'entry-today', date: today })])
    const { container } = render(<ReportsPage />)
    await waitFor(() => expect(mockRateVersions).toHaveBeenCalled())

    // The detail table's first body row is the day header; the entry's own
    // row is the one after it.
    await waitFor(() => {
      const title = within(container).getByText('Time by day and job')
      const table = title.closest('section')?.querySelectorAll('table')[1] as HTMLTableElement
      const rows = [...table.querySelectorAll('tbody tr')]
      const cells = [...rows[1].querySelectorAll('td')].map((cell) => cell.textContent ?? '')
      expect(cells).toContain('$40.00')
      expect(cells).not.toContain('$60.00')
      const footer = table.querySelector('tfoot')?.textContent ?? ''
      expect(footer).toContain('$40.00')
    })
  })
})
