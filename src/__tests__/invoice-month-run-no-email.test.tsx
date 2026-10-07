import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { type Client, type Contact, type PersistedInvoice } from '../lib/types'

/**
 * "Generate the invoice but never email it" (featreq-21d0bba8 answer 8,
 * Rivercity) in the month run.
 *
 * The invoice is generated and reviewed like anyone's, but there is nothing to
 * send: no Send, Send again, Send to other addresses or Payment link, no
 * missing-address warning, and Mark reviewed is the last step - the SERVER
 * marks it sent (db/store-staleness.test.mjs), so what is pinned here is what
 * the page offers and what it does with the invoice the server answers with.
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
  setClientInvoiceNote: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const NUMBER = 'INV-2026-08-001'
const NOTE = 'Not emailed - delivered outside the app'

const client = (over: Partial<Client> = {}): Client =>
  ({
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 0,
    planIds: [],
    contactIds: ['contact-ann'],
    ...over,
  }) as Client

const contacts: Contact[] = [{ id: 'contact-ann', name: 'Ann Acme', email: 'ann@acme.test' }]

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: NUMBER,
    status: 'draft',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 600 }],
    subtotal: 600,
    total: 600,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    emailLog: [],
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: '2026-08-31T12:00:00.000Z',
    ...over,
  } as PersistedInvoice
}

const TABS = { draft: /^To review/, reviewed: /^Reviewed/, sent: /^Sent/ } as const

async function openRun(
  invoice: PersistedInvoice,
  { clients = [client({ invoiceNoEmail: true })], tab = 'draft' as keyof typeof TABS } = {},
) {
  mockList.mockResolvedValue([invoice])
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: TABS[tab] }))
  return screen.findByText(NUMBER)
}

const editor = () => {
  const node = document.querySelector('.invoice-run-editor')
  if (!node) throw new Error('the editor is not open')
  return within(node as HTMLElement)
}
const open = async (invoice: PersistedInvoice, options?: Parameters<typeof openRun>[1]) => {
  fireEvent.click(await openRun(invoice, options))
  await screen.findByLabelText('Note to the client')
}

beforeEach(() => {
  for (const mock of [mockList, mockUpdate]) mock.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a never-email client on the month run', () => {
  it('says on the row that it is not emailed, and shows no recipient count', async () => {
    await openRun(makeInvoice())
    const row = screen.getByText(NUMBER).closest('li') as HTMLElement
    expect(row).toHaveTextContent(NOTE)
    expect(row).not.toHaveTextContent(/1 recipient/i)
  })

  it('does not warn about a missing address - there is nothing to send to', async () => {
    await openRun(makeInvoice(), { clients: [client({ invoiceNoEmail: true, contactIds: [] })] })
    expect(screen.queryByText('No email on file')).toBeNull()
  })

  it('an ordinary client still shows its recipients and the missing-address flag', async () => {
    await openRun(makeInvoice(), { clients: [client()] })
    const row = screen.getByText(NUMBER).closest('li') as HTMLElement
    expect(row).toHaveTextContent(/1 recipient/i)
    expect(row).not.toHaveTextContent(NOTE)
    expect(row).not.toHaveTextContent('Not emailed')
  })

  it('a draft editor has Mark reviewed and no Send, Send again, Send to other addresses or Payment link', async () => {
    await open(makeInvoice())
    expect(editor().getByRole('button', { name: 'Mark reviewed' })).toBeEnabled()
    expect(editor().queryByRole('button', { name: /^Send/ })).toBeNull()
    expect(editor().queryByRole('button', { name: /Send again/i })).toBeNull()
    expect(editor().queryByRole('button', { name: /^Payment link/ })).toBeNull()
    // The recipients block is replaced by the plain statement.
    expect(editor().queryByText(/^Goes to/)).toBeNull()
    expect(document.querySelector('.invoice-run-editor')).toHaveTextContent(NOTE)
  })

  it('Mark reviewed saves the review, and the invoice the server answers with (Sent) moves tabs', async () => {
    await open(makeInvoice())
    mockUpdate.mockResolvedValue(
      makeInvoice({
        status: 'sent',
        sentAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-01T12:00:00.000Z',
        emailLog: [
          {
            kind: 'not-emailed',
            at: '2026-09-01T12:00:00.000Z',
            to: [],
            subject: 'Marked sent - delivered outside the app',
            ok: true,
          } as never,
        ],
      }),
    )

    fireEvent.click(editor().getByRole('button', { name: 'Mark reviewed' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate.mock.calls[0][1]).toEqual({ status: 'reviewed' })
    // Gone from the To review tab, present under Sent.
    await waitFor(() => expect(screen.queryByText(NUMBER)).toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: /^Sent/ }))
    expect(await screen.findByText(NUMBER)).toBeInTheDocument()
  })

  it('a reviewed invoice (reviewed before the switch went on) still offers Mark reviewed to finish', async () => {
    await open(makeInvoice({ status: 'reviewed' }), { tab: 'reviewed' })
    expect(editor().getByRole('button', { name: 'Mark reviewed' })).toBeEnabled()
    expect(editor().getByRole('button', { name: 'Back to draft' })).toBeEnabled()
  })

  it('a ordinary client’s reviewed invoice does not get a second Mark reviewed', async () => {
    await open(makeInvoice({ status: 'reviewed' }), { clients: [client()], tab: 'reviewed' })
    expect(editor().queryByRole('button', { name: 'Mark reviewed' })).toBeNull()
  })

  it('a sent invoice has no Send again and no Payment link, and says when it was marked sent', async () => {
    await open(
      makeInvoice({
        status: 'sent',
        sentAt: '2026-09-01T12:00:00.000Z',
        emailLog: [
          {
            kind: 'not-emailed',
            at: '2026-09-01T12:00:00.000Z',
            to: [],
            subject: 'Marked sent - delivered outside the app',
            ok: true,
          } as never,
        ],
      }),
      { tab: 'sent' },
    )
    expect(editor().queryByRole('button', { name: /^Send/ })).toBeNull()
    expect(editor().queryByRole('button', { name: /^Payment link/ })).toBeNull()
    expect(editor().getByRole('button', { name: 'Mark paid' })).toBeInTheDocument()
    expect(document.querySelector('.invoice-run-editor')).toHaveTextContent(/marked sent/i)
  })

  it('an edit after it was marked sent is just saved: no Send again notice', async () => {
    await open(
      makeInvoice({
        status: 'sent',
        sentAt: '2026-09-01T12:00:00.000Z',
        // Even if the server had marked it (the client was emailed before the switch).
        changedSinceSent: true,
      }),
      { tab: 'sent' },
    )
    expect(editor().queryByRole('button', { name: /Send again/i })).toBeNull()
    expect(document.querySelector('.invoice-run-resend')).toBeEmptyDOMElement()
  })

  it('an ordinary client’s sent invoice still has Send again and a Payment link', async () => {
    await open(
      makeInvoice({
        status: 'sent',
        sentAt: '2026-09-01T12:00:00.000Z',
        emailLog: [
          { at: '2026-09-01T12:00:00.000Z', to: ['ann@acme.test'], subject: 'Invoice', ok: true },
        ],
      }),
      { clients: [client()], tab: 'sent' },
    )
    expect(editor().getByRole('button', { name: 'Send again' })).toBeInTheDocument()
    expect(editor().getByRole('button', { name: /^Payment link/ })).toBeInTheDocument()
  })
})

// Credit on account stage 1d: a never-email invoice a credit covers in full is
// stamped sent and THEN paid by credit; when the second step failed it is left
// Sent at $0, and Mark reviewed is how she finishes it (the server runs only the
// paid stamp: lib/invoice-paid-by-credit-routes.test.mjs).
describe('a never-email invoice left Sent at $0 by a failed paid stamp', () => {
  const sentStamp = {
    kind: 'not-emailed',
    at: '2026-09-01T12:00:00.000Z',
    to: [],
    subject: 'Marked sent - delivered outside the app',
    ok: true,
  } as never
  const covered = (over: Partial<PersistedInvoice> = {}) =>
    makeInvoice({
      status: 'sent',
      sentAt: '2026-09-01T12:00:00.000Z',
      emailLog: [sentStamp],
      lineItems: [
        { kind: 'custom', label: 'Bookkeeping', detail: '', amount: 600 },
        { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -600, draws: [] } as never,
      ],
      total: 0,
      ...over,
    })

  it('offers Mark reviewed with the finish wording, and Mark reviewed sends just the status', async () => {
    await open(covered(), { tab: 'sent' })
    const button = editor().getByRole('button', { name: 'Mark reviewed' })
    expect(button).toHaveAttribute('title', 'Finish marking this paid by credit')
    expect(document.querySelector('.invoice-run-editor')).toHaveTextContent('Finish marking this paid by credit.')

    mockUpdate.mockResolvedValue(covered({ status: 'paid', paymentMethod: 'credit', paidAt: '2026-09-01T12:00:00.000Z' }))
    fireEvent.click(button)

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate.mock.calls[0][1]).toEqual({ status: 'reviewed' })
  })

  it('offers nothing of the kind on a sent invoice that still owes money', async () => {
    await open(makeInvoice({ status: 'sent', sentAt: '2026-09-01T12:00:00.000Z', emailLog: [sentStamp] }), { tab: 'sent' })
    expect(editor().queryByRole('button', { name: 'Mark reviewed' })).toBeNull()
    expect(document.querySelector('.invoice-run-editor')).not.toHaveTextContent('Finish marking')
  })

  it('offers nothing of the kind on a sent $0 invoice with no credit line', async () => {
    await open(
      covered({ lineItems: [{ kind: 'custom', label: 'Nothing', detail: '', amount: 0 }] }),
      { tab: 'sent' },
    )
    expect(editor().queryByRole('button', { name: 'Mark reviewed' })).toBeNull()
  })

  it('an ordinary client’s sent covered invoice gets no Mark reviewed either', async () => {
    await open(covered(), { clients: [client()], tab: 'sent' })
    expect(editor().queryByRole('button', { name: 'Mark reviewed' })).toBeNull()
  })
})
