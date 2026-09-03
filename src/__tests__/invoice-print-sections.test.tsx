import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import { DETAIL_SECTION_TITLE } from '../../lib/invoice-lines.js'
import type { Client, PersistedInvoice, PersistedInvoiceLine } from '../lib/types'

/**
 * The redesigned print sheet (featreq-97ae3214): three named sections, role
 * sub-headings inside the hours section, a detailed-hours appendix as page 2,
 * and a header that names the invoice rather than the day it was printed.
 *
 * Every heading and every total label asserted here is read OFF the objects
 * `invoiceSections` returns — the test pins that the sheet prints what the
 * shared layer says, which is the only reason the sheet, the emailed body and
 * the generated PDF can be expected to word the document the same way.
 *
 * The combined-mode cases are the mirror image and matter more: a billing
 * master's document must show NO heading and NO section total, because a
 * per-section total would state the very split the client chose to hide.
 * `invoice-print-master-combined.test.tsx` guards the names and the amounts;
 * this file guards the structure that could reintroduce them.
 *
 * jsdom applies no print stylesheet and cannot paginate, so the page break
 * itself is measured by scripts/check-print-pdf.mjs. What is checkable here is
 * that the appendix is a separate section, and when it exists at all.
 */

const printInvoice = vi.hoisted(() => vi.fn())
const selectedClientId = vi.hoisted(() => ({ value: 'client-acme' }))

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
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'subscription',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
    paymentTerms: 'Due on receipt',
  },
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
  // S9: an hourly client with the time breakdown ON, exercising the live
  // per-client preview's `buildDisplayInvoice` — the one place hourly work
  // used to get listed twice once labels went per-person in June 2026.
  {
    id: 'client-hourly',
    name: 'Hourly Co',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 100,
    planIds: [],
    contactIds: [],
    invoiceTimeBreakdownMode: 'day',
    invoiceHideInternalHours: true,
    invoiceGroupByCategory: false,
  },
] as unknown as Client[]

const hourlyEmployees = [{ id: 'emp-1', name: 'Test Employee', role: 'Bookkeeper', billRate: 100 }]

const hourlyTimeEntries = [
  {
    id: 'entry-1',
    employeeId: 'emp-1',
    clientId: 'client-hourly',
    date: '2026-08-04',
    minutes: 120,
    billable: true,
  },
  {
    id: 'entry-2',
    employeeId: 'emp-1',
    clientId: 'client-hourly',
    date: '2026-08-11',
    minutes: 180,
    billable: true,
  },
]

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients,
      contacts: [],
      timeEntries: hourlyTimeEntries,
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: hourlyEmployees,
    },
    selectedClientId: selectedClientId.value,
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-08',
    printInvoice,
    ownerMode: true,
    firmSettings: {
      name: 'PB&J Strategic Accounting',
      tagline: 'Strategic bookkeeping, payroll, and advisory support',
      clientDefaults: { hourlyRate: 0 },
    },
  }),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

/** `time_detail` is a real stored kind (db/store.js) that the TS union has yet
 *  to name, so the appendix rows come in through one cast rather than ten. */
const lines = (rows: unknown[]) => rows as PersistedInvoiceLine[]

/**
 * One invoice with all three sections, two role tiers, an ungrouped work row,
 * and a detailed-hours appendix. `sentAt` is deliberately a date that is not
 * today: that is what tells the invoice's own date apart from the printing.
 */
