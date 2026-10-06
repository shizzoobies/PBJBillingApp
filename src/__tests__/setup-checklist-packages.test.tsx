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
    expect(screen.queryByText(/Set up Quarterly checklists/)).toBeNull()
    expect(screen.queryByText('Client Meeting')).toBeNull()
  })

  it('falls back to one nudge per plan when the packages fetch fails', async () => {
    mockPackages.mockRejectedValue(new Error('down'))
    renderPage()
    await act(async () => {})
    openClients()
    expect(screen.getByText('Set up Accounting checklists for Acme')).toBeTruthy()
  })
})
