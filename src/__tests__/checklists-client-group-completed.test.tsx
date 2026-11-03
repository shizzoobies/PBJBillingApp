import { fireEvent, render, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { addDays, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { ReportPeriod } from '../lib/reportPeriod'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * featreq-5a44c051: "When you group by client it should somehow show open and
 * completed at the bottom ... grouping by client and then seeing completed
 * checklist is not helpful". On the In progress tab grouped by client, each
 * client lists its OPEN checklists, and the completed ones (the same rule the
 * Due-date grouping's Completed bucket uses) move into a nested, collapsed
 * "Completed" sub-group at the bottom. The client's count is its open count; a
 * client with only completed work in the period stays listed but collapsed.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: async () => [],
}))

const OWNER = 'emp-patrice'
const TODAY = localDateOnly()

const SHARED = { id: 'client-shared', name: 'Shared Books LLC', assignedBookkeeperIds: [] } as unknown as Client
const OTHER = { id: 'client-other', name: 'Other Co', assignedBookkeeperIds: [] } as unknown as Client

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: SHARED.id,
    assigneeId: OWNER,
    viewerIds: [],
    editorIds: [],
    items: [{ id: `${over.id}-step`, label: 'Reconcile', done: false }],
    ...over,
  }) as Checklist

const OPEN = checklist({ id: 'cl-open', title: 'Bank reconciliation', dueDate: addDays(TODAY, 3) })
// Due EARLIER than the open one, so a plain due-date sort would put it first.
const DONE = checklist({
  id: 'cl-done',
  title: 'Payroll filing',
  dueDate: addDays(TODAY, 2),
  items: [{ id: 'cl-done-step', label: 'File', done: true }],
})
const DONE_ONLY = checklist({
  id: 'cl-done-only',
  title: 'Sales tax return',
  clientId: OTHER.id,
  dueDate: addDays(TODAY, 1),
  items: [{ id: 'cl-done-only-step', label: 'File', done: true }],
})

let contextValue: AppContextValue

function signIn(
  checklists: Checklist[] = [OPEN, DONE, DONE_ONLY],
  reportPeriod: ReportPeriod = { preset: 'custom', from: '2020-01-01', to: '2099-12-31' },
) {
  const data = {
    clients: [SHARED, OTHER],
    employees: [{ id: OWNER, name: 'Patrice Owner', role: 'Owner' }],
    checklists,
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  } as unknown as AppData
  contextValue = {
    data,
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner' },
    sessionUser: { id: OWNER, role: 'owner' },
    visibleChecklists: checklistsVisibleTo(checklists, { viewerId: OWNER, isOwner: true }),
    visibleClients: [SHARED, OTHER],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod,
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

const pageTree = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <ChecklistsPage />
  </MemoryRouter>
)

const renderPage = (entry = '/checklists?group=client') => render(pageTree(entry))

const CARD_TITLE = '.checklist-card-title-sub, .checklist-card-title'

/** The TOP-LEVEL group (a client) whose header label is `label`. */
const clientGroup = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.checklist-stack > .checklist-group')].find(
    (node) => node.querySelector(':scope > .checklist-group-header strong')?.textContent === label,
  ) as HTMLElement

const headerOf = (group: HTMLElement) =>
  group.querySelector(':scope > .checklist-group-header') as HTMLElement

const countOf = (group: HTMLElement) =>
  headerOf(group).querySelector(':scope > span')?.textContent

/** The nested "Completed" group inside a client group, if any. */
const completedIn = (group: HTMLElement) =>
  [...group.querySelectorAll<HTMLElement>('.checklist-group-body .checklist-group')].find(
    (node) => node.querySelector(':scope > .checklist-group-header strong')?.textContent === 'Completed',
  )

/** Card titles rendered directly in a client group (NOT inside its nested Completed group). */
const openTitlesIn = (group: HTMLElement) =>
  [...group.querySelectorAll(CARD_TITLE)]
    .filter((node) => !completedIn(group)?.contains(node))
    .map((node) => node.textContent)

const titlesIn = (group: HTMLElement) =>
  [...group.querySelectorAll(CARD_TITLE)].map((node) => node.textContent)

