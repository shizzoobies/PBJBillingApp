import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * Open next step now (featreq-8b54d117): "when a task under a step gets a
 * delayed [waiting] but all other steps checked off, a button to open next step
 * populates to push the next step while waiting." The button is offered only
 * when every open step is waiting and the next step is not open yet, to the
 * owner or the step's assignee; after it works the card says "Step N opened".
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'
const SAM = 'emp-sam'
const OWNER = 'emp-patrice'

const CLIENT: Client = {
  id: 'client-1',
  name: 'Shared Books LLC',
  assignedBookkeeperIds: [LISA, SAM],
} as unknown as Client

const TEMPLATE = {
  id: 'tmpl-stages',
  title: 'Monthly close',
  clientId: CLIENT.id,
  assigneeId: LISA,
  frequency: 'monthly',
  nextDueDate: '2026-10-31',
  active: true,
  viewerIds: [],
  editorIds: [],
  stages: [
    { id: 'st-0', name: 'Prep', assigneeId: LISA, offsetDays: 0, items: [] },
    { id: 'st-1', name: 'Review', assigneeId: SAM, offsetDays: 0, items: [] },
    { id: 'st-2', name: 'Deliver', assigneeId: LISA, offsetDays: 0, items: [] },
  ],
} as unknown as AppData['checklistTemplates'][number]

const stage = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: CLIENT.id,
    assigneeId: LISA,
    templateId: TEMPLATE.id,
    dueDate: '2026-10-31',
    stageIndex: 0,
    stageCount: 3,
    viewerIds: [],
    editorIds: [],
    items: [
      { id: `${over.id}-done`, label: 'Gather', done: true },
      { id: `${over.id}-wait`, label: 'Statements', done: false, waiting: true },
    ],
    ...over,
  }) as Checklist

const READY = stage({ id: 'cl-ready', title: 'Ready close', caseId: 'case-ready' })
const NOT_READY = stage({
  id: 'cl-notready',
  title: 'Not ready close',
  caseId: 'case-notready',
  items: [
    { id: 'nr-open', label: 'Gather', done: false },
    { id: 'nr-wait', label: 'Statements', done: false, waiting: true },
  ],
})
const ALREADY_OPEN = stage({ id: 'cl-already', title: 'Already open close', caseId: 'case-already' })
const ALREADY_OPEN_NEXT = stage({
  id: 'cl-already-next',
  title: 'Already open review',
  caseId: 'case-already',
  stageIndex: 1,
  items: [{ id: 'aon-1', label: 'Review', done: false }],
})
const ONBOARDING = stage({
  id: 'cl-onboarding',
  title: 'Onboarding close',
  caseId: 'case-onb',
  onboardingForClientId: CLIENT.id,
})
const LAST = stage({ id: 'cl-last', title: 'Last close', caseId: 'case-last', stageIndex: 2 })
/** Sam's step, which Lisa can see as a viewer but is not hers to move on. */
const SAMS = stage({ id: 'cl-sams', title: 'Sams close', caseId: 'case-sams', assigneeId: SAM, viewerIds: [LISA] })
const finishedItems = (id: string) => [
  { id: `${id}-1`, label: 'Gather', done: true },
  { id: `${id}-2`, label: 'Statements', done: true },
]
/** featreq-ed73d181: step 1 finished, step 2 never opened (I-95). */
const STALLED = stage({ id: 'cl-stalled', title: 'Stalled close', caseId: 'case-stalled', items: finishedItems('st') })
/** Finished, and its next step is open: an ordinary hand-off. */
const HANDED = stage({ id: 'cl-handed', title: 'Handed close', caseId: 'case-handed', items: finishedItems('hd') })
const HANDED_NEXT = stage({
  id: 'cl-handed-next',
  title: 'Handed review',
  caseId: 'case-handed',
  stageIndex: 1,
  items: [{ id: 'hn-1', label: 'Review', done: false }],
})
/** The last step of its case, finished: nothing comes after it. */
const FINISHED_LAST = stage({
  id: 'cl-finished-last',
  title: 'Finished last close',
  caseId: 'case-finished-last',
  stageIndex: 2,
  items: finishedItems('fl'),
})

