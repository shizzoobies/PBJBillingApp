import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entrySignature, signatureFields } from '../../lib/payroll-week-approvals.js'
import { PayrollReviewSection } from '../components/PayrollReviewSection'
import {
  DENY_SHARED_TEXT,
  NOTE_REQUIRED_TEXT,
  NOTICE_PREVIEW_LABEL,
  OK_COVERS_TEXT,
  OK_HELP_TEXT,
  OK_KEY_TEXT,
  REVIEW_ACTIONS_TEXT,
  REVIEW_ONLY_TEXT,
  STAFF_REMOVED_NOTE,
  TOTALS_COUNT_TEXT,
} from '../lib/payrollReviewText'
import { DEFAULT_FIRM_SETTINGS, type Employee, type TimeEntry } from '../lib/types'
import type { PayrollWeekRow, PayrollWeekState } from '../lib/api'

/**
 * Payroll review ship 2 (featreq-0b4e42a1): what she can do to one entry, on
 * the page. "Today" is Thursday 2026-11-19, so the page opens on Nov 8 - 14.
 * Clock times are LOCAL wall-clock times; marks are stamped mid-day so the
 * firm's day is the same in any zone a run might use.
 */

vi.mock('../lib/api', () => ({
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
  fetchPayrollWeekRequest: vi.fn(async () => null),
  markPayrollEntryRequest: vi.fn(),
  sendBackPayrollEntryRequest: vi.fn(),
  denyPayrollEntryRequest: vi.fn(),
  undoPayrollDenialRequest: vi.fn(),
}))
// The print header reads the firm's name from the app; nothing else here does.
vi.mock('../AppContext', () => ({
  useAppContext: () => ({ firmSettings: DEFAULT_FIRM_SETTINGS, sessionUser: { id: 'emp-owner', role: 'owner' } }),
}))

import {
  denyPayrollEntryRequest,
  fetchPayrollWeekRequest,
  fetchRateVersions,
  markPayrollEntryRequest,
  sendBackPayrollEntryRequest,
  undoPayrollDenialRequest,
} from '../lib/api'

const at = (day: number, hour: number, minute: number, second = 0) => new Date(2026, 10, day, hour, minute, second).toISOString()
const iso = (day: number) => `2026-11-${String(day).padStart(2, '0')}`
const MARKED_AT = '2026-11-20T17:00:00.000Z'

const employees = [
  { id: 'emp-1', name: 'Lisa Reyes', role: 'Bookkeeper', billRate: 90 },
  { id: 'emp-owner', name: 'Brittany Smith', role: 'Owner', billRate: 150 },
] as unknown as Employee[]
const clients = [
  { id: 'c1', name: 'Acme Dental' },
  { id: 'c2', name: 'Bright Books' },
  { id: 'c3', name: 'Cedar Cafe' },
] as never

function entry(over: Record<string, unknown>) {
  return {
    employeeId: 'emp-1',
    clientId: 'c1',
    isAdministrative: false,
    billable: true,
    taskId: null,
    taskLabel: 'Bookkeeping',
    description: 'Work',
    entryMethod: 'timer',
    approvalStatus: 'approved',
    ...over,
  } as unknown as TimeEntry
}
const BLOCK = [{ startAt: at(11, 9, 0, 7), endAt: at(11, 10, 12, 7) }]
const blockPart = (id: string, clientId: string) =>
  entry({ id, date: iso(11), clientId, minutes: 24, groupId: 'g1', groupAllocation: 'even', startAt: BLOCK[0].startAt, endAt: BLOCK[0].endAt, sessions: BLOCK, description: 'Shared meeting' })

const MANUAL = entry({
  id: 'm1',
  date: iso(10),
  minutes: 72,
  entryMethod: 'manual',
  approvalStatus: 'pending',
  startAt: at(10, 9, 0),
  endAt: at(10, 10, 12),
  sessions: [{ startAt: at(10, 9, 0), endAt: at(10, 10, 12) }],
  description: 'Typed in by hand',
})
const SENT_BACK = entry({ id: 'r1', date: iso(12), minutes: 30, approvalStatus: 'rejected', approvalNote: 'Which client was this?', approvedAt: MARKED_AT, description: 'Call' })
const FIXED = entry({ id: 'f1', date: iso(13), minutes: 45, clientId: 'c2', approvalStatus: 'pending', description: 'Moved to Bright Books' })
const PLAIN = entry({ id: 's1', date: iso(9), minutes: 60, startAt: at(9, 9, 0, 13), endAt: at(9, 10, 0, 13), sessions: [{ startAt: at(9, 9, 0, 13), endAt: at(9, 10, 0, 13) }] })
const timeEntries = [MANUAL, SENT_BACK, FIXED, PLAIN, blockPart('p1', 'c1'), blockPart('p2', 'c2'), blockPart('p3', 'c3')]

