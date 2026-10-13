import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveChecklistsBoardPage } from '../pages/ActiveChecklistsBoardPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { addDays, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, ChecklistTemplate, Client } from '../lib/types'

/**
 * featreq-338b1507: "On our board we only want the active checklist step
 * instead of the full checklist ... Should be easy to go to the board and see
 * what step we are on for each client." A "Current step only" checkbox, ON by
 * default and remembered per user, shows each checklist's first open step (bold,
 * with its due date, who it is for and a Waiting / Overdue chip) and the next two
 * open steps dimmed. Unticked, the board is exactly what it was.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: async () => [],
}))

let contextValue: AppContextValue

const OWNER = 'emp-owner'
const AVERY = 'emp-avery'
const STORAGE_KEY = `pbj.boardStepView.v1.${OWNER}`
const TODAY = localDateOnly()
const STEP_DUE = addDays(TODAY, 5)

const ACME: Client = { id: 'client-acme', name: 'Acme Books', assignedBookkeeperIds: [] } as unknown as Client
const ZED: Client = { id: 'client-zed', name: 'Zed Works', assignedBookkeeperIds: [] } as unknown as Client
const CATEGORIES = [{ id: 'cat-books', name: 'Bookkeeping', sortOrder: 0 }]

const stage = (id: string, name: string) => ({
  id,
  name,
  offsetDays: 0,
  viewerIds: [],
  editorIds: [],
  items: [{ id: `${id}-item`, label: 'x' }],
})

const TEMPLATES = [
  {
    id: 'tpl-close',
    title: 'Monthly close',
    clientId: ACME.id,
    frequency: 'monthly',
    active: false,
    viewerIds: [],
    editorIds: [],
    stages: [stage('s1', 'Prepare'), stage('s2', 'Review'), stage('s3', 'Deliver')],
  },
  {
    id: 'tpl-payroll',
    title: 'Payroll setup',
    clientId: ACME.id,
    frequency: 'monthly',
    active: false,
    viewerIds: [],
    editorIds: [],
    stages: [stage('p1', 'Collect'), stage('p2', 'Enter'), stage('p3', 'Approve')],
  },
  {
    // Produces an "Upcoming" ghost once "Show upcoming" is ticked.
    id: 'tpl-ghost',
    title: 'Quarterly review',
    clientId: ZED.id,
    frequency: 'monthly',
    assigneeId: OWNER,
    nextDueDate: addDays(TODAY, 20),
    active: true,
    viewerIds: [],
    editorIds: [],
    stages: [{ ...stage('g1', 'Only'), assigneeId: OWNER }],
  },
] as unknown as ChecklistTemplate[]

const base = {
  assigneeId: OWNER,
  viewerIds: [],
  editorIds: [],
  frequency: 'monthly',
  categoryId: 'cat-books',
}

const CLOSE = {
  ...base,
  id: 'cl-close',
  clientId: ACME.id,
  title: 'Monthly close',
  templateId: 'tpl-close',
  stageIndex: 1,
  dueDate: addDays(TODAY, 10),
  items: [
    { id: 'a', label: 'Pull statements', done: true },
    { id: 'b', label: 'Reconcile bank feed', done: false, dueDate: STEP_DUE, assigneeId: AVERY },
    { id: 'c', label: 'Categorize expenses', done: false },
    { id: 'd', label: 'Send reports', done: false },
    { id: 'e', label: 'Archive workpapers', done: false },
  ],
} as unknown as Checklist

const PAYROLL = {
  ...base,
  id: 'cl-payroll',
  clientId: ACME.id,
  title: 'Payroll setup',
  templateId: 'tpl-payroll',
  stageIndex: 0,
  dueDate: addDays(TODAY, 12),
  items: [{ id: 'p', label: 'Collect W-4s', done: false, waiting: true, waitingOn: 'client paperwork' }],
} as unknown as Checklist

const INTAKE = {
  ...base,
  id: 'cl-intake',
  clientId: ZED.id,
  title: 'Engagement intake',
  dueDate: addDays(TODAY, 8),
  items: [],
} as unknown as Checklist

const CHECKLISTS = [CLOSE, PAYROLL, INTAKE]

/** The same "Mon D" the board's Due chips use. */
function shortMonthDay(iso: string) {
  const parsed = new Date(`${iso}T12:00:00`)
  return `${parsed.toLocaleString('en-US', { month: 'short' })} ${parsed.getDate()}`
}

