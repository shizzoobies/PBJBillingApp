import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * The lower "Email invoice" button, when the invoice moves under its send
 * (a void landed, or another tab changed it): the send is refused with
 * `invoice_voided` / `invoice_changed`, the sentence shows beside the button, and
 * the month run above reloads itself so its row stops reading "Reviewed".
 * Any other failure leaves the month run alone.
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

import { listInvoicesRequest, sendInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)

const reviewed = {
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
} as unknown as PersistedInvoice

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
  mockList.mockResolvedValue([reviewed])
})

/** Mount, let the month run settle, press Email, and wait for the sentence. */
async function pressEmailAndWaitFor(sentence: string) {
  render(
    <div id="root">
      <InvoicesPage />
    </div>,
  )
  const button = await screen.findByRole('button', { name: 'Email invoice' })
  await act(async () => {})
  const before = mockList.mock.calls.length
  fireEvent.click(button)
  expect(await screen.findByText(sentence)).toBeInTheDocument()
  return before
}

describe('the lower Email invoice button, when the invoice moves under the send', () => {
  for (const [code, sentence] of [
    ['invoice_voided', 'This invoice was voided while it was being sent. Nothing was emailed.'],
    [
      'invoice_changed',
      'This invoice changed while it was being sent. Nothing was emailed. Try sending again.',
    ],
  ] as const) {
    it(`${code}: says the sentence and reloads the month run`, async () => {
      mockSend.mockRejectedValue(new ApiError(409, sentence, code))

      const before = await pressEmailAndWaitFor(sentence)

      // The button's own read of the month, then the month run's reload.
      await waitFor(() => expect(mockList.mock.calls.length).toBe(before + 2))
    })
  }

  it('an ordinary send failure leaves the month run alone', async () => {
    mockSend.mockRejectedValue(new ApiError(502, 'The email provider refused.', 'invoice_send_failed'))

    const before = await pressEmailAndWaitFor('The email provider refused.')
    await act(async () => {})

    // Only the button's own read of the month.
    expect(mockList.mock.calls.length).toBe(before + 1)
  })
})
