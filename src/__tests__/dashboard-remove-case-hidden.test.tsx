import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * Remove case (2026-10-27) is the owner's: the staff view ("My cases in
 * flight") and an owner previewing someone (who sees that same staff view)
 * get no Remove case button. The owner's own view does (the full flow is in
 * dashboard-remove-case.test.tsx, on the real <App>).
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
let removeCase: ReturnType<typeof vi.fn>

const step = (id: string, stageIndex: number, done: boolean[]) =>
  ({
    id,
    clientId: 'client-dobco',
    caseId: CASE,
    stageIndex,
    stageCount: 2,
    title: stageIndex === 0 ? 'Gather statements' : 'Reconcile accounts',
    assigneeId: LISA,
    dueDate: '',
    createdAt: '2026-01-05T15:00:00.000Z',
    items: done.map((isDone, index) => ({ id: `${id}-${index}`, label: `Item ${index}`, done: isDone, assigneeId: LISA })),
  }) as unknown as Checklist

function signInAs(viewer: 'owner' | 'staff' | 'owner-previewing') {
  const owner = viewer !== 'staff'
  const previewing = viewer === 'owner-previewing'
  const user = owner
    ? { id: BRITT, name: 'Brittany Fox', role: 'owner' }
    : { id: LISA, name: 'Lisa Chen', role: 'employee' }
  const shown = previewing ? { id: LISA, name: 'Lisa Chen', role: 'employee' } : user
  removeCase = vi.fn()
  contextValue = {
    data: {
      clients: [{ id: 'client-dobco', name: 'Dobco Properties', assignedBookkeeperIds: [LISA] }],
      employees: [
        { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
        { id: BRITT, name: 'Brittany Fox', role: 'Owner' },
      ],
      checklists: [step('cl-1', 0, [true]), step('cl-2', 1, [true, false])],
      checklistTemplates: [],
      recycledChecklists: [],
      timeEntries: [],
      inactiveEmployees: [],
      serviceCategories: [],
    } as unknown as AppData,
    role: owner ? 'owner' : 'employee',
    ownerMode: owner && !previewing,
    previewMode: previewing,
    activeEmployeeId: shown.id,
    sessionUser: user,
    effectiveUser: shown,
    billingPeriod: '2026-08',
    firmSettings: { clientDefaults: { hourlyRate: 0 } },
    checklistSkips: [],
    reviewChecklistSkip: vi.fn(),
    skipChecklistOccurrence: vi.fn(),
    toggleChecklistItem: vi.fn(),
    setPreviewUserId: vi.fn(),
    waitingOnMe: [],
    removeCase,
    restoreChecklist: vi.fn(),
  } as unknown as AppContextValue
}

const renderDashboard = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <DashboardPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Remove case is the owner view only', () => {
  it("is on the owner's Cases in flight row", () => {
    signInAs('owner')
    renderDashboard()
    const cases = screen.getByRole('region', { name: 'Cases in flight' })
    const row = within(cases).getByText('Reconcile accounts').closest('li') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Remove case' })).toBeInTheDocument()
  })

  it("is not on a staff member's My cases in flight", () => {
    signInAs('staff')
    renderDashboard()
    const cases = screen.getByRole('region', { name: 'My cases in flight' })
    expect(within(cases).getByText('Reconcile accounts')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove case' })).toBeNull()
  })

  it('is not there while the owner previews someone', () => {
    signInAs('owner-previewing')
    renderDashboard()
    expect(screen.getByRole('region', { name: 'My cases in flight' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove case' })).toBeNull()
    expect(removeCase).not.toHaveBeenCalled()
  })
})
