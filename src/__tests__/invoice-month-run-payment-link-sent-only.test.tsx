import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type Contact, type PersistedInvoice } from '../lib/types'

/**
 * "Payment link" is only for an invoice that has been sent.
 *
 * All the button does is hand back the invoice's link again, so it is offered on
 * a sent invoice and nowhere before that. It used to be on every invoice that
 * was not void, and pressing it on a draft marked the draft Sent — skipping
 * review and the covered-dates check. The server refuses it too (pinned in
 * invoice-pay-link-routes.test.ts); this is the screen half.
 *
 * NOT shown rather than shown-but-disabled, because the buttons in that row are
 * not consistent: Mark reviewed, Back to draft, Mark paid and Verify with Stripe
 * each appear only on the statuses they apply to, and only Send is kept on screen
 * with a reason.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { createInvoicePaymentLinkRequest, listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockLink = vi.mocked(createInvoicePaymentLinkRequest)

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

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'draft',
    lineItems: [
      {
        kind: 'hourly',
        label: 'Billable hours — Lisa',
        detail: '',
        amount: 600,
      },
    ],
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

async function openEditor(row: PersistedInvoice, tab?: RegExp) {
  mockList.mockResolvedValue([row])
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
  // The editor is up once its Print button is.
  await screen.findByRole('button', { name: /Print/ })
}

const paymentLink = () => screen.queryByRole('button', { name: 'Payment link' })

beforeEach(() => {
  mockList.mockReset()
  mockLink.mockReset()
})

describe('the Payment link button', () => {
  const notOffered: ReadonlyArray<[PersistedInvoice['status'], RegExp | undefined]> = [
    ['draft', undefined],
    ['reviewed', /^Reviewed/],
    ['processing', /^Sent/],
    ['paid', /^Paid/],
    ['void', /^Voided/],
  ]

  for (const [status, tab] of notOffered) {
    it(`is not shown on a ${status} invoice`, async () => {
      await openEditor(makeInvoice({ status }), tab)
      expect(paymentLink()).not.toBeInTheDocument()
      // Not merely disabled: nothing of it is on the screen at all.
      expect(screen.queryByText('Payment link')).not.toBeInTheDocument()
    })
  }

  it('is offered on a sent invoice, and hands back the link', async () => {
    mockLink.mockResolvedValue({
      url: 'https://app.test/pay/tok_1',
      invoice: makeInvoice({
        status: 'sent',
        sentAt: '2026-09-02T10:00:00.000Z',
      }),
    })
    await openEditor(makeInvoice({ status: 'sent', sentAt: '2026-09-02T10:00:00.000Z' }), /^Sent/)
    const button = screen.getByRole('button', { name: 'Payment link' })
    expect(button).toBeEnabled()

    fireEvent.click(button)

    expect(await screen.findByDisplayValue('https://app.test/pay/tok_1')).toBeInTheDocument()
    expect(mockLink).toHaveBeenCalledWith('inv-1')
  })

  it('is offered on a past-due invoice, which is still a sent one', async () => {
    await openEditor(
      makeInvoice({
        status: 'sent',
        sentAt: '2020-01-02T10:00:00.000Z',
        dueDate: '2020-02-01',
        emailLog: [
          {
            at: '2020-01-02T10:00:00.000Z',
            to: ['ann@acme.test'],
            subject: 'Invoice INV-2026-08-001',
            ok: true,
            providerId: 'ee-1',
          },
        ],
      }),
      /^Past due/,
    )
    expect(screen.getByRole('button', { name: 'Payment link' })).toBeEnabled()
  })

  it('is not offered where there is nothing owed, even on a sent invoice', async () => {
    await openEditor(
      makeInvoice({
        status: 'sent',
        total: 0,
        subtotal: 0,
        sentAt: '2026-09-02T10:00:00.000Z',
      }),
      /^Sent/,
    )
    expect(paymentLink()).not.toBeInTheDocument()
  })
})

/**
 * The server can refuse a Payment link the screen offered: the invoice moved on
 * (paid, or a bank payment started) in another tab since this row was drawn. Those
 * refusals reload the month, like Send, so the row shows what the invoice is NOW;
 * an ordinary refusal does not. The sentence shows once either way.
 */
describe('a refused Payment link', () => {
  const NUMBER = 'INV-2026-08-001'
  const sentAt = '2026-09-02T10:00:00.000Z'
  const sent = () => makeInvoice({ status: 'sent', sentAt })

  const cases: ReadonlyArray<[string, string, PersistedInvoice['status']]> = [
    [
      'invoice_payment_processing',
      'A bank payment is already going through on this invoice, so it does not need a payment link.',
      'processing',
    ],
    ['invoice_locked', 'This invoice has been paid, so it does not need a payment link.', 'paid'],
  ]

  for (const [code, sentence, status] of cases) {
    it(`${code}: reloads the month once, the row shows what it is now, and the sentence is said once`, async () => {
      mockLink.mockRejectedValue(new ApiError(409, sentence, code))
      await openEditor(sent(), /^Sent/)
      expect(mockList).toHaveBeenCalledTimes(1)
      // What the server holds now. A paid invoice leaves the Sent tab.
      mockList.mockResolvedValue([
        makeInvoice({
          status,
          sentAt,
          paidAt: status === 'paid' ? '2026-09-05T00:00:00.000Z' : null,
          updatedAt: '2026-09-05T00:00:00.000Z',
        }),
      ])

      fireEvent.click(screen.getByRole('button', { name: 'Payment link' }))

      await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
      expect(await screen.findByText(sentence, { exact: false })).toBeInTheDocument()
      expect(screen.getAllByText(new RegExp(sentence.slice(0, 30)))).toHaveLength(1)
      // The row now shows its real state, and no Payment link is offered on it.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Payment link' })).toBeNull())
    })
  }

  it('payment_link_needs_sent: does not reload, and says it in the editor', async () => {
    const sentence =
      'A payment link is only for an invoice that has been sent. Send the invoice first.'
    mockLink.mockRejectedValue(new ApiError(409, sentence, 'payment_link_needs_sent'))
    await openEditor(sent(), /^Sent/)

    fireEvent.click(screen.getByRole('button', { name: 'Payment link' }))

    const editor = document.querySelector('.invoice-run-editor') as HTMLElement
    expect(await within(editor).findByText(sentence)).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(`${NUMBER}: ${sentence}`)).not.toBeInTheDocument()
  })

  // The wire half: the code has to survive the trip, or the screen cannot tell
  // these refusals from an ordinary one.
  it('the request carries the code the server answered with', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'invoice_locked',
              message: 'This invoice has been paid, so it does not need a payment link.',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
    try {
      await expect(actual.createInvoicePaymentLinkRequest('inv-1')).rejects.toMatchObject({
        status: 409,
        code: 'invoice_locked',
        message: 'This invoice has been paid, so it does not need a payment link.',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
