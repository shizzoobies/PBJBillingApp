import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The billed-hours field on an hourly line — featreq-cfb1536a, her ask
 * verbatim: "I would like the hours seperate so if I want to round more I can
 * and then the amount just auto calculates changes."
 *
 * So: the hours are their own input, the amount is derived and refuses typing,
 * and editing the hours rewrites the detail text so the printed document says
 * the hours she chose. The server re-derives the amount again on save
 * (db/store-staleness.test.mjs) — this file pins the editor half.
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

import { listInvoicesRequest, listUnappliedRetainersRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 125,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const invoice: PersistedInvoice = {
  id: 'inv-1',
  clientId: 'client-acme',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-2026-08-001',
  status: 'draft',
  lineItems: [
    {
      kind: 'hourly',
      label: 'Billable hours — Lisa',
      detail: '1.31h at $75.00/hr',
      hours: 1.31,
      rate: 75,
      amount: 98.25,
    },
    // A legacy line from before the rule — no hours field, amount editable.
    { kind: 'custom', label: 'Setup fee', detail: '', amount: 50 },
  ],
  subtotal: 148.25,
  total: 148.25,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: null,
} as PersistedInvoice

async function openEditor() {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
  await waitFor(() => expect(screen.getByLabelText('Billed hours')).toBeInTheDocument())
}

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([invoice])
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(invoice)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the billed-hours field', () => {
  it('renders the hours as their own input, with the rate standing beside them', async () => {
    await openEditor()
    expect(screen.getByLabelText('Billed hours')).toHaveValue(1.31)
    expect(screen.getByText('× $75.00/hr')).toBeInTheDocument()
  })

  it('recalculates the amount when she rounds the hours up', async () => {
    await openEditor()
    fireEvent.change(screen.getByLabelText('Billed hours'), { target: { value: '1.5' } })
    // 1.5 × 75 = 112.50 — the amount followed without being touched.
    const amounts = screen.getAllByLabelText('Amount') as HTMLInputElement[]
    expect(amounts[0].value).toBe('112.5')
    // The running total moved with it: 112.50 + 50.
    expect(screen.getByText(/^Total \$162\.50/)).toBeInTheDocument()
  })

  it('rewrites the detail so the printed document says the hours she typed', async () => {
    await openEditor()
    fireEvent.change(screen.getByLabelText('Billed hours'), { target: { value: '1.5' } })
    expect(screen.getByDisplayValue('1.50h at $75.00/hr')).toBeInTheDocument()
  })

  it('the derived amount refuses typing; a legacy line’s stays editable', async () => {
    await openEditor()
    const amounts = screen.getAllByLabelText('Amount') as HTMLInputElement[]
    expect(amounts[0].readOnly).toBe(true) // hourly, hours-carrying
    expect(amounts[1].readOnly).toBe(false) // the custom line
  })

  it('sends hours, rate and the derived amount on save', async () => {
    await openEditor()
    fireEvent.change(screen.getByLabelText('Billed hours'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const sent = mockUpdate.mock.calls[0][1].lineItems!.find((line) => line.kind === 'hourly')!
    expect(sent.hours).toBe(1.5)
    expect(sent.rate).toBe(75)
    expect(sent.amount).toBe(112.5)
  })
})
