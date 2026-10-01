import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { LAST_RECURRING_STEP_MESSAGE } from '../../lib/series-step-delete.js'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * Deleting a step on a recurring checklist asks where (featreq-01464e64): this
 * checklist only, or this and every future one. A one-off checklist has no
 * series, so it gets a plain confirm. Staff cannot edit the template, so they
 * are only ever offered the first choice (which files a deletion request).
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'
const OWNER = 'emp-patrice'

const CLIENT: Client = {
  id: 'client-shared',
  name: 'Shared Books LLC',
  assignedBookkeeperIds: [LISA],
} as unknown as Client

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: CLIENT.id,
    assigneeId: LISA,
    dueDate: '2026-08-31',
    viewerIds: [],
    editorIds: [],
    items: [{ id: `${over.id}-step`, label: 'Reconcile', done: false }],
    ...over,
  }) as Checklist

const RECURRING = checklist({ id: 'cl-recurring', title: 'Recurring close', templateId: 'tmpl-1' })
const ONE_OFF = checklist({ id: 'cl-oneoff', title: 'One off cleanup' })

const data = {
  clients: [CLIENT],
  employees: [
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
  ],
  checklists: [RECURRING, ONE_OFF],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue
let deleteChecklistItem: ReturnType<typeof vi.fn>
let deleteChecklistItemFromSeries: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean) {
  deleteChecklistItem = vi.fn().mockResolvedValue(undefined)
  deleteChecklistItemFromSeries = vi.fn().mockResolvedValue(undefined)
  contextValue = {
    data,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    visibleChecklists: checklistsVisibleTo(data.checklists, { viewerId, isOwner }),
    visibleClients: [CLIENT],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    pushChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { from: '2026-01-01', to: '2026-12-31' },
    setReportPeriod: vi.fn(),
    addChecklist: vi.fn(),
    addSeriesChecklistItem: vi.fn(),
    addSubItem: vi.fn(),
    addSubSubItem: vi.fn(),
    applyTemplateToClient: vi.fn(),
    approveChecklistDeletion: vi.fn(),
    bulkAddChecklistItems: vi.fn(),
    deleteChecklist: vi.fn(),
    deleteChecklistItem,
    reorderChecklistSubItems: vi.fn(),
    deleteChecklistItemFromSeries,
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/checklists']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

const cardFor = (title: string) => screen.getByText(title).closest('article, li, section') as HTMLElement
const clickDelete = (title: string) =>
  fireEvent.click(within(cardFor(title)).getByRole('button', { name: 'Delete item' }))
const prompt = (title: string) =>
  within(cardFor(title)).getByRole('group', { name: 'Where to delete this step' })

beforeEach(() => {
  vi.unstubAllGlobals()
  signInAs(OWNER, true)
})

describe('deleting a step on a recurring checklist', () => {
  it('asks first and deletes nothing yet', () => {
    renderPage()
    clickDelete('Recurring close')
    expect(prompt('Recurring close')).toHaveTextContent('Delete “Reconcile” from…')
    expect(deleteChecklistItem).not.toHaveBeenCalled()
    expect(deleteChecklistItemFromSeries).not.toHaveBeenCalled()
  })

  it('"This checklist only" deletes the step from this checklist alone', () => {
    renderPage()
    clickDelete('Recurring close')
    fireEvent.click(within(prompt('Recurring close')).getByRole('button', { name: 'This checklist only' }))
    expect(deleteChecklistItem).toHaveBeenCalledWith('cl-recurring', 'cl-recurring-step')
    expect(deleteChecklistItemFromSeries).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
  })

  it('an owner can choose "This + all future"', () => {
    renderPage()
    clickDelete('Recurring close')
    fireEvent.click(within(prompt('Recurring close')).getByRole('button', { name: 'This + all future' }))
    expect(deleteChecklistItemFromSeries).toHaveBeenCalledWith('cl-recurring', 'cl-recurring-step')
    expect(deleteChecklistItem).not.toHaveBeenCalled()
  })

  it('Cancel closes the question and deletes nothing', () => {
    renderPage()
    clickDelete('Recurring close')
    fireEvent.click(within(prompt('Recurring close')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
    expect(deleteChecklistItem).not.toHaveBeenCalled()
    expect(deleteChecklistItemFromSeries).not.toHaveBeenCalled()
  })

  describe('shows what the series delete did', () => {
    const chooseSeries = async () => {
      renderPage()
      clickDelete('Recurring close')
      fireEvent.click(within(prompt('Recurring close')).getByRole('button', { name: 'This + all future' }))
    }

    it('says how many upcoming checklists it removed the step from', async () => {
      deleteChecklistItemFromSeries.mockResolvedValue({
        removedFromTemplate: true,
        removedFromChecklists: ['a', 'b'],
        keptOnChecklists: [],
      })
      await chooseSeries()
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Removed from the recurring checklist and 2 upcoming checklists.',
      )
      expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
    })

    it('adds where it kept a copy because work had started', async () => {
      deleteChecklistItemFromSeries.mockResolvedValue({
        removedFromTemplate: true,
        removedFromChecklists: ['a'],
        keptOnChecklists: ['b', 'c'],
      })
      await chooseSeries()
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Removed from the recurring checklist and 1 upcoming checklist. Kept on 2 where work had started.',
      )
    })

    it('says so when the step was not on the recurring checklist under that name', async () => {
      deleteChecklistItemFromSeries.mockResolvedValue({
        removedFromTemplate: false,
        removedFromChecklists: [],
        keptOnChecklists: [],
      })
      await chooseSeries()
      expect(await screen.findByRole('status')).toHaveTextContent(
        'This step is not on the recurring checklist under that name, so only this checklist changed.',
      )
    })

    it('keeps the question open and shows the refusal when it is the last recurring step', async () => {
      deleteChecklistItemFromSeries.mockRejectedValue(new Error(LAST_RECURRING_STEP_MESSAGE))
      await chooseSeries()
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This is the last step of the recurring checklist. Delete or pause the recurring checklist instead.',
      )
      expect(prompt('Recurring close')).toBeInTheDocument()
    })
  })

  it('staff are offered only "This checklist only"', () => {
    signInAs(LISA, false)
    renderPage()
    clickDelete('Recurring close')
    const group = prompt('Recurring close')
    expect(within(group).getByRole('button', { name: 'This checklist only' })).toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: 'This + all future' })).not.toBeInTheDocument()
  })
})

describe('deleting a step on a one-off checklist', () => {
  it('is a plain confirm, and a yes deletes it', () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderPage()
    clickDelete('One off cleanup')
    expect(confirm).toHaveBeenCalledWith('Delete this step?')
    expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
    expect(deleteChecklistItem).toHaveBeenCalledWith('cl-oneoff', 'cl-oneoff-step')
    expect(deleteChecklistItemFromSeries).not.toHaveBeenCalled()
  })

  it('a no deletes nothing', () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    renderPage()
    clickDelete('One off cleanup')
    expect(deleteChecklistItem).not.toHaveBeenCalled()
  })
})
