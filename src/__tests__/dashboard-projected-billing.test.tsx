import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData } from '../lib/types'

/**
 * The owner dashboard's "Projected billing" IS the Invoice Recap's Service
 * total (featreq-464659c9).
 *
 * Her words: "my projected billing on dashboard is $11,695.60 but when I click
 * on report and see invoice recap for service total it shows $14,766.52". The
 * tile used to add up hours logged so far at each person's rate; the report it
 * links to quotes each client's estimate for the whole month. Now the tile
 * reads the report's own route for the same month and works nothing out
 * itself: the workspace below holds an hour that the old code priced at $40,
 * and no test here may ever see that figure.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn().mockResolvedValue({ billRateVersions: [], costRateVersions: [] }),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  invoiceEstimateRequest: vi.fn(),
  listInvoicesRequest: vi.fn().mockResolvedValue([]),
}))

import { fetchRateVersions, invoiceEstimateRequest } from '../lib/api'

const mockEstimate = vi.mocked(invoiceEstimateRequest)
const mockRateVersions = vi.mocked(fetchRateVersions)

type Estimate = Awaited<ReturnType<typeof invoiceEstimateRequest>>
const estimateOf = (period: string, serviceTotal: number) =>
  ({ period, monthTotal: serviceTotal + 100, serviceTotal, reimburseTotal: 100, clients: [] }) as Estimate

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
    // A monthly client the old code added at its rate, whatever the report said.
    {
      id: 'client-sub',
      name: 'Monthly Co',
      billingMode: 'subscription',
      monthlyRate: 500,
      assignedBookkeeperIds: [],
      planIds: [],
    },
  ],
  employees: [
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
    { id: 'emp-avery', name: 'Avery Stone', role: 'Bookkeeper', billRate: 40 },
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
  mockEstimate.mockReset()
  mockEstimate.mockResolvedValue(estimateOf('2026-09', 14766.52))
  mockRateVersions.mockClear()

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

const page = () => (
  <MemoryRouter initialEntries={['/']}>
    <DashboardPage />
  </MemoryRouter>
)

/** The KPI tile's figure, read off the label beside it. */
const projectedBilling = () =>
  screen.getByText('Projected billing').closest('.kpi-stat')?.querySelector('strong')
    ?.textContent ?? ''

const asStaff = () => {
  contextValue = {
    ...contextValue,
    role: 'employee',
    ownerMode: false,
    activeEmployeeId: 'emp-avery',
    sessionUser: { id: 'emp-avery', name: 'Avery Stone', role: 'employee' },
    effectiveUser: { id: 'emp-avery', name: 'Avery Stone', role: 'employee' },
  } as unknown as AppContextValue
}

describe('DashboardPage: where "View full report" goes (featreq-3b162946)', () => {
  it('takes the owner to the Invoice Recap, where her estimate of the month is', async () => {
    render(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenCalled())
    const link = screen.getAllByText(/View full report|Open my time/)[0].closest('a')
    // On the month the tile quotes (featreq-464659c9), so the report's Service
    // total is the same request as the tile's.
    expect(link?.getAttribute('href')).toBe('/invoice-recap?period=2026-09')
  })

  it('follows the billing month she has picked, not today', async () => {
    contextValue = { ...contextValue, billingPeriod: '2026-07' } as unknown as AppContextValue
    mockEstimate.mockResolvedValue(estimateOf('2026-07', 5))
    render(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledWith('2026-07', expect.anything()))
    const link = screen.getByText('View full report →').closest('a')
    expect(link?.getAttribute('href')).toBe('/invoice-recap?period=2026-07')
  })
})

describe('DashboardPage: the staff link stays on their own time', () => {
  it('sends a bookkeeper to /time, not the Invoice Recap estimate', async () => {
    asStaff()
    render(page())
    const link = (await screen.findAllByText('Open my time →'))[0].closest('a')
    expect(link?.getAttribute('href')).toBe('/time')
    expect(screen.queryByText('View full report →')).not.toBeInTheDocument()
  })

  it('never asks for the owner-only estimate, and shows staff no Projected billing', async () => {
    asStaff()
    render(page())
    await screen.findAllByText('Open my time →')
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(screen.queryByText('Projected billing')).not.toBeInTheDocument()
  })
})