beforeEach(() => {
  window.localStorage.clear()
  const data = {
    clients: [ACME, ZED],
    employees: [
      { id: OWNER, name: 'Owner', role: 'Owner' },
      { id: AVERY, name: 'Avery Stone', role: 'Bookkeeper' },
    ],
    checklists: CHECKLISTS,
    checklistTemplates: TEMPLATES,
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: CATEGORIES,
  } as unknown as AppData
  contextValue = {
    data,
    dataRefreshCount: 0,
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner' },
    sessionUser: { id: OWNER, role: 'owner' },
    visibleChecklists: checklistsVisibleTo(CHECKLISTS, { viewerId: OWNER, isOwner: true }),
    visibleClients: [ACME, ZED],
    visibleClientIds: new Set([ACME.id, ZED.id]),
    serviceCategories: CATEGORIES,
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { preset: 'custom', from: '2020-01-01', to: '2099-12-31' },
    setReportPeriod: vi.fn(),
    updateChecklistMeta: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateSubItemWaiting: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    reorderChecklistSubItems: vi.fn(),
  } as unknown as AppContextValue
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderBoard() {
  return render(
    <MemoryRouter initialEntries={['/board']}>
      <ActiveChecklistsBoardPage />
    </MemoryRouter>,
  )
}

const stepBlock = (checklistTitle: string) => {
  const block = screen.getByText(checklistTitle, { selector: '.board-step-title' }).closest('.board-step-block')
  if (!block) throw new Error(`No step block for ${checklistTitle}`)
  return block as HTMLElement
}

describe('Board: Current step only (default ON)', () => {
  it('opens every row and shows the current step in bold with due date and assignee, the next two dimmed, and a link', () => {
    renderBoard()
    const toggle = screen.getByRole('checkbox', { name: 'Current step only' })
    expect(toggle).toBeChecked()

    // No collapse toggle: the rows are open, the roll-up still reads in the header.
    expect(screen.queryByRole('button', { name: /Acme Books/ })).not.toBeInTheDocument()
    const acmeHead = screen.getByText('Acme Books').closest('.board-client-head') as HTMLElement
    expect(acmeHead).toHaveTextContent('1 waiting')
    expect(acmeHead).toHaveTextContent('2')

    const close = stepBlock('Monthly close')
    expect(close).toHaveTextContent('Step 2 of 3 - Review')
    const active = within(close).getByText('Reconcile bank feed')
    expect(active.tagName).toBe('STRONG')
    const activeLine = active.closest('.board-step-active') as HTMLElement
    expect(activeLine).toHaveTextContent(`Due ${shortMonthDay(STEP_DUE)}`)
    expect(activeLine).toHaveTextContent('Avery Stone')

    const coming = close.querySelectorAll('.board-step-coming')
    expect([...coming].map((line) => line.querySelector('.board-step-label')?.textContent)).toEqual([
      'Categorize expenses',
      'Send reports',
    ])
    expect(within(close).queryByText('Archive workpapers')).not.toBeInTheDocument()
    expect(within(close).queryByText('Pull statements')).not.toBeInTheDocument()
    expect(within(close).getByRole('link', { name: 'Open checklist' })).toHaveAttribute(
      'href',
      '/checklists?focus=cl-close',
    )

    // The full card is not rendered.
    expect(document.querySelector('.checklist-block')).toBeNull()
  })

  it('the checklist Due chip names the right month (MONTH_NAMES is 1-based)', () => {
    renderBoard()
    const wrapper = stepBlock('Monthly close').closest('.board-card-with-status') as HTMLElement
    expect(wrapper.querySelector('.board-chip-due')).toHaveTextContent(`Due ${shortMonthDay(STEP_DUE)}`)
  })

  it('a waiting current step carries the Waiting chip on its line', () => {
    renderBoard()
    const payroll = stepBlock('Payroll setup')
    const activeLine = within(payroll).getByText('Collect W-4s').closest('.board-step-active') as HTMLElement
    expect(within(activeLine).getByText('Waiting - client paperwork')).toHaveClass('board-chip-pending')
  })

  it('shows "No steps yet" on an empty checklist and "Then: Step N+2 - <stage>" when the current step is the last open one', () => {
    renderBoard()
    expect(stepBlock('Engagement intake')).toHaveTextContent('No steps yet')
    const payroll = stepBlock('Payroll setup')
    expect(payroll).toHaveTextContent('Step 1 of 3 - Collect')
    expect(payroll).toHaveTextContent('Then: Step 2 - Enter')
    expect(stepBlock('Monthly close')).not.toHaveTextContent('Then:')
  })

  it('unticking it restores the collapsible rows and the full checklist card', () => {
    renderBoard()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Current step only' }))
    expect(document.querySelector('.board-step-block')).toBeNull()
    const row = screen.getByRole('button', { name: /Acme Books/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(row)
    expect(document.querySelector('.checklist-block')).not.toBeNull()
  })

  it('remembers the choice per user and reads it back', () => {
    const first = renderBoard()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Current step only' }))
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ currentStepOnly: false })
    first.unmount()
    cleanup()

    renderBoard()
    expect(screen.getByRole('checkbox', { name: 'Current step only' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: /Acme Books/ })).toBeInTheDocument()
  })

  it('falls back to ON when storage is unusable, and toggling still works', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderBoard()
    const toggle = screen.getByRole('checkbox', { name: 'Current step only' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(toggle).not.toBeChecked()
  })

  it('the search box also matches the current step, but not a later one', () => {
    renderBoard()
    const search = screen.getByRole('searchbox', { name: /search board/i })
    fireEvent.change(search, { target: { value: 'reconcile BANK' } })
    expect(stepBlock('Monthly close')).toBeInTheDocument()
    expect(screen.queryByText('Zed Works')).not.toBeInTheDocument()
    expect(screen.queryByText('Payroll setup', { selector: '.board-step-title' })).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'archive workpapers' } })
    expect(screen.getByText(/No clients or checklists match/)).toBeInTheDocument()
  })

  it('a projected ghost still renders the Upcoming card', async () => {
    renderBoard()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show upcoming' }))
    await waitFor(() => expect(document.querySelector('.checklist-card.projected')).not.toBeNull())
    expect(screen.getAllByText('Upcoming').length).toBeGreaterThan(0)
    expect(screen.getByRole('checkbox', { name: 'Current step only' })).toBeChecked()
  })
})