function row(over: Partial<PayrollWeekRow> = {}): PayrollWeekRow {
  return { id: 'pwa-1', userId: 'emp-1', weekStart: '2026-11-08', status: 'open', entryMarks: {}, deniedEntries: [], updatedAt: MARKED_AT, ...over }
}
function state(rows: PayrollWeekRow[] = [], invoiced: PayrollWeekState['invoiced'] = []): PayrollWeekState {
  return { weekStart: '2026-11-08', weeks: rows, invoiced, actions: { ok: true, sendBack: true, deny: true, undo: true } }
}
const okMark = (target: TimeEntry, flags: string[] = ['manual']) => ({
  kind: 'ok' as const,
  by: 'emp-owner',
  byName: 'Brittany Smith',
  at: MARKED_AT,
  note: '',
  signature: entrySignature(target),
  flags: flags as never,
})
// What she sent back from this screen: the entry as it was then (on Acme Dental).
const sentBackMark = {
  kind: 'sent_back' as const,
  by: 'emp-owner',
  byName: 'Brittany Smith',
  at: MARKED_AT,
  note: 'Wrong client',
  signature: entrySignature({ ...FIXED, clientId: 'c1' }),
  flags: [],
}

const onEntryChange = vi.fn()
const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 19, 12, 0, 0))
  vi.mocked(fetchRateVersions).mockResolvedValue({ billRateVersions: [], costRateVersions: [{ userId: 'emp-1', effectiveDate: '1970-01-01', rate: 20 }] } as never)
  vi.mocked(fetchPayrollWeekRequest).mockReset()
  vi.mocked(markPayrollEntryRequest).mockReset()
  vi.mocked(sendBackPayrollEntryRequest).mockReset()
  vi.mocked(denyPayrollEntryRequest).mockReset()
  vi.mocked(undoPayrollDenialRequest).mockReset()
  onEntryChange.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

async function renderReview(answer: PayrollWeekState | null, entries: TimeEntry[] = timeEntries) {
  vi.mocked(fetchPayrollWeekRequest).mockResolvedValue(answer)
  const view = render(
    <PayrollReviewSection
      employees={employees}
      inactiveEmployees={[]}
      clients={clients}
      checklists={[]}
      entries={entries}
      submissions={[]}
      today="2026-11-19"
      onEntryChange={onEntryChange}
      ownerName="Brittany Smith"
    />,
  )
  await waitFor(() => expect(fetchPayrollWeekRequest).toHaveBeenCalled())
  const section = screen.getByRole('region', { name: 'Payroll review' })
  if (answer) await within(section).findByText(REVIEW_ACTIONS_TEXT)
  return { view, section }
}
const mainRow = (section: HTMLElement, id: string) =>
  section.querySelector(`tr.payroll-review-entry[data-entry-id="${id}"]`) as HTMLElement
const openMenu = (section: HTMLElement, id: string) =>
  fireEvent.click(within(mainRow(section, id)).getByRole('button', { name: 'Actions' }))
const needsALook = (section: HTMLElement) => text(within(section).getByLabelText('Week totals'))


describe('the read-only fallback', () => {
  it('a server that does not answer the new read gets the ship-1 screen, with no action that would not save', async () => {
    const { section } = await renderReview(null)
    expect(within(section).getByText(REVIEW_ONLY_TEXT)).toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: 'Actions' })).toBeNull()
    expect(within(section).queryByText('Actions')).toBeNull()
    expect(fetchPayrollWeekRequest).toHaveBeenCalledWith('2026-11-08', expect.anything())
  })
})

