import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * Push to next month (featreq-40697310) in the month run.
 *
 * The server owns every rule (lib/invoice-rollforward.js, db/store-staleness.test.mjs).
 * What the page owes: the action beside Void on an unsent monthly invoice, a
 * confirm sheet in her words before anything is sent, the reason when it is off,
 * "Rolled into <month>" instead of "Voided" on a pushed invoice with an Undo push,
 * and the carried lines under their own heading on the invoice that took them.
 */

vi.mock('../lib/api', () => ({
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  rollInvoiceForwardRequest: vi.fn(),
  undoInvoiceRollForwardRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  listInvoicesRequest,
  listUnappliedRetainersRequest,
  rollInvoiceForwardRequest,
  undoInvoiceRollForwardRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockRoll = vi.mocked(rollInvoiceForwardRequest)
const mockUndo = vi.mocked(undoInvoiceRollForwardRequest)

let confirm: ReturnType<typeof vi.fn>

const clients = [
  { id: 'client-acme', name: 'Acme', contact: '', billingMode: 'hourly', hourlyRate: 125, planIds: [], contactIds: [] },
] as unknown as Client[]

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'draft',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 40 }],
    subtotal: 40,
    total: 40,
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
  } as PersistedInvoice
}

async function openEditor(tab: RegExp, number = 'INV-2026-08-001') {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText(number))
}

const editor = () => {
  const node = document.querySelector('.invoice-run-editor')
  if (!node) throw new Error('the editor is not open')
  return within(node as HTMLElement)
}

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockRoll.mockReset()
  mockUndo.mockReset()
  confirm = vi.fn().mockReturnValue(true)
  vi.stubGlobal('confirm', confirm)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Push to next month', () => {
  it('sits beside Void on a draft, asks first in plain words, and sends nothing until confirmed', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    await openEditor(/To review/)

    fireEvent.click(editor().getByRole('button', { name: /Push to next month/ }))

    const sheet = screen.getByRole('group', { name: 'Push to next month' })
    expect(sheet).toHaveTextContent(
      "Everything on this August 2026 invoice moves onto September 2026's invoice as its own lines, listed as August work. This invoice closes as rolled into September. You can push again from September if it is still too small.",
    )
    expect(mockRoll).not.toHaveBeenCalled()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Push to next month' })).toBeNull()
    expect(mockRoll).not.toHaveBeenCalled()
  })

  it('says what happens to an attached advance', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        lineItems: [
          { kind: 'custom', label: 'Bookkeeping', detail: '', amount: 40 },
          {
            kind: 'advance_request',
            label: 'Pay in advance amount',
            detail: '',
            amount: 0,
            advanceOffer: { requestId: 'adv-1', number: 'ADV-0004', collection: 'invoice' },
          } as unknown as PersistedInvoice['lineItems'][number],
        ],
      }),
    ])
    await openEditor(/To review/)
    fireEvent.click(editor().getByRole('button', { name: /Push to next month/ }))
    expect(screen.getByRole('group', { name: 'Push to next month' })).toHaveTextContent(
      "The advance request ADV-0004 on this invoice moves with it and is collected on September 2026's payment link.",
    )
  })

  it('pushes on confirm, reloads the month and says where the lines went', async () => {
    mockList.mockResolvedValueOnce([makeInvoice()])
    const rolled = makeInvoice({ status: 'void', rolledIntoPeriod: '2026-09' })
    mockList.mockResolvedValue([rolled])
    mockRoll.mockResolvedValue({ rolled, carrier: null, advance: null })
    await openEditor(/To review/)
    fireEvent.click(editor().getByRole('button', { name: /Push to next month/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Push to September 2026' }))

    await waitFor(() => expect(mockRoll).toHaveBeenCalledWith('inv-1'))
    expect(
      await screen.findByText(
        "INV-2026-08-001 was pushed into September 2026. Its lines go onto September 2026's invoice when you generate September 2026.",
        { exact: false },
      ),
    ).toBeInTheDocument()
    expect(mockList.mock.calls.length).toBeGreaterThan(1)
  })

  it('puts the server’s refusal beside the buttons', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockRoll.mockRejectedValue(
      new ApiError(409, "September 2026's invoice (INV-2026-09-003) already went out, so this cannot be pushed onto it.", 'next_invoice_sent'),
    )
    await openEditor(/To review/)
    fireEvent.click(editor().getByRole('button', { name: /Push to next month/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Push to September 2026' }))
    expect(
      await editor().findByText("September 2026's invoice (INV-2026-09-003) already went out, so this cannot be pushed onto it."),
    ).toBeInTheDocument()
  })

  it('is off, with the reason said, when the month list says it cannot be pushed', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        rollForward: {
          allowed: false,
          reason: 'Pushing an invoice to next month is not supported yet for clients billed for several months at a time.',
        },
      }),
    ])
    await openEditor(/To review/)
    const button = editor().getByRole('button', { name: /Push to next month/ })
    expect(button).toBeDisabled()
    expect(
      editor().getByText(
        'Push to next month: Pushing an invoice to next month is not supported yet for clients billed for several months at a time.',
      ),
    ).toBeInTheDocument()
  })

  it('is not offered on a sent invoice or a retainer', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'sent', sentAt: '2026-09-01T12:00:00.000Z' })])
    await openEditor(/^Sent/)
    expect(editor().queryByRole('button', { name: /Push to next month/ })).toBeNull()
  })
})

