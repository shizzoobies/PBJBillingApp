import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The ad hoc block in the month-run editor.
 *
 * Out-of-scope work is shown apart from scoped work with a per-line decision:
 * invoice it, show the detail at nothing, or leave it off. The risk worth
 * pinning is arithmetic, not layout — splitting the display must not renumber
 * the lines underneath, and the running total on screen has to agree with what
 * the save sends, or she reviews one number and the client receives another.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const invoice: PersistedInvoice = {
  id: 'inv-1',
  clientId: 'client-acme',
  period: '2026-08',
  number: 'INV-2026-08-001',
  status: 'draft',
  lineItems: [
    { kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 200 },
    {
      kind: 'adhoc',
      label: 'Adhoc — Rush 1099 question',
      detail: 'Aug 4, 2026 · Lisa · 0.50h at $100.00/hr',
      amount: 50,
      adhocMode: 'billed',
      adhocAmount: 50,
    },
  ],
  subtotal: 250,
  total: 250,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  createdAt: null,
  updatedAt: null,
}

/** Render the run and open its one invoice's editor. */
async function openEditor() {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

const choice = () => screen.getByLabelText('What to do with this ad hoc work') as HTMLSelectElement
const amounts = () => screen.getAllByLabelText('Amount') as HTMLInputElement[]

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([invoice])
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(invoice)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — the ad hoc block', () => {
  it('sets ad hoc work off under its own heading', async () => {
    await openEditor()
    expect(screen.getByText('Ad hoc — outside scope')).toBeInTheDocument()
  })

  it('offers all three decisions, starting on "Invoice it"', async () => {
    await openEditor()
    expect(choice().value).toBe('billed')
    expect([...choice().options].map((option) => option.value)).toEqual([
      'billed',
      'courtesy',
      'omitted',
    ])
  })

  it('gives a scoped line no such control', async () => {
    await openEditor()
    // One ad hoc line means exactly one control, not one per row.
    expect(screen.getAllByLabelText('What to do with this ad hoc work')).toHaveLength(1)
  })

  it('drops a courtesy line to nothing and takes it out of the running total', async () => {
    await openEditor()
    expect(screen.getByText(/Total \$250\.00/)).toBeInTheDocument()

    fireEvent.change(choice(), { target: { value: 'courtesy' } })

    expect(amounts()[1]).toHaveValue(0)
    expect(screen.getByText(/Total \$200\.00/)).toBeInTheDocument()
  })

  it('gives the amount back when she puts the line on the invoice again', async () => {
    await openEditor()
    fireEvent.change(choice(), { target: { value: 'omitted' } })
    expect(screen.getByText(/Total \$200\.00/)).toBeInTheDocument()

    fireEvent.change(choice(), { target: { value: 'billed' } })

    expect(amounts()[1]).toHaveValue(50)
    expect(screen.getByText(/Total \$250\.00/)).toBeInTheDocument()
  })

  // The client and the server must agree on which field is authoritative for a
  // BILLED line — the server resolves it from `amount` and rewrites the reserve
  // to match, so the editor has to move the reserve when she overtypes. Before
  // this, flipping the mode handed back the rate calculation and threw her
  // number away silently, permanently once saved.
  it('keeps an overtyped amount across a courtesy round trip', async () => {
    await openEditor()
    fireEvent.change(amounts()[1], { target: { value: '150' } })

    fireEvent.change(choice(), { target: { value: 'courtesy' } })
    expect(amounts()[1]).toHaveValue(0)

    fireEvent.change(choice(), { target: { value: 'billed' } })
    expect(amounts()[1]).toHaveValue(150)
    expect(screen.getByText(/Total \$350\.00/)).toBeInTheDocument()
  })

  it('sends the overtyped figure as the reserve, matching what the server stores', async () => {
    await openEditor()
    fireEvent.change(amounts()[1], { target: { value: '150' } })
    fireEvent.change(choice(), { target: { value: 'courtesy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, body] = mockUpdate.mock.calls[0]
    expect(body.lineItems?.[1]).toMatchObject({ amount: 0, adhocAmount: 150 })
  })

  it('shows what a line it is not charging would have come to', async () => {
    await openEditor()
    expect(screen.queryByText(/would be/)).not.toBeInTheDocument()

    fireEvent.change(choice(), { target: { value: 'courtesy' } })

    expect(screen.getByText('would be $50.00')).toBeInTheDocument()
  })

  it('saves the decision against the RIGHT line, in its original position', async () => {
    await openEditor()
    fireEvent.change(choice(), { target: { value: 'omitted' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, body] = mockUpdate.mock.calls[0]
    // The scoped line is untouched and still first; the choice landed on the
    // ad hoc one. Displaying the two apart must not reorder what is stored.
    expect(body.lineItems?.[0]).toMatchObject({ kind: 'hourly', amount: 200 })
    expect(body.lineItems?.[1]).toMatchObject({
      kind: 'adhoc',
      adhocMode: 'omitted',
      amount: 0,
      adhocAmount: 50,
    })
  })

  it('edits the description of the scoped line, not the ad hoc one', async () => {
    await openEditor()
    const labels = screen.getAllByLabelText('Line description') as HTMLInputElement[]
    fireEvent.change(labels[0], { target: { value: 'Billable hours — corrected' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, body] = mockUpdate.mock.calls[0]
    expect(body.lineItems?.[0].label).toBe('Billable hours — corrected')
    expect(body.lineItems?.[1].label).toBe('Adhoc — Rush 1099 question')
  })

  it('shows no ad hoc block on an invoice that has none', async () => {
    mockList.mockResolvedValue([
      { ...invoice, lineItems: [invoice.lineItems[0]], subtotal: 200, total: 200 },
    ])
    await openEditor()
    expect(screen.queryByText('Ad hoc — outside scope')).not.toBeInTheDocument()
  })
})
