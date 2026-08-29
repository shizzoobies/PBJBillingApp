import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BilledOnCard } from '../components/BilledOnCard'
import type { BilledOnInvoice } from '../lib/api'

/**
 * The "Billed on" card on a sub client's page.
 *
 * A company pointed at a billing master generates no invoice of its own. The
 * plan named this as one of the surfaces that breaks if the three companies are
 * simply skipped: a client page showing nothing for the month does not read as
 * "billed elsewhere", it reads as "we forgot to bill them". This card is the
 * answer, and the sentence above the rows is the part that does the explaining.
 *
 * The amount on a row is THIS company's share of the master's invoice, not the
 * master's total — the endpoint sends it as `subtotal`, and nothing here
 * recomputes it.
 */

vi.mock('../lib/api', () => ({
  listBilledOnInvoicesRequest: vi.fn(),
}))

import { listBilledOnInvoicesRequest } from '../lib/api'

const mockBilledOn = vi.mocked(listBilledOnInvoicesRequest)

const paidRow: BilledOnInvoice = {
  invoiceId: 'inv-master-sep',
  number: 'INV-2026-09-004',
  period: '2026-09',
  status: 'paid',
  masterClientId: 'client-klc-master',
  masterClientName: 'KLC Master',
  subtotal: 425,
  paidAt: '2026-09-03T14:00:00.000Z',
}

const unpaidRow: BilledOnInvoice = {
  ...paidRow,
  invoiceId: 'inv-master-oct',
  number: 'INV-2026-10-004',
  period: '2026-10',
  status: 'sent',
  subtotal: 300,
  paidAt: null,
}

const renderCard = (masterName: string | null = 'KLC Master') =>
  render(<BilledOnCard clientId="client-chemtrex" masterName={masterName} />)

beforeEach(() => {
  mockBilledOn.mockReset()
  mockBilledOn.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BilledOnCard', () => {
  it('asks the endpoint for this client', async () => {
    renderCard()

    await waitFor(() => expect(mockBilledOn).toHaveBeenCalledWith('client-chemtrex'))
  })

  it('says, in one line, why this client has no invoice of its own', async () => {
    renderCard()

    expect(
      await screen.findByText("Invoiced on KLC Master’s combined invoice."),
    ).toBeInTheDocument()
  })

  it('lists the invoice, whose it is, this company’s share and when it was paid', async () => {
    mockBilledOn.mockResolvedValue([paidRow])
    renderCard()

    const row = await screen.findByText(/INV-2026-09-004/)
    expect(row.textContent).toContain('(KLC Master)')
    expect(row.textContent).toContain('$425.00')
    expect(row.textContent).toContain('paid Sep 3')
  })

  it('pills the status in the house style', async () => {
    mockBilledOn.mockResolvedValue([paidRow, unpaidRow])
    renderCard()

    await screen.findByText(/INV-2026-09-004/)
    const pills = [...document.querySelectorAll('.invoice-status')]
    expect(pills.map((pill) => pill.textContent)).toEqual(['Paid', 'Sent'])
    expect(pills[0].className).toContain('is-paid')
    expect(pills[1].className).toContain('is-sent')
  })

  // A date beside an unpaid invoice would be a rendering fault, so there is
  // none — the pill is what says where it is.
  it('shows no paid date on an invoice that has not been paid', async () => {
    mockBilledOn.mockResolvedValue([unpaidRow])
    renderCard()

    const row = await screen.findByText(/INV-2026-10-004/)
    expect(row.textContent).not.toContain('paid')
  })

  it('names the master in its empty state rather than showing a blank card', async () => {
    renderCard()

    expect(
      await screen.findByText("Nothing has been billed on KLC Master’s invoice yet."),
    ).toBeInTheDocument()
  })

  // A master that is not in the workspace is a name we cannot vouch for.
  it('falls back when the master is not on file', async () => {
    renderCard(null)

    expect(
      await screen.findByText("Invoiced on another client’s combined invoice."),
    ).toBeInTheDocument()
  })

  it('says so when the endpoint refuses', async () => {
    mockBilledOn.mockRejectedValue(new Error('Failed to load billed-on invoices (500)'))
    renderCard()

    expect(
      await screen.findByText('Failed to load billed-on invoices (500)'),
    ).toBeInTheDocument()
  })
})
