import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PackageLibrary, PlansPage } from '../pages/PlansPage'
import { ApplyPackageField } from '../pages/ClientDetailPage'
import { applyPackageConfirmText, defaultPackageTemplateIds } from '../lib/packages'
import type { AppContextValue } from '../AppContext'
import {
  ApiError,
  type AppData,
  type ChecklistTemplate,
  type Client,
  type Package,
  type SubscriptionPlan,
} from '../lib/types'

/**
 * PACKAGES in the UI (featreq-f890f05b) — the two surfaces and the sentence
 * between them.
 *
 * The two things worth pinning:
 *
 *   1. **A package must COMBINE.** The Plans page refuses one plan without
 *      going near the network — the server refuses it too, but a round trip to
 *      be told "pick another one" is not a form.
 *   2. **The confirm names everything before it happens**, including the line
 *      that stops the obvious misreading: a package is not a price. Applying
 *      one only runs after the owner says yes.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listPackagesRequest: (...args: unknown[]) => listPackagesRequest(...args),
  createPackageRequest: (...args: unknown[]) => createPackageRequest(...args),
  updatePackageRequest: (...args: unknown[]) => updatePackageRequest(...args),
  deletePackageRequest: (...args: unknown[]) => deletePackageRequest(...args),
  applyPackageRequest: (...args: unknown[]) => applyPackageRequest(...args),
  suggestPackageChecklistsRequest: (...args: unknown[]) => suggestPackageChecklistsRequest(...args),
  createSuggestedChecklistsRequest: (...args: unknown[]) =>
    createSuggestedChecklistsRequest(...args),
  // ClientDetailPage imports these from the same module; they are never
  // reached by the component under test.
  issueRetainerInvoiceRequest: vi.fn(),
  recordClientProfileActivity: vi.fn(),
  setClientAssignedTeamRequest: vi.fn(),
}))

let listPackagesRequest = vi.fn()
let createPackageRequest = vi.fn()
let updatePackageRequest = vi.fn()
let deletePackageRequest = vi.fn()
let applyPackageRequest = vi.fn()
let suggestPackageChecklistsRequest = vi.fn()
let createSuggestedChecklistsRequest = vi.fn()

const PLANS: SubscriptionPlan[] = [
  { id: 'plan-books', name: 'Bookkeeping', notes: '', templateIds: ['bp-close'] },
  { id: 'plan-payroll', name: 'Payroll', notes: '', templateIds: ['bp-payroll', 'bp-close'] },
]

const blueprint = (id: string, title: string): ChecklistTemplate =>
  ({ id, title, clientId: '', frequency: 'monthly', isStandard: true, stages: [] }) as
    unknown as ChecklistTemplate

const clientCopy = (id: string, sourceTemplateId: string): ChecklistTemplate =>
  ({
    id,
    title: 'Monthly close',
    clientId: 'c1',
    frequency: 'monthly',
    isStandard: false,
    sourceTemplateId,
    stages: [],
  }) as unknown as ChecklistTemplate

const TEMPLATES = [blueprint('bp-close', 'Monthly close'), blueprint('bp-payroll', 'Payroll run')]

const FULL_SERVICE: Package = {
  id: 'pkg-1',
  name: 'Full service',
  description: 'Books and payroll together.',
  planIds: ['plan-books', 'plan-payroll'],
  templateIds: ['bp-close', 'bp-payroll'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: null,
}

let contextValue: AppContextValue

function setContext(data: Partial<AppData>) {
  contextValue = {
    ownerMode: true,
    data: {
      plans: PLANS,
      clients: [],
      checklistTemplates: TEMPLATES,
      ...data,
    },
  } as unknown as AppContextValue
}

beforeEach(() => {
  listPackagesRequest = vi.fn(async () => [])
  createPackageRequest = vi.fn(async () => FULL_SERVICE)
  updatePackageRequest = vi.fn(async () => FULL_SERVICE)
  deletePackageRequest = vi.fn(async () => undefined)
  applyPackageRequest = vi.fn(async () => ({
    client: { id: 'c1', name: 'Acme' } as Client,
    addedPlanIds: ['plan-payroll'],
    clonedTemplateIds: ['bp-payroll'],
    skippedTemplateIds: ['bp-close'],
  }))
  suggestPackageChecklistsRequest = vi.fn(async () => [
    {
      title: 'Sales tax filing',
      frequency: 'quarterly',
      steps: [{ title: 'Pull taxable sales' }],
      why: 'Both plans here imply a filing obligation nobody owns yet.',
    },
    {
      title: 'Year-end 1099s',
      frequency: 'annually',
      steps: [{ title: 'Collect W-9s' }],
      why: 'Payroll clients almost always have contractors too.',
    },
  ])
  createSuggestedChecklistsRequest = vi.fn(async () => ({
    package: { ...FULL_SERVICE, templateIds: [...FULL_SERVICE.templateIds, 'bp-new'] },
    templates: [{ id: 'bp-new', title: 'Sales tax filing' }],
  }))
  setContext({})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Add one option through a ChipMultiSelect pill + menu. */
