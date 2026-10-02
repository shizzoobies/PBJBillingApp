import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * A payment notification links to `/invoices?period=2026-03` (featreq-c8e5f169):
 * the page reads the month it was opened on and moves the month run to it, then
 * tells its caller it has done so (the router drops the query). A bare
 * `/invoices` would land on the current month - the wrong one for last month's
 * invoice. The guarded move is the month picker's own (an open editor with
 * unsaved edits asks first), covered with the run in invoices-page-view-switch.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

const client = {
  id: 'client-acme',
  name: 'Acme',
  contact: '',
  billingMode: 'hourly',
  hourlyRate: 100,
  planIds: [],
  contactIds: [],
} as unknown as Client

const state = vi.hoisted(() => ({ clients: [] as unknown[] }))

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: state.clients,
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: 'client-acme',
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-08',
    printInvoice: vi.fn(),
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const marchInvoice = {
  id: 'inv-march',
  clientId: 'client-acme',
  period: '2026-03',
  kind: 'monthly',
  number: 'INV-2026-03-007',
  status: 'sent',
  lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 250 }],
  subtotal: 250,
  total: 250,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: '2026-03-20T00:00:00.000Z',
  paidAt: null,
  paymentMethod: null,
  emailLog: [],
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: null,
} as PersistedInvoice

beforeEach(() => {
  state.clients = [client]
  mockList.mockReset()
  mockList.mockImplementation(async (period?: string) => (period === '2026-03' ? [marchInvoice] : []))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Invoices page opened on a month', () => {
  it('moves the month run to the requested month and says it has handled the link', async () => {
    const handled = vi.fn()
    render(<InvoicesPage openPeriod="2026-03" onOpenPeriodHandled={handled} />)

    await waitFor(() => expect(mockList).toHaveBeenCalledWith('2026-03'))
    expect(screen.getByLabelText('Billing month')).toHaveValue('2026-03')
    expect(handled).toHaveBeenCalledTimes(1)
  })

  it('ignores a month that is not YYYY-MM, but still clears the link', async () => {
    const handled = vi.fn()
    render(<InvoicesPage openPeriod="soon" onOpenPeriodHandled={handled} />)

    await waitFor(() => expect(handled).toHaveBeenCalledTimes(1))
    expect(mockList).not.toHaveBeenCalledWith('soon')
    expect(mockList).not.toHaveBeenCalledWith('2026-03')
  })

  it('does nothing without a month (the plain /invoices link)', async () => {
    const handled = vi.fn()
    render(<InvoicesPage onOpenPeriodHandled={handled} />)

    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(handled).not.toHaveBeenCalled()
    expect(mockList).not.toHaveBeenCalledWith('2026-03')
  })
})

// A link opened in a fresh tab arrives BEFORE the app's data has loaded, and the
// page renders nothing until it has: the request must be held until the month run
// exists, and only cleared from the URL after it has been acted on.
describe('a cold load (the page has no data yet)', () => {
  it('holds the month until the run is mounted, then shows it and only then clears the link', async () => {
    state.clients = []
    const handled = vi.fn()
    const { rerender } = render(<InvoicesPage openPeriod="2026-03" onOpenPeriodHandled={handled} />)

    // Nothing rendered, nothing cleared, nothing fetched for that month.
    expect(screen.queryByLabelText('Billing month')).not.toBeInTheDocument()
    expect(handled).not.toHaveBeenCalled()

    state.clients = [client]
    rerender(<InvoicesPage openPeriod="2026-03" onOpenPeriodHandled={handled} />)

    await waitFor(() => expect(mockList).toHaveBeenCalledWith('2026-03'))
    expect(screen.getByLabelText('Billing month')).toHaveValue('2026-03')
    expect(handled).toHaveBeenCalledTimes(1)
  })
})
