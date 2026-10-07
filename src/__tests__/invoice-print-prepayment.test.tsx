import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * Billing period (stage 2): the in-app print sheet prints an anchor-month invoice's
 * prepayment lines under their own "Prepayment" heading with a section total, the
 * same sections the PDF and the email use, and a billing master's combined sheet
 * keeps them beside its one line.
 */

const printInvoice = vi.hoisted(() => vi.fn())
const selectedClientId = vi.hoisted(() => ({ value: 'client-quarterly' }))

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

vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

const clients = [
  {
    id: 'client-quarterly',
    name: 'Quarterly Co',
    contact: '',
    billingMode: 'subscription',
    monthlyRate: 500,
    billingPeriodMonths: 3,
    periodAnchorMonth: '2026-10',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
  {
    id: 'client-klc-master',
    name: 'KLC Master',
    contact: '',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
    isBillingMaster: true,
  },
] as unknown as Client[]

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients,
      contacts: [],
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: selectedClientId.value,
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-10',
    printInvoice,
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const prepayments = [
  { kind: 'prepayment', label: 'Prepayment for November 2026', detail: '', amount: 500, period: '2026-11' },
  { kind: 'prepayment', label: 'Prepayment for December 2026', detail: '', amount: 500, period: '2026-12' },
] as PersistedInvoice['lineItems']

const anchorInvoice: PersistedInvoice = {
  id: 'inv-q',
  clientId: 'client-quarterly',
  period: '2026-10',
  kind: 'monthly',
  number: 'INV-2026-10-001',
  status: 'draft',
  lineItems: [{ kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 500 }, ...prepayments],
  subtotal: 1500,
  total: 1500,
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

const printed = () => document.querySelector('.invoice-print')!.textContent ?? ''

async function printStored(invoice: PersistedInvoice) {
  mockList.mockImplementation(async (period?: string) => (period ? [invoice] : []))
  renderInShell()
  fireEvent.click(await screen.findByText(invoice.number as string))
  fireEvent.click(screen.getByRole('button', { name: 'Print' }))
  await waitFor(() => expect(printInvoice).toHaveBeenCalled())
}

beforeEach(() => {
  printInvoice.mockReset()
  mockList.mockReset()
  selectedClientId.value = 'client-quarterly'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoicesPage - the printed prepayment section', () => {
  it('prints the later months under a Prepayment heading with its own total', async () => {
    await printStored(anchorInvoice)

    expect(printed()).toContain('Prepayment for November 2026')
    expect(printed()).toContain('Prepayment for December 2026')
    expect(printed()).toContain('Total Prepayment')
    expect(printed()).toContain('$1,000.00')
    expect(printed()).toContain('$1,500.00')
    expect(printed().indexOf('Total Subscription Plan')).toBeLessThan(printed().indexOf('Total Prepayment'))
  })

  it('keeps the prepayment rows beside a billing master\'s one combined line', async () => {
    selectedClientId.value = 'client-klc-master'
    await printStored({
      ...anchorInvoice,
      id: 'inv-master',
      clientId: 'client-klc-master',
      number: 'INV-MASTER-001',
      lineItems: [
        { kind: 'plan', label: 'Monthly service - KLC Floors', detail: '', amount: 500, sourceClientId: 'client-klc' },
        ...prepayments,
      ],
    })

    expect(printed()).toContain('Bookkeeping services')
    expect(printed()).toContain('Prepayment for November 2026')
    expect(printed()).toContain('Prepayment for December 2026')
    expect(printed()).not.toContain('KLC Floors')
  })
})
