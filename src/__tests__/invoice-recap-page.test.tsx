import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceRecapPage } from '../pages/InvoiceRecapPage'

/**
 * The staff invoice recap page (featreq-0c2d4ce5). Scoping and shaping are the
 * server's (lib/invoice-recap.test.mjs + the route glue); what the page owes
 * is rendering what it is handed the way Brittany described it — the total for
 * the company, then each reimbursed expense separate with its description —
 * and honest empty/error states.
 */

vi.mock('../lib/api', () => ({
  invoiceRecapRequest: vi.fn(),
}))

import { invoiceRecapRequest } from '../lib/api'

const mockRecap = vi.mocked(invoiceRecapRequest)

function row(over: Record<string, unknown> = {}) {
  return {
    invoiceId: 'inv-1',
    clientId: 'client-a',
    clientName: 'Acme',
    number: 'INV-2026-08-001',
    status: 'paid' as const,
    total: 500,
    sentAt: '2026-08-05T00:00:00.000Z',
    paidAt: '2026-08-20T00:00:00.000Z',
    reimbursedTotal: 100,
    accountingTotal: 400,
    reimbursedLines: [
      {
        label: 'Reimbursement: QBO subscription',
        detail: 'Aug 2, 2026',
        amount: 60,
        company: null,
      },
      { label: 'Software pass-through', detail: '', amount: 40, company: 'Bright Tower' },
    ],
    ...over,
  }
}

beforeEach(() => {
  mockRecap.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceRecapPage', () => {
  it('shows the total, the accounting remainder, and every reimbursed line separately', async () => {
    mockRecap.mockResolvedValue({ period: '2026-08', rows: [row()] })
    render(<InvoiceRecapPage />)

    await screen.findByText('Acme')
    expect(screen.getByText('$500.00')).toBeInTheDocument()
    expect(screen.getByText('$400.00')).toBeInTheDocument()
    expect(screen.getByText('$100.00')).toBeInTheDocument()
    // Each expense stays its own labeled entry with its description.
    expect(screen.getByText('Reimbursement: QBO subscription')).toBeInTheDocument()
    expect(screen.getByText('Aug 2, 2026')).toBeInTheDocument()
    expect(screen.getByText('$60.00')).toBeInTheDocument()
    // A billing master's merged line names WHICH company it belongs to.
    expect(screen.getByText(/— Bright Tower/)).toBeInTheDocument()
  })

  it('says so when a sent invoice carries no reimbursed expenses', async () => {
    mockRecap.mockResolvedValue({
      period: '2026-08',
      rows: [row({ reimbursedLines: [], reimbursedTotal: 0, accountingTotal: 500 })],
    })
    render(<InvoiceRecapPage />)
    await screen.findByText('No reimbursed expenses on this invoice.')
  })

  it('shows an honest empty state for a month with nothing sent', async () => {
    mockRecap.mockResolvedValue({ period: '2026-08', rows: [] })
    render(<InvoiceRecapPage />)
    await screen.findByText(/No sent invoices for .* among your clients\./)
  })

  it('surfaces a load failure instead of an empty page', async () => {
    mockRecap.mockRejectedValue(new Error('No access'))
    render(<InvoiceRecapPage />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('No access')
  })

  it('asks the server for the month the arrows land on', async () => {
    mockRecap.mockResolvedValue({ period: '2026-08', rows: [] })
    render(<InvoiceRecapPage />)
    await waitFor(() => expect(mockRecap).toHaveBeenCalledTimes(1))
    const first = mockRecap.mock.calls[0][0]
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(mockRecap).toHaveBeenCalledTimes(2))
    // One month earlier than whatever "now" was — computed, not hard-coded,
    // per the turn-of-month trap.
    const [year, month] = first.split('-').map(Number)
    const index = year * 12 + (month - 1) - 1
    const previous = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
    expect(mockRecap).toHaveBeenLastCalledWith(previous)
  })
})
