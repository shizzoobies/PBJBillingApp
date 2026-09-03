import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * "Verify all with Stripe" — the sweep form of the single Verify button.
 *
 * The server owns the sweep (route glue pinned in
 * invoice-coverage-routes.test.ts). What the run owes here: the button is
 * always offered (the months holding a stuck payment may not be the month on
 * screen), it needs no confirm (it writes nothing unless Stripe says the money
 * settled), the list re-fetches afterwards, and the summary reaches her as a
 * sentence naming the invoices that changed.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
  verifyAllInvoicePaymentsRequest: vi.fn(),
}))

import {
  listInvoicesRequest,
  listUnappliedRetainersRequest,
  verifyAllInvoicePaymentsRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockVerifyAll = vi.mocked(verifyAllInvoicePaymentsRequest)

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
    status: 'processing',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-20T00:00:00.000Z',
    paidAt: null,
    paymentMethod: 'card',
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  } as PersistedInvoice
}

const verifyAllButton = () =>
  screen.queryByRole('button', { name: /Verify all with Stripe/ })

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockVerifyAll.mockReset()
  // happy-dom ships no window.confirm — stubbed so an unexpected confirm calls
  // a spy instead of throwing, which is exactly what the no-confirm assertion
  // below checks.
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Verify all with Stripe', () => {
  it('is offered even when the shown month has nothing processing', async () => {
    mockList.mockResolvedValue([])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(verifyAllButton()).toBeInTheDocument())
  })

  it('sweeps without a confirm, re-fetches the list, and reports the summary', async () => {
    mockList.mockResolvedValueOnce([makeInvoice()])
    mockVerifyAll.mockResolvedValue({
      checked: 2,
      verified: [{ id: 'inv-1', number: 'INV-2026-08-001' }],
      stillSettling: [{ id: 'inv-2', number: 'INV-2026-08-002', stripeStatus: 'processing' }],
      unverifiable: [],
      invoices: [makeInvoice({ status: 'paid', paidAt: '2026-08-20T13:58:12.000Z' })],
    })
    // The re-fetch after the sweep returns the settled row.
    mockList.mockResolvedValue([
      makeInvoice({ status: 'paid', paidAt: '2026-08-20T13:58:12.000Z' }),
    ])

    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(verifyAllButton()).toBeInTheDocument())
    fireEvent.click(verifyAllButton()!)

    await waitFor(() => expect(mockVerifyAll).toHaveBeenCalledTimes(1))
    // No decision to warn about — the sweep writes nothing Stripe didn't say.
    expect(vi.mocked(window.confirm)).not.toHaveBeenCalled()
    // The list was asked again after the sweep (initial load + post-sweep).
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    await screen.findByText(
      'Checked 2 with Stripe: 1 confirmed paid (INV-2026-08-001) · 1 still settling with Stripe.',
    )
  })

  it('says so when nothing is holding', async () => {
    mockList.mockResolvedValue([])
    mockVerifyAll.mockResolvedValue({
      checked: 0,
      verified: [],
      stillSettling: [],
      unverifiable: [],
      invoices: [],
    })
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(verifyAllButton()).toBeInTheDocument())
    fireEvent.click(verifyAllButton()!)
    await screen.findByText('Nothing is holding — no invoices are mid-payment.')
  })

  it('surfaces a failed sweep as the run error, not silence', async () => {
    mockList.mockResolvedValue([])
    mockVerifyAll.mockRejectedValue(new Error('Could not reach Stripe to check.'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(verifyAllButton()).toBeInTheDocument())
    fireEvent.click(verifyAllButton()!)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Could not reach Stripe')
  })
})
