import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveChecklistsBody } from '../pages/ClientDetailPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client, ClientPendingNote } from '../lib/types'

/**
 * One month's copy of a repeating NOTE can be taken off its checklist
 * (featreq-e8aa2abe). The card shows a note a repeating note put there with a
 * "(repeat)" marker and a small "Dismiss" text button; clicking it asks nothing,
 * dismisses, and the note leaves the card at once. A refusal shows the server's
 * own sentence under the note. An ordinary note has no Dismiss. Dismiss is shown
 * only to the people the server's `pendingNoteWriteDenial` allows (the owner, or
 * any teammate the client is visible to - widened on 2026-10-06 from the
 * assignee / editors of the recurring checklist, after Brittany's send-back that
 * Allison and Lisa had no controls): both sides read the one predicate,
 * `canAddPendingClientNote` in lib/checklist-write-permission.js. The route and the
 * store are pinned in `pending-client-notes-routes.test.ts` and
 * `db/store-staleness.test.mjs`.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: (...args: unknown[]) => listAttached(...args),
  dismissClientPendingNoteRequest: (...args: unknown[]) => dismiss(...args),
}))

let listAttached = vi.fn()
let dismiss = vi.fn()
let contextValue: AppContextValue

const CLIENT = { id: 'client-1', name: 'Acme' } as Client
const TITLE =
  "Take this note off this month's checklist. It will still be added to future months until the repeating note is stopped."

const CHECKLISTS = [
  {
    id: 'cl-a',
    clientId: CLIENT.id,
    title: 'Payroll A',
    assigneeId: 'emp-owner',
    dueDate: '2099-12-31',
    items: [{ id: 'it-1', label: 'Reconcile bank', done: false }],
  } as Checklist,
]

const data = {
  clients: [CLIENT],
  employees: [{ id: 'emp-owner', name: 'Owner', role: 'Owner' }],
  checklists: CHECKLISTS,
  checklistTemplates: [],
  timeEntries: [],
} as unknown as AppData

const note = (over: Partial<ClientPendingNote>): ClientPendingNote => ({
  id: 'pnote-copy',
  clientId: CLIENT.id,
  templateId: 'tmpl-1',
  kind: 'note',
  body: 'Remind them about the 1099s',
  authorId: 'emp-lisa',
  authorName: 'Lisa',
  createdAt: '2026-09-20T12:00:00.000Z',
  attachedChecklistId: 'cl-a',
  attachedItemId: null,
  attachedAt: '2026-09-25T00:00:00.000Z',
  repeatOf: 'pnote-parent',
  ...over,
})

function signInAsOwner(extra: Record<string, unknown> = {}) {
  contextValue = {
    data,
    dataRefreshCount: 0,
    activeEmployeeId: 'emp-owner',
    role: 'owner',
    ownerMode: true,
    previewMode: false,
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
    deleteChecklistItemFromSeries: vi.fn(),
    removeSubItem: vi.fn(),
    removeSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    reorderChecklistSubItems: vi.fn(),
    setChecklistViewers: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateSubItemWaiting: vi.fn(),
    ...extra,
  } as unknown as AppContextValue
}

const renderCard = () => render(<ActiveChecklistsBody client={CLIENT} data={data} />)
const noteRow = (body: string) => screen.getByText(body).closest('li') as HTMLElement

beforeEach(() => {
  listAttached = vi.fn(async () => [
    note({}),
    note({ id: 'pnote-once', body: 'An ordinary note', repeatOf: undefined }),
    note({ id: 'pnote-task', kind: 'task', body: 'A task copy', attachedItemId: 'item-pn-x' }),
  ])
  dismiss = vi.fn().mockResolvedValue({ ok: true, dismissed: true })
  signInAsOwner()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Dismiss on the checklist card', () => {
  it('is on a note a repeating note added, marked "(repeat)", with the explaining tooltip - and not on an ordinary note', async () => {
    renderCard()
    await screen.findByText('Remind them about the 1099s')
    const copy = noteRow('Remind them about the 1099s')
    expect(copy.textContent).toContain('(repeat)')
    const button = within(copy).getByRole('button', { name: 'Dismiss' })
    expect(button).toHaveAttribute('title', TITLE)
    expect(button).not.toBeDisabled()
    // An ordinary note is left as it was, and a task copy is a step, not a note card entry.
    const ordinary = noteRow('An ordinary note')
    expect(within(ordinary).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    expect(ordinary.textContent).not.toContain('(repeat)')
    expect(screen.queryByText('A task copy')).not.toBeInTheDocument()
  })

  it('asks nothing, dismisses that note, and it leaves the card at once', async () => {
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    renderCard()
    await screen.findByText('Remind them about the 1099s')
    fireEvent.click(within(noteRow('Remind them about the 1099s')).getByRole('button', { name: 'Dismiss' }))
    expect(dismiss).toHaveBeenCalledWith(CLIENT.id, 'pnote-copy')
    await waitFor(() => expect(screen.queryByText('Remind them about the 1099s')).not.toBeInTheDocument())
    expect(confirm).not.toHaveBeenCalled()
    // The ordinary note stays.
    expect(screen.getByText('An ordinary note')).toBeInTheDocument()
  })

  it('stays gone when the page refetches (the server no longer lists it)', async () => {
    const view = renderCard()
    await screen.findByText('Remind them about the 1099s')
    fireEvent.click(within(noteRow('Remind them about the 1099s')).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText('Remind them about the 1099s')).not.toBeInTheDocument())
    listAttached = vi.fn(async () => [note({ id: 'pnote-once', body: 'An ordinary note', repeatOf: undefined })])
    contextValue = { ...contextValue, dataRefreshCount: 1 } as unknown as AppContextValue
    view.rerender(<ActiveChecklistsBody client={CLIENT} data={data} />)
    await waitFor(() => expect(listAttached).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Remind them about the 1099s')).not.toBeInTheDocument()
    expect(screen.getByText('An ordinary note')).toBeInTheDocument()
  })

  it("shows the server's sentence under the note on a refusal, keeps the note, and raises no alert", async () => {
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    const sentence = 'This repeating task became a step on this checklist. Remove the step on the checklist instead.'
    dismiss.mockRejectedValue(Object.assign(new Error(sentence), { status: 409 }))
    renderCard()
    await screen.findByText('Remind them about the 1099s')
    const copy = noteRow('Remind them about the 1099s')
    fireEvent.click(within(copy).getByRole('button', { name: 'Dismiss' }))
    expect(await within(copy).findByRole('alert')).toHaveTextContent(sentence)
    expect(screen.getByText('Remind them about the 1099s')).toBeInTheDocument()
    expect(within(copy).getByRole('button', { name: 'Dismiss' })).not.toBeDisabled()
    expect(alert).not.toHaveBeenCalled()
  })

  describe('is shown only to the people the server would let dismiss', () => {
    const TEMPLATE = {
      id: 'tmpl-1',
      clientId: CLIENT.id,
      title: 'Payroll',
      assigneeId: 'emp-owner',
      editorIds: [] as string[],
      isStandard: false,
      active: true,
      stages: [],
    }
    const viewAs = (viewer: string, checklistOver: Partial<Checklist>, template = TEMPLATE) => {
      const view = {
        ...data,
        checklists: [{ ...CHECKLISTS[0], templateId: 'tmpl-1', ...checklistOver } as Checklist],
        checklistTemplates: [template],
      } as unknown as AppData
      signInAsOwner({
        data: view,
        activeEmployeeId: viewer,
        ownerMode: false,
        role: 'employee',
        visibleChecklists: view.checklists,
      })
      return render(<ActiveChecklistsBody client={CLIENT} data={view} />)
    }
    const dismissButton = async () => {
      await screen.findByText('Remind them about the 1099s')
      return within(noteRow('Remind them about the 1099s')).queryByRole('button', { name: 'Dismiss' })
    }

    it('shows it to a teammate the client is visible to, even one on neither the template nor its checklists', async () => {
      // Brittany's send-back of 2026-10-06: teammates get the same controls as
      // the owner on their clients. The client is visible (the page loaded).
      viewAs('emp-lisa', { assigneeId: 'emp-owner', editorIds: [] })
      expect(await dismissButton()).toBeInTheDocument()
      expect(noteRow('Remind them about the 1099s').textContent).toContain('(repeat)')
    })

    it('shows it to the assignee of a live checklist of that recurring template', async () => {
      viewAs('emp-lisa', { assigneeId: 'emp-lisa' })
      expect(await dismissButton()).toBeInTheDocument()
    })

    it('shows it to an editor of one of those checklists', async () => {
      viewAs('emp-lisa', { assigneeId: 'emp-owner', editorIds: ['emp-lisa'] })
      expect(await dismissButton()).toBeInTheDocument()
    })

    it('shows it to an editor of the recurring template itself', async () => {
      viewAs('emp-lisa', { assigneeId: 'emp-owner', editorIds: [] }, { ...TEMPLATE, editorIds: ['emp-lisa'] })
      expect(await dismissButton()).toBeInTheDocument()
    })

    it('does not depend on which recurring template the live checklist belongs to', async () => {
      viewAs('emp-lisa', { assigneeId: 'emp-lisa', templateId: 'tmpl-other' })
      expect(await dismissButton()).toBeInTheDocument()
    })
  })

  it('is disabled while previewing someone, with the reason as its title', async () => {
    signInAsOwner({ previewMode: true })
    renderCard()
    await screen.findByText('Remind them about the 1099s')
    const button = within(noteRow('Remind them about the 1099s')).getByRole('button', { name: 'Dismiss' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Disabled in preview mode')
    fireEvent.click(button)
    expect(dismiss).not.toHaveBeenCalled()
  })
})
