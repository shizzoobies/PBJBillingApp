import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientsPage } from '../pages/ClientsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Client } from '../lib/types'

/**
 * Brittany, 2026-10-03 (tracker featreq-739f43d1): on the Clients page each
 * row's "Mark inactive" button becomes "Statements", which opens the same
 * Statement dates box the client page shows, so the dates are one click from
 * the list. Retiring now happens only on the client page (the row's stage
 * dropdown never offers Inactive); a retired client, which has no dropdown,
 * keeps Reactivate on the row.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listClientStatementAccountsRequest: (...args: unknown[]) => listAccounts(...args),
}))

let listAccounts = vi.fn()
let contextValue: AppContextValue

const OWNER = 'emp-owner'
const ACTIVE: Client = { id: 'client-a', name: 'Reflect & Renew Therapy', contact: 'Isabella' } as Client
const RETIRED: Client = {
  id: 'client-b',
  name: 'Beacon Dental',
  contact: 'Pat',
  lifecycleStage: 'inactive',
} as Client

const data = {
  clients: [ACTIVE, RETIRED],
  employees: [{ id: OWNER, name: 'Owner', role: 'Owner' }],
  checklists: [],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  contacts: [],
  plans: [],
} as unknown as AppData

function signIn(ownerMode: boolean) {
  contextValue = {
    ownerMode,
    visibleClients: [ACTIVE, RETIRED],
    data,
    activeEmployeeId: OWNER,
    effectiveUser: { staffRole: undefined },
    sessionUser: { id: OWNER, name: 'Owner', role: ownerMode ? 'owner' : 'member' },
    dataRefreshCount: 0,
    updateClientPlan: vi.fn(),
    updateClient: vi.fn(),
    addClient: vi.fn(),
    startOnboarding: vi.fn(),
    applyTemplateToClient: vi.fn(),
    setClientLifecycle: vi.fn(),
  } as unknown as AppContextValue
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/clients']}>
      <ClientsPage />
    </MemoryRouter>,
  )
}

function rowOf(name: string): HTMLElement {
  // The staff page also lists client names in a chip list, so find the table cell.
  const row = screen
    .getAllByText(name)
    .map((el) => el.closest('tr'))
    .find((tr): tr is HTMLTableRowElement => tr !== null)
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

/** The owner list opens on the Active segment; retired clients sit under All. */
function showAllStages() {
  fireEvent.click(screen.getByRole('tab', { name: /^All/ }))
}

beforeEach(() => {
  listAccounts = vi.fn(async () => ({
    accounts: [{ id: 'acct-1', name: 'TD Bank 3922', dayOfMonth: 5 }],
    version: 'v1',
  }))
})

describe('Clients page row: Statements replaces Mark inactive', () => {
  it('owner: every row has Statements and no row has Mark inactive', () => {
    signIn(true)
    renderPage()
    const active = rowOf(ACTIVE.name)
    expect(active.querySelector('button[title^="Statement dates"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Mark inactive/ })).not.toBeInTheDocument()
  })

  it('Statements opens the Statement dates box for that client, with its saved accounts', async () => {
    signIn(true)
    renderPage()
    const button = rowOf(ACTIVE.name).querySelector('button[title^="Statement dates"]')
    if (!button) throw new Error('no Statements button')
    fireEvent.click(button)

    expect(screen.getByText(`Statement dates · ${ACTIVE.name}`)).toBeInTheDocument()
    expect(screen.getByText('Reference only. Nothing else in the app reads these.')).toBeInTheDocument()
    await waitFor(() => expect(listAccounts).toHaveBeenCalledWith(ACTIVE.id))
    expect(await screen.findByDisplayValue('TD Bank 3922')).toBeInTheDocument()
  })

  it('a retired client keeps Reactivate on the row beside Statements (it has no stage dropdown)', () => {
    signIn(true)
    renderPage()
    showAllStages()
    const retired = rowOf(RETIRED.name)
    expect(retired.querySelector('button[title^="Statement dates"]')).not.toBeNull()
    expect(retired.textContent).toContain('Reactivate')
    expect(retired.querySelector('select.stage-override')).toBeNull()
    // The active client has the stage dropdown, which does not offer Inactive
    // (retiring is the client page's job now), and no Reactivate.
    const active = rowOf(ACTIVE.name)
    const dropdown = active.querySelector('select.stage-override')
    expect(dropdown).not.toBeNull()
    const options = Array.from(dropdown?.querySelectorAll('option') ?? []).map((o) => o.value)
    expect(options).toEqual(['proposal', 'onboarding', 'active'])
    expect(active.textContent).not.toContain('Reactivate')
  })

  it('Reactivate on a retired row calls setClientLifecycle(active)', async () => {
    signIn(true)
    renderPage()
    showAllStages()
    const button = Array.from(rowOf(RETIRED.name).querySelectorAll('button')).find((b) =>
      /Reactivate/.test(b.textContent ?? ''),
    )
    if (!button) throw new Error('no Reactivate button')
    fireEvent.click(button)
    await waitFor(() =>
      expect(contextValue.setClientLifecycle).toHaveBeenCalledWith(RETIRED.id, 'active'),
    )
  })

  it('staff see Statements too, and never a Reactivate', () => {
    signIn(false)
    renderPage()
    expect(rowOf(ACTIVE.name).querySelector('button[title^="Statement dates"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Reactivate/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mark inactive/ })).not.toBeInTheDocument()
  })
})
