import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import {
  ApiError,
  type Checklist,
  type Client,
  type Employee,
  type PersistedInvoice,
  type TimeEntry,
} from '../lib/types'

/**
 * While the covered dates are saving, nothing in the editor can take input.
 *
 * A successful dates save hands the server's invoice to the run and the editor
 * remounts from it (keyed on `updatedAt`), so anything typed or staged during
 * the request is thrown away. The quiet control is already refused while the
 * editor is dirty; what is pinned here is the rest of the editor — the note,
 * Add a line, the hours panel's tags, and every button that saves or sends —
 * which waits for the request and is live again afterwards, success or failure.
 * The Remove buttons stay where they are, disabled, rather than blinking away.
 *
 * Also pinned: a line the server marks not changeable (a later month is
 * already billed for its expense) says so in words instead of offering a
 * control that can only fail.
 */

vi.mock('../lib/api', () => ({
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
  verifyAllInvoicePaymentsRequest: vi.fn(),
}))

import {
  confirmInvoiceCoverageRequest,
  listInvoicesRequest,
  updateInvoiceRequest,
  verifyAllInvoicePaymentsRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockConfirm = vi.mocked(confirmInvoiceCoverageRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockVerifyAll = vi.mocked(verifyAllInvoicePaymentsRequest)

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

const timeEntries = [
  {
    id: 'entry-1',
    clientId: 'client-acme',
    employeeId: 'emp-lisa',
    date: '2026-08-04',
    minutes: 120,
    description: 'Month-end close',
    billable: true,
    taskId: 'chk-1',
    approvalStatus: 'approved',
  },
] as unknown as TimeEntry[]

const recurringLine = {
  kind: 'recurring' as const,
  label: 'QuickBooks Ledger — August 13 – September 13, 2026',
  detail: 'monthly',
  amount: 90,
  recurringId: 'recur-qbo',
  coverageStart: '2026-08-13',
  coverageEnd: '2026-09-13',
}

const baseInvoice: PersistedInvoice = {
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
    recurringLine,
  ],
  subtotal: 290,
  total: 290,
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

/** The same invoice after the dates moved: a new `updatedAt` remounts the editor. */
const movedInvoice: PersistedInvoice = {
  ...baseInvoice,
  updatedAt: '2026-10-01T00:00:00.000Z',
  lineItems: [
    baseInvoice.lineItems[0],
    {
      ...recurringLine,
      label: 'QuickBooks Ledger — September 13 – October 13, 2026',
      coverageStart: '2026-09-13',
      coverageEnd: '2026-10-13',
    },
  ],
}

async function openEditor(invoice: PersistedInvoice = baseInvoice) {
  mockList.mockResolvedValue([invoice])
  render(
    <InvoiceMonthRun
      clients={clients}
      timeEntries={timeEntries}
      employees={employees}
      checklists={checklists}
      onPrint={vi.fn()}
    />,
  )
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

const changeButton = () => screen.getByRole('button', { name: 'Change covered dates' })
const note = () => screen.getByLabelText('Note to the client') as HTMLTextAreaElement
const addLine = () => screen.getByRole('button', { name: 'Add a line' })
const reviewButton = () => screen.getByRole('button', { name: 'Mark reviewed' })
const saveChanges = () => screen.getByRole('button', { name: 'Save changes' })
const scopeSelect = () =>
  screen.getByLabelText('Scope for Month-end close on 2026-08-04') as HTMLSelectElement
const removeButtons = () => screen.getAllByRole('button', { name: /^Remove / })

/** Start a dates save that stays in flight until the returned function settles it. */
function startSavingDates() {
  let settle: (result: 'ok' | 'refused') => void = () => {}
  mockConfirm.mockReturnValue(
    new Promise((resolve, reject) => {
      settle = (result) =>
        result === 'ok'
          ? resolve(movedInvoice)
          : reject(new Error('The end of the covered period must come after its start.'))
    }),
  )
  fireEvent.click(changeButton())
  fireEvent.change(screen.getByLabelText('Covered period end'), {
    target: { value: '2026-09-20' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))
  return settle
}

function expectEditorFrozen() {
  expect(note()).toHaveAttribute('readonly')
  expect(addLine()).toBeDisabled()
  expect(saveChanges()).toBeDisabled()
  expect(reviewButton()).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Mark paid' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Void' })).toBeDisabled()
  expect(screen.getByRole('button', { name: /Payment link/ })).toBeDisabled()
  // The hours panel stages tags that the remount would discard.
  expect(scopeSelect()).toBeDisabled()
  expect(screen.getByText(/covered dates are saving/i)).toBeInTheDocument()
  // Visible, not gone: a blink of the whole column is worse than a dead button.
  const removes = removeButtons()
  expect(removes).toHaveLength(2)
  for (const button of removes) expect(button).toBeDisabled()
  for (const box of screen.getAllByLabelText('Line description')) {
    expect(box).toHaveAttribute('readonly')
  }
}

function expectEditorLive() {
  expect(note()).not.toHaveAttribute('readonly')
  expect(addLine()).toBeEnabled()
  expect(reviewButton()).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Mark paid' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Void' })).toBeEnabled()
  expect(scopeSelect()).toBeEnabled()
  expect(screen.queryByText(/covered dates are saving/i)).not.toBeInTheDocument()
  for (const button of removeButtons()) expect(button).toBeEnabled()
  for (const box of screen.getAllByLabelText('Line description')) {
    expect(box).not.toHaveAttribute('readonly')
  }
}

