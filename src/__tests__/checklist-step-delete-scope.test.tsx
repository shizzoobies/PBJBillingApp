import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
/** A long card: the question has to appear at the step that was clicked, not below them all. */
const TWO_STEPS = checklist({
  id: 'cl-two',
  title: 'Two step close',
  templateId: 'tmpl-1',
  items: [
    { id: 'cl-two-first', label: 'First step', done: false },
    { id: 'cl-two-second', label: 'Second step', done: false },
    { id: 'cl-two-third', label: 'Third step', done: false },
  ],
} as Partial<Checklist>)

const data = {
  clients: [CLIENT],
  employees: [
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
  ],
  checklists: [RECURRING, ONE_OFF, TWO_STEPS],
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
    dataRefreshCount: 0,
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

  it('"This checklist only" deletes the step from this checklist alone', async () => {
    renderPage()
    clickDelete('Recurring close')
    fireEvent.click(within(prompt('Recurring close')).getByRole('button', { name: 'This checklist only' }))
    expect(deleteChecklistItem).toHaveBeenCalledWith('cl-recurring', 'cl-recurring-step')
    expect(deleteChecklistItemFromSeries).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument(),
    )
  })

  describe('while a delete is in flight', () => {
    // A promise the test settles by hand, so the click is observed mid-request.
    const pending = () => {
      let settle: (value?: unknown) => void = () => {}
      const promise = new Promise((resolve) => {
        settle = resolve
      })
      return { promise, settle }
    }

    it('disables both choices so "This + all future" cannot be sent twice', async () => {
      const request = pending()
      deleteChecklistItemFromSeries.mockReturnValue(request.promise)
      renderPage()
      clickDelete('Recurring close')
      const group = within(prompt('Recurring close'))
      const everyFuture = group.getByRole('button', { name: 'This + all future' })
      const thisOnly = group.getByRole('button', { name: 'This checklist only' })
      expect(everyFuture).not.toBeDisabled()

      fireEvent.click(everyFuture)
      await waitFor(() => expect(everyFuture).toBeDisabled())
      expect(thisOnly).toBeDisabled()
      fireEvent.click(everyFuture)
      fireEvent.click(thisOnly)
      expect(deleteChecklistItemFromSeries).toHaveBeenCalledTimes(1)
      expect(deleteChecklistItem).not.toHaveBeenCalled()

      request.settle({ removedFromTemplate: true, removedFromChecklists: [], keptOnChecklists: [] })
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument(),
      )
    })

    it('disables both choices so "This checklist only" cannot be sent twice', async () => {
      const request = pending()
      deleteChecklistItem.mockReturnValue(request.promise)
      renderPage()
      clickDelete('Recurring close')
      const group = within(prompt('Recurring close'))
      const thisOnly = group.getByRole('button', { name: 'This checklist only' })

      fireEvent.click(thisOnly)
      await waitFor(() => expect(thisOnly).toBeDisabled())
      expect(group.getByRole('button', { name: 'This + all future' })).toBeDisabled()
      fireEvent.click(thisOnly)
      expect(deleteChecklistItem).toHaveBeenCalledTimes(1)

      request.settle()
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument(),
      )
    })

    it('enables them again when the series delete is refused', async () => {
      const request = pending()
      deleteChecklistItemFromSeries.mockReturnValue(request.promise)
      renderPage()
      clickDelete('Recurring close')
      const everyFuture = within(prompt('Recurring close')).getByRole('button', { name: 'This + all future' })
      fireEvent.click(everyFuture)
      await waitFor(() => expect(everyFuture).toBeDisabled())

      // Settle the pending call with a refusal.
      request.settle(Promise.reject(new Error(LAST_RECURRING_STEP_MESSAGE)))
      expect(await screen.findByRole('alert')).toHaveTextContent(LAST_RECURRING_STEP_MESSAGE)
      await waitFor(() => expect(everyFuture).not.toBeDisabled())
    })
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

  describe('where the question appears and how it behaves', () => {
    const stepItem = (label: string) =>
      screen.getByText(label, { selector: '.task-row-title' }).closest('.task-item') as HTMLElement
    const deleteStep = (label: string) =>
      fireEvent.click(within(stepItem(label)).getAllByRole('button', { name: 'Delete item' })[0])

    it('renders inside the row of the step being deleted, not below the whole list', () => {
      renderPage()
      deleteStep('Second step')
      const group = within(stepItem('Second step')).getByRole('group', { name: 'Where to delete this step' })
      expect(group).toHaveTextContent('Delete “Second step” from…')
      // Not under the other steps, and only one question is open.
      expect(
        within(stepItem('First step')).queryByRole('group', { name: 'Where to delete this step' }),
      ).not.toBeInTheDocument()
      expect(
        within(stepItem('Third step')).queryByRole('group', { name: 'Where to delete this step' }),
      ).not.toBeInTheDocument()
      expect(screen.getAllByRole('group', { name: 'Where to delete this step' })).toHaveLength(1)
    })

    it('takes focus when it opens, so the keyboard lands on the question', () => {
      renderPage()
      deleteStep('Second step')
      const first = within(stepItem('Second step')).getByRole('button', { name: 'This checklist only' })
      expect(first).toHaveFocus()
    })

    it('closes on Escape and deletes nothing', () => {
      renderPage()
      deleteStep('Second step')
      fireEvent.keyDown(within(stepItem('Second step')).getByRole('button', { name: 'This checklist only' }), {
        key: 'Escape',
      })
      expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
      expect(deleteChecklistItem).not.toHaveBeenCalled()
      expect(deleteChecklistItemFromSeries).not.toHaveBeenCalled()
    })

    it('does not close on Escape while a delete is running, and Cancel waits too', async () => {
      let settle: (value?: unknown) => void = () => {}
      deleteChecklistItemFromSeries.mockReturnValue(new Promise((resolve) => (settle = resolve)))
      renderPage()
      deleteStep('Second step')
      const group = within(stepItem('Second step'))
      fireEvent.click(group.getByRole('button', { name: 'This + all future' }))
      await waitFor(() => expect(group.getByRole('button', { name: 'Cancel' })).toBeDisabled())
      fireEvent.keyDown(group.getByRole('group', { name: 'Where to delete this step' }), { key: 'Escape' })
      expect(screen.getByRole('group', { name: 'Where to delete this step' })).toBeInTheDocument()
      settle({ removedFromTemplate: true, removedFromChecklists: [], keptOnChecklists: [] })
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument(),
      )
    })

    it('shows the server’s sentence for a refusal such as "already gone" and keeps the question open', async () => {
      deleteChecklistItemFromSeries.mockRejectedValue(new Error('Checklist item not found'))
      renderPage()
      deleteStep('Second step')
      fireEvent.click(within(stepItem('Second step')).getByRole('button', { name: 'This + all future' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Checklist item not found')
      expect(screen.getByRole('group', { name: 'Where to delete this step' })).toBeInTheDocument()
      // The choices are live again, so the person can cancel or try something else.
      await waitFor(() =>
        expect(within(stepItem('Second step')).getByRole('button', { name: 'Cancel' })).not.toBeDisabled(),
      )
    })

    it('opening the delete question closes the add question, and the other way round', () => {
      renderPage()
      const card = () => cardFor('Two step close')
      const addBox = () => within(card()).getByPlaceholderText('Add an item...')
      fireEvent.change(addBox(), { target: { value: 'Extra step' } })
      fireEvent.keyDown(addBox(), { key: 'Enter' })
      expect(within(card()).getByRole('group', { name: 'Where to add this task' })).toBeInTheDocument()

      deleteStep('Second step')
      expect(within(card()).queryByRole('group', { name: 'Where to add this task' })).not.toBeInTheDocument()
      expect(within(card()).getByRole('group', { name: 'Where to delete this step' })).toBeInTheDocument()

      fireEvent.change(addBox(), { target: { value: 'Another step' } })
      fireEvent.keyDown(addBox(), { key: 'Enter' })
      expect(within(card()).getByRole('group', { name: 'Where to add this task' })).toBeInTheDocument()
      expect(within(card()).queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
    })

    it('closes the question when its step is no longer on the checklist (a refetch removed it)', () => {
      const view = renderPage()
      deleteStep('Second step')
      expect(screen.getByRole('group', { name: 'Where to delete this step' })).toBeInTheDocument()

      const showChecklist = (card: Checklist) => {
        contextValue = {
          ...contextValue,
          data: { ...data, checklists: [RECURRING, ONE_OFF, card] },
          visibleChecklists: [RECURRING, ONE_OFF, card],
        } as unknown as AppContextValue
        view.rerender(
          <MemoryRouter initialEntries={['/checklists']}>
            <ChecklistsPage />
          </MemoryRouter>,
        )
      }
      showChecklist({
        ...TWO_STEPS,
        items: TWO_STEPS.items.filter((item) => item.id !== 'cl-two-second'),
      } as Checklist)
      expect(screen.queryByText('Second step')).not.toBeInTheDocument()
      // The step comes back (a later refetch): an old question must not come back with it.
      showChecklist(TWO_STEPS)
      expect(screen.getByText('Second step')).toBeInTheDocument()
      expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
    })

    it('Cancel hands focus back to the x that opened the question', () => {
      renderPage()
      deleteStep('Second step')
      fireEvent.click(within(stepItem('Second step')).getByRole('button', { name: 'Cancel' }))
      expect(within(stepItem('Second step')).getByRole('button', { name: 'Delete item' })).toHaveFocus()
    })

    it('is disabled with "Disabled in preview mode" while previewing as someone', () => {
      contextValue = { ...contextValue, previewMode: true } as unknown as AppContextValue
      renderPage()
      deleteStep('Second step')
      const group = within(stepItem('Second step'))
      for (const name of ['This checklist only', 'This + all future']) {
        const button = group.getByRole('button', { name })
        expect(button).toBeDisabled()
        expect(button).toHaveAttribute('title', 'Disabled in preview mode')
      }
    })
  })

  describe('the result notice is a passing one', () => {
    const seriesResult = { removedFromTemplate: true, removedFromChecklists: ['a'], keptOnChecklists: [] }
    const removeFromSeries = async () => {
      deleteChecklistItemFromSeries.mockResolvedValue(seriesResult)
      renderPage()
      clickDelete('Recurring close')
      fireEvent.click(within(prompt('Recurring close')).getByRole('button', { name: 'This + all future' }))
      return screen.findByRole('status')
    }

    it('clears after 8 seconds', async () => {
      const timers = vi.spyOn(window, 'setTimeout')
      try {
        const notice = await removeFromSeries()
        expect(notice).toHaveTextContent('Removed from the recurring checklist')
        // The notice armed exactly one 8-second timer; fire it as the clock would.
        // The timer is armed in an effect, which runs AFTER the notice is on the
        // page - under a loaded run the sentence can be found before the effect
        // has fired, so wait for the timer rather than assuming it is there.
        const armed = () => timers.mock.calls.filter(([, delay]) => delay === 8000)
        await waitFor(() => expect(armed()).toHaveLength(1))
        const eightSeconds = armed()
        act(() => {
          ;(eightSeconds[0][0] as () => void)()
        })
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
      } finally {
        timers.mockRestore()
      }
    })

    it('clears on the next click on that card', async () => {
      await removeFromSeries()
      fireEvent.click(within(cardFor('Recurring close')).getByText('Recurring close'))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