describe('DashboardPage: Projected billing is the Invoice Recap Service total (featreq-464659c9)', () => {
  it('shows the Service total the report shows, for the dashboard month', async () => {
    render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,766.52'))
    expect(mockEstimate).toHaveBeenCalledTimes(1)
    expect(mockEstimate.mock.calls[0][0]).toBe('2026-09')
  })

  it('says in its hint that hourly clients this month are at the hours so far (featreq-abd4b683)', async () => {
    render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,766.52'))
    const hint = screen.getByText('Projected billing').closest('.kpi-stat')?.getAttribute('title') ?? ''
    expect(hint).toMatch(/^The Service total on the Invoice Recap/)
    expect(hint).toMatch(/hourly clients in the current month at the hours worked so far times their bill rates/)
  })

  it('works nothing out from the hours and rates on the page', async () => {
    // The old tile said $540.00 here: one hour at $40 plus the $500 monthly rate.
    mockEstimate.mockResolvedValue(estimateOf('2026-09', 0))
    render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$0.00'))
    // It no longer needs the rate history at all.
    expect(mockRateVersions).not.toHaveBeenCalled()
  })

  it('shows a dash, never a figure of its own, while the estimate is loading', async () => {
    mockEstimate.mockReturnValue(new Promise<Estimate>(() => {}))
    render(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenCalled())
    expect(projectedBilling()).toBe('—')
  })

  it('shows a dash when the estimate cannot be loaded', async () => {
    mockEstimate.mockRejectedValue(new Error('Failed to load the invoice estimate (500)'))
    render(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenCalled())
    // Let the failure land and be handled before looking.
    await act(async () => {
      await mockEstimate.mock.results[0].value.catch(() => {})
    })
    expect(projectedBilling()).toBe('—')
    expect(screen.getByText('Projected billing')).toBeInTheDocument()
  })

  it('a failed re-read clears the figure: the earlier answer is not left standing', async () => {
    const view = render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,766.52'))

    // More time is logged for the month, so the tile asks again, and that fails.
    mockEstimate.mockRejectedValue(new Error('Failed to load the invoice estimate (500)'))
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        timeEntries: [...data.timeEntries, { ...data.timeEntries[0], id: 'entry-2', minutes: 30 }],
      },
    } as unknown as AppContextValue
    view.rerender(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(projectedBilling()).toBe('—'))
  })

  it('asks again when the month’s time on the page changes, and shows the new total', async () => {
    const view = render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,766.52'))
    expect(mockEstimate).toHaveBeenCalledTimes(1)

    mockEstimate.mockResolvedValue(estimateOf('2026-09', 14800))
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        timeEntries: [...data.timeEntries, { ...data.timeEntries[0], id: 'entry-2', minutes: 30 }],
      },
    } as unknown as AppContextValue
    view.rerender(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,800.00'))
    expect(mockEstimate).toHaveBeenCalledTimes(2)
  })

  // featreq-abd4b683: the figure is hours x each person's rate, so an edit that
  // keeps the count and the minutes still changes it.
  it.each([
    ['reassigned to another person', { employeeId: OWNER }],
    ['moved to another client', { clientId: 'client-sub' }],
    ['flipped to ad hoc', { isAdhoc: true }],
  ])('asks again when an entry is %s with the same minutes', async (_name, change) => {
    const view = render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,766.52'))
    expect(mockEstimate).toHaveBeenCalledTimes(1)

    mockEstimate.mockResolvedValue(estimateOf('2026-09', 14700))
    contextValue = {
      ...contextValue,
      data: { ...data, timeEntries: [{ ...data.timeEntries[0], ...change }] },
    } as unknown as AppContextValue
    view.rerender(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,700.00'))
    expect(mockEstimate).toHaveBeenCalledTimes(2)
  })

  it('does not ask again for a change that is not this month’s time', async () => {
    const view = render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,766.52'))

    // Another month's entry, and a new array holding the same September time.
    contextValue = {
      ...contextValue,
      data: {
        ...data,
        timeEntries: [...data.timeEntries, { ...data.timeEntries[0], id: 'entry-aug', date: '2026-08-03' }],
      },
    } as unknown as AppContextValue
    view.rerender(page())
    await act(async () => {})
    expect(mockEstimate).toHaveBeenCalledTimes(1)
    expect(projectedBilling()).toBe('$14,766.52')
  })

  it('shows a dash when the answer holds no usable Service total', async () => {
    mockEstimate.mockResolvedValue({ period: '2026-09', clients: [] } as unknown as Estimate)
    render(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenCalled())
    // Let the answer land and any re-render it causes finish before looking.
    await act(async () => {
      await mockEstimate.mock.results[0].value
    })
    expect(projectedBilling()).toBe('—')
  })

  it('shows a dash when the Service total is not a real number', async () => {
    mockEstimate.mockResolvedValue({ ...estimateOf('2026-09', 0), serviceTotal: Number.NaN })
    render(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenCalled())
    await act(async () => {
      await mockEstimate.mock.results[0].value
    })
    expect(projectedBilling()).toBe('—')
  })

  it('never shows one month’s total under another month', async () => {
    const view = render(page())
    await waitFor(() => expect(projectedBilling()).toBe('$14,766.52'))

    // She moves to October; its answer has not arrived yet.
    let answerOctober: (estimate: Estimate) => void = () => {}
    mockEstimate.mockReturnValue(
      new Promise<Estimate>((resolve) => {
        answerOctober = resolve
      }),
    )
    contextValue = { ...contextValue, billingPeriod: '2026-10' } as unknown as AppContextValue
    view.rerender(page())
    await waitFor(() => expect(mockEstimate).toHaveBeenLastCalledWith('2026-10', expect.anything()))
    expect(projectedBilling()).toBe('—')

    answerOctober(estimateOf('2026-10', 9000))
    await waitFor(() => expect(projectedBilling()).toBe('$9,000.00'))
  })

  it('previewing someone else shows their dashboard, which has no estimate to ask for', async () => {
    // The owner view is not rendered in preview at all (DashboardPage picks the
    // team member's view), so this pins the dispatch; the effect's own preview
    // check is a second line behind it.
    contextValue = { ...contextValue, previewMode: true } as unknown as AppContextValue
    render(page())
    await waitFor(() => expect(screen.getAllByText(/View full report|Open my time/).length).toBeGreaterThan(0))
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(screen.queryByText('Projected billing')).not.toBeInTheDocument()
  })
})
