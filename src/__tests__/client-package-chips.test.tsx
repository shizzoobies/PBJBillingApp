import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplyPackageField, PlanChecklistsBody, PlanServicesField } from '../pages/ClientDetailPage'
import { chosenPackagesOf, packagesForClient } from '../lib/packages'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistTemplate, Client, Package, SubscriptionPlan } from '../lib/types'

/**
 * THE CHOSEN PACKAGE LIVES ON THE CLIENT (featreq-8bdc5ec5, part 2).
 *
 * Brittany picked a package and still saw four individual plan chips with an
 * empty Packages row. A chosen package (`client.packageIds`) now lists its plans
 * under Packages; Plans / services holds only the plans outside every chosen
 * package; and a client with none chosen reads exactly as it did before.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listPackagesRequest: (...args: unknown[]) => listPackagesRequest(...args),
  applyPackageRequest: vi.fn(),
}))

let listPackagesRequest = vi.fn()
let contextValue: AppContextValue
const onCommit = vi.fn()

const plan = (id: string, name: string, templateIds: string[] = []): SubscriptionPlan => ({
  id,
  name,
  notes: '',
  templateIds,
})
const blueprint = (id: string, title: string): ChecklistTemplate =>
  ({ id, title, clientId: '', frequency: 'monthly', isStandard: true, stages: [] }) as unknown as ChecklistTemplate

const PLANS = [
  plan('tx', 'Transactions - Monthly', ['T1']),
  plan('rec', 'Reconciliations - Monthly', ['T2']),
  plan('rpt', 'Review and Prepare Reports - Quarterly', ['T3']),
  plan('meet', 'Client Meeting - Quarterly', ['T4']),
  plan('pay', 'Payroll', ['T5']),
]
const TEMPLATES = [
  blueprint('T1', 'Transactions'),
  blueprint('T2', 'Reconciliations'),
  blueprint('T3', 'Reports'),
  blueprint('T4', 'Client Meeting'),
  blueprint('T5', 'Payroll run'),
]
const QA: Package = {
  id: 'qa',
  name: 'Quarterly Accounting',
  description: '',
  planIds: ['tx', 'rec', 'rpt'],
  templateIds: ['T1', 'T2', 'T3'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: null,
}

const client = (overrides: Partial<Client> = {}): Client =>
  ({
    id: 'c1',
    name: 'Acme',
    planIds: ['tx', 'rec', 'rpt', 'meet'],
    packageIds: ['qa'],
    ...overrides,
  }) as Client

function setContext(extra: Partial<AppContextValue> = {}) {
  contextValue = {
    ownerMode: true,
    data: { plans: PLANS, clients: [], checklistTemplates: TEMPLATES } as unknown as AppData,
    addChecklistTemplate: vi.fn(),
    updateChecklistTemplate: vi.fn(),
    ...extra,
  } as unknown as AppContextValue
}

/** The two rows side by side, sharing one packages list as the Billing section does. */
function Rows({ value, packages = [QA] }: { value: Client; packages?: Package[] }) {
  return (
    <div>
      <PlanServicesField client={value} plans={PLANS} packages={packages} onCommit={onCommit} />
      <ApplyPackageField client={value} packages={packages} onCommit={onCommit} />
    </div>
  )
}

const chipLabels = (field: HTMLElement) =>
  Array.from(field.querySelectorAll('.sharing-chip > strong')).map((node) => node.textContent)
const fieldOf = (label: string) => screen.getByText(label).closest('.field') as HTMLElement

