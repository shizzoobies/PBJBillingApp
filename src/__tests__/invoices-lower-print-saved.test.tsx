import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * The lower "Print invoice" button prints the SAVED invoice when the month has
 * one (the same sheet the row's Print gives), and the dialog says which of the
 * two it will print before she presses Print.
 *
 * The clock is frozen on October 1, 2026 (Date only): the top-bar billing month
 * is October while September is the month being invoiced. August $200,
 * September $300 and October $0 are what the LIVE calculation gives; every
 * saved invoice below carries a figure the calculation could never produce.
 */

const printInvoice = vi.hoisted(() => vi.fn())
const page = vi.hoisted(() => ({ billingPeriod: '2026-10' }))

vi.mock('../lib/api', () => ({
  answerInvoiceAiReviewQuestionRequest: vi.fn(),
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
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

const client = {
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
} as unknown as Client

const timeEntries = [
  {
    id: 'e-aug',
    employeeId: 'emp-1',
    clientId: 'client-hourly',
    date: '2026-08-04',
    minutes: 120,
    billable: true,
  },
  {
    id: 'e-sep',
    employeeId: 'emp-1',
    clientId: 'client-hourly',
    date: '2026-09-11',
    minutes: 180,
    billable: true,
  },
]

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: [client],
      contacts: [],
      timeEntries,
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [{ id: 'emp-1', name: 'Test Employee', role: 'Bookkeeper', billRate: 100 }],
    },
    selectedClientId: 'client-hourly',
    setSelectedClientId: vi.fn(),
    billingPeriod: page.billingPeriod,
    printInvoice,
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const saved = (overrides: Partial<PersistedInvoice>): PersistedInvoice => ({
  id: 'inv-sep',
  clientId: 'client-hourly',
  period: '2026-09',
  kind: 'monthly',
  number: 'INV-2026-09-001',
  status: 'draft',
  lineItems: [
    { kind: 'hourly', label: 'Billable hours', detail: 'Corrected September wording', amount: 777 },
  ],
  subtotal: 777,
  total: 777,
  dueDate: '2026-10-31',
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: '2026-10-01T14:00:00.000Z',
  updatedAt: null,
  ...overrides,
})

/** What the server holds, by month. Anything not listed has no invoices. */
const stored = new Map<string, PersistedInvoice[]>()
const serveStored = () =>
  mockList.mockImplementation(async (period?: string) => stored.get(period ?? '') ?? [])

const printed = () => document.querySelector('.invoice-print')!.textContent ?? ''

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

const openDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Print invoice' }))
  return within(await screen.findByRole('dialog', { name: 'Print invoice' }))
}

const setMonth = (dialog: ReturnType<typeof within>, value: string) =>
  fireEvent.change(dialog.getByLabelText('Billing month'), { target: { value } })

const printButton = (dialog: ReturnType<typeof within>) =>
  dialog.getByRole('button', { name: 'Print' })

const clickPrint = async (dialog: ReturnType<typeof within>) => {
  await waitFor(() => expect(printButton(dialog)).toBeEnabled())
  fireEvent.click(printButton(dialog))
  await waitFor(() => expect(printInvoice).toHaveBeenCalledOnce())
}

const addCustomLine = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Customize' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Add line' }))
  const descriptions = screen.getAllByPlaceholderText('Description')
  fireEvent.change(descriptions[descriptions.length - 1], { target: { value: 'Custom review fee' } })
}