function pickChip(addLabel: string, optionLabel: string) {
  fireEvent.click(screen.getByRole('button', { name: addLabel }))
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(optionLabel) }))
}

describe('the Packages tab', () => {
  it('refuses a package that combines fewer than two plans, without asking the server', async () => {
    render(<PackageLibrary plans={PLANS} templates={TEMPLATES} ownerMode />)
    await waitFor(() => expect(listPackagesRequest).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Add package' }))
    fireEvent.change(screen.getByLabelText('Package name'), { target: { value: 'Solo' } })
    pickChip('+ Add plan', 'Bookkeeping')
    fireEvent.click(screen.getByRole('button', { name: 'Create package' }))

    expect(await screen.findByText('A package combines plans — pick at least two.')).toBeTruthy()
    expect(createPackageRequest).not.toHaveBeenCalled()
  })

  it('defaults the checklists to the union of the chosen plans, and creates with them', async () => {
    render(<PackageLibrary plans={PLANS} templates={TEMPLATES} ownerMode />)
    await waitFor(() => expect(listPackagesRequest).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Add package' }))
    fireEvent.change(screen.getByLabelText('Package name'), { target: { value: 'Full service' } })
    pickChip('+ Add plan', 'Bookkeeping')
    pickChip('+ Add plan', 'Payroll')

    // Bookkeeping brings Monthly close; Payroll brings Payroll run and Monthly
    // close again — the union is two, not three, and the count says so.
    expect(screen.getByText('Checklists (2)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create package' }))
    await waitFor(() => expect(createPackageRequest).toHaveBeenCalledTimes(1))
    expect(createPackageRequest).toHaveBeenCalledWith({
      name: 'Full service',
      description: '',
      planIds: ['plan-books', 'plan-payroll'],
      templateIds: ['bp-close', 'bp-payroll'],
    })
  })

  it('shows an existing package with its plans and its checklist count', async () => {
    listPackagesRequest = vi.fn(async () => [FULL_SERVICE])
    render(<PackageLibrary plans={PLANS} templates={TEMPLATES} ownerMode />)

    expect(await screen.findByText('Full service')).toBeTruthy()
    expect(screen.getByText('Plans: Bookkeeping, Payroll')).toBeTruthy()
    expect(screen.getByText(/2 checklists: Monthly close, Payroll run/)).toBeTruthy()
  })

  it('says a package changes no money, where the owner is deciding', async () => {
    render(<PackageLibrary plans={PLANS} templates={TEMPLATES} ownerMode />)
    expect(
      await screen.findByText(/Nothing on the invoice changes — plans are labels/),
    ).toBeTruthy()
  })
})

/**
 * The Plans page itself (featreq-f890f05b): Plans and Packages as two tabs at
 * the top, in place of the Packages section that used to sit below the plans
 * list. `PackageLibrary` fetches its own list on mount, so the tabs must keep
 * it MOUNTED and only hide it — switching tabs is never a re-fetch.
 */
describe('the Plans page tabs', () => {
  const renderPlansPage = (initialEntry = '/plans') => {
    contextValue = {
      ownerMode: true,
      data: { plans: PLANS, clients: [], checklistTemplates: TEMPLATES },
      addPlan: vi.fn(),
      updatePlan: vi.fn(),
      deletePlan: vi.fn(async () => undefined),
    } as unknown as AppContextValue
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <PlansPage />
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    listPackagesRequest = vi.fn(async () => [FULL_SERVICE])
  })

  it('defaults to the Plans tab, with Packages mounted but hidden', async () => {
    renderPlansPage()

    expect(screen.getByRole('tab', { name: /Plans/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Packages/ })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('Bookkeeping')).toBeVisible()

    await waitFor(() => expect(listPackagesRequest).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Full service')).not.toBeVisible()
  })

  it('shows only Packages after a click, without re-fetching', async () => {
    renderPlansPage()
    await waitFor(() => expect(listPackagesRequest).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: /Packages/ }))

    expect(screen.getByRole('tab', { name: /Packages/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Full service')).toBeVisible()
    expect(screen.getByText('Bookkeeping')).not.toBeVisible()
    expect(listPackagesRequest).toHaveBeenCalledTimes(1)
  })

  it('opens straight to Packages from ?tab=packages', async () => {
    renderPlansPage('/plans?tab=packages')

    expect(screen.getByRole('tab', { name: /Packages/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByText('Full service')).toBeVisible())
    expect(screen.getByText('Bookkeeping')).not.toBeVisible()
  })

  it('shows counts on each tab matching the fixtures', async () => {
    renderPlansPage()

    expect(screen.getByRole('tab', { name: /Plans/ })).toHaveTextContent(String(PLANS.length))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Packages/ })).toHaveTextContent('1'),
    )
  })
})