const fullInvoice: PersistedInvoice = {
  id: 'inv-acme',
  clientId: 'client-acme',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-2026-08-004',
  status: 'draft',
  lineItems: lines([
    { kind: 'plan', label: 'The Classic', detail: 'Monthly service', amount: 400 },
    {
      kind: 'hourly',
      label: 'Billable hours — Lisa Mockabee',
      detail: '2.00 at $125.00/hr',
      amount: 250,
      roleTier: 'Bookkeeper',
    },
    {
      kind: 'adhoc',
      label: 'Billable hours — Brittany Ferguson',
      detail: '1.00 at $150.00/hr',
      amount: 150,
      roleTier: 'CFO',
    },
    // No `roleTier` — a legacy or hand-added row. It still has money on it, so
    // it must print, and it prints FIRST and untitled rather than under a
    // guessed heading.
    { kind: 'hourly', label: 'Billable hours', detail: 'Legacy row', amount: 100 },
    {
      kind: 'recurring',
      label: 'QuickBooks Online',
      detail: 'covers Aug 1 – Aug 31, 2026',
      amount: 90,
    },
    { kind: 'time_detail', label: 'Lisa Mockabee', detail: 'Aug 4 · 2.00 hrs', amount: 0 },
    { kind: 'time_detail', label: 'Brittany Ferguson', detail: 'Aug 11 · 1.00 hrs', amount: 0 },
  ]),
  subtotal: 990,
  total: 990,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: null,
}

/** The same shape on a billing master, where none of it may show. */
const masterInvoice: PersistedInvoice = {
  ...fullInvoice,
  id: 'inv-master',
  clientId: 'client-klc-master',
  number: 'INV-MASTER-002',
}

/** The same long-date shape the sheet prints, computed rather than typed so the
 *  assertions hold in any timezone the suite runs in. */
const longDate = (value: string | Date) =>
  new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(
    typeof value === 'string' ? new Date(value) : value,
  )

const printed = () => document.querySelector('.invoice-print')!.textContent ?? ''
const detailSheet = () => document.querySelector('.invoice-print .print-detail-sheet')

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

/**
 * Open the run's row for this invoice and print it through the page's sheet.
 * The run splits by status into tabs, so a sent invoice needs its tab opened
 * first — its row is not rendered under "To review".
 */
