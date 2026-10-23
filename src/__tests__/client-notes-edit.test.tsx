import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientNotesPanel } from '../components/ClientNotesPanel'
import type { AppContextValue } from '../AppContext'
import {
  ApiError,
  type AppData,
  type ChecklistTemplate,
  type ClientNote,
  type ClientPendingNote,
} from '../lib/types'

/**
 * The writer of a note can edit it (featreq-da3801ab), the notes box half: an
 * Edit link on YOUR OWN notes only (the owner is no exception - her words: "Only
 * the original creator can edit a note"), an inline textarea with Save / Cancel
 * (Esc cancels), and a quiet "edited <date>" after the body. A pending note is
 * editable only while it waits for a checklist. The server refuses everyone else
 * anyway (note-edit-routes.test.ts, lib/note-edit-permission.test.mjs).
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listClientNotes: (...args: unknown[]) => listNotes(...args),
  addClientNote: vi.fn(),
  deleteClientNote: vi.fn(),
  updateClientNoteRequest: (...args: unknown[]) => updateNote(...args),
  listClientPendingNotesRequest: (...args: unknown[]) => listPending(...args),
  addClientPendingNoteRequest: vi.fn(),
  deleteClientPendingNoteRequest: vi.fn(),
  updateClientPendingNoteRequest: (...args: unknown[]) => updatePending(...args),
}))

let listNotes = vi.fn()
let updateNote = vi.fn()
let listPending = vi.fn()
let updatePending = vi.fn()
let contextValue: AppContextValue

const template = {
  id: 'tmpl-payroll',
  title: 'Payroll',
  clientId: 'c1',
  assigneeId: 'emp-lisa',
  frequency: 'monthly',
  nextDueDate: '2026-11-01',
  active: true,
  viewerIds: [],
  editorIds: [],
  stages: [],
} as unknown as ChecklistTemplate

const clientNote = (over: Partial<ClientNote> = {}): ClientNote => ({
  id: 'cnote-lisa',
  clientId: 'c1',
  authorId: 'emp-lisa',
  authorName: 'Lisa',
  body: 'Teh bank changed',
  createdAt: '2026-10-20T15:00:00.000Z',
  ...over,
})

const pendingNote = (over: Partial<ClientPendingNote> = {}): ClientPendingNote => ({
  id: 'pnote-lisa',
  clientId: 'c1',
  templateId: 'tmpl-payroll',
  kind: 'note',
  body: 'New hire startng',
  authorId: 'emp-lisa',
  authorName: 'Lisa',
  createdAt: '2026-10-20T15:00:00.000Z',
  attachedChecklistId: null,
  attachedItemId: null,
  attachedAt: null,
  ...over,
})

function renderPanel({ ownerMode = false, currentUserId = 'emp-lisa', previewMode = false } = {}) {
  contextValue = {
    data: { checklistTemplates: [template], checklists: [] } as unknown as AppData,
    dataRefreshCount: 0,
    previewMode,
  } as unknown as AppContextValue
  return render(
    <MemoryRouter>
      <ClientNotesPanel clientId="c1" ownerMode={ownerMode} currentUserId={currentUserId} />
    </MemoryRouter>,
  )
}

/** The list row that holds `text`. */
async function rowOf(text: string) {
  const body = await screen.findByText(text)
  const row = body.closest('li')
  expect(row).not.toBeNull()
  return row as HTMLElement
}

beforeEach(() => {
  listNotes = vi.fn(async () => [
    clientNote(),
    clientNote({ id: 'cnote-pat', authorId: 'emp-patrice', authorName: 'Brittany', body: 'Her note' }),
  ])
  updateNote = vi.fn(async (_clientId: string, noteId: string, body: string) =>
    clientNote({ id: noteId, body, editedAt: '2026-10-23T14:00:00.000Z' }),
  )
  listPending = vi.fn(async () => [
    pendingNote(),
    pendingNote({ id: 'pnote-pat', authorId: 'emp-patrice', authorName: 'Brittany', body: 'Her pending' }),
    pendingNote({ id: 'pnote-att', body: 'Already on it', attachedChecklistId: 'chk-1', attachedAt: '2026-10-21T12:00:00.000Z' }),
  ])
  updatePending = vi.fn(async (_clientId: string, noteId: string, body: string) =>
    pendingNote({ id: noteId, body, editedAt: '2026-10-23T14:00:00.000Z' }),
  )
})

afterEach(() => cleanup())

