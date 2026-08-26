import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * The paid lock in the month-run editor — featreq-ead3a215, Brittany's rule:
 * "invoices should not be editable once paid all invoices should lock after
 * paid."
 *
 * The server is what ENFORCES this (`updateInvoice` throws; pinned in
 * db/store-staleness.test.mjs). What the editor owes her is that she never finds
 * out by being refused: the fields do not accept typing, the writing controls
 * are gone, and the reason is stated once at the top rather than arriving as an
 * error after a click that never had a chance.
 *
 * The draft block at the end is the tripwire that matters most. Every assertion
 * here is about something being ABSENT, and absence is also what a component
 * that failed to render produces — so the same queries are run against a draft,
 * where they must all find something.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, listUnappliedRetainersRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

function makeInvoice(overrides: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'draft',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: 'Thanks for your business.',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

async function openEditor(tab?: RegExp) {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

const saveButton = () => screen.queryByRole('button', { name: 'Save changes' })
const addLineButton = () => screen.queryByRole('button', { name: /Add a line/i })
const removeButton = () => screen.queryByRole('button', { name: /^Remove/i })
const description = () => screen.getByLabelText('Line description') as HTMLInputElement
const note = () => screen.getByLabelText(/Note to the client/i) as HTMLTextAreaElement

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockUpdate.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — a paid invoice is a record, not a draft', () => {
  beforeEach(() => {
    mockList.mockResolvedValue([
      makeInvoice({ status: 'paid', paidAt: '2026-08-20T00:00:00.000Z' }),
    ])
  })

  it('says why, once, at the top', async () => {
    await openEditor(/Paid/)
    expect(await screen.findByText(/locked because it has been paid/i)).toBeInTheDocument()
  })

  it('offers nothing that writes', async () => {
    await openEditor(/Paid/)
    await waitFor(() => expect(description()).toBeInTheDocument())
    expect(saveButton()).not.toBeInTheDocument()
    expect(addLineButton()).not.toBeInTheDocument()
    // Hidden rather than disabled: with Save gone, a line she could delete but
    // never persist is worse than no button at all.
    expect(removeButton()).not.toBeInTheDocument()
  })

  it('will not take typing into the lines or the note', async () => {
    await openEditor(/Paid/)
    await waitFor(() => expect(description()).toBeInTheDocument())
    expect(description().readOnly).toBe(true)
    expect(note().readOnly).toBe(true)
  })

  // The escape hatch has to be visible, or the lock is a trap.
  it('still offers Void', async () => {
    await openEditor(/Paid/)
    expect(await screen.findByRole('button', { name: 'Void' })).toBeInTheDocument()
  })

  it('never asks the server to save anything', async () => {
    await openEditor(/Paid/)
    await waitFor(() => expect(description()).toBeInTheDocument())
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('InvoiceMonthRun — an invoice mid-payment', () => {
  it('locks with its own wording while the money is still settling', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'processing' })])
    await openEditor(/Sent/)
    expect(await screen.findByText(/payment is going through/i)).toBeInTheDocument()
    expect(saveButton()).not.toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — the boundary the lock stops at', () => {
  // A draft is the control: every query above must find something here, or the
  // "not.toBeInTheDocument" assertions prove nothing.
  it('leaves a draft fully editable', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    await openEditor()
    await waitFor(() => expect(description()).toBeInTheDocument())
    expect(screen.queryByText(/locked because/i)).not.toBeInTheDocument()
    expect(saveButton()).toBeInTheDocument()
    expect(addLineButton()).toBeInTheDocument()
    expect(removeButton()).toBeInTheDocument()
    expect(description().readOnly).toBe(false)
    expect(note().readOnly).toBe(false)
  })

  // Nobody has paid a sent invoice. Correcting one before they do is ordinary
  // bookkeeping, and she did not ask for it to stop.
  it('leaves a sent invoice editable', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'sent', sentAt: '2026-08-19T00:00:00.000Z' })])
    await openEditor(/Sent/)
    await waitFor(() => expect(description()).toBeInTheDocument())
    expect(screen.queryByText(/locked because/i)).not.toBeInTheDocument()
    expect(saveButton()).toBeInTheDocument()
    expect(description().readOnly).toBe(false)
  })
})

describe('InvoiceMonthRun — a tab that was open across the payment', () => {
  /**
   * The one path that can still reach a refusal: she opened this invoice while
   * it was a draft, the client paid it, and her Save lands against a row that
   * has since locked. The sentence has to arrive beside the lines, and the table
   * must not be quietly rewritten under a message about a frozen invoice.
   */
  it('shows the server sentence and changes nothing', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockUpdate.mockRejectedValue(
      new ApiError(409, 'This invoice is locked because it has been paid', 'invoice_locked'),
    )
    await openEditor()
    await waitFor(() => expect(description()).toBeInTheDocument())

    fireEvent.change(description(), { target: { value: 'Bookkeeping — August' } })
    fireEvent.click(saveButton()!)

    // Queried by its words rather than by role: the editor already carries an
    // unrelated alert (no email on file), and `findByRole('alert')` returns
    // whichever comes first in the DOM.
    const refusal = await screen.findByText(/locked because it has been paid/i)
    expect(refusal).toBeInTheDocument()
    expect(refusal.closest('[role="alert"]')).not.toBeNull()
    // Her typing is still on screen: nothing was silently reverted or dropped.
    expect(description().value).toBe('Bookkeeping — August')
  })
})
