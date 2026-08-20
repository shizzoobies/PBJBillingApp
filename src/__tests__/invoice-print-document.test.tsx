import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * Printing an invoice from inside the app.
 *
 * The print path is CSS, not a popup: `printInvoice()` tags <body> with
 * `printing-invoice`, and the print stylesheet then hides `#root` and shows
 * `.invoice-print`. That pair only works while the sheet is a SIBLING of
 * #root — a descendant of a `display: none` ancestor cannot be shown again by
 * any rule, so a sheet rendered inside the router Outlet (which lives inside
 * #root) prints a BLANK page. That is what these tests guard: the sheet
 * escapes #root, and it carries the invoice she clicked Print on.
 *
 * jsdom applies no print stylesheet and has no pagination, so it can only
 * check the STRUCTURE the CSS depends on. The rendered result — one page, the
 * invoice on it — is measured by scripts/check-print-pdf.mjs.
 */

const printInvoice = vi.hoisted(() => vi.fn())

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
    printInvoice,
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

// The stored invoice the month run offers to print. Its total is deliberately
// NOT the live per-client total (this client has no time entries, so the live
// calculation is $0.00) — that is how these tests tell the two apart.
const storedInvoice: PersistedInvoice = {
  id: 'inv-run',
  clientId: 'client-acme',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-RUN-001',
  status: 'draft',
  lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: 'August', amount: 400 }],
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
}

/** Render the page the way the app does: inside the #root the print CSS hides. */
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

beforeEach(() => {
  printInvoice.mockReset()
  mockList.mockReset()
  mockList.mockImplementation(async (period?: string) => (period ? [storedInvoice] : []))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoicesPage — the printable invoice sheet', () => {
  it('renders the print sheet outside #root, so the printout is not blank', () => {
    renderInShell()

    const sheet = document.querySelector('.invoice-print')
    expect(sheet).not.toBeNull()
    expect(sheet?.querySelector('.print-sheet')).not.toBeNull()
    // The whole fix: NOT inside the element the print stylesheet hides.
    expect(document.querySelector('#root .print-document')).toBeNull()
    expect(sheet?.parentElement).toBe(document.body)
  })

  // The class the invoice rules key off has to be narrower than
  // `.print-document`, because the assistant's report sheet is one too and the
  // beforeprint listener sets `printing-invoice` merely because this sheet is
  // MOUNTED. Unscoped, a report printed from the Invoices page came out as the
  // invoice instead.
  it('tags its sheet with the invoice-specific print class', () => {
    renderInShell()

    const sheet = document.querySelector('.print-document')!
    expect(sheet.classList.contains('invoice-print')).toBe(true)
  })

  it('prints the stored invoice the month run offered, not the live calculation', async () => {
    renderInShell()

    const printDocument = () => document.querySelector('.invoice-print')!

    // Before the click the sheet holds the live per-client invoice, which for a
    // client with no tracked time is $0.00.
    fireEvent.click(await screen.findByText('INV-RUN-001'))
    expect(printDocument().textContent).not.toContain('$400.00')

    fireEvent.click(screen.getByRole('button', { name: 'Print' }))

    expect(printDocument().textContent).toContain('$400.00')
    expect(printDocument().textContent).toContain('Billable hours')
    await waitFor(() => expect(printInvoice).toHaveBeenCalledOnce())
  })

  // Printing an archived invoice must not leave the page pointed at it: a plain
  // Ctrl+P afterwards has to print the invoice she is LOOKING at.
  it('reverts to the live calculation once the stored print finishes', async () => {
    renderInShell()

    fireEvent.click(await screen.findByText('INV-RUN-001'))
    fireEvent.click(screen.getByRole('button', { name: 'Print' }))
    expect(document.querySelector('.invoice-print')!.textContent).toContain('$400.00')

    window.dispatchEvent(new Event('afterprint'))

    await waitFor(() =>
      expect(document.querySelector('.invoice-print')!.textContent).not.toContain('$400.00'),
    )
  })
})
