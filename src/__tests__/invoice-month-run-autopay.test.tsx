import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { AutopayAttemptSummary, Client, PersistedInvoice } from '../lib/types'

/**
 * The month run's autopay surface (featreq-bef42b72): the "Autopay" /
 * "Autopay failed" badge on an invoice row, and the owner's "Charge again".
 *
 * The badge is advisory and SILENT when its data cannot load - the invoices
 * themselves must never depend on it.
 */

vi.mock('../lib/api', () => ({
  chargeAutopayAgainRequest: vi.fn(),
  checkAutopayAttemptRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listAutopayAttemptsRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  chargeAutopayAgainRequest,
  checkAutopayAttemptRequest,
  listAutopayAttemptsRequest,
  listInvoicesRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockAttempts = vi.mocked(listAutopayAttemptsRequest)
const mockChargeAgain = vi.mocked(chargeAutopayAgainRequest)
const mockCheck = vi.mocked(checkAutopayAttemptRequest)

const clients = [
  { id: 'client-acme', name: 'Acme LLC', contactIds: [], planIds: [] },
] as unknown as Client[]

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
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-28T10:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    emailLog: [{ at: '2026-08-28T10:00:00.000Z', to: ['ann@acme.com'], subject: 'Invoice', ok: true }],
    ...over,
  }) as PersistedInvoice

const attempt = (over: Partial<AutopayAttemptSummary> = {}): AutopayAttemptSummary => ({
  invoiceId: 'inv-1',
  attemptNo: 1,
  status: 'processing',
  errorCode: null,
  error: null,
  updatedAt: '2026-08-28T10:00:00.000Z',
  ...over,
})

async function renderRun(rows: PersistedInvoice[]) {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  // Sent and processing invoices live on the Sent tab.
  fireEvent.click(await screen.findByRole('tab', { name: /^Sent/ }))
  await screen.findByText('INV-2026-08-031')
}

beforeEach(() => {
  mockList.mockReset()
  mockAttempts.mockReset()
  mockChargeAgain.mockReset()
  mockCheck.mockReset()
})

describe('the Autopay badge', () => {
  it.each(['claimed', 'processing', 'succeeded'] as const)(
    'reads Autopay, quietly, while the attempt is %s',
    async (status) => {
      mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [attempt({ status })] })
      await renderRun([invoice({ status: 'processing' })])
      const badge = await screen.findByText('Autopay')
      expect(badge.className).not.toContain('is-bad')
      expect(screen.queryByText('Autopay failed')).toBeNull()
    },
  )

  it('reads Autopay failed, in red, with the reason on hover', async () => {
    mockAttempts.mockResolvedValue({
      chargingEnabled: true,
      attempts: [attempt({ status: 'failed', errorCode: 'card_declined', error: 'Your card was declined.' })],
    })
    await renderRun([invoice()])
    const badge = await screen.findByTitle('Your card was declined.')
    expect(badge.className).toContain('is-bad')
    expect(badge.textContent).toBe('Autopay failed')
  })

  it('shows no badge for an invoice autopay never touched', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [] })
    await renderRun([invoice()])
    await waitFor(() => expect(mockAttempts).toHaveBeenCalled())
    expect(screen.queryByText(/^Autopay/)).toBeNull()
  })

  it('shows another invoice’s attempt on that invoice only', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [attempt({ invoiceId: 'inv-other' })] })
    await renderRun([invoice()])
    await waitFor(() => expect(mockAttempts).toHaveBeenCalled())
    expect(screen.queryByText(/^Autopay/)).toBeNull()
  })

  it('is silent, and the invoices still list, when the attempts cannot be loaded', async () => {
    mockAttempts.mockRejectedValue(new Error('down'))
    await renderRun([invoice()])
    expect(screen.queryByText(/^Autopay/)).toBeNull()
    expect(screen.getByText('INV-2026-08-031')).toBeInTheDocument()
  })
})

