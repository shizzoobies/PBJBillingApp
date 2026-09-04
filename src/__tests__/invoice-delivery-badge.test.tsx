import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'
import { latestInvoiceDelivery, latestInvoiceSend } from '../lib/utils'

/**
 * The delivery badge beside "Sent … to …".
 *
 * Invoices were landing in clients' spam folders and nobody could tell — the
 * run said "Sent" whether the message arrived, bounced, or was filed as junk.
 * The Resend webhook now writes what happened into the same email log, and this
 * is the half of it that shows.
 *
 * The badge says nothing when there is nothing to say: an invoice sent before
 * any of this existed, or one whose events have not landed yet, looks exactly
 * as it always did.
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
  at: '2026-08-11T10:00:00.000Z',
  to: ['ann@acme.com'],
  subject: 'Invoice INV-2026-08-001',
  ok: true,
  providerId: 'ee-1',
  ...over,
})

const delivery = (over = {}) => ({
  kind: 'delivery' as const,
  event: 'delivered' as const,
  at: '2026-08-11T10:00:06.000Z',
  providerId: 'ee-1',
  to: ['ann@acme.com'],
  detail: '',
  ...over,
})

const invoice = (over: Partial<PersistedInvoice> = {}): PersistedInvoice =>
  ({
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'sent',
    lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-11T10:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  }) as PersistedInvoice

/** Render the run, switch to Sent, and open the invoice's editor. */
async function openEditor(rows: PersistedInvoice[]) {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: /^Sent/ }))
  fireEvent.click(await screen.findByText(rows[0].number as string))
}

beforeEach(() => {
  mockList.mockReset()
})

describe('the delivery badge in the month run', () => {
  it('says Delivered next to the send it belongs to', async () => {
    await openEditor([invoice({ emailLog: [send(), delivery()] })])
    expect(await screen.findByText(/Sent Aug 11 to 1 recipient/)).toBeInTheDocument()
    expect(screen.getByText('Delivered')).toBeInTheDocument()
  })

  it('shows nothing at all when no delivery event has arrived', async () => {
    await openEditor([invoice({ emailLog: [send()] })])
    expect(await screen.findByText(/Sent Aug 11 to 1 recipient/)).toBeInTheDocument()
    for (const label of ['Delivered', 'Delayed', 'Bounced', 'Marked as spam']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  // The two that need a person, with the provider's own words on hover — "why
  // did it bounce" is the whole question, and it does not fit in a badge.
  it('carries the reason on a bounce, and names a spam complaint plainly', async () => {
    await openEditor([
      invoice({
        emailLog: [send(), delivery({ event: 'bounced', detail: 'mailbox does not exist' })],
      }),
    ])
    const badge = await screen.findByText('Bounced')
    expect(badge).toHaveAttribute('title', 'mailbox does not exist')
    expect(badge.className).toContain('is-bad')
  })

  it('calls a complaint "Marked as spam", in words Brittany can act on', async () => {
    await openEditor([invoice({ emailLog: [send(), delivery({ event: 'complained' })] })])
    expect(await screen.findByText('Marked as spam')).toBeInTheDocument()
  })
})

/**
 * The selectors underneath. An invoice sent three times has three threads of
 * events in one log, and the badge must describe the LATEST send rather than
 * whichever event happened to arrive last.
 */
describe('latestInvoiceSend / latestInvoiceDelivery', () => {
  it('reads the newest successful send, skipping failures and delivery entries', () => {
    const log = [
      send({ providerId: 'ee-1' }),
      send({ ok: false, error: 'refused', providerId: 'ee-2' }),
      delivery({ providerId: 'ee-1' }),
      send({ at: '2026-08-12T10:00:00.000Z', providerId: 'ee-3' }),
    ]
    expect(latestInvoiceSend(log)?.providerId).toBe('ee-3')
  })

  // The bounce belongs to a message sent to an address that has since been
  // fixed. Showing it against the re-send would be worse than showing nothing.
  it('ignores an event belonging to an earlier send', () => {
    const log = [
      send({ providerId: 'ee-1' }),
      delivery({ event: 'bounced', providerId: 'ee-1' }),
      send({ at: '2026-08-12T10:00:00.000Z', providerId: 'ee-2' }),
    ]
    expect(latestInvoiceDelivery(log)).toBeNull()
  })

  it('takes the newest event about that send, so delayed then delivered reads delivered', () => {
    const log = [
      send(),
      delivery({ event: 'delayed', at: '2026-08-11T10:00:02.000Z' }),
      delivery({ event: 'delivered', at: '2026-08-11T10:04:00.000Z' }),
    ]
    expect(latestInvoiceDelivery(log)?.event).toBe('delivered')
  })

  it('claims nothing about a send made before provider ids were recorded', () => {
    const log = [send({ providerId: undefined }), delivery({ providerId: null })]
    expect(latestInvoiceDelivery(log)).toBeNull()
  })

  it('copes with an invoice that has no email log at all', () => {
    expect(latestInvoiceSend(undefined)).toBeNull()
    expect(latestInvoiceDelivery(undefined)).toBeNull()
  })
})
