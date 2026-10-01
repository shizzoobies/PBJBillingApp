import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type Contact, type PersistedInvoice } from '../lib/types'

/**
 * Two things the month run owes after an invoice moves under it
 * (featreq-61347136).
 *
 * 1. A refusal that means "this invoice moved" (a payment landed, another tab
 *    changed it) reloads the month, so the row shows what the invoice is NOW and
 *    the buttons that no longer apply go away. The sentence still shows ONCE.
 * 2. No failure in the editor goes unheard after the row is closed: Mark paid,
 *    Verify with Stripe, Undo manual payment, Payment link, Send and a covered
 *    dates save say their failure in the editor while it is on screen, and in the
 *    run's banner (naming the invoice) when it is gone by the time the answer
 *    arrives.
 */

vi.mock('../lib/api', () => ({
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  markInvoicePaidRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  unmarkInvoicePaidRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
  verifyInvoicePaymentRequest: vi.fn(),
}))

import {
  confirmInvoiceCoverageRequest,
  createInvoicePaymentLinkRequest,
  listInvoicesRequest,
  markInvoicePaidRequest,
  sendInvoiceRequest,
  unmarkInvoicePaidRequest,
  updateInvoiceRequest,
  verifyInvoicePaymentRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockMark = vi.mocked(markInvoicePaidRequest)
const mockVerify = vi.mocked(verifyInvoicePaymentRequest)
const mockUnmark = vi.mocked(unmarkInvoicePaidRequest)
const mockLink = vi.mocked(createInvoicePaymentLinkRequest)
const mockSend = vi.mocked(sendInvoiceRequest)
const mockConfirm = vi.mocked(confirmInvoiceCoverageRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 0,
    planIds: [],
    contactIds: ['contact-acme'],
  },
] as unknown as Client[]

const contacts: Contact[] = [{ id: 'contact-acme', name: 'Ann Acme', email: 'ann@acme.test' }]

const recurringLine = {
  kind: 'recurring' as const,
  label: 'QuickBooks Ledger — August 13 – September 13, 2026',
  detail: 'monthly',
  amount: 90,
  recurringId: 'recur-qbo',
  coverageStart: '2026-08-13',
  coverageEnd: '2026-09-13',
}

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'draft',
    lineItems: [{ kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 600 }],
    subtotal: 600,
    total: 600,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  } as PersistedInvoice
}

const NUMBER = 'INV-2026-08-001'

/** The editor itself, so a sentence is found beside its buttons and not in the banner. */
const editor = () => {
  const node = document.querySelector('.invoice-run-editor')
  if (!node) throw new Error('the editor is not open')
  return within(node as HTMLElement)
}

async function openEditor(rows: PersistedInvoice[], tab?: RegExp) {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText(NUMBER))
}

/** Collapse the open row, the way she does while a request is still in the air. */
function collapseRow() {
  fireEvent.click(screen.getByText(NUMBER))
  expect(document.querySelector('.invoice-run-editor')).toBeNull()
}

