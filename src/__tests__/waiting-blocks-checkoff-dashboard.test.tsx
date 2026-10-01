import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * A waiting step cannot be checked off (featreq-cdab1605) - the Dashboard
 * queue's checkbox, including the case the single-node predicate missed:
 * ticking an item cascades `done` onto its sub-items, so an item whose
 * SUB-step is waiting is blocked too. The decision is pinned in
 * `lib/waiting-on-state.test.mjs`; this is the wiring on the queue.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn().mockResolvedValue({ billRateVersions: [], costRateVersions: [] }),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  listInvoicesRequest: vi.fn().mockResolvedValue([]),
}))

const LISA = 'emp-lisa'

let contextValue: AppContextValue

function signInWith(items: Checklist['items']) {
  const data = {
    clients: [{ id: 'client-acme', name: 'Acme LLC', assignedBookkeeperIds: [LISA] }],
    employees: [{ id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' }],
    checklists: [
      {
        id: 'cl-1',
        clientId: 'client-acme',
        title: 'August close',
        assigneeId: LISA,
        // No due date lands in the "Today" group, which renders open.
        dueDate: '',
        items,
      },
    ],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    inactiveEmployees: [],
    serviceCategories: [],
  } as unknown as AppData
  contextValue = {
    data,
    role: 'employee',
    ownerMode: false,
    previewMode: false,
    activeEmployeeId: LISA,
    sessionUser: { id: LISA, name: 'Lisa Chen', role: 'employee' },
    effectiveUser: { id: LISA, name: 'Lisa Chen', role: 'employee' },
    billingPeriod: '2026-08',
    firmSettings: { clientDefaults: { hourlyRate: 0 } },
    checklistSkips: [],
    reviewChecklistSkip: vi.fn(),
    skipChecklistOccurrence: vi.fn(),
    toggleChecklistItem: vi.fn(),
    setPreviewUserId: vi.fn(),
    waitingOnMe: [],
  } as unknown as AppContextValue
}

const queueBox = (label: string): HTMLInputElement => {
  const row = screen.getByText(label).closest('li')
  const box = row?.querySelector('input[type="checkbox"]')
  if (!box) throw new Error(`no queue checkbox for "${label}"`)
  return box as HTMLInputElement
}

const renderDashboard = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <DashboardPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the Dashboard queue checkbox', () => {
  it('is disabled for a waiting item', () => {
    signInWith([{ id: 'it-1', label: 'Bank rec', done: false, assigneeId: LISA, waiting: true }])
    renderDashboard()
    expect(queueBox('Bank rec')).toBeDisabled()
  })

  it('is disabled for an item whose SUB-step is waiting, and says so', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: LISA,
        subItems: [
          { id: 'sub-1', title: 'Pull statements', done: false },
          { id: 'sub-2', title: 'Match deposits', done: false, waiting: true },
        ],
      },
    ] as unknown as Checklist['items'])
    renderDashboard()
    const box = queueBox('Bank rec')
    expect(box).toBeDisabled()
    expect(box.closest('label')?.title).toBe('A sub-step is waiting - clear it first')
  })

  it('leaves an ordinary item with ordinary sub-steps checkable', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: LISA,
        subItems: [{ id: 'sub-1', title: 'Pull statements', done: false }],
      },
    ] as unknown as Checklist['items'])
    renderDashboard()
    expect(queueBox('Bank rec')).not.toBeDisabled()
  })
})
