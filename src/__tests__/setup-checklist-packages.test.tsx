import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupChecklistPage } from '../pages/SetupChecklistPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Client, Package } from '../lib/types'

/**
 * The To 100% page groups plan checklist nudges by package, and holds them back
 * until the packages fetch settles: the first paint must not offer a per-plan
 * Fix that the package grouping then replaces (a quick click in that window
 * would set up a checklist the package deliberately leaves out).
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  dismissSetupIssueRequest: vi.fn(),
  fetchDismissedSetupIssues: vi.fn(async () => []),
  listPackagesRequest: vi.fn(),
  restoreSetupIssueRequest: vi.fn(),
}))

import { listPackagesRequest } from '../lib/api'

const mockPackages = vi.mocked(listPackagesRequest)
let contextValue: AppContextValue

const template = (id: string, title: string) => ({
  id,
  title,
  clientId: '',
  assigneeId: '',
  frequency: 'monthly',
  active: true,
  isStandard: true,
  stages: [],
})
const PACKAGE: Package = {
  id: 'pk-1',
  name: 'Quarterly Accounting',
  description: '',
  planIds: ['plan-a', 'plan-b'],
  templateIds: ['t1'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: null,
}

beforeEach(() => {
  const client = {
    id: 'client-1',
    name: 'Acme',
    contact: 'Pat',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: ['plan-a', 'plan-b'],
    contactIds: ['c1'],
    monthlyRate: 1000,
    email: 'pay@acme.test',
    assignedBookkeeperIds: ['emp-1'],
  } as unknown as Client
  const data = {
    clients: [client],
    contacts: [{ id: 'c1', name: 'Pat' }],
    employees: [{ id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: 100 }],
    plans: [
      { id: 'plan-a', name: 'Accounting', notes: '', templateIds: ['t1'] },
      { id: 'plan-b', name: 'Quarterly', notes: '', templateIds: ['t1', 't3'] },
    ],
    checklistTemplates: [template('t1', 'Close'), template('t3', 'Client Meeting')],
    checklists: [],
  } as unknown as AppData
  contextValue = {
    data,
    ownerMode: true,
    updateClient: vi.fn(),
    applyTemplateToClient: vi.fn(),
  } as unknown as AppContextValue
})

const renderPage = () =>
  render(
    <MemoryRouter>
      <SetupChecklistPage />
    </MemoryRouter>,
  )

const openClients = () =>
  fireEvent.click(document.querySelector('#setup-cat-Clients button.setup-cat-header')!)

describe('SetupChecklistPage plan checklist nudges', () => {
  it('shows none before the packages fetch settles, then one per covering package', async () => {
    let resolve!: (rows: Package[]) => void
    mockPackages.mockReturnValue(new Promise<Package[]>((r) => (resolve = r)))
    renderPage()
    // Before the fetch resolves: no plan-checklist nudge (even the Clients tab
    // has nothing to open), so no stale per-plan Fix can be clicked.
    expect(screen.queryByText(/checklists for Acme/)).toBeNull()
    expect(document.getElementById('setup-cat-Clients')).toBeNull()

    await act(async () => {
      resolve([PACKAGE])
    })
    openClients()
    expect(screen.getByText('Set up Quarterly Accounting package checklists for Acme')).toBeTruthy()
    expect(screen.queryByText(/Set up Accounting checklists/)).toBeNull()
    // The covered Quarterly plan bundles Client Meeting, which the package's
    // set leaves out: it nudges for that one on its own (featreq-8bdc5ec5).
    expect(screen.getByText('Set up Quarterly checklists for Acme')).toBeTruthy()
    expect(screen.getAllByText('Client Meeting')).toHaveLength(1)
  })

  it('falls back to one nudge per plan when the packages fetch fails', async () => {
    mockPackages.mockRejectedValue(new Error('down'))
    renderPage()
    await act(async () => {})
    openClients()
    expect(screen.getByText('Set up Accounting checklists for Acme')).toBeTruthy()
  })
})

/**
 * "Link existing" in the To 100% fix dialog (featreq-2b067744): a Not set up
 * checklist the client already has under her own title is linked instead of
 * cloned, and Set them up then copies only what is still missing.
 */
describe('the plan checklists fix dialog offers Link existing', () => {
  it('links her checklist, then sets up only the rest', async () => {
    // One package nudge holding both checklists.
    mockPackages.mockResolvedValue([{ ...PACKAGE, templateIds: ['t1', 't3'] }])
    const updateChecklistTemplate = vi.fn()
    const base = contextValue
    const hers = {
      ...template('h1', 'Monthly Close'),
      clientId: 'client-1',
      isStandard: false,
    }
    const withTemplates = (checklistTemplates: unknown[]) => {
      contextValue = {
        ...base,
        data: { ...base.data, checklistTemplates },
        updateChecklistTemplate,
      } as unknown as AppContextValue
    }
    withTemplates([...base.data.checklistTemplates, hers])
    const view = renderPage()
    await act(async () => {})
    openClients()
    fireEvent.click(screen.getAllByRole('button', { name: 'Fix' })[0])

    fireEvent.click(screen.getByRole('button', { name: 'Link Monthly Close as Close' }))
    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
    const [linkedId, updater] = updateChecklistTemplate.mock.calls[0]
    expect(linkedId).toBe('h1')
    const linked = updater(hers)
    expect(linked.sourceTemplateId).toBe('t1')

    // The workspace now holds the link: Close reads Linked; Set them up copies the rest.
    withTemplates([...base.data.checklistTemplates, linked])
    view.rerender(
      <MemoryRouter>
        <SetupChecklistPage />
      </MemoryRouter>,
    )
    expect(screen.getByText('Linked')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set them up' }))
    })
    const apply = vi.mocked(contextValue.applyTemplateToClient)
    expect(apply.mock.calls.map((call) => call[0])).toEqual(['t3'])
  })
})
