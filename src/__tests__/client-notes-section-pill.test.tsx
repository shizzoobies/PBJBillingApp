import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientNotesSection } from '../pages/ClientDetailPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, ClientPendingNote } from '../lib/types'

/**
 * The "N waiting for a checklist" pill on the Client notes section header
 * (featreq-b688e73c). The section is a CollapsibleSection, which UNMOUNTS its
 * children when collapsed - so a count the notes box fetched and reported up
 * used to vanish exactly when the section was folded away. The count is now
 * fetched by the section itself, independent of whether the box is mounted.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listClientNotes: async () => [],
  listClientPendingNotesRequest: (...args: unknown[]) => listPending(...args),
}))

let listPending = vi.fn()
let contextValue: AppContextValue

const pendingNote = (over: Partial<ClientPendingNote> = {}): ClientPendingNote => ({
  id: 'pnote-1',
  clientId: 'c1',
  templateId: 'tmpl-payroll',
  kind: 'task',
  body: 'New hire starting',
  authorId: 'emp-lisa',
  authorName: 'Lisa',
  createdAt: '2026-09-20T12:00:00.000Z',
  attachedChecklistId: null,
  attachedItemId: null,
  attachedAt: null,
  ...over,
})

function renderSection() {
  return render(
    <MemoryRouter>
      <ClientNotesSection clientId="c1" ownerMode currentUserId="emp-owner" />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // CollapsibleSection remembers collapse state in localStorage across tests.
  window.localStorage.clear()
  listPending = vi.fn(async () => [])
  contextValue = {
    data: { checklistTemplates: [], checklists: [] } as unknown as AppData,
    dataRefreshCount: 0,
  } as unknown as AppContextValue
})

describe('the pending-notes count pill', () => {
  it('counts only the notes still waiting, not the ones already attached', async () => {
    listPending = vi.fn(async () => [
      pendingNote({ id: 'pnote-1' }),
      pendingNote({ id: 'pnote-2' }),
      pendingNote({
        id: 'pnote-3',
        attachedChecklistId: 'chk-1',
        attachedAt: '2026-09-25T00:00:00.000Z',
      }),
    ])
    renderSection()
    expect(await screen.findByText('2 waiting for a checklist')).toBeInTheDocument()
  })

  it('shows no pill when nothing is waiting', async () => {
    renderSection()
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/waiting for a checklist/)).not.toBeInTheDocument()
  })

  it('stays in the header when the section is collapsed and the notes box is unmounted', async () => {
    listPending = vi.fn(async () => [pendingNote()])
    renderSection()
    expect(await screen.findByText('1 waiting for a checklist')).toBeInTheDocument()
    // Open: the notes box is on screen.
    expect(screen.getByText('Add a note')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Client notes' }))

    // Collapsed: the box is gone, the pill is not.
    expect(screen.queryByText('Add a note')).not.toBeInTheDocument()
    expect(screen.getByText('1 waiting for a checklist')).toBeInTheDocument()
  })

  it('shows the pill even when the section starts collapsed', async () => {
    listPending = vi.fn(async () => [pendingNote(), pendingNote({ id: 'pnote-2' })])
    window.localStorage.setItem('pbj.section.Client notes.collapsed', '1')
    renderSection()
    expect(await screen.findByText('2 waiting for a checklist')).toBeInTheDocument()
    expect(screen.queryByText('Add a note')).not.toBeInTheDocument()
  })

  it('is one fetch, shared with the open notes box - not a second copy', async () => {
    listPending = vi.fn(async () => [pendingNote()])
    renderSection()
    expect(await screen.findByText('New hire starting')).toBeInTheDocument()
    expect(screen.getByText('1 waiting for a checklist')).toBeInTheDocument()
    expect(listPending).toHaveBeenCalledTimes(1)
  })

  it('follows the data-changed signal', async () => {
    const view = renderSection()
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(1))

    listPending = vi.fn(async () => [pendingNote()])
    contextValue = { ...contextValue, dataRefreshCount: 1 } as unknown as AppContextValue
    view.rerender(
      <MemoryRouter>
        <ClientNotesSection clientId="c1" ownerMode currentUserId="emp-owner" />
      </MemoryRouter>,
    )
    expect(await screen.findByText('1 waiting for a checklist')).toBeInTheDocument()
  })
})