describe('the notes log', () => {
  it('shows Edit only on your own note', async () => {
    renderPanel()
    const own = await rowOf('Teh bank changed')
    const hers = await rowOf('Her note')
    expect(within(own).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(hers).queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('the owner gets no Edit on a teammate’s note (she can still delete it)', async () => {
    renderPanel({ ownerMode: true, currentUserId: 'emp-patrice' })
    const lisas = await rowOf('Teh bank changed')
    expect(within(lisas).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(lisas).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(within(await rowOf('Her note')).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('save sends the new words and shows the note with an "edited" marker', async () => {
    renderPanel()
    const own = await rowOf('Teh bank changed')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    const box = within(own).getByRole('textbox', { name: 'Edit note' })
    expect(box).toHaveValue('Teh bank changed')
    fireEvent.change(box, { target: { value: 'The bank changed' } })
    fireEvent.click(within(own).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateNote).toHaveBeenCalledWith('c1', 'cnote-lisa', 'The bank changed'))
    const saved = await rowOf('The bank changed')
    expect(within(saved).getByText(/^edited Oct 23, 2026$/)).toBeInTheDocument()
    expect(within(saved).queryByRole('textbox')).toBeNull()
  })

  it('Cancel puts the note back as it was, and nothing is sent', async () => {
    renderPanel()
    const own = await rowOf('Teh bank changed')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(own).getByRole('textbox', { name: 'Edit note' }), { target: { value: 'Something else' } })
    fireEvent.click(within(own).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Teh bank changed')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull()
    // Opening it again starts from the saved words, not the abandoned draft.
    fireEvent.click(within(await rowOf('Teh bank changed')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Edit note' })).toHaveValue('Teh bank changed')
    expect(updateNote).not.toHaveBeenCalled()
  })

  it('Esc cancels too', async () => {
    renderPanel()
    const own = await rowOf('Teh bank changed')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    fireEvent.keyDown(within(own).getByRole('textbox', { name: 'Edit note' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull()
    expect(updateNote).not.toHaveBeenCalled()
  })

  it('Save is off while the box is blank', async () => {
    renderPanel()
    const own = await rowOf('Teh bank changed')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(own).getByRole('textbox', { name: 'Edit note' }), { target: { value: '   ' } })
    expect(within(own).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('a refused save keeps the box open and says why', async () => {
    updateNote = vi.fn(async () => {
      throw new ApiError(403, 'Only the person who wrote this note can edit it.')
    })
    renderPanel()
    const own = await rowOf('Teh bank changed')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(own).getByRole('textbox', { name: 'Edit note' }), { target: { value: 'x' } })
    fireEvent.click(within(own).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Only the person who wrote this note can edit it.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Edit note' })).toHaveValue('x')
  })

  it('a note edited earlier shows its marker on load', async () => {
    listNotes = vi.fn(async () => [clientNote({ editedAt: '2026-10-22T14:00:00.000Z' })])
    renderPanel()
    expect(within(await rowOf('Teh bank changed')).getByText(/^edited Oct 22, 2026$/)).toBeInTheDocument()
  })

  it('Edit is off in preview mode', async () => {
    renderPanel({ previewMode: true })
    expect(within(await rowOf('Teh bank changed')).getByRole('button', { name: 'Edit' })).toBeDisabled()
  })
})

describe('pending notes', () => {
  it('shows Edit only on your own note that still waits for a checklist', async () => {
    renderPanel()
    expect(within(await rowOf('New hire startng')).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(await rowOf('Her pending')).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(await rowOf('Already on it')).queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('the owner gets no Edit on a teammate’s pending note', async () => {
    renderPanel({ ownerMode: true, currentUserId: 'emp-patrice' })
    expect(within(await rowOf('New hire startng')).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(await rowOf('Her pending')).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('save sends the new words and shows the note with an "edited" marker', async () => {
    renderPanel()
    const own = await rowOf('New hire startng')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    const box = within(own).getByRole('textbox', { name: 'Edit note' })
    fireEvent.change(box, { target: { value: 'New hire starting' } })
    fireEvent.click(within(own).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updatePending).toHaveBeenCalledWith('c1', 'pnote-lisa', 'New hire starting'))
    expect(within(await rowOf('New hire starting')).getByText(/^edited Oct 23, 2026$/)).toBeInTheDocument()
  })

  it('a 409 (it was just added to a checklist) shows the server’s sentence', async () => {
    updatePending = vi.fn(async () => {
      throw new ApiError(409, 'This note was already added to a checklist - edit it there.', 'pending_note_attached')
    })
    renderPanel()
    const own = await rowOf('New hire startng')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    fireEvent.click(within(own).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This note was already added to a checklist - edit it there.')).toBeInTheDocument()
  })

  it('Cancel puts it back, and nothing is sent', async () => {
    renderPanel()
    const own = await rowOf('New hire startng')
    fireEvent.click(within(own).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(own).getByRole('textbox', { name: 'Edit note' }), { target: { value: 'zzz' } })
    fireEvent.click(within(own).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('New hire startng')).toBeInTheDocument()
    expect(updatePending).not.toHaveBeenCalled()
  })
})
