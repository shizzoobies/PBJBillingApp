import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type Contact, type PersistedInvoice } from '../lib/types'

/**
 * The prepayment send guard (billing period, stage 2), as the month run shows it.
 *
 * A later month of a billing-period client whose period's prepayment invoice is not
 * paid would bill the month again. The month list marks such a row (a small flag), but
 * the page never decides from it: Send goes to the server, which refuses with 409
 * `prepayment_unpaid` and the editor turns that into the question - a "Send anyway"
 * (reason 'unpaid') that repeats the send with `{ allowUnpaidPrepayment: true }`, or
 * just the sentence when the anchor is paid but this invoice never drew it
 * ('not_applied': Apply credit first). The rule itself lives in lib/billing-period.js.
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
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, sendInvoiceRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const MESSAGE =
  'INV-2026-10-001 carries the prepayment for November 2026 and has not been paid yet (it is Sent), so sending this invoice would bill that month again.'

const clients = [
  {
    id: 'client-q',
    name: 'Quarterly Co',
    contact: '',
    billingMode: 'subscription',
    monthlyRate: 500,
    billingPeriodMonths: 3,
    periodAnchorMonth: '2026-10',
    hourlyRate: 0,
    planIds: [],
    contactIds: ['contact-ann'],
  },
] as unknown as Client[]
const contacts: Contact[] = [{ id: 'contact-ann', name: 'Ann', email: 'ann@q.test' }]

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-nov',
    clientId: 'client-q',
    period: '2026-11',
    kind: 'monthly',
    number: 'INV-2026-11-001',
    status: 'reviewed',
    lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 500 }],
    subtotal: 500,
    total: 500,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: 'u1',
    ...over,
  } as PersistedInvoice
}

const marked = (over: Partial<PersistedInvoice> = {}) =>
  makeInvoice({
    unpaidPrepayment: {
      message: MESSAGE,
      month: '2026-11',
      anchorInvoiceId: 'inv-oct',
      anchorInvoiceNumber: 'INV-2026-10-001',
    },
    ...over,
  })

async function openEditor(row: PersistedInvoice) {
  mockList.mockResolvedValue([row])
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
  fireEvent.click(await screen.findByText(row.number as string))
}

const sendButton = () => screen.getByRole('button', { name: 'Send' })

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
  mockUpdate.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the month run row', () => {
  it('flags an unsent later month whose prepayment is not paid, with the sentence on hover', async () => {
    mockList.mockResolvedValue([marked()])
    render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
    const flag = await screen.findByText('Prepayment unpaid')
    expect(flag.closest('.invoice-run-flag')).toHaveAttribute('title', MESSAGE)
  })

  it('shows no flag on an invoice the list did not mark', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
    await screen.findByText('INV-2026-11-001')
    expect(screen.queryByText('Prepayment unpaid')).toBeNull()
  })
})

describe('Send on a marked invoice', () => {
  // M-8: the list's mark can be stale, so the page never decides locally: every send
  // goes to the server, which decides on the rows as they are now.
  it('sends to the server first, then asks with the sentence and a Send anyway', async () => {
    await openEditor(marked())
    mockSend.mockRejectedValueOnce(new ApiError(409, MESSAGE, 'prepayment_unpaid', 'unpaid'))
    fireEvent.click(sendButton())
    const ask = await screen.findByRole('alert')
    expect(ask).toHaveTextContent(MESSAGE)
    expect(screen.getByRole('button', { name: 'Send anyway' })).toBeEnabled()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith('inv-nov', undefined)
  })

  it('Send anyway repeats the send with allowUnpaidPrepayment', async () => {
    await openEditor(marked())
    mockSend.mockRejectedValueOnce(new ApiError(409, MESSAGE, 'prepayment_unpaid', 'unpaid'))
    mockSend.mockResolvedValueOnce({ invoice: makeInvoice({ status: 'sent', sentAt: '2026-11-30T12:00:00.000Z' }) })
    fireEvent.click(sendButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Send anyway' }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2))
    expect(mockSend).toHaveBeenLastCalledWith('inv-nov', undefined, undefined, { allowUnpaidPrepayment: true })
  })

  it('Not now closes the question and sends nothing more', async () => {
    await openEditor(marked())
    mockSend.mockRejectedValueOnce(new ApiError(409, MESSAGE, 'prepayment_unpaid', 'unpaid'))
    fireEvent.click(sendButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('a stale mark does not stop a send the server now allows', async () => {
    // The anchor was paid and the credit applied since the list loaded.
    await openEditor(marked())
    mockSend.mockResolvedValueOnce({ invoice: makeInvoice({ status: 'sent', sentAt: '2026-11-30T12:00:00.000Z' }) })
    fireEvent.click(sendButton())
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull()
  })
})

describe('the paid-but-not-applied hold (I-1)', () => {
  const NOT_APPLIED =
    "This month was prepaid on October 2026's invoice, but the prepayment has not been applied to this invoice. Apply credit on account, or Void & regenerate, before sending."

  it('shows its sentence with NO Send anyway (the server never lifts it) and re-reads the month', async () => {
    await openEditor(makeInvoice())
    mockSend.mockRejectedValueOnce(new ApiError(409, NOT_APPLIED, 'prepayment_unpaid', 'not_applied'))
    const listCalls = mockList.mock.calls.length
    fireEvent.click(sendButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_APPLIED)
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull()
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument()
    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(listCalls))
    // The re-read does not remount the editor: the sentence is still there.
    expect(screen.getByRole('alert')).toHaveTextContent(NOT_APPLIED)
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  const CLEARING =
    "This month was prepaid on October 2026's invoice and that payment is still clearing. Once it settles, Apply credit on account (or Void & regenerate) and send then."

  it('R-3: a clearing anchor shows its sentence with only OK (no Send anyway) and keeps it through the re-read', async () => {
    await openEditor(makeInvoice())
    mockSend.mockRejectedValueOnce(new ApiError(409, CLEARING, 'prepayment_unpaid', 'processing'))
    const listCalls = mockList.mock.calls.length
    fireEvent.click(sendButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(CLEARING)
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull()
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument()
    // The month is re-read, and the sentence is still on screen afterwards.
    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(listCalls))
    expect(screen.getByRole('alert')).toHaveTextContent(CLEARING)
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('labels the row flag "Prepayment clearing" for the processing reason', async () => {
    mockList.mockResolvedValue([
      marked({
        unpaidPrepayment: {
          message: CLEARING,
          reason: 'processing',
          month: '2026-11',
          anchorInvoiceId: 'inv-oct',
          anchorInvoiceNumber: 'INV-2026-10-001',
        },
      }),
    ])
    render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
    const flag = await screen.findByText('Prepayment clearing')
    expect(flag.closest('.invoice-run-flag')).toHaveAttribute('title', CLEARING)
  })

  it('labels the row flag "Prepayment not applied" for that reason', async () => {
    mockList.mockResolvedValue([
      marked({
        unpaidPrepayment: {
          message: NOT_APPLIED,
          reason: 'not_applied',
          month: '2026-11',
          anchorInvoiceId: 'inv-oct',
          anchorInvoiceNumber: 'INV-2026-10-001',
        },
      }),
    ])
    render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
    const flag = await screen.findByText('Prepayment not applied')
    expect(flag.closest('.invoice-run-flag')).toHaveAttribute('title', NOT_APPLIED)
  })
})

describe('the server backstop (a list that was stale)', () => {
  it('turns 409 prepayment_unpaid into the question instead of an error, on an unmarked row', async () => {
    await openEditor(makeInvoice())
    mockSend.mockRejectedValueOnce(new ApiError(409, MESSAGE, 'prepayment_unpaid', 'unpaid'))
    fireEvent.click(sendButton())
    expect(await screen.findByRole('button', { name: 'Send anyway' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(MESSAGE)
    // The ordinary send went out WITHOUT the override first.
    expect(mockSend).toHaveBeenCalledWith('inv-nov', undefined)

    mockSend.mockResolvedValueOnce({ invoice: makeInvoice({ status: 'sent', sentAt: '2026-11-30T12:00:00.000Z' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2))
    expect(mockSend).toHaveBeenLastCalledWith('inv-nov', undefined, undefined, { allowUnpaidPrepayment: true })
  })
})

describe('the flag follows a save (R-4)', () => {
  const NOT_APPLIED =
    "This month was prepaid on October 2026's invoice, but the prepayment has not been applied to this invoice. Apply credit on account, or Void & regenerate, before sending."
  const heldAfterSave = () =>
    marked({
      updatedAt: 'u2',
      unpaidPrepayment: {
        message: NOT_APPLIED,
        reason: 'not_applied',
        month: '2026-11',
        anchorInvoiceId: 'inv-oct',
        anchorInvoiceNumber: 'INV-2026-10-001',
      },
    })

  async function saveAnEdit() {
    fireEvent.change(screen.getAllByLabelText('Amount')[0], { target: { value: '450' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  }

  it('re-reads the month after a save on a billing-period client, so a row the save newly holds is flagged', async () => {
    await openEditor(makeInvoice())
    expect(screen.queryByText('Prepayment not applied')).toBeNull()
    mockUpdate.mockResolvedValueOnce(makeInvoice({ updatedAt: 'u2', lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 450 }] }))
    mockList.mockResolvedValue([heldAfterSave()])
    const listCalls = mockList.mock.calls.length
    await saveAnEdit()
    expect(await screen.findByText('Prepayment not applied')).toBeInTheDocument()
    expect(mockList.mock.calls.length).toBeGreaterThan(listCalls)
  })

  it('does not re-read the month after a save on an ordinary client', async () => {
    mockList.mockResolvedValue([makeInvoice({ clientId: 'client-plain' })])
    render(
      <InvoiceMonthRun
        clients={[
          ...clients,
          { id: 'client-plain', name: 'Plain Co', contact: '', billingMode: 'subscription', monthlyRate: 500, hourlyRate: 0, planIds: [], contactIds: ['contact-ann'] } as unknown as Client,
        ]}
        contacts={contacts}
        onPrint={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
    fireEvent.click(await screen.findByText('INV-2026-11-001'))
    mockUpdate.mockResolvedValueOnce(makeInvoice({ clientId: 'client-plain', updatedAt: 'u2' }))
    const listCalls = mockList.mock.calls.length
    await saveAnEdit()
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockList.mock.calls.length).toBe(listCalls)
  })
})
