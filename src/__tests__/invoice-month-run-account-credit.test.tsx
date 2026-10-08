import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { ApiError, type Client, type PersistedInvoice } from '../lib/types'

/**
 * Credit on account in the month-run editor (stage 1b).
 *
 * THE APP OFFERS, THE SERVER DECIDES. The button shows when the client has a
 * balance and the invoice is a draft or reviewed monthly one; pressing it asks the
 * SERVER to draw the credit (which credits, how much, under a per-client lock),
 * and the saved invoice that comes back is what the editor shows. Nothing here
 * sizes a credit, and nothing applies one on her behalf.
 */

vi.mock('../lib/api', () => ({
  applyAccountCreditRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listAccountCreditsRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  removeAccountCreditRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  applyAccountCreditRequest,
  generateInvoicesRequest,
  listAccountCreditsRequest,
  listInvoicesRequest,
  regenerateInvoicesRequest,
  listUnappliedRetainersRequest,
  removeAccountCreditRequest,
  updateInvoiceRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockBalance = vi.mocked(listAccountCreditsRequest)
const mockApply = vi.mocked(applyAccountCreditRequest)
const mockRemove = vi.mocked(removeAccountCreditRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockGenerate = vi.mocked(generateInvoicesRequest)
const mockRegenerate = vi.mocked(regenerateInvoicesRequest)

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

const hours = { kind: 'hourly', label: 'Billable hours - Lisa', detail: '', amount: 600 } as const
const creditLine = {
  kind: 'account_credit',
  label: 'Credit on account',
  detail: '',
  amount: -200,
  draws: [{ creditId: 'credit-1', amount: 200 }],
} as const

function makeInvoice(overrides: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-a',
    clientId: 'client-acme',
    period: '2026-10',
    kind: 'monthly',
    number: 'INV-2026-10-001',
    status: 'draft',
    lineItems: [{ ...hours }],
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
    updatedAt: 'u1',
    ...overrides,
  }
}

const credited = (overrides: Partial<PersistedInvoice> = {}) =>
  makeInvoice({
    lineItems: [{ ...hours }, { ...creditLine, draws: [...creditLine.draws] }],
    total: 400,
    updatedAt: 'u2',
    ...overrides,
  })

async function openEditor(number = 'INV-2026-10-001', tab?: RegExp) {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText(number))
}

const applyButton = () => screen.queryByRole('button', { name: 'Apply credit on account' })
const removeButton = () =>
  screen.queryByRole('button', { name: 'Remove credit on account from this invoice' })

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([makeInvoice()])
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockBalance.mockReset()
  mockBalance.mockResolvedValue({ balance: 250, credits: [] })
  mockApply.mockReset()
  mockApply.mockResolvedValue(credited())
  mockRemove.mockReset()
  mockRemove.mockResolvedValue(makeInvoice({ updatedAt: 'u3' }))
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(makeInvoice({ updatedAt: 'u4' }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun - Apply credit on account', () => {
  it('is offered beside the retainer credit, with the balance in its title', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    expect(applyButton()).toHaveAttribute('title', '$250.00 on account for this client')
    expect(mockBalance).toHaveBeenCalledWith('client-acme')
    expect(applyButton()).toBeEnabled()
  })

  it('is also offered next to a retainer credit when the client has both', async () => {
    mockRetainers.mockResolvedValue([
      makeInvoice({
        id: 'inv-ret',
        kind: 'retainer',
        number: 'INV-RET-2026-001',
        period: '2026-01',
        status: 'paid',
        lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
        total: 500,
      }),
    ])
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Apply retainer/i })).toBeInTheDocument()
  })

  it('is not offered when the client has nothing on account', async () => {
    mockBalance.mockResolvedValue({ balance: 0, credits: [] })
    await openEditor()
    expect(screen.getByText('Add a line')).toBeInTheDocument()
    await waitFor(() => expect(mockBalance).toHaveBeenCalled())
    expect(applyButton()).not.toBeInTheDocument()
  })

  it('is not offered, and the balance is not even read, once the invoice has gone out', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'sent', sentAt: '2026-11-01T00:00:00.000Z' })])
    await openEditor('INV-2026-10-001', /sent/i)
    expect(await screen.findByText('Add a line')).toBeInTheDocument()
    expect(applyButton()).not.toBeInTheDocument()
    expect(mockBalance).not.toHaveBeenCalled()
  })

  it('is not offered on a reviewed invoice\'s retainer cousin: a retainer invoice is not a thing you credit', async () => {
    mockList.mockResolvedValue([
      makeInvoice({
        kind: 'retainer',
        number: 'INV-RET-2026-009',
        lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
        total: 500,
      }),
    ])
    await openEditor('INV-RET-2026-009')
    await waitFor(() => expect(screen.getAllByText(/INV-RET-2026-009/).length).toBeGreaterThan(0))
    expect(applyButton()).not.toBeInTheDocument()
    expect(mockBalance).not.toHaveBeenCalled()
  })

  it('is offered on a reviewed invoice too', async () => {
    mockList.mockResolvedValue([makeInvoice({ status: 'reviewed' })])
    await openEditor('INV-2026-10-001', /reviewed/i)
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
  })

  it('is not offered on an invoice that already carries the line', async () => {
    mockList.mockResolvedValue([credited()])
    await openEditor()
    expect(await screen.findByTestId('account-credit-applied')).toBeInTheDocument()
    expect(applyButton()).not.toBeInTheDocument()
    expect(mockBalance).not.toHaveBeenCalled()
  })

  it('stays quiet when the balance cannot be read: the button just does not appear', async () => {
    mockBalance.mockRejectedValue(new Error('offline'))
    await openEditor()
    await waitFor(() => expect(mockBalance).toHaveBeenCalled())
    expect(screen.getByText('Add a line')).toBeInTheDocument()
    expect(applyButton()).not.toBeInTheDocument()
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument()
  })

  it('does not apply on her behalf: opening the editor writes nothing', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(screen.getByText(/^Total \$600\.00/)).toBeInTheDocument()
  })

  it('asks the server to apply, and shows the saved invoice that comes back', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)

    await waitFor(() => expect(mockApply).toHaveBeenCalledWith('inv-a'))
    // The credit is the SERVER's: its label, its amount, its total.
    expect(await screen.findByDisplayValue('Credit on account')).toBeInTheDocument()
    expect(screen.getByTestId('account-credit-applied')).toHaveTextContent('Credit applied $200.00')
    expect(screen.getByText(/^Total \$400\.00/)).toBeInTheDocument()
    // One credit per invoice: the offer is gone.
    expect(applyButton()).not.toBeInTheDocument()
    // Nothing was saved through the ordinary line save.
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('does not let her type the amount of the credit: the server sizes it', async () => {
    mockList.mockResolvedValue([credited()])
    await openEditor()
    const amounts = await screen.findAllByLabelText('Amount')
    const creditAmount = amounts.find((input) => (input as HTMLInputElement).value === '-200')
    expect(creditAmount).toBeDefined()
    expect(creditAmount).toHaveAttribute('readonly')
  })

  it('says the refusal beside the buttons and keeps the lines as they were', async () => {
    mockApply.mockRejectedValue(
      new ApiError(409, 'This client has no credit on account to apply.', 'account_credit_refused'),
    )
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.click(applyButton()!)

    expect(await screen.findByText(/no credit on account to apply/i)).toBeInTheDocument()
    expect(screen.getByText(/^Total \$600\.00/)).toBeInTheDocument()
    expect(applyButton()).toBeEnabled()
  })

  it('waits behind unsaved edits, because the server\'s answer replaces the editor', async () => {
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    fireEvent.change(screen.getAllByLabelText('Amount')[0], { target: { value: '650' } })

    expect(applyButton()).toBeDisabled()
    expect(applyButton()).toHaveAttribute('title', 'Save your changes first, then apply the credit')
    fireEvent.click(applyButton()!)
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('is disabled, and says why, on an invoice with nothing on it to credit', async () => {
    mockList.mockResolvedValue([makeInvoice({ lineItems: [], subtotal: 0, total: 0 })])
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    expect(applyButton()).toBeDisabled()
    expect(applyButton()).toHaveAttribute('title', 'There is nothing on this invoice left to credit')
  })
})