/**
 * The AI half. Brittany's wording is the test: the AI "always asks for approval
 * first, and only creates items after the user confirms". So the panel must be
 * incapable of creating anything on its own — every box starts UNCHECKED, and
 * the create is behind a confirm.
 */
describe('"Suggest checklists" in the package editor', () => {
  beforeEach(() => {
    listPackagesRequest = vi.fn(async () => [FULL_SERVICE])
  })

  const openEditor = async () => {
    render(<PackageLibrary plans={PLANS} templates={TEMPLATES} ownerMode />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Full service' }))
  }

  it('says plainly that it creates nothing on its own', async () => {
    await openEditor()
    expect(
      screen.getByText(
        'The AI only suggests. Nothing is created until you pick the ones you want and confirm.',
      ),
    ).toBeTruthy()
    // And it is not offered while creating a package — there is nothing to
    // attach a blueprint to until the package exists.
    expect(suggestPackageChecklistsRequest).not.toHaveBeenCalled()
  })

  it('renders each proposal with its reason, UNCHECKED', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest checklists' }))

    expect(await screen.findByText('Sales tax filing')).toBeTruthy()
    expect(
      screen.getByText('Both plans here imply a filing obligation nobody owns yet.'),
    ).toBeTruthy()
    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false)
    }
    // Nothing can be created while nothing is ticked.
    expect(
      (screen.getByRole('button', { name: 'Create selected (0)' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(createSuggestedChecklistsRequest).not.toHaveBeenCalled()
  })

  it('creates nothing when the confirm is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest checklists' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Sales tax filing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create selected (1)' }))

    expect(createSuggestedChecklistsRequest).not.toHaveBeenCalled()
  })

  it('creates exactly the ones she ticked, once she confirms', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest checklists' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Sales tax filing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create selected (1)' }))

    await waitFor(() => expect(createSuggestedChecklistsRequest).toHaveBeenCalledTimes(1))
    const [packageId, picked] = createSuggestedChecklistsRequest.mock.calls[0] as [
      string,
      Array<{ title: string }>,
    ]
    expect(packageId).toBe('pkg-1')
    expect(picked.map((row) => row.title)).toEqual(['Sales tax filing'])
    expect(await screen.findByText(/Created 1 checklist/)).toBeTruthy()
  })

  it('shows a model failure as a sentence rather than breaking the editor', async () => {
    suggestPackageChecklistsRequest = vi.fn(async () => {
      throw new ApiError(503, 'The AI is at capacity right now — give it a minute and try again.')
    })
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest checklists' }))

    expect(await screen.findByText(/The AI is at capacity right now/)).toBeTruthy()
    // The editor is still there and still usable.
    expect(screen.getByLabelText('Package name')).toBeTruthy()
  })
})

