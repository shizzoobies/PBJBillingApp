import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { AutopayAttemptSummary, Client, PersistedInvoice } from '../lib/types'
import { formatSentOn } from '../lib/utils'

/**
 * The Processing tab (featreq-3f1d63b6, part a): a bank payment that is still
 * clearing gets its own tab between Sent and Past due, instead of sitting under
 * Sent, and its row says since when the payment has been clearing.
 *
 * The date is an EVENT time - the autopay attempt's own update, else the newest
 * bank-payment acknowledgment that actually went out. Never the invoice's own
 * `updatedAt`, which moves for reasons that have nothing to do with the payment.
 */

vi.mock('../lib/api', () => ({
  chargeAutopayAgainRequest: vi.fn(),
  checkAutopayAttemptRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listAutopayAttemptsRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listAutopayAttemptsRequest, listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockAttempts = vi.mocked(listAutopayAttemptsRequest)

const clients = [
  { id: 'client-acme', name: 'Acme LLC', contactIds: [], planIds: [] },
  { id: 'client-bolt', name: 'Bolt Inc', contactIds: [], planIds: [] },
] as unknown as Client[]

const SENT_AT = '2026-08-28T15:00:00.000Z'
const ACK_OLD = '2026-09-02T15:00:00.000Z'
const ACK_NEW = '2026-09-04T15:00:00.000Z'
const ACK_FAILED_NEWER = '2026-09-06T15:00:00.000Z'
const INVOICE_UPDATED = '2026-09-09T15:00:00.000Z'
const ATTEMPT_UPDATED = '2026-09-01T15:00:00.000Z'

const send = { at: SENT_AT, to: ['ann@acme.com'], subject: 'Invoice', ok: true }
const ack = (at: string, ok = true) => ({
  at,
  to: ['ann@acme.com'],
  subject: 'We received your payment',
  ok,
  kind: 'ack' as const,
})

const invoice = (over: Partial<PersistedInvoice> = {}): PersistedInvoice =>
  ({
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-031',
    status: 'processing',
    lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: SENT_AT,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: INVOICE_UPDATED,
    emailLog: [send],
    ...over,
  }) as PersistedInvoice

const attempt = (over: Partial<AutopayAttemptSummary> = {}): AutopayAttemptSummary => ({
  invoiceId: 'inv-1',
  attemptNo: 1,
  status: 'processing',
  errorCode: null,
  error: null,
  updatedAt: ATTEMPT_UPDATED,
  ...over,
})

async function renderRun(rows: PersistedInvoice[]) {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  return screen.findByRole('tab', { name: /^Processing/ })
}

async function openProcessing(rows: PersistedInvoice[]) {
  fireEvent.click(await renderRun(rows))
  return screen.findByRole('tabpanel')
}

beforeEach(() => {
  mockList.mockReset()
  mockAttempts.mockReset()
  mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [] })
})

describe('the Processing tab', () => {
  it('sits between Sent and Past due', async () => {
    await renderRun([invoice()])
    const labels = screen
      .getAllByRole('tab')
      .map((tab) => (tab.textContent ?? '').replace(/\d+$/, ''))
    expect(labels).toEqual([
      'To review',
      'Reviewed',
      'Sent',
      'Processing',
      'Past due',
      'Payment failed',
      'Paid',
      'Voided',
    ])
  })

  it('holds a processing invoice, with its count, and Sent does not', async () => {
    const processingTab = await renderRun([
      invoice(),
      invoice({ id: 'inv-2', clientId: 'client-bolt', number: 'INV-2026-08-032', status: 'sent' }),
    ])
    expect(processingTab.textContent).toBe('Processing1')
    expect(screen.getByRole('tab', { name: /^Sent/ }).textContent).toBe('Sent1')

    fireEvent.click(screen.getByRole('tab', { name: /^Sent/ }))
    const sentPanel = await screen.findByRole('tabpanel')
    expect(within(sentPanel).getByText('INV-2026-08-032')).toBeInTheDocument()
    expect(within(sentPanel).queryByText('INV-2026-08-031')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /^Processing/ }))
    const processingPanel = await screen.findByRole('tabpanel')
    expect(within(processingPanel).getByText('INV-2026-08-031')).toBeInTheDocument()
    expect(within(processingPanel).queryByText('INV-2026-08-032')).toBeNull()
  })

  it('says "No bank payments clearing." when nothing is clearing', async () => {
    await openProcessing([invoice({ status: 'sent' })])
    expect(await screen.findByText('No bank payments clearing.')).toBeInTheDocument()
  })

  it('offers no bulk action that would sweep a clearing invoice in with the sent ones', async () => {
    await renderRun([
      invoice(),
      invoice({ id: 'inv-2', clientId: 'client-bolt', number: 'INV-2026-08-032', status: 'sent' }),
    ])
    fireEvent.click(screen.getByRole('tab', { name: /^Sent/ }))
    await screen.findByText('INV-2026-08-032')
    // The Sent tab's one bulk control is "Remind all sent" (Alex, 2026-10-14).
    // It lists the Sent tab's invoices and must never reach the Processing
    // tab's: a clearing bank payment is not chased.
    expect(screen.queryByRole('button', { name: /send all|select all/i })).toBeNull()
    expect(screen.queryByText('INV-2026-08-031')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remind all sent' }))
    const confirm = screen.getByRole('group', { name: 'Remind all sent' })
    expect(within(confirm).getByText(/INV-2026-08-032/)).toBeInTheDocument()
    expect(within(confirm).queryByText(/INV-2026-08-031/)).toBeNull()
  })
})

