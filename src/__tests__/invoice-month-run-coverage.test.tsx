import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * "Confirm the covered dates" in the month-run editor.
 *
 * A reimbursed expense whose cycle was skipped — or that was paused and
 * resumed — arrives on the invoice with a PROPOSED window rather than a
 * decided one. What is pinned here is the pair of promises that makes the
 * proposal safe:
 *
 *   1. she cannot mark the invoice reviewed until she has answered, and the
 *      button says why rather than sitting there dead;
 *   2. typing in the date boxes does NOT make the editor dirty — dirty gates
 *      Print, Send and the payment link behind "Save your changes first", and
 *      there is no sense in making her save an invoice in order to answer a
 *      question the invoice is asking her.
 */

vi.mock('../lib/api', () => ({
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  confirmInvoiceCoverageRequest,
  listInvoicesRequest,
  updateInvoiceRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockConfirm = vi.mocked(confirmInvoiceCoverageRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const baseInvoice: PersistedInvoice = {
  id: 'inv-1',
  clientId: 'client-acme',
  period: '2026-11',
  kind: 'monthly',
  number: 'INV-2026-11-001',
  status: 'draft',
  lineItems: [
    { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 500 },
    {
      kind: 'recurring',
      label: 'QuickBooks Online — August 13 – September 13, 2026',
      detail: 'monthly',
      amount: 90,
      recurringId: 'recur-qbo',
      coverageStart: '2026-08-13',
      coverageEnd: '2026-09-13',
      needsCoverageConfirmation: true,
      coverageReason: 'gap',
    },
  ],
  subtotal: 590,
  total: 590,
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

/** The same invoice with the question answered. */
const settledInvoice: PersistedInvoice = {
  ...baseInvoice,
  updatedAt: '2026-12-01T00:00:00.000Z',
  lineItems: [
    baseInvoice.lineItems[0],
    {
      kind: 'recurring',
      label: 'QuickBooks Online — September 13 – October 13, 2026',
      detail: 'monthly',
      amount: 90,
      recurringId: 'recur-qbo',
      coverageStart: '2026-09-13',
      coverageEnd: '2026-10-13',
      needsCoverageConfirmation: false,
    },
  ],
}

async function openEditor(invoice: PersistedInvoice = baseInvoice) {
  mockList.mockResolvedValue([invoice])
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByText('INV-2026-11-001'))
}

const reviewButton = () => screen.getByRole('button', { name: 'Mark reviewed' })
const startBox = () => screen.getByLabelText('Covered period start') as HTMLInputElement
const endBox = () => screen.getByLabelText('Covered period end') as HTMLInputElement

beforeEach(() => {
  mockList.mockReset()
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(baseInvoice)
  mockConfirm.mockReset()
  mockConfirm.mockResolvedValue(settledInvoice)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — confirming the covered dates', () => {
  it('flags the line and says why it is asking', async () => {
    await openEditor()

    expect(screen.getByText('Confirm the covered dates')).toBeInTheDocument()
    expect(
      screen.getByText('A billing cycle was skipped. Confirm the dates this invoice covers.'),
    ).toBeInTheDocument()
    // The proposal is shown, not hidden behind the button.
    expect(startBox().value).toBe('2026-08-13')
    expect(endBox().value).toBe('2026-09-13')
  })

  it('explains a resumed pause differently from a skipped cycle', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [
        baseInvoice.lineItems[0],
        { ...baseInvoice.lineItems[1], coverageReason: 'resumed' },
      ],
    })

    expect(
      screen.getByText('This expense was paused. Confirm the dates this invoice covers.'),
    ).toBeInTheDocument()
  })

  it('explains a month billed behind one already sent', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [
        baseInvoice.lineItems[0],
        { ...baseInvoice.lineItems[1], coverageReason: 'backfill' },
      ],
    })

    expect(
      screen.getByText(
        'This month comes before one already billed. Confirm the dates this invoice covers.',
      ),
    ).toBeInTheDocument()
  })

  it('blocks Mark reviewed, and the button says what is missing', async () => {
    await openEditor()

    expect(reviewButton()).toBeDisabled()
    expect(reviewButton()).toHaveAttribute('title', 'Confirm the covered dates above first')
  })

  it('offers Mark reviewed once nothing is left to answer', async () => {
    await openEditor(settledInvoice)

    expect(screen.queryByText('Confirm the covered dates')).not.toBeInTheDocument()
    expect(reviewButton()).not.toBeDisabled()
  })

  // Dirty gates Print / Send / payment link behind "Save your changes first".
  // Answering the invoice's own question must not trip that.
  it('does not make the editor dirty while she edits the dates', async () => {
    await openEditor()
    expect(screen.getByText('Total $590.00')).toBeInTheDocument()

    fireEvent.change(endBox(), { target: { value: '2026-10-13' } })

    expect(endBox().value).toBe('2026-10-13')
    // No "· unsaved", and Save stays disabled — nothing about the LINES moved.
    expect(screen.getByText('Total $590.00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('sends the dates she typed, not the ones proposed', async () => {
    await openEditor()

    fireEvent.change(startBox(), { target: { value: '2026-09-13' } })
    fireEvent.change(endBox(), { target: { value: '2026-10-13' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm dates' }))

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith('inv-1', 'recur-qbo', {
        coverageStart: '2026-09-13',
        coverageEnd: '2026-10-13',
      })
    })
  })

  it('accepts the proposal untouched when she just presses the button', async () => {
    await openEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm dates' }))

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith('inv-1', 'recur-qbo', {
        coverageStart: '2026-08-13',
        coverageEnd: '2026-09-13',
      })
    })
  })

  // The confirm is its own endpoint precisely because it writes the expense's
  // ledger too. It must never be folded into the ordinary line save.
  it('does not save the invoice as a side effect of confirming', async () => {
    await openEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm dates' }))

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('says so, beside the lines, when the server refuses', async () => {
    mockConfirm.mockRejectedValue(new Error('Covered dates must look like 2026-08-13.'))
    await openEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm dates' }))

    expect(
      await screen.findByText('Covered dates must look like 2026-08-13.'),
    ).toBeInTheDocument()
    // Still blocked — a refused confirm is not an answer.
    expect(reviewButton()).toBeDisabled()
  })
})
