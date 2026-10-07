import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { AccountCredit, Client, PersistedInvoice } from '../lib/types'

/**
 * "Apply as credit" on a double payment (credit on account, stage 1e): beside
 * Mark as handled on the Need-a-look notice, a confirm step that names the amount
 * and the client it credits, a lower-amount field, and a note that survives the
 * editor reloading.
 */

vi.mock('../lib/api', () => ({
  acknowledgeInvoiceAmountMismatchRequest: vi.fn(),
  applyDuplicatePaymentAsCreditRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  applyDuplicatePaymentAsCreditRequest,
  listInvoicesRequest,
  listUnappliedRetainersRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockApply = vi.mocked(applyDuplicatePaymentAsCreditRequest)

const acme = {
  id: 'client-acme',
  name: 'Acme',
  contact: '',
  billingMode: 'hourly',
  hourlyRate: 125,
  planIds: [],
  contactIds: [],
} as unknown as Client

const duplicate = {
  kind: 'payment',
  event: 'amount-mismatch',
  at: '2026-09-12T14:00:00.000Z',
  paymentIntentId: 'pi_2',
  expectedCents: 40000,
  receivedCents: 41250,
  reason: 'duplicate',
} as const

const handledEntry = {
  kind: 'payment',
  event: 'amount-mismatch-handled',
  at: '2026-09-13T10:00:00.000Z',
  by: 'owner-1',
  paymentIntentId: 'pi_2',
} as const

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'paid',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-20T00:00:00.000Z',
    paidAt: '2026-09-10T14:00:00.000Z',
    paymentMethod: 'card',
    emailLog: [duplicate],
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  } as PersistedInvoice
}

const creditRow = (over: Partial<AccountCredit> = {}) =>
  ({
    id: 'credit-1',
    clientId: 'client-acme',
    amount: 412.5,
    sourceKind: 'overpayment',
    sourceRef: 'pi_2',
    forPeriod: null,
    note: 'Second payment on INV-2026-08-001',
    createdBy: 'owner-1',
    createdAt: '2026-10-07T15:00:00.000Z',
    voidedAt: null,
    voidedBy: null,
    draws: [],
    remaining: 412.5,
    ...over,
  }) as AccountCredit

const needALookStat = () => {
  const label = screen.getByText('Need a look')
  return within(label.parentElement as HTMLElement).getByText(/^\d+$/)
}

async function openEditor(clients: Client[] = [acme]) {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockApply.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Apply as credit on a second payment', () => {
  it('sits beside Mark as handled on a settled duplicate, enabled', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    await openEditor()

    expect(await screen.findByRole('button', { name: 'Mark as handled' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply as credit' })).toBeEnabled()
  })

  it('is not offered for a payment of a different amount, which is not a double payment', async () => {
    mockList.mockResolvedValue([
      makeInvoice({ emailLog: [{ ...duplicate, reason: undefined }] } as Partial<PersistedInvoice>),
    ])
    await openEditor()

    expect(await screen.findByRole('button', { name: 'Mark as handled' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply as credit' })).not.toBeInTheDocument()
  })

  it("stays enabled while the bank payment looks like it is settling: the server asks Stripe and says so", async () => {
    mockList.mockResolvedValue([makeInvoice({ emailLog: [{ ...duplicate, settling: true }] } as Partial<PersistedInvoice>)])
    mockApply.mockRejectedValue(new Error('That payment is still settling - try once it clears.'))
    await openEditor()

    const button = await screen.findByRole('button', { name: 'Apply as credit' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add $412.50 to credit' }))

    expect(await screen.findByText('That payment is still settling - try once it clears.')).toBeInTheDocument()
    expect(needALookStat()).toHaveTextContent('1')
  })

  it('Mark as handled is disabled while Apply as credit is running', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    let finish: (value: Awaited<ReturnType<typeof applyDuplicatePaymentAsCreditRequest>>) => void = () => {}
    mockApply.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    await openEditor()

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add $412.50 to credit' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark as handled' })).toBeDisabled())
    finish({
      credit: creditRow(),
      invoice: makeInvoice({ emailLog: [duplicate, handledEntry], updatedAt: 'later' }),
      replayed: false,
    })
    expect(await screen.findByText("Added $412.50 to Acme's credit on account")).toBeInTheDocument()
  })

  describe('a card payment: the fee is taken off the default, never off what she may raise it to', () => {
    // total $1,000.00 + card fee $30.18 = $1,030.18 charged
    const cardInvoice = () =>
      makeInvoice({
        lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 1000 }],
        subtotal: 1000,
        total: 1000,
        emailLog: [{ ...duplicate, expectedCents: 100000, receivedCents: 103018, card: true }],
      } as unknown as Partial<PersistedInvoice>)

    it('shows the breakdown and defaults to what reached the firm', async () => {
      mockList.mockResolvedValue([cardInvoice()])
      await openEditor()

      fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
      const panel = await screen.findByRole('group', { name: 'Apply as credit' })
      expect(
        within(panel).getByText('Charged $1,030.18 (includes $30.18 card fee) - credit $1,000.00'),
      ).toBeInTheDocument()
      expect(within(panel).getByLabelText('Credit amount')).toHaveValue(1000)
      expect(within(panel).getByText(/Add \$1,000\.00 to Acme's credit on account\./)).toBeInTheDocument()
    })

    it('sends the shown default, and the charged amount when she raises it to that', async () => {
      mockList.mockResolvedValue([cardInvoice()])
      mockApply.mockResolvedValue({
        credit: creditRow({ amount: 1030.18 }),
        invoice: makeInvoice({ emailLog: [duplicate, handledEntry], updatedAt: 'later' }),
        replayed: false,
      })
      await openEditor()

      fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
      const panel = await screen.findByRole('group', { name: 'Apply as credit' })
      const amount = within(panel).getByLabelText('Credit amount')

      fireEvent.change(amount, { target: { value: '1030.19' } })
      expect(within(panel).getByText(/cannot be more than \$1,030\.18/)).toBeInTheDocument()

      fireEvent.change(amount, { target: { value: '1030.18' } })
      fireEvent.click(within(panel).getByRole('button', { name: 'Add $1,030.18 to credit' }))
      await waitFor(() =>
        expect(mockApply).toHaveBeenCalledWith('inv-1', { paymentIntentId: 'pi_2', amount: 1030.18 }),
      )
    })

    it('the default click sends the amount the box showed', async () => {
      mockList.mockResolvedValue([cardInvoice()])
      mockApply.mockResolvedValue({
        credit: creditRow({ amount: 1000 }),
        invoice: makeInvoice({ emailLog: [duplicate, handledEntry], updatedAt: 'later' }),
        replayed: false,
      })
      await openEditor()

      fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
      const panel = await screen.findByRole('group', { name: 'Apply as credit' })
      fireEvent.click(within(panel).getByRole('button', { name: 'Add $1,000.00 to credit' }))
      await waitFor(() =>
        expect(mockApply).toHaveBeenCalledWith('inv-1', { paymentIntentId: 'pi_2', amount: 1000 }),
      )
    })

    it('a bank payment shows no breakdown and defaults to the full amount', async () => {
      mockList.mockResolvedValue([makeInvoice()])
      await openEditor()

      fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
      const panel = await screen.findByRole('group', { name: 'Apply as credit' })
      expect(within(panel).queryByText(/card fee/)).not.toBeInTheDocument()
      expect(within(panel).getByLabelText('Credit amount')).toHaveValue(412.5)
    })
  })

  it('asks first, naming the amount and the client the credit goes to, and cancelling sends nothing', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    await openEditor()

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))

    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    expect(within(panel).getByText(/Add \$412\.50 to Acme's credit on account\./)).toBeInTheDocument()
    expect(within(panel).getByLabelText('Credit amount')).toHaveValue(412.5)
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Apply as credit' })).not.toBeInTheDocument()
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('credits everything by default: the request names the payment and the amount the box showed', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockApply.mockResolvedValue({
      credit: creditRow(),
      invoice: makeInvoice({ emailLog: [duplicate, handledEntry], updatedAt: 'later' }),
      replayed: false,
    })
    await openEditor()

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add $412.50 to credit' }))

    await waitFor(() =>
      expect(mockApply).toHaveBeenCalledWith('inv-1', { paymentIntentId: 'pi_2', amount: 412.5 }),
    )
  })

  it("afterwards the marker is gone and a note says what was added, which survives the editor's reload", async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockApply.mockResolvedValue({
      credit: creditRow(),
      invoice: makeInvoice({ emailLog: [duplicate, handledEntry], updatedAt: 'later' }),
      replayed: false,
    })
    await openEditor()
    expect(needALookStat()).toHaveTextContent('1')

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add $412.50 to credit' }))

    expect(await screen.findByText("Added $412.50 to Acme's credit on account")).toBeInTheDocument()
    await waitFor(() => expect(needALookStat()).toHaveTextContent('0'))
    expect(screen.queryByRole('button', { name: 'Apply as credit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark as handled' })).not.toBeInTheDocument()
    expect(screen.queryByText('Second payment $412.50')).not.toBeInTheDocument()
  })

  it('a lower amount is sent as dollars; a higher one is refused on the spot', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockApply.mockResolvedValue({
      credit: creditRow({ amount: 400, remaining: 400 }),
      invoice: makeInvoice({ emailLog: [duplicate, handledEntry], updatedAt: 'later' }),
      replayed: false,
    })
    await openEditor()

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    const amount = within(panel).getByLabelText('Credit amount')

    fireEvent.change(amount, { target: { value: '500' } })
    expect(within(panel).getByText(/cannot be more than \$412\.50/)).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /^Add .* to credit$/ })).toBeDisabled()

    fireEvent.change(amount, { target: { value: '400' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add $400.00 to credit' }))

    await waitFor(() => expect(mockApply).toHaveBeenCalledWith('inv-1', { paymentIntentId: 'pi_2', amount: 400 }))
    expect(await screen.findByText("Added $400.00 to Acme's credit on account")).toBeInTheDocument()
  })

  it('names the MASTER when the invoice belongs to a billing sub', async () => {
    const master = { ...acme, id: 'client-master', name: 'KLC Group', isBillingMaster: true } as unknown as Client
    const sub = { ...acme, billToClientId: 'client-master' } as unknown as Client
    mockList.mockResolvedValue([makeInvoice()])
    await openEditor([sub, master])

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    expect(within(panel).getByText(/Add \$412\.50 to KLC Group's credit on account\./)).toBeInTheDocument()
  })

  it('says the refusal inline and keeps the flag when the server will not do it', async () => {
    mockList.mockResolvedValue([makeInvoice()])
    mockApply.mockRejectedValue(new Error('That payment is still settling - try once it clears.'))
    await openEditor()

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add $412.50 to credit' }))

    expect(await screen.findByText('That payment is still settling - try once it clears.')).toBeInTheDocument()
    expect(needALookStat()).toHaveTextContent('1')
    expect(screen.queryByText(/Added \$/)).not.toBeInTheDocument()
  })

  it('when Stripe did not say the amount, the panel says it credits what Stripe collected and sends no amount', async () => {
    mockList.mockResolvedValue([
      makeInvoice({ emailLog: [{ ...duplicate, receivedCents: null }] } as Partial<PersistedInvoice>),
    ])
    mockApply.mockResolvedValue({
      credit: creditRow(),
      invoice: makeInvoice({ emailLog: [duplicate, handledEntry], updatedAt: 'later' }),
      replayed: false,
    })
    await openEditor()

    fireEvent.click(await screen.findByRole('button', { name: 'Apply as credit' }))
    const panel = await screen.findByRole('group', { name: 'Apply as credit' })
    expect(within(panel).getByText(/everything Stripe collected for it/)).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'Add to credit' }))
    await waitFor(() => expect(mockApply).toHaveBeenCalledWith('inv-1', { paymentIntentId: 'pi_2' }))
  })
})
