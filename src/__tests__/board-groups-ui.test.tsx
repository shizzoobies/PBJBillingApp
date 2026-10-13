import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ActiveChecklistsBoardPage } from '../pages/ActiveChecklistsBoardPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { addDays, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client, ServiceCategory } from '../lib/types'

/**
 * featreq-54bf39b6: "If a board has nothing to show, can it be hidden so the
 * board is not so overwhelming when you look at it with nothing due? Maybe
 * Group Boards but have a main overview you can quickly see main groups."
 * Columns carry an optional group; the Board shows an overview strip (one chip
 * per group with its client count, "Other" for the ungrouped), a header over
 * each group, and a "Hide empty columns" box - ON by default, remembered per
 * user - that leaves out the columns with nothing on them.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: async () => [],
}))

let contextValue: AppContextValue
let updateServiceCategory: ReturnType<typeof vi.fn>
let addServiceCategory: ReturnType<typeof vi.fn>

const OWNER = 'emp-owner'
const STORAGE_KEY = `pbj.boardHideEmpty.v1.${OWNER}`
const TODAY = localDateOnly()

const ACME = { id: 'client-acme', name: 'Acme Books', assignedBookkeeperIds: [] } as unknown as Client
const BOLT = { id: 'client-bolt', name: 'Bolt Co', assignedBookkeeperIds: [] } as unknown as Client
const ZED = { id: 'client-zed', name: 'Zed Works', assignedBookkeeperIds: [] } as unknown as Client

const category = (id: string, name: string, sortOrder: number, groupName: string | null): ServiceCategory => ({
  id,
  name,
  sortOrder,
  groupName,
})

const GROUPED: ServiceCategory[] = [
  category('cat-feed', 'Clear Feed', 0, 'Core Accounting'),
  category('cat-recon', 'Reconciliations', 1, 'Core Accounting'),
  category('cat-payroll', 'Payroll', 2, 'Accounting Operations'),
  category('cat-tax', 'Sales Tax', 3, 'Accounting Operations'),
  category('cat-cash', 'Cash Flow', 4, 'CFO & Advisory'),
  category('cat-call', 'Client Call', 5, null),
]

const checklist = (id: string, clientId: string, categoryId: string): Checklist =>
  ({
    id,
    clientId,
    categoryId,
    title: `Task ${id}`,
    assigneeId: OWNER,
    viewerIds: [],
    editorIds: [],
    frequency: 'monthly',
    dueDate: addDays(TODAY, 5),
    items: [{ id: `${id}-item`, label: 'Do it', done: false }],
  }) as unknown as Checklist

// Core Accounting: Acme in two columns + Bolt = 2 distinct clients. Accounting
// Operations: Zed in Payroll, Sales Tax empty. CFO & Advisory: nothing at all.
// Other (ungrouped Client Call): Bolt.
const CHECKLISTS = [
  checklist('cl-1', ACME.id, 'cat-feed'),
  checklist('cl-2', ACME.id, 'cat-recon'),
  checklist('cl-3', BOLT.id, 'cat-recon'),
  checklist('cl-4', ZED.id, 'cat-payroll'),
  checklist('cl-5', BOLT.id, 'cat-call'),
]

function setup(categories: ServiceCategory[]) {
  updateServiceCategory = vi.fn(async () => {})
  addServiceCategory = vi.fn(async () => categories[0])
  const data = {
    clients: [ACME, BOLT, ZED],
    employees: [{ id: OWNER, name: 'Owner', role: 'Owner' }],
    checklists: CHECKLISTS,
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
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
    visibleClients: [ACME, BOLT, ZED],
    visibleClientIds: new Set([ACME.id, BOLT.id, ZED.id]),
    serviceCategories: categories,
    addServiceCategory,
    updateServiceCategory,
    deleteServiceCategory: vi.fn(),
    checklistSkips: [],
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { preset: 'custom', from: '2020-01-01', to: '2099-12-31' },
    setReportPeriod: vi.fn(),
  } as unknown as AppContextValue
}

beforeEach(() => {
  window.localStorage.clear()
  setup(GROUPED)
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

const strip = () => screen.getByRole('navigation', { name: 'Board groups' })
const chipLabels = () => within(strip()).getAllByRole('button').map((chip) => chip.textContent)
const groupHeaders = () =>
  [...document.querySelectorAll<HTMLElement>('.board-group-header')].map((header) => header.textContent)
const columnNames = () =>
  [...document.querySelectorAll<HTMLElement>('.board-column-header strong')].map((name) => name.textContent)

describe('Board column groups: the overview strip', () => {
  it('shows one chip per group with its distinct client count, "Other" last', () => {
    renderBoard()
    expect(chipLabels()).toEqual([
      'Core Accounting 2',
      'Accounting Operations 1',
      'CFO & Advisory 0',
      'Other 1',
    ])
  })

  it('clicking a chip scrolls that group’s header into view', () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original
    })
    renderBoard()
    fireEvent.click(within(strip()).getByRole('button', { name: /Accounting Operations/ }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'start' })
    const target = scrollIntoView.mock.contexts[0] as HTMLElement
    expect(target).toHaveClass('board-group-header')
    expect(target).toHaveTextContent('Accounting Operations')
  })

  it('shows "Other" only alongside named groups, and no strip or headers when no column has a group', () => {
    setup(GROUPED.map((entry) => ({ ...entry, groupName: null })))
    renderBoard()
    expect(screen.queryByRole('navigation', { name: 'Board groups' })).not.toBeInTheDocument()
    expect(document.querySelector('.board-group, .board-group-header')).toBeNull()
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
    // The board looks as it does today: columns straight inside the scroller.
    // (Hide empty columns is on: the four columns with clients.)
    expect(document.querySelectorAll('.board-scroll > .board-column').length).toBe(4)
  })

  it('with every column in a group there is no "Other" chip', () => {
    setup(GROUPED.map((entry) => (entry.groupName ? entry : { ...entry, groupName: 'Consulting' })))
    renderBoard()
    expect(chipLabels()).toEqual([
      'Core Accounting 2',
      'Accounting Operations 1',
      'CFO & Advisory 0',
      'Consulting 1',
    ])
  })

  it('the Uncategorized column sits under "Other"', () => {
    // Client Call deleted: its checklist falls to Uncategorized.
    setup(GROUPED.filter((entry) => entry.groupName !== null))
    renderBoard()
    expect(chipLabels()).toEqual(['Core Accounting 2', 'Accounting Operations 1', 'CFO & Advisory 0', 'Other 1'])
    const other = [...document.querySelectorAll<HTMLElement>('section.board-group')].at(-1) as HTMLElement
    expect(within(other).getByText('Uncategorized')).toBeInTheDocument()
  })
})

describe('Board column groups: grouped body and Hide empty columns', () => {
  it('is ON by default: hides empty columns and a group with none left, which keeps its 0 chip', () => {
    renderBoard()
    expect(screen.getByRole('checkbox', { name: 'Hide empty columns' })).toBeChecked()
    expect(groupHeaders()).toEqual(['Core Accounting2', 'Accounting Operations1', 'Other1'])
    expect(columnNames()).toEqual(['Clear Feed', 'Reconciliations', 'Payroll', 'Client Call'])
    // Each group's columns sit in its own row under its header.
    const ops = document.querySelectorAll<HTMLElement>('section.board-group')[1]
    expect(within(ops).getByText('Payroll')).toBeInTheDocument()
    expect(ops.querySelector('.board-group-columns .board-column')).not.toBeNull()
    expect(chipLabels()).toContain('CFO & Advisory 0')
  })

  it('unticked, every column and every group shows, as before', () => {
    renderBoard()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide empty columns' }))
    expect(groupHeaders()).toEqual([
      'Core Accounting2',
      'Accounting Operations1',
      'CFO & Advisory0',
      'Other1',
    ])
    expect(columnNames()).toEqual([
      'Clear Feed',
      'Reconciliations',
      'Payroll',
      'Sales Tax',
      'Cash Flow',
      'Client Call',
    ])
  })

  it('hides a column the search empties, and still says nothing matches', () => {
    renderBoard()
    fireEvent.change(screen.getByPlaceholderText('Search board…'), { target: { value: 'Zed' } })
    expect(columnNames()).toEqual(['Payroll'])
    expect(chipLabels()).toEqual(['Core Accounting 0', 'Accounting Operations 1', 'CFO & Advisory 0', 'Other 0'])
    fireEvent.change(screen.getByPlaceholderText('Search board…'), { target: { value: 'nobody-here' } })
    expect(screen.getByText('No clients or checklists match "nobody-here".')).toBeInTheDocument()
  })

  it('remembers the choice per user', () => {
    const { unmount } = renderBoard()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide empty columns' }))
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ hideEmpty: false })
    unmount()
    renderBoard()
    expect(screen.getByRole('checkbox', { name: 'Hide empty columns' })).not.toBeChecked()
    expect(columnNames()).toContain('Sales Tax')
  })

  it('a throwing localStorage is safe: default ON, and the box still works', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderBoard()
    const box = screen.getByRole('checkbox', { name: 'Hide empty columns' })
    expect(box).toBeChecked()
    fireEvent.click(box)
    expect(box).not.toBeChecked()
    expect(columnNames()).toContain('Sales Tax')
  })

  it('applies with no groups too: an empty column is left out until unticked', () => {
    setup(GROUPED.map((entry) => ({ ...entry, groupName: null })))
    renderBoard()
    expect(columnNames()).toEqual(['Clear Feed', 'Reconciliations', 'Payroll', 'Client Call'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide empty columns' }))
    expect(columnNames()).toHaveLength(6)
  })
})

describe('Manage columns: a Group per column', () => {
  const openManager = () => {
    renderBoard()
    fireEvent.click(screen.getByRole('button', { name: 'Manage columns' }))
  }

  it('shows each column’s group, with the existing group names offered', () => {
    openManager()
    expect(screen.getByLabelText('Group for Payroll')).toHaveValue('Accounting Operations')
    expect(screen.getByLabelText('Group for Client Call')).toHaveValue('')
    const options = [...document.querySelectorAll('datalist#board-group-names option')].map(
      (option) => (option as HTMLOptionElement).value,
    )
    expect(options).toEqual(['Core Accounting', 'Accounting Operations', 'CFO & Advisory'])
    expect(screen.getByLabelText('Group for Payroll')).toHaveAttribute('list', 'board-group-names')
  })

  it('saves a new group on blur, and clearing it sends null', () => {
    openManager()
    const input = screen.getByLabelText('Group for Payroll')
    fireEvent.change(input, { target: { value: '  Year-End ' } })
    fireEvent.blur(input)
    expect(updateServiceCategory).toHaveBeenLastCalledWith('cat-payroll', { groupName: 'Year-End' })

    const other = screen.getByLabelText('Group for Sales Tax')
    fireEvent.change(other, { target: { value: '' } })
    fireEvent.blur(other)
    expect(updateServiceCategory).toHaveBeenLastCalledWith('cat-tax', { groupName: null })
    expect(updateServiceCategory).toHaveBeenCalledTimes(2)
  })

  it('saves on Enter once (the blur after it does not save again), and an unchanged blur saves nothing', () => {
    openManager()
    fireEvent.blur(screen.getByLabelText('Group for Clear Feed'))
    expect(updateServiceCategory).not.toHaveBeenCalled()
    const input = screen.getByLabelText('Group for Client Call')
    fireEvent.change(input, { target: { value: 'Consulting' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(updateServiceCategory).toHaveBeenCalledTimes(1)
    expect(updateServiceCategory).toHaveBeenCalledWith('cat-call', { groupName: 'Consulting' })
  })

  it('the Add row takes an optional group', async () => {
    openManager()
    fireEvent.change(screen.getByPlaceholderText('New column name…'), { target: { value: 'Budget' } })
    fireEvent.change(screen.getByLabelText('Group for the new column'), { target: { value: 'CFO & Advisory' } })
    fireEvent.click(screen.getByRole('button', { name: /Add column/ }))
    expect(addServiceCategory).toHaveBeenCalledWith('Budget', 'CFO & Advisory')
    await vi.waitFor(() => expect(screen.getByPlaceholderText('New column name…')).toHaveValue(''))
    expect(screen.getByLabelText('Group for the new column')).toHaveValue('')

    fireEvent.change(screen.getByPlaceholderText('New column name…'), { target: { value: 'Forecast' } })
    fireEvent.click(screen.getByRole('button', { name: /Add column/ }))
    expect(addServiceCategory).toHaveBeenLastCalledWith('Forecast')
  })
})
