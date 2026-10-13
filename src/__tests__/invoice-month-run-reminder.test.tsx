import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import {
  ApiError,
  type Client,
  type Contact,
  type InvoiceEmailSendEntry,
  type PersistedInvoice,
} from '../lib/types'

/**
 * "Send reminder" in the month run (featreq-3f1d63b6): the button beside Send
 * again, its disabled reasons (the server's refusals, read from the same rule),
 * the confirm that names who it goes to, "Last reminded <date>" on the row and
 * in the editor, and "Remind all past due" on the Past due tab.
 */

vi.mock('../lib/api', () => ({
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listAutopayAttemptsRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  markInvoicePaidRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  remindInvoiceRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listAutopayAttemptsRequest, listInvoicesRequest, remindInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockAttempts = vi.mocked(listAutopayAttemptsRequest)
const mockRemind = vi.mocked(remindInvoiceRequest)

const SENT_AT = '2026-08-31T16:00:00.000Z'

function makeClients(over: Partial<Client> = {}, extra: Client[] = []): Client[] {
  return [
    {
      id: 'client-acme',
      name: 'Acme',
      contact: '',
      billingMode: 'hourly',
      hourlyRate: 0,
      planIds: [],
      contactIds: ['contact-ann', 'contact-bo'],
      ...over,
    } as unknown as Client,
    ...extra,
  ]
}

const contacts: Contact[] = [
  { id: 'contact-ann', name: 'Ann Acme', email: 'ann@acme.test' },
  { id: 'contact-bo', name: 'Bo Acme', email: 'bo@acme.test' },
  { id: 'contact-cy', name: 'Cy Bolt', email: 'cy@bolt.test' },
  { id: 'contact-di', name: 'Di Cove', email: 'di@cove.test' },
]

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'sent',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 600 }],
    subtotal: 600,
    total: 600,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: SENT_AT,
    paidAt: null,
    paymentMethod: null,
    emailLog: [{ at: SENT_AT, to: ['ann@acme.test', 'bo@acme.test'], subject: 'Invoice', ok: true }],
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: SENT_AT,
    ...over,
  } as PersistedInvoice
}

const reminderEntry = (at: string, ok = true): InvoiceEmailSendEntry => ({
  at,
  to: ['ann@acme.test', 'bo@acme.test'],
  subject: 'Reminder',
  ok,
  kind: 'reminder',
})

const TAB: Record<string, RegExp> = {
  sent: /^Sent/,
  overdue: /^Sent/,
  draft: /^To review/,
  reviewed: /^Reviewed/,
  processing: /^Processing/,
  paid: /^Paid/,
}

async function openRun(
  rows: PersistedInvoice[],
  { clients = makeClients(), tab = TAB[rows[0].status as string], open = true } = {},
) {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: tab }))
  if (open) fireEvent.click(await screen.findByText(rows[0].number as string))
}

const remindButton = () => screen.getByRole('button', { name: 'Send reminder' })

beforeEach(() => {
  for (const mock of [mockList, mockRemind]) mock.mockReset()
  mockAttempts.mockReset()
  mockAttempts.mockResolvedValue({ chargingEnabled: false, attempts: [] } as never)
})