beforeEach(() => {
  onCommit.mockReset()
  listPackagesRequest = vi.fn(async () => [QA])
  setContext()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Packages row and the Plans / services chips', () => {
  it('lists the chosen package with its plans, and leaves only the outside plans as chips', () => {
    render(<Rows value={client()} />)

    const packages = fieldOf('Packages')
    expect(chipLabels(packages)).toEqual(['Quarterly Accounting - 3 plans'])
    expect(within(packages).getByText('Quarterly Accounting')).toBeTruthy()
    expect(
      within(packages).getByText(
        'Transactions - Monthly, Reconciliations - Monthly, Review and Prepare Reports - Quarterly',
      ),
    ).toBeTruthy()

    expect(chipLabels(fieldOf('Plans / services'))).toEqual(['Client Meeting - Quarterly'])
  })

  it('counts the client\u2019s own plans of the package, graying the one it lacks', () => {
    render(<Rows value={client({ planIds: ['tx', 'rec', 'meet'] })} />)

    const packages = fieldOf('Packages')
    expect(chipLabels(packages)).toEqual(['Quarterly Accounting - 2 of 3 plans'])
    const missing = within(packages).getByText('Review and Prepare Reports - Quarterly (not on this client)')
    expect(missing.className).toContain('muted-text')
    expect(within(packages).getByText(/Transactions - Monthly, Reconciliations - Monthly/)).toBeTruthy()
  })

  it('shows every plan as a chip and no package chip while none is chosen', () => {
    render(<Rows value={client({ packageIds: [] })} />)

    expect(chipLabels(fieldOf('Packages'))).toEqual([])
    expect(chipLabels(fieldOf('Plans / services'))).toEqual([
      'Transactions - Monthly',
      'Reconciliations - Monthly',
      'Review and Prepare Reports - Quarterly',
      'Client Meeting - Quarterly',
    ])
  })

  it('ignores a chosen id whose package no longer exists', () => {
    render(<Rows value={client({ packageIds: ['gone'] })} />)
    expect(chipLabels(fieldOf('Packages'))).toEqual([])
    expect(chipLabels(fieldOf('Plans / services'))).toHaveLength(4)
  })

  it('adding a plan a chosen package already lists changes nothing and says so', () => {
    render(<Rows value={client()} />)

    fireEvent.click(screen.getByRole('button', { name: '+ Add plan / service' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Transactions - Monthly' }))

    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('Transactions - Monthly is already in Quarterly Accounting.')).toBeTruthy()
  })

  it('adding a plan outside the package saves it next to the plans the package holds', () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    render(<Rows value={client()} />)

    fireEvent.click(screen.getByRole('button', { name: '+ Add plan / service' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Payroll' }))

    expect(onCommit).toHaveBeenCalledWith({ planIds: ['tx', 'rec', 'rpt', 'meet', 'pay'] })
  })

  it('removing an outside plan keeps the plans the package holds', () => {
    render(<Rows value={client()} />)
    fireEvent.click(within(fieldOf('Plans / services')).getByRole('button', { name: 'Remove Client Meeting - Quarterly' }))
    expect(onCommit).toHaveBeenCalledWith({ planIds: ['tx', 'rec', 'rpt'] })
  })
})

describe('removing a chosen package', () => {
  it('takes the package off, then asks about its plans and keeps them on "Keep the plans"', () => {
    render(<Rows value={client()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Quarterly Accounting' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ packageIds: [] })
    expect(screen.getByText(/Also remove its plans from this client\?/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Keep the plans' }))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Also remove its plans from this client\?/)).toBeNull()
  })

  it('removes the package’s plans too on "Yes", leaving the outside plans', () => {
    render(<Rows value={client()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Quarterly Accounting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove its plans' }))

    expect(onCommit).toHaveBeenLastCalledWith({ planIds: ['meet'] })
  })

  it('keeps a plan another chosen package still lists', () => {
    const other: Package = { ...QA, id: 'other', name: 'Just Transactions', planIds: ['tx', 'pay'], templateIds: ['T1'] }
    render(<Rows value={client({ packageIds: ['qa', 'other'], planIds: ['tx', 'rec', 'rpt', 'pay'] })} packages={[QA, other]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Quarterly Accounting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove its plans' }))

    expect(onCommit).toHaveBeenLastCalledWith({ planIds: ['tx', 'pay'] })
  })
})

describe('the remove prompt and the hint belong to one client', () => {
  it('shows no remove prompt on the next client after navigating with it open', () => {
    const { rerender } = render(<Rows value={client()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Quarterly Accounting' }))
    expect(screen.getByText(/Also remove its plans from this client\?/)).toBeTruthy()

    rerender(<Rows value={client({ id: 'c2', name: 'Beta' })} />)
    expect(screen.queryByText(/Also remove its plans from this client\?/)).toBeNull()
  })

  it('carries no "already in" note to the next client', () => {
    const { rerender } = render(<Rows value={client()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add plan / service' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Transactions - Monthly' }))
    expect(screen.getByText('Transactions - Monthly is already in Quarterly Accounting.')).toBeTruthy()

    rerender(<Rows value={client({ id: 'c2', name: 'Beta' })} />)
    expect(screen.queryByText(/is already in Quarterly Accounting/)).toBeNull()
  })

  it('Undo puts the package back and closes the question', () => {
    render(<Rows value={client()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Quarterly Accounting' }))
    expect(onCommit).toHaveBeenLastCalledWith({ packageIds: [] })

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    // The prop still shows the pre-removal list in this harness, so the id is not doubled.
    expect(onCommit).toHaveBeenLastCalledWith({ packageIds: ['qa'] })
    expect(screen.queryByText(/Also remove its plans from this client\?/)).toBeNull()
  })
})

describe('the pure choice', () => {
  it('prefers the chosen packages and falls back to coverage only when none was ever chosen', () => {
    const covering = client({ packageIds: null })
    expect(packagesForClient(covering, [QA]).map((pkg) => pkg.id)).toEqual(['qa'])
    expect(packagesForClient(client({ packageIds: undefined }), [QA]).map((pkg) => pkg.id)).toEqual(['qa'])
    // Chosen none ([]): she removed the last package, so NO fallback.
    expect(packagesForClient(client({ packageIds: [] }), [QA])).toEqual([])
    // Chosen, though the client lacks a plan: still the chosen package.
    const partial = client({ planIds: ['tx'], packageIds: ['qa'] })
    expect(chosenPackagesOf(partial, [QA]).map((pkg) => pkg.id)).toEqual(['qa'])
    expect(packagesForClient(partial, [QA]).map((pkg) => pkg.id)).toEqual(['qa'])
    // Not chosen and not covered: nothing.
    expect(packagesForClient(client({ planIds: ['tx'], packageIds: null }), [QA])).toEqual([])
  })
})

describe('the Plan checklists panel follows the chosen package', () => {
  const flush = () =>
    act(async () => {
      await vi.mocked(listPackagesRequest).mock.results[0].value.catch(() => undefined)
    })

  it('falls back to the plans\u2019 coverage only for a client that never chose, not one that chose none', async () => {
    const check = async (packageIds: string[] | null) => {
      listPackagesRequest = vi.fn(async () => [QA])
      const value = client({ planIds: ['tx', 'rec', 'rpt'], packageIds })
      const data = { plans: PLANS, clients: [value], checklistTemplates: TEMPLATES } as unknown as AppData
      setContext({ data })
      const view = render(<PlanChecklistsBody client={value} data={data} />)
      await flush()
      const headings = Array.from(view.container.querySelectorAll('.plan-checklists-head > strong')).map(
        (node) => node.textContent,
      )
      view.unmount()
      return headings
    }
    expect(await check(null)).toEqual(['Quarterly Accounting'])
    expect(await check([])).toEqual([
      'Transactions - Monthly',
      'Reconciliations - Monthly',
      'Review and Prepare Reports - Quarterly',
    ])
  })

  it('groups by the chosen package even when the client lacks one of its plans', async () => {
    const value = client({ planIds: ['tx', 'meet'], packageIds: ['qa'] })
    const data = { plans: PLANS, clients: [value], checklistTemplates: TEMPLATES } as unknown as AppData
    setContext({ data })
    const { container } = render(<PlanChecklistsBody client={value} data={data} />)
    await flush()

    const headings = Array.from(container.querySelectorAll('.plan-checklists-head > strong')).map(
      (node) => node.textContent,
    )
    expect(headings).toEqual(['Quarterly Accounting', 'Client Meeting - Quarterly'])
  })
})
