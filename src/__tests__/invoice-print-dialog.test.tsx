import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * "Print invoice" on the Invoices page asks which month first, and the date the
 * sheet prints follows the billing month (from September 2026 on a monthly
 * invoice is dated the last day of the month it bills).
 *
 * The clock is frozen on October 1, 2026 (local time, Date only, so the
 * testing library's own timers still run): the day the firm is invoicing
 * September while the top-bar billing month sits on the current month, October.
 */

const printInvoice = vi.hoisted(() => vi.fn())
const page = vi.hoisted(() => ({ billingPeriod: '2026-10' }))

vi.mock('../lib/api', () => ({
  answerInvoiceAiReviewQuestionRequest: vi.fn(),
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
  generateInvoicesRequest: vi.fn(),
  listInvoiceAiReviewsRequest: vi.fn(async () => []),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  rateInvoiceRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

// Not what is under test, and it reaches for its own data.
vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

const client = {
  id: 'client-hourly',
  name: 'Hourly Co',
  contact: '',
  billingMode: 'hourly',
  hourlyRate: 100,
  planIds: [],
  contactIds: [],
  invoiceTimeBreakdownMode: 'day',
  invoiceHideInternalHours: true,
  invoiceGroupByCategory: false,
} as unknown as Client

// August $200, September $300, October nothing: each month's live calculation
// is told apart by its total.
const timeEntries = [
  {
    id: 'e-aug',
    employeeId: 'emp-1',
    clientId: 'client-hourly',
    date: '2026-08-04',
    minutes: 120,
    billable: true,
  },
  {
    id: 'e-sep',
    employeeId: 'emp-1',
    clientId: 'client-hourly',
    date: '2026-09-11',
    minutes: 180,
    billable: true,
  },
]

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: [client],
      contacts: [],
      timeEntries,
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [{ id: 'emp-1', name: 'Test Employee', role: 'Bookkeeper', billRate: 100 }],
    },
    selectedClientId: 'client-hourly',
    setSelectedClientId: vi.fn(),
    billingPeriod: page.billingPeriod,
    printInvoice,
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const storedSeptember: PersistedInvoice = {
  id: 'inv-sep',
  clientId: 'client-hourly',
  period: '2026-09',
  kind: 'monthly',
  number: 'INV-2026-09-001',
  status: 'draft',
  lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: 'September', amount: 777 }],
  subtotal: 777,
  total: 777,
  dueDate: '2026-10-31',
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: '2026-10-01T14:00:00.000Z',
  updatedAt: null,
}

const printed = () => document.querySelector('.invoice-print')!.textContent ?? ''

function renderInShell() {
  return render(
    <div id="root">
      <div className="app-shell">
        <main className="workspace">
          <InvoicesPage />
        </main>
      </div>
    </div>,
  )
}

const openDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Print invoice' }))
  return within(await screen.findByRole('dialog', { name: 'Print invoice' }))
}

const setMonth = (dialog: ReturnType<typeof within>, value: string) =>
  fireEvent.change(dialog.getByLabelText('Billing month'), { target: { value } })

const addCustomLine = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Customize' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Add line' }))
  const descriptions = screen.getAllByPlaceholderText('Description')
  fireEvent.change(descriptions[descriptions.length - 1], { target: { value: 'Custom review fee' } })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 1, 9, 30, 0)) // Oct 1, 2026, local
  printInvoice.mockReset()
  mockList.mockReset()
  mockList.mockImplementation(async () => [])
  page.billingPeriod = '2026-10'
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the printed Invoice Date', () => {
  it('dates a stored September invoice built in October September 30', async () => {
    mockList.mockImplementation(async (period?: string) => (period ? [storedSeptember] : []))
    renderInShell()

    fireEvent.click(await screen.findByText('INV-2026-09-001'))
    fireEvent.click(screen.getByRole('button', { name: 'Print' }))

    await waitFor(() => expect(printInvoice).toHaveBeenCalledOnce())
    expect(printed()).toContain('$777.00')
    expect(printed()).toContain('September 30, 2026')
    expect(printed()).not.toContain('October 1, 2026')
  })

  it('dates the live preview of a finished month the last day of that month', async () => {
    page.billingPeriod = '2026-09'
    renderInShell()
    await screen.findByRole('button', { name: 'Print invoice' })

    expect(printed()).toContain('$300.00')
    expect(printed()).toContain('September 30, 2026')
  })

  it('dates the live preview of the current month today', async () => {
    renderInShell()
    await screen.findByRole('button', { name: 'Print invoice' })

    expect(printed()).toContain('October 1, 2026')
  })

  it('leaves the live preview of a month before the cutoff on today', async () => {
    page.billingPeriod = '2026-08'
    renderInShell()
    await screen.findByRole('button', { name: 'Print invoice' })

    expect(printed()).toContain('$200.00')
    expect(printed()).toContain('October 1, 2026')
  })
})

