import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * "Change covered dates" on a line nobody flagged.
 *
 * The first invoice for a recurring expense carries the dates typed at setup,
 * so nothing is flagged — and by the time she sees them the ledger already
 * holds that month, so editing the expense changes nothing. The month-run
 * editor therefore offers a quiet, collapsed control on any recurring line
 * that carries a window, on any invoice still open to change.
 *
 * What is pinned: it is quiet (no warning block, no gate on Mark reviewed), it
 * only saves a real change, it goes through the same confirm request the
 * flagged block uses, and it is absent where the invoice is a record.
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
  period: '2026-09',
  kind: 'monthly',
  number: 'INV-2026-09-001',
  status: 'draft',
  lineItems: [
    { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 500 },
    {
      kind: 'recurring',
      label: 'QuickBooks Ledger — September 13 – October 13, 2026',
      detail: 'monthly',
      amount: 90,
      recurringId: 'recur-qbo',
      coverageStart: '2026-09-13',
      coverageEnd: '2026-10-13',
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

/** The same invoice after the window moved a cycle. */
const movedInvoice: PersistedInvoice = {
  ...baseInvoice,
  updatedAt: '2026-10-01T00:00:00.000Z',
  lineItems: [
    baseInvoice.lineItems[0],
    {
      ...baseInvoice.lineItems[1],
      label: 'QuickBooks Ledger — October 13 – November 13, 2026',
      coverageStart: '2026-10-13',
      coverageEnd: '2026-11-13',
    },
  ],
}

async function openEditor(
  invoice: PersistedInvoice = baseInvoice,
  props: { previewMode?: boolean } = {},
  tab?: RegExp,
) {
  mockList.mockResolvedValue([invoice])
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} {...props} />)
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText('INV-2026-09-001'))
}

const changeButton = () => screen.getByRole('button', { name: 'Change covered dates' })
const saveButton = () => screen.getByRole('button', { name: 'Save dates' })
const reviewButton = () => screen.getByRole('button', { name: 'Mark reviewed' })
const startBox = () => screen.getByLabelText('Covered period start') as HTMLInputElement
const endBox = () => screen.getByLabelText('Covered period end') as HTMLInputElement

