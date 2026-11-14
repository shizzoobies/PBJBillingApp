import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, ChecklistTemplate, Client } from '../lib/types'

/**
 * Covered dates that can be corrected - featreq-6678d532. Brittany: "These do
 * not always get pushed correctly and there is not a way for us to update once
 * it becomes active."
 *
 * Two surfaces. On a CHECKLIST, Edit details now carries the two dates, and
 * changing them changes that checklist's case only. On the REPEATING TASK, the
 * two dates are the dates of the checklist that is open now - not of the next
 * one, which is where a correction used to land, a month off.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'
const OWNER = 'emp-patrice'

const CLIENT: Client = {
  id: 'client-shared',
  name: 'Shared Books LLC',
  assignedBookkeeperIds: [LISA],
} as unknown as Client

const RECIPE = {
  id: 'tmpl-recon',
  title: 'Monthly Reconciliations',
  clientId: CLIENT.id,
  assigneeId: LISA,
  frequency: 'monthly',
  // The November checklist is open; the recipe has already moved on to December.
  nextDueDate: '2026-12-05',
  active: true,
  periodLabelEnabled: true,
  // As typed in the summer: July's books, set for the August checklist.
  periodCoverageStart: '2026-07-01',
  periodCoverageEnd: '2026-07-31',
  periodCoverageAnchorDue: '2026-08-05',
  viewerIds: [],
  editorIds: [],
  stages: [
    {
      id: 'stage-1',
      name: 'Step 1',
      assigneeId: LISA,
      offsetDays: 0,
      viewerIds: [],
      editorIds: [],
      items: [{ id: 'titem-1', label: 'Reconcile' }],
    },
  ],
} as unknown as ChecklistTemplate

const QUIET_RECIPE = {
  ...RECIPE,
  id: 'tmpl-quiet',
  title: 'Quarter close',
  nextDueDate: '2027-01-20',
  frequency: 'quarterly',
  periodCoverageStart: '2026-07-01',
  periodCoverageEnd: '2026-09-30',
  periodCoverageAnchorDue: '2026-10-20',
} as unknown as ChecklistTemplate

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: CLIENT.id,
    assigneeId: LISA,
    dueDate: '2026-11-05',
    viewerIds: [],
    editorIds: [],
    items: [{ id: `${over.id}-step`, label: 'Reconcile', done: false }],
    ...over,
  }) as Checklist

const OPEN_NOVEMBER = checklist({
  id: 'cl-nov',
  title: 'Monthly Reconciliations',
  templateId: 'tmpl-recon',
  caseId: 'case-nov',
  periodLabel: 'October 1 – October 31, 2026',
})
const BY_HAND = checklist({
  id: 'cl-hand',
  title: 'Payroll catch-up',
  templateId: 'tmpl-recon',
  caseId: 'case-hand',
  dueDate: '2026-11-12',
  periodLabel: 'October 4 – October 17, 2026',
  periodLabelManual: true,
})
const NO_DATES = checklist({ id: 'cl-plain', title: 'One off cleanup' })
const STEP_TWO = checklist({
  id: 'cl-step2',
  title: 'Year-end package',
  caseId: 'case-steps',
  stageIndex: 1,
  stageCount: 3,
  periodLabel: 'January 1 – December 31, 2026',
})

let contextValue: AppContextValue
let updateChecklistMeta: ReturnType<typeof vi.fn>
let updateChecklistTemplate: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean, checklists: Checklist[]) {
  updateChecklistMeta = vi.fn().mockResolvedValue(null)
  updateChecklistTemplate = vi.fn()
  const data = {
    clients: [CLIENT],
    employees: [
      { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
      { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
    ],
    checklists,
    checklistTemplates: [RECIPE, QUIET_RECIPE],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  } as unknown as AppData
  contextValue = {
    data,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    visibleChecklists: checklistsVisibleTo(checklists, { viewerId, isOwner }),
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
    bulkAddChecklistItems: vi.fn(),
    deleteChecklist: vi.fn(),
    deleteChecklistItem: vi.fn(),
    dataRefreshCount: 0,
    deleteChecklistItemFromSeries: vi.fn(),
    emptyChecklistRecycleBin: vi.fn(),
    rejectChecklistDeletion: vi.fn(),
    removeSubItem: vi.fn(),
    removeSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    reorderChecklistSubItems: vi.fn(),
    restoreChecklist: vi.fn(),
    setChecklistViewers: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateChecklistMeta,
    updateChecklistTemplate,
    updateSubItemWaiting: vi.fn(),
  } as unknown as AppContextValue
}

const renderPage = (entry = '/checklists') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

/** The card for a given task title. */
const cardFor = (title: string) =>
  screen.getByText(title).closest('article, li, section') as HTMLElement

const openEditor = (title: string) => {
  const card = cardFor(title)
  fireEvent.click(within(card).getByRole('button', { name: 'Task actions' }))
  fireEvent.click(within(card).getByRole('menuitem', { name: 'Edit details' }))
  return card
}