describe('Print invoice asks which month', () => {
  it('opens a dialog on click and prints nothing yet', async () => {
    renderInShell()
    const dialog = await openDialog()

    expect(dialog.getByText('Which month is this invoice for?')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Print' })).toBeEnabled()
    expect(printInvoice).not.toHaveBeenCalled()
  })

  it('opens on the month the month run is showing and names what will print', async () => {
    renderInShell()
    // The run opens on the current month, October; step it back to September.
    fireEvent.click(await screen.findByRole('button', { name: 'Previous month' }))

    const dialog = await openDialog()
    expect(dialog.getByLabelText('Billing month')).toHaveValue('2026-09')
    expect(dialog.getByText('Hourly Co · September 2026')).toBeInTheDocument()

    setMonth(dialog, '2026-08')
    expect(dialog.getByText('Hourly Co · August 2026')).toBeInTheDocument()
  })

  it('prints nothing on Cancel or Escape', async () => {
    renderInShell()

    const dialog = await openDialog()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Print invoice' })).toBeNull()

    await openDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Print invoice' })).toBeNull()

    expect(printInvoice).not.toHaveBeenCalled()
  })

  it('disables Print while the month is empty', async () => {
    renderInShell()
    const dialog = await openDialog()

    setMonth(dialog, '')
    expect(dialog.getByRole('button', { name: 'Print' })).toBeDisabled()
    setMonth(dialog, '2026-09')
    expect(dialog.getByRole('button', { name: 'Print' })).toBeEnabled()
  })

  it('prints the live calculation for a different month, dated that month’s last day', async () => {
    renderInShell()
    // The on-screen invoice is October's: nothing tracked.
    expect(printed()).not.toContain('$300.00')

    const dialog = await openDialog()
    setMonth(dialog, '2026-09')
    fireEvent.click(dialog.getByRole('button', { name: 'Print' }))

    await waitFor(() => expect(printInvoice).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog', { name: 'Print invoice' })).toBeNull()
    // The sheet was committed with September's invoice BEFORE print ran.
    expect(printed()).toContain('$300.00')
    expect(printed()).toContain('Billing Period: September 2026')
    expect(printed()).toContain('September 30, 2026')
  })

  it('falls back to the on-screen invoice once the print finishes', async () => {
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')
    fireEvent.click(dialog.getByRole('button', { name: 'Print' }))
    await waitFor(() => expect(printInvoice).toHaveBeenCalledOnce())
    expect(printed()).toContain('$300.00')

    act(() => {
      window.dispatchEvent(new Event('afterprint'))
    })

    await waitFor(() => expect(printed()).not.toContain('$300.00'))
    expect(printed()).toContain('Billing Period: October 2026')
    expect(printed()).toContain('October 1, 2026')
  })

  it('prints the on-screen invoice, Customize edits included, for the page’s own month', async () => {
    renderInShell()
    await addCustomLine()

    const dialog = await openDialog()
    expect(dialog.getByText('Customize edits apply to October 2026 only.')).toBeInTheDocument()
    setMonth(dialog, '2026-10')
    fireEvent.click(dialog.getByRole('button', { name: 'Print' }))

    await waitFor(() => expect(printInvoice).toHaveBeenCalledOnce())
    expect(printed()).toContain('Custom review fee')
  })

  it('leaves Customize edits off another month’s sheet', async () => {
    renderInShell()
    await addCustomLine()

    const dialog = await openDialog()
    setMonth(dialog, '2026-09')
    fireEvent.click(dialog.getByRole('button', { name: 'Print' }))

    await waitFor(() => expect(printInvoice).toHaveBeenCalledOnce())
    expect(printed()).not.toContain('Custom review fee')
    expect(printed()).toContain('$300.00')
  })

  it('shows no Customize line when Customize is closed', async () => {
    renderInShell()
    const dialog = await openDialog()
    expect(dialog.queryByText(/Customize edits apply to/)).toBeNull()
  })
})