describe('the words at the top', () => {
  it('says what the tab does, that an OK is not an approval, and that removed time is not counted', async () => {
    const { section } = await renderReview(state())
    expect(REVIEW_ACTIONS_TEXT).toBe(
      'Here you can OK an entry you have looked at, send one back to be fixed, or deny and remove one (it comes off their hours and off client reports and invoices; Undo is under Removed from payroll). Nothing here approves or locks a week. Approve on the Weekly submissions tab or in the Approval queue; approving there does not lock the time.',
    )
    expect(within(section).getByText(OK_KEY_TEXT)).toBeInTheDocument()
    expect(OK_KEY_TEXT).toContain('It does not approve the entry or the week, and it changes no hours.')
    expect(within(section).getByText(OK_COVERS_TEXT)).toBeInTheDocument()
    expect(within(section).getByText(TOTALS_COUNT_TEXT)).toBeInTheDocument()
    expect(TOTALS_COUNT_TEXT).toContain('Entries you removed are not counted.')
  })
})

describe('OK, looked at', () => {
  it('records the entry’s signature, the flags and partners showing, then reads as seen and stops counting', async () => {
    const { section } = await renderReview(state())
    expect(needsALook(section)).toContain('2 flagged entries')
    openMenu(section, 'm1')
    expect(text(screen.getByRole('menuitem', { name: 'OK, looked at' }))).toContain(OK_HELP_TEXT)
    expect(text(screen.getByRole('menuitem', { name: 'Send back to fix' }))).toContain(
      'Lisa fixes it. The time stays as it is until then.',
    )
    expect(text(screen.getByRole('menuitem', { name: 'Deny and remove' }))).toContain(
      "Takes this time off Lisa's hours and off every report and invoice.",
    )
    vi.mocked(markPayrollEntryRequest).mockResolvedValue({ week: row({ entryMarks: { m1: okMark(MANUAL) } }) })
    fireEvent.click(screen.getByRole('menuitem', { name: 'OK, looked at' }))
    await waitFor(() =>
      expect(markPayrollEntryRequest).toHaveBeenCalledWith({
        entryId: 'm1',
        signature: entrySignature(MANUAL),
        flags: ['manual'],
        partners: {},
      }),
    )
    await waitFor(() => expect(text(mainRow(section, 'm1'))).toContain("Manual entry · OK'd by Brittany Nov 20"))
    expect(needsALook(section)).toContain('1 flagged entry')
    fireEvent.click(within(section).getByLabelText('Show only flagged'))
    expect(mainRow(section, 'm1')).toBeNull()
    expect(mainRow(section, 'r1')).not.toBeNull()
  })

  it('un-ticks itself when the entry changed since, says what changed, and can be taken off', async () => {
    const before = { ...MANUAL, minutes: 60 } as TimeEntry
    const stale = { ...okMark(before), fields: signatureFields(before) }
    const { section } = await renderReview(state([row({ entryMarks: { m1: stale } })]))
    const line = text(mainRow(section, 'm1'))
    expect(line).toContain("Changed since you OK'd it on Nov 20 (hours 1.00 to 1.20): look again.")
    expect(line).not.toContain("OK'd by")
    expect(needsALook(section)).toContain('2 flagged entries')
    openMenu(section, 'm1')
    vi.mocked(markPayrollEntryRequest).mockResolvedValue({ week: row() })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove my OK' }))
    await waitFor(() => expect(markPayrollEntryRequest).toHaveBeenCalledWith({ entryId: 'm1', remove: true }))
  })

  it('an OK of an overlap covers the partner it named; a new partner needs a look again', async () => {
    const a = entry({ id: 'o1', date: iso(9), minutes: 60, startAt: at(9, 13, 0, 5), endAt: at(9, 14, 0, 5), sessions: [{ startAt: at(9, 13, 0, 5), endAt: at(9, 14, 0, 5) }] })
    const b = entry({ id: 'o2', date: iso(9), clientId: 'c2', minutes: 30, startAt: at(9, 13, 30, 9), endAt: at(9, 14, 0, 9), sessions: [{ startAt: at(9, 13, 30, 9), endAt: at(9, 14, 0, 9) }] })
    const c = entry({ id: 'o3', date: iso(9), clientId: 'c3', minutes: 20, startAt: at(9, 13, 10, 3), endAt: at(9, 13, 30, 3), sessions: [{ startAt: at(9, 13, 10, 3), endAt: at(9, 13, 30, 3) }] })
    const mark = { ...okMark(a, ['overlap']), partners: { overlap: ['o2'] } }
    const covered = await renderReview(state([row({ entryMarks: { o1: mark } })]), [a, b])
    expect(text(mainRow(covered.section, 'o1'))).toContain("Overlaps another entry · OK'd by Brittany Nov 20")
    covered.view.unmount()
    const { section } = await renderReview(state([row({ entryMarks: { o1: mark } })]), [a, b, c])
    const line = text(mainRow(section, 'o1'))
    expect(line).toContain("A new overlap since you OK'd it.")
    expect(line).not.toContain("OK'd by")
  })

  it('is not offered on an entry with nothing to look at, nor on one waiting on the person', async () => {
    const { section } = await renderReview(state())
    openMenu(section, 's1')
    expect(screen.queryByRole('menuitem', { name: 'OK, looked at' })).toBeNull()
    openMenu(section, 'r1')
    expect(screen.queryByRole('menuitem', { name: 'OK, looked at' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Send back to fix' })).toBeNull()
  })

  it('a read still in flight never puts back what a newer answer replaced', async () => {
    let finishLateRead: (value: PayrollWeekState) => void = () => {}
    const { section, view } = await renderReview(state())
    openMenu(section, 'm1')
    vi.mocked(markPayrollEntryRequest).mockResolvedValue({ week: row({ entryMarks: { m1: okMark(MANUAL) } }) })
    // A re-read starts (the workspace changed) and answers only after the mark.
    vi.mocked(fetchPayrollWeekRequest).mockReturnValueOnce(new Promise((resolve) => (finishLateRead = resolve)))
    view.rerender(
      <PayrollReviewSection
        employees={employees}
        inactiveEmployees={[]}
        clients={clients}
        checklists={[]}
        entries={[...timeEntries]}
        submissions={[]}
        today="2026-11-19"
        onEntryChange={onEntryChange}
        ownerName="Brittany Smith"
      />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'OK, looked at' }))
    await waitFor(() => expect(text(mainRow(section, 'm1'))).toContain("OK'd by Brittany"))
    finishLateRead(state())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(text(mainRow(section, 'm1'))).toContain("OK'd by Brittany")
  })
})

describe('Send back to fix', () => {
  it('asks for a reason the person will read, shows the notice as it will be sent, and sends the signature', async () => {
    const { section } = await renderReview(state())
    openMenu(section, 'm1')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send back to fix' }))
    const sheet = screen.getByRole('group', { name: 'Send back to fix' })
    expect(text(sheet)).toContain(
      'Lisa is told your reason, and the entry shows as waiting on Lisa until it is changed. It still counts toward the week until then.',
    )
    expect(within(sheet).getByText('Reason (Lisa will read this)')).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back' }))
    expect(within(sheet).getByText(NOTE_REQUIRED_TEXT)).toBeInTheDocument()
    expect(sendBackPayrollEntryRequest).not.toHaveBeenCalled()
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Which client?' } })
    expect(text(within(sheet).getByLabelText(NOTICE_PREVIEW_LABEL))).toContain(
      'Brittany sent back your 1.20h entry (Tue Nov 10, Acme Dental, Bookkeeping). Reason: Which client? Edit and resubmit it from the Time page.',
    )
    const updated = { ...MANUAL, approvalStatus: 'rejected', approvalNote: 'Which client?' } as TimeEntry
    vi.mocked(sendBackPayrollEntryRequest).mockResolvedValue({ entry: updated, week: row() })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back' }))
    await waitFor(() =>
      expect(sendBackPayrollEntryRequest).toHaveBeenCalledWith({ entryId: 'm1', signature: entrySignature(MANUAL), note: 'Which client?' }),
    )
    expect(onEntryChange).toHaveBeenCalledWith({ updated })
  })

  it('a sent-back entry says since when and on whom it waits; once changed it reads Changed, look again', async () => {
    const { section } = await renderReview(state([row({ entryMarks: { f1: sentBackMark } })]))
    expect(text(mainRow(section, 'r1'))).toContain('Sent back Nov 20, waiting on Lisa: Which client was this?')
    const changed = text(mainRow(section, 'f1'))
    expect(changed).toContain('Changed, look again')
    expect(changed).toContain('Lisa changed this entry after you sent it back (Nov 20). Please check it. Your note was: Wrong client')
    expect(needsALook(section)).toContain('3 flagged entries')
  })

  it('once approved, a changed entry shows nothing more and stops counting', async () => {
    const approved = { ...FIXED, approvalStatus: 'approved' } as TimeEntry
    const { section } = await renderReview(state([row({ entryMarks: { f1: sentBackMark } })]), timeEntries.map((item) => (item.id === 'f1' ? approved : item)))
    expect(text(mainRow(section, 'f1'))).not.toContain('look again')
    expect(needsALook(section)).toContain('2 flagged entries')
  })

  it('a refusal is said in words on the row', async () => {
    const { section } = await renderReview(state())
    openMenu(section, 'm1')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send back to fix' }))
    const sheet = screen.getByRole('group', { name: 'Send back to fix' })
    const { ApiError } = await import('../lib/types')
    vi.mocked(sendBackPayrollEntryRequest).mockRejectedValue(
      new ApiError(409, 'This entry changed since you opened the week. Reload and look again.'),
    )
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'x' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back' }))
    expect(await within(section).findByText('This entry changed since you opened the week. Reload and look again.')).toBeInTheDocument()
    expect(onEntryChange).not.toHaveBeenCalled()
  })
})

describe('Deny and remove', () => {
  it('a part of a shared block lists every part and what comes off, names the button for the block, and sends every part’s signature', async () => {
    const { section } = await renderReview(state())
    openMenu(section, 'p2')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deny and remove' }))
    const sheet = screen.getByRole('group', { name: 'Deny and remove' })
    expect(within(sheet).getByText(DENY_SHARED_TEXT)).toBeInTheDocument()
    const parts = within(sheet).getAllByRole('listitem').map(text)
    expect(parts).toEqual([
      'Wed Nov 11 · Acme Dental · Bookkeeping · 0.40h',
      'Wed Nov 11 · Bright Books · Bookkeeping · 0.40h',
      'Wed Nov 11 · Cedar Cafe · Bookkeeping · 0.40h',
    ])
    await waitFor(() =>
      expect(text(sheet)).toContain(
        "This takes 1.20h, $24.00 at cost, $108.00 billable off Lisa's time. The entry is deleted, so it also drops off client reports and invoices. A copy is kept. Lisa is told your reason and that their hours are lower by that much. To put it back, press Undo under \"Removed from payroll\" below Lisa's name.",
      ),
    )
    expect(text(sheet)).not.toContain('until the week is approved')
    expect(within(sheet).getByText('Reason (Lisa will read this)')).toBeInTheDocument()
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Logged twice.' } })
    expect(text(within(sheet).getByLabelText(NOTICE_PREVIEW_LABEL))).toContain(
      'Brittany removed a 1.20h block from your time (Wed Nov 11; Acme Dental, Bright Books, Cedar Cafe; Bookkeeping). Reason: Logged twice. Your hours for that week are lower by 1.20h. You do not need to do anything. If you think this is a mistake, talk to Brittany.',
    )
    vi.mocked(denyPayrollEntryRequest).mockResolvedValue({
      removedIds: ['p1', 'p2', 'p3'],
      denial: { id: 'deny-1', deniedBy: 'emp-owner', deniedByName: 'Brittany Smith', deniedAt: MARKED_AT, note: 'Logged twice.', hours: 1.2, parts: [] },
      week: row(),
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove the whole block (3 parts)' }))
    await waitFor(() =>
      expect(denyPayrollEntryRequest).toHaveBeenCalledWith({
        entryId: 'p2',
        signatures: {
          p1: entrySignature(blockPart('p1', 'c1')),
          p2: entrySignature(blockPart('p2', 'c2')),
          p3: entrySignature(blockPart('p3', 'c3')),
        },
        note: 'Logged twice.',
      }),
    )
    expect(onEntryChange).toHaveBeenCalledWith({ removedIds: ['p1', 'p2', 'p3'] })
    expect(await within(section).findByRole('status')).toHaveTextContent(
      "Removed 1.20h from Lisa's week. Undo is under Removed from payroll below.",
    )
  })

  /** Renders the review with these clients and invoice facts, and opens Deny on one entry: its invoice warnings. */
  async function denyWarnings(
    clientList: Array<{ id: string; name: string; billingMode?: string }>,
    invoiced: PayrollWeekState['invoiced'],
    entryId: string,
    entries: TimeEntry[] = timeEntries,
  ) {
    vi.mocked(fetchPayrollWeekRequest).mockResolvedValue(state([], invoiced))
    const view = render(
      <PayrollReviewSection
        employees={employees}
        inactiveEmployees={[]}
        clients={clientList as never}
        checklists={[]}
        entries={entries}
        submissions={[]}
        today="2026-11-19"
        onEntryChange={onEntryChange}
        ownerName="Brittany Smith"
      />,
    )
    const section = screen.getByRole('region', { name: 'Payroll review' })
    await within(section).findByText(REVIEW_ACTIONS_TEXT)
    openMenu(section, entryId)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deny and remove' }))
    const sheet = screen.getByRole('group', { name: 'Deny and remove' })
    const warnings = [...sheet.querySelectorAll('[data-warning="invoice"]')].map(text)
    view.unmount()
    return warnings
  }
  const hourly = [
    { id: 'c1', name: 'Acme Dental', billingMode: 'hourly' },
    { id: 'c2', name: 'Bright Books', billingMode: 'hourly' },
    { id: 'c3', name: 'Cedar Cafe', billingMode: 'hourly' },
    { id: 'm-master', name: 'Kline Group', billingMode: 'hourly' },
  ]

  it('warns when hourly time is already on an invoice: not sent, sent, and a sub billed on its master’s invoice', async () => {
    const warnings = await denyWarnings(
      hourly,
      [
        { clientId: 'c1', invoiceClientId: 'c1', period: '2026-11', status: 'draft', sent: false },
        { clientId: 'c2', invoiceClientId: 'c2', period: '2026-11', status: 'sent', sent: true },
        { clientId: 'c3', invoiceClientId: 'm-master', period: '2026-11', status: 'paid', sent: true },
        { clientId: 'c3', invoiceClientId: 'c3', period: '2026-10', status: 'sent', sent: true },
      ],
      'p1',
    )
    expect(warnings).toEqual([
      "This time is on Acme Dental's November invoice, which has not been sent. It will drop off when that invoice is generated again.",
      "This time is on Bright Books's November invoice, which has been SENT. That invoice will not change. If the client should not be billed for it, fix the invoice separately.",
      "This time is on Kline Group's November invoice, which has been SENT. That invoice will not change. If the client should not be billed for it, fix the invoice separately.",
    ])
  })

  it('a month pushed to the next is warned about as the invoice that carries it; not yet generated, nothing', async () => {
    const carried = await denyWarnings(
      hourly,
      [{ clientId: 'c1', invoiceClientId: 'c1', period: '2026-11', carriedTo: '2026-12', status: 'sent', sent: true }],
      'm1',
    )
    expect(carried).toEqual([
      "This time is on Acme Dental's December invoice (carried from November), which has been SENT. That invoice will not change. If the client should not be billed for it, fix the invoice separately.",
    ])
    // The server reports nothing for a pushed month whose carrying invoice does not exist yet.
    expect(await denyWarnings(hourly, [], 'm1')).toEqual([])
  })

  it('no warning for a plan client’s ordinary time, nor for non-billable time; ad hoc work on a plan client is warned', async () => {
    const onInvoice = [{ clientId: 'c1', invoiceClientId: 'c1', period: '2026-11', status: 'sent', sent: true }]
    const plan = [{ id: 'c1', name: 'Acme Dental', billingMode: 'subscription' }, ...hourly.slice(1)]
    expect(await denyWarnings(plan, onInvoice, 'm1')).toEqual([])
    const annual = [{ id: 'c1', name: 'Acme Dental', billingMode: 'annual' }, ...hourly.slice(1)]
    expect(await denyWarnings(annual, onInvoice, 'm1')).toEqual([])
    const unbilled = timeEntries.map((item) => (item.id === 'm1' ? ({ ...item, billable: false } as TimeEntry) : item))
    expect(await denyWarnings(hourly, onInvoice, 'm1', unbilled)).toEqual([])
    const adhoc = timeEntries.map((item) => (item.id === 'm1' ? ({ ...item, isAdhoc: true } as TimeEntry) : item))
    expect(await denyWarnings(plan, onInvoice, 'm1', adhoc)).toHaveLength(1)
  })

  it('a part dated in another week says so in the confirm and in the removed hours line', async () => {
    const moved = { ...blockPart('p3', 'c3'), date: iso(15) } as TimeEntry
    const entries = timeEntries.map((item) => (item.id === 'p3' ? moved : item))
    const { section } = await renderReview(state(), entries)
    openMenu(section, 'p1')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deny and remove' }))
    const sheet = screen.getByRole('group', { name: 'Deny and remove' })
    expect(within(sheet).getAllByRole('listitem').map(text)).toContain(
      'Sun Nov 15 · Cedar Cafe · Bookkeeping · 0.40h (dated Nov 15, another week)',
    )
  })

  it('Removed from payroll lists what she denied, says the hours by the totals, and Undo asks first', async () => {
    const part = (id: string, date: string) => ({
      id, employeeId: 'emp-1', date, clientId: 'c1', isAdministrative: false, taskId: null, taskLabel: 'Bookkeeping', description: 'Same as m1', minutes: 72, billable: true,
    })
    const denied = {
      id: 'deny-1',
      deniedBy: 'emp-owner',
      deniedByName: 'Brittany Smith',
      deniedAt: MARKED_AT,
      note: 'Logged twice',
      hours: 2.4,
      parts: [part('d1', iso(10)), { ...part('d2', iso(15)), groupId: 'gx' }],
    }
    const { section } = await renderReview(state([row({ deniedEntries: [denied] })]))
    const person = section.querySelector('[data-person-id="emp-1"]') as HTMLElement
    expect(text(person)).toContain(
      '1.20h removed this week (plus 1.20h dated in another week; see Removed from payroll below). It is not in the totals.',
    )
    const removed = within(person).getByLabelText('Removed from payroll: Lisa Reyes')
    expect(text(removed)).toContain(STAFF_REMOVED_NOTE)
    expect(text(removed)).toContain('Tue Nov 10 · Acme Dental · Bookkeeping · Same as m1 · 1.20h')
    expect(text(removed)).toContain('Sun Nov 15 · Acme Dental · Bookkeeping · Same as m1 · 1.20h (dated Nov 15, another week)')
    expect(text(removed)).toContain('Removed by Brittany Nov 20: Logged twice')
    fireEvent.click(within(removed).getByRole('button', { name: 'Undo' }))
    expect(undoPayrollDenialRequest).not.toHaveBeenCalled()
    expect(within(removed).getByText('Put this back and tell Lisa?')).toBeInTheDocument()
    const restored = { ...MANUAL, id: 'd1' } as TimeEntry
    vi.mocked(undoPayrollDenialRequest).mockResolvedValue({ restored: [restored], week: row() })
    fireEvent.click(within(removed).getByRole('button', { name: 'Put back' }))
    await waitFor(() =>
      expect(undoPayrollDenialRequest).toHaveBeenCalledWith({ userId: 'emp-1', weekStart: '2026-11-08', denialId: 'deny-1' }),
    )
    expect(onEntryChange).toHaveBeenCalledWith({ restored: [restored] })
    await waitFor(() => expect(within(section).queryByLabelText('Removed from payroll: Lisa Reyes')).toBeNull())
  })

  it('a person whose every entry this week was removed still shows, with their Removed list and Undo', async () => {
    const denied = {
      id: 'deny-9',
      deniedBy: 'emp-owner',
      deniedByName: 'Brittany Smith',
      deniedAt: MARKED_AT,
      note: 'Not worked',
      hours: 1,
      parts: [{ id: 'z1', employeeId: 'emp-1', date: iso(10), clientId: 'c1', isAdministrative: false, taskId: null, description: 'x', minutes: 60, billable: true }],
    }
    const { section } = await renderReview(state([row({ deniedEntries: [denied] })]), [])
    const person = section.querySelector('[data-person-id="emp-1"]') as HTMLElement
    expect(person).not.toBeNull()
    expect(text(person)).toContain('No time logged this week.')
    expect(within(person).getByLabelText('Removed from payroll: Lisa Reyes')).toBeInTheDocument()
    expect(within(person).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(within(section).queryByText('No time logged this week.', { selector: '.payroll-review-empty' })).toBeNull()
  })
})
