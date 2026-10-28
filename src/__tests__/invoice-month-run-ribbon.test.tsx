import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The month run's top ribbon (featreq-ea4a68cd): Month total, Service total,
 * Reimburse total, Clients invoiced, Clients not invoiced - once invoices have
 * gone out. The status counts moved to the tabs only.
 */

vi.mock('../lib/api', () => ({
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

const client = (id: string, name: string, over: Partial<Client> = {}) =>
  ({
    id,
    name,
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 100,
    planIds: [],
    contactIds: [],
    ...over,
  }) as unknown as Client

const clients = [
  client('client-acme', 'Acme'),
  client('client-bolt', 'Bolt'),
  client('client-cedar', 'Cedar'),
  client('client-dune', 'Dune'),
]

const invoice = (id: string, clientId: string, over: Partial<PersistedInvoice> = {}) =>
  ({
    id,
    clientId,
    period: '2026-08',
    kind: 'monthly',
    number: `INV-${id}`,
    status: 'sent',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-20T00:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    emailLog: [],
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  }) as PersistedInvoice

const stat = (label: string) => {
  const span = screen.getByText(label, { selector: '.invoice-run-stat span' })
  return span.closest('.invoice-run-stat') as HTMLElement
}

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
})

describe('the month run ribbon', () => {
  it('totals what has gone out, splits reimbursements, and names who is left', async () => {
    mockList.mockResolvedValue([
      invoice('1', 'client-acme', {
        total: 500,
        lineItems: [
          { kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 },
          { kind: 'reimbursement', label: 'Filing fee', detail: '', amount: 100 },
        ],
      } as Partial<PersistedInvoice>),
      invoice('2', 'client-bolt', { status: 'paid', total: 400 }),
      // A draft has not gone out: it is in no total, and its client is still left.
      invoice('3', 'client-cedar', { status: 'draft', total: 9999 }),
    ])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    await waitFor(() => expect(within(stat('Month total')).getByText('$900.00')).toBeInTheDocument())
    expect(within(stat('Service total')).getByText('$800.00')).toBeInTheDocument()
    expect(within(stat('Reimburse total')).getByText('$100.00')).toBeInTheDocument()
    expect(within(stat('Clients invoiced')).getByText('2')).toBeInTheDocument()
    const left = stat('Clients not invoiced')
    expect(within(left).getByText('2')).toBeInTheDocument()
    expect(within(left).getByText('Cedar')).toBeInTheDocument()
    expect(within(left).getByText('Dune')).toBeInTheDocument()
  })

  it('shows dashes, not $0.00 or the whole roster, while the month is loading', async () => {
    mockList.mockReturnValue(new Promise(() => {}))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    for (const label of [
      'Month total',
      'Service total',
      'Reimburse total',
      'Clients invoiced',
      'Clients not invoiced',
    ]) {
      expect(within(stat(label)).getByText('—')).toBeInTheDocument()
    }
    expect(screen.queryByText('Who')).not.toBeInTheDocument()
    expect(screen.queryByText('Acme')).not.toBeInTheDocument()
  })

  it('shows dashes when the month could not be loaded', async () => {
    mockList.mockRejectedValue(new Error('boom'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
    expect(within(stat('Month total')).getByText('—')).toBeInTheDocument()
    expect(within(stat('Clients not invoiced')).getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('Who')).not.toBeInTheDocument()
  })

  it('says what "not invoiced" includes', async () => {
    mockList.mockResolvedValue([invoice('1', 'client-acme')])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(within(stat('Clients invoiced')).getByText('1')).toBeInTheDocument())
    expect(stat('Clients not invoiced')).toHaveTextContent(/including any with nothing to bill/)
  })

  it('no longer carries the status counts in the strip', async () => {
    mockList.mockResolvedValue([invoice('1', 'client-acme', { status: 'draft' })])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(stat('Month total')).toBeInTheDocument())
    for (const label of ['To review', 'Reviewed', 'Need a look', 'Past due']) {
      expect(
        screen.queryByText(label, { selector: '.invoice-run-stat span' }),
      ).not.toBeInTheDocument()
    }
    // They live on the tabs.
    expect(screen.getByRole('tab', { name: /^To review/ })).toBeInTheDocument()
  })
})