const NO_INVOICE =
  'No invoice has been generated for September 2026 yet. Prints a preview from current time and rates.'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 1, 9, 30, 0)) // Oct 1, 2026, local
  printInvoice.mockReset()
  mockList.mockReset()
  stored.clear()
  serveStored()
  page.billingPeriod = '2026-10'
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the lower Print prints the saved invoice when the month has one', () => {
  it('names the saved invoice and prints it, not the live calculation', async () => {
    stored.set('2026-09', [saved({})])
    renderInShell()
    // The on-screen invoice is October's, and the live September would be $300.
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-09-001 (Draft).'),
    ).toBeInTheDocument()
    await clickPrint(dialog)

    expect(screen.queryByRole('dialog', { name: 'Print invoice' })).toBeNull()
    // Only the stored invoice carries these; the live September is $300.00.
    expect(printed()).toContain('$777.00')
    expect(printed()).toContain('Corrected September wording')
    expect(printed()).not.toContain('$300.00')
    // Dated like the row's Print: the last day of the month it bills.
    expect(printed()).toContain('September 30, 2026')
  })

  it('says the status the way the month run does, and copes with no number', async () => {
    stored.set('2026-09', [saved({ status: 'processing', number: null })])
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(await dialog.findByText('Prints the saved invoice (Processing).')).toBeInTheDocument()
  })

  it('reads Sent and Paid in plain words', async () => {
    stored.set('2026-09', [saved({ status: 'sent' })])
    stored.set('2026-08', [saved({ id: 'inv-aug', period: '2026-08', number: 'INV-2026-08-001', status: 'paid' })])
    renderInShell()
    const dialog = await openDialog()

    setMonth(dialog, '2026-09')
    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-09-001 (Sent).'),
    ).toBeInTheDocument()
    setMonth(dialog, '2026-08')
    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-08-001 (Paid).'),
    ).toBeInTheDocument()
  })

  it('uses the saved invoice of the month chosen, not the page’s own month', async () => {
    // The page is on October, which has its own saved invoice; September's is
    // the one chosen in the dialog.
    stored.set('2026-10', [saved({ id: 'inv-oct', period: '2026-10', number: 'INV-2026-10-001', lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: 'October only', amount: 555 }], total: 555, subtotal: 555 })])
    stored.set('2026-09', [saved({})])
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')
    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-09-001 (Draft).'),
    ).toBeInTheDocument()
    await clickPrint(dialog)

    expect(printed()).toContain('$777.00')
    expect(printed()).not.toContain('$555.00')
  })

  it('takes the monthly invoice over a retainer issued the same month', async () => {
    stored.set('2026-09', [
      saved({
        id: 'inv-retainer',
        kind: 'retainer',
        number: 'INV-RET-001',
        lineItems: [{ kind: 'custom', label: 'Engagement retainer', detail: '', amount: 4000 }],
        subtotal: 4000,
        total: 4000,
      }),
      saved({}),
    ])
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-09-001 (Draft).'),
    ).toBeInTheDocument()
    await clickPrint(dialog)
    expect(printed()).toContain('$777.00')
    expect(printed()).not.toContain('Engagement retainer')
  })

  it('does not count another client’s invoice', async () => {
    stored.set('2026-09', [saved({ clientId: 'client-other' })])
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(await dialog.findByText(NO_INVOICE)).toBeInTheDocument()
  })
})

describe('with no saved invoice the lower Print is the preview it always was', () => {
  it('says so and prints the live calculation', async () => {
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(await dialog.findByText(NO_INVOICE)).toBeInTheDocument()
    await clickPrint(dialog)
    expect(printed()).toContain('$300.00')
    expect(printed()).toContain('Billing Period: September 2026')
  })

  it('treats a month holding only void invoices as having none', async () => {
    stored.set('2026-09', [saved({ status: 'void' })])
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(await dialog.findByText(NO_INVOICE)).toBeInTheDocument()
    await clickPrint(dialog)
    expect(printed()).toContain('$300.00')
    expect(printed()).not.toContain('$777.00')
  })

  it('treats a month holding only a retainer as having no monthly invoice', async () => {
    stored.set('2026-09', [saved({ kind: 'retainer', number: 'INV-RET-001' })])
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(await dialog.findByText(NO_INVOICE)).toBeInTheDocument()
    await clickPrint(dialog)
    expect(printed()).toContain('$300.00')
  })
})

describe('Customize on the page’s own month stays her one-off sheet', () => {
  it('says so over a saved invoice and prints the on-screen sheet', async () => {
    stored.set('2026-10', [
      saved({ id: 'inv-oct', period: '2026-10', number: 'INV-2026-10-001', total: 555, subtotal: 555 }),
    ])
    renderInShell()
    await addCustomLine()

    const dialog = await openDialog()
    expect(dialog.getByText('Customize edits apply to October 2026 only.')).toBeInTheDocument()
    expect(
      await dialog.findByText(
        'Prints this page with your Customize edits, not the saved invoice INV-2026-10-001.',
      ),
    ).toBeInTheDocument()
    await clickPrint(dialog)

    expect(printed()).toContain('Custom review fee')
    expect(printed()).not.toContain('$555.00')
    expect(printed()).not.toContain('Corrected September wording')
  })

  it('still prints another month’s saved invoice while Customize is open', async () => {
    stored.set('2026-09', [saved({})])
    renderInShell()
    await addCustomLine()

    const dialog = await openDialog()
    setMonth(dialog, '2026-09')
    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-09-001 (Draft).'),
    ).toBeInTheDocument()
    await clickPrint(dialog)

    expect(printed()).toContain('$777.00')
    expect(printed()).not.toContain('Custom review fee')
  })
})

