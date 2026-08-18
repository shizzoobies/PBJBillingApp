import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * The retainer credit in the month-run editor.
 *
 * THE APP OFFERS, SHE DECIDES. There is no "final invoice" flag for the button
 * to key off, so the offer stands on every invoice for a client whose retainer
 * is still on account and nothing applies it on her behalf. What is worth
 * pinning here is that the offer appears where it should, disappears when the
 * money is spent, and puts the SAME figure into the lines that the button
 * promised — she reviews one number and the client must receive the same one.
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
  updateInvoiceRequest,
} from '../lib/api'

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
    id: 'inv-final',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'draft',
    lineItems: [{ kind: 'hourly', label: 'Billable hours — Lisa', detail: '', amount: 600 }],
    subtotal: 600,
    total: 600,
    dueDate: null,
    blurb: '',
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

const retainer = makeInvoice({
  id: 'inv-ret',
  kind: 'retainer',
  number: 'INV-RET-2026-001',
  period: '2026-01',
  status: 'paid',
  lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
  subtotal: 500,
  total: 500,
})

/**
 * Render the run and open one invoice's editor. `tab` is needed whenever the
 * invoice's status puts it somewhere other than "To review", which is where the
 * run opens.
 */
async function openEditor(number = 'INV-2026-08-001', tab?: RegExp) {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText(number))
}

