import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * A waiting step cannot be checked off (featreq-cdab1605). The server is the
 * source of truth (pinned in `waiting-blocks-checkoff-route.test.ts`) and the
 * predicate itself is pinned in `lib/waiting-on-state.test.mjs`; this is the
 * remaining piece — that the Checklists tab's own checkbox actually reads
 * `waitingBlocksCompletion` and disables itself, so the 409 is never reachable
 * from a control the page still offered.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-brit'
const CLIENT = { id: 'client-acme', name: 'Acme Dental' }

const checklist = (items: Checklist['items']): Checklist =>
  ({
    id: 'cl-1',
    clientId: CLIENT.id,
    title: 'August close',
    assigneeId: OWNER,
    // Far enough out to land in the "Later" due-date bucket, which starts
    // collapsed — the "Overdue" / "This week" buckets start OPEN, and
    // `openDueGroups` below would toggle one of those CLOSED instead.
    dueDate: '2026-12-31',
    items,
  }) as Checklist

const data = (items: Checklist['items']) =>
  ({
    clients: [CLIENT],
    employees: [{ id: OWNER, name: 'Brittany Fox', role: 'owner' }],
    checklists: [checklist(items)],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  }) as unknown as AppData

let contextValue: AppContextValue

function signInWith(items: Checklist['items']) {
  contextValue = {
    data: data(items),
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner', staffRole: 'Owner' },
    sessionUser: { id: OWNER, role: 'owner', staffRole: 'Owner' },
    visibleChecklists: data(items).checklists,
    visibleClients: [CLIENT],
    serviceCategories: [],
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

const renderProgress = () => {
  const result = render(
    <MemoryRouter initialEntries={['/checklists?area=progress']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )
  // The In-progress list buckets by due date and ships those groups collapsed.
  for (const heading of screen.queryAllByRole('button', { name: /^(Later|Overdue|This week)/ })) {
    fireEvent.click(heading)
  }
  return result
}

/** The checkbox on the `.task-item` whose title text contains `label`. */
function itemCheckbox(container: HTMLElement, label: string): HTMLInputElement {
  const rows = Array.from(container.querySelectorAll('.task-item'))
  const row = rows.find((el) => el.textContent?.includes(label))
  if (!row) throw new Error(`no task-item found for "${label}"`)
  const found = row.querySelector('input[type="checkbox"]')
  if (!found) throw new Error(`no checkbox rendered for "${label}"`)
  return found as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a waiting step', () => {
  it('disables the checkbox with "Clear the wait first"', () => {
    signInWith([{ id: 'it-1', label: 'Bank rec', done: false, assigneeId: OWNER, waiting: true }])
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).toBeDisabled()
    expect(box.title).toBe('Clear the wait first')
  })

  it('disables it for a live structured wait too, not just the legacy flag', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: OWNER,
        waitingOns: [{ id: 'wo-1', blockerId: 'emp-lisa', requestedBy: OWNER, createdAt: '2026-08-01T00:00:00.000Z' }],
      },
    ])
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).toBeDisabled()
  })

  // Un-checking a done step is never blocked — only the forward move is. A
  // second, still-open item keeps the whole checklist out of the Completed
  // bucket so the card renders under In progress at all.
  it('leaves a DONE-but-still-waiting step checkable, so it can be un-checked', () => {
    signInWith([
      { id: 'it-1', label: 'Bank rec', done: true, assigneeId: OWNER, waiting: true },
      { id: 'it-2', label: 'Payroll review', done: false, assigneeId: OWNER },
    ])
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).not.toBeDisabled()
  })

  it('leaves an ordinary, non-waiting step alone', () => {
    signInWith([{ id: 'it-1', label: 'Bank rec', done: false, assigneeId: OWNER }])
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).not.toBeDisabled()
    expect(box.title).toBeFalsy()
  })
})

// Ticking a parent cascades `done` onto every sub-step beneath it, so a parent
// whose sub-step (or sub-sub-step) is waiting is blocked too - otherwise the
// waiting child is checked off through the parent while its own box stays
// disabled.
describe('a parent with a waiting sub-step', () => {
  const withSub = (sub: Record<string, unknown>) =>
    [
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: OWNER,
        subItems: [{ id: 'sub-1', title: 'Pull statements', done: false }, sub],
      },
    ] as unknown as Checklist['items']

  it('disables the parent checkbox and says a sub-step is waiting', () => {
    signInWith(withSub({ id: 'sub-2', title: 'Match deposits', done: false, waiting: true }))
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).toBeDisabled()
    expect(box.title).toBe('A sub-step is waiting - clear it first')
  })

  it('disables the parent when only a sub-sub-step is waiting', () => {
    signInWith(
      withSub({
        id: 'sub-2',
        title: 'Match deposits',
        done: false,
        subItems: [{ id: 'ss-1', title: 'Chase client', done: false, waiting: true }],
      }),
    )
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).toBeDisabled()
  })

  it('disables the sub-item whose own sub-sub-step is waiting', () => {
    signInWith(
      withSub({
        id: 'sub-2',
        title: 'Match deposits',
        done: false,
        subItems: [{ id: 'ss-1', title: 'Chase client', done: false, waiting: true }],
      }),
    )
    const { container } = renderProgress()
    const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
      el.textContent?.includes('Match deposits'),
    )
    const box = row?.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box).toBeDisabled()
    expect(box.title).toBe('A sub-step is waiting - clear it first')
  })

  it('leaves the parent checkable once the waiting sub-step is done', () => {
    signInWith(withSub({ id: 'sub-2', title: 'Match deposits', done: true, waiting: true }))
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).not.toBeDisabled()
  })
})
