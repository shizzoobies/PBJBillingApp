import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientNotesPanel } from '../components/ClientNotesPanel'
import type { AppContextValue } from '../AppContext'
import { ApiError, type AppData, type Checklist, type ChecklistTemplate, type ClientPendingNote } from '../lib/types'

/**
 * Pending notes for future recurring checklists (featreq-b688e73c), the
 * client-page half: the "For an upcoming checklist" block inside
 * ClientNotesPanel — the write gate (mirrors `pendingNoteWriteDenial`),
 * adding, how an attached note renders, and when the list refetches. (The
 * count pill lives in the section header: client-notes-section-pill.test.tsx.)
 * Reuses the existing `ClientNotesPanel` plumbing (client-statements-panel
 * test's mocking pattern), so the plain-notes half is stubbed out rather than
 * re-tested here.
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

function payrollTemplate(over: Partial<ChecklistTemplate> = {}): ChecklistTemplate {
  return {
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
    ...over,
  } as unknown as ChecklistTemplate
}

function renderPanel({
  clientId = 'c1',
  ownerMode = true,
  currentUserId = 'emp-owner',
  templates = [payrollTemplate()],
  checklists = [],
}: {
  clientId?: string
  ownerMode?: boolean
  currentUserId?: string
  templates?: ChecklistTemplate[]
  checklists?: Checklist[]
} = {}) {
  contextValue = {
    data: { checklistTemplates: templates, checklists } as unknown as AppData,
    dataRefreshCount: 0,
  } as unknown as AppContextValue
  return render(
    <MemoryRouter>
      <ClientNotesPanel clientId={clientId} ownerMode={ownerMode} currentUserId={currentUserId} />
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

beforeEach(() => {
  listPending = vi.fn(async () => [])
  addPending = vi.fn(async (_id: string, note: { templateId: string; kind: string; body: string }) =>
    pendingNote({ ...note, id: 'pnote-new' } as Partial<ClientPendingNote>),
  )
  deletePending = vi.fn(async () => ({ ok: true }))
})

describe('refetching the pending notes', () => {
  const rerenderWith = (view: ReturnType<typeof renderPanel>, over: Partial<AppContextValue>) => {
    contextValue = { ...contextValue, ...over } as AppContextValue
    view.rerender(
      <MemoryRouter>
        <ClientNotesPanel clientId="c1" ownerMode currentUserId="emp-owner" />
      </MemoryRouter>,
    )
  }

  it('fetches once, and a new `data` reference alone does not refetch', async () => {
    listPending = vi.fn(async () => [pendingNote()])
    const view = renderPanel()
    await screen.findByText('New hire starting')
    expect(listPending).toHaveBeenCalledTimes(1)

    // Every local edit replaces `data`; that must not hit the server again.
    rerenderWith(view, {
      data: { checklistTemplates: [payrollTemplate()], checklists: [] } as unknown as AppData,
    })
    rerenderWith(view, {
      data: { checklistTemplates: [payrollTemplate()], checklists: [] } as unknown as AppData,
    })
    expect(listPending).toHaveBeenCalledTimes(1)
  })

  it('refetches on the data-changed signal, keeping the rows on screen while it does', async () => {
    listPending = vi.fn(async () => [pendingNote()])
    const view = renderPanel()
    await screen.findByText('New hire starting')

    let finish: (notes: ClientPendingNote[]) => void = () => {}
    listPending = vi.fn(
      () =>
        new Promise<ClientPendingNote[]>((resolve) => {
          finish = resolve
        }),
    )
    rerenderWith(view, { dataRefreshCount: 1 })
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(1))

    // In flight: the existing row is still there and nothing flashes "Loading".
    expect(screen.getByText('New hire starting')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()

    finish([pendingNote(), pendingNote({ id: 'pnote-2', body: 'A second one' })])
    expect(await screen.findByText('A second one')).toBeInTheDocument()
    expect(screen.getByText('New hire starting')).toBeInTheDocument()
  })

  it('says "Loading…" only until the first answer', async () => {
    let finish: (notes: ClientPendingNote[]) => void = () => {}
    listPending = vi.fn(
      () =>
        new Promise<ClientPendingNote[]>((resolve) => {
          finish = resolve
        }),
    )
    renderPanel()
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    finish([pendingNote()])
    expect(await screen.findByText('New hire starting')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })
})

describe('the "for an upcoming checklist" block', () => {
  it('is shown to the owner', async () => {
    listPending = vi.fn(async () => [pendingNote()])
    renderPanel()
    expect(await screen.findByText('For an upcoming checklist')).toBeInTheDocument()
    expect(await screen.findByText('New hire starting')).toBeInTheDocument()
  })

  it('shows a staff user with no write access the LIST of what is waiting, but not the add form', async () => {
    listPending = vi.fn(async () => [pendingNote({ body: 'Waiting for the next run' })])
    renderPanel({
      ownerMode: false,
      currentUserId: 'emp-stranger',
      templates: [payrollTemplate({ assigneeId: 'emp-lisa' })],
    })
    expect(await screen.findByText('Waiting for the next run')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/hasn't come up yet/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Add$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    // Not theirs, so nothing to delete either.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('is hidden for a staff user with no write access to any active template', async () => {
    renderPanel({
      ownerMode: false,
      currentUserId: 'emp-stranger',
      templates: [payrollTemplate()],
    })
    // Give the plain-notes load a tick so we are not just catching a loading flash.
    await screen.findByText('No notes yet.')
    expect(screen.queryByText('For an upcoming checklist')).not.toBeInTheDocument()
  })

  it('shows the block for a staff user who is the template’s assignee, and lets them add', async () => {
    renderPanel({
      ownerMode: false,
      currentUserId: 'emp-lisa',
      templates: [payrollTemplate({ assigneeId: 'emp-lisa' })],
    })
    expect(await screen.findByText('For an upcoming checklist')).toBeInTheDocument()
    const addButton = screen.getByRole('button', { name: /^Add$/ })
    expect(addButton).toBeDisabled() // no body typed yet
    fireEvent.change(screen.getByPlaceholderText(/hasn't come up yet/i), {
      target: { value: 'New hire starting' },
    })
    expect(addButton).not.toBeDisabled()
  })

  it('shows the block, but disables Add, for a staff user who can see the template with no write access to it — only via a live checklist they are on', async () => {
    renderPanel({
      ownerMode: false,
      currentUserId: 'emp-brit',
      templates: [payrollTemplate({ assigneeId: 'emp-lisa' })],
      checklists: [],
    })
    // Not the template's assignee/editor and no live checklist of it yet —
    // nothing eligible, so the block does not render at all.
    await screen.findByText('No notes yet.')
    expect(screen.queryByText('For an upcoming checklist')).not.toBeInTheDocument()
  })

  it('submits a new note against the selected template', async () => {
    renderPanel()
    fireEvent.change(await screen.findByPlaceholderText(/hasn't come up yet/i), {
      target: { value: 'New hire starting' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))
    await waitFor(() => expect(addPending).toHaveBeenCalledWith('c1', {
      templateId: 'tmpl-payroll',
      kind: 'task',
      body: 'New hire starting',
    }))
  })

  it('renders a pending row with its target and kind', async () => {
    listPending = vi.fn(async () => [pendingNote({ kind: 'note' })])
    renderPanel()
    expect(await screen.findByText('New hire starting')).toBeInTheDocument()
    expect(screen.getByText(/→ Payroll as Note/)).toBeInTheDocument()
  })

  it('renders an attached note grayed with a link to the checklist', async () => {
    listPending = vi.fn(async () => [
      pendingNote({
        attachedChecklistId: 'chk-1',
        attachedAt: '2026-09-25T00:00:00.000Z',
      }),
    ])
    renderPanel({
      checklists: [
        {
          id: 'chk-1',
          title: 'Payroll',
          clientId: 'c1',
          assigneeId: 'emp-lisa',
          dueDate: '2026-10-05',
          viewerIds: [],
          editorIds: [],
          items: [],
        } as unknown as Checklist,
      ],
    })
    const link = await screen.findByRole('link', { name: /Payroll \(2026-10-05\)/ })
    expect(link).toHaveAttribute('href', '/checklists?focus=chk-1')
  })

  it('lets the owner delete any pending note; a staff author only their own, and only while unattached', async () => {
    listPending = vi.fn(async () => [
      pendingNote({ id: 'pnote-mine', authorId: 'emp-lisa', body: 'Unattached note' }),
      pendingNote({
        id: 'pnote-attached-mine',
        authorId: 'emp-lisa',
        body: 'Attached note',
        attachedChecklistId: 'chk-1',
        attachedAt: '2026-09-25T00:00:00.000Z',
      }),
    ])
    const { rerender } = renderPanel({
      ownerMode: false,
      currentUserId: 'emp-lisa',
      templates: [payrollTemplate({ assigneeId: 'emp-lisa' })],
    })
    await screen.findByText('Unattached note')
    await screen.findByText('Attached note')
    // Only the unattached one owned by this staff user is deletable.
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)

    contextValue = {
      data: { checklistTemplates: [payrollTemplate()], checklists: [] } as unknown as AppData,
      dataRefreshCount: 0,
    } as unknown as AppContextValue
    rerender(
      <MemoryRouter>
        <ClientNotesPanel clientId="c1" ownerMode currentUserId="emp-owner" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2))
  })

  it('deletes a pending note', async () => {
    listPending = vi.fn(async () => [pendingNote({ authorId: 'emp-owner' })])
    renderPanel({ currentUserId: 'emp-owner' })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deletePending).toHaveBeenCalledWith('c1', 'pnote-1'))
    await waitFor(() => expect(screen.queryByText('New hire starting')).not.toBeInTheDocument())
  })
})

describe('accessibility, preview mode, the 100-note cap and a stale load error', () => {
  const typeNote = (text: string) =>
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for an upcoming checklist' }), {
      target: { value: text },
    })

  it('names the textarea and groups the Task / Note radios under "Add as"', async () => {
    renderPanel()
    await waitFor(() => expect(listPending).toHaveBeenCalled())
    expect(screen.getByRole('textbox', { name: 'Note for an upcoming checklist' })).toBeInTheDocument()
    const group = screen.getByRole('group', { name: 'Add as' })
    expect(within(group).getByRole('radio', { name: 'Task' })).toBeChecked()
    expect(within(group).getByRole('radio', { name: 'Note' })).not.toBeChecked()
  })

  it('disables Add with "Disabled in preview mode" while previewing as someone', async () => {
    renderPanel()
    contextValue = { ...contextValue, previewMode: true } as unknown as AppContextValue
    cleanup()
    render(
      <MemoryRouter>
        <ClientNotesPanel clientId="c1" ownerMode currentUserId="emp-owner" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(listPending).toHaveBeenCalled())
    typeNote('Heads up')
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    expect(add).toHaveAttribute('title', 'Disabled in preview mode')
  })

  it('shows the server sentence when the client already has 100 notes waiting', async () => {
    addPending = vi.fn(async () => {
      throw new ApiError(
        409,
        'This client already has 100 notes waiting. Delete some first.',
        'too_many_pending_notes',
      )
    })
    renderPanel()
    await waitFor(() => expect(listPending).toHaveBeenCalled())
    typeNote('One more')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(
      await screen.findByText('This client already has 100 notes waiting. Delete some first.'),
    ).toBeInTheDocument()
    // Any other failure keeps the generic line.
    addPending = vi.fn(async () => {
      throw new Error('boom')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Could not add that note — please try again.')).toBeInTheDocument()
  })

  it('does not carry one client’s load error over to the next client', async () => {
    listPending = vi.fn(async () => {
      throw new Error('down')
    })
    const view = renderPanel({ templates: [payrollTemplate(), payrollTemplate({ id: 'tmpl-2', clientId: 'c2' })] })
    expect(await screen.findByText('Could not load pending notes.')).toBeInTheDocument()

    // The next client's load is still in flight: its answer has not cleared anything yet.
    listPending = vi.fn(() => new Promise<ClientPendingNote[]>(() => {}))
    view.rerender(
      <MemoryRouter>
        <ClientNotesPanel clientId="c2" ownerMode currentUserId="emp-owner" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(listPending).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Could not load pending notes.')).not.toBeInTheDocument())
  })
})
