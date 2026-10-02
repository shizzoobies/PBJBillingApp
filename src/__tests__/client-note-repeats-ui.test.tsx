import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientNotesPanel } from '../components/ClientNotesPanel'
import { pendingNoteCount } from '../hooks/useClientPendingNotes'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, ChecklistTemplate, ClientPendingNote } from '../lib/types'

/**
 * A client note that repeats on every month's checklist (featreq-1f352c4f), the
 * client-page half: the "Repeat on every checklist from now on" box (off by
 * default) on the create form, the "Repeats on every checklist" line in the list
 * (with what it was last added to once it has been used) and its "Stop repeating"
 * action. One-time notes look and behave exactly as before. The mocking pattern is
 * the one in client-notes-panel-pending.test.tsx.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listClientNotes: async () => [],
  addClientNote: vi.fn(),
  deleteClientNote: vi.fn(),
  listClientPendingNotesRequest: (...args: unknown[]) => listPending(...args),
  addClientPendingNoteRequest: (...args: unknown[]) => addPending(...args),
  deleteClientPendingNoteRequest: (...args: unknown[]) => deletePending(...args),
}))

let listPending = vi.fn()
let addPending = vi.fn()
let deletePending = vi.fn()
let contextValue: AppContextValue

const template = {
  id: 'tmpl-payroll',
  title: 'Payroll',
  clientId: 'c1',
  assigneeId: 'emp-lisa',
  frequency: 'monthly',
  nextDueDate: '2026-10-01',
  active: true,
  viewerIds: [],
  editorIds: [],
  stages: [],
} as unknown as ChecklistTemplate

function renderPanel({
  ownerMode = true,
  currentUserId = 'emp-owner',
}: { ownerMode?: boolean; currentUserId?: string } = {}) {
  contextValue = {
    data: { checklistTemplates: [template], checklists: [] as Checklist[] } as unknown as AppData,
    dataRefreshCount: 0,
  } as unknown as AppContextValue
  return render(
    <MemoryRouter>
      <ClientNotesPanel clientId="c1" ownerMode={ownerMode} currentUserId={currentUserId} />
    </MemoryRouter>,
  )
}

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

const repeating = (over: Partial<ClientPendingNote> = {}) =>
  pendingNote({
    id: 'pnote-r',
    body: 'Send the 1099s',
    repeats: true,
    lastAttachedChecklistId: null,
    lastAttachedDueDate: null,
    ...over,
  })

const BOX = 'Repeat on every checklist from now on'

beforeEach(() => {
  listPending = vi.fn(async () => [])
  addPending = vi.fn(async (_id: string, note: { templateId: string; kind: string; body: string; repeats?: boolean }) =>
    pendingNote({ ...note, id: 'pnote-new' } as Partial<ClientPendingNote>),
  )
  deletePending = vi.fn(async () => ({ ok: true }))
})

const typeNote = (text: string) =>
  fireEvent.change(screen.getByLabelText('Note for an upcoming checklist'), { target: { value: text } })

describe('the create form', () => {
  it('has the Repeat box, off by default', async () => {
    renderPanel()
    const box = await screen.findByLabelText(BOX)
    expect(box).toHaveProperty('type', 'checkbox')
    expect(box).not.toBeChecked()
  })

  it('without the box ticked, sends exactly the request it always sent (no repeats field)', async () => {
    renderPanel()
    typeNote('One time only')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(addPending).toHaveBeenCalledTimes(1))
    expect(addPending).toHaveBeenCalledWith('c1', {
      templateId: 'tmpl-payroll',
      kind: 'task',
      body: 'One time only',
    })
  })

  it('with the box ticked, sends repeats: true, then clears the box for the next note', async () => {
    addPending = vi.fn(async (_id: string, note: Record<string, unknown>) =>
      repeating({ ...(note as Partial<ClientPendingNote>), id: 'pnote-new' }),
    )
    renderPanel()
    typeNote('Every month')
    fireEvent.click(screen.getByLabelText(BOX))
    expect(screen.getByLabelText(BOX)).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(addPending).toHaveBeenCalledTimes(1))
    expect(addPending).toHaveBeenCalledWith('c1', {
      templateId: 'tmpl-payroll',
      kind: 'task',
      body: 'Every month',
      repeats: true,
    })
    await screen.findByText('Repeats on every checklist')
    expect(screen.getByLabelText(BOX)).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Stop repeating' })).toBeTruthy()
  })
})

describe('the list', () => {
  const rowOf = (text: string) => screen.getByText(text).closest('li') as HTMLElement

  it('says a repeating note repeats, and what it was last added to once it has been used', async () => {
    listPending = vi.fn(async () => [
      repeating({ lastAttachedChecklistId: 'chk-a', lastAttachedDueDate: '2026-10-10' }),
    ])
    renderPanel()
    await screen.findByText('Send the 1099s')
    const row = rowOf('Send the 1099s')
    expect(within(row).getByText(/Repeats on every checklist/)).toBeTruthy()
    expect(row.textContent).toContain('last added to the Oct 10, 2026 checklist')
    expect(within(row).getByRole('button', { name: 'Stop repeating' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('a repeating note not used yet says it repeats and nothing about a last checklist', async () => {
    listPending = vi.fn(async () => [repeating()])
    renderPanel()
    await screen.findByText('Send the 1099s')
    const row = rowOf('Send the 1099s')
    expect(row.textContent).toContain('Repeats on every checklist')
    expect(row.textContent).not.toContain('last added')
  })

  it('a one-time note looks and behaves exactly as before', async () => {
    listPending = vi.fn(async () => [pendingNote()])
    renderPanel()
    await screen.findByText('New hire starting')
    const row = rowOf('New hire starting')
    expect(row.textContent).not.toContain('Repeats')
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Stop repeating' })).toBeNull()
  })

  it('a copy a repeating note left on a checklist carries a quiet (repeat) marker; a one-time note and the repeating note itself do not', async () => {
    listPending = vi.fn(async () => [
      repeating(),
      pendingNote({
        id: 'pnote-copy',
        body: 'Send the 1099s',
        attachedChecklistId: 'chk-a',
        attachedItemId: 'item-pn-copy',
        attachedAt: '2026-10-01T00:00:00.000Z',
        repeatOf: 'pnote-r',
      }),
      pendingNote({
        id: 'pnote-once',
        body: 'Attached once',
        attachedChecklistId: 'chk-b',
        attachedAt: '2026-10-01T00:00:00.000Z',
      }),
    ])
    renderPanel()
    await screen.findByText('Attached once')
    const bodies = Array.from(document.querySelectorAll('.pending-client-note .client-note-body')).map(
      (el) => el.textContent,
    )
    expect(bodies).toEqual(['Send the 1099s', 'Send the 1099s (repeat)', 'Attached once'])
  })

  it('a copy has no Delete (for an owner too) while a one-time attached note and the repeating note keep theirs', async () => {
    listPending = vi.fn(async () => [
      repeating(),
      pendingNote({
        id: 'pnote-copy',
        body: 'The copy',
        attachedChecklistId: 'chk-a',
        attachedItemId: 'item-pn-copy',
        attachedAt: '2026-10-01T00:00:00.000Z',
        repeatOf: 'pnote-r',
      }),
      pendingNote({
        id: 'pnote-once',
        body: 'Attached once',
        attachedChecklistId: 'chk-b',
        attachedAt: '2026-10-01T00:00:00.000Z',
      }),
    ])
    renderPanel()
    await screen.findByText('Attached once')
    expect(within(rowOf('The copy')).queryByRole('button')).toBeNull()
    expect(rowOf('The copy').textContent).toContain('(repeat)')
    expect(within(rowOf('Attached once')).getByRole('button', { name: 'Delete' })).toBeTruthy()
    expect(within(rowOf('Send the 1099s')).getByRole('button', { name: 'Stop repeating' })).toBeTruthy()
  })

  it('Stop repeating removes the note through the delete route and leaves the copies on checklists listed', async () => {
    listPending = vi.fn(async () => [
      repeating({ lastAttachedChecklistId: 'chk-a', lastAttachedDueDate: '2026-10-10' }),
      pendingNote({
        id: 'pnote-copy',
        body: 'Send the 1099s',
        attachedChecklistId: 'chk-a',
        attachedItemId: 'item-pn-copy',
        attachedAt: '2026-10-01T00:00:00.000Z',
        repeatOf: 'pnote-r',
      }),
    ])
    renderPanel()
    await screen.findByRole('button', { name: 'Stop repeating' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop repeating' }))
    await waitFor(() => expect(deletePending).toHaveBeenCalledWith('c1', 'pnote-r'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop repeating' })).toBeNull())
    expect(screen.queryByText('Repeats on every checklist')).toBeNull()
    // The copy that already went on a checklist is still in the list, untouched.
    expect(screen.getAllByText('Send the 1099s')).toHaveLength(1)
    expect(deletePending).toHaveBeenCalledTimes(1)
  })

  it('the author (not an owner) can stop their own repeating note; another teammate cannot', async () => {
    listPending = vi.fn(async () => [repeating({ authorId: 'emp-lisa' })])
    const own = renderPanel({ ownerMode: false, currentUserId: 'emp-lisa' })
    await screen.findByText('Send the 1099s')
    expect(screen.getByRole('button', { name: 'Stop repeating' })).toBeTruthy()
    own.unmount()

    listPending = vi.fn(async () => [repeating({ authorId: 'emp-lisa' })])
    renderPanel({ ownerMode: false, currentUserId: 'emp-someone-else' })
    await screen.findByText('Send the 1099s')
    expect(screen.queryByRole('button', { name: 'Stop repeating' })).toBeNull()
  })
})

describe('the "waiting for a checklist" count', () => {
  it('counts one-time notes that are waiting, not a repeating note (it is a standing one)', () => {
    expect(
      pendingNoteCount([
        pendingNote({ id: 'a' }),
        pendingNote({ id: 'b', attachedChecklistId: 'chk-a' }),
        repeating({ id: 'c' }),
      ]),
    ).toBe(1)
  })
})