beforeEach(() => {
  for (const mock of [
    mockList,
    mockUpdate,
    mockMark,
    mockVerify,
    mockUnmark,
    mockLink,
    mockSend,
    mockConfirm,
  ]) {
    mock.mockReset()
  }
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('InvoiceMonthRun — a refusal that means the invoice moved reloads the month', () => {
  const sentence = 'This invoice changed while you were working - a payment may have just come in.'

  for (const code of ['invoice_payment_processing', 'invoice_locked', 'invoice_changed']) {
    it(`${code}: reloads the month once, the row leaves the tab it no longer belongs in, and the sentence is said once`, async () => {
      mockUpdate.mockRejectedValue(new ApiError(409, sentence, code))
      await openEditor([makeInvoice()])
      expect(mockList).toHaveBeenCalledTimes(1)
      // What the server holds now: a payment has taken the invoice.
      mockList.mockResolvedValue([
        makeInvoice({ status: 'paid', paidAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }),
      ])

      fireEvent.click(await screen.findByRole('button', { name: 'Void' }))

      await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
      // The month on screen, whatever it is — not some other month.
      expect(mockList).toHaveBeenLastCalledWith(mockList.mock.calls[0][0])
      // The draft is gone from To review; the buttons that no longer applied went with it.
      await waitFor(() => expect(screen.queryByText(NUMBER)).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
      // Said once — in the banner, naming the invoice, because the editor left.
      expect(await screen.findByText(`${NUMBER}: ${sentence}`)).toBeInTheDocument()
      expect(screen.getAllByText(new RegExp(sentence.slice(0, 30)))).toHaveLength(1)
      // The row now shows its real status, under Paid.
      fireEvent.click(screen.getByRole('tab', { name: /^Paid/ }))
      expect(await screen.findByText(NUMBER)).toBeInTheDocument()
    })
  }

  it('says it in the editor, once, when the reload leaves the row where it was', async () => {
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'invoice_changed'))
    await openEditor([makeInvoice()])

    fireEvent.click(await screen.findByRole('button', { name: 'Void' }))

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })

  it('does not reload for an ordinary refusal such as coverage_unconfirmed', async () => {
    const ordinary = 'Confirm the covered dates on the QuickBooks line before marking reviewed.'
    mockUpdate.mockRejectedValue(new ApiError(409, ordinary, 'coverage_unconfirmed'))
    await openEditor([makeInvoice()])

    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))

    expect(await editor().findByText(ordinary)).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('does not reload for an unknown code or a plain failure', async () => {
    mockUpdate.mockRejectedValueOnce(new ApiError(409, 'Something new.', 'some_future_code'))
    await openEditor([makeInvoice()])
    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }))
    expect(await editor().findByText('Something new.')).toBeInTheDocument()

    mockUpdate.mockRejectedValueOnce(new ApiError(500, 'Could not save that change.'))
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    expect(await editor().findByText('Could not save that change.')).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('keeps the sentence and the list she has when the reload itself fails', async () => {
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'invoice_changed'))
    await openEditor([makeInvoice()])
    mockList.mockRejectedValue(new Error('offline'))

    fireEvent.click(await screen.findByRole('button', { name: 'Void' }))

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(screen.getByText(NUMBER)).toBeInTheDocument()
  })
})

/** A refusal-in-the-air: the returned function settles the pending request with a failure. */
function pending(mock: { mockReturnValue: (value: never) => unknown }) {
  let fail: (error: Error) => void = () => {}
  mock.mockReturnValue(new Promise((_, reject) => (fail = reject)) as never)
  return (message: string) => fail(new Error(message))
}

describe('InvoiceMonthRun — a failure that arrives after the editor is gone is said in the banner', () => {
  const sentence = 'Stripe would not do that just now.'
  const banner = `${NUMBER}: ${sentence}`

  it('Mark paid', async () => {
    const fail = pending(mockMark)
    await openEditor([makeInvoice({ status: 'sent' })], /^Sent/)
    fireEvent.click(await screen.findByRole('button', { name: 'Mark paid' }))
    collapseRow()

    fail(sentence)

    expect(await screen.findByText(banner)).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(sentence))).toHaveLength(1)
  })

  it('Verify with Stripe', async () => {
    const fail = pending(mockVerify)
    await openEditor([makeInvoice({ status: 'processing' })], /^Sent/)
    fireEvent.click(await screen.findByRole('button', { name: 'Verify with Stripe' }))
    collapseRow()

    fail(sentence)

    expect(await screen.findByText(banner)).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(sentence))).toHaveLength(1)
  })

  it('Undo manual payment', async () => {
    const fail = pending(mockUnmark)
    await openEditor([makeInvoice({ status: 'paid', paymentMethod: 'manual' })], /^Paid/)
    fireEvent.click(await screen.findByRole('button', { name: 'Undo manual payment' }))
    collapseRow()

    fail(sentence)

    expect(await screen.findByText(banner)).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(sentence))).toHaveLength(1)
  })

  it('Payment link', async () => {
    const fail = pending(mockLink)
    await openEditor([makeInvoice({ status: 'sent' })], /^Sent/)
    fireEvent.click(await screen.findByRole('button', { name: 'Payment link' }))
    collapseRow()

    fail(sentence)

    expect(await screen.findByText(banner)).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(sentence))).toHaveLength(1)
  })

  it('Send', async () => {
    const fail = pending(mockSend)
    await openEditor([makeInvoice({ status: 'reviewed' })], /^Reviewed/)
    fireEvent.click(await screen.findByRole('button', { name: /^Send$/ }))
    collapseRow()

    fail(sentence)

    expect(await screen.findByText(banner)).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(sentence))).toHaveLength(1)
  })

  it('a covered dates save', async () => {
    const fail = pending(mockConfirm)
    await openEditor([makeInvoice({ lineItems: [recurringLine], subtotal: 90, total: 90 })])
    fireEvent.click(await screen.findByRole('button', { name: 'Change covered dates' }))
    fireEvent.change(screen.getByLabelText('Covered period end'), {
      target: { value: '2026-09-20' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))
    collapseRow()

    fail(sentence)

    expect(await screen.findByText(banner)).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(sentence))).toHaveLength(1)
  })
})

