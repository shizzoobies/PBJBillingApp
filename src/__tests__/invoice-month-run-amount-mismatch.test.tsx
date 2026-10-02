import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * A payment for a different amount than the invoice total, in the month run
 * (featreq-9cc3c370).
 *
 * The webhook records the payment as usual and writes a marker to the invoice's
 * log. What the run owes is showing it where she will see it - on a PAID invoice
 * too, in "Need a look", on the row and in the open editor - and letting her
 * clear it with "Mark as handled", with a server refusal said inline.
 */

vi.mock('../lib/api', () => ({
  acknowledgeInvoiceAmountMismatchRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  acknowledgeInvoiceAmountMismatchRequest,
  listInvoicesRequest,
  listUnappliedRetainersRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockAck = vi.mocked(acknowledgeInvoiceAmountMismatchRequest)

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

const marker = {
  kind: 'payment',
  event: 'amount-mismatch',
  at: '2026-09-10T14:00:00.000Z',
  paymentIntentId: 'pi_1',
  expectedCents: 40000,
  receivedCents: 35000,
} as const

const handled = {
  kind: 'payment',
  event: 'amount-mismatch-handled',
  at: '2026-09-11T10:00:00.000Z',
  by: 'owner-1',
  paymentIntentId: 'pi_1',
} as const

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'paid',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-20T00:00:00.000Z',
    paidAt: '2026-09-10T14:00:00.000Z',
    paymentMethod: 'us_bank_account',
    emailLog: [marker],
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  } as PersistedInvoice
}

const NOTICE =
  "The client paid $350.00; this invoice's total is $400.00. It is recorded as paid. Bill or refund the difference, then mark this as handled."

const needALookStat = () => {
  const label = screen.getByText('Need a look')
  return within(label.parentElement as HTMLElement).getByText(/^\d+$/)
}

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockAck.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a payment for a different amount than the invoice total', () => {
  it('counts a PAID invoice under Need a look, and puts the amber marker on the Paid tab', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    await waitFor(() => expect(needALookStat()).toHaveTextContent('1'))
    const paidTab = screen.getByRole('tab', { name: /Paid/ })
    expect(paidTab.querySelector('.invoice-run-tab-flag')).not.toBeNull()
    // The other tabs hold nothing flagged.
    expect(
      screen.getByRole('tab', { name: /^Sent/ }).querySelector('.invoice-run-tab-flag'),
    ).toBeNull()
  })

  it('shows both amounts on the row', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))

    expect(await screen.findByText(/Paid \$350\.00, total \$400\.00/)).toBeInTheDocument()
  })

  it('renders the notice with both amounts in the open editor', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as handled' })).toBeInTheDocument()
  })

  it('while a bank payment is still processing, never says it is recorded as paid', async () => {
    mockList.mockResolvedValue([
      makeInvoice({ status: 'processing', paidAt: null, emailLog: [marker] }),
    ])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Sent/ }))
    expect(await screen.findByText(/Paying \$350\.00, total \$400\.00/)).toBeInTheDocument()
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(
      await screen.findByText(
        "The client's payment in progress is for $350.00; this invoice's total is $400.00. Once it settles, bill or refund the difference, then mark this as handled.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/recorded as paid/)).not.toBeInTheDocument()
  })

  it('a bank payment that later failed is neither flagged nor counted', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        status: 'sent',
        paidAt: null,
        emailLog: [
          marker,
          {
            kind: 'payment',
            event: 'failed',
            at: '2026-09-20T00:00:00.000Z',
            paymentIntentId: 'pi_1',
            detail: 'returned',
          },
        ],
      } as Partial<PersistedInvoice>),
    ])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    await waitFor(() => expect(needALookStat()).toHaveTextContent('0'))
  })

  it('does not count an invoice whose mismatch was already handled', async () => {
    mockList.mockResolvedValue([makeInvoice({ emailLog: [marker, handled] })])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    await waitFor(() => expect(needALookStat()).toHaveTextContent('0'))
    expect(
      screen.getByRole('tab', { name: /Paid/ }).querySelector('.invoice-run-tab-flag'),
    ).toBeNull()
  })

  it('is not mistaken for a failed payment: a sent invoice stays in Sent', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'sent', paidAt: null, paymentMethod: null })])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Sent/ }))

    expect(await screen.findByText('INV-2026-08-001')).toBeInTheDocument()
    // The Payment failed tab is empty (its count is 0) and the row carries no
    // red "Payment failed <date>" flag.
    expect(screen.getByRole('tab', { name: /Payment failed/ })).toHaveTextContent('0')
    expect(screen.queryByText(/Payment failed \w{3} \d/)).not.toBeInTheDocument()
  })

  it('Mark as handled calls the API and the flag is gone from the editor, the row and the count', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockAck.mockResolvedValue(makeInvoice({ emailLog: [marker, handled], updatedAt: 'later' }))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as handled' }))

    await waitFor(() => expect(mockAck).toHaveBeenCalledWith('inv-1'))
    await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument())
    expect(screen.queryByText(/Paid \$350\.00, total \$400\.00/)).not.toBeInTheDocument()
    expect(needALookStat()).toHaveTextContent('0')
  })

  it('says a refusal inline instead of swallowing it, and keeps the flag', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockAck.mockRejectedValue(new Error('Only owners can mark a payment mismatch handled'))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as handled' }))

    expect(
      await screen.findByText('Only owners can mark a payment mismatch handled'),
    ).toBeInTheDocument()
    expect(screen.getByText(NOTICE)).toBeInTheDocument()
    expect(needALookStat()).toHaveTextContent('1')
  })
})

