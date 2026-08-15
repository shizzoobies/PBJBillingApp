import { render, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * The Completed tasks tab.
 *
 * Brittany asked for "a history of all tasks completed by client, able to find
 * record of completion and audit trail," with two boundaries: employees see
 * their OWN completed tasks and make no changes, and an accountant additionally
 * sees the completed work of the people staffed on their clients.
 *
 * Completed work never moved anywhere — a finished checklist stays in the same
 * table, just filtered out of the active views — so this tab is a VIEW, and
 * these tests are about which rows each role gets and about the total ABSENCE of
 * anything that could change one.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const BRITTANY = 'emp-brit'
const LISA = 'emp-lisa'
const NOAH = 'emp-noah'
const OWNER = 'emp-patrice'

/** Brittany + Lisa share this client; Noah is on the other one. */
const SHARED: Client = {
  id: 'client-shared',
  name: 'Shared Books LLC',
  assignedBookkeeperIds: [BRITTANY, LISA],
} as unknown as Client
const OTHER: Client = {
  id: 'client-other',
  name: 'Elsewhere Inc',
  assignedBookkeeperIds: [NOAH],
} as unknown as Client

const done = (id: string, completedAt?: string): Checklist['items'][number] => ({
  id,
  label: 'Step',
  done: true,
  ...(completedAt ? { completedAt } : {}),
})

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: SHARED.id,
    dueDate: '2026-07-31',
    items: [done('it-1', '2026-07-15T12:00:00.000Z')],
    ...over,
  }) as Checklist

