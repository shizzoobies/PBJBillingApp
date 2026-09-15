import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type {
  Checklist,
  Client,
  Employee,
  PersistedInvoice,
  TimeEntry,
} from '../lib/types'

/**
 * The hours review panel beside the invoice under review — featreq-8cec48db.
 *
 * Brittany's two decisions are what these pin. Tags STAGE and apply on save, so
 * a click must move the running total and touch NO network; and the panel shows
 * the tag already made at time entry and lets her override it, so the control's
 * value comes off the ENTRY rather than off the invoice.
 *
 * The risk worth testing is arithmetic and wiring, not layout: what the save
 * sends has to be the lines she has been looking at the total of, in ONE
 * request with the tags that moved them.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 60,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const employees = [
  { id: 'emp-lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 100 },
] as unknown as Employee[]

const checklists = [{ id: 'chk-1', title: 'Monthly close' }] as unknown as Checklist[]

const entry = (over: Partial<TimeEntry> = {}) =>
  ({
    id: 'entry-1',
    clientId: 'client-acme',
    employeeId: 'emp-lisa',
    date: '2026-08-04',
    minutes: 90,
    description: 'Month-end close',
    billable: true,
    taskId: 'chk-1',
    approvalStatus: 'approved',
    ...over,
  }) as unknown as TimeEntry

const timeEntries: TimeEntry[] = [
  entry(),
  entry({
    id: 'entry-2',
    date: '2026-08-11',
    minutes: 30,
    description: 'Payroll journal',
    taskId: undefined,
    taskLabel: 'Payroll',
  }),
  // Already flagged ad hoc when the time was logged — the panel has to show
  // that, not offer "In scope" as if nobody had decided.
  entry({
    id: 'entry-3',
    date: '2026-08-18',
    minutes: 60,
    description: 'Rush 1099 question',
    isAdhoc: true,
  }),
  // A different month: the panel is about the invoice's period.
  entry({ id: 'entry-4', date: '2026-07-02', description: 'Last month' }),
]

const invoice: PersistedInvoice = {
  id: 'inv-1',
  clientId: 'client-acme',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-2026-08-001',
  status: 'draft',
  lineItems: [
    {
      kind: 'hourly',
      label: 'Billable hours — Lisa',
      detail: '2.00h at $100.00/hr',
      hours: 2,
      rate: 100,
      amount: 200,
    },
    {
      kind: 'adhoc',
      label: 'Adhoc — Rush 1099 question',
      detail: 'Aug 18, 2026 · Lisa · 1.00h at $100.00/hr',
      amount: 100,
      adhocMode: 'billed',
      adhocAmount: 100,
      entryId: 'entry-3',
    },
  ],
  subtotal: 300,
  total: 300,
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

async function openEditor(
  over: Partial<Parameters<typeof InvoiceMonthRun>[0]> = {},
  /** Which status tab the invoice sits in — drafts start on "To review". */
  tab?: string,
) {
  render(
    <InvoiceMonthRun
      clients={clients}
      timeEntries={timeEntries}
      employees={employees}
      checklists={checklists}
      onPrint={vi.fn()}
      {...over}
    />,
  )
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${tab}`) }))
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

const scopeSelect = (description: string, date: string) =>
  screen.getByLabelText(`Scope for ${description} on ${date}`) as HTMLSelectElement

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([invoice])
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(invoice)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceScopePanel — what it shows', () => {
  it('lists the period’s entries grouped under the team member, with the five columns', async () => {
    await openEditor()

    expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Description' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Hours' })).toBeInTheDocument()
    // The team member is the GROUP heading rather than a repeated cell.
    expect(screen.getByRole('columnheader', { name: 'Lisa' })).toBeInTheDocument()
    expect(screen.getByText('Month-end close')).toBeInTheDocument()
    // The checklist behind the entry, read back by id.
    expect(screen.getAllByText('Monthly close').length).toBeGreaterThan(0)
    // A free-typed task name reaches her too, rather than reading "Unassigned".
    expect(screen.getByText('Payroll')).toBeInTheDocument()
  })

  it('leaves another month’s time out of it', async () => {
    await openEditor()
    expect(screen.queryByText('Last month')).not.toBeInTheDocument()
  })

  it('shows the tag the entry already carries, so she can override it', async () => {
    await openEditor()
    expect(scopeSelect('Month-end close', '2026-08-04').value).toBe('in-scope')
    expect(scopeSelect('Rush 1099 question', '2026-08-18').value).toBe('adhoc')
  })

  it('subtotals the person’s hours three ways', async () => {
    await openEditor()
    expect(screen.getByText('2.00h in scope')).toBeInTheDocument()
    expect(screen.getByText('1.00h ad hoc')).toBeInTheDocument()
    expect(screen.getByText('0.00h out of scope')).toBeInTheDocument()
  })

  it('offers the three existing ad hoc options only on an ad hoc row', async () => {
    await openEditor()
    const choices = screen.getAllByLabelText(/^What to do with this ad hoc work on/)
    expect(choices).toHaveLength(1)
    expect(
      [...(choices[0] as HTMLSelectElement).options].map((option) => option.textContent),
    ).toEqual(['Invoice it', 'Show detail only ($0.00)', 'Leave off the invoice'])
  })
})

describe('InvoiceScopePanel — staging', () => {
  it('moves the running total on a tag, with NO network call', async () => {
    await openEditor()
    expect(screen.getByText(/Total \$300\.00/)).toBeInTheDocument()

    fireEvent.change(scopeSelect('Month-end close', '2026-08-04'), {
      target: { value: 'out-of-scope' },
    })

    // 1.50h of her 2.00h leaves the billable line at $100/hr.
    expect(screen.getByText(/Total \$150\.00/)).toBeInTheDocument()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('says on the row that nothing has happened yet', async () => {
    await openEditor()
    expect(screen.queryByText('Will apply on save')).not.toBeInTheDocument()

    fireEvent.change(scopeSelect('Payroll journal', '2026-08-11'), {
      target: { value: 'adhoc' },
    })

    expect(screen.getByText('Will apply on save')).toBeInTheDocument()
  })

  it('moving time to ad hoc at the same rate leaves the total alone', async () => {
    await openEditor()
    fireEvent.change(scopeSelect('Month-end close', '2026-08-04'), {
      target: { value: 'adhoc' },
    })
    expect(screen.getByText(/Total \$300\.00/)).toBeInTheDocument()
  })

  it('sends the recomputed lines and the tags in ONE request', async () => {
    await openEditor()
    fireEvent.change(scopeSelect('Month-end close', '2026-08-04'), {
      target: { value: 'out-of-scope' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    const [, body] = mockUpdate.mock.calls[0]
    expect(body.entryTags).toEqual([{ entryId: 'entry-1', tag: 'out-of-scope' }])
    expect(body.lineItems?.[0]).toMatchObject({
      kind: 'hourly',
      hours: 0.5,
      rate: 100,
      amount: 50,
      detail: '0.50h at $100.00/hr',
    })
    // The ad hoc line she did not touch is byte-for-byte what it was.
    expect(body.lineItems?.[1]).toEqual(invoice.lineItems[1])
  })

  /**
   * The shape almost every real invoice is in: the hourly line has been renamed
   * by hand and carries no hours or rate (38 of the 40 hourly lines written
   * since the June 2026 cutover, measured against production 2026-09-14). The
   * hours cannot be taken off a line like that, so nothing may be added either
   * — the alternative is charging the client twice for the same work.
   */
  it('says so on the row when the hours sit on a renamed line, and moves no money', async () => {
    mockList.mockResolvedValue([
      {
        ...invoice,
        lineItems: [
          { kind: 'hourly', label: 'For services rendered for the month of', detail: '', amount: 800 },
        ],
        subtotal: 800,
        total: 800,
      },
    ])
    await openEditor()

    fireEvent.change(scopeSelect('Month-end close', '2026-08-04'), {
      target: { value: 'adhoc' },
    })

    // Her row, plus the ad hoc row this invoice has no ad hoc line for — both
    // are hours the lines cannot account for.
    expect(screen.getAllByText(/these hours are on a renamed line/i)).toHaveLength(2)
    expect(screen.queryByText('Will apply on save')).not.toBeInTheDocument()
    expect(screen.getByText(/Total \$800\.00/)).toBeInTheDocument()
  })

  it('still saves the tag on a renamed invoice, with the lines untouched', async () => {
    const renamed = {
      ...invoice,
      lineItems: [
        { kind: 'hourly' as const, label: 'For services rendered', detail: '', amount: 800 },
      ],
      subtotal: 800,
      total: 800,
    }
    mockList.mockResolvedValue([renamed])
    await openEditor()

    fireEvent.change(scopeSelect('Month-end close', '2026-08-04'), {
      target: { value: 'out-of-scope' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, body] = mockUpdate.mock.calls[0]
    expect(body.entryTags).toEqual([{ entryId: 'entry-1', tag: 'out-of-scope' }])
    expect(body.lineItems).toEqual(renamed.lineItems)
  })

  /**
   * A blocked tag still SAVES — it is a fact about the work. So after the save
   * the row must keep its warning, or the only sign that the invoice is still
   * billing hours the entry disowns disappears with the remount.
   */
  it('keeps the warning on a saved tag the lines never followed', async () => {
    mockList.mockResolvedValue([
      {
        ...invoice,
        lineItems: [
          { kind: 'hourly', label: 'For services rendered for the month of', detail: '', amount: 800 },
        ],
        subtotal: 800,
        total: 800,
      },
    ])
    // Already saved out of scope by an earlier, blocked save.
    await openEditor({
      timeEntries: timeEntries.map((row) =>
        row.id === 'entry-1' ? { ...row, billable: false } : row,
      ),
    })

    expect(scopeSelect('Month-end close', '2026-08-04').value).toBe('out-of-scope')
    expect(screen.queryByText('Will apply on save')).not.toBeInTheDocument()
    expect(screen.getAllByText(/these hours are on a renamed line/i).length).toBeGreaterThan(0)
  })

  /**
   * A pre-commit draft's ad hoc lines carry no entry id. Reading only the
   * stamped ones showed "Invoice it" beside a row already sitting at courtesy,
   * and one round trip through the panel re-billed the work.
   */
  it('shows the ad hoc decision a pre-commit draft s line already carries', async () => {
    const legacy = {
      ...invoice.lineItems[1],
      adhocMode: 'courtesy' as const,
      amount: 0,
      adhocAmount: 100,
    }
    delete (legacy as Record<string, unknown>).entryId
    mockList.mockResolvedValue([
      {
        ...invoice,
        lineItems: [invoice.lineItems[0], legacy],
        subtotal: 200,
        total: 200,
      },
    ])
    await openEditor()

    const choice = screen.getByLabelText(
      'What to do with this ad hoc work on 2026-08-18',
    ) as HTMLSelectElement
    expect(choice.value).toBe('courtesy')
  })

  // Landing back on the tag the entry already has is a retraction, not an edit:
  // the editor goes clean again and the save sends no tag write at all.
  it('drops a tag she changed her mind about', async () => {
    await openEditor()
    const select = scopeSelect('Month-end close', '2026-08-04')

    fireEvent.change(select, { target: { value: 'out-of-scope' } })
    expect(screen.getByText('Will apply on save')).toBeInTheDocument()

    fireEvent.change(select, { target: { value: 'in-scope' } })
    expect(screen.queryByText('Will apply on save')).not.toBeInTheDocument()
    expect(screen.getByText(/Total \$300\.00/)).toBeInTheDocument()
    // Nothing left to save, so there is nothing to send: the editor is clean
    // rather than holding a tag write that would change nothing.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('sends no entryTags at all when she only edited a line', async () => {
    await openEditor()
    const labels = screen.getAllByLabelText('Line description') as HTMLInputElement[]
    fireEvent.change(labels[0], { target: { value: 'Billable hours — corrected' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(mockUpdate.mock.calls[0][1].entryTags).toBeUndefined()
  })
})

describe('InvoiceScopePanel — when she may not decide here', () => {
  it('disables every control on a sent invoice', async () => {
    mockList.mockResolvedValue([{ ...invoice, status: 'sent', sentAt: '2026-09-01T00:00:00Z' }])
    await openEditor({}, 'Sent')
    expect(scopeSelect('Month-end close', '2026-08-04')).toBeDisabled()
  })

  it('disables them while an owner is previewing someone else’s view', async () => {
    await openEditor({ previewMode: true })
    expect(scopeSelect('Month-end close', '2026-08-04')).toBeDisabled()
  })

  it('disables them on a paid invoice, whose content is frozen', async () => {
    mockList.mockResolvedValue([{ ...invoice, status: 'paid', paidAt: '2026-09-05T00:00:00Z' }])
    await openEditor({}, 'Paid')
    expect(scopeSelect('Month-end close', '2026-08-04')).toBeDisabled()
  })

  // A subscription invoice has no per-employee hourly lines to move hours
  // between, so the panel says so rather than offering a control that would
  // quietly change nothing.
  it('shows the hours but not the decision on a subscription invoice', async () => {
    const subscription = [
      { ...clients[0], billingMode: 'subscription', monthlyRate: 500 },
    ] as unknown as Client[]
    await openEditor({ clients: subscription })

    expect(screen.getByText('Month-end close')).toBeInTheDocument()
    expect(scopeSelect('Month-end close', '2026-08-04')).toBeDisabled()
    expect(screen.getByText(/only exist on an hourly invoice from June 2026 on/)).toBeInTheDocument()
  })

  it('says so when a month has been signed off', async () => {
    await openEditor({
      timesheetLocks: [
        { id: 'lock-1', userId: 'emp-lisa', period: '2026-08', lockedBy: 'emp-owner', lockedAt: '' },
      ],
    })
    expect(screen.getAllByText('Month locked').length).toBeGreaterThan(0)
    // A note, not a block: owners are exempt from the lock.
    expect(scopeSelect('Month-end close', '2026-08-04')).not.toBeDisabled()
  })

  it('says so plainly when the client logged no time', async () => {
    await openEditor({ timeEntries: [] })
    const panel = screen.getByRole('complementary', { name: 'Hours logged for this client' })
    expect(
      within(panel).getByText('No time was logged for this client this period.'),
    ).toBeInTheDocument()
  })
})
