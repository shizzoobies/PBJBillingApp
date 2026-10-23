import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveChecklistsBoardPage } from '../pages/ActiveChecklistsBoardPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { reportPeriodLabel, type ReportPeriod } from '../lib/reportPeriod'
import { addDays, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client, ServiceCategory } from '../lib/types'

/**
 * featreq-5a44c051: "also if we could add a today period". The shared Report
 * period control gains a "Today" preset (today..today). The Board reads only
 * the period's END as its horizon, so on Today it shows what is due today (and
 * anything already late) but nothing due tomorrow.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listAttachedPendingNotesRequest: async () => [],
}))

let contextValue: AppContextValue
let setReportPeriod: ReturnType<typeof vi.fn>

const OWNER = 'emp-owner'
const TODAY = localDateOnly()

const ACME = { id: 'client-acme', name: 'Acme Books', assignedBookkeeperIds: [] } as unknown as Client
const BOLT = { id: 'client-bolt', name: 'Bolt Co', assignedBookkeeperIds: [] } as unknown as Client

const CATEGORIES: ServiceCategory[] = [{ id: 'cat-feed', name: 'Clear Feed', sortOrder: 0, groupName: null }]

const checklist = (id: string, clientId: string, dueDate: string): Checklist =>
  ({
    id,
    clientId,
    categoryId: 'cat-feed',
    title: `Task ${id}`,
    assigneeId: OWNER,
    viewerIds: [],
    editorIds: [],
    frequency: 'monthly',
    dueDate,
    items: [{ id: `${id}-item`, label: 'Do it', done: false }],
  }) as unknown as Checklist

const CHECKLISTS = [checklist('cl-today', ACME.id, TODAY), checklist('cl-tomorrow', BOLT.id, addDays(TODAY, 1))]

function setup(reportPeriod: ReportPeriod) {
  setReportPeriod = vi.fn()
  const data = {
    clients: [ACME, BOLT],
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
    visibleClients: [ACME, BOLT],
    visibleClientIds: new Set([ACME.id, BOLT.id]),
    serviceCategories: CATEGORIES,
    addServiceCategory: vi.fn(),
    updateServiceCategory: vi.fn(),
    deleteServiceCategory: vi.fn(),
    checklistSkips: [],
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod,
    setReportPeriod,
  } as unknown as AppContextValue
}

beforeEach(() => {
  window.localStorage.clear()
})

const renderBoard = () =>
  render(
    <MemoryRouter initialEntries={['/board']}>
      <ActiveChecklistsBoardPage />
    </MemoryRouter>,
  )

// Columns start folded ("Name (N)"); expand them to read the client rows.
const boardClients = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
  return [...document.querySelectorAll<HTMLElement>('.board-client-name')].map((node) => node.textContent)
}

describe('Board: the "Today" report period', () => {
  it('offers Today first in the preset list, and picking it sets today..today', () => {
    setup({ preset: 'custom', from: '2020-01-01', to: '2099-12-31' })
    renderBoard()
    const select = screen.getByLabelText('Report period preset') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)[0]).toBe('Today')

    fireEvent.change(select, { target: { value: 'today' } })
    expect(setReportPeriod).toHaveBeenCalledWith({ preset: 'today', from: TODAY, to: TODAY })
  })

  it('on Today the Board shows what is due today and nothing due tomorrow', () => {
    setup({ preset: 'today', from: TODAY, to: TODAY })
    renderBoard()
    const clients = boardClients()
    expect(clients).toContain('Acme Books')
    expect(clients).not.toContain('Bolt Co')
    expect(
      screen.getByText(`1 client with open work · through ${reportPeriodLabel({ preset: 'today', from: TODAY, to: TODAY })}`),
    ).toBeInTheDocument()
  })

  it('a wider period still shows tomorrow (control case)', () => {
    setup({ preset: 'custom', from: TODAY, to: addDays(TODAY, 7) })
    renderBoard()
    expect(boardClients()).toEqual(expect.arrayContaining(['Acme Books', 'Bolt Co']))
  })
})