describe('InvoiceMonthRun - the applied credit', () => {
  it('shows what was applied, with a Remove control', async () => {
    mockList.mockResolvedValue([credited()])
    await openEditor()
    expect(await screen.findByTestId('account-credit-applied')).toHaveTextContent('Credit applied $200.00')
    expect(removeButton()).toBeEnabled()
  })

  it('asks the server to remove it and shows the invoice that comes back without it', async () => {
    mockList.mockResolvedValue([credited()])
    await openEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove credit on account from this invoice' }))

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('inv-a'))
    await waitFor(() => expect(screen.queryByTestId('account-credit-applied')).not.toBeInTheDocument())
    expect(screen.getByText(/^Total \$600\.00/)).toBeInTheDocument()
    // And it is offered again, the balance having come back.
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
  })

  it('waits behind unsaved edits like Apply does', async () => {
    mockList.mockResolvedValue([credited()])
    await openEditor()
    await screen.findByTestId('account-credit-applied')
    fireEvent.change(screen.getAllByLabelText('Amount')[0], { target: { value: '650' } })
    expect(removeButton()).toBeDisabled()
    expect(removeButton()).toHaveAttribute('title', 'Save your changes first')
  })

  it('says a refused removal beside the buttons', async () => {
    mockList.mockResolvedValue([credited()])
    mockRemove.mockRejectedValue(new ApiError(409, 'This invoice was paid while you looked.', 'invoice_locked'))
    await openEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove credit on account from this invoice' }))
    expect(await screen.findByText(/paid while you looked/i)).toBeInTheDocument()
  })

  it('is not offered a Remove on a paid invoice, which is locked', async () => {
    mockList.mockResolvedValue([credited({ status: 'paid', paidAt: '2026-11-03T00:00:00.000Z' })])
    await openEditor('INV-2026-10-001', /paid/i)
    expect(await screen.findByTestId('account-credit-applied')).toBeInTheDocument()
    expect(removeButton()).not.toBeInTheDocument()
  })

  it('a save that drops a credit the server could not keep says so in the run\'s banner', async () => {
    mockList.mockResolvedValue([credited()])
    mockUpdate.mockResolvedValue(
      makeInvoice({
        updatedAt: 'u5',
        accountCreditNotice:
          'The credit on account on this invoice could not be kept (it was voided or used elsewhere), so it was taken off.',
      }),
    )
    await openEditor()
    await screen.findByTestId('account-credit-applied')
    fireEvent.change(screen.getAllByLabelText('Amount')[0], { target: { value: '650' } })
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(await screen.findByText(/could not be kept/i)).toBeInTheDocument()
  })

  it('sends the credit line along with an ordinary save of the other lines', async () => {
    mockList.mockResolvedValue([credited()])
    await openEditor()
    await screen.findByTestId('account-credit-applied')
    fireEvent.change(screen.getAllByLabelText('Amount')[0], { target: { value: '650' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, body] = mockUpdate.mock.calls[0]
    expect(body.lineItems?.[1]).toMatchObject({ kind: 'account_credit', draws: [{ creditId: 'credit-1', amount: 200 }] })
  })
})

/**
 * Stage 1c: the month run draws credit on account onto each new monthly draft
 * itself. The draft is the same invoice with the same line (so the editor, the
 * Remove button and the rest above are unchanged); what is new is that the note
 * after a build says it happened, so a $0 draft is never a surprise.
 */
describe('InvoiceMonthRun - credit drawn at generation', () => {
  const draftWithCredit = (amount: number) =>
    makeInvoice({
      lineItems: [{ ...hours }, { ...creditLine, amount: -amount, draws: [{ creditId: 'credit-1', amount }] }],
      total: 600 - amount,
      updatedAt: 'g1',
    })

  it('Generate says how much credit on account it applied', async () => {
    mockList.mockResolvedValue([])
    mockGenerate.mockResolvedValue({
      period: '2026-10',
      created: [draftWithCredit(250)],
      skipped: [],
    })
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText('Built 1 invoice. Credit on account applied: $250.00 on 1 invoice.'),
    ).toBeInTheDocument()
  })

  it('Generate adds nothing to its note when no draft drew credit', async () => {
    mockList.mockResolvedValue([])
    mockGenerate.mockResolvedValue({ period: '2026-10', created: [makeInvoice()], skipped: [] })
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Generate' }))

    expect(await screen.findByText('Built 1 invoice.')).toBeInTheDocument()
    expect(screen.queryByText(/Credit on account applied/)).not.toBeInTheDocument()
  })

  it('Void & regenerate says the rebuilt drafts drew their credit again', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockRegenerate.mockResolvedValue({
      period: '2026-10',
      voided: 1,
      created: [draftWithCredit(600)],
      skipped: [],
    })
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Void & regenerate/ }))

    expect(
      await screen.findByText('Voided 1 and rebuilt 1 invoice. Credit on account applied: $600.00 on 1 invoice.'),
    ).toBeInTheDocument()
  })

  it('Void & regenerate says "carried over" when the voided draft already held the credit', async () => {
    mockList.mockResolvedValue([draftWithCredit(600)])
    mockRegenerate.mockResolvedValue({
      period: '2026-10',
      voided: 1,
      created: [draftWithCredit(600)],
      skipped: [],
    })
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Void & regenerate/ }))

    expect(
      await screen.findByText('Voided 1 and rebuilt 1 invoice. Credit on account carried over: $600.00 on 1 invoice.'),
    ).toBeInTheDocument()
  })

  it('a generated draft is the ordinary credited draft: the credit shows and Remove credit is offered', async () => {
    mockList.mockResolvedValue([draftWithCredit(200)])
    await openEditor()
    expect(await screen.findByRole('button', { name: 'Remove credit on account from this invoice' })).toBeInTheDocument()
    expect(applyButton()).not.toBeInTheDocument()
  })
})

