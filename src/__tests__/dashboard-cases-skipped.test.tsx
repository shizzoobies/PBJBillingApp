import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * Cases in flight, Stuck cases and My cases leave out skipped tasks
 * (featreq-9c818fca, follow-up to the queue fix).
 *
 * A skipped step is closed out for its cycle without its items being ticked,
 * so it never rolls up complete. Cases in flight kept a case whose only open
 * step was skipped ("one finished, one still open"), and the stuck detectors
 * counted that skipped step as a stale open step. A skipped step is neither
 * finished nor open: the case drops off every Dashboard case list.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn().mockResolvedValue({ billRateVersions: [], costRateVersions: [] }),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  listInvoicesRequest: vi.fn().mockResolvedValue([]),
}))

const LISA = 'emp-lisa'
const BRITT = 'emp-brit'
const CASE = 'case-dobco-close'

let contextValue: AppContextValue

type Viewer = 'owner' | 'staff'

// Created long ago with no activity since, so an open step reads as stale.
const LONG_AGO = '2026-01-05T15:00:00.000Z'

/** Step 1 of 2: every item ticked. */
const finishedStep = () =>
  ({
    id: 'cl-step-1',
    clientId: 'client-dobco',
    caseId: CASE,
    stageIndex: 0,
    stageCount: 2,
    title: 'Gather statements',
    assigneeId: LISA,
    dueDate: '',
    createdAt: LONG_AGO,
    items: [{ id: 'step-1-it-1', label: 'Gather', done: true, assigneeId: LISA }],
  }) as unknown as Checklist

/** Step 2 of 2: one item ticked, one open (in progress), optionally skipped. */
const openStep = (skipped: boolean) =>
  ({
    id: 'cl-step-2',
    clientId: 'client-dobco',
    caseId: CASE,
    stageIndex: 1,
    stageCount: 2,
    title: 'Reconcile accounts',
    assigneeId: LISA,
    dueDate: '',
    createdAt: LONG_AGO,
    items: [
      { id: 'step-2-it-1', label: 'Bank', done: true, assigneeId: LISA },
      { id: 'step-2-it-2', label: 'Card', done: false, assigneeId: LISA },
    ],
    ...(skipped ? { skippedAt: '2026-10-10T14:00:00.000Z' } : {}),
  }) as unknown as Checklist

function signInAs(viewer: Viewer, checklists: Checklist[]) {
  const owner = viewer === 'owner'
  const data = {
    clients: [{ id: 'client-dobco', name: 'Dobco Properties', assignedBookkeeperIds: [LISA] }],
    employees: [
      { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
      { id: BRITT, name: 'Brittany Fox', role: 'Owner' },
    ],
    checklists,
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    inactiveEmployees: [],
    serviceCategories: [],
  } as unknown as AppData
  const user = owner
    ? { id: BRITT, name: 'Brittany Fox', role: 'owner' }
    : { id: LISA, name: 'Lisa Chen', role: 'employee' }
  contextValue = {
    data,
    role: owner ? 'owner' : 'employee',
    ownerMode: owner,
    previewMode: false,
    activeEmployeeId: user.id,
    sessionUser: user,
    effectiveUser: user,
    billingPeriod: '2026-08',
    firmSettings: { clientDefaults: { hourlyRate: 0 } },
    checklistSkips: [],
    reviewChecklistSkip: vi.fn(),
    skipChecklistOccurrence: vi.fn(),
    toggleChecklistItem: vi.fn(),
    setPreviewUserId: vi.fn(),
    waitingOnMe: [],
  } as unknown as AppContextValue
}

const renderDashboard = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <DashboardPage />
    </MemoryRouter>,
  )

/** The number on the alert card whose label is `label`. */
const alertCount = (label: string) => {
  const card = screen.getByText(label, { selector: 'span' }).closest('button')
  expect(card).not.toBeNull()
  return card!.querySelector('strong')?.textContent
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("the owner's Cases in flight and Stuck cases", () => {
  it('list a case whose open step is not skipped, and count it stuck', () => {
    signInAs('owner', [finishedStep(), openStep(false)])
    renderDashboard()

    const cases = screen.getByRole('region', { name: 'Cases in flight' })
    expect(within(cases).getByText('Reconcile accounts')).toBeInTheDocument()
    expect(within(cases).getByText('Stuck')).toBeInTheDocument()
    expect(alertCount('Stuck cases')).toBe('1')
  })

  it('leave out a case whose only open step is skipped', () => {
    signInAs('owner', [finishedStep(), openStep(true)])
    renderDashboard()

    const cases = screen.getByRole('region', { name: 'Cases in flight' })
    expect(within(cases).queryByText('Reconcile accounts')).not.toBeInTheDocument()
    expect(within(cases).getByText('No multi-step cases in flight.')).toBeInTheDocument()
    expect(alertCount('Stuck cases')).toBe('0')
  })
})

describe("the staff member's My cases in flight and Stuck", () => {
  it('list a case whose open step is not skipped, and count it stuck', () => {
    signInAs('staff', [finishedStep(), openStep(false)])
    renderDashboard()

    const cases = screen.getByRole('region', { name: 'My cases in flight' })
    expect(within(cases).getByText('Reconcile accounts')).toBeInTheDocument()
    expect(alertCount('Stuck')).toBe('1')
  })

  it('leave out a case whose only open step is skipped', () => {
    signInAs('staff', [finishedStep(), openStep(true)])
    renderDashboard()

    const cases = screen.getByRole('region', { name: 'My cases in flight' })
    expect(within(cases).queryByText('Reconcile accounts')).not.toBeInTheDocument()
    expect(within(cases).getByText('No cases in flight.')).toBeInTheDocument()
    expect(alertCount('Stuck')).toBe('0')
  })
})
