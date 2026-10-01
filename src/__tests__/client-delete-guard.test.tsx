import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientDetailPage } from '../pages/ClientDetailPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Client, TimeEntry } from '../lib/types'

/**
 * A client with time logged or invoices cannot be deleted, only made inactive
 * (tracker featreq-27836ea0). The Delete button is offered only for a client
 * with neither; otherwise the page says why, in the sentence the server uses.
 * Time is known from the workspace; invoices are not in it, so the page asks
 * the server for the count (`fetchClientInvoiceCount`).
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchClientInvoiceCount: (...args: unknown[]) => invoiceCount(...args),
  fetchRateVersions: async () => [],
  listPackagesRequest: async () => [],
  listClientNotes: async () => [],
  listClientPendingNotesRequest: async () => [],
  listBilledOnInvoicesRequest: async () => [],
  listClientStatementAccounts: async () => ({ accounts: [], version: '' }),
}))

let invoiceCount = vi.fn()
let contextValue: AppContextValue
const deleteClient = vi.fn()

const TIME_SENTENCE = 'This client has time logged, so it cannot be deleted. Mark it inactive instead.'
const INVOICE_SENTENCE = 'This client has invoices, so it cannot be deleted. Mark it inactive instead.'

const entry = { id: 't1', clientId: 'c1', employeeId: 'emp-1', minutes: 30, date: '2026-09-10' } as unknown as TimeEntry

function renderPage(client: Partial<Client> = {}, timeEntries: TimeEntry[] = []) {
  const record = { id: 'c1', name: 'Acme', ...client } as Client
  contextValue = {
    data: {
      clients: [record],
      employees: [],
      checklists: [],
      checklistTemplates: [],
      recycledChecklists: [],
      timeEntries,
      contacts: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
    } as unknown as AppData,
    ownerMode: true,
    sessionUser: { id: 'emp-owner', role: 'owner', name: 'Owner' },
    dataRefreshCount: 0,
    dataSyncState: 'idle',
    serviceCategories: [],
    updateClient: vi.fn(),
    deleteClient,
    setClientLifecycle: vi.fn(),
    visibleChecklists: [],
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
  } as unknown as AppContextValue
  return render(
    <MemoryRouter initialEntries={['/clients/c1']}>
      <Routes>
        <Route path="/clients/:clientId" element={<ClientDetailPage />} />
        <Route path="/clients" element={<p>Clients list</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  deleteClient.mockClear()
  invoiceCount = vi.fn(async () => 0)
})

describe('Delete client on the client page', () => {
  it('offers no Delete button for a client with time, and says why', async () => {
    renderPage({}, [entry])
    expect(await screen.findByText(TIME_SENTENCE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete client/ })).not.toBeInTheDocument()
    // The way out is right beside it.
    expect(screen.getByRole('button', { name: /Mark inactive/ })).toBeInTheDocument()
    // Time already decides, so the server is not asked about invoices.
    expect(invoiceCount).not.toHaveBeenCalled()
  })

  it('offers no Delete button for a client with only invoices, and says why', async () => {
    invoiceCount = vi.fn(async () => 2)
    renderPage()
    expect(await screen.findByText(INVOICE_SENTENCE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete client/ })).not.toBeInTheDocument()
    expect(invoiceCount).toHaveBeenCalledWith('c1')
  })

  it('shows only the sentence beside Reactivate for a retired client with time', async () => {
    renderPage({ lifecycleStage: 'inactive' }, [entry])
    expect(await screen.findByText(TIME_SENTENCE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete client/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mark inactive/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Reactivate/ }).length).toBeGreaterThan(0)
  })

  it('keeps the button for a client with nothing logged, with a confirm that is true', async () => {
    const confirm = vi.fn(() => false)
    window.confirm = confirm
    renderPage()
    const button = await screen.findByRole('button', { name: /Delete client/ })
    expect(screen.queryByText(TIME_SENTENCE)).not.toBeInTheDocument()
    expect(screen.queryByText(INVOICE_SENTENCE)).not.toBeInTheDocument()

    fireEvent.click(button)
    expect(confirm).toHaveBeenCalledWith(
      'Delete Acme? This permanently removes the client and its checklists, recurring checklists and reimbursements. This cannot be undone.',
    )
    // Declining the confirm deletes nothing.
    expect(deleteClient).not.toHaveBeenCalled()
  })

  it('deletes only after the confirm is accepted', async () => {
    window.confirm = vi.fn(() => true)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Delete client/ }))
    expect(deleteClient).toHaveBeenCalledWith('c1')
  })

  it('does not offer Delete until the invoice answer arrives, or if it never does', async () => {
    invoiceCount = vi.fn(async () => {
      throw new Error('offline')
    })
    renderPage()
    await waitFor(() => expect(invoiceCount).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Delete client/ })).not.toBeInTheDocument()
    expect(screen.queryByText(INVOICE_SENTENCE)).not.toBeInTheDocument()
  })
})
