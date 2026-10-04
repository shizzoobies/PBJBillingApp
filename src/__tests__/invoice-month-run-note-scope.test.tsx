import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { type Client, type PersistedInvoice } from '../lib/types'

/**
 * "Note to the client" can be kept for future invoices (featreq-459bdfc2 item
 * 7). Beside the note box the editor offers a choice - This invoice only
 * (the default) or Keep for future invoices - and the helper text under the box
 * tells the truth about whichever is selected.
 *
 * The store half (the column, the bulk-save preservation, generation starting
 * from it) is pinned in db/store-staleness.test.mjs.
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
  setClientInvoiceNote: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, setClientInvoiceNote, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockKeep = vi.mocked(setClientInvoiceNote)

const NUMBER = 'INV-2026-08-001'

const clientWith = (invoiceNote: string | null = null) =>
  [
    {
      id: 'client-acme',
      name: 'Acme',
      contact: '',
      billingMode: 'hourly',
      hourlyRate: 0,
      planIds: [],
      contactIds: [],
      invoiceNote,
    },
  ] as unknown as Client[]

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: NUMBER,
    status: 'draft',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 600 }],
    subtotal: 600,
    total: 600,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    emailLog: [],
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: '2026-08-31T12:00:00.000Z',
    ...over,
  } as PersistedInvoice
}

const note = () => screen.getByLabelText('Note to the client') as HTMLTextAreaElement
const thisOnly = () => screen.getByRole('radio', { name: 'This invoice only' }) as HTMLInputElement
const keep = () => screen.getByRole('radio', { name: 'Keep for future invoices' }) as HTMLInputElement
const helper = () => document.querySelector('.invoice-run-blurb-helper') as HTMLElement
const save = () => screen.getByRole('button', { name: 'Save changes' })

async function openRun(
  invoice: PersistedInvoice,
  { kept = null as string | null, onClientNoteKept = vi.fn() } = {},
) {
  mockList.mockResolvedValue([invoice])
  render(
    <InvoiceMonthRun
      clients={clientWith(kept)}
      contacts={[]}
      onPrint={vi.fn()}
      onClientNoteKept={onClientNoteKept}
    />,
  )
  fireEvent.click(await screen.findByRole('tab', { name: /^To review/ }))
  fireEvent.click(await screen.findByText(NUMBER))
  await screen.findByLabelText('Note to the client')
  return { onClientNoteKept }
}

beforeEach(() => {
  for (const mock of [mockList, mockUpdate, mockKeep]) mock.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the note choice in the invoice editor', () => {
  it('defaults to This invoice only, and says it stays on this invoice', async () => {
    await openRun(makeInvoice())
    expect(thisOnly().checked).toBe(true)
    expect(keep().checked).toBe(false)
    expect(helper()).toHaveTextContent(/this invoice only/i)
    // The old placeholder promised a carry-over nothing performed.
    expect(note().placeholder).not.toMatch(/carried over/i)
  })

  it('tells the truth when the client already has a kept note', async () => {
    await openRun(makeInvoice(), { kept: 'Thanks for your business.' })
    expect(helper()).toHaveTextContent('Thanks for your business.')
    expect(helper()).toHaveTextContent(/new invoice/i)
  })

  it('says what Keep will do once it is selected', async () => {
    await openRun(makeInvoice({ blurb: 'Hello' }))
    fireEvent.click(keep())
    expect(helper()).toHaveTextContent(/every future invoice/i)
    expect(helper()).toHaveTextContent(/already created/i)
  })

  it('says Keep with an empty box clears the kept note', async () => {
    await openRun(makeInvoice(), { kept: 'Old kept note' })
    fireEvent.click(keep())
    expect(helper()).toHaveTextContent(/clear/i)
  })

  it('saving with This invoice only writes the invoice and never touches the client', async () => {
    await openRun(makeInvoice())
    mockUpdate.mockResolvedValue(makeInvoice({ blurb: 'Just this one', updatedAt: 'x' }))
    fireEvent.change(note(), { target: { value: 'Just this one' } })
    fireEvent.click(save())
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ blurb: 'Just this one' })
    expect(mockKeep).not.toHaveBeenCalled()
  })

  it('saving with Keep writes the invoice AND the client, in that order', async () => {
    const { onClientNoteKept } = await openRun(makeInvoice())
    mockUpdate.mockResolvedValue(makeInvoice({ blurb: 'For every invoice', updatedAt: 'x' }))
    mockKeep.mockResolvedValue({
      ...clientWith('For every invoice')[0],
    } as Client)
    fireEvent.change(note(), { target: { value: 'For every invoice' } })
    fireEvent.click(keep())
    fireEvent.click(save())

    await waitFor(() => expect(mockKeep).toHaveBeenCalledWith('client-acme', 'For every invoice'))
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({ blurb: 'For every invoice' })
    expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockKeep.mock.invocationCallOrder[0])
    await waitFor(() =>
      expect(onClientNoteKept).toHaveBeenCalledWith('client-acme', 'For every invoice'),
    )
  })

  it('choosing Keep for a note already on the invoice is itself an unsaved change', async () => {
    await openRun(makeInvoice({ blurb: 'Already here' }))
    expect(save()).toBeDisabled()
    fireEvent.click(keep())
    expect(save()).toBeEnabled()
  })

  it('does nothing to keep when the invoice save is refused', async () => {
    await openRun(makeInvoice())
    mockUpdate.mockRejectedValue(new Error('Could not save that change.'))
    fireEvent.change(note(), { target: { value: 'Never saved' } })
    fireEvent.click(keep())
    fireEvent.click(save())
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    await screen.findByText('Could not save that change.')
    expect(mockKeep).not.toHaveBeenCalled()
  })

  it('says so when the invoice saved but the note could not be kept', async () => {
    await openRun(makeInvoice())
    mockUpdate.mockResolvedValue(makeInvoice({ blurb: 'Keep me', updatedAt: 'x' }))
    mockKeep.mockRejectedValue(new Error('Only owners can keep a note for future invoices'))
    fireEvent.change(note(), { target: { value: 'Keep me' } })
    fireEvent.click(keep())
    fireEvent.click(save())
    const said = await screen.findByText(/The invoice was saved, but the note could not be kept/)
    expect(said).toHaveTextContent(/future invoices/i)
    expect(said).toHaveTextContent(/Only owners/)
  })
})
