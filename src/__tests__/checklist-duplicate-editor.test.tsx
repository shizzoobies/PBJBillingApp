import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, ChecklistTemplate } from '../lib/types'

/**
 * The Repeating tab's half of featreq-0bc2437e.
 *
 * Two things an owner has to be told, both learned the hard way when Brittany
 * duplicated a Let's Eat recipe and pointed it at I-95:
 *
 *   1. A copy arrives SWITCHED OFF, and its editor says so — otherwise the
 *      Duplicate button looks like it did nothing.
 *   2. Changing a recipe's client does NOT move the tasks it already made.
 *      Those carry the client they were born with, forever. The confirm names
 *      the count before the change, not after.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LETS_EAT = { id: 'client-lets-eat', name: "Let's Eat, LLC" }
const I95 = { id: 'client-i95', name: 'I-95 Signature, LLC' }

const template = (over: Partial<ChecklistTemplate>): ChecklistTemplate =>
  ({
    clientId: LETS_EAT.id,
    frequency: 'monthly',
    assigneeId: 'emp-1',
    nextDueDate: '2026-12-31',
    active: true,
    viewerIds: [],
    editorIds: [],
    stages: [
      {
        id: `${over.id}-stage`,
        name: 'Stage 1',
        assigneeId: 'emp-1',
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: [{ id: `${over.id}-item`, label: 'Reconcile bank feed' }],
      },
    ],
    ...over,
  }) as ChecklistTemplate

/** The recipe that has already produced work. */
const WORKING = template({ id: 'tpl-working', title: 'Monthly bookkeeping' })
/** Switched off, but hand-authored and never generated — not a copy. */
const UNUSED = template({ id: 'tpl-unused', title: 'Quarterly sales tax', active: false })
/** The copy Duplicate just made: off, never run, origin stamped. */
const COPY = template({
  id: 'tpl-copy',
  title: 'Monthly bookkeeping (copy)',
  active: false,
  sourceTemplateId: WORKING.id,
})

const instance = (id: string): Checklist =>
  ({
    id,
    templateId: WORKING.id,
    title: 'Monthly bookkeeping',
    clientId: LETS_EAT.id,
    assigneeId: 'emp-1',
    dueDate: '2026-09-30',
    viewerIds: [],
    editorIds: [],
    items: [],
  }) as unknown as Checklist

const data = {
  clients: [LETS_EAT, I95],
  employees: [{ id: 'emp-1', name: 'Avery', role: 'Bookkeeper' }],
  checklists: [instance('cl-1'), instance('cl-2'), instance('cl-3')],
  checklistTemplates: [WORKING, UNUSED, COPY],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue
let updateChecklistTemplate: ReturnType<typeof vi.fn>
let duplicateChecklistTemplate: ReturnType<typeof vi.fn>

beforeEach(() => {
  updateChecklistTemplate = vi.fn()
  duplicateChecklistTemplate = vi.fn(() => COPY.id)
  // happy-dom has no layout, so the copy's scroll-into-view is a no-op here.
  Element.prototype.scrollIntoView = vi.fn()
  contextValue = {
    data,
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: 'emp-1',
    effectiveUser: { id: 'emp-1', role: 'owner', staffRole: 'Owner' },
    sessionUser: { id: 'emp-1', role: 'owner', staffRole: 'Owner' },
    visibleChecklists: data.checklists,
    visibleClients: data.clients,
    serviceCategories: [],
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { from: '2026-01-01', to: '2026-12-31' },
    setReportPeriod: vi.fn(),
    updateChecklistTemplate,
    duplicateChecklistTemplate,
  } as unknown as AppContextValue
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Open the Repeating area, the client's group, and one recipe's editor. The
 * row's accessible name is the whole summary line (client, who, cadence, due
 * date, On/Off), so the row is found by its title span instead — "Monthly
 * bookkeeping" and "Monthly bookkeeping (copy)" both sit in this list.
 */
function openEditor(title: string) {
  render(
    <MemoryRouter initialEntries={['/checklists?area=repeating']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: new RegExp(LETS_EAT.name) }))
  const row = screen
    .getAllByRole('button')
    .find((button) => button.querySelector('.repeating-task-title')?.textContent === title)
  if (!row) throw new Error(`No repeating-task row titled "${title}"`)
  fireEvent.click(row)
}

describe('changing a recipe’s client', () => {
  it('names the tasks that stay behind, and leaves the client alone on cancel', () => {
    const confirm = vi.fn<(message: string) => boolean>(() => false)
    vi.stubGlobal('confirm', confirm)
    openEditor('Monthly bookkeeping')

    fireEvent.change(screen.getByLabelText('Client'), { target: { value: I95.id } })

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toBe(
      "3 existing tasks stay with Let's Eat, LLC. Only new tasks will be created for I-95 Signature, LLC. Change the client?",
    )
    expect(updateChecklistTemplate).not.toHaveBeenCalled()
  })

  it('changes the client once the owner says yes', () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    openEditor('Monthly bookkeeping')

    fireEvent.change(screen.getByLabelText('Client'), { target: { value: I95.id } })

    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
    const [templateId, updater] = updateChecklistTemplate.mock.calls[0]
    expect(templateId).toBe(WORKING.id)
    expect(updater(WORKING).clientId).toBe(I95.id)
  })

  it('does not ask when the recipe has never produced a task', () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    openEditor('Quarterly sales tax')

    fireEvent.change(screen.getByLabelText('Client'), { target: { value: I95.id } })

    expect(confirm).not.toHaveBeenCalled()
    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
  })
})

describe('Duplicate', () => {
  it('opens the copy’s editor and says why it is off', () => {
    openEditor('Monthly bookkeeping')
    fireEvent.click(screen.getByRole('button', { name: /duplicate/i }))

    expect(duplicateChecklistTemplate).toHaveBeenCalledWith(WORKING.id)
    expect(
      screen.getByText(/Switched off until you pick the client and turn it on/),
    ).toBeInTheDocument()
  })

  it('says nothing of the sort on a recipe that is simply switched off', () => {
    openEditor('Quarterly sales tax')

    expect(
      screen.queryByText(/Switched off until you pick the client and turn it on/),
    ).not.toBeInTheDocument()
  })
})
