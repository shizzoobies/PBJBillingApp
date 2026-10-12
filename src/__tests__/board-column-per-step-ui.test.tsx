import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistTemplate } from '../lib/types'

/**
 * featreq-3e81b386: "Can we change it to where the board setting is under each
 * step and not the checklist as a whole?" Each step of a recipe gets its own
 * "Board column" picker; "Same as recipe (<name>)" keeps the recipe's, which is
 * now labeled "Default board column".
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const CLIENT = { id: 'client-1', name: 'Acme Holdings' }
const CATEGORIES = [
  { id: 'cat-mb', name: 'Monthly Bookkeeping', sortOrder: 0 },
  { id: 'cat-review', name: 'Review', sortOrder: 1 },
]

const RECIPE = {
  id: 'tpl-1',
  title: 'Monthly close',
  clientId: CLIENT.id,
  frequency: 'monthly',
  assigneeId: 'emp-1',
  nextDueDate: '2026-12-31',
  active: true,
  viewerIds: [],
  editorIds: [],
  categoryId: 'cat-mb',
  stages: [
    {
      id: 'stage-1',
      name: 'Prepare',
      assigneeId: 'emp-1',
      offsetDays: 0,
      viewerIds: [],
      editorIds: [],
      items: [{ id: 'item-1', label: 'Reconcile bank feed' }],
    },
  ],
} as unknown as ChecklistTemplate

const data = {
  clients: [CLIENT],
  employees: [{ id: 'emp-1', name: 'Avery', role: 'Bookkeeper' }],
  checklists: [],
  checklistTemplates: [RECIPE],
  recycledChecklists: [],
  timeEntries: [],
} as unknown as AppData

let contextValue: AppContextValue
let patchTemplateStage: ReturnType<typeof vi.fn>

beforeEach(() => {
  patchTemplateStage = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  contextValue = {
    data,
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: 'emp-1',
    effectiveUser: { id: 'emp-1', role: 'owner', staffRole: 'Owner' },
    sessionUser: { id: 'emp-1', role: 'owner', staffRole: 'Owner' },
    visibleChecklists: [],
    visibleClients: data.clients,
    serviceCategories: CATEGORIES,
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { from: '2026-01-01', to: '2026-12-31' },
    setReportPeriod: vi.fn(),
    updateChecklistTemplate: vi.fn(),
    patchTemplateStage,
    dataRefreshCount: 0,
    reorderChecklistSubItems: vi.fn(),
    deleteChecklistItemFromSeries: vi.fn(),
  } as unknown as AppContextValue
})

function openEditor() {
  render(
    <MemoryRouter initialEntries={['/checklists?area=repeating']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: new RegExp(CLIENT.name) }))
  const row = screen
    .getAllByRole('button')
    .find((button) => button.querySelector('.repeating-task-title')?.textContent === RECIPE.title)
  if (!row) throw new Error('No repeating-task row')
  fireEvent.click(row)
}

describe('recipe editor: a Board column per step', () => {
  it('labels the recipe picker "Default board column"', () => {
    openEditor()
    const recipePicker = screen.getByLabelText('Default board column') as HTMLSelectElement
    expect(recipePicker.value).toBe('cat-mb')
  })

  it('gives each step a "Board column" picker defaulting to the recipe, and saves a choice on the step', () => {
    openEditor()
    const stageCard = document.querySelector('.stage-card') as HTMLElement
    const stepPicker = within(stageCard).getByLabelText('Board column') as HTMLSelectElement
    expect(stepPicker.value).toBe('')
    expect(within(stepPicker).getByRole('option', { name: 'Same as recipe (Monthly Bookkeeping)' })).toBeTruthy()

    fireEvent.change(stepPicker, { target: { value: 'cat-review' } })
    expect(patchTemplateStage).toHaveBeenCalledWith('tpl-1', 'stage-1', { categoryId: 'cat-review' })

    fireEvent.change(stepPicker, { target: { value: '' } })
    expect(patchTemplateStage).toHaveBeenLastCalledWith('tpl-1', 'stage-1', { categoryId: null })
  })
})
