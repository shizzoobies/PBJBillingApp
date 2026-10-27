import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { defaultReportPeriod } from '../lib/reportPeriod'
import { addDays, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * featreq-9c818fca (send-back of featreq-ed73d181): "Dashboard - Cases in Flight
 * section - still does nothing when clicking open step."
 *
 * The cause, reproduced here: the stalled row's step is FINISHED and usually
 * due before this month, so under the default "This month" report period it is
 * not in the In-progress list. `?focus=` admitted it - but only while the param
 * was in the URL, and the page deletes the param after ~1.5 s. The card (and the
 * collapsed Completed group the focus had forced open) then vanished again, so
 * the click looked like it did nothing. The page now holds the jumped-to row in
 * view after the param clears, without touching the shared report period.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-patrice'
const TODAY = localDateOnly()
const PERIOD = defaultReportPeriod(TODAY)

const CLIENT: Client = { id: 'client-1', name: 'I-95 Logistics', assignedBookkeeperIds: [] } as unknown as Client

/** Finished step 1 of 3, due ten days before this month began, step 2 never opened. */
const STALLED: Checklist = {
  id: 'cl-stalled',
  title: 'Quarterly close',
  clientId: CLIENT.id,
  assigneeId: OWNER,
  templateId: 'tmpl-q',
  caseId: 'case-stalled',
  stageIndex: 0,
  stageCount: 3,
  dueDate: addDays(PERIOD.from, -10),
  viewerIds: [],
  editorIds: [],
  items: [{ id: 'st-1', label: 'Gather statements', done: true }],
} as unknown as Checklist

/** An ordinary open task this month, so the list is not empty. */
const OPEN: Checklist = {
  id: 'cl-open',
  title: 'Monthly bookkeeping',
  clientId: CLIENT.id,
  assigneeId: OWNER,
  dueDate: PERIOD.to,
  viewerIds: [],
  editorIds: [],
  items: [{ id: 'op-1', label: 'Reconcile', done: false }],
} as unknown as Checklist

let contextValue: AppContextValue

function signIn() {
  const data = {
    clients: [CLIENT],
    employees: [{ id: OWNER, name: 'Brittany Ferguson', role: 'Owner' }],
    checklists: [STALLED, OPEN],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  } as unknown as AppData
  contextValue = {
    data,
    ownerMode: true,
    role: 'owner',
    previewMode: false,
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner' },
    sessionUser: { id: OWNER, role: 'owner' },
    visibleChecklists: checklistsVisibleTo(data.checklists, { viewerId: OWNER, isOwner: true }),
    visibleClients: [CLIENT],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    pushChecklistOccurrence: vi.fn(),
    openNextStageEarly: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    // The default every user starts with: this month.
    reportPeriod: PERIOD,
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

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="url">{`${location.pathname}${location.search}`}</output>
}

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ChecklistsPage />
      <LocationProbe />
    </MemoryRouter>,
  )

const CARD_TITLE = '.checklist-card-title-sub, .checklist-card-title'
const cardFor = (title: string) =>
  [...document.querySelectorAll('article.checklist-block')].find(
    (node) => node.querySelector(CARD_TITLE)?.textContent === title,
  )

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom has no scrollIntoView; the focus handler calls it.
  Element.prototype.scrollIntoView = vi.fn()
  signIn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a jump to a finished step outside the report period (featreq-9c818fca)', () => {
  it('is not in the list without the jump: the default period leaves it out', () => {
    expect(STALLED.dueDate < PERIOD.from).toBe(true)
    renderAt('/checklists')
    expect(cardFor('Quarterly close')).toBeUndefined()
    expect(cardFor('Monthly bookkeeping')).toBeTruthy()
  })

  it('shows the card, and keeps showing it after the focus param clears itself', () => {
    renderAt('/checklists?focus=cl-stalled')
    expect(cardFor('Quarterly close')).toBeTruthy()

    // The page deletes ?focus= after ~1.5 s so the scroll does not re-fire.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByTestId('url').textContent).not.toContain('focus=')

    // Before the fix the row dropped out here: the click "did nothing".
    expect(cardFor('Quarterly close')).toBeTruthy()
    expect(contextValue.setReportPeriod).not.toHaveBeenCalled()
  })

  it('opens the collapsed Completed group to show it, and the group can still be folded away', () => {
    renderAt('/checklists?focus=cl-stalled')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    const header = [...document.querySelectorAll<HTMLButtonElement>('.checklist-group-header')].find((button) =>
      button.textContent?.startsWith('Completed'),
    ) as HTMLButtonElement
    expect(header.getAttribute('aria-expanded')).toBe('true')
    act(() => {
      header.click()
    })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(cardFor('Quarterly close')).toBeUndefined()
  })
})
