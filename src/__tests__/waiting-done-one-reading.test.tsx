import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { DelayedPage } from '../pages/DelayedPage'
import { boardChecklistStatus } from '../lib/activeBoard'
import { waitingStepCount } from '../lib/inProgressFilter'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, WaitingOn } from '../lib/types'

/**
 * ONE rule for "is this waiting step done": the roll-up (a step with sub-steps
 * is done when its sub-steps are - `isChecklistItemDone`). The Waiting count on
 * the card, the checkbox guard and the Delayed page always read it that way; the
 * step chip on the Checklists page and the Board used to read the step's STORED
 * done flag, so on data whose stored flag lags its sub-steps (or the reverse)
 * one screen said Waiting while another did not. These tests put the same data
 * in front of every screen and require the same answer.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-brit'
const WORKER = 'emp-avery'
const BLOCKER = 'emp-lisa'
const CLIENT = { id: 'client-acme', name: 'Acme Dental' }

const wait = (over: Partial<WaitingOn> = {}): WaitingOn => ({
  id: 'wo-1',
  blockerId: BLOCKER,
  requestedBy: OWNER,
  note: 'the bank statements',
  createdAt: '2026-08-05T15:00:00.000Z',
  ...over,
})

const checklistWith = (items: unknown[]): Checklist =>
  ({
    id: 'cl-1',
    clientId: CLIENT.id,
    title: 'August close',
    assigneeId: WORKER,
    // "Later" bucket: collapsed by default, opened by `renderProgress` below.
    dueDate: '2026-12-31',
    items,
  }) as unknown as Checklist

let contextValue: AppContextValue

function signIn(checklist: Checklist, viewerId: string) {
  const user = { id: viewerId, role: 'staff', staffRole: 'Bookkeeper' }
  const data = {
    clients: [CLIENT],
    employees: [
      { id: OWNER, name: 'Brittany Fox', role: 'owner' },
      { id: WORKER, name: 'Avery Lane', role: 'Bookkeeper' },
      { id: BLOCKER, name: 'Lisa Chen', role: 'Bookkeeper' },
    ],
    checklists: [checklist],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  } as unknown as AppData
  contextValue = {
    data,
    ownerMode: false,
    role: user.role,
    activeEmployeeId: viewerId,
    effectiveUser: user,
    sessionUser: user,
    visibleChecklists: data.checklists,
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
    reorderChecklistSubItems: vi.fn(),
    dataRefreshCount: 0,
    deleteChecklistItemFromSeries: vi.fn(),
    restoreChecklist: vi.fn(),
    setChecklistViewers: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateChecklistMeta: vi.fn(),
    updateSubItemWaiting: vi.fn(),
    waitingOnDone: vi.fn(),
    waitingOnVerify: vi.fn(),
    waitingOnSendBack: vi.fn(),
    waitingOnQuestion: vi.fn(),
  } as unknown as AppContextValue
}

const renderProgress = () => {
  const result = render(
    <MemoryRouter initialEntries={['/checklists?area=progress']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )
  for (const heading of screen.queryAllByRole('button', { name: /^(Later|Overdue|This week)/ })) {
    fireEvent.click(heading)
  }
  return result
}

/** Step chips that say a step is waiting NOW (not the "Was waiting on" record). */
const liveStepChips = (container: HTMLElement) =>
  container.querySelectorAll('.task-row-waiting:not(.task-row-waiting-resolved)')

/** How many waits the Delayed page lists for `viewerId` (rows on the Waiting-on-me tab). */
function delayedCount(checklist: Checklist, viewerId: string) {
  signIn(checklist, viewerId)
  const { unmount } = render(
    <MemoryRouter initialEntries={['/delayed']}>
      <DelayedPage />
    </MemoryRouter>,
  )
  const count = document.querySelectorAll('li.delayed-wait').length
  unmount()
  return count
}

