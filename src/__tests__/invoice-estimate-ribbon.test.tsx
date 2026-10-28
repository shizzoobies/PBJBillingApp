import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceRecapPage } from '../pages/InvoiceRecapPage'
import type { InvoiceEstimate } from '../lib/api'

/**
 * The owner's estimate ribbon on the Invoice Recap (featreq-a5e14899). The
 * App passes `ownerEstimate` only for the owner outside preview; staff and
 * preview must never request the route and see the page exactly as before.
 */

vi.mock('../lib/api', () => ({
  invoiceRecapRequest: vi.fn(),
  invoiceEstimateRequest: vi.fn(),
}))

import { invoiceEstimateRequest, invoiceRecapRequest } from '../lib/api'

const mockRecap = vi.mocked(invoiceRecapRequest)
const mockEstimate = vi.mocked(invoiceEstimateRequest)

const estimate: InvoiceEstimate = {
  period: '2026-10',
  monthTotal: 2750,
  serviceTotal: 2500,
  reimburseTotal: 250,
  clients: [
    {
      clientId: 'a',
      clientName: 'Acme',
      basis: 'sent',
      detail: null,
      service: 1500,
      reimburse: 100,
      total: 1600,
      invoiceNumber: 'INV-2026-10-001',
    },
    {
      clientId: 'b',
      clientName: 'Bolt',
      basis: 'projected',
      detail: 'estimate',
      service: 1000,
      reimburse: 150,
      total: 1150,
    },
    {
      clientId: 'c',
      clientName: 'Cedar',
      basis: 'too_early',
      detail: 'no rates',
      service: null,
      reimburse: 0,
      total: null,
    },
  ],
}

beforeEach(() => {
  mockRecap.mockReset()
  mockRecap.mockResolvedValue({ period: '2026-10', rows: [] })
  mockEstimate.mockReset()
})

describe('the owner estimate ribbon', () => {
  it('shows the three totals with a sent / projected count, and the client rows on request', async () => {
    mockEstimate.mockResolvedValue(estimate)
    render(<InvoiceRecapPage ownerEstimate />)

    const stat = (label: string) =>
      screen.getByText(label, { selector: '.invoice-run-stat span' }).closest('.invoice-run-stat') as HTMLElement
    await waitFor(() => expect(within(stat('Month total')).getByText('$2,750.00')).toBeInTheDocument())
    expect(within(stat('Service total')).getByText('$2,500.00')).toBeInTheDocument()
    expect(within(stat('Reimburse total')).getByText('$250.00')).toBeInTheDocument()
    expect(screen.getByText('3 clients: 1 sent, 1 projected, 1 too early')).toBeInTheDocument()

    // The fold-out names each client's basis in a word.
    const rows = screen.getAllByRole('row')
    const rowFor = (name: string) => rows.find((row) => row.textContent?.startsWith(name)) as HTMLElement
    expect(rowFor('Acme')).toHaveTextContent('Sent · INV-2026-10-001')
    expect(rowFor('Bolt')).toHaveTextContent('Projected · estimate')
  })

  it('explains why the three totals can differ on sent rows', async () => {
    mockEstimate.mockResolvedValue(estimate)
    render(<InvoiceRecapPage ownerEstimate />)
    expect(await screen.findByText(/Service excludes prepayments and credits applied/)).toBeInTheDocument()
  })

  it('leaves the sent-rows caption out when nothing is sent', async () => {
    mockEstimate.mockResolvedValue({
      ...estimate,
      clients: estimate.clients.filter((entry) => entry.basis !== 'sent'),
    })
    render(<InvoiceRecapPage ownerEstimate />)
    await screen.findByText('Bolt')
    expect(screen.queryByText(/Service excludes prepayments/)).not.toBeInTheDocument()
  })

  it('never shows $0.00 for a client whose estimate is unusable: it says why', async () => {
    mockEstimate.mockResolvedValue(estimate)
    render(<InvoiceRecapPage ownerEstimate />)
    await screen.findByText('Cedar')
    const cedar = screen.getAllByRole('row').find((row) => row.textContent?.startsWith('Cedar')) as HTMLElement
    expect(cedar).toHaveTextContent('Too early')
    expect(cedar).toHaveTextContent('no rates')
    // Service reads "no rates"; reimburse and total are dashes. No $0.00 anywhere.
    expect(within(cedar).getAllByText('—')).toHaveLength(2)
    expect(cedar.textContent).not.toContain('$0.00')
  })

  it('asks for the estimate of the month the page is on', async () => {
    mockEstimate.mockResolvedValue(estimate)
    render(<InvoiceRecapPage ownerEstimate />)
    await waitFor(() => expect(mockEstimate).toHaveBeenCalled())
    expect(mockEstimate.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}$/)
  })

  it('shows dashes while loading and the error when it fails', async () => {
    mockEstimate.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(<InvoiceRecapPage ownerEstimate />)
    expect(
      within(
        screen.getByText('Month total', { selector: '.invoice-run-stat span' })
          .closest('.invoice-run-stat') as HTMLElement,
      ).getByText('—'),
    ).toBeInTheDocument()
    unmount()

    mockEstimate.mockRejectedValue(new Error('estimate boom'))
    render(<InvoiceRecapPage ownerEstimate />)
    expect(await screen.findByText('estimate boom')).toBeInTheDocument()
  })

  it('is not requested and not drawn for staff (or in preview): the default', async () => {
    render(<InvoiceRecapPage />)
    await waitFor(() => expect(mockRecap).toHaveBeenCalled())
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(screen.queryByText('Month total')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Estimated invoices')).not.toBeInTheDocument()
  })
})
