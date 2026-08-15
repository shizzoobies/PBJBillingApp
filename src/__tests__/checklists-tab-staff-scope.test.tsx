import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, ChecklistTemplate } from '../lib/types'

/**
 * The Checklists tab's three areas, from featreq-9b47ab5b:
 *
 *   Active / In progress — each employee sees only their OWN.
 *   Repeating            — everyone assigned to the client can SEE the
 *                          recurring checklists but not change them.
 *   Standard             — templates only the OWNER can change; an accountant
 *                          can view and copy one to a client.
 *
 * Owners are unaffected throughout. Writes are refused server-side regardless
 * (bulk workspace saves and template-stage CRUD are owner-only, and
 * `templateApplyRoleDenial` gates the copy), so these assertions are about the
 * page not offering staff a control that would be refused — or, worse, one that
 * would succeed against a colleague's work.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const BRITTANY = 'emp-brit'
const LISA = 'emp-lisa'
const CLIENT = { id: 'client-shared', name: 'Brittany Bookkeeping' }

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: CLIENT.id,
    dueDate: '2026-12-31',
    items: [{ id: 'it-1', label: 'Step', done: false }],
    ...over,
  }) as Checklist

const template = (over: Partial<ChecklistTemplate>): ChecklistTemplate =>
  ({
    clientId: CLIENT.id,
    frequency: 'monthly',
    assigneeId: LISA,
    stages: [],
    items: [],
    ...over,
  }) as unknown as ChecklistTemplate

const RECURRING = template({ id: 'tpl-recurring', title: 'Monthly bank rec', isStandard: false })
const STANDARD = template({
  id: 'tpl-standard',
  title: 'New client onboarding',
  isStandard: true,
  clientId: '',
})

const data = {
  clients: [CLIENT],
  employees: [
    { id: BRITTANY, name: 'Brittany Bookkeepington', role: 'Bookkeeper' },
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
  ],
  checklists: [
    checklist({ id: 'cl-brit', title: 'Brittany payroll', assigneeId: BRITTANY }),
    checklist({ id: 'cl-lisa', title: 'Lisa monthly close', assigneeId: LISA }),
  ],
  checklistTemplates: [RECURRING, STANDARD],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue

function signInAs(viewerId: string, isOwner: boolean, staffRole = 'Bookkeeper') {
  contextValue = {
    data,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee', staffRole },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee', staffRole },
    visibleChecklists: checklistsVisibleTo(data.checklists, { viewerId, isOwner }),
    visibleClients: data.clients,
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

const renderArea = (area: string) =>
  render(
    <MemoryRouter initialEntries={[`/checklists?area=${area}`]}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

/** The In-progress list buckets by due date and ships those groups collapsed. */
function openDueGroups() {
  for (const heading of screen.queryAllByRole('button', { name: /^(Later|Overdue|This week)/ })) {
    fireEvent.click(heading)
  }
}

beforeEach(() => {
  signInAs(BRITTANY, false)
})

describe('Active / In progress', () => {
  it('shows an employee only their own active checklists', () => {
    renderArea('progress')
    openDueGroups()
    expect(screen.getAllByText('Brittany payroll').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('Lisa monthly close')).toHaveLength(0)
  })

  it('leaves the owner everyone’s', () => {
    signInAs('emp-patrice', true, 'Owner')
    renderArea('progress')
    openDueGroups()
    expect(screen.getAllByText('Brittany payroll').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Lisa monthly close').length).toBeGreaterThan(0)
  })
})

describe('Repeating', () => {
  it('shows a non-owner the client’s recurring checklists, read-only', () => {
    renderArea('repeating')
    // Grouped by client and collapsed until opened.
    fireEvent.click(screen.getByRole('button', { name: /Brittany Bookkeeping/ }))
    expect(screen.getAllByText('Monthly bank rec').length).toBeGreaterThan(0)
    // No editor: the owner's manager renders a delete control per template.
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add recurring/i })).not.toBeInTheDocument()
  })
})

describe('Standard', () => {
  it('shows a bookkeeper the blueprints with no edit and no copy', () => {
    renderArea('standard')
    expect(screen.getAllByText('New client onboarding').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /copy to client/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })

  it('lets an accountant copy one to a client — still no edit', () => {
    signInAs(BRITTANY, false, 'Accountant')
    renderArea('standard')
    expect(screen.getByRole('button', { name: /copy to client/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })
})
