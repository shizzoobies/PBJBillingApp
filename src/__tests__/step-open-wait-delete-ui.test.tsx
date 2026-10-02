import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * A sub-step or sub-sub-step with an open saved wait cannot be deleted
 * (featreq-1f352c4f). The server refuses it for everyone (pinned in
 * `waiting-blocks-checkoff-route.test.ts` and `db/store-staleness.test.mjs`); the
 * page says so up front: the Delete control is disabled and its title is the
 * sentence the server answers with, the same way it already explains a delete
 * that would finish a waiting step. A closed (verified) wait does not block.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-brit'
const WORKER = 'emp-avery'
const CLIENT = { id: 'client-acme', name: 'Acme Dental' }
const SENTENCE =
  'This step has an open wait on it. Close the wait first (mark it done and approve it), then delete the step.'

const wait = (over: Record<string, unknown> = {}) => ({
  id: 'wo-1',
  blockerId: OWNER,
  requestedBy: WORKER,
  note: 'needs your sign-off',
  createdAt: '2026-09-30T12:00:00.000Z',
  ...over,
})
const resolvedWait = wait({ id: 'wo-2', resolvedAt: '2026-09-30T13:00:00.000Z', resolvedBy: OWNER })
const verifiedWait = wait({
  id: 'wo-3',
  resolvedAt: '2026-09-30T13:00:00.000Z',
  resolvedBy: OWNER,
  verifiedAt: '2026-09-30T14:00:00.000Z',
  verifiedBy: WORKER,
})

const items = () =>
  [
    {
      id: 'it-1',
      label: 'Bank rec',
      done: false,
      assigneeId: WORKER,
      subItems: [
        { id: 'sub-1', title: 'Waited sub-step', done: false, waitingOns: [wait()] },
        { id: 'sub-2', title: 'Closed sub-step', done: false, waitingOns: [verifiedWait] },
        { id: 'sub-3', title: 'Plain sub-step', done: false },
        {
          id: 'sub-4',
          title: 'Parent of a waited one',
          done: false,
          subItems: [
            { id: 'ss-1', title: 'Resolved sub-sub', done: false, waitingOns: [resolvedWait] },
            { id: 'ss-2', title: 'Plain sub-sub', done: false },
          ],
        },
      ],
    },
  ] as unknown as Checklist['items']

const data = () =>
  ({
    clients: [CLIENT],
    employees: [
      { id: OWNER, name: 'Brittany Fox', role: 'owner' },
      { id: WORKER, name: 'Avery Lane', role: 'Bookkeeper' },
    ],
    checklists: [
      {
        id: 'cl-1',
        clientId: CLIENT.id,
        title: 'August close',
        assigneeId: WORKER,
        dueDate: '2026-12-31',
        items: items(),
      } as Checklist,
    ],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  }) as unknown as AppData

let contextValue: AppContextValue

function signInAs(viewer: 'staff' | 'owner', extra: Record<string, unknown> = {}) {
  const user =
    viewer === 'owner'
      ? { id: OWNER, role: 'owner', staffRole: 'Owner' }
      : { id: WORKER, role: 'staff', staffRole: 'Bookkeeper' }
  contextValue = {
    data: data(),
    ownerMode: viewer === 'owner',
    role: user.role,
    activeEmployeeId: user.id,
    effectiveUser: user,
    sessionUser: user,
    visibleChecklists: data().checklists,
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
    ...extra,
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

const deleteButton = (container: HTMLElement, label: string) => {
  const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
    el.textContent?.includes(label),
  )
  return row?.querySelector('button[aria-label="Delete sub-step"]') as HTMLButtonElement
}

beforeEach(() => {
  contextValue = undefined as unknown as AppContextValue
})

describe.each(['staff', 'owner'] as const)('delete controls on a step with an open wait (%s)', (viewer) => {
  it('disables Delete on a sub-step that carries an open wait, titled with the sentence', () => {
    signInAs(viewer)
    const { container } = renderProgress()
    const button = deleteButton(container, 'Waited sub-step')
    expect(button).toBeDisabled()
    expect(button.title).toBe(SENTENCE)
    fireEvent.click(button)
    expect(contextValue.removeSubItem).not.toHaveBeenCalled()
  })

  it('disables Delete on a sub-step whose sub-sub-step has an open wait, but not on the plain sub-sub-step', () => {
    signInAs(viewer)
    const { container } = renderProgress()
    const parent = deleteButton(container, 'Parent of a waited one')
    expect(parent).toBeDisabled()
    expect(parent.title).toBe(SENTENCE)
    const waitedChild = deleteButton(container, 'Resolved sub-sub')
    expect(waitedChild).toBeDisabled()
    expect(waitedChild.title).toBe(SENTENCE)
    expect(deleteButton(container, 'Plain sub-sub')).not.toBeDisabled()
  })

  it('leaves Delete on for a sub-step whose wait is verified, and for one with no wait', () => {
    signInAs(viewer)
    const { container } = renderProgress()
    for (const label of ['Closed sub-step', 'Plain sub-step']) {
      const button = deleteButton(container, label)
      expect(button, label).not.toBeDisabled()
      expect(button.title, label).toBe('Delete sub-step')
    }
    fireEvent.click(deleteButton(container, 'Plain sub-step'))
    expect(contextValue.removeSubItem).toHaveBeenCalledWith('cl-1', 'it-1', 'sub-3')
  })
})

describe('the owner\'s Approve on a deletion request for a step with an open wait', () => {
  const request = (subItemId: string, subSubItemId: string | null, label: string) => ({
    id: `del-${subItemId}`,
    clientId: CLIENT.id,
    checklistId: 'cl-1',
    itemId: 'it-1',
    subItemId,
    subSubItemId,
    label,
    requestedBy: WORKER,
    requestedByName: 'Avery Lane',
    requestedAt: '2026-09-30T15:00:00.000Z',
  })

  it('is disabled with the sentence for a waited node, and enabled for a plain one', () => {
    signInAs('owner', {
      itemDeletionRequests: [
        request('sub-1', null, 'Waited sub-step'),
        request('sub-3', null, 'Plain sub-step'),
      ],
    })
    renderProgress()
    const rows = screen
      .getAllByRole('listitem')
      .filter((li) => li.className.includes('pending-deletion-item'))
    const approve = (label: string) =>
      Array.from(
        rows.find((row) => row.textContent?.includes(label))?.querySelectorAll('button') ?? [],
      ).find((button) => button.textContent === 'Approve') as HTMLButtonElement
    expect(approve('Waited sub-step')).toBeDisabled()
    expect(approve('Waited sub-step').title).toBe(SENTENCE)
    expect(approve('Plain sub-step')).not.toBeDisabled()
  })
})
