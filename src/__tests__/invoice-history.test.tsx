import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { InvoiceHistory } from '../components/InvoiceHistory'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The History view (I5). What is worth pinning here is not the markup but the
 * promises the view makes: months collapsed until asked, a header line that
 * describes exactly the rows underneath it (so filtering has to move it), and
 * a way back into the month run.
 */

vi.mock('../lib/api', () => ({
  listInvoicesRequest: vi.fn(),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

function makeInvoice(overrides: Partial<PersistedInvoice>): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'sent',
    lineItems: [],
    subtotal: 0,
    total: 0,
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

const clients = [
  { id: 'client-acme', name: 'Acme', contact: '', billingMode: 'hourly', hourlyRate: 0, planIds: [], contactIds: [] },
  { id: 'client-borden', name: 'Borden', contact: '', billingMode: 'hourly', hourlyRate: 0, planIds: [], contactIds: [] },
] as unknown as Client[]

const invoices = [
  makeInvoice({ id: 'a', number: 'INV-2026-08-001', total: 400, status: 'paid' }),
  makeInvoice({ id: 'b', number: 'INV-2026-08-002', total: 250, clientId: 'client-borden' }),
  makeInvoice({ id: 'c', number: 'INV-2026-08-003', total: 9000, status: 'void' }),
  makeInvoice({ id: 'd', number: 'INV-2026-07-001', period: '2026-07', total: 100 }),
]

function renderHistory(overrides: Partial<Parameters<typeof InvoiceHistory>[0]> = {}) {
  return render(
    <InvoiceHistory
      clients={clients}
      onOpenMonth={vi.fn()}
      onPrint={vi.fn()}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue(invoices)
})

describe('InvoiceHistory', () => {
  it('asks for the WHOLE archive, not one month', async () => {
    renderHistory()
    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(mockList).toHaveBeenCalledWith()
  })

  it('groups by month newest first, with totals that exclude the void', async () => {
    renderHistory()
    const august = await screen.findByRole('button', { name: /August 2026/ })

    // $400 paid + $250 sent = $650 billed; the $9,000 void is not revenue.
    expect(august).toHaveTextContent('2 invoices')
    expect(august).toHaveTextContent('$650.00 billed')
    expect(august).toHaveTextContent('$400.00 paid')
    expect(august).toHaveTextContent('$250.00 outstanding')
    expect(august).toHaveTextContent('1 voided')

    const months = screen
      .getAllByRole('button', { expanded: false })
      .map((node) => node.textContent ?? '')
    expect(months[0]).toContain('August 2026')
    expect(months[1]).toContain('July 2026')
  })

  it('starts collapsed and opens on click', async () => {
    renderHistory()
    const august = await screen.findByRole('button', { name: /August 2026/ })
    expect(august).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('INV-2026-08-001')).toBeNull()

    fireEvent.click(august)
    expect(august).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('INV-2026-08-001')).toBeTruthy()
    // The July rows stay shut — one month at a time is the point.
    expect(screen.queryByText('INV-2026-07-001')).toBeNull()
  })

  it('recomputes the header from the filtered rows, and drops empty months', async () => {
    renderHistory()
    await screen.findByRole('button', { name: /August 2026/ })

    fireEvent.change(screen.getByRole('combobox', { name: /Client/ }), {
      target: { value: 'client-borden' },
    })

    const august = await screen.findByRole('button', { name: /August 2026/ })
    expect(august).toHaveTextContent('1 invoice ·')
    expect(august).toHaveTextContent('$250.00 billed')
    expect(august).toHaveTextContent('$0.00 paid')
    // Borden has nothing in July, so July is gone rather than shown empty.
    expect(screen.queryByRole('button', { name: /July 2026/ })).toBeNull()
  })

  it('hands the row’s month back to the run', async () => {
    const onOpenMonth = vi.fn()
    renderHistory({ onOpenMonth })
    fireEvent.click(await screen.findByRole('button', { name: /August 2026/ }))

    fireEvent.click(screen.getByText('INV-2026-08-001'))
    expect(onOpenMonth).toHaveBeenCalledWith('2026-08')
  })

  it('says so quietly when there is no archive yet', async () => {
    mockList.mockResolvedValue([])
    renderHistory()
    expect(
      await screen.findByText(/Invoices appear here once months have been generated/),
    ).toBeTruthy()
  })
})