beforeEach(() => {
  mockList.mockReset()
  mockConfirm.mockReset()
  mockUpdate.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvoiceMonthRun — nothing typed is lost while the dates save', () => {
  it('freezes the whole editor during the request and frees it when it succeeds', async () => {
    await openEditor()
    expectEditorLive()

    const settle = startSavingDates()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled())
    expectEditorFrozen()

    settle('ok')
    expect(
      await screen.findByDisplayValue('QuickBooks Ledger — September 13 – October 13, 2026'),
    ).toBeInTheDocument()
    expectEditorLive()
  })

  it('frees it again when the server refuses, with her typed dates still there', async () => {
    await openEditor()
    const settle = startSavingDates()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled())
    expectEditorFrozen()

    settle('refused')
    expect(
      await screen.findByText('The end of the covered period must come after its start.'),
    ).toBeInTheDocument()
    expectEditorLive()
    expect((screen.getByLabelText('Covered period end') as HTMLInputElement).value).toBe(
      '2026-09-20',
    )
  })

  it('freezes it the same way for the flagged Confirm dates path', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [
        baseInvoice.lineItems[0],
        { ...recurringLine, needsCoverageConfirmation: true, coverageReason: 'gap' },
      ],
    })
    let settle: (invoice: PersistedInvoice) => void = () => {}
    mockConfirm.mockReturnValue(new Promise((resolve) => (settle = resolve)))

    fireEvent.click(screen.getByRole('button', { name: 'Confirm dates' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled())
    expect(note()).toHaveAttribute('readonly')
    expect(addLine()).toBeDisabled()
    expect(scopeSelect()).toBeDisabled()
    for (const button of removeButtons()) expect(button).toBeDisabled()

    settle(movedInvoice)
    expect(
      await screen.findByDisplayValue('QuickBooks Ledger — September 13 – October 13, 2026'),
    ).toBeInTheDocument()
    expect(note()).not.toHaveAttribute('readonly')
    expect(addLine()).toBeEnabled()
  })

  // `locked` (a paid invoice) hides Remove, and that is unchanged.
  it('still hides Remove on a paid invoice', async () => {
    mockList.mockResolvedValue([{ ...baseInvoice, status: 'paid', paidAt: '2026-09-02T00:00:00Z' }])
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Paid/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — the control is offered only where it works', () => {
  const settledInvoice: PersistedInvoice = {
    ...baseInvoice,
    lineItems: [baseInvoice.lineItems[0], { ...recurringLine, coverageChangeable: false }],
  }

  it('says the dates are set by a later invoice, and offers no button', async () => {
    await openEditor(settledInvoice)

    expect(
      screen.getByText('Dates are set by a later invoice — change them there.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change covered dates' })).not.toBeInTheDocument()
    // Not a gate: nothing is flagged, so Mark reviewed is as live as ever.
    expect(reviewButton()).toBeEnabled()
  })

  it('offers the button, and no sentence, on a line the server did not mark', async () => {
    await openEditor()

    expect(changeButton()).toBeInTheDocument()
    expect(
      screen.queryByText('Dates are set by a later invoice — change them there.'),
    ).not.toBeInTheDocument()
  })

  // A flagged line is the open question and is answered in any order.
  it('keeps the Confirm block on a flagged line whatever else it carries', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [
        baseInvoice.lineItems[0],
        {
          ...recurringLine,
          needsCoverageConfirmation: true,
          coverageReason: 'backfill',
          coverageChangeable: false,
        },
      ],
    })

    expect(screen.getByRole('button', { name: 'Confirm dates' })).toBeInTheDocument()
    expect(
      screen.queryByText('Dates are set by a later invoice — change them there.'),
    ).not.toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — the editor message clears when she stages a tag', () => {
  it('goes as soon as she changes one in the hours panel', async () => {
    const sentence = 'Confirm the covered dates before marking reviewed.'
    mockUpdate.mockRejectedValue(new ApiError(409, sentence, 'coverage_unconfirmed'))
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    expect(await screen.findByText(sentence)).toBeInTheDocument()

    fireEvent.change(scopeSelect(), { target: { value: 'out-of-scope' } })

    expect(screen.queryByText(sentence)).not.toBeInTheDocument()
  })
})

