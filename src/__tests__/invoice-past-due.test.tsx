import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'
import { localDateOnly, pastDueInvoice } from '../lib/utils'

/**
 * The "Past due" tab in the month run.
 *
 * Every invoice carries a due date the client never sees: thirty days from the
 * day it was first emailed, the line after which the firm chases. Nothing in
 * the app used to read it — a bill thirty days late looked exactly like one
 * sent yesterday, and Brittany had to open each one to find out.
 *
 * Like "Payment failed", this is a DERIVED tab, not a status. `overdue` exists
 * in the status union and nothing writes it; being late is recomputed from
 * today's date every render. That is what makes it free of migrations and
 * impossible to leave stale.
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

/**
 * A due date `days` from today, in the same YYYY-MM-DD the run compares against.
 * Relative rather than fixed: "past due" is a question about the day the test
 * runs, so a fixture pinned to a calendar date would answer differently in six
 * months.
 */
const dayFromToday = (days: number) => {
  const base = new Date(`${localDateOnly()}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

const send = (over = {}) => ({
  at: '2026-08-28T10:00:00.000Z',
  to: ['ann@acme.com'],
  subject: 'Invoice INV-2026-08-031',
  ok: true,
  providerId: 'ee-1',
  ...over,
})

const failure = (over = {}) => ({
  kind: 'payment' as const,
  event: 'failed' as const,
  at: '2026-09-10T10:00:00.000Z',
  paymentIntentId: 'pi_1',
  detail: 'The bank returned the debit.',
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
    dueDate: dayFromToday(-40),
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-28T10:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    emailLog: [send()],
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

describe('the Past due tab', () => {
  it('sits between Sent and Payment failed, and holds the late invoice instead of Sent', async () => {
    const run = await renderRun([invoice()])
    const tabs = (await screen.findAllByRole('tab')).map((tab) => tab.textContent ?? '')
    expect(tabs.map((text) => text.replace(/\d+$/, ''))).toEqual([
      'To review',
      'Reviewed',
      'Sent',
      'Past due',
      'Payment failed',
      'Paid',
      'Voided',
    ])
    expect(run.count(await run.tab(/^Past due/))).toBe('1')
    expect(run.count(await run.tab(/^Sent/))).toBe('0')
  })

  it('flags the row in red with the days, naming the line on hover', async () => {
    await renderRun([invoice()])
    fireEvent.click(await screen.findByRole('tab', { name: /^Past due/ }))
    const flag = await screen.findByTitle(/^Past-due line was /)
    expect(flag.textContent).toBe('Past due · 40 days')
    expect(flag.className).toContain('is-bad')
    // Still Sent underneath — the status pill does not invent a status.
    expect(screen.getByText('Sent', { selector: '.invoice-status' })).toBeInTheDocument()
  })

  it('says "1 day" on the first day past the line', async () => {
    await renderRun([invoice({ dueDate: dayFromToday(-1) })])
    fireEvent.click(await screen.findByRole('tab', { name: /^Past due/ }))
    const flag = await screen.findByTitle(/^Past-due line was /)
    expect(flag.textContent).toBe('Past due · 1 day')
  })

  // Due TODAY is not late: the client has the day.
  it('leaves an invoice due today in Sent', async () => {
    const run = await renderRun([invoice({ dueDate: dayFromToday(0) })])
    expect(run.count(await run.tab(/^Past due/))).toBe('0')
    expect(run.count(await run.tab(/^Sent/))).toBe('1')
  })

  it('leaves an invoice with no due date in Sent', async () => {
    const run = await renderRun([invoice({ dueDate: null })])
    expect(run.count(await run.tab(/^Past due/))).toBe('0')
    expect(run.count(await run.tab(/^Sent/))).toBe('1')
  })

  /**
   * Both signals at once. The failure wins: the client tried and something
   * broke, which is a phone call, where past due may just be a slow payer. An
   * invoice in both lists would be chased twice.
   */
  it('gives Payment failed the invoice that is also past due', async () => {
    const run = await renderRun([invoice({ emailLog: [send(), failure()] })])
    expect(run.count(await run.tab(/^Payment failed/))).toBe('1')
    expect(run.count(await run.tab(/^Past due/))).toBe('0')
  })

  it('leaves a paid invoice in Paid, however late it was', async () => {
    const run = await renderRun([
      invoice({ status: 'paid', paidAt: '2026-09-12T10:00:00.000Z' }),
    ])
    expect(run.count(await run.tab(/^Past due/))).toBe('0')
    expect(run.count(await run.tab(/^Paid/))).toBe('1')
  })

  // A bank payment that is actually settling is not somebody to chase.
  it('leaves an invoice mid-payment out of it', async () => {
    const run = await renderRun([invoice({ status: 'processing' })])
    expect(run.count(await run.tab(/^Past due/))).toBe('0')
    expect(run.count(await run.tab(/^Sent/))).toBe('1')
  })

  it('tells her what to do when the invoice is opened', async () => {
    await renderRun([invoice()])
    fireEvent.click(await screen.findByRole('tab', { name: /^Past due/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-031'))
    // The editor can hold other alerts, so the notice is found by what it says.
    const alert = (await screen.findByText(/past the 30-day line since/)).closest('p')
    expect(alert).not.toBeNull()
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert?.textContent).toContain('Past due')
    expect(alert?.textContent).toContain('30-day line since')
    expect(alert?.textContent).toContain('Send again to nudge')
    expect(alert?.textContent).toContain('Mark paid')
  })

  /**
   * THE THING THE NOTICE PROMISES. Sending again is a nudge; the line was set by
   * the FIRST send and does not move, so the invoice stays here until it is
   * actually paid. (`db/store.js` refuses to re-stamp an invoice that already
   * has a `sentAt` — this is the half of that rule the owner can see.)
   */
  it('keeps a re-sent invoice in Past due', async () => {
    const run = await renderRun([
      invoice({
        emailLog: [send(), send({ at: '2026-09-11T09:00:00.000Z', providerId: 'ee-2' })],
      }),
    ])
    expect(run.count(await run.tab(/^Past due/))).toBe('1')
    expect(run.count(await run.tab(/^Sent/))).toBe('0')
  })

  it('has its own empty message, so an empty tab reads as good news', async () => {
    await renderRun([invoice({ dueDate: dayFromToday(5) })])
    fireEvent.click(await screen.findByRole('tab', { name: /^Past due/ }))
    expect(await screen.findByText(/Nothing is past its 30-day line/)).toBeInTheDocument()
  })

  it('counts them in the stat strip, flagged when there are any', async () => {
    await renderRun([invoice(), invoice({ id: 'inv-2', number: 'INV-2026-08-032' })])
    const stat = (await screen.findByText('Past due', { selector: '.invoice-run-stat span' }))
      .closest('div')
    expect(stat?.textContent).toContain('2')
    expect(stat?.className).toContain('is-flagged')
  })
})

/**
 * The selector underneath the tab, on its own. It has no clock: "today" is the
 * argument, which is what lets the SPA pass its local day and the server pass
 * its UTC one without either of them owning the rule.
 */
describe('pastDueInvoice', () => {
  const log = [send()]

  it('is the due date and the whole days since it', () => {
    expect(pastDueInvoice({ status: 'sent', dueDate: '2026-09-01', emailLog: log }, '2026-10-01'))
      .toEqual({ dueDate: '2026-09-01', daysPastDue: 30 })
  })

  it('is nothing on the due date itself, and nothing before it', () => {
    expect(
      pastDueInvoice({ status: 'sent', dueDate: '2026-09-01', emailLog: log }, '2026-09-01'),
    ).toBeNull()
    expect(
      pastDueInvoice({ status: 'sent', dueDate: '2026-09-01', emailLog: log }, '2026-08-31'),
    ).toBeNull()
  })

  it('counts a sent and an overdue invoice as still owed, and nothing else', () => {
    for (const status of ['sent', 'overdue'] as const) {
      expect(pastDueInvoice({ status, dueDate: '2026-09-01', emailLog: log }, '2026-10-01'))
        .not.toBeNull()
    }
    for (const status of ['draft', 'reviewed', 'processing', 'paid', 'void'] as const) {
      expect(
        pastDueInvoice({ status, dueDate: '2026-09-01', emailLog: log }, '2026-10-01'),
      ).toBeNull()
    }
  })

  it('is nothing without a due date', () => {
    expect(pastDueInvoice({ status: 'sent', dueDate: null, emailLog: log }, '2026-10-01')).toBeNull()
    expect(pastDueInvoice({ status: 'sent', emailLog: log }, '2026-10-01')).toBeNull()
  })

  // The other tab wins — the failure is the actionable thing.
  it('yields to an unresolved payment failure', () => {
    expect(
      pastDueInvoice(
        { status: 'sent', dueDate: '2026-09-01', emailLog: [send(), failure()] },
        '2026-10-01',
      ),
    ).toBeNull()
    // Answered by a later send, so it is past due again.
    expect(
      pastDueInvoice(
        {
          status: 'sent',
          dueDate: '2026-09-01',
          emailLog: [send(), failure(), send({ at: '2026-09-11T00:00:00.000Z' })],
        },
        '2026-10-01',
      ),
    ).not.toBeNull()
  })

  it('is nothing for no invoice at all', () => {
    expect(pastDueInvoice(null, '2026-10-01')).toBeNull()
    expect(pastDueInvoice(undefined, '2026-10-01')).toBeNull()
  })
})