describe('Charge again', () => {
  const failed = attempt({ status: 'failed', errorCode: 'card_declined', error: 'Your card was declined.' })

  it('is offered for a failed attempt while charging is on', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [failed] })
    await renderRun([invoice()])
    expect(await screen.findByRole('button', { name: 'Charge again' })).toBeInTheDocument()
    expect(screen.getByText(/The client was not charged/)).toBeInTheDocument()
  })

  it('is NOT offered while charging is switched off - the failure is still explained', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: false, attempts: [failed] })
    await renderRun([invoice()])
    await screen.findByText(/The client was not charged/)
    expect(screen.queryByRole('button', { name: 'Charge again' })).toBeNull()
  })

  it.each(['debit_not_authorized', 'account_closed', 'no_account'])(
    'is NOT offered when the bank said %s (autopay is off for that client)',
    async (errorCode) => {
      mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [{ ...failed, errorCode }] })
      await renderRun([invoice()])
      await screen.findByText(/The client was not charged/)
      expect(screen.queryByRole('button', { name: 'Charge again' })).toBeNull()
    },
  )

  it('is NOT offered once the invoice is no longer sent', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [failed] })
    await renderRun([invoice({ status: 'processing' })])
    await screen.findByText('Autopay failed')
    expect(screen.queryByRole('button', { name: 'Charge again' })).toBeNull()
  })

  it('charges the invoice the button is on, once, and looks at the attempts again', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [failed] })
    mockChargeAgain.mockResolvedValue(invoice({ status: 'processing' }))
    await renderRun([invoice()])
    fireEvent.click(await screen.findByRole('button', { name: 'Charge again' }))
    await waitFor(() => expect(mockChargeAgain).toHaveBeenCalledWith('inv-1'))
    expect(mockChargeAgain).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mockAttempts.mock.calls.length).toBeGreaterThan(1))
  })

  it('shows the server’s sentence when it refuses', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [failed] })
    mockChargeAgain.mockRejectedValue(new Error('This client is not set up for automatic payments.'))
    await renderRun([invoice()])
    fireEvent.click(await screen.findByRole('button', { name: 'Charge again' }))
    expect(await screen.findByText('This client is not set up for automatic payments.')).toBeInTheDocument()
  })
})

describe('Check with Stripe (a stuck attempt)', () => {
  const stuck = attempt({
    status: 'claimed',
    error: 'socket hang up',
    updatedAt: '2026-08-28T10:00:00.000Z',
  })

  it('an attempt that ended in an unconfirmed error offers Check with Stripe', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [stuck] })
    await renderRun([invoice()])
    expect(await screen.findByText('Automatic payment not confirmed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check with Stripe' })).toBeInTheDocument()
    // It is not offered Charge again: nothing has failed yet.
    expect(screen.queryByRole('button', { name: 'Charge again' })).toBeNull()
  })

  it('an attempt that has simply sat claimed for a long time is stuck too', async () => {
    mockAttempts.mockResolvedValue({
      chargingEnabled: true,
      attempts: [attempt({ status: 'claimed', error: null, updatedAt: '2020-01-01T00:00:00.000Z' })],
    })
    await renderRun([invoice()])
    expect(await screen.findByRole('button', { name: 'Check with Stripe' })).toBeInTheDocument()
  })

  it('a charge that is only seconds old, with no error, is left alone', async () => {
    mockAttempts.mockResolvedValue({
      chargingEnabled: true,
      attempts: [attempt({ status: 'claimed', error: null, updatedAt: new Date().toISOString() })],
    })
    await renderRun([invoice()])
    await screen.findByText('Autopay')
    expect(screen.queryByRole('button', { name: 'Check with Stripe' })).toBeNull()
  })

  it('asks the server once, shows its sentence, and looks at the attempts again', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [stuck] })
    mockCheck.mockResolvedValue({
      outcome: 'no_payment_found',
      message: 'Stripe has no payment for this attempt, so nothing was charged.',
      invoice: invoice(),
    })
    await renderRun([invoice()])
    fireEvent.click(await screen.findByRole('button', { name: 'Check with Stripe' }))
    expect(await screen.findByText(/nothing was charged/)).toBeInTheDocument()
    expect(mockCheck).toHaveBeenCalledWith('inv-1')
    expect(mockCheck).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mockAttempts.mock.calls.length).toBeGreaterThan(1))
  })

  it('shows the refusal when Stripe cannot be reached', async () => {
    mockAttempts.mockResolvedValue({ chargingEnabled: true, attempts: [stuck] })
    mockCheck.mockRejectedValue(new Error('Stripe could not be reached, so nothing was changed.'))
    await renderRun([invoice()])
    fireEvent.click(await screen.findByRole('button', { name: 'Check with Stripe' }))
    expect(await screen.findByText(/nothing was changed/)).toBeInTheDocument()
  })
})
