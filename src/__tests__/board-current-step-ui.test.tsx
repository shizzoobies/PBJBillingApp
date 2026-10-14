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
 * what step we are on for each client." Her follow-up: "I consider the main a
 * step. And the items under it the task for that step. The open/unlocked step
 * should show on the board not the task." A "Current step only" checkbox, ON by
 * default and remembered per user, shows the STEP each checklist is on (the
 * stage, bold), who it is for, "N of M tasks done" and the next stage - never
 * the tasks themselves. Unticked, the board is exactly what it was.
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
const BOLT: Client = { id: 'client-bolt', name: 'Bolt Co', assignedBookkeeperIds: [] } as unknown as Client
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
  stageCount: 3,
  assigneeId: AVERY,
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
  stageCount: 3,
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

// Bolt Co: Overdue / Waiting live on the status chip only, and a checklist whose
// tasks all read done.
const LATE = {
  ...base,
  id: 'cl-late',
  clientId: BOLT.id,
  title: 'Sales tax filing',
  dueDate: addDays(TODAY, 6),
  items: [{ id: 'l', label: 'File the return', done: false, dueDate: addDays(TODAY, -2) }],
} as unknown as Checklist

const STUCK = {
  ...base,
  id: 'cl-stuck',
  clientId: BOLT.id,
  title: 'Year-end payroll',
  dueDate: addDays(TODAY, 6),
  items: [
    { id: 's', label: 'Issue W-2s', done: false, dueDate: addDays(TODAY, -3), waiting: true, waitingOn: 'client approval' },
  ],
} as unknown as Checklist

// Stored flag open, but every sub-step is done: the roll-up reads it done, so
// the checklist stays on the board with every task done (a stage not yet advanced).
const DONE_STAGE = {
  ...base,
  id: 'cl-done-stage',
  clientId: BOLT.id,
  title: 'Quarterly filing',
  dueDate: addDays(TODAY, 6),
  items: [{ id: 'q', label: 'Submit 941', done: false, subItems: [{ id: 'q1', label: 'Sign', done: true }] }],
} as unknown as Checklist

const CHECKLISTS = [CLOSE, PAYROLL, INTAKE, LATE, STUCK, DONE_STAGE]

/** The same "Mon D" the board's Due chips use. */
function shortMonthDay(iso: string) {
  const parsed = new Date(`${iso}T12:00:00`)
  return `${parsed.toLocaleString('en-US', { month: 'short' })} ${parsed.getDate()}`
}

