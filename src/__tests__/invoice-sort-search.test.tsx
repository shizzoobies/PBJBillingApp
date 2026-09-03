import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceHistory } from '../components/InvoiceHistory'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * Sorting + search across the invoicing areas (featreq-a1e61913). Her rule,
 * verbatim: "When no sort is actively applied, keep the list ordered
 * alphabetically as the default." So the month run's tabs and History's month
 * tables open client-A–Z — which deliberately supersedes the invoice-number
 * default the run launched with — and both areas gain a search box matching
 * client name or invoice number.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, listUnappliedRetainersRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)

const clients = [
  { id: 'client-z', name: 'Zebra Co', contact: '', billingMode: 'hourly', hourlyRate: 0, planIds: [], contactIds: [] },
  { id: 'client-a', name: 'Acme', contact: '', billingMode: 'hourly', hourlyRate: 0, planIds: [], contactIds: [] },
] as unknown as Client[]

function makeInvoice(overrides: Partial<PersistedInvoice>): PersistedInvoice {
  return {
    id: 'inv-x',
    clientId: 'client-a',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'sent',
    lineItems: [],
    subtotal: 0,
    total: 100,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-20T00:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as PersistedInvoice
}

// Zebra holds the LOWER invoice number, so number order and client order
// disagree — which is what makes the default observable.
const monthInvoices = [
  makeInvoice({ id: 'inv-z', clientId: 'client-z', number: 'INV-2026-08-001', total: 50 }),
  makeInvoice({ id: 'inv-a', clientId: 'client-a', number: 'INV-2026-08-002', total: 900 }),
]

const rowTexts = () =>
  screen.getAllByText(/INV-2026-08-\d+/).map((node) => node.textContent ?? '')

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the month run — sort and search', () => {
  it('opens alphabetical by client, not invoice-number order', async () => {
    mockList.mockResolvedValue(monthInvoices)
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Sent/ }))
    await waitFor(() => expect(rowTexts()).toHaveLength(2))
    // Acme (…-002) before Zebra (…-001): client A–Z, not number order.
    expect(rowTexts()).toEqual(['INV-2026-08-002', 'INV-2026-08-001'])
  })

  it('sorting by invoice number restores number order', async () => {
    mockList.mockResolvedValue(monthInvoices)
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Sent/ }))
    await waitFor(() => expect(rowTexts()).toHaveLength(2))
    fireEvent.change(screen.getByLabelText(/Sort/), { target: { value: 'number' } })
    expect(rowTexts()).toEqual(['INV-2026-08-001', 'INV-2026-08-002'])
  })

  it('search narrows the tabs by client name or invoice number', async () => {
    mockList.mockResolvedValue(monthInvoices)
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Sent/ }))
    await waitFor(() => expect(rowTexts()).toHaveLength(2))

    const box = screen.getByRole('searchbox', { name: /Search by client or invoice number/ })
    fireEvent.change(box, { target: { value: 'zebra' } })
    expect(rowTexts()).toEqual(['INV-2026-08-001'])

    fireEvent.change(box, { target: { value: '08-002' } })
    expect(rowTexts()).toEqual(['INV-2026-08-002'])
  })

  it('the month stats stay whole-month while a search narrows the list', async () => {
    mockList.mockResolvedValue(monthInvoices)
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Sent/ }))
    await waitFor(() => expect(rowTexts()).toHaveLength(2))
    fireEvent.change(
      screen.getByRole('searchbox', { name: /Search by client or invoice number/ }),
      { target: { value: 'zebra' } },
    )
    // $50 + $900 — the strip describes the month, not the search.
    expect(screen.getByText('$950.00')).toBeInTheDocument()
  })

  it('the OPEN editor row is exempt from the filter — unsaved edits cannot be unmounted by typing', async () => {
    mockList.mockResolvedValue(monthInvoices)
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Sent/ }))
    await waitFor(() => expect(rowTexts()).toHaveLength(2))
    // Open Zebra's editor, then search for Acme: Zebra's row must survive.
    fireEvent.click(screen.getByText('INV-2026-08-001'))
    fireEvent.change(
      screen.getByRole('searchbox', { name: /Search by client or invoice number/ }),
      { target: { value: 'acme' } },
    )
    expect(rowTexts()).toContain('INV-2026-08-001')
  })
})

describe('History — sort default and search', () => {
  const historyInvoices = [
    makeInvoice({ id: 'h-z', clientId: 'client-z', number: 'INV-2026-08-001', status: 'paid' }),
    makeInvoice({ id: 'h-a', clientId: 'client-a', number: 'INV-2026-08-002' }),
  ]

  it('opens months alphabetical by client, and search narrows the archive', async () => {
    mockList.mockResolvedValue(historyInvoices)
    render(<InvoiceHistory clients={clients} onOpenMonth={vi.fn()} onPrint={vi.fn()} />)
    const august = await screen.findByRole('button', { name: /August 2026/ })
    fireEvent.click(august)

    const table = screen.getByRole('table')
    let rows = within(table).getAllByText(/INV-2026-08-\d+/).map((n) => n.textContent)
    // Acme before Zebra — client A–Z default, though Zebra holds the lower number.
    expect(rows).toEqual(['INV-2026-08-002', 'INV-2026-08-001'])

    fireEvent.change(
      screen.getByRole('searchbox', { name: /Search by client or invoice number/ }),
      { target: { value: 'zebra' } },
    )
    rows = screen.getAllByText(/INV-2026-08-\d+/).map((n) => n.textContent)
    expect(rows).toEqual(['INV-2026-08-001'])
  })
})
