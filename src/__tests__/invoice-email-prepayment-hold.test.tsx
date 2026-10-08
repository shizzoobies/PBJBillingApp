import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * The lower "Email invoice" button and the billing-period send guard (M-1). The month
 * run asks "send anyway?" when a later month's prepayment is unpaid; this view asks the
 * same question, with the server's own sentence, and repeats the send with the owner's
 * yes. A hold with no override (the payment is clearing, or the prepayment was not
 * applied to this invoice) shows its sentence and nothing to override.
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

vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

const client = {
  id: 'client-q',
  name: 'Quarterly Co',
  contact: '',
  billingMode: 'subscription',
  monthlyRate: 500,
  billingPeriodMonths: 3,
  periodAnchorMonth: '2026-09',
  hourlyRate: 0,
  planIds: [],
  contactIds: ['contact-1'],
} as unknown as Client

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: [client],
      contacts: [{ id: 'contact-1', name: 'Quinn', email: 'quinn@q.test' }],
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: 'client-q',
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-10',
    printInvoice: vi.fn(),
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest, sendInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)

const HOLD =
  'INV-2026-09-001 carries the prepayment for October 2026 and has not been paid yet (it is Sent), so sending this invoice would bill that month again.'
const CLEARING =
  "This month was prepaid on September 2026's invoice and that payment is still clearing. Once it settles, Apply credit on account (or Void & regenerate) and send then."

const october = {
  id: 'inv-oct',
  clientId: 'client-q',
  period: '2026-10',
  kind: 'monthly',
  number: 'INV-2026-10-001',
  status: 'reviewed',
  lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 500 }],
  subtotal: 500,
  total: 500,
  dueDate: '2026-11-30',
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: '2026-11-01T14:00:00.000Z',
  updatedAt: null,
} as unknown as PersistedInvoice

const sentOctober = { ...october, status: 'sent', emailLog: [] } as unknown as PersistedInvoice

const pressEmail = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'Email invoice' }))

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
  mockList.mockResolvedValue([october])
})

describe('Email invoice and the billing-period hold', () => {
  it('asks with the server sentence and a Send anyway instead of showing an error', async () => {
    mockSend.mockRejectedValueOnce(new ApiError(409, HOLD, 'prepayment_unpaid', 'unpaid'))
    render(<InvoicesPage />)
    await pressEmail()
    const ask = await screen.findByText(HOLD)
    expect(ask.closest('.invoice-run-prepayment-ask')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Send anyway' })).toBeEnabled()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith('inv-oct', undefined)
  })

  it('Send anyway repeats the send with allowUnpaidPrepayment and clears the question', async () => {
    mockSend.mockRejectedValueOnce(new ApiError(409, HOLD, 'prepayment_unpaid', 'unpaid'))
    mockSend.mockResolvedValueOnce({ invoice: sentOctober } as never)
    render(<InvoicesPage />)
    await pressEmail()
    fireEvent.click(await screen.findByRole('button', { name: 'Send anyway' }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2))
    expect(mockSend).toHaveBeenLastCalledWith('inv-oct', undefined, undefined, { allowUnpaidPrepayment: true })
    await waitFor(() => expect(screen.queryByText(HOLD)).toBeNull())
  })

  it('Not now closes the question and sends nothing more', async () => {
    mockSend.mockRejectedValueOnce(new ApiError(409, HOLD, 'prepayment_unpaid', 'unpaid'))
    render(<InvoicesPage />)
    await pressEmail()
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByText(HOLD)).toBeNull()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('a hold with no override shows its sentence and OK only, inline', async () => {
    mockSend.mockRejectedValueOnce(new ApiError(409, CLEARING, 'prepayment_unpaid', 'processing'))
    render(<InvoicesPage />)
    await pressEmail()
    expect(await screen.findByText(CLEARING)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull()
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})
