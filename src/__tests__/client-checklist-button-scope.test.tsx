import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveChecklistsBody } from '../pages/ClientDetailPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * The Clients tab's Checklist button, which is exactly how the firm owner
 * reproduced the bug: signed in as a bookkeeper, on a client she shares with
 * Lisa, that button opened Lisa's ACTIVE checklist in the full editor.
 *
 * The panel behind the button is `ActiveChecklistsBody`. It used to read
 * `data.checklists` — the raw, client-scoped feed, which on a shared client
 * carries both people's work. It now reads `visibleChecklists`, the same
 * "mine" set the Checklists tab's In-progress list uses.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const BRITTANY = 'emp-brit'
const LISA = 'emp-lisa'
const OWNER = 'emp-patrice'
const SHARED: Client = { id: 'client-shared', name: 'Brittany Bookkeeping' } as Client

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: SHARED.id,
    dueDate: '2026-12-31',
    items: [{ id: 'it-1', label: 'Reconcile bank', done: false }],
    ...over,
  }) as Checklist

const LISAS = checklist({ id: 'cl-lisa', title: 'Lisa monthly close', assigneeId: LISA })
const BRITTS = checklist({ id: 'cl-brit', title: 'Brittany payroll', assigneeId: BRITTANY })

const data = {
  clients: [SHARED],
  employees: [
    { id: BRITTANY, name: 'Brittany Bookkeepington', role: 'Bookkeeper' },
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
  ],
  checklists: [LISAS, BRITTS],
  checklistTemplates: [],
  timeEntries: [],
} as unknown as AppData

let contextValue: AppContextValue

/** Builds the context the way `App.tsx` does — same narrowing, same inputs. */
function signInAs(viewerId: string, isOwner: boolean, checklists: Checklist[] = data.checklists) {
  contextValue = {
    data,
    activeEmployeeId: viewerId,
    role: isOwner ? 'owner' : 'employee',
    ownerMode: isOwner,
    visibleChecklists: checklistsVisibleTo(checklists, { viewerId, isOwner }),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    serviceCategories: [],
    addSeriesChecklistItem: vi.fn(),
    approveChecklistDeletion: vi.fn(),
    rejectChecklistDeletion: vi.fn(),
    updateChecklistMeta: vi.fn(),
    addSubItem: vi.fn(),
    addSubSubItem: vi.fn(),
    bulkAddChecklistItems: vi.fn(),
    deleteChecklist: vi.fn(),
    deleteChecklistItem: vi.fn(),
    removeSubItem: vi.fn(),
    removeSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    setChecklistViewers: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateSubItemWaiting: vi.fn(),
  } as unknown as AppContextValue
}

beforeEach(() => {
  signInAs(BRITTANY, false)
})

describe('Clients tab → Checklist button', () => {
  it('shows the viewer their own active checklist and not a colleague’s', () => {
    render(<ActiveChecklistsBody client={SHARED} data={data} />)
    expect(screen.getByText('Brittany payroll')).toBeInTheDocument()
    expect(screen.queryByText('Lisa monthly close')).not.toBeInTheDocument()
  })

  it('says "No active task at this time" rather than surfacing someone else’s', () => {
    // Same shared client, but the only live work on it is Lisa's.
    signInAs(BRITTANY, false, [LISAS])
    render(<ActiveChecklistsBody client={SHARED} data={data} />)
    expect(screen.getByText('No active task at this time')).toBeInTheDocument()
    expect(screen.queryByText('Lisa monthly close')).not.toBeInTheDocument()
  })

  it('leaves the owner seeing every active checklist on the client', () => {
    signInAs(OWNER, true)
    render(<ActiveChecklistsBody client={SHARED} data={data} />)
    expect(screen.getByText('Lisa monthly close')).toBeInTheDocument()
    expect(screen.getByText('Brittany payroll')).toBeInTheDocument()
  })
})
