import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { isChecklistSkipped } from '../../lib/checklist-skip.js'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * The skip affordance on a task card.
 *
 * The load-bearing rule is the ABSENCE of a control: "they don't necessarily
 * know skipping is an option unless enabled". So a task whose template has
 * skipping off must render nothing at all — not a disabled button, not a
 * tooltip. And once a task is skipped it leaves the active list for the cycle,
 * which is the "quiet" half of the feature.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'
const OWNER = 'emp-patrice'

const CLIENT: Client = {
  id: 'client-shared',
  name: 'Shared Books LLC',
  assignedBookkeeperIds: [LISA],
} as unknown as Client

const template = (id: string, skipAllowed: boolean) =>
  ({
    id,
    title: 'Recurring',
    clientId: CLIENT.id,
    assigneeId: LISA,
    frequency: 'monthly',
    nextDueDate: '2026-09-30',
    active: true,
    skipAllowed,
    viewerIds: [],
    editorIds: [],
    stages: [],
  }) as unknown as AppData['checklistTemplates'][number]

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

const SKIPPABLE = checklist({
  id: 'cl-skippable',
  title: 'Skippable close',
  templateId: 'tmpl-on',
})
const NOT_SKIPPABLE = checklist({
  id: 'cl-locked',
  title: 'Locked close',
  templateId: 'tmpl-off',
})
const ONE_OFF = checklist({ id: 'cl-oneoff', title: 'One off cleanup' })
const ALREADY_SKIPPED = checklist({
  id: 'cl-done',
  title: 'Already skipped close',
  templateId: 'tmpl-on',
  skippedAt: '2026-08-13T12:00:00.000Z',
  skippedBy: LISA,
})

const data = {
  clients: [CLIENT],
  employees: [
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
  ],
  checklists: [SKIPPABLE, NOT_SKIPPABLE, ONE_OFF, ALREADY_SKIPPED],
  checklistTemplates: [template('tmpl-on', true), template('tmpl-off', false)],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue
let skipChecklistOccurrence: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean) {
  skipChecklistOccurrence = vi.fn().mockResolvedValue(undefined)
  // Exactly what App.tsx does: skipped occurrences are filtered OUT of the
  // shared "my work" narrowing, and stay in `data.checklists` so the owner's
  // bulk save round-trips them.
  const active = data.checklists.filter((entry) => !isChecklistSkipped(entry))

  contextValue = {
    data,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    visibleChecklists: checklistsVisibleTo(active, { viewerId, isOwner }),
    visibleClients: [CLIENT],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence,
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
    deleteChecklistItem: vi.fn(),
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

/** The card for a given task title. */
const cardFor = (title: string) =>
  screen.getByText(title).closest('article, li, section') as HTMLElement

beforeEach(() => {
  signInAs(LISA, false)
})

describe('when skipping is not enabled', () => {
  it('shows no skip control at all on a task whose template has it off', () => {
    renderPage()
    expect(within(cardFor('Locked close')).queryByText('Skip this cycle')).not.toBeInTheDocument()
  })

  it('shows no skip control on a one-off task — there is no next occurrence', () => {
    renderPage()
    expect(within(cardFor('One off cleanup')).queryByText('Skip this cycle')).not.toBeInTheDocument()
  })
})

describe('when skipping is enabled', () => {
  it('offers it on the task whose template allows it', () => {
    renderPage()
    expect(within(cardFor('Skippable close')).getByText('Skip this cycle')).toBeInTheDocument()
  })

  it('asks for a category and an explanation, and refuses to submit without both', async () => {
    renderPage()

    fireEvent.click(within(cardFor('Skippable close')).getByText('Skip this cycle'))

    const dialog = screen.getByRole('group', { name: /Skip Skippable close this cycle/i })
    const confirm = within(dialog).getByRole('button', { name: 'Skip this cycle' })
    expect(confirm).toBeDisabled()

    // A category alone is not enough — the explanation is required too.
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'client' } })
    expect(confirm).toBeDisabled()

    // …and neither is whitespace.
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '   ' } })
    expect(confirm).toBeDisabled()

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Statements never arrived.' },
    })
    expect(confirm).toBeEnabled()

    fireEvent.click(confirm)
    await waitFor(() =>
      expect(skipChecklistOccurrence).toHaveBeenCalledWith('cl-skippable', {
        category: 'client',
        explanation: 'Statements never arrived.',
      }),
    )
  })

  it('offers all three categories and nothing else', () => {
    renderPage()
    fireEvent.click(within(cardFor('Skippable close')).getByText('Skip this cycle'))

    const options = within(screen.getByRole('group', { name: /Skip Skippable close/i }))
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean)
    expect(options).toEqual(['me', 'colleague', 'client'])
  })
})

describe('after a skip', () => {
  it('the task is gone from the active list for this cycle', () => {
    renderPage()
    expect(screen.queryByText('Already skipped close')).not.toBeInTheDocument()
    // …and is still in the workspace data the owner's save writes back.
    expect(data.checklists.some((entry) => entry.id === 'cl-done')).toBe(true)
  })
})
