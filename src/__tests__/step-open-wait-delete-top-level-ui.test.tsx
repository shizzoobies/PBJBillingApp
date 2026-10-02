import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * A TOP-LEVEL step with an open saved wait cannot be deleted (featreq-e8aa2abe),
 * the same rule as its sub-steps. The server refuses it for everyone (pinned in
 * `waiting-blocks-checkoff-route.test.ts` and `db/store-staleness.test.mjs`); the
 * page says so up front: the delete control is disabled with the sentence as its
 * title, and when the server refuses anyway (a wait added from another tab) the
 * card shows the server's own sentence inline, never a generic failure and never
 * an alert. A verified (closed) wait does not block.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-patrice'
const LISA = 'emp-lisa'
const CLIENT: Client = {
  id: 'client-shared',
  name: 'Shared Books LLC',
  assignedBookkeeperIds: [LISA],
} as unknown as Client
const SENTENCE =
  'This step has an open wait on it. Close the wait first (mark it done and approve it), then delete the step.'

const wait = (over: Record<string, unknown> = {}) => ({
  id: 'wo-1',
  blockerId: OWNER,
  requestedBy: LISA,
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
  verifiedBy: LISA,
})

const items = () =>
  [
    { id: 'it-own', label: 'Own wait step', done: false, waitingOns: [wait()] },
    { id: 'it-resolved', label: 'Resolved wait step', done: false, waitingOns: [resolvedWait] },
    {
      id: 'it-sub',
      label: 'Waited sub-step parent',
      done: false,
      subItems: [{ id: 'sub-1', title: 'Waited sub-step', done: false, waitingOns: [wait({ id: 'wo-4' })] }],
    },
    { id: 'it-closed', label: 'Closed wait step', done: false, waitingOns: [verifiedWait] },
    { id: 'it-plain', label: 'Plain step', done: false },
  ] as unknown as Checklist['items']

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: CLIENT.id,
    assigneeId: LISA,
    dueDate: '2026-08-31',
    viewerIds: [],
    editorIds: [],
    items: items(),
    ...over,
  }) as Checklist

const RECURRING = checklist({ id: 'cl-recurring', title: 'Recurring close', templateId: 'tmpl-1' })
const ONE_OFF = checklist({ id: 'cl-oneoff', title: 'One off cleanup' })

