import { describe, expect, it } from 'vitest'
import {
  editChangesWhatClientSees,
  invoiceContentChanged,
  totalsDiffer,
} from './invoice-sent-change.js'

/**
 * What counts as "the client would see this changed": the note, the lines the
 * client's copy prints (including the covered dates, which are in the label),
 * and the total. The send route asks it of the invoice it built the email from
 * and the one it re-reads just before sending.
 */

const line = (over = {}) => ({ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 400, ...over })
const recurring = (over = {}) => ({
  kind: 'recurring',
  label: 'QuickBooks - Sept 13 - Oct 13',
  detail: 'monthly',
  amount: 90,
  recurringId: 'recur-qbo',
  coverageStart: '2026-09-13',
  coverageEnd: '2026-10-13',
  ...over,
})
const invoice = (over = {}) => ({
  lineItems: [line(), recurring()],
  blurb: 'Thank you.',
  total: 490,
  dueDate: '2026-10-15',
  ...over,
})

describe('totalsDiffer', () => {
  it('compares whole cents', () => {
    expect(totalsDiffer(400, 400)).toBe(false)
    expect(totalsDiffer(400, 400.004)).toBe(false)
    expect(totalsDiffer(400, 400.01)).toBe(true)
    expect(totalsDiffer('400.00', 400)).toBe(false)
    expect(totalsDiffer(undefined, 0)).toBe(false)
  })
})

describe('editChangesWhatClientSees', () => {
  it('counts the note and the lines the client prints', () => {
    expect(editChangesWhatClientSees({ blurb: { before: 'a', after: 'b' } })).toBe(true)
    expect(
      editChangesWhatClientSees({
        lineItems: { before: [line()], after: [line({ amount: 450 })] },
      }),
    ).toBe(true)
  })

  it('counts a covered-dates change, even under a label that does not repeat them', () => {
    expect(
      editChangesWhatClientSees({
        lineItems: {
          before: [recurring({ label: 'QBO (per contract)' })],
          after: [recurring({ label: 'QBO (per contract)', coverageEnd: '2026-10-20' })],
        },
      }),
    ).toBe(true)
  })

  it('does not count what only the app reads, or nothing at all', () => {
    expect(editChangesWhatClientSees(null)).toBe(false)
    expect(editChangesWhatClientSees({})).toBe(false)
    expect(
      editChangesWhatClientSees({
        lineItems: {
          before: [recurring()],
          after: [recurring({ needsCoverageConfirmation: false, coverageReason: null })],
        },
      }),
    ).toBe(false)
    expect(editChangesWhatClientSees({ dueDate: { before: 'a', after: 'b' } })).toBe(false)
  })
})

// The hourly section's rows (main 0a89927): a role row she can fill, a rate she can
// change, and a row left at 0.00 that stays off the client's copy.
describe('editChangesWhatClientSees - the hours rows', () => {
  const hours = (over = {}) => ({
    kind: 'hourly',
    label: 'Bookkeeping',
    detail: '4.00 hours at $75.00/hr',
    hours: 4,
    rate: 75,
    amount: 300,
    roleTier: 'Bookkeeper',
    ...over,
  })
  const change = (before, after) =>
    editChangesWhatClientSees({ lineItems: { before: [before], after: [after] } })

  it('does NOT count stamping or changing rateManual or employeeId alone', () => {
    expect(change(hours(), hours({ rateManual: true }))).toBe(false)
    expect(change(hours({ rateManual: true }), hours())).toBe(false)
    expect(change(hours(), hours({ employeeId: 'emp-lisa' }))).toBe(false)
    expect(change(hours({ employeeId: 'emp-lisa' }), hours({ employeeId: 'emp-ann' }))).toBe(false)
    expect(change(hours(), hours({ rateManual: true, employeeId: 'emp-lisa' }))).toBe(false)
  })

  it('counts hours, rate, amount, label and detail', () => {
    expect(change(hours(), hours({ hours: 5, amount: 375 }))).toBe(true)
    expect(change(hours(), hours({ rate: 80, amount: 320 }))).toBe(true)
    expect(change(hours(), hours({ amount: 310 }))).toBe(true)
    expect(change(hours(), hours({ label: 'Bookkeeping - Lisa' }))).toBe(true)
    expect(change(hours(), hours({ detail: '4.00 hours' }))).toBe(true)
  })

  it("does not count adding or removing a zero-hours row: it is not on the client's copy", () => {
    const empty = hours({ hours: 0, amount: 0, label: 'Accounting', detail: '', roleTier: 'Accountant' })
    expect(
      editChangesWhatClientSees({ lineItems: { before: [hours()], after: [hours(), empty] } }),
    ).toBe(false)
    expect(
      editChangesWhatClientSees({ lineItems: { before: [hours(), empty], after: [hours()] } }),
    ).toBe(false)
    // Changing what is on an empty row without filling it is still nothing.
    expect(change(empty, { ...empty, rate: 90, rateManual: true })).toBe(false)
  })

  it('counts the moment an empty row is filled, and a filled row going back to zero', () => {
    const empty = hours({ hours: 0, amount: 0 })
    expect(change(empty, hours())).toBe(true)
    expect(change(hours(), empty)).toBe(true)
  })

  it("uses the filter the client's copy uses (the same rows disappear from both)", async () => {
    const { clientFacingInvoiceLines } = await import('./invoice-lines.js')
    const empty = hours({ hours: 0, amount: 0 })
    const full = { lineItems: [hours(), empty], period: '2026-09', total: 300 }

    expect(clientFacingInvoiceLines(full, {})).toHaveLength(1)
    expect(change(empty, { ...empty, label: 'Renamed empty row' })).toBe(false)
  })
})

describe('invoiceContentChanged', () => {
  it('is false for the same invoice, whatever else moved on the row', () => {
    expect(invoiceContentChanged(invoice(), invoice())).toBe(false)
    // Session ids, due date and status are not what the email says.
    expect(
      invoiceContentChanged(invoice(), {
        ...invoice({ dueDate: '2026-11-30' }),
        stripeCheckoutSessionId: 'cs_new',
        status: 'sent',
      }),
    ).toBe(false)
  })

  it('is true when the lines, the note, the covered dates or the total moved', () => {
    expect(
      invoiceContentChanged(invoice(), invoice({ lineItems: [line({ label: 'Renamed' }), recurring()] })),
    ).toBe(true)
    expect(invoiceContentChanged(invoice(), invoice({ blurb: 'A different note.' }))).toBe(true)
    expect(
      invoiceContentChanged(
        invoice(),
        invoice({ lineItems: [line(), recurring({ coverageEnd: '2026-10-20' })] }),
      ),
    ).toBe(true)
    // A total that moved with the lines left alone (a card fee appended by the
    // webhook changes both; this is the total on its own).
    expect(invoiceContentChanged(invoice(), invoice({ total: 500 }))).toBe(true)
  })

  it('tolerates a missing side', () => {
    expect(invoiceContentChanged(invoice(), null)).toBe(true)
    expect(invoiceContentChanged(undefined, undefined)).toBe(false)
  })
})
