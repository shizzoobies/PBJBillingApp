import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveChecklistsBody } from '../pages/ClientDetailPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client, ClientPendingNote } from '../lib/types'

/**
 * Page-level: a client's Active checklists renders one card per checklist, and
 * ALL of them are served by ONE request for attached notes - not one request
 * (and one full workspace read on the server) per card. A card shows the notes
 * the page hands it and never fetches.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: (...args: unknown[]) => listAttached(...args),
}))

let listAttached = vi.fn()
let contextValue: AppContextValue

const CLIENT = { id: 'client-1', name: 'Acme' } as Client

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: CLIENT.id,
    assigneeId: 'emp-owner',
    dueDate: '2099-12-31',
    items: [{ id: 'it-1', label: 'Reconcile bank', done: false }],
    ...over,
  }) as Checklist

const CHECKLISTS = [
  checklist({ id: 'cl-a', title: 'Payroll A' }),
  checklist({ id: 'cl-b', title: 'Payroll B' }),
  checklist({ id: 'cl-c', title: 'Payroll C' }),
]

const data = {
  clients: [CLIENT],
  employees: [{ id: 'emp-owner', name: 'Owner', role: 'Owner' }],
  checklists: CHECKLISTS,
  checklistTemplates: [],
  timeEntries: [],
} as unknown as AppData

const pendingNote = (over: Partial<ClientPendingNote>): ClientPendingNote => ({
  id: 'pnote-1',
  clientId: CLIENT.id,
  templateId: 'tmpl-1',
  kind: 'note',
  body: 'A note',
  authorId: 'emp-lisa',
  authorName: 'Lisa',
  createdAt: '2026-09-20T12:00:00.000Z',
  attachedChecklistId: 'cl-b',
  attachedItemId: null,
  attachedAt: '2026-09-25T00:00:00.000Z',
  ...over,
})

function signInAsOwner() {
  contextValue = {
    data,
    dataRefreshCount: 0,
    activeEmployeeId: 'emp-owner',
    role: 'owner',
    ownerMode: true,
    visibleChecklists: CHECKLISTS,
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
  listAttached = vi.fn(async () => [pendingNote({ body: 'Only B has this' })])
  signInAsOwner()
})

describe('a client page with many checklist cards', () => {
  it('makes ONE request for all of them, and the note lands on the right card', async () => {
    render(<ActiveChecklistsBody client={CLIENT} data={data} />)

    expect(await screen.findByText('Only B has this')).toBeInTheDocument()
    expect(screen.getByText('Payroll A')).toBeInTheDocument()
    expect(screen.getByText('Payroll B')).toBeInTheDocument()
    expect(screen.getByText('Payroll C')).toBeInTheDocument()

    await waitFor(() => expect(listAttached).toHaveBeenCalledTimes(1))
    expect(listAttached.mock.calls[0][0]).toEqual(['cl-a', 'cl-b', 'cl-c'])
    // Exactly one copy of the note, on exactly one card.
    expect(screen.getAllByText('Only B has this')).toHaveLength(1)
  })

  it('asks again on the data-changed signal - once, not once per card', async () => {
    const view = render(<ActiveChecklistsBody client={CLIENT} data={data} />)
    await screen.findByText('Only B has this')

    listAttached = vi.fn(async () => [
      pendingNote({ body: 'Only B has this' }),
      pendingNote({ id: 'pnote-2', attachedChecklistId: 'cl-c', body: 'Now C has one too' }),
    ])
    contextValue = { ...contextValue, dataRefreshCount: 1 } as unknown as AppContextValue
    view.rerender(<ActiveChecklistsBody client={CLIENT} data={data} />)

    expect(await screen.findByText('Now C has one too')).toBeInTheDocument()
    expect(listAttached).toHaveBeenCalledTimes(1)
  })
})