const applyButton = () => screen.queryByRole('button', { name: /Apply retainer/i })

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([makeInvoice()])
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([retainer])
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(makeInvoice())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — the retainer credit', () => {
  it('offers the credit, named with what it is worth', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    // Named as well as priced — a client can hold more than one.
    expect(applyButton()).toHaveTextContent('Apply retainer INV-RET-2026-001 credit ($500.00)')
  })

  it('offers nothing when the firm holds no retainer for this client', async () => {
    mockRetainers.mockResolvedValue([])
    await openEditor()
    expect(screen.getByText('Add a line')).toBeInTheDocument()
    expect(applyButton()).not.toBeInTheDocument()
  })

  // Applying is never automatic. Opening the editor changes no money.
  it('does not apply it on her behalf', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    expect(screen.getByText(/^Total \$600\.00/)).toBeInTheDocument()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('adds the credit as a line and moves the running total to match', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)

    expect(screen.getByDisplayValue('Retainer applied — credit')).toBeInTheDocument()
    expect(screen.getByText(/^Total \$100\.00/)).toBeInTheDocument()
    // The offer is gone once it has been taken — one credit per invoice.
    expect(applyButton()).not.toBeInTheDocument()
  })

  it('sends the credit, with the retainer it came out of, on save', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, body] = mockUpdate.mock.calls[0]
    expect(body.lineItems?.[1]).toMatchObject({
      kind: 'retainer_credit',
      amount: -500,
      retainerInvoiceId: 'inv-ret',
    })
  })

  // The floor at zero. A $400 invoice cannot give back $500, because an invoice
  // reading -$100 would be a promise to pay the client.
  it('never offers more than the invoice comes to', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
        subtotal: 400,
        total: 400,
      }),
    ])
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())

    expect(applyButton()).toHaveTextContent('Apply retainer INV-RET-2026-001 credit ($400.00)')
    // And it says so, rather than leaving the missing $100 to be discovered.
    expect(screen.getByText(/held on account/i)).toBeInTheDocument()

    fireEvent.click(applyButton()!)
    expect(screen.getByText(/^Total \$0\.00/)).toBeInTheDocument()
  })

  it('offers nothing on an invoice that already carries a credit', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        lineItems: [
          { kind: 'hourly', label: 'Billable hours', detail: '', amount: 600 },
          {
            kind: 'retainer_credit',
            label: 'Retainer applied — credit',
            detail: 'Retainer INV-RET-2026-001',
            amount: -500,
            retainerInvoiceId: 'inv-ret',
          },
        ],
        total: 100,
      }),
    ])
    await openEditor()
    expect(applyButton()).not.toBeInTheDocument()
  })

  // Removing it is hers too, and it is the ordinary line control that does it.
  it('lets her take the credit back off', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)

    fireEvent.click(screen.getByLabelText('Remove Retainer applied — credit'))

    expect(screen.getByText(/^Total \$600\.00/)).toBeInTheDocument()
    expect(applyButton()).toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — the credit at the edges', () => {
  // Review comes before the money moves. Mirrors the server rule; the button is
  // simply not held out where pressing it would be refused.
  it('offers nothing on an invoice that has already gone out', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'sent' })])
    await openEditor('INV-2026-08-001', /^Sent/)
    expect(screen.getByText('Add a line')).toBeInTheDocument()
    expect(applyButton()).not.toBeInTheDocument()
  })

  it('offers nothing on a voided invoice', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'void' })])
    await openEditor('INV-2026-08-001', /^Voided/)
    expect(applyButton()).not.toBeInTheDocument()
  })

  // The server sizes the credit and rewrites whatever it is sent, so an
  // editable box would take a number and then silently replace it.
  it('shows the credit amount without offering to edit it', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)

    const amounts = screen.getAllByLabelText('Amount') as HTMLInputElement[]
    expect(amounts[1].readOnly).toBe(true)
    // The wording is still hers.
    expect(
      (screen.getByDisplayValue('Retainer applied — credit') as HTMLInputElement).readOnly,
    ).toBe(false)
    // ...and the scoped line above it is untouched by any of this.
    expect(amounts[0].readOnly).toBe(false)
  })

  // The refusal she will actually hit: that retainer was given back somewhere
  // else while this tab sat open.
  it('explains a refused credit beside the lines, and takes it back out', async () => {
    mockUpdate.mockRejectedValue(
      new ApiError(409, 'That retainer has already been applied to another invoice.'),
    )
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() =>
      expect(
        screen.getByText('That retainer has already been applied to another invoice.'),
      ).toBeInTheDocument(),
    )
    // The credit is gone from the editor — leaving it would fail every
    // subsequent save the same way, note to the client and all.
    expect(screen.queryByDisplayValue('Retainer applied — credit')).not.toBeInTheDocument()
    expect(screen.getByText(/^Total \$600\.00/)).toBeInTheDocument()
    // ...and it re-asks what is still on account rather than trusting its list.
    await waitFor(() => expect(mockRetainers).toHaveBeenCalledTimes(2))
  })

  // An ordinary failure is still the run's business, not the editor's.
  it('leaves a non-retainer failure to the run, with the lines intact', async () => {
    mockUpdate.mockRejectedValue(new ApiError(500, 'Could not save that change — please try again.'))
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() =>
      expect(
        screen.getByText('Could not save that change — please try again.'),
      ).toBeInTheDocument(),
    )
    expect(screen.getByDisplayValue('Retainer applied — credit')).toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — telling a retainer apart in the run', () => {
  it('tags the retainer sitting beside that client’s monthly invoice', async () => {
    mockList.mockResolvedValue([
      makeInvoice(),
      makeInvoice({
        id: 'inv-ret-aug',
        kind: 'retainer',
        number: 'INV-RET-2026-002',
        lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 2500 }],
        subtotal: 2500,
        total: 2500,
      }),
    ])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    await screen.findByText('INV-RET-2026-002')
    // One tag, on the retainer — the monthly invoice beside it wears nothing.
    expect(screen.getAllByText('Retainer')).toHaveLength(1)
  })

  it('does not offer to credit a retainer against itself', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        id: 'inv-ret-aug',
        kind: 'retainer',
        number: 'INV-RET-2026-002',
        lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 2500 }],
        subtotal: 2500,
        total: 2500,
      }),
    ])
    await openEditor('INV-RET-2026-002')
    expect(applyButton()).not.toBeInTheDocument()
  })
})