async function printStored(invoice: PersistedInvoice, tab?: string) {
  mockList.mockImplementation(async (period?: string) => (period ? [invoice] : []))
  renderInShell()
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${tab}`) }))
  fireEvent.click(await screen.findByText(invoice.number as string))
  fireEvent.click(screen.getByRole('button', { name: 'Print' }))
  await waitFor(() => expect(printInvoice).toHaveBeenCalled())
}

beforeEach(() => {
  printInvoice.mockReset()
  mockList.mockReset()
  selectedClientId.value = 'client-acme'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoicesPage — the printed sheet’s sections', () => {
  it('prints her three section headings', async () => {
    await printStored(fullInvoice)

    expect(printed()).toContain('Subscription Plan')
    expect(printed()).toContain('Ad-Hoc / Billable Hours')
    expect(printed()).toContain('Client Reimbursed Expenses')
  })

  // The constraint Alex attached to the whole feature: the section totals are
  // the sum of the rows that print under them, so they still add to what the
  // per-person lines have always billed. 400 + (250 + 150 + 100) + 90 = 990.
  it('prints a total for each section, and they sum to the invoice total', async () => {
    await printStored(fullInvoice)

    expect(printed()).toContain('Total Subscription Plan')
    expect(printed()).toContain('Total Ad-Hoc/Billable Hours')
    expect(printed()).toContain('Total Client Reimbursed Expenses')
    expect(printed()).toContain('$400.00')
    expect(printed()).toContain('$500.00')
    expect(printed()).toContain('$90.00')
    expect(printed()).toContain('$990.00')
  })

  // "Subtotal" is the one word these labels may not use: a combined-mode PDF
  // test asserts it never appears on a client-facing document.
  it('never labels a section total "Subtotal"', async () => {
    await printStored(fullInvoice)

    expect(printed()).not.toContain('Subtotal')
  })

  it('sub-heads the hours section by role, in her fixed order', async () => {
    await printStored(fullInvoice)

    const text = printed()
    expect(text).toContain('CFO / Advisory Services')
    expect(text).toContain('Bookkeeping Services')
    expect(text.indexOf('CFO / Advisory Services')).toBeLessThan(
      text.indexOf('Bookkeeping Services'),
    )
    // The tier headings live INSIDE the hours section, under its heading and
    // above its total.
    expect(text.indexOf('Ad-Hoc / Billable Hours')).toBeLessThan(
      text.indexOf('CFO / Advisory Services'),
    )
    expect(text.indexOf('Bookkeeping Services')).toBeLessThan(
      text.indexOf('Total Ad-Hoc/Billable Hours'),
    )
  })

  it('prints a row that carries no role tier, ungrouped and ahead of the tiers', async () => {
    await printStored(fullInvoice)

    const text = printed()
    expect(text).toContain('Legacy row')
    expect(text).toContain('$100.00')
    expect(text.indexOf('Legacy row')).toBeLessThan(text.indexOf('CFO / Advisory Services'))
  })
})

describe('InvoicesPage — a billing master’s sheet shows no section structure', () => {
  beforeEach(() => {
    selectedClientId.value = 'client-klc-master'
  })

  it('prints no section heading and no section total', async () => {
    await printStored(masterInvoice)

    // Positive anchor first: an empty render (or one that silently dropped
    // every line) would pass every `not.toContain` below for free. Pinning
    // the one line a master's document DOES show is what makes the negatives
    // that follow mean anything.
    expect(printed()).toContain('Bookkeeping services — August 2026')
    expect(printed()).toContain('$990.00')

    for (const heading of [
      'Subscription Plan',
      'Ad-Hoc / Billable Hours',
      'Client Reimbursed Expenses',
      'Total Subscription Plan',
      'Total Ad-Hoc/Billable Hours',
      'Total Client Reimbursed Expenses',
    ]) {
      expect(printed()).not.toContain(heading)
    }
  })

  it('prints no role sub-heading either', async () => {
    await printStored(masterInvoice)

    expect(printed()).toContain('Bookkeeping services — August 2026')

    for (const heading of [
      'CFO / Advisory Services',
      'Accounting Services',
      'Bookkeeping Services',
      'Other Services',
    ]) {
      expect(printed()).not.toContain(heading)
    }
  })
})

describe('InvoicesPage — the detailed-hours page', () => {
  it('renders as its own section, after the sheet, when there are detail rows', async () => {
    await printStored(fullInvoice)

    const appendix = detailSheet()
    expect(appendix).not.toBeNull()
    // The SHARED heading, so the sheet cannot word page 2 differently from the
    // PDF and the email.
    expect(appendix?.querySelector('h2')?.textContent).toBe(DETAIL_SECTION_TITLE)
    expect(appendix?.textContent).toContain('Aug 4 · 2.00 hrs')
    // No amount column: every appendix row is $0.00, and a column of zeroes
    // under this heading reads as a bug. Two columns, as in the PDF.
    expect(appendix?.querySelectorAll('thead th')).toHaveLength(2)
    expect(appendix?.textContent).not.toContain('$0.00')
    // A sibling of the invoice sheet, not a child of it: a nested block cannot
    // carry a page break of its own.
    expect(appendix?.parentElement).toBe(document.querySelector('.invoice-print'))
    expect(document.querySelector('.invoice-print .print-sheet .print-detail-sheet')).toBeNull()
  })

  it('is suppressed when the invoice carries no detail rows', async () => {
    await printStored({
      ...fullInvoice,
      lineItems: lines([
        { kind: 'plan', label: 'The Classic', detail: 'Monthly service', amount: 400 },
      ]),
      subtotal: 400,
      total: 400,
    })

    expect(detailSheet()).toBeNull()
    expect(printed()).not.toContain(DETAIL_SECTION_TITLE)
  })

  /*
   * A `time_detail` row is an appendix row ONLY when it carries no money. The
   * $0.00 invariant is enforced by the generator, not the store, and production
   * holds a sent invoice (INV-2026-08-044) whose entire total sits on hand-built
   * `time_detail` lines. Moving those to page 2 would print an empty body over a
   * live total — which is why this sheet asks `invoiceDetailRows` rather than
   * filtering on the kind itself.
   */
  it('keeps a money-carrying time_detail row in the body, off page 2', async () => {
    await printStored({
      ...fullInvoice,
      lineItems: lines([
        { kind: 'time_detail', label: 'Bookkeeping', detail: 'August', amount: 256.25 },
      ]),
      subtotal: 256.25,
      total: 256.25,
    })

    expect(detailSheet()).toBeNull()
    expect(printed()).toContain('$256.25')
  })

  // `time_detail` is not among the kinds a combined document keeps, so a
  // master's page 2 would otherwise print blank.
  it('is suppressed on a billing master, whose detail rows are dropped', async () => {
    selectedClientId.value = 'client-klc-master'
    await printStored(masterInvoice)

    expect(detailSheet()).toBeNull()
    expect(printed()).not.toContain(DETAIL_SECTION_TITLE)
  })
})

describe('InvoicesPage — the sheet’s header', () => {
  it('names the invoice and its billing period, and no longer says "Issued"', async () => {
    await printStored(fullInvoice)

    expect(printed()).toContain('Invoice no.')
    expect(printed()).toContain('INV-2026-08-004')
    expect(printed()).toContain('Invoice Date')
    expect(printed()).toContain('Billing Period: August 2026')
    expect(printed()).not.toContain('Issued')
  })

  it('drops the firm tagline from the letterhead', async () => {
    await printStored(fullInvoice)

    expect(printed()).toContain('PB&J Strategic Accounting')
    expect(printed()).not.toContain('Strategic bookkeeping, payroll, and advisory support')
  })

  /*
   * THE BUG THE RENAME EXPOSED. The sheet formatted `new Date()`, so an August
   * invoice reprinted in October was stamped October — the printed copy
   * contradicted the PDF the client was already holding.
   */
  it('prints the invoice’s own date, not the day it is being printed', async () => {
    await printStored({ ...fullInvoice, status: 'sent', sentAt: '2026-07-15T12:00:00.000Z' }, 'Sent')

    const sentOn = longDate('2026-07-15T12:00:00.000Z')
    expect(printed()).toContain(sentOn)
    // Guard against the assertion above passing by coincidence on the one day
    // of the year the two agree.
    const today = longDate(new Date())
    if (today !== sentOn) expect(printed()).not.toContain(today)
  })

  it('falls back to the created date on an invoice that was never sent', async () => {
    await printStored(fullInvoice)

    expect(printed()).toContain(longDate('2026-07-01T12:00:00.000Z'))
    expect(printed()).not.toContain(longDate(new Date()))
  })

  /*
   * S3: the sheet's Invoice Date must read the same UTC calendar day the
   * generated PDF's `stampDate` reads, not whatever day the FULL timestamp
   * falls on in the local timezone. `2026-09-02T01:00:00Z` is 1am UTC — a 9pm
   * ET generate on Sep 1 — which used to `new Date(...)` to the LOCAL day
   * (Sep 1 in US timezones) while the PDF, reading only `slice(0, 10)`,
   * stamped Sep 2: the same invoice's two client-facing copies disagreeing on
   * their own date. Asserted against the fixed calendar day rather than
   * `new Date()` so it holds regardless of the timezone the suite runs in.
   */
  it("prints the UTC calendar day, matching the PDF, even when the local day would differ", async () => {
    await printStored(
      { ...fullInvoice, status: 'sent', sentAt: '2026-09-02T01:00:00Z' },
      'Sent',
    )

    expect(printed()).toContain('September 2, 2026')
  })
})

describe('InvoicesPage — the sheet’s footer', () => {
  it('prints the firm’s line when the client has no footer note of their own', async () => {
    await printStored(fullInvoice)

    expect(printed()).toContain(
      'Spread success, not stress, thanks for choosing PB&J Strategic Accounting.',
    )
  })

  // Payment terms stay whatever the client record says — that is data, and
  // changing the words is a record edit rather than a code change (plan §1d).
  it('still prints the client’s stored payment terms', async () => {
    await printStored(fullInvoice)

    expect(printed()).toContain('Due on receipt')
  })
})

describe('InvoicesPage — Customize’s "Add line" (B1)', () => {
  /*
   * BLOCKER: a line added through Customize used to be minted with no `kind`
   * at all (`{ id, label: '', detail: '', amount: 0 }`). `invoiceSections`
   * buckets every row by `kind`, so a kind-less row vanished from the printed
   * sheet entirely — while `draftToDisplay` still summed its amount into
   * Total due, because that sum does not look at `kind`. The result was a
   * printed document whose own rows did not add up to its own total.
   *
   * `kind: 'custom'` is what `sanitizeInvoiceLines` would coerce the line to
   * on save anyway (`db/store.js`), and `invoiceSections` puts `custom` rows
   * in the untitled charges block, where they print plainly with no section
   * total of their own.
   */
  it('a line added via Customize prints its label and amount, and folds into Total due', async () => {
    mockList.mockImplementation(async () => [])
    renderInShell()

    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add line' }))

    const descriptionInputs = screen.getAllByPlaceholderText('Description')
    const amountInputs = screen.getAllByPlaceholderText('0.00')
    fireEvent.change(descriptionInputs[descriptionInputs.length - 1], {
      target: { value: 'Custom review fee' },
    })
    fireEvent.change(amountInputs[amountInputs.length - 1], { target: { value: '75' } })

    fireEvent.click(screen.getByRole('button', { name: 'Print invoice' }))
    await waitFor(() => expect(printInvoice).toHaveBeenCalled())

    const text = printed()
    const occurrences = (needle: string) => text.split(needle).length - 1

    // The row itself must be ON the printed sheet — not dropped by the
    // section layer for lacking a `kind`.
    expect(text).toContain('Custom review fee')
    // Acme (client-acme) has no plan rate on file, so the seeded collapsed
    // line is $0.00 and the client's only real charge is the $75 line just
    // added. It should appear exactly twice: once as the row, once as Total
    // due — proving the printed rows and the printed total agree, which is
    // exactly what did NOT hold before this fix (the row was invisible while
    // the $75 still landed in Total due).
    expect(occurrences('$75.00')).toBe(2)
  })
})

describe('InvoicesPage — live per-client preview does not double-list hourly work (S9)', () => {
  /*
   * `buildDisplayInvoice`'s `subscriptionLines` filter used to exclude by
   * LABEL ('Billable hours' / 'Hourly overage'), which stopped matching once
   * the June 2026 cutover made hourly labels per-person ("Billable hours —
   * <name>"). With the breakdown on, the per-employee line then survived
   * alongside `entryLines` (which re-lists every entry directly), so hourly
   * work was listed twice. Invisible while nothing summed a section total
   * next to it; wrong now that "Total Ad-Hoc/Billable Hours" prints beside a
   * correct Total due — the section would read roughly double the real
   * charge. The fix filters by `kind !== 'hourly'` instead, which matches
   * regardless of the label's wording.
   */
  it('prints each hourly amount once, and the hours section total is their sum', async () => {
    selectedClientId.value = 'client-hourly'
    mockList.mockImplementation(async () => [])
    renderInShell()

    fireEvent.click(await screen.findByRole('button', { name: 'Print invoice' }))
    await waitFor(() => expect(printInvoice).toHaveBeenCalled())

    const text = printed()
    const occurrences = (needle: string) => text.split(needle).length - 1

    // The merged per-employee line ("Billable hours — Test Employee", $500 —
    // built from `invoice.lines` by the generator) must NOT be on this
    // preview at all: it is exactly what the buggy label filter let through
    // (its label never matched the literal 'Billable hours'), printing
    // alongside the per-entry rows below and doubling the section total.
    expect(text).not.toContain('Billable hours — Test Employee')
    // entry-1: 120 min at $100/hr = $200.00. entry-2: 180 min at $100/hr =
    // $300.00 — the per-entry rows `entryLines` builds directly from the raw
    // time entries. Each must appear exactly once.
    expect(occurrences('$200.00')).toBe(1)
    expect(occurrences('$300.00')).toBe(1)
    expect(text).toContain('Total Ad-Hoc/Billable Hours')
    // $200 + $300 = $500 is both the section total AND Total due — the
    // constraint this fix restores. Before the fix the section also carried
    // the doubled $500 employee line, so the total read $1,000.00 instead.
    expect(text).not.toContain('$1,000.00')
    expect(occurrences('$500.00')).toBe(2)
  })
})
