import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveChecklistsBoardPage } from '../pages/ActiveChecklistsBoardPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * One word for one state. The checklist card's badge and the Waiting filter say
 * "Waiting"; the Board's client row ("N pending") and its card chips
 * ("Pending - ...") said "Pending" for the very same state. Both Board chips
 * now say "Waiting".
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: async () => [],
}))

let contextValue: AppContextValue

const OWNER = 'emp-owner'
const ACME: Client = { id: 'client-acme', name: 'Acme Books', assignedBookkeeperIds: [] } as unknown as Client

// A board with no columns renders nothing, so it needs one.
const CATEGORIES = [{ id: 'cat-books', name: 'Bookkeeping', sortOrder: 0 }]

const WAITING_CLOSE = {
  id: 'cl-waiting',
  clientId: ACME.id,
  title: 'Payroll run',
  assigneeId: OWNER,
  viewerIds: [],
  editorIds: [],
  frequency: 'monthly',
  dueDate: localDateOnly(),
  items: [{ id: 'a', label: 'Reconcile', done: false, waiting: true, waitingOn: 'client bank statements' }],
} as unknown as Checklist

beforeEach(() => {
  const data = {
    clients: [ACME],
    employees: [{ id: OWNER, name: 'Owner', role: 'Owner' }],
    checklists: [WAITING_CLOSE],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: CATEGORIES,
  } as unknown as AppData
  contextValue = {
    data,
    dataRefreshCount: 0,
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner' },
    sessionUser: { id: OWNER, role: 'owner' },
    visibleChecklists: checklistsVisibleTo([WAITING_CLOSE], { viewerId: OWNER, isOwner: true }),
    visibleClients: [ACME],
    visibleClientIds: new Set([ACME.id]),
    serviceCategories: CATEGORIES,
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { preset: 'custom', from: '2020-01-01', to: '2099-12-31' },
    setReportPeriod: vi.fn(),
    updateChecklistMeta: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateSubItemWaiting: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    reorderChecklistSubItems: vi.fn(),
  } as unknown as AppContextValue
})

describe('the Board says "Waiting" for a waiting checklist', () => {
  it('on the client row and on the card chip, never "Pending"', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <ActiveChecklistsBoardPage />
      </MemoryRouter>,
    )
    const toggle = await screen.findByRole('button', { name: /Acme Books/ })
    expect(toggle).toHaveTextContent('1 waiting')
    expect(toggle).not.toHaveTextContent(/pending/i)

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByText(/Waiting — client bank statements/)).toBeInTheDocument())
    expect(screen.queryByText(/Pending/)).not.toBeInTheDocument()
  })
})