describe('the Send reminder button', () => {
  it('is offered beside Send again on a sent invoice that is owed', async () => {
    await openRun([makeInvoice()])
    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument()
    expect(remindButton()).toBeEnabled()
  })

  it.each([
    ['draft', 'Not sent yet'],
    ['reviewed', 'Not sent yet'],
    ['processing', 'A bank payment is clearing'],
    ['paid', 'Nothing is owed'],
  ])('is disabled on a %s invoice: "%s"', async (status, reason) => {
    await openRun([makeInvoice({ status: status as PersistedInvoice['status'] })])
    expect(remindButton()).toBeDisabled()
    expect(remindButton()).toHaveAttribute('title', reason)
  })

  it('is disabled when nothing is owed', async () => {
    await openRun([makeInvoice({ total: 0, subtotal: 0 })])
    expect(remindButton()).toBeDisabled()
    expect(remindButton()).toHaveAttribute('title', 'Nothing is owed')
  })

  it('is not offered at all to a never-email client, like Send (the server refuses it too)', async () => {
    await openRun([makeInvoice()], { clients: makeClients({ invoiceNoEmail: true }) })
    expect(screen.queryByRole('button', { name: 'Send reminder' })).toBeNull()
  })

  it('is disabled for an opted-out client', async () => {
    await openRun([makeInvoice()], { clients: makeClients({ platformInvoicingOptOut: true }) })
    expect(remindButton()).toBeDisabled()
    expect(remindButton()).toHaveAttribute('title', 'Client is not emailed')
  })

  it('is disabled while autopay is collecting this one', async () => {
    mockAttempts.mockResolvedValue({
      chargingEnabled: true,
      attempts: [
        { invoiceId: 'inv-1', attemptNo: 1, status: 'processing', errorCode: null, error: null, updatedAt: SENT_AT },
      ],
    } as never)
    await openRun([makeInvoice()])
    await waitFor(() => expect(remindButton()).toBeDisabled())
    expect(remindButton()).toHaveAttribute('title', 'Autopay is collecting this one')
  })

  it('is NOT disabled by an autopay attempt that failed', async () => {
    mockAttempts.mockResolvedValue({
      chargingEnabled: true,
      attempts: [
        { invoiceId: 'inv-1', attemptNo: 1, status: 'failed', errorCode: 'card_declined', error: 'Declined', updatedAt: SENT_AT },
      ],
    } as never)
    await openRun([makeInvoice()])
    await screen.findByText(/Automatic payment failed/)
    expect(remindButton()).toBeEnabled()
  })

  it('is disabled while the invoice is Changed since sent', async () => {
    await openRun([makeInvoice({ changedSinceSent: true })])
    expect(remindButton()).toBeDisabled()
    expect(remindButton()).toHaveAttribute('title', 'Changed since sent - use Send again')
  })

  it('is disabled once reminded today', async () => {
    await openRun([
      makeInvoice({
        emailLog: [
          { at: SENT_AT, to: ['ann@acme.test'], subject: 'Invoice', ok: true },
          reminderEntry(new Date().toISOString()),
        ],
      }),
    ])
    expect(remindButton()).toBeDisabled()
    expect(remindButton()).toHaveAttribute('title', 'Already reminded today')
  })

  it('is disabled when the invoice itself went out today', async () => {
    const now = new Date().toISOString()
    await openRun([makeInvoice({ sentAt: now, emailLog: [{ at: now, to: ['ann@acme.test'], subject: 'Invoice', ok: true }] })])
    expect(remindButton()).toBeDisabled()
    expect(remindButton()).toHaveAttribute('title', 'Already reminded today')
  })

  it('does not count a failed reminder today', async () => {
    await openRun([
      makeInvoice({
        emailLog: [
          { at: SENT_AT, to: ['ann@acme.test'], subject: 'Invoice', ok: true },
          reminderEntry(new Date().toISOString(), false),
        ],
      }),
    ])
    expect(remindButton()).toBeEnabled()
  })
})