/**
 * featreq-c8e5f169 (smaller items): a SECOND payment on an already-paid invoice
 * rides the same flag with its own wording, the notice says how many payments
 * are waiting, and money for a voided invoice (a log-only entry) shows nothing.
 */
describe('a second payment on a paid invoice, and how many are waiting', () => {
  const duplicate = {
    kind: 'payment',
    event: 'amount-mismatch',
    at: '2026-09-12T14:00:00.000Z',
    paymentIntentId: 'pi_2',
    expectedCents: 40000,
    receivedCents: 40000,
    reason: 'duplicate',
  } as const

  const DUPLICATE_NOTICE =
    'A payment of $400.00 arrived for this invoice again after it was already paid. It was not applied to the invoice. Refund it or apply it by hand, then mark this as handled.'

  it('flags a duplicate on a Paid invoice, counts it, and words it as a second payment', async () => {
    mockList.mockResolvedValue([makeInvoice({ emailLog: [duplicate] })])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    await waitFor(() => expect(needALookStat()).toHaveTextContent('1'))
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    expect(await screen.findByText('Second payment $400.00')).toBeInTheDocument()
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(await screen.findByText(DUPLICATE_NOTICE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as handled' })).toBeInTheDocument()
  })

  it('says it was a payment without an amount when Stripe did not report one', async () => {
    mockList.mockResolvedValue([
      makeInvoice({ emailLog: [{ ...duplicate, receivedCents: null }] } as Partial<PersistedInvoice>),
    ])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))

    expect(await screen.findByText('Second payment')).toBeInTheDocument()
    fireEvent.click(await screen.findByText('INV-2026-08-001'))
    expect(
      await screen.findByText(/^A payment arrived for this invoice again after it was already paid\./),
    ).toBeInTheDocument()
  })

  it('says how many payments are waiting, not only the newest', async () => {
    const newest = { ...duplicate, paymentIntentId: 'pi_3', at: '2026-09-13T14:00:00.000Z' }
    mockList.mockResolvedValue([makeInvoice({ emailLog: [marker, newest] })])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    // One invoice, however many payments: the stat counts invoices.
    await waitFor(() => expect(needALookStat()).toHaveTextContent('1'))
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    expect(await screen.findByText('Second payment $400.00 (2 unhandled)')).toBeInTheDocument()
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(
      await screen.findByText(
        DUPLICATE_NOTICE + ' 2 payments on this invoice are waiting to be marked handled (this is the newest).',
      ),
    ).toBeInTheDocument()
  })

  it('does not say anything about a count when only one is waiting', async () => {
    mockList.mockResolvedValue([makeInvoice({ emailLog: [marker] })])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    expect(screen.queryByText(/waiting to be marked handled/)).not.toBeInTheDocument()
  })

  it('money for a voided invoice (an on-voided log entry) flags nothing', async () => {
    const onVoided = {
      kind: 'payment',
      event: 'on-voided',
      at: '2026-09-12T14:00:00.000Z',
      paymentIntentId: 'pi_late',
      amount: 400,
    } as const
    mockList.mockResolvedValue([
      makeInvoice({ status: 'void', paidAt: null, emailLog: [onVoided] } as Partial<PersistedInvoice>),
    ])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    await waitFor(() => expect(needALookStat()).toHaveTextContent('0'))
  })
})

describe('a second BANK payment that was only started', () => {
  it('says it was started, not that money arrived, and that it clears itself if it fails', async () => {
    const started = {
      kind: 'payment',
      event: 'amount-mismatch',
      at: '2026-09-12T14:00:00.000Z',
      paymentIntentId: 'pi_2',
      expectedCents: 40000,
      receivedCents: 40000,
      reason: 'duplicate',
      settling: true,
    } as const
    mockList.mockResolvedValue([makeInvoice({ emailLog: [started] })])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(
      await screen.findByText(
        'A second bank payment of $400.00 was started for this invoice after it was already paid. It was not applied to the invoice. Once it settles, refund it or apply it by hand, then mark this as handled. If it fails, this clears by itself.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/arrived/)).not.toBeInTheDocument()
  })
})
