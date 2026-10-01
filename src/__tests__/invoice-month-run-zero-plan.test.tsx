import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * featreq-87b20ed7: a section prints only when the client has something in it.
 *
 * K & A Performance's September draft carries a stored $0.00 plan line beside a
 * $10 recurring expense. The client's copy leaves the plan line off, so the
 * row's "N lines" count (which promises what the client will SEE) must agree
 * with it, while the editor keeps listing EVERY stored line — she may still
 * want to put an amount on the plan line.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const clients = [
  {
    id: 'client-ka',
    name: 'K & A Performance, LLC',
    contact: '',
    billingMode: 'subscription',
    monthlyRate: 0,
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const invoice: PersistedInvoice = {
  id: 'inv-ka',
  clientId: 'client-ka',
  period: '2026-09',
  kind: 'monthly',
  number: 'INV-2026-09-050',
  status: 'draft',
  lineItems: [
    { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 0 },
    { kind: 'recurring', label: 'Recurring: Software', detail: 'monthly', amount: 10 },
  ],
  subtotal: 10,
  total: 10,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: null,
}

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([invoice])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — a $0 monthly service line', () => {
  it('is not counted in the row, because the client never sees it', async () => {
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    const row = (await screen.findByText('INV-2026-09-050')).closest('.invoice-run-main')
    expect(row?.textContent).toMatch(/1 line ·/)
    expect(row?.textContent).not.toMatch(/2 lines/)
  })

  it('is still listed in the editor, so she can put an amount on it', async () => {
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByText('INV-2026-09-050'))

    const amounts = screen.getAllByLabelText('Amount') as HTMLInputElement[]
    expect(amounts).toHaveLength(2)
    expect(amounts.map((input) => Number(input.value))).toEqual([0, 10])
    expect(screen.getAllByDisplayValue('Monthly service').length).toBeGreaterThan(0)
  })
})
