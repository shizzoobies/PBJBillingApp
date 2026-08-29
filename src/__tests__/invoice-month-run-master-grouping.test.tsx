import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The month-run editor for a BILLING MASTER's invoice.
 *
 * KLC's invoice is the merged lines of four companies. Inside the app that
 * split has to be legible — the firm has to see who is being billed for what —
 * so the editor groups by `sourceClientId` with a subtotal per company.
 *
 * The banner is the load-bearing part. Brittany answered "2": the document KLC
 * receives is ONE combined line with no company names. Without a sentence
 * saying so on the screen where the breakdown IS shown, "the invoice shows too
 * much detail" is the send-back that follows.
 *
 * Everything about EDITING is unchanged, and that is asserted rather than
 * assumed: an ad hoc line keeps its billed/courtesy/omitted decision inside its
 * company's block, and an ordinary client's editor still splits scoped from ad
 * hoc exactly as before.
 */

vi.mock('../lib/api', () => ({
  answerInvoiceAiReviewQuestionRequest: vi.fn(),
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoiceAiReviewsRequest: vi.fn(async () => []),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  rateInvoiceRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, sendInvoiceRequest } from '../lib/api'
import { ApiError } from '../lib/types'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)

const clients = [
  {
    id: 'client-klc-master',
    name: 'KLC Master',
    contact: '',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
    isBillingMaster: true,
    // One address on file, so Send goes straight out rather than opening the
    // recipient picker — the send-refusal test below needs the round trip.
    email: 'billing@klc.example',
  },
  {
    id: 'client-klc',
    name: 'KLC Floors & More',
    contact: '',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
    billToClientId: 'client-klc-master',
  },
  {
    id: 'client-chemtrex',
    name: 'Chemtrex',
    contact: '',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
    billToClientId: 'client-klc-master',
  },
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 100,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const BANNER = 'KLC sees ONE combined line — this breakdown is only visible here.'

/** The master's merged invoice: two companies, one of them with ad hoc work. */
const masterInvoice: PersistedInvoice = {
  id: 'inv-master',
  clientId: 'client-klc-master',
  period: '2026-09',
  kind: 'monthly',
  number: 'INV-2026-09-004',
  status: 'draft',
  lineItems: [
    {
      kind: 'plan',
      label: 'Monthly service',
      detail: 'The Classic',
      amount: 500,
      sourceClientId: 'client-klc',
    },
    {
      kind: 'reimbursement',
      label: 'State filing fee',
      detail: 'Sep 2',
      amount: 50,
      sourceClientId: 'client-klc',
    },
    {
      kind: 'plan',
      label: 'Monthly service',
      detail: 'The Classic',
      amount: 300,
      sourceClientId: 'client-chemtrex',
    },
    {
      kind: 'adhoc',
      label: 'Prior-year cleanup',
      detail: '2.5 hrs',
      amount: 125,
      adhocMode: 'billed',
      adhocAmount: 125,
      sourceClientId: 'client-chemtrex',
    },
  ],
  subtotal: 975,
  total: 975,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: null,
}

/** An ordinary client's invoice, with ad hoc work of its own. */
const plainInvoice: PersistedInvoice = {
  ...masterInvoice,
  id: 'inv-acme',
  clientId: 'client-acme',
  number: 'INV-2026-09-009',
  lineItems: [
    { kind: 'hourly', label: 'Billable hours', detail: 'September', amount: 400 },
    {
      kind: 'adhoc',
      label: 'One-off cleanup',
      detail: '1 hr',
      amount: 100,
      adhocMode: 'billed',
      adhocAmount: 100,
    },
  ],
  subtotal: 500,
  total: 500,
}

async function openEditor(invoice: PersistedInvoice) {
  mockList.mockResolvedValue([invoice])
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByText(invoice.number as string))
}

/** The company heading rows, in the order they render. */
const groupHeadings = () =>
  [...document.querySelectorAll('.invoice-run-source-heading')].map((row) => ({
    name: row.querySelector('th')?.textContent ?? '',
    subtotal: row.querySelector('.invoice-run-source-subtotal')?.textContent ?? '',
  }))

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("InvoiceMonthRun — a billing master's editor", () => {
  it('says the client only ever sees one combined line', async () => {
    await openEditor(masterInvoice)

    expect(screen.getByText(BANNER)).toBeInTheDocument()
  })

  it('groups the lines by company, in the order they were merged', async () => {
    await openEditor(masterInvoice)

    expect(groupHeadings().map((group) => group.name)).toEqual([
      'KLC Floors & More',
      'Chemtrex',
    ])
  })

  // Each company's share of the one document. Chemtrex's includes its ad hoc
  // line: a subtotal that left out out-of-scope work would not be what that
  // company is being billed.
  it('subtotals each company, ad hoc work included', async () => {
    await openEditor(masterInvoice)

    expect(groupHeadings()).toEqual([
      { name: 'KLC Floors & More', subtotal: '$550.00' },
      { name: 'Chemtrex', subtotal: '$425.00' },
    ])
  })

  it('keeps every line, in its existing order within its company', async () => {
    await openEditor(masterInvoice)

    const labels = [...document.querySelectorAll('input[aria-label="Line description"]')].map(
      (input) => (input as HTMLInputElement).value,
    )
    expect(labels).toEqual([
      'Monthly service',
      'State filing fee',
      'Monthly service',
      'Prior-year cleanup',
    ])
  })

  // Grouping changes WHERE a row sits, never what it can do. The ad hoc line's
  // three-way decision travels into its company's block with it.
  it('leaves ad hoc dispositions editable inside their company block', async () => {
    await openEditor(masterInvoice)

    const choice = screen.getByLabelText('What to do with this ad hoc work') as HTMLSelectElement
    expect(choice.value).toBe('billed')

    fireEvent.change(choice, { target: { value: 'courtesy' } })

    expect(choice.value).toBe('courtesy')
    // The shared rule moved the money, so the group heading follows: $425 − $125.
    expect(groupHeadings()[1]).toEqual({ name: 'Chemtrex', subtotal: '$300.00' })
    expect(screen.getByText('would be $125.00')).toBeInTheDocument()
  })

  it('still edits labels and amounts by their position in the saved array', async () => {
    await openEditor(masterInvoice)

    const amounts = document.querySelectorAll('input[aria-label="Amount"]')
    fireEvent.change(amounts[1], { target: { value: '75' } })

    // The second line belongs to KLC: $500 + $75.
    expect(groupHeadings()[0]).toEqual({ name: 'KLC Floors & More', subtotal: '$575.00' })
  })
})

describe('InvoiceMonthRun — sending a master invoice with no recipient chosen', () => {
  // A master has no contacts of its own — "sends invoice to sub client you
  // choose" — so the server refuses the send with 409 `master_recipient_unset`
  // and a sentence naming the fix. It has to land where she clicked, not in a
  // console: the send is the one action with no undo.
  it('shows the server’s sentence beside the invoice', async () => {
    mockSend.mockRejectedValue(
      new ApiError(
        409,
        'Pick which company receives this invoice first — Settings on the master client.',
        'master_recipient_unset',
      ),
    )
    mockList.mockResolvedValue([{ ...masterInvoice, status: 'reviewed' }])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    // A reviewed invoice waits on its own tab, not the one the run opens on.
    fireEvent.click(await screen.findByRole('tab', { name: /Reviewed/ }))
    fireEvent.click(screen.getByText('INV-2026-09-004'))

    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).not.toBeDisabled()
    fireEvent.click(send)

    expect(
      await screen.findByText(
        'Pick which company receives this invoice first — Settings on the master client.',
      ),
    ).toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — an ordinary client is untouched', () => {
  it('keeps the scoped / ad hoc split and shows no company headings', async () => {
    await openEditor(plainInvoice)

    expect(screen.getByText('Ad hoc — outside scope')).toBeInTheDocument()
    expect(groupHeadings()).toEqual([])
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument()
  })
})
