import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { FilterBar } from '../components/FilterBar'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * The "Waiting" status on the In progress tab: a filter option, a valid
 * `?status=waiting` URL value, and a row badge with a "N step(s) waiting"
 * tooltip. Nothing is stored; the badge reads the step waits on every render.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'

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

const ONE_WAIT = checklist({
  id: 'cl-one',
  title: 'One wait close',
  items: [
    { id: 'a', label: 'Reconcile', done: false, waiting: true },
    { id: 'b', label: 'Review', done: false },
  ],
} as Partial<Checklist>)
const TWO_WAITS = checklist({
  id: 'cl-two',
  title: 'Two waits close',
  items: [
    {
      id: 'a',
      label: 'Reconcile',
      done: false,
      subItems: [{ id: 's', label: 'Statement', done: false, waiting: true }],
    },
    { id: 'b', label: 'Review', done: false, waiting: true },
  ],
} as Partial<Checklist>)
const QUIET = checklist({ id: 'cl-quiet', title: 'Quiet close' })
const VERIFIED = checklist({
  id: 'cl-verified',
  title: 'Verified wait close',
  items: [
    {
      id: 'a',
      label: 'Reconcile',
      done: false,
      waitingOns: [
        {
          id: 'w',
          blockerId: 'emp-pat',
          requestedBy: LISA,
          createdAt: '2026-08-01T00:00:00Z',
          resolvedAt: '2026-08-02T00:00:00Z',
          verifiedAt: '2026-08-03T00:00:00Z',
        },
      ],
    },
  ],
} as Partial<Checklist>)
const COMPLETE = checklist({
  id: 'cl-complete',
  title: 'Complete close',
  items: [{ id: 'a', label: 'Reconcile', done: true, waiting: true }],
} as Partial<Checklist>)

const data = {
  clients: [CLIENT],
  employees: [{ id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' }],
  checklists: [ONE_WAIT, TWO_WAITS, QUIET, VERIFIED, COMPLETE],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

const contextValue = {
  data,
  ownerMode: false,
  role: 'employee',
  activeEmployeeId: LISA,
  effectiveUser: { id: LISA, role: 'employee' },
  sessionUser: { id: LISA, role: 'employee' },
  visibleChecklists: checklistsVisibleTo(data.checklists, { viewerId: LISA, isOwner: false }),
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
  deleteChecklistItem: vi.fn(),
  reorderChecklistSubItems: vi.fn(),
  deleteChecklistItemFromSeries: vi.fn(),
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

afterEach(cleanup)

const renderPage = (url = '/checklists') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

/** The card for a task title (the title also appears in other checklists' pickers). */
const cardFor = (title: string) =>
  screen.getByText(title, { selector: '.checklist-card-title-sub' }).closest('article') as HTMLElement
const badge = (card: HTMLElement) => card.querySelector('.checklist-waiting-badge')

describe('FilterBar status options', () => {
  const options = (showWaiting?: boolean) => {
    const { container } = render(
      <MemoryRouter>
        <FilterBar employees={[]} clients={[]} showWaiting={showWaiting} />
      </MemoryRouter>,
    )
    return Array.from(container.querySelectorAll('select')[2].querySelectorAll('option')).map(
      (option) => option.value,
    )
  }

  it('offers Waiting between Overdue and Completed', () => {
    expect(options()).toEqual(['all', 'active', 'overdue', 'waiting', 'completed'])
  })

  it('can leave Waiting out for a page whose statuses have no such bucket', () => {
    expect(options(false)).toEqual(['all', 'active', 'overdue', 'completed'])
  })
})

describe('the Waiting badge on an In progress row', () => {
  it('shows on a checklist with a waiting step, with the count in its tooltip', () => {
    renderPage()
    expect(badge(cardFor('One wait close'))).toHaveAttribute(
      'title',
      '1 step waiting',
    )
    expect(badge(cardFor('Two waits close'))).toHaveAttribute(
      'title',
      '2 steps waiting',
    )
  })

  it('is absent on a checklist with nothing waiting', () => {
    renderPage()
    expect(badge(cardFor('Quiet close'))).toBeNull()
  })

  it('is absent on a verified wait and on a complete checklist', () => {
    renderPage()
    expect(badge(cardFor('Verified wait close'))).toBeNull()
    cleanup()
    renderPage('/checklists?status=completed&focus=cl-complete')
    expect(badge(cardFor('Complete close'))).toBeNull()
  })

  it('?status=waiting lists only the waiting checklists', () => {
    renderPage('/checklists?status=waiting')
    expect(screen.getByText('One wait close', { selector: '.checklist-card-title-sub' })).toBeInTheDocument()
    expect(screen.getByText('Two waits close', { selector: '.checklist-card-title-sub' })).toBeInTheDocument()
    expect(screen.queryByText('Quiet close', { selector: '.checklist-card-title-sub' })).not.toBeInTheDocument()
  })
})
