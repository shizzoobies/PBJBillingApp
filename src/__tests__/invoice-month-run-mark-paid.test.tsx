import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * Manual "Mark as Paid" in the month run — featreq-602d2c6e.
 *
 * The server owns the transitions (db/store-staleness.test.mjs). What the
 * editor owes is offering the button exactly where the server would say yes —
 * and not on processing, where a real debit is settling — plus the undo
 * appearing only on a MANUAL mark, never on a webhook-settled invoice.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  markInvoicePaidRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  unmarkInvoicePaidRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  listInvoicesRequest,
  listUnappliedRetainersRequest,
  markInvoicePaidRequest,
  unmarkInvoicePaidRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockMark = vi.mocked(markInvoicePaidRequest)
const mockUnmark = vi.mocked(unmarkInvoicePaidRequest)

// happy-dom ships no window.confirm, so it is STUBBED, not spied — same
// pattern (and same teardown reason) as the dirty-guard suite.
let confirm: ReturnType<typeof vi.fn>

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

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
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
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  } as PersistedInvoice
}

async function openEditor(tab: RegExp) {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

const markButton = () => screen.queryByRole('button', { name: 'Mark paid' })
const undoButton = () => screen.queryByRole('button', { name: 'Undo manual payment' })

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockMark.mockReset()
  mockUnmark.mockReset()
  confirm = vi.fn().mockReturnValue(true)
  vi.stubGlobal('confirm', confirm)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Mark paid', () => {
  it('is offered on a sent invoice, confirms, calls the API and merges the result', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockMark.mockResolvedValue(
      makeInvoice({ status: 'paid', paymentMethod: 'manual', paidAt: '2026-09-01T00:00:00.000Z' }),
    )
    await openEditor(/Sent/)
    await waitFor(() => expect(markButton()).toBeInTheDocument())

    fireEvent.click(markButton()!)
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(mockMark).toHaveBeenCalledWith('inv-1'))
    // The merged invoice is paid now, so it LEAVES the Sent tab (tabs never
    // auto-follow — pinned since 3362519) and stands on Paid with the undo.
    await waitFor(() => expect(screen.queryByText('INV-2026-08-001')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Paid/ }))
    // The editor is still open for this invoice (openId survives a tab
    // switch), so clicking the row again would TOGGLE it closed.
    await screen.findByText('INV-2026-08-001')
    await waitFor(() => expect(undoButton()).toBeInTheDocument())
    expect(markButton()).not.toBeInTheDocument()
  })

  it('does nothing when she cancels the confirm', async () => {
    confirm.mockReturnValue(false)
    mockList.mockResolvedValue([makeInvoice()])
    await openEditor(/Sent/)
    await waitFor(() => expect(markButton()).toBeInTheDocument())
    fireEvent.click(markButton()!)
    expect(mockMark).not.toHaveBeenCalled()
  })

  // The webhook owns a settling debit; the button must not even be offered.
  it('is NOT offered while a payment is processing', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'processing' })])
    await openEditor(/Sent/)
    await waitFor(() => expect(screen.getByText(/going through/i)).toBeInTheDocument())
    expect(markButton()).not.toBeInTheDocument()
  })
})

describe('Undo manual payment', () => {
  it('is offered only on a manual mark, and returns the invoice to Sent', async () => {
    mockList.mockResolvedValue([
      makeInvoice({ status: 'paid', paymentMethod: 'manual', paidAt: '2026-09-01T00:00:00.000Z' }),
    ])
    mockUnmark.mockResolvedValue(makeInvoice())
    await openEditor(/Paid/)
    await waitFor(() => expect(undoButton()).toBeInTheDocument())

    fireEvent.click(undoButton()!)
    await waitFor(() => expect(mockUnmark).toHaveBeenCalledWith('inv-1'))
  })

  it('never appears on a webhook-paid invoice — real money stays what it is', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        status: 'paid',
        paymentMethod: 'us_bank_account',
        paidAt: '2026-09-01T00:00:00.000Z',
      }),
    ])
    await openEditor(/Paid/)
    await waitFor(() => expect(screen.getByText(/locked because it has been paid/i)).toBeInTheDocument())
    expect(undoButton()).not.toBeInTheDocument()
    expect(markButton()).not.toBeInTheDocument()
  })
})
