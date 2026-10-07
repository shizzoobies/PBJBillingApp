import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The lower "Email invoice" button sends the client's MONTHLY invoice and never
 * a retainer invoice by accident (featreq-beec1ccc). It picks through the same
 * rule as the lower Print: a live row, and the monthly one when the client also
 * has a retainer invoice that month. When the retainer is all there is, it says
 * so and sends nothing.
 */

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
  contactIds: ['contact-1'],
  invoiceTimeBreakdownMode: 'day',
  invoiceHideInternalHours: true,
  invoiceGroupByCategory: false,
} as unknown as Client

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: [client],
      contacts: [{ id: 'contact-1', name: 'Hana Hourly', email: 'hana@hourly.test' }],
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: 'client-hourly',
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-09',
    printInvoice: vi.fn(),
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import {
  generateInvoicesRequest,
  listInvoicesRequest,
  sendInvoiceRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)
const mockGenerate = vi.mocked(generateInvoicesRequest)

function makeInvoice(over: Partial<PersistedInvoice>): PersistedInvoice {
  return {
    id: 'inv-monthly',
    clientId: 'client-hourly',
    period: '2026-09',
    kind: 'monthly',
    number: 'INV-2026-09-001',
    status: 'reviewed',
    lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: 'September', amount: 300 }],
    subtotal: 300,
    total: 300,
    dueDate: '2026-10-31',
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: '2026-10-01T14:00:00.000Z',
    updatedAt: null,
    ...over,
  } as PersistedInvoice
}

const monthly = makeInvoice({})
const retainer = makeInvoice({
  id: 'inv-retainer',
  kind: 'retainer',
  number: 'INV-2026-09-R01',
  status: 'sent',
  sentAt: '2026-09-02T14:00:00.000Z',
})

const retainerSentence =
  'This month has only a retainer invoice for Hourly Co; no monthly invoice has been generated yet. Send the retainer invoice from its row in the list above.'

function renderPage() {
  return render(
    <div id="root">
      <InvoicesPage />
    </div>,
  )
}

const pressEmail = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'Email invoice' }))

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
  mockGenerate.mockReset()
  mockSend.mockResolvedValue({ invoice: { ...monthly, status: 'sent', emailLog: [] } } as never)
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
})

describe('Email invoice picks the month\'s invoice, never a retainer by accident', () => {
  it('sends the MONTHLY invoice when the client also has a retainer invoice (retainer listed first)', async () => {
    mockList.mockResolvedValue([retainer, monthly])
    renderPage()

    await pressEmail()

    await waitFor(() => expect(mockSend).toHaveBeenCalledOnce())
    expect(mockSend.mock.calls[0][0]).toBe('inv-monthly')
  })

  it('sends the monthly invoice when the retainer is listed after it', async () => {
    mockList.mockResolvedValue([monthly, retainer])
    renderPage()

    await pressEmail()

    await waitFor(() => expect(mockSend).toHaveBeenCalledOnce())
    expect(mockSend.mock.calls[0][0]).toBe('inv-monthly')
  })

  it('sends nothing and says so when the only live invoice is a retainer', async () => {
    mockList.mockResolvedValue([retainer])
    renderPage()

    await pressEmail()

    expect(await screen.findByText(retainerSentence)).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
    // No offer to build one either: the month already has an invoice for her.
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('a voided monthly invoice beside a live retainer is still the retainer-only case', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'void' }), retainer])
    renderPage()

    await pressEmail()

    expect(await screen.findByText(retainerSentence)).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a monthly invoice alone sends exactly as before', async () => {
    mockList.mockResolvedValue([monthly])
    renderPage()

    await pressEmail()

    await waitFor(() => expect(mockSend).toHaveBeenCalledOnce())
    expect(mockSend.mock.calls[0][0]).toBe('inv-monthly')
    expect(screen.queryByText(retainerSentence)).not.toBeInTheDocument()
  })

  it('a draft monthly invoice still says to mark it reviewed first, retainer or not', async () => {
    mockList.mockResolvedValue([retainer, makeInvoice({ status: 'draft' })])
    renderPage()

    await pressEmail()

    expect(
      await screen.findByText('Mark this invoice reviewed first, in the month run above.'),
    ).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('no invoice at all still offers to generate one', async () => {
    mockList.mockResolvedValue([])
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false)
    renderPage()

    await pressEmail()

    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce())
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain(
      'Hourly Co has no invoice for September 2026 yet. Generate it now?',
    )
    expect(mockSend).not.toHaveBeenCalled()
  })

  // Stage 1c: a one-client generate draws the client's credit on account onto the
  // new draft, and the note that follows says so.
  it('a generate that drew credit on account says how much, beside "created as a draft"', async () => {
    mockList.mockResolvedValue([])
    mockGenerate.mockResolvedValue({
      period: '2026-09',
      created: [
        makeInvoice({
          status: 'draft',
          lineItems: [
            { kind: 'hourly', label: 'Billable hours', detail: 'September', amount: 300 },
            { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -120, draws: [] },
          ],
          total: 180,
        } as Partial<PersistedInvoice>),
      ],
      skipped: [],
    })
    renderPage()

    await pressEmail()

    expect(
      await screen.findByText(
        /Invoice INV-2026-09-001 created as a draft .* then send\. Credit on account applied: \$120\.00 on 1 invoice\./,
      ),
    ).toBeInTheDocument()
  })
})