const data = {
  clients: [CLIENT],
  employees: [
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
    { id: SAM, name: 'Sam Lee', role: 'Bookkeeper' },
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
  ],
  checklists: [
    READY,
    NOT_READY,
    ALREADY_OPEN,
    ALREADY_OPEN_NEXT,
    ONBOARDING,
    LAST,
    SAMS,
    STALLED,
    HANDED,
    HANDED_NEXT,
    FINISHED_LAST,
  ],
  checklistTemplates: [TEMPLATE],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue
let openNextStageEarly: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean, { previewMode = false } = {}) {
  openNextStageEarly = vi.fn().mockResolvedValue({ ...READY, id: 'cl-next', stageIndex: 1 })
  contextValue = {
    data,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    previewMode,
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    visibleChecklists: checklistsVisibleTo(data.checklists, { viewerId, isOwner }),
    visibleClients: [CLIENT],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    pushChecklistOccurrence: vi.fn(),
    openNextStageEarly,
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
    dataRefreshCount: 0,
    deleteChecklistItemFromSeries: vi.fn(),
    emptyChecklistRecycleBin: vi.fn(),
    rejectChecklistDeletion: vi.fn(),
    removeSubItem: vi.fn(),
    removeSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    reorderChecklistSubItems: vi.fn(),
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

/** The task card, found by its own title line (titles also appear in other cards' pickers). */
const cardFor = (title: string) =>
  screen
    .getAllByText(title)
    .filter((element) => element.matches('.checklist-card-title, .checklist-card-title-sub'))
    .map((element) => element.closest('article'))
    .find((card) => card !== null) as HTMLElement
const buttonOn = (title: string) => within(cardFor(title)).queryByRole('button', { name: 'Open next step now' })

beforeEach(() => {
  signInAs(LISA, false)
})

describe('Open next step now', () => {
  it('is offered to the assignee when every open step is waiting, with the tooltip naming the next step', () => {
    renderPage()
    const button = buttonOn('Ready close')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('title')).toBe(
      'Steps here are waiting. Start Step 2 (Review) now; this step stays open until its waits clear.',
    )
  })

  it('is not offered when an open step is not waiting, the next step is open, onboarding, or the last step', () => {
    renderPage()
    expect(buttonOn('Not ready close')).toBeNull()
    expect(buttonOn('Already open close')).toBeNull()
    expect(buttonOn('Onboarding close')).toBeNull()
    expect(buttonOn('Last close')).toBeNull()
  })

  it('is not offered to someone who is neither the owner nor the assignee', () => {
    renderPage()
    expect(buttonOn('Sams close')).toBeNull()
  })

  it('is offered to the owner, and never in preview', () => {
    signInAs(OWNER, true)
    const first = renderPage()
    expect(buttonOn('Sams close')).not.toBeNull()
    first.unmount()
    signInAs(OWNER, true, { previewMode: true })
    renderPage()
    expect(buttonOn('Ready close')).toBeNull()
  })

  it('opens the next step and says "Step 2 opened", linking to it', async () => {
    renderPage()
    fireEvent.click(buttonOn('Ready close') as HTMLElement)
    expect(openNextStageEarly).toHaveBeenCalledWith('cl-ready')
    const pill = await within(cardFor('Ready close')).findByRole('link', { name: 'Step 2 opened' })
    expect(pill.getAttribute('href')).toBe('/checklists?focus=cl-next')
  })

  /** Finished steps sit in the collapsed "Completed" group. */
  const openCompleted = () => {
    const header = screen
      .getAllByRole('button')
      .find((button) => button.matches('.checklist-group-header') && button.textContent?.startsWith('Completed'))
    fireEvent.click(header as HTMLElement)
  }

  it('is offered on a finished step whose next step never opened, saying so', () => {
    renderPage()
    openCompleted()
    expect(buttonOn('Stalled close')).not.toBeNull()
    expect(buttonOn('Stalled close')?.getAttribute('title')).toBe('Every step here is done. Open Step 2 (Review) now.')
    const card = cardFor('Stalled close')
    expect(within(card).getByText('This step is done but the next one never opened.')).not.toBeNull()
    // Not a hand-off: nothing was handed to anyone.
    expect(within(card).queryByText('Handed off')).toBeNull()
  })

  it('a revive calls the same action', async () => {
    renderPage()
    openCompleted()
    fireEvent.click(buttonOn('Stalled close') as HTMLElement)
    expect(openNextStageEarly).toHaveBeenCalledWith('cl-stalled')
  })

  it('is absent on a finished step whose next step is open, and on a finished last step', () => {
    renderPage()
    openCompleted()
    expect(buttonOn('Handed close')).toBeNull()
    expect(within(cardFor('Handed close')).queryByText('This step is done but the next one never opened.')).toBeNull()
    expect(within(cardFor('Handed close')).queryByText('Handed off')).not.toBeNull()
    expect(buttonOn('Finished last close')).toBeNull()
    expect(
      within(cardFor('Finished last close')).queryByText('This step is done but the next one never opened.'),
    ).toBeNull()
  })

  it("shows the server's sentence when it refuses", async () => {
    openNextStageEarly.mockRejectedValueOnce(new Error('Step 2 is already open.'))
    renderPage()
    fireEvent.click(buttonOn('Ready close') as HTMLElement)
    await waitFor(() =>
      expect(within(cardFor('Ready close')).getByRole('alert').textContent).toBe('Step 2 is already open.'),
    )
  })
})
