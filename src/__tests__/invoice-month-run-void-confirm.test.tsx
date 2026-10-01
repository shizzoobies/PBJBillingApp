import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * Void asks first, and is not offered while a bank payment is clearing
 * (tracker featreq-459bdfc2).
 *
 * The server owns the refusal (db/store-staleness.test.mjs, both backends).
 * What the editor owes is: a confirm that says what the void means for THIS
 * invoice, nothing sent when she declines, a disabled button with a reason on a
 * processing invoice, and the server's sentence beside the buttons if a stale
 * tab reaches the server anyway.
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

import {
  listInvoicesRequest,
  listUnappliedRetainersRequest,
  regenerateInvoicesRequest,
  updateInvoiceRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockRegenerate = vi.mocked(regenerateInvoicesRequest)

// happy-dom ships no window.confirm, so it is stubbed (same as mark-paid).
let confirm: ReturnType<typeof vi.fn>

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 125,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'sent',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-20T00:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  } as PersistedInvoice
}

async function openEditor(tab: RegExp, number: string | null = 'INV-2026-08-001') {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: tab }))
  // An invoice with no number has no row text to click; the client name does.
  fireEvent.click(await screen.findByText(number ?? 'Acme'))
}

const voidButton = () => screen.getByRole('button', { name: 'Void' })

/** The editor itself, so a sentence is found NEXT TO the buttons, not in the run's banner. */
const editor = () => {
  const node = document.querySelector('.invoice-run-editor')
  if (!node) throw new Error('the editor is not open')
  return within(node as HTMLElement)
}

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockUpdate.mockReset()
  mockRegenerate.mockReset()
  confirm = vi.fn().mockReturnValue(true)
  vi.stubGlobal('confirm', confirm)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Void asks first', () => {
  it('says a draft was never sent', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'draft', sentAt: null })])
    await openEditor(/To review/)
    fireEvent.click(voidButton())
    expect(confirm).toHaveBeenCalledWith(
      'Void INV-2026-08-001 for Acme? It was never sent. Generate the month again if you still need to bill it.',
    )
  })

  it('says the same for a reviewed invoice', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'reviewed', sentAt: null })])
    await openEditor(/^Reviewed/)
    fireEvent.click(voidButton())
    expect(confirm).toHaveBeenCalledWith(
      'Void INV-2026-08-001 for Acme? It was never sent. Generate the month again if you still need to bill it.',
    )
  })

  it('says the client has a payment link that will stop working, for a sent invoice', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'sent' })])
    await openEditor(/Sent/)
    fireEvent.click(voidButton())
    expect(confirm).toHaveBeenCalledWith(
      'Void INV-2026-08-001 for Acme? The client already has this invoice by email, and their payment link will stop working. This cannot be undone.',
    )
  })

  it('says a paid invoice is not refunded and leaves the paid totals', async () => {
    mockList.mockResolvedValue([
      makeInvoice({ status: 'paid', paidAt: '2026-09-01T00:00:00.000Z', paymentMethod: 'manual' }),
    ])
    await openEditor(/Paid/)
    fireEvent.click(voidButton())
    expect(confirm).toHaveBeenCalledWith(
      'Void INV-2026-08-001 for Acme? This invoice is PAID. Voiding it does not refund the client and takes it out of your paid totals. This cannot be undone.',
    )
  })

  it('says "this invoice" when it has no number yet', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'draft', sentAt: null, number: null })])
    await openEditor(/To review/, null)
    fireEvent.click(voidButton())
    expect(confirm).toHaveBeenCalledWith(
      'Void this invoice for Acme? It was never sent. Generate the month again if you still need to bill it.',
    )
  })

  it('sends nothing when she declines', async () => {
    confirm.mockReturnValue(false)
    mockList.mockResolvedValue([makeInvoice({ status: 'sent' })])
    await openEditor(/Sent/)
    fireEvent.click(voidButton())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('sends the void when she accepts', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'sent' })])
    mockUpdate.mockResolvedValue(makeInvoice({ status: 'void' }))
    await openEditor(/Sent/)
    fireEvent.click(voidButton())
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('inv-1', { status: 'void' }))
  })
})

describe('Void while a bank payment is clearing', () => {
  it('is disabled, and says why', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'processing' })])
    await openEditor(/Sent/)
    const button = voidButton()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'A bank payment is still clearing on this invoice')
    fireEvent.click(button)
    expect(confirm).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  // A tab left open across the payment still shows Void; the server is the real
  // guard, and its sentence lands beside the buttons.
  it('shows the server sentence beside the buttons when a stale tab is refused', async () => {
    const sentence =
      'A bank payment is still clearing on this invoice. Wait until it is paid or fails, then void it.'
    mockList.mockResolvedValue([makeInvoice({ status: 'sent' })])
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'invoice_payment_processing'))
    await openEditor(/Sent/)

    fireEvent.click(voidButton())

    expect(await editor().findByText(sentence)).toBeInTheDocument()
    // In the editor only, not repeated in the run's banner.
    expect(screen.getAllByText(sentence)).toHaveLength(1)
    // The invoice is still sent, still on its tab.
    expect(screen.getByRole('tab', { name: /Sent/ })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Void & regenerate leaves a clearing payment alone and says so', () => {
  it('names how many invoices were left because a bank payment is clearing', async () => {
    mockList.mockResolvedValue([
      makeInvoice({ id: 'inv-draft', status: 'draft', sentAt: null }),
      makeInvoice({
        id: 'inv-clearing',
        clientId: 'client-other',
        number: 'INV-2026-08-002',
        status: 'processing',
      }),
    ])
    mockRegenerate.mockResolvedValue({
      period: '2026-08',
      voided: 1,
      clearing: 1,
      created: [],
      skipped: [{ clientId: 'client-other', reason: 'already-generated' }],
    })
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await screen.findByRole('tab', { name: /Sent/ })

    fireEvent.click(await screen.findByRole('button', { name: /Void & regenerate/ }))

    expect(
      await screen.findByText(
        /Voided 1 and rebuilt 0 invoices\. 1 invoice left alone because a bank payment is still clearing\./,
      ),
    ).toBeInTheDocument()
    // The clearing invoice is counted once, in its own sentence.
    expect(screen.queryByText(/sent or paid invoice/)).not.toBeInTheDocument()
  })
})