describe('covered dates on one checklist', () => {
  beforeEach(() => {
    signInAs(LISA, false, [OPEN_NOVEMBER, BY_HAND, NO_DATES, STEP_TWO])
  })

  it('opens with the two dates its title shows', () => {
    renderPage()
    const card = openEditor('Monthly Reconciliations')
    expect(within(card).getByLabelText('Covers from')).toHaveValue('2026-10-01')
    expect(within(card).getByLabelText('Covers to')).toHaveValue('2026-10-31')
    expect(within(card).getByText(/changes this checklist only/i)).toBeInTheDocument()
  })

  it('sends the new dates when she changes them', () => {
    renderPage()
    const card = openEditor('Monthly Reconciliations')
    fireEvent.change(within(card).getByLabelText('Covers from'), { target: { value: '2026-10-04' } })
    fireEvent.change(within(card).getByLabelText('Covers to'), { target: { value: '2026-10-17' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    expect(updateChecklistMeta).toHaveBeenCalledWith(
      'cl-nov',
      expect.objectContaining({ coveredDates: { start: '2026-10-04', end: '2026-10-17' } }),
    )
  })

  it('sends no dates at all when she saved something else', () => {
    // Otherwise renaming a checklist would turn its dates into hand-set ones.
    renderPage()
    const card = openEditor('Monthly Reconciliations')
    fireEvent.change(within(card).getByLabelText('Checklist title'), { target: { value: 'Renamed' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    expect(updateChecklistMeta).toHaveBeenCalledTimes(1)
    expect(updateChecklistMeta.mock.calls[0][1]).not.toHaveProperty('coveredDates')
  })

  it('refuses an end before the start, says why, and keeps the editor open', () => {
    renderPage()
    const card = openEditor('Monthly Reconciliations')
    fireEvent.change(within(card).getByLabelText('Covers to'), { target: { value: '2026-09-15' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    expect(updateChecklistMeta).not.toHaveBeenCalled()
    expect(
      within(card).getByText('Pick both covered dates, with the first on or before the second.'),
    ).toBeInTheDocument()
    expect(within(card).getByLabelText('Covers to')).toBeInTheDocument()
  })

  it('refuses one date cleared', () => {
    renderPage()
    const card = openEditor('Monthly Reconciliations')
    fireEvent.change(within(card).getByLabelText('Covers from'), { target: { value: '' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    expect(updateChecklistMeta).not.toHaveBeenCalled()
  })

  it('says when the dates were set on this checklist, and can hand them back', () => {
    renderPage()
    const card = openEditor('Payroll catch-up')
    expect(within(card).getByLabelText('Covers from')).toHaveValue('2026-10-04')
    expect(within(card).getByText(/were set on this checklist/i)).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: "Use the repeating task's dates" }))
    expect(updateChecklistMeta).toHaveBeenCalledWith(
      'cl-hand',
      expect.objectContaining({ coveredDates: null }),
    )
  })

  it('handing the dates back saves the rest of the editor with it', () => {
    renderPage()
    const card = openEditor('Payroll catch-up')
    fireEvent.change(within(card).getByLabelText('Checklist title'), { target: { value: 'Renamed' } })
    // Dates she typed and then abandoned for the recipe's are not sent as hand-set ones.
    fireEvent.change(within(card).getByLabelText('Covers to'), { target: { value: '2026-10-20' } })
    fireEvent.click(within(card).getByRole('button', { name: "Use the repeating task's dates" }))
    expect(updateChecklistMeta).toHaveBeenCalledTimes(1)
    expect(updateChecklistMeta.mock.calls[0]).toEqual([
      'cl-hand',
      expect.objectContaining({ title: 'Renamed', coveredDates: null }),
    ])
  })

  it('does not offer to hand back dates that were never set by hand', () => {
    renderPage()
    const card = openEditor('Monthly Reconciliations')
    expect(
      within(card).queryByRole('button', { name: "Use the repeating task's dates" }),
    ).not.toBeInTheDocument()
  })

  it('says the change reaches every step when the checklist is one step of a case', () => {
    renderPage()
    const card = openEditor('Year-end package')
    expect(within(card).getByText(/every step of this case/i)).toBeInTheDocument()
  })

  it('shows no covered-date fields on a checklist that has none', () => {
    renderPage()
    const card = openEditor('One off cleanup')
    expect(within(card).queryByLabelText('Covers from')).not.toBeInTheDocument()
  })

  it('marks the chip of a hand-set label', () => {
    renderPage()
    expect(
      within(cardFor('Payroll catch-up')).getByTitle(
        'Covers October 4 – October 17, 2026 (set on this checklist)',
      ),
    ).toBeInTheDocument()
    expect(
      within(cardFor('Monthly Reconciliations')).getByTitle('Covers October 1 – October 31, 2026'),
    ).toBeInTheDocument()
  })
})

describe('covered dates on the repeating task', () => {
  const openRecipe = (title: string) => {
    renderPage('/checklists?area=repeating')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(CLIENT.name) }))
    const row = screen
      .getAllByRole('button')
      .find((button) => button.querySelector('.repeating-task-title')?.textContent === title)
    if (!row) throw new Error('No repeating-task row')
    fireEvent.click(row)
    return row.closest('article') as HTMLElement
  }

  beforeEach(() => {
    signInAs(OWNER, true, [OPEN_NOVEMBER, NO_DATES])
  })

  it('shows the dates of the checklist that is open now, not the ones typed in the summer', () => {
    const recipe = openRecipe('Monthly Reconciliations')
    expect(within(recipe).getByLabelText('From')).toHaveValue('2026-10-01')
    expect(within(recipe).getByLabelText('To')).toHaveValue('2026-10-31')
    expect(within(recipe).getByText(/The dates the open checklist covers/)).toBeInTheDocument()
    expect(within(recipe).getByText(/The checklist first due Nov 5/)).toBeInTheDocument()
  })

  it('attaches a correction to the open checklist, so it lands there and carries on', () => {
    const recipe = openRecipe('Monthly Reconciliations')
    fireEvent.change(within(recipe).getByLabelText('From'), { target: { value: '2026-10-04' } })
    const updater = updateChecklistTemplate.mock.calls.at(-1)?.[1] as (
      current: ChecklistTemplate,
    ) => ChecklistTemplate
    expect(updateChecklistTemplate.mock.calls.at(-1)?.[0]).toBe('tmpl-recon')
    expect(updater(RECIPE)).toMatchObject({
      periodCoverageStart: '2026-10-04',
      // The other date is written as it was SHOWN: both now count from November's checklist.
      periodCoverageEnd: '2026-10-31',
      // The open checklist's date - not the recipe's next due date (December 5).
      periodCoverageAnchorDue: '2026-11-05',
    })
  })

  it('writes the same anchor when the second date is the one she changes', () => {
    const recipe = openRecipe('Monthly Reconciliations')
    fireEvent.change(within(recipe).getByLabelText('To'), { target: { value: '2026-10-17' } })
    const updater = updateChecklistTemplate.mock.calls.at(-1)?.[1] as (
      current: ChecklistTemplate,
    ) => ChecklistTemplate
    expect(updater(RECIPE)).toMatchObject({
      periodCoverageStart: '2026-10-01',
      periodCoverageEnd: '2026-10-17',
      periodCoverageAnchorDue: '2026-11-05',
    })
  })

  /**
   * A recipe whose dates were last typed under the OLD rule is anchored to the
   * occurrence AFTER the open checklist (its next due date at the time). Its
   * dates do not govern the open checklist, so the fields must not claim they
   * do: they read what that checklist's own title says.
   */
  describe('a recipe anchored after its open checklist', () => {
    const LATE_ANCHOR = {
      ...RECIPE,
      // Typed in November for the December occurrence: November's books.
      periodCoverageStart: '2026-11-01',
      periodCoverageEnd: '2026-11-30',
      periodCoverageAnchorDue: '2026-12-05',
    } as unknown as ChecklistTemplate

    beforeEach(() => {
      signInAs(OWNER, true, [OPEN_NOVEMBER, NO_DATES])
      ;(contextValue.data as AppData).checklistTemplates = [LATE_ANCHOR, QUIET_RECIPE]
    })

    it('shows what the open checklist says, not the dates typed for the one after it', () => {
      const recipe = openRecipe('Monthly Reconciliations')
      // OPEN_NOVEMBER's title says October.
      expect(within(recipe).getByLabelText('From')).toHaveValue('2026-10-01')
      expect(within(recipe).getByLabelText('To')).toHaveValue('2026-10-31')
      expect(within(recipe).getByText('October 1 – October 31, 2026')).toBeInTheDocument()
    })

    it('a one-date change keeps the other as shown and attaches both to the open checklist', () => {
      const recipe = openRecipe('Monthly Reconciliations')
      fireEvent.change(within(recipe).getByLabelText('To'), { target: { value: '2026-10-17' } })
      const updater = updateChecklistTemplate.mock.calls.at(-1)?.[1] as (
        current: ChecklistTemplate,
      ) => ChecklistTemplate
      expect(updater(LATE_ANCHOR)).toMatchObject({
        periodCoverageStart: '2026-10-01',
        periodCoverageEnd: '2026-10-17',
        periodCoverageAnchorDue: '2026-11-05',
      })
    })
  })

  it('with nothing open, the dates are the next checklist\'s', () => {
    const recipe = openRecipe('Quarter close')
    // Third quarter was set for October; the next one, in January, covers the fourth.
    expect(within(recipe).getByLabelText('From')).toHaveValue('2026-10-01')
    expect(within(recipe).getByLabelText('To')).toHaveValue('2026-12-31')
    expect(within(recipe).getByText(/The dates the next checklist covers/)).toBeInTheDocument()
    fireEvent.change(within(recipe).getByLabelText('To'), { target: { value: '2026-12-15' } })
    const updater = updateChecklistTemplate.mock.calls.at(-1)?.[1] as (
      current: ChecklistTemplate,
    ) => ChecklistTemplate
    expect(updater(QUIET_RECIPE)).toMatchObject({
      periodCoverageStart: '2026-10-01',
      periodCoverageEnd: '2026-12-15',
      periodCoverageAnchorDue: '2027-01-20',
    })
  })
})