describe('InvoiceMonthRun — one dates save at a time', () => {
  const payrollLine = {
    ...recurringLine,
    label: 'Payroll Service — August 13 – September 13, 2026',
    recurringId: 'recur-payroll',
  }
  const flagged = (line: typeof recurringLine) => ({
    ...line,
    needsCoverageConfirmation: true,
    coverageReason: 'gap' as const,
  })

  it('freezes the other line\'s Confirm and date boxes until the first answers', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [baseInvoice.lineItems[0], flagged(recurringLine), flagged(payrollLine)],
    })
    let settle: (invoice: PersistedInvoice) => void = () => {}
    mockConfirm.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const [firstConfirm] = screen.getAllByRole('button', { name: 'Confirm dates' })

    fireEvent.click(firstConfirm)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled())
    // The label stays on the line being saved; the other line only waits.
    const waiting = screen.getByRole('button', { name: 'Confirm dates' })
    expect(waiting).toBeDisabled()
    fireEvent.click(waiting)
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    for (const box of [
      ...screen.getAllByLabelText('Covered period start'),
      ...screen.getAllByLabelText('Covered period end'),
    ]) {
      expect(box).toHaveAttribute('readonly')
    }

    settle(movedInvoice)
    await screen.findByDisplayValue('QuickBooks Ledger — September 13 – October 13, 2026')
  })

  it('freezes a quiet line\'s Change covered dates and an open Save dates too', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [baseInvoice.lineItems[0], recurringLine, flagged(payrollLine)],
    })
    mockConfirm.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm dates' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled())
    expect(changeButton()).toBeDisabled()
  })

  it('frees the other line once the first save is refused', async () => {
    await openEditor({
      ...baseInvoice,
      lineItems: [baseInvoice.lineItems[0], flagged(recurringLine), flagged(payrollLine)],
    })
    let refuse: (error: Error) => void = () => {}
    mockConfirm.mockReturnValue(new Promise((_, reject) => (refuse = reject)))
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm dates' })[0])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled())

    refuse(new Error('Nope.'))

    await screen.findByText('Nope.')
    for (const button of screen.getAllByRole('button', { name: 'Confirm dates' })) {
      expect(button).toBeEnabled()
    }
    for (const box of screen.getAllByLabelText('Covered period end')) {
      expect(box).not.toHaveAttribute('readonly')
    }
  })
})

describe('InvoiceMonthRun — a flagged Confirm waits for her unsaved edits', () => {
  const flaggedInvoice: PersistedInvoice = {
    ...baseInvoice,
    lineItems: [
      baseInvoice.lineItems[0],
      { ...recurringLine, needsCoverageConfirmation: true, coverageReason: 'gap' },
    ],
  }

  it('is live on a clean editor', async () => {
    await openEditor(flaggedInvoice)

    expect(screen.getByRole('button', { name: 'Confirm dates' })).toBeEnabled()
    expect(screen.queryByText('Save your other changes first')).not.toBeInTheDocument()
  })

  it('is disabled, with the reason in words, once a line is edited, and nothing is sent', async () => {
    await openEditor(flaggedInvoice)

    fireEvent.change(screen.getAllByLabelText('Line description')[0], {
      target: { value: 'A label she is still typing' },
    })

    const confirm = screen.getByRole('button', { name: 'Confirm dates' })
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveAttribute('title', 'Save your other changes first')
    expect(screen.getByText('Save your other changes first')).toBeInTheDocument()
    fireEvent.click(confirm)
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('is disabled for a typed note and for a staged tag as well', async () => {
    await openEditor(flaggedInvoice)

    fireEvent.change(note(), { target: { value: 'Thanks!' } })
    expect(screen.getByRole('button', { name: 'Confirm dates' })).toBeDisabled()

    fireEvent.change(note(), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Confirm dates' })).toBeEnabled()

    fireEvent.change(scopeSelect(), { target: { value: 'out-of-scope' } })
    expect(screen.getByRole('button', { name: 'Confirm dates' })).toBeDisabled()
  })
})

describe('InvoiceMonthRun — the derived mark is not an edit', () => {
  it('a re-fetch that changes only the mark leaves a clean editor clean', async () => {
    await openEditor()
    expect(saveChanges()).toBeDisabled()
    expect(reviewButton()).toBeEnabled()
    expect(changeButton()).toBeInTheDocument()

    // Same invoice, same updatedAt, but the server now says a later month is
    // billed. Verify all with Stripe re-reads the list.
    mockList.mockResolvedValue([
      {
        ...baseInvoice,
        lineItems: [baseInvoice.lineItems[0], { ...recurringLine, coverageChangeable: false }],
      },
    ])
    mockVerifyAll.mockResolvedValue({
      checked: 0,
      verified: [],
      stillSettling: [],
      unverifiable: [],
      invoices: [],
    })
    fireEvent.click(screen.getByRole('button', { name: /Verify all with Stripe/ }))

    // The mark arrives (so it reaches the open editor), and it is not an edit.
    expect(
      await screen.findByText('Dates are set by a later invoice — change them there.'),
    ).toBeInTheDocument()
    expect(saveChanges()).toBeDisabled()
    expect(reviewButton()).toBeEnabled()
    expect(screen.queryByText(/unsaved/)).not.toBeInTheDocument()
  })
})