const data = {
  clients: [SHARED, OTHER],
  employees: [
    { id: BRITTANY, name: 'Brittany Bookkeepington', role: 'Bookkeeper' },
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
    { id: NOAH, name: 'Noah Reed', role: 'Bookkeeper' },
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
  ],
  checklists: [
    checklist({
      id: 'cl-brit',
      title: 'Brittany payroll',
      assigneeId: BRITTANY,
      items: [done('it-b', '2026-07-15T12:00:00.000Z')],
    }),
    checklist({
      id: 'cl-lisa',
      title: 'Lisa monthly close',
      assigneeId: LISA,
      items: [done('it-l', '2026-07-20T12:00:00.000Z')],
    }),
    checklist({
      id: 'cl-noah',
      title: 'Noah sales tax',
      assigneeId: NOAH,
      clientId: OTHER.id,
      items: [done('it-n', '2026-07-22T12:00:00.000Z')],
    }),
    // Still open — must never appear here.
    checklist({
      id: 'cl-open',
      title: 'Brittany open work',
      assigneeId: BRITTANY,
      items: [{ id: 'it-open', label: 'Step', done: false }],
    }),
    // Completed before `completed_at` existed: no stamp, and none invented.
    checklist({
      id: 'cl-legacy',
      title: 'Brittany ancient history',
      assigneeId: BRITTANY,
      items: [done('it-legacy')],
    }),
  ],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue

function signInAs(viewerId: string, isOwner: boolean, staffRole = 'Bookkeeper') {
  // The server sends a non-owner every checklist for a client they're assigned
  // to, so mirror that: Brittany and Lisa get the shared client's tasks.
  const visibleClients = isOwner
    ? data.clients
    : data.clients.filter((client) =>
        ((client as Client).assignedBookkeeperIds ?? []).includes(viewerId),
      )
  const visibleClientIds = new Set(visibleClients.map((client) => client.id))
  const feed = isOwner
    ? data.checklists
    : data.checklists.filter((entry) => visibleClientIds.has(entry.clientId))

  contextValue = {
    data: { ...data, checklists: feed },
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee', staffRole },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee', staffRole },
    visibleChecklists: checklistsVisibleTo(feed, { viewerId, isOwner }),
    visibleClients,
    serviceCategories: [],
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { from: '2026-01-01', to: '2026-12-31' },
    setReportPeriod: vi.fn(),
    addChecklist: vi.fn(),
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

const renderCompleted = () =>
  render(
    <MemoryRouter initialEntries={['/checklists?area=completed']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

/** The Completed tasks panel only — the page header has its own buttons. */
const panel = () => document.querySelector('#completed-tasks') as HTMLElement

beforeEach(() => {
  signInAs(BRITTANY, false)
})

describe('who sees what', () => {
  it('shows an employee only their own completed tasks', () => {
    renderCompleted()
    const rows = within(panel()).getAllByRole('row')
    const text = rows.map((row) => row.textContent ?? '').join('\n')

    expect(text).toContain('Brittany payroll')
    expect(text).not.toContain('Lisa monthly close')
    expect(text).not.toContain('Noah sales tax')
  })

  it('adds the tasks of people staffed on the same clients for an accountant', () => {
    signInAs(BRITTANY, false, 'Accountant')
    renderCompleted()
    const text = within(panel())
      .getAllByRole('row')
      .map((row) => row.textContent ?? '')
      .join('\n')

    expect(text).toContain('Brittany payroll')
    // Lisa is on the same client — her completed work is in scope.
    expect(text).toContain('Lisa monthly close')
    // Noah is not: a different client, which the accountant is not assigned to.
    expect(text).not.toContain('Noah sales tax')
  })

  it('leaves the owner everyone’s', () => {
    signInAs(OWNER, true, 'Owner')
    renderCompleted()
    const text = within(panel())
      .getAllByRole('row')
      .map((row) => row.textContent ?? '')
      .join('\n')

    expect(text).toContain('Brittany payroll')
    expect(text).toContain('Lisa monthly close')
    expect(text).toContain('Noah sales tax')
  })

  it('never lists unfinished work', () => {
    signInAs(OWNER, true, 'Owner')
    renderCompleted()
    expect(within(panel()).queryByText('Brittany open work')).not.toBeInTheDocument()
  })

  it('names the client and the person for each row', () => {
    renderCompleted()
    const row = within(panel()).getByText('Brittany payroll').closest('tr') as HTMLElement
    expect(row.textContent).toContain('Shared Books LLC')
    expect(row.textContent).toContain('Brittany Bookkeepington')
  })

  it('orders newest first', () => {
    signInAs(OWNER, true, 'Owner')
    renderCompleted()
    const titles = within(panel())
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('td')?.textContent ?? '')

    expect(titles.indexOf('Noah sales tax')).toBeLessThan(titles.indexOf('Lisa monthly close'))
    expect(titles.indexOf('Lisa monthly close')).toBeLessThan(titles.indexOf('Brittany payroll'))
    // Undated rows sort LAST — they are the oldest work in the system.
    expect(titles[titles.length - 1]).toBe('Brittany ancient history')
  })
})

describe('rows with no completion date', () => {
  it('renders an honest placeholder instead of inventing one', () => {
    renderCompleted()
    const row = within(panel()).getByText('Brittany ancient history').closest('tr') as HTMLElement
    const cells = [...row.querySelectorAll('td')]

    expect(cells[cells.length - 1].textContent).toBe('—')
    expect(
      within(row).getByTitle('Completed before the app recorded completion dates'),
    ).toBeInTheDocument()
    // And the table says what the dash means.
    expect(panel().textContent).toContain(
      'was completed before the app started recording completion dates',
    )
  })
})

describe('read-only', () => {
  it('offers no control that could change a task', () => {
    signInAs(OWNER, true, 'Owner')
    renderCompleted()
    const scope = within(panel())

    // No completion toggles, and nothing to press: the filters are selects and
    // date inputs, and the component is not handed a single mutating callback.
    expect(scope.queryAllByRole('checkbox')).toHaveLength(0)
    expect(scope.queryAllByRole('button')).toHaveLength(0)
    expect(scope.queryByRole('link')).not.toBeInTheDocument()
    expect(scope.queryAllByRole('textbox')).toHaveLength(0)
  })

  it('does not wire up the toggle even when the owner is signed in', () => {
    signInAs(OWNER, true, 'Owner')
    renderCompleted()
    expect(contextValue.toggleChecklistItem).not.toHaveBeenCalled()
  })
})
