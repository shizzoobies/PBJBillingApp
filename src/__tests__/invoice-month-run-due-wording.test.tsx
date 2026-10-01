import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * What the month-run row says about the stored due date.
 *
 * That date is the firm's own follow-up line, thirty days after the send. A
 * client who is asked to pay on receipt has never been shown it, so the row
 * names it for what it is; a client whose own terms name a longer window keeps
 * the plain "due <date>".
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const clients = [
  { id: 'client-receipt', name: 'Receipt Co', contactIds: [], planIds: [] },
  {
    id: 'client-net45',
    name: 'Net Forty Five LLC',
    contactIds: [],
    planIds: [],
    paymentTerms: 'Net 45',
  },
] as unknown as Client[]

const invoice = (over: Partial<PersistedInvoice> = {}): PersistedInvoice =>
  ({
    id: 'inv-1',
    clientId: 'client-receipt',
    period: '2026-09',
    kind: 'monthly',
    number: 'INV-2026-09-001',
    status: 'draft',
    lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
    subtotal: 400,
    total: 400,
    dueDate: '2026-10-31',
    blurb: '',
    scopeFlags: [],
    sentAt: null,
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: '2026-10-01T14:00:00.000Z',
    updatedAt: null,
    ...over,
  }) as PersistedInvoice

const rowMeta = async () =>
  (await screen.findByText(/lines? ·/, { selector: '.invoice-run-meta' })).textContent ?? ''

async function renderRow(row: PersistedInvoice) {
  mockList.mockResolvedValue([row])
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
}

beforeEach(() => {
  mockList.mockReset()
})

describe('the month-run row’s due wording', () => {
  it('reads "Due on receipt · follow up Oct 31" for a client asked to pay on receipt', async () => {
    await renderRow(invoice())
    expect(await rowMeta()).toContain('Due on receipt · follow up Oct 31')
    // The tooltip that explains the date stays on it.
    expect(
      screen.getByTitle('Internal follow-up date; the client’s invoice says due on receipt'),
    ).toHaveTextContent('Due on receipt · follow up Oct 31')
  })

  it('reads just "Due on receipt" when no date is stored', async () => {
    await renderRow(invoice({ dueDate: null }))
    const meta = await rowMeta()
    expect(meta).toContain('Due on receipt')
    expect(meta).not.toContain('follow up')
    expect(meta).not.toContain('no due date')
  })

  it('keeps "due <date>" for a client whose own terms name a longer window', async () => {
    await renderRow(invoice({ clientId: 'client-net45', dueDate: '2026-11-15' }))
    const meta = await rowMeta()
    expect(meta).toContain('due Nov 15')
    expect(meta).not.toContain('Due on receipt')
  })

  it('keeps "no due date" for that client when none is stored', async () => {
    await renderRow(invoice({ clientId: 'client-net45', dueDate: null }))
    expect(await rowMeta()).toContain('no due date')
  })
})
