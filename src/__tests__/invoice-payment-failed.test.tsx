import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'
import { latestInvoiceSend, unresolvedPaymentFailure } from '../lib/utils'

/**
 * The "Payment failed" tab in the month run.
 *
 * A client's bank payment that never verified (or a debit the bank returned)
 * puts the invoice back to `sent` and emails the owners once — and after that
 * the row read "Sent" exactly like a client who had never opened the email.
 * Brittany had nothing to tell her which client to call. The webhook now writes
 * the failure to the invoice's log, and this is the half that shows it.
 *
 * It is a derived tab, not a status: still owed, still Sent underneath. Sending
 * the invoice again is the follow-up, and returns it to the Sent tab.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const clients = [
  { id: 'client-acme', name: 'Acme LLC', contactIds: [], planIds: [] },
] as unknown as Client[]

const send = (over = {}) => ({
  at: '2026-08-28T10:00:00.000Z',
  to: ['ann@acme.com'],
  subject: 'Invoice INV-2026-08-031',
  ok: true,
  providerId: 'ee-1',
  ...over,
})

// 10:00Z, like every date fixture in the sibling suites: `formatSentOn` renders
// LOCAL time and the suite pins no TZ, so a mid-day stamp is the same calendar
// day from UTC-10 to UTC+13. 14:00Z reads "Sep 11" in Sydney.
const failure = (over = {}) => ({
  kind: 'payment' as const,
  event: 'failed' as const,
  at: '2026-09-10T10:00:00.000Z',
  paymentIntentId: 'pi_1',
  detail:
    'Microdeposit verification for this PaymentIntent has timed out. Customer has not verified their bank account within the required 10 day period.',
  ...over,
})

const invoice = (over: Partial<PersistedInvoice> = {}): PersistedInvoice =>
  ({
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-031',
    status: 'sent',
    lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-28T10:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  }) as PersistedInvoice

async function renderRun(rows: PersistedInvoice[]) {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  return {
    tab: async (name: RegExp) => await screen.findByRole('tab', { name }),
    count: (tab: HTMLElement) => within(tab).getByText(/^\d+$/).textContent,
  }
}

beforeEach(() => {
  mockList.mockReset()
})

describe('the Payment failed tab', () => {
  it('sits between Sent and Paid, and holds the invoice whose payment failed instead of Sent', async () => {
    const run = await renderRun([invoice({ emailLog: [send(), failure()] })])
    const tabs = (await screen.findAllByRole('tab')).map((tab) => tab.textContent ?? '')
    expect(tabs.map((text) => text.replace(/\d+$/, ''))).toEqual([
      'To review',
      'Reviewed',
      'Sent',
      'Payment failed',
      'Paid',
      'Voided',
    ])
    expect(run.count(await run.tab(/^Payment failed/))).toBe('1')
    expect(run.count(await run.tab(/^Sent/))).toBe('0')
  })

  it('flags the row in red with the date, carrying Stripe’s reason on hover', async () => {
    await renderRun([invoice({ emailLog: [send(), failure()] })])
    fireEvent.click(await screen.findByRole('tab', { name: /^Payment failed/ }))
    const flag = await screen.findByTitle(/Microdeposit verification/)
    expect(flag.textContent).toMatch(/^Payment failed Sep 10/)
    expect(flag.className).toContain('is-bad')
    // Still Sent underneath — the status pill does not lie about the money.
    expect(screen.getByText('Sent', { selector: '.invoice-status' })).toBeInTheDocument()
  })

  it('tells her what to do when the invoice is opened', async () => {
    await renderRun([invoice({ emailLog: [send(), failure()] })])
    fireEvent.click(await screen.findByRole('tab', { name: /^Payment failed/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-031'))
    // The editor can hold other alerts (a client with no address on file
    // gets one), so the notice is found by what it says, not by its role.
    const alert = (await screen.findByText(/The pay link from that attempt/)).closest('p')
    expect(alert).not.toBeNull()
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert?.textContent).toContain('Payment failed Sep 10')
    expect(alert?.textContent).toContain('Microdeposit verification')
    expect(alert?.textContent).toContain('send the invoice again')
  })

  // The follow-up IS the re-send: fresh link, back in the client's inbox. The
  // invoice goes back to Sent, and the tab empties.
  it('returns the invoice to Sent once it has been sent again', async () => {
    const run = await renderRun([
      invoice({
        emailLog: [send(), failure(), send({ at: '2026-09-11T09:00:00.000Z', providerId: 'ee-2' })],
      }),
    ])
    expect(run.count(await run.tab(/^Payment failed/))).toBe('0')
    expect(run.count(await run.tab(/^Sent/))).toBe('1')
    fireEvent.click(await run.tab(/^Sent/))
    expect(screen.queryByTitle(/Microdeposit verification/)).not.toBeInTheDocument()
  })

  it('leaves a paid invoice in Paid, whatever its history says', async () => {
    const run = await renderRun([
      invoice({ status: 'paid', paidAt: '2026-09-12T10:00:00.000Z', emailLog: [send(), failure()] }),
    ])
    expect(run.count(await run.tab(/^Payment failed/))).toBe('0')
    expect(run.count(await run.tab(/^Paid/))).toBe('1')
  })

  it('has its own empty message, so an empty tab reads as good news', async () => {
    await renderRun([invoice({ emailLog: [send()] })])
    fireEvent.click(await screen.findByRole('tab', { name: /^Payment failed/ }))
    expect(await screen.findByText(/No failed payments this month/)).toBeInTheDocument()
  })
})

/**
 * The selector underneath the tab, on its own. Its one rule: a failure is
 * unresolved while the invoice is still owed and nothing has been SENT since.
 */
describe('unresolvedPaymentFailure', () => {
  it('is the newest failure when nothing has been sent since it', () => {
    const log = [
      send(),
      failure({ at: '2026-09-01T00:00:00.000Z', paymentIntentId: 'pi_1' }),
      failure({ at: '2026-09-10T00:00:00.000Z', paymentIntentId: 'pi_2' }),
    ]
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: log })?.paymentIntentId).toBe('pi_2')
  })

  it('is answered by a send that came after it', () => {
    const log = [send(), failure(), send({ at: '2026-09-11T00:00:00.000Z', providerId: 'ee-2' })]
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: log })).toBeNull()
  })

  // A failed send (ok: false) never reached the client — it does not count as
  // a follow-up, so the failure stays.
  it('is not answered by a send that did not go out', () => {
    const log = [
      send(),
      failure(),
      send({ at: '2026-09-11T00:00:00.000Z', ok: false, error: 'refused', providerId: 'ee-2' }),
    ]
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: log })).not.toBeNull()
  })

  it('counts an overdue invoice as still owed, and nothing else', () => {
    const log = [send(), failure()]
    expect(unresolvedPaymentFailure({ status: 'overdue', emailLog: log })).not.toBeNull()
    for (const status of ['draft', 'reviewed', 'processing', 'paid', 'void'] as const) {
      expect(unresolvedPaymentFailure({ status, emailLog: log })).toBeNull()
    }
  })

  it('is nothing on an invoice with no log, or a log with no failure', () => {
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: undefined })).toBeNull()
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: [send()] })).toBeNull()
  })

  // The send selector must not mistake a payment entry for a send: it has no
  // `ok`, and the "Sent … to …" line would otherwise crash or lie.
  it('is skipped by latestInvoiceSend', () => {
    const log = [send({ providerId: 'ee-1' }), failure()]
    expect(latestInvoiceSend(log)?.providerId).toBe('ee-1')
  })
})
