import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The two wirings that hold the Invoices page together, and that a tidy-up
 * would quietly break:
 *
 *  1. The month view is HIDDEN, not unmounted, while History is showing. Swap
 *     the wrapper for `{view === 'month' ? … : null}` and this page still looks
 *     right — until someone glances at the archive mid-edit and loses the
 *     invoice they were working on.
 *  2. "Open in month run" respects a refusal. Rewrite the check as a plain
 *     falsy test and a null ref starts meaning "refused"; drop it entirely and
 *     keeping your edits still dumps you on a month run that did not move.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

// Not what is under test, and it reaches for its own data.
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

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: [client],
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

function makeInvoice(overrides: Partial<PersistedInvoice>): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'draft',
    lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

// Distinct numbers so a query can never be ambiguous about which view it hit.
const runInvoice = makeInvoice({ id: 'inv-run', number: 'INV-RUN-001' })
// A month that is NOT the one the run opens on, so "open in month run" is a
// real move and the guard actually fires.
const historyInvoice = makeInvoice({
  id: 'inv-hist',
  number: 'INV-2026-03-007',
  period: '2026-03',
  status: 'sent',
  total: 250,
})

let confirm: ReturnType<typeof vi.fn>

/** Render the page, open the run's invoice, and type into it so it is dirty. */
async function renderWithDirtyEditor() {
  render(<InvoicesPage />)
  fireEvent.click(await screen.findByText('INV-RUN-001'))
  const lineInput = screen.getByLabelText('Line description') as HTMLInputElement
  fireEvent.change(lineInput, { target: { value: 'Billable hours — corrected' } })
  await screen.findByText(/unsaved/)
  return lineInput
}

beforeEach(() => {
  mockList.mockReset()
  mockList.mockImplementation(async (period?: string) =>
    period ? [runInvoice] : [historyInvoice],
  )
  confirm = vi.fn().mockReturnValue(true)
  vi.stubGlobal('confirm', confirm)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('InvoicesPage — This month / History', () => {
  it('hides the month view rather than unmounting it, so open edits survive', async () => {
    const lineInput = await renderWithDirtyEditor()

    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByText('Invoice history')

    // Still in the document, still holding what she typed.
    expect(lineInput.isConnected).toBe(true)
    expect(lineInput).toHaveValue('Billable hours — corrected')
    expect(document.querySelector('.invoice-view')).toHaveAttribute('hidden')
  })

  it('keeps her in History, and says why, when she declines to discard', async () => {
    const lineInput = await renderWithDirtyEditor()
    confirm.mockReturnValue(false)

    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    fireEvent.click(await screen.findByRole('button', { name: /March 2026/ }))
    fireEvent.click(screen.getByText('INV-2026-03-007'))

    expect(confirm).toHaveBeenCalledOnce()
    // Not a silent no-op: it says which month is holding the edits.
    expect(await screen.findByText(/Kept your unsaved edits/)).toHaveTextContent(
      /month run first\.$/,
    )
    // Still in History, and nothing was thrown away.
    expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(document.querySelector('.invoice-view')).toHaveAttribute('hidden')
    expect(lineInput).toHaveValue('Billable hours — corrected')
  })

  it('moves the run to that month and switches back when she agrees', async () => {
    await renderWithDirtyEditor()

    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    fireEvent.click(await screen.findByRole('button', { name: /March 2026/ }))
    fireEvent.click(screen.getByText('INV-2026-03-007'))

    expect(screen.getByRole('button', { name: 'This month' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(document.querySelector('.invoice-view')).not.toHaveAttribute('hidden')
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('2026-03'))
  })

  it('clears a stale note when she switches views herself', async () => {
    await renderWithDirtyEditor()
    confirm.mockReturnValue(false)

    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    fireEvent.click(await screen.findByRole('button', { name: /March 2026/ }))
    fireEvent.click(screen.getByText('INV-2026-03-007'))
    await screen.findByText(/Kept your unsaved edits/)

    fireEvent.click(screen.getByRole('button', { name: 'This month' }))
    fireEvent.click(screen.getByRole('button', { name: 'History' }))

    await screen.findByText('Invoice history')
    expect(screen.queryByText(/Kept your unsaved edits/)).toBeNull()
  })
})
