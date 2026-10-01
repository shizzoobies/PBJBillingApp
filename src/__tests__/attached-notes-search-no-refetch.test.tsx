import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { ActiveChecklistsBoardPage } from '../pages/ActiveChecklistsBoardPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { addDays, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * The pages ask for the notes attached to the cards they render ONCE, keyed on
 * the set of checklists the page holds - not on what the search box leaves
 * showing. Typing in the box narrows the cards; it must not ask the server
 * again for every keystroke.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: (...args: unknown[]) => listAttached(...args),
}))

let listAttached = vi.fn()
let contextValue: AppContextValue

const OWNER = 'emp-owner'
const TODAY = localDateOnly()

const ACME: Client = { id: 'client-acme', name: 'Acme Books', assignedBookkeeperIds: [] } as unknown as Client
const ZED: Client = { id: 'client-zed', name: 'Zed Works', assignedBookkeeperIds: [] } as unknown as Client

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    assigneeId: OWNER,
    viewerIds: [],
    editorIds: [],
    frequency: 'monthly',
    items: [{ id: `${over.id}-step`, label: 'Reconcile', done: false }],
    ...over,
  }) as Checklist

const CHECKLISTS = [
  checklist({ id: 'cl-acme', clientId: ACME.id, title: 'Payroll run', dueDate: addDays(TODAY, 3) }),
  checklist({ id: 'cl-zed', clientId: ZED.id, title: 'Sales tax', dueDate: addDays(TODAY, 4) }),
]

function signInAsOwner() {
  const data = {
    clients: [ACME, ZED],
    employees: [{ id: OWNER, name: 'Owner', role: 'Owner' }],
    checklists: CHECKLISTS,
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  } as unknown as AppData

  contextValue = {
    data,
    dataRefreshCount: 0,
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner' },
    sessionUser: { id: OWNER, role: 'owner' },
    visibleChecklists: checklistsVisibleTo(CHECKLISTS, { viewerId: OWNER, isOwner: true }),
    visibleClients: [ACME, ZED],
    visibleClientIds: new Set([ACME.id, ZED.id]),
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { preset: 'custom', from: '2020-01-01', to: '2099-12-31' },
    setReportPeriod: vi.fn(),
    addChecklist: vi.fn(),
    addSeriesChecklistItem: vi.fn(),
    addSubItem: vi.fn(),
    addSubSubItem: vi.fn(),
    applyTemplateToClient: vi.fn(),
    approveChecklistDeletion: vi.fn(),
    bulkAddChecklistItems: vi.fn(),
    deleteChecklist: vi.fn(),
    deleteChecklistItem: vi.fn(),
    emptyChecklistRecycleBin: vi.fn(),
    rejectChecklistDeletion: vi.fn(),
    removeSubItem: vi.fn(),
    removeSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    restoreChecklist: vi.fn(),
    setChecklistViewers: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateChecklistMeta: vi.fn(),
    updateSubItemWaiting: vi.fn(),
  } as unknown as AppContextValue
}

beforeEach(() => {
  listAttached = vi.fn(async () => [])
  signInAsOwner()
})

describe('typing in the search box does not refetch the attached notes', () => {
  it('Checklists page', async () => {
    render(
      <MemoryRouter initialEntries={['/checklists']}>
        <ChecklistsPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(listAttached).toHaveBeenCalledTimes(1))
    expect(listAttached.mock.calls[0][0]).toEqual(['cl-acme', 'cl-zed'])

    fireEvent.change(screen.getByRole('searchbox', { name: /search checklists/i }), {
      target: { value: 'payroll' },
    })
    await waitFor(() => expect(screen.queryByText('Sales tax')).not.toBeInTheDocument())
    expect(screen.getByText('Payroll run')).toBeInTheDocument()

    expect(listAttached).toHaveBeenCalledTimes(1)
  })

  it('Active checklists board', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <ActiveChecklistsBoardPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(listAttached).toHaveBeenCalledTimes(1))
    expect(listAttached.mock.calls[0][0]).toEqual(['cl-acme', 'cl-zed'])

    fireEvent.change(screen.getByRole('searchbox', { name: /search board/i }), {
      target: { value: 'acme' },
    })
    await waitFor(() => expect(screen.queryByText('Zed Works')).not.toBeInTheDocument())

    expect(listAttached).toHaveBeenCalledTimes(1)
  })
})