describe('the clearing line on a processing row', () => {
  it('dates from the newest acknowledgment that went out, not a newer failed one or the invoice update', async () => {
    const panel = await openProcessing([
      invoice({
        emailLog: [send, ack(ACK_OLD), ack(ACK_NEW), ack(ACK_FAILED_NEWER, false)],
      }),
    ])
    expect(
      await within(panel).findByText(`Bank payment clearing since ${formatSentOn(ACK_NEW)}`),
    ).toBeInTheDocument()
    expect(within(panel).queryByText(new RegExp(formatSentOn(ACK_FAILED_NEWER)))).toBeNull()
    expect(within(panel).queryByText(new RegExp(formatSentOn(INVOICE_UPDATED)))).toBeNull()
  })

  it('reads "Bank payment clearing" with no date when nothing records when it started', async () => {
    const panel = await openProcessing([invoice({ emailLog: [send, ack(ACK_NEW, false)] })])
    await waitFor(() => expect(mockAttempts).toHaveBeenCalled())
    expect(await within(panel).findByText('Bank payment clearing')).toBeInTheDocument()
    expect(within(panel).queryByText(/Bank payment clearing since/)).toBeNull()
  })

  // The acknowledgment goes out ONCE per invoice (hasLoggedPaymentEmail), so a
  // second bank payment after a failed first one has no ack of its own. The old
  // ack dates the failed payment; showing it would claim a week-old start.
  it('gives no date when the newest acknowledgment belongs to a payment that later failed', async () => {
    const failure = {
      kind: 'payment' as const,
      event: 'failed' as const,
      at: ACK_FAILED_NEWER,
      paymentIntentId: 'pi_1',
    }
    const panel = await openProcessing([invoice({ emailLog: [send, ack(ACK_NEW), failure] })])
    await waitFor(() => expect(mockAttempts).toHaveBeenCalled())
    expect(await within(panel).findByText('Bank payment clearing')).toBeInTheDocument()
    expect(within(panel).queryByText(/Bank payment clearing since/)).toBeNull()
  })

  it.each(['processing', 'succeeded'] as const)(
    'dates from the autopay attempt over an acknowledgment when the attempt is %s',
    async (status) => {
      mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [attempt({ status })] })
      const panel = await openProcessing([invoice({ emailLog: [send, ack(ACK_NEW)] })])
      expect(
        await within(panel).findByText(
          `Bank payment clearing since ${formatSentOn(ATTEMPT_UPDATED)}`,
        ),
      ).toBeInTheDocument()
    },
  )

  it('ignores a failed autopay attempt and falls back to the acknowledgment', async () => {
    mockAttempts.mockResolvedValue({
      chargingEnabled: true,
      attempts: [attempt({ status: 'failed', error: 'declined' })],
    })
    const panel = await openProcessing([invoice({ emailLog: [send, ack(ACK_NEW)] })])
    await waitFor(() => expect(mockAttempts).toHaveBeenCalled())
    expect(
      await within(panel).findByText(`Bank payment clearing since ${formatSentOn(ACK_NEW)}`),
    ).toBeInTheDocument()
  })

  it('is not shown on a sent invoice', async () => {
    await renderRun([invoice({ status: 'sent', emailLog: [send, ack(ACK_NEW)] })])
    fireEvent.click(screen.getByRole('tab', { name: /^Sent/ }))
    await screen.findByText('INV-2026-08-031')
    expect(screen.queryByText(/Bank payment clearing/)).toBeNull()
  })
})
