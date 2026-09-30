import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachedClientNotes } from '../pages/ChecklistsPage'
import type { ClientPendingNote } from '../lib/types'

/**
 * "Notes from the client page" (featreq-b688e73c): the read-only block a
 * checklist shows for kind-'note' pending notes attached to it —
 * GET /api/checklists/:id/pending-notes. Kind 'task' is excluded here; it
 * already landed as an ordinary item, so showing it again would double it up.
 */

vi.mock('../lib/api', () => ({
  listPendingNotesForChecklistRequest: (...args: unknown[]) => listNotes(...args),
}))

let listNotes = vi.fn()

const note = (over: Partial<ClientPendingNote> = {}): ClientPendingNote => ({
  id: 'pnote-1',
  clientId: 'c1',
  templateId: 'tmpl-payroll',
  kind: 'note',
  body: 'New hire starting this cycle',
  authorId: 'emp-lisa',
  authorName: 'Lisa',
  createdAt: '2026-09-20T12:00:00.000Z',
  attachedChecklistId: 'chk-1',
  attachedItemId: null,
  attachedAt: '2026-09-25T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  listNotes = vi.fn(async () => [])
})

describe('AttachedClientNotes', () => {
  it('renders nothing when there are no attached notes', async () => {
    const { container } = render(<AttachedClientNotes checklistId="chk-1" />)
    await waitFor(() => expect(listNotes).toHaveBeenCalledWith('chk-1'))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a kind-"note" note, with its author', async () => {
    listNotes = vi.fn(async () => [note()])
    render(<AttachedClientNotes checklistId="chk-1" />)
    expect(await screen.findByText('Notes from the client page')).toBeInTheDocument()
    expect(screen.getByText('New hire starting this cycle')).toBeInTheDocument()
    expect(screen.getByText('Lisa')).toBeInTheDocument()
  })

  it('excludes a kind-"task" note — it is already an ordinary item', async () => {
    listNotes = vi.fn(async () => [note({ id: 'pnote-task', kind: 'task' })])
    const { container } = render(<AttachedClientNotes checklistId="chk-1" />)
    await waitFor(() => expect(listNotes).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders both when a checklist has one of each kind', async () => {
    listNotes = vi.fn(async () => [
      note({ id: 'pnote-note', kind: 'note', body: 'Shown note' }),
      note({ id: 'pnote-task', kind: 'task', body: 'Hidden task note' }),
    ])
    render(<AttachedClientNotes checklistId="chk-1" />)
    expect(await screen.findByText('Shown note')).toBeInTheDocument()
    expect(screen.queryByText('Hidden task note')).not.toBeInTheDocument()
  })
})