describe('sending one reminder', () => {
  it('asks first, naming who it goes to, then sends and shows Last reminded', async () => {
    await openRun([makeInvoice()])
    const remindedAt = '2026-10-09T16:00:00.000Z'
    mockRemind.mockResolvedValue({
      invoice: makeInvoice({
        updatedAt: remindedAt,
        emailLog: [
          { at: SENT_AT, to: ['ann@acme.test', 'bo@acme.test'], subject: 'Invoice', ok: true },
          reminderEntry(remindedAt),
        ],
      }),
    })

    fireEvent.click(remindButton())
    // Nothing is sent by the first press: it asks, and lists the recipients.
    expect(mockRemind).not.toHaveBeenCalled()
    const confirm = screen.getByRole('group', { name: 'Send reminder' })
    expect(within(confirm).getByText(/ann@acme\.test/)).toBeInTheDocument()
    expect(within(confirm).getByText(/bo@acme\.test/)).toBeInTheDocument()

    fireEvent.click(within(confirm).getByRole('button', { name: 'Send reminder now' }))
    await waitFor(() => expect(mockRemind).toHaveBeenCalledWith('inv-1'))

    // The editor remounts on the new invoice; the line is read off its log.
    const editor = await waitFor(() => {
      const node = document.querySelector('.invoice-run-editor')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    await waitFor(() => expect(within(editor).getByText(/Last reminded Oct 9/)).toBeInTheDocument())
    expect(screen.queryByRole('group', { name: 'Send reminder' })).not.toBeInTheDocument()
  })

  it('Cancel sends nothing', async () => {
    await openRun([makeInvoice()])
    fireEvent.click(remindButton())
    fireEvent.click(within(screen.getByRole('group', { name: 'Send reminder' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Send reminder' })).not.toBeInTheDocument()
    expect(mockRemind).not.toHaveBeenCalled()
  })

  it("says the server's refusal and re-reads the month", async () => {
    await openRun([makeInvoice()])
    mockRemind.mockRejectedValue(
      new ApiError(409, 'This client already heard about this invoice today.', 'reminded_today'),
    )
    const listsBefore = mockList.mock.calls.length

    fireEvent.click(remindButton())
    fireEvent.click(screen.getByRole('button', { name: 'Send reminder now' }))

    expect(await screen.findByText(/already heard about this invoice today/)).toBeInTheDocument()
    expect(mockList.mock.calls.length).toBeGreaterThan(listsBefore)
  })
})

describe('Last reminded on the row', () => {
  it('shows the newest ok reminder date before anything is opened', async () => {
    await openRun(
      [
        makeInvoice({
          emailLog: [
            { at: SENT_AT, to: ['ann@acme.test'], subject: 'Invoice', ok: true },
            reminderEntry('2026-10-05T16:00:00.000Z'),
            reminderEntry('2026-10-09T16:00:00.000Z'),
            reminderEntry('2026-10-10T16:00:00.000Z', false),
          ],
        }),
      ],
      { open: false },
    )
    const row = (await screen.findByText('INV-2026-08-001')).closest('li') as HTMLElement
    expect(within(row).getByText(/Last reminded Oct 9/)).toBeInTheDocument()
  })

  it('says nothing on a row never reminded', async () => {
    await openRun([makeInvoice()], { open: false })
    await screen.findByText('INV-2026-08-001')
    expect(screen.queryByText(/Last reminded/)).not.toBeInTheDocument()
  })
})

describe('Remind all past due', () => {
  // Past the firm's 30-day line, still owed.
  const pastDue = (over: Partial<PersistedInvoice>) =>
    makeInvoice({ dueDate: '2026-09-30', ...over })
  const clients = makeClients({}, [
    { id: 'client-bolt', name: 'Bolt', contactIds: ['contact-cy'], planIds: [] } as unknown as Client,
    { id: 'client-cove', name: 'Cove', contactIds: ['contact-di'], planIds: [], invoiceNoEmail: true } as unknown as Client,
    { id: 'client-dune', name: 'Dune', contactIds: ['contact-di'], planIds: [] } as unknown as Client,
  ])
  const rows = [
    pastDue({ id: 'inv-a', number: 'INV-2026-08-001', clientId: 'client-acme' }),
    pastDue({ id: 'inv-b', number: 'INV-2026-08-002', clientId: 'client-bolt' }),
    // Skipped: never emailed.
    pastDue({ id: 'inv-c', number: 'INV-2026-08-003', clientId: 'client-cove' }),
    // Skipped: reminded today already.
    pastDue({
      id: 'inv-d',
      number: 'INV-2026-08-004',
      clientId: 'client-dune',
      emailLog: [
        { at: SENT_AT, to: ['di@cove.test'], subject: 'Invoice', ok: true },
        reminderEntry(new Date().toISOString()),
      ],
    }),
  ]
  const openPastDue = async () => {
    await openRun(rows, { clients, tab: /^Past due/, open: false })
  }
  const panel = () => screen.getByRole('group', { name: 'Remind all past due' })

  it('is offered on the Past due tab only', async () => {
    await openRun(rows, { clients, tab: /^Sent/, open: false })
    expect(screen.queryByRole('button', { name: 'Remind all past due' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /^Past due/ }))
    expect(await screen.findByRole('button', { name: 'Remind all past due' })).toBeEnabled()
  })

  it('lists what it will send, to whom, and what it skips and why - before sending anything', async () => {
    await openPastDue()
    fireEvent.click(await screen.findByRole('button', { name: 'Remind all past due' }))

    expect(mockRemind).not.toHaveBeenCalled()
    const list = panel()
    const willSend = within(list).getByRole('list', { name: 'Will be reminded' })
    expect(within(willSend).getAllByRole('listitem')).toHaveLength(2)
    expect(within(willSend).getByText(/INV-2026-08-001 · Acme/)).toHaveTextContent('ann@acme.test')
    expect(within(willSend).getByText(/INV-2026-08-002 · Bolt/)).toHaveTextContent('cy@bolt.test')
    const skipped = within(list).getByRole('list', { name: 'Skipped' })
    expect(within(skipped).getByText(/INV-2026-08-003 · Cove/)).toHaveTextContent('Client is not emailed')
    expect(within(skipped).getByText(/INV-2026-08-004 · Dune/)).toHaveTextContent('Already reminded today')
  })

  it('sends them one at a time and reports "Reminded N of M"', async () => {
    await openPastDue()
    mockRemind.mockImplementation(async (id: string) => ({
      invoice: rows.find((row) => row.id === id) as PersistedInvoice,
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remind all past due' }))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send 2 reminders' }))

    expect(await screen.findByText(/Reminded 2 of 2\./)).toBeInTheDocument()
    expect(mockRemind.mock.calls.map((call) => call[0])).toEqual(['inv-a', 'inv-b'])
  })

  it('stops on the first failure and says how far it got', async () => {
    const more = [...rows, pastDue({ id: 'inv-e', number: 'INV-2026-08-005', clientId: 'client-bolt' })]
    await openRun(more, { clients, tab: /^Past due/, open: false })
    mockRemind.mockImplementation(async (id: string) => {
      if (id === 'inv-b') throw new ApiError(502, 'domain is not verified', 'reminder_send_failed')
      return { invoice: more.find((row) => row.id === id) as PersistedInvoice }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Remind all past due' }))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send 3 reminders' }))

    expect(await screen.findByText(/Reminded 1 of 3\./)).toHaveTextContent(
      'INV-2026-08-002: domain is not verified',
    )
    expect(mockRemind.mock.calls.map((call) => call[0])).toEqual(['inv-a', 'inv-b'])
  })

  it('Cancel sends nothing', async () => {
    await openPastDue()
    fireEvent.click(await screen.findByRole('button', { name: 'Remind all past due' }))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Remind all past due' })).not.toBeInTheDocument()
    expect(mockRemind).not.toHaveBeenCalled()
  })
})