beforeEach(() => {
  mockList.mockReset()
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(baseInvoice)
  mockConfirm.mockReset()
  mockConfirm.mockResolvedValue(movedInvoice)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — changing the covered dates on an unflagged line', () => {
  it('offers a collapsed control and none of the warning block', async () => {
    await openEditor()

    expect(changeButton()).toBeInTheDocument()
    expect(screen.queryByText('Confirm the covered dates')).not.toBeInTheDocument()
    expect(screen.queryByText('Next month continues from the end date.')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Covered period start')).not.toBeInTheDocument()
    expect(document.querySelector('.invoice-run-line-unconfirmed')).toBeNull()
  })

  it('reveals the line\'s own dates and the one line of help', async () => {
    await openEditor()

    fireEvent.click(changeButton())

    expect(startBox().value).toBe('2026-09-13')
    expect(endBox().value).toBe('2026-10-13')
    expect(screen.getByText('Next month continues from the end date.')).toBeInTheDocument()
    expect(screen.queryByText('Confirm the covered dates')).not.toBeInTheDocument()
    expect(document.querySelector('.invoice-run-line-unconfirmed')).toBeNull()
  })

  it('keeps Save dates off until a date really changes', async () => {
    await openEditor()
    fireEvent.click(changeButton())

    expect(saveButton()).toBeDisabled()

    fireEvent.change(endBox(), { target: { value: '2026-10-14' } })
    expect(saveButton()).not.toBeDisabled()

    // Typed back to what it was: nothing to save.
    fireEvent.change(endBox(), { target: { value: '2026-10-13' } })
    expect(saveButton()).toBeDisabled()
  })

  it('refuses an end that is not after the start, and an emptied date', async () => {
    await openEditor()
    fireEvent.click(changeButton())

    fireEvent.change(startBox(), { target: { value: '2026-10-13' } })
    // Start now equals the end.
    expect(saveButton()).toBeDisabled()

    fireEvent.change(startBox(), { target: { value: '2026-10-20' } })
    expect(saveButton()).toBeDisabled()

    fireEvent.change(startBox(), { target: { value: '' } })
    expect(saveButton()).toBeDisabled()

    fireEvent.change(startBox(), { target: { value: '2026-10-13' } })
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })
    expect(saveButton()).not.toBeDisabled()
  })

  it('sends the dates she typed and shows the server\'s new label and dates', async () => {
    await openEditor()
    expect(
      screen.getByDisplayValue('QuickBooks Ledger — September 13 – October 13, 2026'),
    ).toBeInTheDocument()
    fireEvent.click(changeButton())

    fireEvent.change(startBox(), { target: { value: '2026-10-13' } })
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })
    fireEvent.click(saveButton())

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith('inv-1', 'recur-qbo', {
        coverageStart: '2026-10-13',
        coverageEnd: '2026-11-13',
      })
    })
    expect(
      await screen.findByDisplayValue('QuickBooks Ledger — October 13 – November 13, 2026'),
    ).toBeInTheDocument()
    // Collapsed again, with the invoice's own dates behind it.
    expect(screen.queryByLabelText('Covered period start')).not.toBeInTheDocument()
    fireEvent.click(changeButton())
    expect(startBox().value).toBe('2026-10-13')
    expect(endBox().value).toBe('2026-11-13')
    // It is its own endpoint; the ordinary line save is not involved.
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('says so, and stays open with her edit, when the server refuses', async () => {
    mockConfirm.mockRejectedValue(new Error('The end of the covered period must come after its start.'))
    await openEditor()
    fireEvent.click(changeButton())
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })

    fireEvent.click(saveButton())

    expect(
      await screen.findByText('The end of the covered period must come after its start.'),
    ).toBeInTheDocument()
    expect(endBox().value).toBe('2026-11-13')
    expect(saveButton()).not.toBeDisabled()
  })

  it('Cancel collapses the boxes and discards the unsaved edit', async () => {
    await openEditor()
    fireEvent.click(changeButton())
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByLabelText('Covered period end')).not.toBeInTheDocument()
    expect(mockConfirm).not.toHaveBeenCalled()
    fireEvent.click(changeButton())
    expect(endBox().value).toBe('2026-10-13')
  })

  it('does not gate Mark reviewed', async () => {
    await openEditor()

    expect(reviewButton()).not.toBeDisabled()

    // Not even with the boxes open and an edit half typed.
    fireEvent.click(changeButton())
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })
    expect(reviewButton()).not.toBeDisabled()
  })

  it('leaves a flagged line exactly as it was, and it still gates', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [
        baseInvoice.lineItems[0],
        {
          ...baseInvoice.lineItems[1],
          needsCoverageConfirmation: true,
          coverageReason: 'gap',
        },
      ],
    })

    expect(screen.getByText('Confirm the covered dates')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm dates' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change covered dates' })).not.toBeInTheDocument()
    expect(screen.queryByText('Next month continues from the end date.')).not.toBeInTheDocument()
    expect(document.querySelector('.invoice-run-line-unconfirmed')).not.toBeNull()
    expect(reviewButton()).toBeDisabled()
  })

  it('offers no control on a paid invoice', async () => {
    await openEditor({ ...baseInvoice, status: 'paid', paidAt: '2026-10-05T00:00:00.000Z' }, {}, /Paid/)

    expect(screen.queryByRole('button', { name: 'Change covered dates' })).not.toBeInTheDocument()
  })

  it('offers no control on a void invoice', async () => {
    await openEditor({ ...baseInvoice, status: 'void' }, {}, /Void/)

    expect(screen.queryByRole('button', { name: 'Change covered dates' })).not.toBeInTheDocument()
  })

  it('does offer it on a sent invoice that is not yet paid', async () => {
    await openEditor({ ...baseInvoice, status: 'sent', sentAt: '2026-10-02T00:00:00.000Z' }, {}, /Sent/)

    expect(changeButton()).toBeInTheDocument()
  })

  it('offers no control on a recurring line that carries no window', async () => {
    const { coverageStart, coverageEnd, ...windowless } = baseInvoice.lineItems[1]
    void coverageStart
    void coverageEnd
    await openEditor({ ...baseInvoice, lineItems: [baseInvoice.lineItems[0], windowless] })

    expect(screen.queryByRole('button', { name: 'Change covered dates' })).not.toBeInTheDocument()
  })

  it('is disabled with a reason while previewing as someone', async () => {
    await openEditor(baseInvoice, { previewMode: true })

    expect(changeButton()).toBeDisabled()
    expect(changeButton()).toHaveAttribute('title', 'Disabled in preview mode')
  })

  // A greyed-out Save dates with the reason only on hover looks broken.
  it('says why Save dates is off, in words, while her other changes are unsaved', async () => {
    await openEditor(baseInvoice)
    fireEvent.click(changeButton())
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })
    expect(saveButton()).not.toBeDisabled()
    expect(screen.queryByText('Save your other changes first')).not.toBeInTheDocument()

    fireEvent.change(screen.getAllByLabelText('Line description')[0], {
      target: { value: 'A label she is still typing' },
    })

    expect(screen.getByText('Save your other changes first')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  // Two expenses on one invoice: only one panel is open at a time, and the
  // dates typed into the one that closed do not come back later.
  it('opening another line\'s panel discards the dates typed into the first', async () => {
    const second = {
      ...baseInvoice.lineItems[1],
      label: 'Payroll Service — September 13 – October 13, 2026',
      recurringId: 'recur-payroll',
    }
    await openEditor({ ...baseInvoice, lineItems: [...baseInvoice.lineItems, second] })

    fireEvent.click(screen.getAllByRole('button', { name: 'Change covered dates' })[0])
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })

    // The second line's button is the only one left; its panel replaces the first.
    fireEvent.click(screen.getByRole('button', { name: 'Change covered dates' }))
    expect(endBox().value).toBe('2026-10-13')
    expect(screen.getAllByLabelText('Covered period end')).toHaveLength(1)

    // Back to the first: its boxes open on the line's own dates, not the stale typing.
    fireEvent.click(screen.getByRole('button', { name: 'Change covered dates' }))
    expect(endBox().value).toBe('2026-10-13')
  })

  it('locks the line inputs while the dates are being saved', async () => {
    let finish: (invoice: PersistedInvoice) => void = () => {}
    mockConfirm.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    await openEditor(baseInvoice)
    fireEvent.click(changeButton())
    fireEvent.change(endBox(), { target: { value: '2026-11-13' } })

    fireEvent.click(saveButton())

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled())
    for (const box of screen.getAllByLabelText('Line description')) {
      expect(box).toHaveAttribute('readonly')
    }

    finish(movedInvoice)
    expect(
      await screen.findByDisplayValue('QuickBooks Ledger — October 13 – November 13, 2026'),
    ).toBeInTheDocument()
    for (const box of screen.getAllByLabelText('Line description')) {
      expect(box).not.toHaveAttribute('readonly')
    }
  })

  // Saving the dates reloads the invoice from the server, so an unsaved line
  // edit would be thrown away. The dates wait until the other changes are saved.
  it('waits for her other unsaved changes, and says so', async () => {
    await openEditor(baseInvoice)
    expect(changeButton()).toBeEnabled()

    const description = screen.getAllByLabelText('Line description')[0]
    fireEvent.change(description, { target: { value: 'A label she is still typing' } })

    expect(changeButton()).toBeDisabled()
    expect(changeButton()).toHaveAttribute('title', 'Save your other changes first')
  })
})
