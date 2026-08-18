import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, Contact, PersistedInvoice } from '../lib/types'

/**
 * "Make sure it goes to EVERY email attached to that client" — the half of that
 * which happens on screen.
 *
 * She could never see who an invoice was addressed to. A client with two
 * contact addresses and a client with one looked identical, and a client with
 * NO address looked identical to both right up until Send answered with a 409.
 * These pin that the run now says who it goes to before anything leaves, offers
 * the checkbox list when there is a choice to make, and shows who it went to
 * afterwards.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, sendInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)

const clients = [
  {
    id: 'client-cooper',
    name: 'Cooper & Cooper, PA',
    contactIds: ['contact-anthony', 'contact-charlean'],
    planIds: [],
  },
  { id: 'client-solo', name: 'Solo LLC', contactIds: ['contact-solo'], planIds: [] },
  { id: 'client-nobody', name: 'Nobody Inc', contactIds: [], planIds: [] },
] as unknown as Client[]

const contacts: Contact[] = [
  {
    id: 'contact-anthony',
    name: 'Anthony Cooper',
    // The personal address AND the one attached to this client both count.
    email: 'acooper@gmail.com',
    companyEmails: [{ clientId: 'client-cooper', email: 'anthony@coopercooperpa.com' }],
  },
  { id: 'contact-charlean', name: 'Charlean Cooper', email: 'charlean@coopercooperpa.com' },
  { id: 'contact-solo', name: 'Sol O', email: 'sol@solo.com' },
]

const invoice = (over: Partial<PersistedInvoice> = {}): PersistedInvoice => ({
  id: 'inv-1',
  clientId: 'client-cooper',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-2026-08-001',
  status: 'reviewed',
  lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
  subtotal: 400,
  total: 400,
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
})

/** Render the run, switch to the tab holding this invoice, and open its editor. */
async function openEditor(rows: PersistedInvoice[], tab = 'Reviewed') {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${tab}`) }))
  fireEvent.click(await screen.findByText(rows[0].number as string))
}

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
  mockSend.mockResolvedValue({ invoice: invoice({ status: 'sent' }) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — who the invoice goes to', () => {
  it('counts the recipients on the row and names them in the editor', async () => {
    await openEditor([invoice()])

    // Three addresses: the contact's client address, the same contact's
    // personal one, and the second contact.
    // Twice over: the row's own meta line (visible without opening anything)
    // and the editor's "Goes to" heading above the list.
    expect(screen.getAllByText(/3 recipients/)).toHaveLength(2)
    expect(
      screen.getByText('Anthony Cooper <anthony@coopercooperpa.com>'),
    ).toBeInTheDocument()
    expect(screen.getByText('Anthony Cooper <acooper@gmail.com>')).toBeInTheDocument()
    expect(
      screen.getByText('Charlean Cooper <charlean@coopercooperpa.com>'),
    ).toBeInTheDocument()
  })

  it('flags a client with no address and refuses to send, saying why', async () => {
    await openEditor([invoice({ clientId: 'client-nobody' })])

    expect(screen.getByText('No email on file')).toBeInTheDocument()
    const send = screen.getByRole('button', { name: /^Send$/ })
    expect(send).toBeDisabled()
    expect(send).toHaveAttribute('title', expect.stringMatching(/no email address on file/i))

    fireEvent.click(send)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends straight out when there is only one address — no dialog', async () => {
    await openEditor([invoice({ clientId: 'client-solo' })])

    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledWith('inv-1', undefined))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the checkbox list with everyone ticked when there is a choice', async () => {
    await openEditor([invoice()])

    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Invoice INV-2026-08-001 for Cooper & Cooper, PA')
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes).toHaveLength(3)
    expect(boxes.every((box) => box.checked)).toBe(true)
    // "Send to everyone" is still one click.
    expect(screen.getByRole('button', { name: 'Send to 3 people' })).toBeEnabled()
  })

  it('sends only what she leaves ticked', async () => {
    await openEditor([invoice()])
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getAllByRole('checkbox')[1])

    fireEvent.click(screen.getByRole('button', { name: 'Send to 2 people' }))
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith('inv-1', [
        'anthony@coopercooperpa.com',
        'charlean@coopercooperpa.com',
      ]),
    )
  })

  it('will not send to nobody', async () => {
    await openEditor([invoice()])
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
    await screen.findByRole('dialog')

    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)

    expect(screen.getByRole('button', { name: /^Send to /i })).toBeDisabled()
    expect(screen.getByText(/Pick at least one address/)).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('shows who a past send actually reached', async () => {
    await openEditor([
      invoice({
        status: 'sent',
        emailLog: [
          {
            at: '2026-08-13T15:00:00.000Z',
            to: ['anthony@coopercooperpa.com', 'charlean@coopercooperpa.com'],
            subject: 'Invoice INV-2026-08-001',
            ok: true,
          },
        ],
      }),
    ], 'Sent')

    expect(screen.getByText(/Sent Aug 13 to 2 recipients/)).toBeInTheDocument()
    // The addresses are one disclosure away — the answer to "they say it never
    // arrived", which is the only time anyone asks.
    expect(screen.getByText('anthony@coopercooperpa.com')).toBeInTheDocument()
    expect(screen.getByText('charlean@coopercooperpa.com')).toBeInTheDocument()
  })
})
