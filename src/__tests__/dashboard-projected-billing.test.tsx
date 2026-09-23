import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData } from '../lib/types'

/**
 * The owner dashboard's "Projected billing" follows each client's pin.
 *
 * It used to price every hourly client's hours at each person's live
 * `billRate` — the NEWEST version, a raise dated ahead included — so for any
 * client still on older rates the figure ran past what the month run would
 * actually invoice. Acme is pinned to June, where Avery bills $40; the raise
 * to $60 from September must not reach it until Acme is moved.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn(),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  listInvoicesRequest: vi.fn().mockResolvedValue([]),
}))

import { fetchRateVersions } from '../lib/api'

const mockRateVersions = vi.mocked(fetchRateVersions)

const OWNER = 'emp-patrice'

const data = {
  clients: [
    {
      id: 'client-acme',
      name: 'Acme',
      billingMode: 'hourly',
      hourlyRate: 0,
      hourlyRatePeriod: '2026-06',
      assignedBookkeeperIds: [],
      planIds: [],
    },
  ],
  employees: [
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
    // The live mirror of the newest version — the figure the old code used.
    { id: 'emp-avery', name: 'Avery Stone', role: 'Bookkeeper', billRate: 60 },
  ],
  checklists: [],
  checklistTemplates: [],
  recycledChecklists: [],
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
      description: 'Monthly close',
      workSessions: [],
    },
  ],
  inactiveEmployees: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue

beforeEach(() => {
  mockRateVersions.mockReset()
  mockRateVersions.mockResolvedValue({
    billRateVersions: [
      { userId: 'emp-avery', effectivePeriod: '2026-06', rate: 40 },
      { userId: 'emp-avery', effectivePeriod: '2026-09', rate: 60 },
    ],
    costRateVersions: [],
  } as unknown as Awaited<ReturnType<typeof fetchRateVersions>>)

  contextValue = {
    data,
    role: 'owner',
    ownerMode: true,
    previewMode: false,
    activeEmployeeId: OWNER,
    sessionUser: { id: OWNER, name: 'Patrice Owner', role: 'owner' },
    effectiveUser: { id: OWNER, name: 'Patrice Owner', role: 'owner' },
    billingPeriod: '2026-09',
    firmSettings: { clientDefaults: { hourlyRate: 0 } },
    checklistSkips: [],
    reviewChecklistSkip: vi.fn(),
    skipChecklistOccurrence: vi.fn(),
    toggleChecklistItem: vi.fn(),
    setPreviewUserId: vi.fn(),
    waitingOnMe: [],
  } as unknown as AppContextValue
})

/** The KPI tile's figure, read off the label beside it. */
const projectedBilling = () =>
  screen.getByText('Projected billing').closest('.kpi-stat')?.querySelector('strong')
    ?.textContent ?? ''

describe('DashboardPage projects a pinned client at its pin', () => {
  it('bills a June-pinned client’s September hour at $40, not the newest $60', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(mockRateVersions).toHaveBeenCalled())

    await waitFor(() => expect(projectedBilling()).toBe('$40.00'))
  })
})