/** Every screen's answer to "does this checklist have a live waiting step?". */
function readEverywhere(checklist: Checklist) {
  signIn(checklist, WORKER)
  const { container, unmount } = renderProgress()
  const chips = liveStepChips(container).length
  unmount()
  return {
    waitingCount: waitingStepCount(checklist),
    boardPending: boardChecklistStatus(checklist, '2026-09-01').kind === 'pending',
    chips,
    delayed: delayedCount(checklist, BLOCKER),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a step whose stored done flag lags its sub-steps', () => {
  // Stored done: false, but every sub-step is done: the roll-up says DONE, so the
  // wait it carries is not blocking anything any more.
  const lagging = checklistWith([
    {
      id: 'it-1',
      label: 'Bank rec',
      done: false,
      assigneeId: WORKER,
      waitingOns: [wait()],
      subItems: [
        { id: 'sub-1', title: 'Pull statements', done: true },
        { id: 'sub-2', title: 'Match the lines', done: true },
      ],
    },
  ])

  it('is not waiting on any screen: count, Board, step chip and Delayed page agree', () => {
    expect(readEverywhere(lagging)).toEqual({
      waitingCount: 0,
      boardPending: false,
      chips: 0,
      delayed: 0,
    })
  })

  it('keeps the card on the Board as due, not pending', () => {
    expect(boardChecklistStatus(lagging, '2026-09-01').kind).toBe('due')
  })
})

describe('a step whose stored done flag is true with a sub-step still open', () => {
  // Stored done: true, but a sub-step is open: the roll-up says OPEN, so the wait
  // it carries is still blocking.
  const reverse = checklistWith([
    {
      id: 'it-1',
      label: 'Bank rec',
      done: true,
      assigneeId: WORKER,
      waitingOns: [wait()],
      subItems: [
        { id: 'sub-1', title: 'Pull statements', done: true },
        { id: 'sub-2', title: 'Match the lines', done: false },
      ],
    },
    // Keeps the checklist in progress (a card whose stored flags are all true is Completed).
    { id: 'it-2', label: 'Payroll', done: false, assigneeId: WORKER },
  ])

  it('is waiting on every screen: count, Board, step chip and Delayed page agree', () => {
    expect(readEverywhere(reverse)).toEqual({
      waitingCount: 1,
      boardPending: true,
      chips: 1,
      delayed: 1,
    })
  })

  it('puts the card on the Board as pending, with the wait as the reason', () => {
    const status = boardChecklistStatus(reverse, '2026-09-01', { [BLOCKER]: 'Lisa Chen' })
    expect(status).toMatchObject({ kind: 'pending', waitingCount: 1 })
  })
})

describe('a sub-step whose stored done flag lags its sub-sub-steps', () => {
  const lagging = checklistWith([
    {
      id: 'it-1',
      label: 'Payroll',
      done: false,
      assigneeId: WORKER,
      subItems: [
        {
          id: 'sub-1',
          title: 'Confirm the hours',
          done: false,
          waitingOns: [wait()],
          subItems: [
            { id: 'ss-1', title: 'Sign', done: true },
            { id: 'ss-2', title: 'File', done: true },
          ],
        },
        { id: 'sub-2', title: 'Approve', done: false },
      ],
    },
  ])

  it('is done by its sub-sub-steps on every screen, so its wait blocks nothing', () => {
    expect(readEverywhere(lagging)).toEqual({
      waitingCount: 0,
      boardPending: false,
      chips: 0,
      delayed: 0,
    })
  })

  const reverse = checklistWith([
    {
      id: 'it-1',
      label: 'Payroll',
      done: false,
      assigneeId: WORKER,
      subItems: [
        {
          id: 'sub-1',
          title: 'Confirm the hours',
          done: true,
          waitingOns: [wait()],
          subItems: [
            { id: 'ss-1', title: 'Sign', done: true },
            { id: 'ss-2', title: 'File', done: false },
          ],
        },
        { id: 'sub-2', title: 'Approve', done: false },
      ],
    },
  ])

  it('is open by its sub-sub-steps on every screen, so its wait still counts', () => {
    expect(readEverywhere(reverse)).toEqual({
      waitingCount: 1,
      boardPending: true,
      chips: 1,
      delayed: 1,
    })
  })
})