const data = {
  clients: [CLIENT],
  employees: [
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
  ],
  checklists: [RECURRING, ONE_OFF],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue
let deleteChecklistItem: ReturnType<typeof vi.fn>
let deleteChecklistItemFromSeries: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean, extra: Record<string, unknown> = {}) {
  deleteChecklistItem = vi.fn().mockResolvedValue(undefined)
  deleteChecklistItemFromSeries = vi.fn().mockResolvedValue(undefined)
  contextValue = {
    data,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    visibleChecklists: checklistsVisibleTo(data.checklists, { viewerId, isOwner }),
    visibleClients: [CLIENT],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    pushChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
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
    approveItemDeletion: vi.fn(),
    bulkAddChecklistItems: vi.fn(),
    deleteChecklist: vi.fn(),
    deleteChecklistItem,
    reorderChecklistSubItems: vi.fn(),
    dataRefreshCount: 0,
    deleteChecklistItemFromSeries,
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
    ...extra,
  } as unknown as AppContextValue
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/checklists']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

const cardFor = (title: string) => screen.getByText(title).closest('article, li, section') as HTMLElement
/** The × of one step: its row is the `.task-item` that holds the label. */
const deleteButtonOf = (title: string, label: string) => {
  const row = Array.from(cardFor(title).querySelectorAll('.task-item')).find((el) =>
    el.textContent?.includes(label),
  )
  return row?.querySelector('button[aria-label="Delete item"]') as HTMLButtonElement
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each([
  ['owner', OWNER, true],
  ['staff', LISA, false],
] as const)('delete control on a top-level step with an open wait (%s)', (_name, viewerId, isOwner) => {
  beforeEach(() => signInAs(viewerId, isOwner))

  it('is disabled, titled with the sentence, on a step with its own waiting or resolved wait', () => {
    renderPage()
    for (const label of ['Own wait step', 'Resolved wait step']) {
      const button = deleteButtonOf('Recurring close', label)
      expect(button, label).toBeDisabled()
      expect(button.title, label).toBe(SENTENCE)
      fireEvent.click(button)
    }
    expect(screen.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
    expect(deleteChecklistItem).not.toHaveBeenCalled()
    expect(deleteChecklistItemFromSeries).not.toHaveBeenCalled()
  })

  it('is disabled when the open wait is on a sub-step beneath the step', () => {
    renderPage()
    const button = deleteButtonOf('One off cleanup', 'Waited sub-step parent')
    expect(button).toBeDisabled()
    expect(button.title).toBe(SENTENCE)
  })

  it('stays on for a step whose wait is verified and for one with no wait', () => {
    renderPage()
    for (const label of ['Closed wait step', 'Plain step']) {
      const button = deleteButtonOf('Recurring close', label)
      expect(button, label).not.toBeDisabled()
      expect(button.title, label).toBe('Delete item')
    }
    fireEvent.click(deleteButtonOf('Recurring close', 'Plain step'))
    expect(screen.getByRole('group', { name: 'Where to delete this step' })).toBeInTheDocument()
  })
})

describe('the server refuses anyway (a wait added from another tab)', () => {
  const refusal = () => Object.assign(new Error(SENTENCE), { status: 409 })

  it('"This checklist only" keeps the prompt open and shows the server\'s sentence inline, with no alert', async () => {
    signInAs(OWNER, true)
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    deleteChecklistItem.mockRejectedValue(refusal())
    renderPage()
    fireEvent.click(deleteButtonOf('Recurring close', 'Plain step'))
    const group = screen.getByRole('group', { name: 'Where to delete this step' })
    fireEvent.click(within(group).getByRole('button', { name: 'This checklist only' }))
    expect(await within(group).findByRole('alert')).toHaveTextContent(SENTENCE)
    expect(screen.getByRole('group', { name: 'Where to delete this step' })).toBeInTheDocument()
    expect(alert).not.toHaveBeenCalled()
  })

  it('"This + all future" shows the server\'s sentence inline, with no alert', async () => {
    signInAs(OWNER, true)
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    deleteChecklistItemFromSeries.mockRejectedValue(refusal())
    renderPage()
    fireEvent.click(deleteButtonOf('Recurring close', 'Plain step'))
    const group = screen.getByRole('group', { name: 'Where to delete this step' })
    fireEvent.click(within(group).getByRole('button', { name: 'This + all future' }))
    expect(await within(group).findByRole('alert')).toHaveTextContent(SENTENCE)
    expect(alert).not.toHaveBeenCalled()
  })

  it('a one-off checklist (plain confirm) shows the sentence under its steps, with no alert', async () => {
    signInAs(OWNER, true)
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    deleteChecklistItem.mockRejectedValue(refusal())
    renderPage()
    fireEvent.click(deleteButtonOf('One off cleanup', 'Plain step'))
    await waitFor(() => expect(deleteChecklistItem).toHaveBeenCalledWith('cl-oneoff', 'it-plain'))
    expect(await within(cardFor('One off cleanup')).findByRole('alert')).toHaveTextContent(SENTENCE)
    expect(alert).not.toHaveBeenCalled()
  })
})

describe('the owner\'s Approve on a deletion request for a whole step with an open wait', () => {
  const request = (itemId: string, label: string, scope?: 'series') => ({
    id: `del-${itemId}`,
    clientId: CLIENT.id,
    checklistId: 'cl-oneoff',
    itemId,
    subItemId: null,
    subSubItemId: null,
    label,
    scope,
    requestedBy: LISA,
    requestedByName: 'Lisa Chen',
    requestedAt: '2026-09-30T15:00:00.000Z',
  })

  it('is disabled with the sentence for a waited step, and enabled for a plain one', () => {
    signInAs(OWNER, true, {
      itemDeletionRequests: [
        request('it-own', 'Own wait step'),
        request('it-sub', 'Waited sub-step parent'),
        request('it-plain', 'Plain step'),
      ],
    })
    renderPage()
    const rows = screen
      .getAllByRole('listitem')
      .filter((li) => li.className.includes('pending-deletion-item'))
    const approve = (label: string) =>
      Array.from(
        rows.find((row) => row.textContent?.includes(label))?.querySelectorAll('button') ?? [],
      ).find((button) => button.textContent === 'Approve') as HTMLButtonElement
    expect(approve('Own wait step')).toBeDisabled()
    expect(approve('Own wait step').title).toBe(SENTENCE)
    expect(approve('Waited sub-step parent')).toBeDisabled()
    expect(approve('Plain step')).not.toBeDisabled()
  })
})
