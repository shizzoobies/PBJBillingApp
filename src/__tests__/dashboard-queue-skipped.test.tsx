import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * The Dashboard queue leaves out skipped tasks (featreq-9c818fca).
 *
 * Skipping closes an occurrence out for its cycle without ticking its steps, so
 * a skipped task never rolls up complete. The queue's "not complete" rule alone
 * kept it there forever - Brittany's "my queue shows items that have already
 * been addressed". The overdue and due-this-week cards beside it, and every
 * other page, already leave skipped tasks out; the queue now does too.
 *
 * The owner's region is "Your queue"; the staff (and preview-as) region is
 * "My queue". Both read the same rule.
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

let contextValue: AppContextValue

type Viewer = 'owner' | 'staff' | 'owner-previewing'

/** An open task (one unticked step) assigned to `assigneeId`, due today. */
const task = (id: string, title: string, assigneeId: string, over: Partial<Checklist> = {}) =>
  ({
    id,
    clientId: 'client-dobco',
    title,
    assigneeId,
    // No due date lands in the "Today" group.
    dueDate: '',
    items: [{ id: `${id}-it-1`, label: 'Meet', done: false, assigneeId }],
    ...over,
  }) as unknown as Checklist

function signInWith(viewer: Viewer, checklists: (assignee: string) => Checklist[]) {
  const owner = viewer !== 'staff'
  // Previewing as Lisa shows what Lisa sees: her tasks, the staff view.
  const queueOwnerId = viewer === 'owner' ? BRITT : LISA
  const data = {
    clients: [{ id: 'client-dobco', name: 'Dobco Properties', assignedBookkeeperIds: [LISA] }],
    employees: [
      { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
      { id: BRITT, name: 'Brittany Fox', role: 'Owner' },
    ],
    checklists: checklists(queueOwnerId),
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    inactiveEmployees: [],
    serviceCategories: [],
  } as unknown as AppData
  const effective =
    viewer === 'owner'
      ? { id: BRITT, name: 'Brittany Fox', role: 'owner' }
      : { id: LISA, name: 'Lisa Chen', role: 'employee' }
  contextValue = {
    data,
    role: owner ? 'owner' : 'employee',
    ownerMode: owner,
    previewMode: viewer === 'owner-previewing',
    activeEmployeeId: queueOwnerId,
    sessionUser: owner
      ? { id: BRITT, name: 'Brittany Fox', role: 'owner' }
      : { id: LISA, name: 'Lisa Chen', role: 'employee' },
    effectiveUser: effective,
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

const SKIPPED = { skippedAt: '2026-10-10T14:00:00.000Z' } as Partial<Checklist>

const cases: { viewer: Viewer; region: string }[] = [
  { viewer: 'owner', region: 'Your queue' },
  { viewer: 'staff', region: 'My queue' },
  { viewer: 'owner-previewing', region: 'My queue' },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe.each(cases)('the Dashboard queue ($viewer)', ({ viewer, region }) => {
  it('lists the open task and leaves out the skipped one', () => {
    signInWith(viewer, (who) => [
      task('cl-skipped', 'Client Meeting (skipped)', who, SKIPPED),
      task('cl-open', 'Monthly close', who),
    ])
    renderDashboard()

    const queue = screen.getByRole('region', { name: region })
    expect(within(queue).getByText('Monthly close')).toBeInTheDocument()
    expect(within(queue).queryByText('Client Meeting (skipped)')).not.toBeInTheDocument()
    // The count beside "Today" counts what is listed.
    expect(within(queue).getByRole('heading', { name: 'Today 1' })).toBeInTheDocument()
  })

  it('says "Nothing in your queue" when the only task is skipped', () => {
    signInWith(viewer, (who) => [task('cl-skipped', 'Client Meeting (skipped)', who, SKIPPED)])
    renderDashboard()

    const queue = screen.getByRole('region', { name: region })
    expect(within(queue).getByText('Nothing in your queue. Nicely done.')).toBeInTheDocument()
    expect(within(queue).queryByText('Client Meeting (skipped)')).not.toBeInTheDocument()
  })
})