describe('InvoiceMonthRun - Apply credit on account and a later month\'s prepayment (R-2)', () => {
  const credit = (over: Record<string, unknown>) => ({
    id: 'c',
    clientId: 'client-acme',
    amount: 500,
    sourceKind: 'prepayment',
    sourceRef: 'x',
    forPeriod: null,
    note: '',
    createdBy: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    voidedAt: null,
    voidedBy: null,
    draws: [],
    remaining: 500,
    ...over,
  })

  it('shows what this invoice can take, and keeps a later month\'s prepayment out of the figure', async () => {
    mockBalance.mockResolvedValue({
      balance: 700,
      credits: [
        credit({ id: 'prepay:a:2026-10', forPeriod: '2026-10', derived: true, remaining: 200 }),
        credit({ id: 'prepay:a:2026-11', forPeriod: '2026-11', derived: true, remaining: 500 }),
      ],
    } as never)
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    expect(applyButton()).toHaveAttribute('title', '$200.00 on account for this client')
    expect(applyButton()).toBeEnabled()
  })

  it('shows Apply disabled, saying why, when everything left is prepaid for later months', async () => {
    mockBalance.mockResolvedValue({
      balance: 500,
      credits: [credit({ id: 'prepay:a:2026-11', forPeriod: '2026-11', derived: true, remaining: 500 })],
    } as never)
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeInTheDocument())
    expect(applyButton()).toBeDisabled()
    expect(applyButton()).toHaveAttribute(
      'title',
      '$500.00 on account is prepaid for later months and is applied on those invoices',
    )
  })

  it('a stored credit meant for a later month still counts as available', async () => {
    mockBalance.mockResolvedValue({
      balance: 300,
      credits: [credit({ id: 'manual', sourceKind: 'manual', forPeriod: '2026-11', remaining: 300 })],
    } as never)
    await openEditor()
    await waitFor(() => expect(applyButton()).toBeEnabled())
    expect(applyButton()).toHaveAttribute('title', '$300.00 on account for this client')
  })
})
