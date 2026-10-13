import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlansPage } from '../pages/PlansPage'
import type { AppContextValue } from '../AppContext'
import type { SubscriptionPlan } from '../lib/types'

/**
 * The "How often" select on each plan (featreq-acdd0c84, stage B1). It shows the
 * EFFECTIVE cadence - what the server derived - and says "(from the name)" when
 * nothing is stored. Choosing a value goes through the same updatePlan as name /
 * notes (the workspace autosave); the server keeps the choice.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listPackagesRequest: vi.fn(async () => []),
  createPackageRequest: vi.fn(),
  updatePackageRequest: vi.fn(),
  deletePackageRequest: vi.fn(),
  suggestPackageChecklistsRequest: vi.fn(),
  createSuggestedChecklistsRequest: vi.fn(),
}))

let contextValue: AppContextValue
const updatePlan = vi.fn()

const PLANS: SubscriptionPlan[] = [
  {
    id: 'plan-meeting',
    name: 'Client Meeting - Quarterly',
    notes: '',
    templateIds: [],
    cadence: null,
    effectiveCadence: 'quarterly',
  },
  { id: 'plan-books', name: 'Bookkeeping', notes: '', templateIds: [], cadence: null, effectiveCadence: 'blueprint' },
  // Renamed locally: the server's effectiveCadence is stale, the name now decides.
  {
    id: 'plan-renamed',
    name: 'Payroll - Weekly',
    notes: '',
    templateIds: [],
    cadence: null,
    effectiveCadence: 'blueprint',
  },
  {
    id: 'plan-reports',
    name: 'Reports - Quarterly',
    notes: '',
    templateIds: [],
    cadence: 'monthly',
    effectiveCadence: 'monthly',
  },
]

function renderPage(ownerMode = true) {
  contextValue = {
    ownerMode,
    data: { plans: PLANS, clients: [], checklistTemplates: [] },
    addPlan: vi.fn(),
    updatePlan,
    deletePlan: vi.fn(async () => undefined),
  } as unknown as AppContextValue
  return render(
    <MemoryRouter initialEntries={['/plans']}>
      <PlansPage />
    </MemoryRouter>,
  )
}

describe('the plan cadence select', () => {
  beforeEach(() => {
    updatePlan.mockClear()
  })

  it('offers the five choices, with the plain-English label for the last', () => {
    renderPage()
    const select = screen.getByLabelText('How often Bookkeeping') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Weekly',
      'Monthly',
      'Quarterly',
      'Yearly',
      "Use the checklist's own schedule",
    ])
    expect([...select.options].map((option) => option.value)).toEqual([
      'weekly',
      'monthly',
      'quarterly',
      'annual',
      'blueprint',
    ])
  })

  it('shows the effective value, and "(from the name)" only when it is read off the name', () => {
    renderPage()
    expect((screen.getByLabelText('How often Client Meeting - Quarterly') as HTMLSelectElement).value).toBe('quarterly')
    expect((screen.getByLabelText('How often Bookkeeping') as HTMLSelectElement).value).toBe('blueprint')
    expect((screen.getByLabelText('How often Reports - Quarterly') as HTMLSelectElement).value).toBe('monthly')
    // Two plans are derived from their names; the blueprint one and the stored one are not.
    expect((screen.getByLabelText('How often Payroll - Weekly') as HTMLSelectElement).value).toBe('weekly')
    expect(screen.getAllByText('How often (from the name)')).toHaveLength(2)
    expect(screen.getAllByText('How often')).toHaveLength(2)
  })

  it('saves a choice through updatePlan', () => {
    renderPage()
    fireEvent.change(screen.getByLabelText('How often Bookkeeping'), { target: { value: 'weekly' } })
    expect(updatePlan).toHaveBeenCalledWith('plan-books', { cadence: 'weekly', effectiveCadence: 'weekly' })
    fireEvent.change(screen.getByLabelText('How often Client Meeting - Quarterly'), {
      target: { value: 'blueprint' },
    })
    expect(updatePlan).toHaveBeenLastCalledWith('plan-meeting', {
      cadence: 'blueprint',
      effectiveCadence: 'blueprint',
    })
  })

  it('a non-owner sees the value as text, with no select', () => {
    renderPage(false)
    expect(screen.queryByLabelText('How often Bookkeeping')).toBeNull()
    expect(screen.getByText('How often: Quarterly (from the name)')).toBeTruthy()
    expect(screen.getByText("How often: Use the checklist's own schedule")).toBeTruthy()
  })
})
