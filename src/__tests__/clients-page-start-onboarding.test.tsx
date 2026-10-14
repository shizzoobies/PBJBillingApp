import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientsPage } from '../pages/ClientsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Client } from '../lib/types'

/**
 * Engagements leftovers 10 [33]: "Start onboarding" is for a client with no onboarding
 * case. Signing a prospect's letter opens one (the client lands in Onboarding with its
 * case), and the server opens only one case per client, so the button is not offered to
 * a client that has one - from the template or from a live stage checklist.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

let contextValue: AppContextValue

const OWNER = 'emp-owner'
const FRESH = { id: 'client-fresh', name: 'Fresh Prospect', lifecycleStage: 'proposal' } as Client
const SIGNED = { id: 'client-signed', name: 'Signed Newcomer', lifecycleStage: 'onboarding' } as Client
const STARTED = { id: 'client-started', name: 'Started Before', lifecycleStage: 'proposal' } as Client

function signIn(data: Partial<AppData>) {
  const all = {
    clients: [FRESH, SIGNED, STARTED],
    employees: [{ id: OWNER, name: 'Owner', role: 'Owner' }],
    checklists: [],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    contacts: [],
    plans: [],
    ...data,
  } as unknown as AppData
  contextValue = {
    ownerMode: true,
    visibleClients: all.clients,
    data: all,
    activeEmployeeId: OWNER,
    effectiveUser: { staffRole: undefined },
    sessionUser: { id: OWNER, name: 'Owner', role: 'owner' },
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
  render(
    <MemoryRouter initialEntries={['/clients']}>
      <ClientsPage />
    </MemoryRouter>,
  )
  // The owner list opens on the Active segment; these clients are not active yet.
  fireEvent.click(screen.getByRole('tab', { name: /^All/ }))
}

function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByText(name)
    .map((el) => el.closest('tr'))
    .find((tr): tr is HTMLTableRowElement => tr !== null)
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

const startButton = (name: string) => rowOf(name).querySelector('button[title^="Create the 3-stage onboarding"]')

beforeEach(() => {
  signIn({})
})

describe('Start onboarding on the Clients page', () => {
  it('is offered to a client that has no onboarding case', () => {
    renderPage()
    expect(startButton(FRESH.name)).not.toBeNull()
    expect(startButton(SIGNED.name)).not.toBeNull()
    expect(startButton(STARTED.name)).not.toBeNull()
  })

  it('is not offered to a client whose case exists as a template or as a live stage checklist', () => {
    signIn({
      checklistTemplates: [{ id: 'template-1', title: 'Onboarding', onboardingForClientId: SIGNED.id }],
      checklists: [{ id: 'check-1', title: 'Onboarding stage', clientId: STARTED.id, onboardingForClientId: STARTED.id, items: [] }],
    } as unknown as Partial<AppData>)
    renderPage()
    expect(startButton(FRESH.name)).not.toBeNull()
    expect(startButton(SIGNED.name)).toBeNull()
    expect(startButton(STARTED.name)).toBeNull()
  })
})
