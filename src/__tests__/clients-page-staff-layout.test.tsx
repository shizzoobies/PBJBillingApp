/**
 * Layout fix pass (branch fix/layout-1200), item 1: at a 1200px laptop window
 * the staff (!ownerMode) Clients page used to put the client list and the
 * "Visible work" panel side by side in `.two-column` — the panel took ~45% of
 * the content width, squeezing the table until its Actions column (Checklist
 * / Time / Note) scrolled out of view.
 *
 * The fix: the staff branch renders `.content-grid.client-scope-layout`
 * (single column, see App.css), with the list panel first and the
 * VisibilityPanel ("Visible work") below it in the same section — not a
 * pixel check, just that the wrapper class changed and the DOM order still
 * puts the list first.
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ClientsPage } from '../pages/ClientsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Client } from '../lib/types'

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const STAFF = 'emp-brit'
const CLIENT_A: Client = { id: 'client-a', name: 'Acme Bakery', contact: 'Jo' } as Client
const CLIENT_B: Client = { id: 'client-b', name: 'Beacon Dental', contact: 'Pat' } as Client

const data = {
  clients: [CLIENT_A, CLIENT_B],
  employees: [{ id: STAFF, name: 'Brittany Fox', role: 'Bookkeeper' }],
  checklists: [],
  checklistTemplates: [],
  plans: [],
} as unknown as AppData

let contextValue: AppContextValue

function signInAsStaff() {
  contextValue = {
    ownerMode: false,
    visibleClients: [CLIENT_A, CLIENT_B],
    data,
    activeEmployeeId: STAFF,
    effectiveUser: { staffRole: undefined },
    sessionUser: { id: STAFF, name: 'Brittany Fox' },
    updateClientPlan: vi.fn(),
    updateClient: vi.fn(),
    addClient: vi.fn(),
    startOnboarding: vi.fn(),
    applyTemplateToClient: vi.fn(),
    setClientLifecycle: vi.fn(),
  } as unknown as AppContextValue
}

describe('ClientsPage — staff (!ownerMode) branch layout', () => {
  it('renders the single-column client-scope-layout wrapper, not two-column', () => {
    signInAsStaff()
    const { container } = render(
      <MemoryRouter>
        <ClientsPage />
      </MemoryRouter>,
    )

    const section = container.querySelector('#clients')
    expect(section).not.toBeNull()
    expect(section?.classList.contains('client-scope-layout')).toBe(true)
    expect(section?.classList.contains('two-column')).toBe(false)
  })

  it('puts the list panel before the "Visible work" panel in the DOM', () => {
    signInAsStaff()
    const { container } = render(
      <MemoryRouter>
        <ClientsPage />
      </MemoryRouter>,
    )

    const headings = [...container.querySelectorAll('#clients h2')].map((h) => h.textContent)
    expect(headings).toEqual(['Clients', 'Visible work'])
  })
})
