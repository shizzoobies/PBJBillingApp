import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { BillRateVersion, Client, Employee, PersistedInvoice } from '../lib/types'

/**
 * The hourly section of the invoice editor: three role rows she can fill, an
 * hourly rate she can change, and hours lines that stay in their section.
 *
 * Her words: "Ad-Hoc/Billable Hours should have 3 fillable sections ... CFO /
 * Advisory, Accounting Services, Bookkeeping Services ... when I added a line it
 * put it under reimbursed Expense section ... I would also like to be able to
 * change the hourly rate for this section should I need to ie - Flourish hourly
 * rate is $90 but it came over at $125 and I had to delete and readd."
 *
 * The empty row each heading offers is VIRTUAL: not in the invoice's lines, not
 * sent on Save, never a reason for the editor to read dirty. Typing into it makes
 * it a real line, and the row she is typing in must not be re-created while she
 * does (a re-created input loses focus on the first keystroke).
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, listUnappliedRetainersRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const CFO = 'CFO / Advisory Services'
const ACCOUNTING = 'Accounting Services'
const BOOKKEEPING = 'Bookkeeping Services'

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 125,
    planIds: [],
    contactIds: [],
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
] as unknown as Client[]

const employees = [
  { id: 'britt', name: 'Brittany', role: 'Owner', billRate: 150 },
  { id: 'allison', name: 'Allison', role: 'Accountant', billRate: 135 },
  { id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 75 },
] as Employee[]

function makeInvoice(overrides: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-09',
    kind: 'monthly',
    number: 'INV-2026-09-001',
    status: 'draft',
    lineItems: [
      { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 400 },
      { kind: 'reimbursement', label: 'Reimbursement: Filing', detail: '', amount: 30 },
    ],
    subtotal: 430,
    total: 430,
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
  } as PersistedInvoice
}

const lisaLine = {
  kind: 'hourly' as const,
  label: 'Billable hours — Lisa',
  detail: '2.00h at $75.00/hr',
  hours: 2,
  rate: 75,
  amount: 150,
  roleTier: 'Bookkeeper' as const,
}

async function openEditor(
  invoice: PersistedInvoice,
  props: {
    previewMode?: boolean
    billRateVersions?: BillRateVersion[]
    employees?: Employee[]
    tab?: RegExp
  } = {},
) {
  mockList.mockResolvedValue([invoice])
  const { tab, ...rest } = props
  render(
    <InvoiceMonthRun
      clients={clients}
      employees={rest.employees ?? employees}
      onPrint={vi.fn()}
      {...rest}
    />,
  )
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  fireEvent.click(await screen.findByText(invoice.number as string))
  await waitFor(() => expect(document.querySelector('.invoice-run-editor')).not.toBeNull())
}

const saveButton = () => screen.getByText('Save changes').closest('button') as HTMLButtonElement
const sentLines = () => mockUpdate.mock.calls[0][1].lineItems!

beforeEach(() => {
  mockList.mockReset()
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(makeInvoice())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the three role rows', () => {
  it('are always offered, under the existing headings, in print order', async () => {
    await openEditor(makeInvoice())
    const positions = [CFO, ACCOUNTING, BOOKKEEPING].map(
      (title) => screen.getByText(title, { selector: 'th' }),
    )
    for (let i = 1; i < positions.length; i += 1) {
      expect(
        positions[i - 1].compareDocumentPosition(positions[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    for (const title of [CFO, ACCOUNTING, BOOKKEEPING]) {
      expect(screen.getByLabelText(`Hours for ${title}`)).toHaveValue(null)
      expect(screen.getByLabelText(`Rate for ${title}`)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Add hours line under ${title}` })).toBeInTheDocument()
    }
  })

  it('sit between the plan and the reimbursement, not after everything', async () => {
    await openEditor(makeInvoice())
    const plan = screen.getAllByLabelText('Line description')[0]
    const hours = screen.getByText(CFO, { selector: 'th' })
    const expense = screen.getByDisplayValue('Reimbursement: Filing')
    expect(plan.compareDocumentPosition(hours) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(hours.compareDocumentPosition(expense) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('give their rows their own labels, so a stored line’s labels still find exactly the stored lines', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    expect(screen.getAllByLabelText('Billed hours')).toHaveLength(1)
    expect(screen.getAllByLabelText('Hourly rate')).toHaveLength(1)
    // The two tiers with no stored line still offer a row each.
    expect(screen.getByLabelText(`Hours for ${CFO}`)).toBeInTheDocument()
    expect(screen.getByLabelText(`Hours for ${ACCOUNTING}`)).toBeInTheDocument()
    expect(screen.queryByLabelText(`Hours for ${BOOKKEEPING}`)).not.toBeInTheDocument()
    // Lines whose labels the old tests query by: just the stored ones.
    expect(screen.getAllByLabelText('Line description')).toHaveLength(1)
    expect(screen.getAllByLabelText('Amount')).toHaveLength(1)
  })

  it('show one row per person when two people share a tier, and no empty row there', async () => {
    await openEditor(
      makeInvoice({
        lineItems: [
          {
            kind: 'hourly',
            label: 'Billable hours — Allison',
            detail: '1.00h at $135.00/hr',
            hours: 1,
            rate: 135,
            amount: 135,
            roleTier: 'Accountant',
          },
          {
            kind: 'hourly',
            label: 'Billable hours — Sam',
            detail: '3.00h at $110.00/hr',
            hours: 3,
            rate: 110,
            amount: 330,
            roleTier: 'Accountant',
          },
        ],
      }),
    )
    expect(screen.getAllByLabelText('Billed hours')).toHaveLength(2)
    expect(screen.getAllByLabelText('Hourly rate').map((box) => (box as HTMLInputElement).value)).toEqual([
      '135',
      '110',
    ])
    expect(screen.queryByLabelText(`Hours for ${ACCOUNTING}`)).not.toBeInTheDocument()
    expect(screen.getByLabelText(`Hours for ${CFO}`)).toBeInTheDocument()
  })

  it('put a line with no tier, or tier Other, first and untitled', async () => {
    await openEditor(
      makeInvoice({
        lineItems: [
          { ...lisaLine, label: 'Billable hours — Zed', roleTier: 'Other' },
          { kind: 'hourly', label: 'Billable hours', detail: '', amount: 500 },
        ],
      }),
    )
    const stored = screen.getAllByLabelText('Line description')
    expect(stored.map((box) => (box as HTMLInputElement).value)).toEqual([
      'Billable hours — Zed',
      'Billable hours',
    ])
    const firstHeading = screen.getByText(CFO, { selector: 'th' })
    for (const box of stored) {
      expect(box.compareDocumentPosition(firstHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })
})

describe('an empty row is not part of the invoice until she types in it', () => {
  it('does not make the editor dirty, and is not sent when something else is saved', async () => {
    await openEditor(makeInvoice())
    expect(saveButton()).toBeDisabled()
    expect(screen.queryByText(/ · unsaved/)).not.toBeInTheDocument()

    fireEvent.change(screen.getAllByLabelText('Line description')[0], {
      target: { value: 'Monthly service (Sept)' },
    })
    expect(saveButton()).toBeEnabled()
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    // Only the two stored lines went: no hourly line for the three empty rows.
    expect(sentLines().map((line) => line.kind)).toEqual(['plan', 'reimbursement'])
  })

  it('becomes a real hourly line of that role on the first keystroke, at the staff rate', async () => {
    await openEditor(makeInvoice())
    expect(screen.getByLabelText(`Rate for ${CFO}`)).toHaveValue(150)
    fireEvent.change(screen.getByLabelText(`Hours for ${CFO}`), { target: { value: '2' } })

    expect(saveButton()).toBeEnabled()
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const sent = sentLines()
    expect(sent).toHaveLength(3)
    // Between the plan and the reimbursement: with the hours, not after the expenses.
    expect(sent.map((line) => line.kind)).toEqual(['plan', 'hourly', 'reimbursement'])
    expect(sent[1]).toEqual({
      kind: 'hourly',
      roleTier: 'CFO',
      label: CFO,
      detail: '2.00h at $150.00/hr',
      hours: 2,
      rate: 150,
      amount: 300,
    })
    // The rate was the default, not something she typed: it does not stick.
    expect(sent[1]).not.toHaveProperty('rateManual')
  })

  it('keeps FOCUS on the input she is typing in — the same element before and after the first keystroke', async () => {
    await openEditor(makeInvoice())
    const empty = screen.getByLabelText(`Hours for ${ACCOUNTING}`) as HTMLInputElement
    empty.focus()
    expect(document.activeElement).toBe(empty)

    fireEvent.change(empty, { target: { value: '1' } })

    // The row is now a stored line (its labels changed to a stored line's), and
    // it is the SAME DOM node, still focused: a remounted row would have lost it.
    const now = screen.getByLabelText('Billed hours') as HTMLInputElement
    expect(now).toBe(empty)
    expect(document.activeElement).toBe(empty)
    // And typing goes on from there.
    fireEvent.change(now, { target: { value: '1.5' } })
    expect(screen.getByLabelText('Billed hours')).toBe(empty)
    expect(document.activeElement).toBe(empty)
    expect(empty.value).toBe('1.5')
  })

  it('keeps focus when the first thing typed is the rate', async () => {
    await openEditor(makeInvoice())
    const rate = screen.getByLabelText(`Rate for ${BOOKKEEPING}`) as HTMLInputElement
    rate.focus()
    fireEvent.change(rate, { target: { value: '90' } })
    expect(screen.getByLabelText('Hourly rate')).toBe(rate)
    expect(document.activeElement).toBe(rate)
  })

  it('goes back to an empty row when she removes the only line of a role', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    expect(screen.queryByLabelText(`Hours for ${BOOKKEEPING}`)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Billable hours — Lisa' }))
    expect(screen.getByLabelText(`Hours for ${BOOKKEEPING}`)).toBeInTheDocument()
  })
})

describe('the rate on an hours line', () => {
  it('is a box: typing a rate rewrites the amount and the detail, and marks it hers', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '90' } })

    // 2.00h × $90 = $180 — the amount followed without being touched.
    expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('180')
    expect(screen.getByDisplayValue('2.00h at $90.00/hr')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines()[0]).toMatchObject({
      kind: 'hourly',
      hours: 2,
      rate: 90,
      rateManual: true,
      amount: 180,
      detail: '2.00h at $90.00/hr',
    })
  })

  it('refuses a negative rate (the box snaps back) and stores whole cents', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    const box = screen.getByLabelText('Hourly rate') as HTMLInputElement
    fireEvent.change(box, { target: { value: '-5' } })
    expect(box.value).toBe('75')
    expect(saveButton()).toBeDisabled() // nothing changed
    fireEvent.change(box, { target: { value: '90.555' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines()[0].rate).toBeCloseTo(90.56, 2)
  })

  it('refuses a rate over $10,000, as the server does (a typo like an extra zero)', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    const box = screen.getByLabelText('Hourly rate') as HTMLInputElement
    fireEvent.change(box, { target: { value: '10001' } })
    expect(box.value).toBe('75')
    expect(saveButton()).toBeDisabled()
    fireEvent.change(box, { target: { value: '10000' } })
    expect(box.value).toBe('10000')
    expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('20000')
  })

  it('an EMPTY rate box keeps the last rate and amount, and is not marked hers', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    const box = screen.getByLabelText('Hourly rate') as HTMLInputElement
    fireEvent.change(box, { target: { value: '' } })
    // The box reads empty (she is clearing it to retype) ...
    expect(box.value).toBe('')
    // ... and the line did not take 0, or a manual mark, for it.
    expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('150')
    expect(screen.getByDisplayValue('2.00h at $75.00/hr')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    // Retyping gives a clean "90": no "090".
    fireEvent.change(box, { target: { value: '9' } })
    fireEvent.change(box, { target: { value: '90' } })
    expect(box.value).toBe('90')
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines()[0]).toMatchObject({ rate: 90, rateManual: true, amount: 180 })
  })

  it('a typed 0 is a rate: it sets 0 and marks it hers', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '0' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines()[0]).toMatchObject({ rate: 0, rateManual: true, amount: 0 })
  })

  it('when the box loses focus it shows the line’s own rate again', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    const box = screen.getByLabelText('Hourly rate') as HTMLInputElement
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.blur(box)
    expect(box.value).toBe('75')
  })

  it('the hours box refuses more than 100,000 hours the way the rate box refuses an impossible rate', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    const box = screen.getByLabelText('Billed hours') as HTMLInputElement
    fireEvent.change(box, { target: { value: '100001' } })
    expect(box.value).toBe('2')
    expect(saveButton()).toBeDisabled() // nothing changed
    fireEvent.change(box, { target: { value: '100000' } })
    expect(box.value).toBe('100000')
    expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('7500000')
  })

  // Some browsers report a half-typed "1." / "90." as an EMPTY value with
  // `validity.badInput` set. That is neither an emptied box nor a 0.
  describe('a half-typed number (badInput)', () => {
    const halfTyped = (box: HTMLInputElement) => {
      Object.defineProperty(box, 'validity', { value: { badInput: true }, configurable: true })
      fireEvent.change(box, { target: { value: '' } })
    }

    it('keeps the last hours instead of zeroing the line', async () => {
      await openEditor(makeInvoice({ lineItems: [lisaLine] }))
      halfTyped(screen.getByLabelText('Billed hours') as HTMLInputElement)
      expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('150')
      expect(screen.getByDisplayValue('2.00h at $75.00/hr')).toBeInTheDocument()
      expect(saveButton()).toBeDisabled()
    })

    it('keeps the last rate, and does not mark it hers', async () => {
      await openEditor(makeInvoice({ lineItems: [lisaLine] }))
      halfTyped(screen.getByLabelText('Hourly rate') as HTMLInputElement)
      expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('150')
      expect(saveButton()).toBeDisabled()
    })

    it('a GENUINELY emptied hours box still means 0 hours, and an emptied rate box still keeps the rate', async () => {
      await openEditor(makeInvoice({ lineItems: [lisaLine] }))
      fireEvent.change(screen.getByLabelText('Billed hours'), { target: { value: '' } })
      expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('0')
      fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '' } })
      expect(screen.getByDisplayValue('0.00h at $75.00/hr')).toBeInTheDocument()
    })
  })

  it('the hours box clears and retypes the same way (no "05" after clearing)', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    const box = screen.getByLabelText('Billed hours') as HTMLInputElement
    fireEvent.change(box, { target: { value: '' } })
    expect(box.value).toBe('')
    fireEvent.change(box, { target: { value: '5' } })
    expect(box.value).toBe('5')
    expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('375')
  })

  it('leaves the hours box doing what it did: it uses the rate she set', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('Billed hours'), { target: { value: '3' } })
    expect(screen.getByDisplayValue('3.00h at $90.00/hr')).toBeInTheDocument()
    expect((screen.getAllByLabelText('Amount')[0] as HTMLInputElement).value).toBe('270')
  })

  it('is not offered on a legacy hourly line with no hours or rate', async () => {
    await openEditor(
      makeInvoice({ lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 500 }] }),
    )
    expect(screen.queryByLabelText('Hourly rate')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Billed hours')).not.toBeInTheDocument()
  })
})

describe('Add hours line', () => {
  it('appends another hourly line of that role at the rate already on the invoice for it', async () => {
    await openEditor(makeInvoice({ lineItems: [lisaLine] }))
    fireEvent.click(screen.getByRole('button', { name: `Add hours line under ${BOOKKEEPING}` }))
    expect(screen.getAllByLabelText('Billed hours')).toHaveLength(2)

    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines()[1]).toMatchObject({
      kind: 'hourly',
      roleTier: 'Bookkeeper',
      label: BOOKKEEPING,
      hours: 0,
      rate: 75,
      amount: 0,
    })
  })

  it('stays in its section: it never lands under Reimbursed Expenses', async () => {
    await openEditor(makeInvoice())
    fireEvent.click(screen.getByRole('button', { name: `Add hours line under ${ACCOUNTING}` }))
    // The new row sits between the plan and the expense, with the hours.
    const added = screen.getAllByLabelText('Billed hours')[0]
    const expense = screen.getByDisplayValue('Reimbursement: Filing')
    expect(added.compareDocumentPosition(expense) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is saved WITH the other hours lines, ahead of the reimbursements (checkout, QuickBooks and the AI read in order)', async () => {
    await openEditor(
      makeInvoice({
        lineItems: [
          lisaLine,
          { kind: 'reimbursement', label: 'Reimbursement: Filing', detail: '', amount: 30 },
        ],
      }),
    )
    // The Add link, and typing into an empty row: both land after Lisa, before the expense.
    fireEvent.click(screen.getByRole('button', { name: `Add hours line under ${BOOKKEEPING}` }))
    fireEvent.change(screen.getByLabelText(`Hours for ${CFO}`), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines().map((line) => [line.kind, line.label])).toEqual([
      ['hourly', 'Billable hours — Lisa'],
      ['hourly', BOOKKEEPING],
      ['hourly', CFO],
      ['reimbursement', 'Reimbursement: Filing'],
    ])
  })

  it('on a subscription invoice goes ahead of the expense, not after it', async () => {
    await openEditor(makeInvoice())
    fireEvent.change(screen.getByLabelText(`Hours for ${ACCOUNTING}`), { target: { value: '1' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines().map((line) => line.kind)).toEqual(['plan', 'hourly', 'reimbursement'])
  })

  it('keeps focus on the empty row when the new line lands in the middle of the saved lines', async () => {
    await openEditor(
      makeInvoice({
        lineItems: [
          lisaLine,
          { kind: 'reimbursement', label: 'Reimbursement: Filing', detail: '', amount: 30 },
        ],
      }),
    )
    const empty = screen.getByLabelText(`Hours for ${CFO}`) as HTMLInputElement
    empty.focus()
    fireEvent.change(empty, { target: { value: '1' } })
    // Now a stored line (labels changed), the SAME node, still focused.
    expect(screen.getAllByLabelText('Billed hours')).toContain(empty)
    expect(document.activeElement).toBe(empty)
  })

  describe('what a row she adds is called', () => {
    const handRow = (label: string) => ({
      kind: 'hourly' as const,
      roleTier: 'Accountant' as const,
      label,
      detail: '1.00h at $135.00/hr',
      hours: 1,
      rate: 135,
      amount: 135,
    })
    const labelsSent = async () => {
      fireEvent.click(screen.getByText('Save changes'))
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
      return sentLines().map((line) => line.label)
    }

    it('is the bare role title when nothing under that heading already carries it', async () => {
      // A line generated before role titles (or a retyped one) does not collide.
      await openEditor(makeInvoice({ lineItems: [handRow('Billable hours — Allison')] }))
      fireEvent.click(screen.getByRole('button', { name: `Add hours line under ${ACCOUNTING}` }))
      expect(await labelsSent()).toEqual(['Billable hours — Allison', ACCOUNTING])
    })

    it('is "<Title> — additional hours" when a line under the heading already has the bare title', async () => {
      await openEditor(makeInvoice({ lineItems: [handRow(ACCOUNTING)] }))
      fireEvent.click(screen.getByRole('button', { name: `Add hours line under ${ACCOUNTING}` }))
      expect(await labelsSent()).toEqual([ACCOUNTING, `${ACCOUNTING} — additional hours`])
    })

    it('numbers the next ones, so no two rows under a heading share a label', async () => {
      await openEditor(makeInvoice({ lineItems: [handRow(ACCOUNTING)] }))
      const add = screen.getByRole('button', { name: `Add hours line under ${ACCOUNTING}` })
      fireEvent.click(add)
      fireEvent.click(add)
      fireEvent.click(add)
      const labels = await labelsSent()
      expect(labels).toEqual([
        ACCOUNTING,
        `${ACCOUNTING} — additional hours`,
        `${ACCOUNTING} — additional hours 2`,
        `${ACCOUNTING} — additional hours 3`,
      ])
      expect(new Set(labels).size).toBe(labels.length)
    })

    it('only counts lines under THAT heading', async () => {
      await openEditor(makeInvoice({ lineItems: [handRow(ACCOUNTING)] }))
      fireEvent.click(screen.getByRole('button', { name: `Add hours line under ${BOOKKEEPING}` }))
      expect(await labelsSent()).toEqual([ACCOUNTING, BOOKKEEPING])
    })
  })

  it('reads the staff rate at the client’s rate month, through the dated versions', async () => {
    const billRateVersions = [
      { userId: 'allison', effectivePeriod: '2026-06', rate: 120 },
      { userId: 'allison', effectivePeriod: '2026-09', rate: 135 },
    ] as unknown as BillRateVersion[]
    const pinned = [{ ...clients[0], hourlyRatePeriod: '2026-06' }, clients[1]] as Client[]
    mockList.mockResolvedValue([makeInvoice()])
    render(
      <InvoiceMonthRun
        clients={pinned}
        employees={employees}
        billRateVersions={billRateVersions}
        onPrint={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByText('INV-2026-09-001'))
    await waitFor(() => expect(screen.getByLabelText(`Rate for ${ACCOUNTING}`)).toHaveValue(120))
  })

  it('falls back to the client’s hourly rate when nobody is on staff for the role', async () => {
    await openEditor(makeInvoice(), { employees: [] })
    expect(screen.getByLabelText(`Rate for ${CFO}`)).toHaveValue(125)
  })
})

describe('Add a line', () => {
  it('still creates a custom line for a true extra, and says what it is for', async () => {
    await openEditor(makeInvoice())
    expect(
      screen.getByText('Prints below the sections. For hours, use Add hours line under a role above.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add a line' }))
    fireEvent.change(screen.getAllByLabelText('Line description').at(-1)!, { target: { value: 'Setup' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(sentLines().at(-1)).toMatchObject({ kind: 'custom', label: 'Setup' })
    expect(sentLines().filter((line) => line.kind === 'hourly')).toHaveLength(0)
  })
})

describe('where the empty rows are not offered', () => {
  const noEmptyRows = () => {
    for (const title of [CFO, ACCOUNTING, BOOKKEEPING]) {
      expect(screen.queryByLabelText(`Hours for ${title}`)).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: `Add hours line under ${title}` }),
      ).not.toBeInTheDocument()
    }
  }

  it('is offered on a draft (the tripwire for every absence below)', async () => {
    await openEditor(makeInvoice())
    expect(screen.getByLabelText(`Hours for ${CFO}`)).toBeInTheDocument()
  })

  it('is offered on a subscription client’s invoice, with no prefill', async () => {
    await openEditor(makeInvoice())
    expect(screen.getByLabelText(`Hours for ${BOOKKEEPING}`)).toHaveValue(null)
  })

  it('not on a billing master’s invoice, which is grouped by company', async () => {
    await openEditor(
      makeInvoice({
        id: 'inv-master',
        clientId: 'client-klc-master',
        number: 'INV-2026-09-004',
        lineItems: [
          { kind: 'plan', label: 'Monthly service', detail: '', amount: 500, sourceClientId: 'client-acme' },
        ],
      }),
    )
    noEmptyRows()
  })

  it('not on a retainer invoice', async () => {
    await openEditor(
      makeInvoice({
        kind: 'retainer',
        number: 'INV-RET-2026-001',
        lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 500 }],
      }),
    )
    noEmptyRows()
    expect(screen.queryByText(/Prints below the sections/)).not.toBeInTheDocument()
  })

  it('not on a paid (locked) invoice', async () => {
    await openEditor(makeInvoice({ status: 'paid' }), { tab: /^Paid/ })
    noEmptyRows()
  })

  it('not on a void invoice', async () => {
    await openEditor(makeInvoice({ status: 'void' }), { tab: /^Voided/ })
    noEmptyRows()
  })

  it('not while previewing as someone else', async () => {
    await openEditor(makeInvoice(), { previewMode: true })
    noEmptyRows()
  })

  it('still shows the stored hours lines on a locked invoice, read-only, under their heading', async () => {
    await openEditor(makeInvoice({ status: 'paid', lineItems: [lisaLine] }), { tab: /^Paid/ })
    expect(screen.getByText(BOOKKEEPING, { selector: 'th' })).toBeInTheDocument()
    expect(screen.queryByText(CFO, { selector: 'th' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Billed hours')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Hourly rate')).toHaveAttribute('readonly')
  })
})