beforeEach(() => {
  window.localStorage.clear()
  const data = {
    clients: [ACME, ZED, BOLT],
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
    visibleClients: [ACME, ZED, BOLT],
    visibleClientIds: new Set([ACME.id, ZED.id, BOLT.id]),
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

/** Every column unfolded (Expand all), then every client row (all start folded). */
function openAll() {
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
  for (const row of document.querySelectorAll<HTMLElement>('.board-client-toggle[aria-expanded="false"]')) {
    fireEvent.click(row)
  }
}

function renderOpenBoard() {
  const view = renderBoard()
  openAll()
  return view
}

/** The step block of the checklist with this title (shown as its step line or above it). */
const stepBlock = (checklistTitle: string) => {
  const block = [...document.querySelectorAll<HTMLElement>('.board-step-block')].find((candidate) =>
    candidate.textContent?.includes(checklistTitle),
  )
  if (!block) throw new Error(`No step block for ${checklistTitle}`)
  return block
}

// Every top-level task label on the board's checklists: none may be listed.
const TASK_LABELS = CHECKLISTS.flatMap((checklist) => checklist.items.map((item) => item.label))

describe('Board: Current step only (default ON)', () => {
  it('opens a row to show the step in bold, who it is for, the task count, the next stage and a link', () => {
    renderBoard()
    const toggle = screen.getByRole('checkbox', { name: 'Current step only' })
    expect(toggle).toBeChecked()

    // Columns and rows start folded; the roll-up reads in the toggle that opens each row.
    expect(document.querySelector('.board-client-toggle')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    const acmeHead = screen.getByRole('button', { name: /Acme Books/ })
    expect(acmeHead).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('.board-step-block')).toBeNull()
    expect(acmeHead).toHaveTextContent('1 waiting')
    expect(acmeHead).toHaveTextContent('2')
    fireEvent.click(acmeHead)
    expect(acmeHead).toHaveAttribute('aria-expanded', 'true')

    const close = stepBlock('Monthly close')
    const label = within(close).getByText('Step 2 of 3 - Review')
    expect(label.tagName).toBe('STRONG')
    expect(label).toHaveClass('board-step-label')
    // The checklist's name still says which case this is, as a quiet line.
    expect(within(close).getByText('Monthly close')).toHaveClass('board-step-title')
    const meta = close.querySelector('.board-step-meta') as HTMLElement
    expect(meta).toHaveTextContent('Avery Stone')
    expect(meta.querySelector('.board-step-count')).toHaveTextContent(/^1 of 5 tasks done$/)
    expect(within(close).getByText('Then: Step 3 - Deliver')).toHaveClass('board-step-next')
    expect(within(close).getByRole('link', { name: 'Open checklist' })).toHaveAttribute(
      'href',
      '/checklists?focus=cl-close',
    )

    // The full card is not rendered.
    expect(document.querySelector('.checklist-block')).toBeNull()
  })

  it('folds one client row on its own and opens it again, keeping the roll-up line', () => {
    renderOpenBoard()
    const acmeHead = screen.getByRole('button', { name: /Acme Books/ })
    const zedHead = screen.getByRole('button', { name: /Zed Works/ })
    expect(stepBlock('Monthly close')).toBeInTheDocument()
    fireEvent.click(acmeHead)
    expect(acmeHead).toHaveAttribute('aria-expanded', 'false')
    expect(acmeHead).toHaveTextContent('1 waiting')
    expect(screen.queryByText('Step 2 of 3 - Review')).not.toBeInTheDocument()
    // Another client's row is untouched.
    expect(zedHead).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(acmeHead)
    expect(acmeHead).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Step 2 of 3 - Review')).toBeInTheDocument()
  })

  it('lists no tasks at all - the step is the unit, its items stay on the card', () => {
    renderOpenBoard()
    expect(document.querySelectorAll('.board-step-block').length).toBe(CHECKLISTS.length)
    for (const taskLabel of TASK_LABELS) {
      expect(document.body).not.toHaveTextContent(taskLabel)
    }
    expect(document.querySelector('.board-step-active, .board-step-coming')).toBeNull()
  })

  it('an unstaged checklist reads as its own name in bold, not repeated', () => {
    renderOpenBoard()
    const block = stepBlock('Sales tax filing')
    const label = within(block).getByText('Sales tax filing')
    expect(label.tagName).toBe('STRONG')
    expect(label).toHaveClass('board-step-label')
    expect(block.querySelector('.board-step-title')).toBeNull()
    expect(block).toHaveTextContent('Owner')
    // Singular when the step has one task.
    expect(block.querySelector('.board-step-count')).toHaveTextContent(/^0 of 1 task done$/)
    expect(block).not.toHaveTextContent('Then:')
  })

  it('the first stage names the next one; a stage whose tasks all read done counts them', () => {
    renderOpenBoard()
    const payroll = stepBlock('Payroll setup')
    expect(within(payroll).getByText('Step 1 of 3 - Collect').tagName).toBe('STRONG')
    expect(payroll.querySelector('.board-step-count')).toHaveTextContent(/^0 of 1 task done$/)
    expect(payroll).toHaveTextContent('Then: Step 2 - Enter')

    const doneStage = stepBlock('Quarterly filing')
    expect(doneStage.querySelector('.board-step-count')).toHaveTextContent(/^1 of 1 task done$/)
    expect(doneStage).not.toHaveTextContent('All steps done')
  })

  it('a checklist with no tasks reads "No tasks yet"', () => {
    renderOpenBoard()
    const intake = stepBlock('Engagement intake')
    expect(within(intake).getByText('No tasks yet')).toBeInTheDocument()
    expect(intake).not.toHaveTextContent(/tasks? done/)
  })

  it('the checklist Due chip names the right month (MONTH_NAMES is 1-based)', () => {
    renderOpenBoard()
    const wrapper = stepBlock('Monthly close').closest('.board-card-with-status') as HTMLElement
    expect(wrapper.querySelector('.board-chip-due')).toHaveTextContent(`Due ${shortMonthDay(STEP_DUE)}`)
  })

  it('Waiting and Overdue live on the status chip only, never inside the step block', () => {
    renderOpenBoard()
    for (const [title, chipClass] of [
      ['Payroll setup', 'board-chip-pending'],
      ['Sales tax filing', 'board-chip-overdue'],
      ['Year-end payroll', 'board-chip-pending'],
    ] as const) {
      const block = stepBlock(title)
      const wrapper = block.closest('.board-card-with-status') as HTMLElement
      expect(wrapper.querySelector(`.board-card-chips .${chipClass}`)).not.toBeNull()
      expect(block.querySelector('.board-chip')).toBeNull()
    }
  })

  it('unticking it restores the collapsible rows and the full checklist card', () => {
    renderBoard()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
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

  it('the search box also matches the step a checklist is on, but not its tasks', () => {
    renderOpenBoard()
    const search = screen.getByRole('searchbox', { name: /search board/i })
    fireEvent.change(search, { target: { value: 'REVIEW' } })
    expect(stepBlock('Monthly close')).toBeInTheDocument()
    expect(screen.queryByText('Zed Works')).not.toBeInTheDocument()
    expect(screen.queryByText('Step 1 of 3 - Collect')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'step 1 of 3' } })
    expect(stepBlock('Payroll setup')).toBeInTheDocument()
    expect(screen.queryByText('Step 2 of 3 - Review')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'reconcile bank' } })
    expect(screen.getByText(/No clients or checklists match/)).toBeInTheDocument()
  })

  it('a projected ghost still renders the Upcoming card', async () => {
    renderOpenBoard()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show upcoming' }))
    await waitFor(() => {
      openAll()
      expect(document.querySelector('.checklist-card.projected')).not.toBeNull()
    })
    expect(screen.getAllByText('Upcoming').length).toBeGreaterThan(0)
    expect(screen.getByRole('checkbox', { name: 'Current step only' })).toBeChecked()
  })
})