describe('"+ Add package" on a client', () => {
  const ACME: Client = { id: 'c1', name: 'Acme', planIds: ['plan-books'] } as Client

  beforeEach(() => {
    listPackagesRequest = vi.fn(async () => [FULL_SERVICE])
    setContext({
      clients: [ACME],
      checklistTemplates: [...TEMPLATES, clientCopy('tpl-c1-close', 'bp-close')],
    })
  })

  it('names exactly what will happen, then applies it', async () => {
    const confirm = vi.fn((message?: string) => Boolean(message))
    vi.stubGlobal('confirm', confirm)
    render(<ApplyPackageField client={ACME} />)
    await waitFor(() => expect(listPackagesRequest).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: '+ Add package' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Full service' }))

    const sentence = confirm.mock.calls[0]?.[0] ?? ''
    // Bookkeeping is already on the client, so only Payroll is added.
    expect(sentence).toContain('Adds plans: Payroll.')
    // Monthly close is already copied onto this client (the sourceTemplateId
    // stamp), so it is named as a skip rather than promised as a creation.
    expect(sentence).toContain('Creates 1 checklist for this client: Payroll run')
    expect(sentence).toContain('(1 already exists and will be skipped)')
    expect(sentence).toContain(
      'Nothing on the invoice changes — plans are labels; the monthly rate stays as it is.',
    )

    await waitFor(() => expect(applyPackageRequest).toHaveBeenCalledWith('c1', 'pkg-1'))
    expect(await screen.findByText(/Applied "Full service"/)).toBeTruthy()
  })

  it('does nothing at all when the confirm is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    render(<ApplyPackageField client={ACME} />)
    await waitFor(() => expect(listPackagesRequest).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: '+ Add package' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Full service' }))

    expect(applyPackageRequest).not.toHaveBeenCalled()
  })

  it('is absent on a billing master and on a retired client', async () => {
    const master = { ...ACME, isBillingMaster: true } as Client
    const { container: masterBox } = render(<ApplyPackageField client={master} />)
    expect(masterBox.textContent).toBe('')

    const retired = { ...ACME, lifecycleStage: 'inactive' } as Client
    const { container: retiredBox } = render(<ApplyPackageField client={retired} />)
    expect(retiredBox.textContent).toBe('')

    expect(listPackagesRequest).not.toHaveBeenCalled()
  })
})

describe('the pure halves', () => {
  it('unions a package’s default checklists in plan order, without repeats', () => {
    expect(defaultPackageTemplateIds(['plan-books', 'plan-payroll'], PLANS)).toEqual([
      'bp-close',
      'bp-payroll',
    ])
    expect(defaultPackageTemplateIds(['plan-payroll'], PLANS)).toEqual(['bp-payroll', 'bp-close'])
    expect(defaultPackageTemplateIds(['plan-gone'], PLANS)).toEqual([])
  })

  it('says so plainly when there is nothing to add', () => {
    const text = applyPackageConfirmText({
      packageName: 'Full service',
      clientName: 'Acme',
      addedPlanNames: [],
      newChecklistTitles: [],
      skippedCount: 2,
    })
    expect(text).toContain('Adds no plans — this client is already on all of them.')
    expect(text).toContain('Creates no checklists — all 2 of them are already set up here.')
  })
})