describe('InvoiceMonthRun — the same failures with the editor still open are unchanged', () => {
  const sentence = 'Stripe would not do that just now.'

  /** Exactly one alert carrying the sentence, inside the editor, and no banner copy. */
  async function expectSaidOnceInEditor() {
    expect(await editor().findByText(sentence)).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(sentence))).toHaveLength(1)
    expect(screen.queryByText(`${NUMBER}: ${sentence}`)).not.toBeInTheDocument()
  }

  it('Mark paid says it beside the buttons', async () => {
    mockMark.mockRejectedValue(new Error(sentence))
    await openEditor([makeInvoice({ status: 'sent' })], /^Sent/)

    fireEvent.click(await screen.findByRole('button', { name: 'Mark paid' }))

    await expectSaidOnceInEditor()
  })

  it('Verify with Stripe says it beside the buttons', async () => {
    mockVerify.mockRejectedValue(new Error(sentence))
    await openEditor([makeInvoice({ status: 'processing' })], /^Sent/)

    fireEvent.click(await screen.findByRole('button', { name: 'Verify with Stripe' }))

    await expectSaidOnceInEditor()
  })

  it('Undo manual payment says it beside the buttons', async () => {
    mockUnmark.mockRejectedValue(new Error(sentence))
    await openEditor([makeInvoice({ status: 'paid', paymentMethod: 'manual' })], /^Paid/)

    fireEvent.click(await screen.findByRole('button', { name: 'Undo manual payment' }))

    await expectSaidOnceInEditor()
  })

  it('Payment link says it in its own slot', async () => {
    mockLink.mockRejectedValue(new Error(sentence))
    await openEditor([makeInvoice({ status: 'sent' })], /^Sent/)

    fireEvent.click(await screen.findByRole('button', { name: 'Payment link' }))

    await expectSaidOnceInEditor()
  })

  it('Send says it in its own slot', async () => {
    mockSend.mockRejectedValue(new Error(sentence))
    await openEditor([makeInvoice({ status: 'reviewed' })], /^Reviewed/)

    fireEvent.click(await screen.findByRole('button', { name: /^Send$/ }))

    await expectSaidOnceInEditor()
  })

  it('a covered dates save says it in its own slot', async () => {
    mockConfirm.mockRejectedValue(new Error(sentence))
    await openEditor([makeInvoice({ lineItems: [recurringLine], subtotal: 90, total: 90 })])
    fireEvent.click(await screen.findByRole('button', { name: 'Change covered dates' }))
    fireEvent.change(screen.getByLabelText('Covered period end'), {
      target: { value: '2026-09-20' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))

    await expectSaidOnceInEditor()
  })
})