describe('In progress grouped by client: completed checklists in a nested Completed group', () => {
  it('lists the open card in the client group and tucks the completed one into a collapsed Completed (1)', () => {
    signIn()
    renderPage()

    const shared = clientGroup('Shared Books LLC')
    expect(shared).toBeTruthy()
    expect(headerOf(shared)).toHaveAttribute('aria-expanded', 'true')
    // The header counts OPEN work only.
    expect(countOf(shared)).toBe('1')
    expect(openTitlesIn(shared)).toEqual(['Bank reconciliation'])

    const completed = completedIn(shared) as HTMLElement
    expect(completed).toBeTruthy()
    expect(countOf(completed)).toBe('1')
    expect(headerOf(completed)).toHaveAttribute('aria-expanded', 'false')
    // Collapsed: the completed card is not on the page at all yet.
    expect(titlesIn(shared)).not.toContain('Payroll filing')

    fireEvent.click(headerOf(completed))
    expect(headerOf(completed)).toHaveAttribute('aria-expanded', 'true')
    expect(titlesIn(completed)).toEqual(['Payroll filing'])
    // Still not among the open cards once expanded.
    expect(openTitlesIn(shared)).toEqual(['Bank reconciliation'])
  })

  it('puts the Completed sub-group AFTER the open cards', () => {
    signIn()
    renderPage()
    const shared = clientGroup('Shared Books LLC')
    const body = shared.querySelector(':scope > .checklist-group-body') as HTMLElement
    const last = body.lastElementChild as HTMLElement
    expect(last).toBe(completedIn(shared))
  })

  it('has no Completed sub-group when a client has nothing completed', () => {
    signIn([OPEN])
    renderPage()
    const shared = clientGroup('Shared Books LLC')
    expect(completedIn(shared)).toBeUndefined()
    expect(countOf(shared)).toBe('1')
  })

  it('keeps a client with ONLY completed checklists listed, but collapsed, its pill reading "N done"', () => {
    signIn()
    renderPage()
    const other = clientGroup('Other Co')
    expect(other).toBeTruthy()
    expect(headerOf(other)).toHaveAttribute('aria-expanded', 'false')
    // No open work: the pill says how many are done instead of a bare "0".
    expect(countOf(other)).toBe('1 done')
    expect(titlesIn(other)).toEqual([])

    fireEvent.click(headerOf(other))
    const completed = completedIn(other) as HTMLElement
    expect(completed).toBeTruthy()
    expect(headerOf(completed)).toHaveAttribute('aria-expanded', 'false')
    expect(countOf(completed)).toBe('1')
  })

  it('a client that mounts all-completed OPENS when a period change gives it open work', () => {
    // Only DONE (due today+2) is in this window, so Shared Books is all-completed.
    const narrow: ReportPeriod = { preset: 'custom', from: addDays(TODAY, 2), to: addDays(TODAY, 2) }
    signIn([OPEN, DONE], narrow)
    const { rerender } = renderPage()
    expect(headerOf(clientGroup('Shared Books LLC'))).toHaveAttribute('aria-expanded', 'false')
    expect(countOf(clientGroup('Shared Books LLC'))).toBe('1 done')

    // Widen the period so OPEN (due today+3) is in it too.
    signIn([OPEN, DONE], { preset: 'custom', from: TODAY, to: addDays(TODAY, 7) })
    rerender(pageTree('/checklists?group=client'))
    const shared = clientGroup('Shared Books LLC')
    expect(headerOf(shared)).toHaveAttribute('aria-expanded', 'true')
    expect(countOf(shared)).toBe('1')
    expect(openTitlesIn(shared)).toEqual(['Bank reconciliation'])
  })

  it('a ?focus= on a completed card opens both its client group and the nested Completed group', () => {
    signIn()
    renderPage('/checklists?group=client&focus=cl-done-only')
    const other = clientGroup('Other Co')
    expect(headerOf(other)).toHaveAttribute('aria-expanded', 'true')
    const completed = completedIn(other) as HTMLElement
    expect(headerOf(completed)).toHaveAttribute('aria-expanded', 'true')
    expect(titlesIn(completed)).toEqual(['Sales tax return'])
  })

  it('leaves the Due-date grouping alone: completed work is still in its own top-level Completed bucket', () => {
    signIn()
    renderPage('/checklists')
    const stackGroups = [
      ...document.querySelectorAll<HTMLElement>('.checklist-stack > .checklist-group'),
    ].map((node) => node.querySelector(':scope > .checklist-group-header strong')?.textContent)
    expect(stackGroups).toEqual(['Due this week', 'Completed'])
    const completed = clientGroup('Completed')
    expect(countOf(completed)).toBe('2')
    expect(within(completed).queryByText('Payroll filing')).toBeNull()
  })
})

/**
 * featreq-6c7ff53b: both Completed groups on the In progress tab list the most
 * recently completed checklist first (the latest step stamp), not by due date.
 * The due dates here run the OPPOSITE way, so a due-date sort would fail.
 */
describe('Completed groups list the most recently completed first', () => {
  const finished = (id: string, title: string, dueIn: number, completedAt?: string) =>
    checklist({
      id,
      title,
      dueDate: addDays(TODAY, dueIn),
      items: [{ id: `${id}-step`, label: 'File', done: true, ...(completedAt ? { completedAt } : {}) }],
    })
  // Due order: Undated, Oldest, Middle, Newest. Completion order is the reverse
  // (with the undated one last).
  const UNDATED = finished('cl-undated', 'Undated filing', 0)
  const OLDEST = finished('cl-oldest', 'Oldest filing', 1, '2026-10-01T10:00:00.000Z')
  const MIDDLE = finished('cl-middle', 'Middle filing', 2, '2026-10-10T10:00:00.000Z')
  const NEWEST = finished('cl-newest', 'Newest filing', 4, '2026-11-03T15:00:00.000Z')
  const EXPECTED = ['Newest filing', 'Middle filing', 'Oldest filing', 'Undated filing']

  it('grouped by client: the nested Completed sub-group', () => {
    signIn([OPEN, UNDATED, OLDEST, MIDDLE, NEWEST])
    renderPage()
    const completed = completedIn(clientGroup('Shared Books LLC')) as HTMLElement
    fireEvent.click(headerOf(completed))
    expect(titlesIn(completed)).toEqual(EXPECTED)
  })

  it('grouped by due date: the Completed bucket (other buckets stay soonest-due first)', () => {
    const SOON = checklist({ id: 'cl-soon', title: 'Soon open', dueDate: addDays(TODAY, 1) })
    signIn([OPEN, SOON, UNDATED, OLDEST, MIDDLE, NEWEST])
    renderPage('/checklists')
    const completed = clientGroup('Completed')
    fireEvent.click(headerOf(completed))
    expect(titlesIn(completed)).toEqual(EXPECTED)
    expect(titlesIn(clientGroup('Due this week'))).toEqual(['Soon open', 'Bank reconciliation'])
  })
})