describe('a pushed invoice', () => {
  const rolled = () => makeInvoice({ status: 'void', rolledIntoPeriod: '2026-09', rollUndo: { allowed: true, reason: null } })

  it('reads "Rolled into September 2026" on the Voided tab, not Voided', async () => {
    mockList.mockResolvedValue([rolled()])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Voided/ }))
    const row = (await screen.findByText('INV-2026-08-001')).closest('li') as HTMLElement
    expect(within(row).getByText('Rolled into September 2026')).toBeInTheDocument()
    expect(within(row).queryByText('Voided')).toBeNull()
  })

  it('offers Undo push, asks first, and reloads with the outcome', async () => {
    mockList.mockResolvedValue([rolled()])
    mockUndo.mockResolvedValue({
      rolled: makeInvoice({ status: 'void', rolledIntoPeriod: null }),
      carrier: makeInvoice({ id: 'inv-9', period: '2026-09', number: 'INV-2026-09-001' }),
      carrierVoided: false,
      regenerated: makeInvoice({ id: 'inv-2', number: 'INV-2026-08-002' }),
      skipped: [],
      advance: null,
      generateError: null,
    })
    await openEditor(/Voided/)
    fireEvent.click(editor().getByRole('button', { name: /Undo push/ }))
    expect(confirm).toHaveBeenCalledWith(
      "Undo the push of INV-2026-08-001? Its lines come off September 2026's invoice, and August 2026's invoice is built again from the time records. This invoice stays voided with your edits on it; they are not copied to the new one.",
    )
    await waitFor(() => expect(mockUndo).toHaveBeenCalledWith('inv-1'))
    expect(
      await screen.findByText(
        'The push of INV-2026-08-001 was undone. Its lines were taken off INV-2026-09-001. August 2026 was built again as INV-2026-08-002.',
        { exact: false },
      ),
    ).toBeInTheDocument()
  })

  it('declining the confirm sends nothing', async () => {
    confirm.mockReturnValue(false)
    mockList.mockResolvedValue([rolled()])
    await openEditor(/Voided/)
    fireEvent.click(editor().getByRole('button', { name: /Undo push/ }))
    expect(mockUndo).not.toHaveBeenCalled()
  })

  it('Undo is off with the reason once next month went out', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        status: 'void',
        rolledIntoPeriod: '2026-09',
        rollUndo: { allowed: false, reason: "September 2026's invoice already went out with these lines on it, so the push cannot be undone." },
      }),
    ])
    await openEditor(/Voided/)
    expect(editor().getByRole('button', { name: /Undo push/ })).toBeDisabled()
    expect(
      editor().getByText(
        "Undo push: September 2026's invoice already went out with these lines on it, so the push cannot be undone.",
      ),
    ).toBeInTheDocument()
  })
})

describe('the invoice that took the lines', () => {
  it('shows them under "Carried forward from <month>", editable, apart from this month’s lines', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        id: 'inv-9',
        period: '2026-09',
        number: 'INV-2026-09-001',
        lineItems: [
          { kind: 'custom', label: 'September work', detail: '', amount: 60 },
          {
            kind: 'custom',
            label: 'August 2026: Bookkeeping',
            detail: '',
            amount: 40,
            carriedFromPeriod: '2026-08',
            carriedFromInvoiceId: 'inv-1',
          },
        ],
        subtotal: 100,
        total: 100,
      }),
    ])
    await openEditor(/To review/, 'INV-2026-09-001')
    const block = document.querySelector('.invoice-run-carried') as HTMLElement
    expect(block).not.toBeNull()
    expect(within(block).getByText('Carried forward from August 2026')).toBeInTheDocument()
    expect(within(block).getByDisplayValue('August 2026: Bookkeeping')).toBeInTheDocument()
    expect(within(block).queryByDisplayValue('September work')).toBeNull()
    expect(editor().getByDisplayValue('September work')).toBeInTheDocument()
  })
})