describe('when the lookup does not answer cleanly', () => {
  it('says it could not check, keeps Print off, and retries on a month change', async () => {
    stored.set('2026-08', [
      saved({ id: 'inv-aug', period: '2026-08', number: 'INV-2026-08-001', status: 'reviewed' }),
    ])
    mockList.mockImplementation(async (period?: string) => {
      if (period === '2026-09') throw new Error('network down')
      return stored.get(period ?? '') ?? []
    })
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Could not check for a saved invoice. Try again.',
    )
    expect(printButton(dialog)).toBeDisabled()
    fireEvent.click(printButton(dialog))
    expect(printInvoice).not.toHaveBeenCalled()

    setMonth(dialog, '2026-08')
    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-08-001 (Reviewed).'),
    ).toBeInTheDocument()
    expect(dialog.queryByRole('alert')).toBeNull()
    expect(printButton(dialog)).toBeEnabled()
  })

  it('tries again when the dialog is reopened', async () => {
    stored.set('2026-09', [saved({})])
    let fail = true
    mockList.mockImplementation(async (period?: string) => {
      if (period === '2026-09' && fail) throw new Error('network down')
      return stored.get(period ?? '') ?? []
    })
    renderInShell()
    let dialog = await openDialog()
    setMonth(dialog, '2026-09')
    expect(await dialog.findByRole('alert')).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    fail = false
    dialog = await openDialog()
    setMonth(dialog, '2026-09')
    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-09-001 (Draft).'),
    ).toBeInTheDocument()
  })

  it('shows a checking line with Print off while the lookup is in flight', async () => {
    let release: (rows: PersistedInvoice[]) => void = () => {}
    mockList.mockImplementation(async (period?: string) =>
      period === '2026-09'
        ? new Promise<PersistedInvoice[]>((resolve) => {
            release = resolve
          })
        : [],
    )
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')

    expect(dialog.getByText('Checking for a saved invoice...')).toBeInTheDocument()
    expect(printButton(dialog)).toBeDisabled()

    await act(async () => {
      release([saved({})])
    })
    expect(
      await dialog.findByText('Prints the saved invoice INV-2026-09-001 (Draft).'),
    ).toBeInTheDocument()
    expect(dialog.queryByText('Checking for a saved invoice...')).toBeNull()
    expect(printButton(dialog)).toBeEnabled()
  })

  it('never lets a slow answer for a month she has left win', async () => {
    let releaseSeptember: (rows: PersistedInvoice[]) => void = () => {}
    mockList.mockImplementation(async (period?: string) => {
      if (period === '2026-09') {
        // Slow: still out when the faster August answer has already landed.
        return new Promise<PersistedInvoice[]>((resolve) => {
          releaseSeptember = resolve
        })
      }
      return []
    })
    renderInShell()
    const dialog = await openDialog()
    setMonth(dialog, '2026-09')
    expect(dialog.getByText('Checking for a saved invoice...')).toBeInTheDocument()

    setMonth(dialog, '2026-08')
    expect(
      await dialog.findByText(
        'No invoice has been generated for August 2026 yet. Prints a preview from current time and rates.',
      ),
    ).toBeInTheDocument()

    // September's saved invoice finally arrives; August is what is showing.
    await act(async () => {
      releaseSeptember([saved({})])
    })
    expect(dialog.queryByText(/Prints the saved invoice/)).toBeNull()
    expect(
      dialog.getByText(
        'No invoice has been generated for August 2026 yet. Prints a preview from current time and rates.',
      ),
    ).toBeInTheDocument()

    await clickPrint(dialog)
    expect(printed()).toContain('$200.00')
    expect(printed()).not.toContain('$777.00')
  })
})
