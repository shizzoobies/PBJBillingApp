import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * What a BILLING MASTER's printed invoice actually says.
 *
 * Brittany's answer to "does KLC see the other companies' names" was "2": the
 * document shows ONE combined line — "Bookkeeping services — {month}" carrying
 * the total — and the per-company split lives only inside the app. This is the
 * one decision in the feature that cannot be undone after a send, so the
 * absence of the company names is asserted directly against the rendered sheet,
 * not inferred from a flag.
 *
 * The sheet asks the SAME `clientFacingInvoiceLines` the emailed body and the
 * generated PDF ask (lib/invoice-lines.js), so what is pinned here is that the
 * print path goes through it — not a second copy of the rule that could drift.
 *
 * jsdom sees no print stylesheet; the page-level rendering is covered by
 * scripts/check-print-pdf.mjs and by invoice-print-document.test.tsx.
 */

const printInvoice = vi.hoisted(() => vi.fn())
const selectedClientId = vi.hoisted(() => ({ value: 'client-klc-master' }))

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

// Not what is under test, and it reaches for its own data.
vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

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

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients,
      contacts: [],
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: selectedClientId.value,
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-08',
    printInvoice,
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

/** The merged invoice: every line names the company it came from. */
const masterInvoice: PersistedInvoice = {
  id: 'inv-master',
  clientId: 'client-klc-master',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-MASTER-001',
  status: 'draft',
  lineItems: [
    {
      kind: 'plan',
      label: 'Monthly service — KLC Floors & More',
      detail: 'The Classic',
      amount: 500,
      sourceClientId: 'client-klc',
    },
    {
      kind: 'recurring',
      label: 'QuickBooks Online — Chemtrex',
      detail: 'covers Aug 1 – Aug 31, 2026',
      amount: 90,
      sourceClientId: 'client-chemtrex',
    },
    {
      kind: 'plan',
      label: 'Monthly service — Bright Tower',
      detail: 'The Classic',
      amount: 260,
      sourceClientId: 'client-bright-tower',
    },
  ],
  subtotal: 850,
  total: 850,
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

const plainInvoice: PersistedInvoice = {
  ...masterInvoice,
  id: 'inv-acme',
  clientId: 'client-acme',
  number: 'INV-ACME-001',
  lineItems: [
    { kind: 'hourly', label: 'Billable hours', detail: 'August', amount: 400 },
    { kind: 'reimbursement', label: 'State filing fee', detail: 'Aug 4', amount: 50 },
  ],
  subtotal: 450,
  total: 450,
}

function renderInShell() {
  return render(
    <div id="root">
      <div className="app-shell">
        <main className="workspace">
          <InvoicesPage />
        </main>
      </div>
    </div>,
  )
}

const printed = () => document.querySelector('.invoice-print')!.textContent ?? ''

/** Open the run's row for this invoice and print it through the page's sheet. */
async function printStored(invoice: PersistedInvoice) {
  mockList.mockImplementation(async (period?: string) => (period ? [invoice] : []))
  renderInShell()
  fireEvent.click(await screen.findByText(invoice.number as string))
  fireEvent.click(screen.getByRole('button', { name: 'Print' }))
  await waitFor(() => expect(printInvoice).toHaveBeenCalled())
}

beforeEach(() => {
  printInvoice.mockReset()
  mockList.mockReset()
  selectedClientId.value = 'client-klc-master'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("InvoicesPage — a billing master's printed document", () => {
  it('prints ONE combined line carrying the invoice total', async () => {
    await printStored(masterInvoice)

    expect(printed()).toContain('Bookkeeping services — August 2026')
    expect(printed()).toContain('$850.00')
  })

  // The whole of Brittany's "2", asserted against the rendered sheet.
  it('names no company anywhere in the printed output', async () => {
    await printStored(masterInvoice)

    for (const name of ['KLC Floors', 'Chemtrex', 'Bright Tower']) {
      expect(printed()).not.toContain(name)
    }
  })

  // Not only the labels: a recurring line's coverage window and an hours line's
  // detail describe ONE company's charge too, which is why the combined mode
  // replaces the lines outright rather than relabeling them.
  it('carries none of the per-company line detail either', async () => {
    await printStored(masterInvoice)

    expect(printed()).not.toContain('covers Aug 1')
    expect(printed()).not.toContain('The Classic')
    expect(printed()).not.toContain('$500.00')
    expect(printed()).not.toContain('$90.00')
  })

  // The sheet is still an invoice: the brand, the terms and the total block are
  // untouched by the rendering mode.
  it('keeps the firm branding and the total block', async () => {
    await printStored(masterInvoice)

    expect(printed()).toContain('PB&J Strategic Accounting')
    expect(printed()).toContain('Total due')
    expect(printed()).toContain('KLC Master')
  })
})

/*
 * Two kinds of line survive the merge, because they explain the CHARGE rather
 * than describe the work (`COMBINED_KEPT_KINDS`, lib/invoice-lines.js). Both
 * were being erased from this sheet — and ONLY this sheet — because the stored
 * lines were mapped down to label/detail/amount before the renderer saw them,
 * so it could no longer recognize them by kind. The PDF and the email kept
 * them. Three documents disagreeing about the amount due is the one failure
 * this whole feature cannot have.
 */
describe('InvoicesPage — the lines a combined document still prints', () => {
  const withCardFee: PersistedInvoice = {
    ...masterInvoice,
    lineItems: [
      ...masterInvoice.lineItems,
      { kind: 'card-fee', label: 'Card processing fee', detail: '', amount: 25.4 },
    ],
    total: 875.4,
  }

  it('keeps the card fee, and the lines still add to the amount due', async () => {
    await printStored(withCardFee)

    expect(printed()).toContain('Card processing fee')
    expect(printed()).toContain('$25.40')
    // The combined line carries the total LESS what is stated separately, so
    // the column adds up: 850.00 + 25.40 = 875.40.
    expect(printed()).toContain('$850.00')
    expect(printed()).toContain('$875.40')
  })

  it('keeps a retainer credit, which is the only negative line', async () => {
    await printStored({
      ...masterInvoice,
      lineItems: [
        ...masterInvoice.lineItems,
        { kind: 'retainer_credit', label: 'Retainer credit', detail: '', amount: -200 },
      ],
      total: 650,
    })

    expect(printed()).toContain('Retainer credit')
    expect(printed()).toContain('-$200.00')
  })

  // Neither kept line may name a company — that is the condition on keeping
  // them at all.
  it('still names no company', async () => {
    await printStored(withCardFee)

    for (const name of ['KLC Floors', 'Chemtrex', 'Bright Tower']) {
      expect(printed()).not.toContain(name)
    }
  })
})

/*
 * A retainer is an engagement-level document with one line reading "Retainer".
 * Rendered combined it would print "Bookkeeping services — {month}" over money
 * that is not a month's bookkeeping. The exemption is keyed off the invoice's
 * `kind`, which this page had been dropping on the way to the renderer.
 */
describe('InvoicesPage — a master’s retainer is never combined', () => {
  it('prints its own line, not the combined one', async () => {
    await printStored({
      ...masterInvoice,
      id: 'inv-retainer',
      kind: 'retainer',
      number: 'INV-RET-001',
      lineItems: [
        { kind: 'retainer', label: 'Retainer', detail: 'Engagement retainer', amount: 2000 },
      ],
      subtotal: 2000,
      total: 2000,
    })

    expect(printed()).toContain('Retainer')
    expect(printed()).toContain('$2,000.00')
    expect(printed()).not.toContain('Bookkeeping services — August 2026')
  })
})

describe('InvoicesPage — an ordinary client prints exactly as before', () => {
  it('prints every stored line, unchanged', async () => {
    selectedClientId.value = 'client-acme'
    await printStored(plainInvoice)

    expect(printed()).toContain('Billable hours')
    expect(printed()).toContain('State filing fee')
    expect(printed()).toContain('$400.00')
    expect(printed()).toContain('$50.00')
    expect(printed()).not.toContain('Bookkeeping services — August 2026')
  })
})
