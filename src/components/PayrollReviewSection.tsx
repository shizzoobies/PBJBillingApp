import { ChevronLeft, ChevronRight, Printer } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { dateOnlyInZone, firmToday } from '../../lib/firm-time.js'
import {
  FLAG_LABELS,
  LONG_DAY_HOURS,
  LONG_ENTRY_HOURS,
  addDaysIso,
  dayFlags,
  entryFlags,
  findLoggedTwice,
  findOverlaps,
  lastCompletedWeekStart,
  payPeriodOf,
} from '../../lib/payroll-week-checks.js'
import {
  applyEntryMarks,
  deniedMessage,
  entrySignature,
  instantDayText,
  payrollHoursOf,
  sentBackMessage,
  type InvoicedFact,
  type MarkPartners,
  type MarkedFlag,
  type TickableFlagKind,
} from '../../lib/payroll-week-approvals.js'
import {
  ApiError,
} from '../lib/types'
import {
  denyPayrollEntryRequest,
  fetchPayrollWeekRequest,
  markPayrollEntryRequest,
  sendBackPayrollEntryRequest,
  undoPayrollDenialRequest,
  type PayrollDenial,
  type PayrollWeekRow,
  type PayrollWeekState,
} from '../lib/api'
import { PrintHeader } from './PrintHeader'
import { displayHours, duplicateFullSliceIds, sumDisplayHours, sumPersonCosts } from '../lib/payrollAggregation'
import {
  HOW_LOGGED_LABEL,
  buildSplitBlocks,
  clockMismatchNote,
  clockMismatchShortNote,
  clockSpansOf,
  entryFigures,
  howLogged,
  splitNote,
  stretchRows,
} from '../lib/payrollClock'
import {
  buildPayrollDayGroups,
  makePayrollPricing,
  payrollJobOf,
  payrollPersonFigures,
  payrollTaskOf,
  rowAmountCells,
  rowCostCells,
  useRateVersions,
  type PayrollDayGroup,
  type PayrollEntryRow,
  type PayrollPricing,
  type RateReadStatus,
} from '../lib/payrollRows'
import type { Checklist, Client, Employee, TimeEntry, WeeklySubmission } from '../lib/types'
import { currency, shortDate } from '../lib/utils'
import {
  DASH_MEANS_TEXT,
  CHANGED_KEY_TEXT,
  DENY_BUTTON_LABEL,
  DENY_LABEL,
  DENY_SHARED_TEXT,
  NOTE_REQUIRED_TEXT,
  NOTICE_PREVIEW_LABEL,
  OK_ACTION_LABEL,
  OK_COVERS_TEXT,
  OK_HELP_TEXT,
  OK_KEY_TEXT,
  OWNERS_LEFT_OUT_TEXT,
  PAYCHECK_COUNTS_TEXT,
  PAYCHECK_FOOT_TEXT,
  RATES_FAILED_TEXT,
  RATES_LOADING_TEXT,
  REMOVED_HEADING,
  REVIEW_ACTIONS_TEXT,
  REVIEW_ONLY_TEXT,
  SEND_BACK_LABEL,
  STAFF_REMOVED_NOTE,
  TOTALS_COUNT_TEXT,
  UNDO_CONFIRM_LABEL,
  UNDO_LABEL,
  UNDO_OK_LABEL,
  denyBlockButtonLabel,
  denyConfirmText,
  denyHelpText,
  deniedStatusText,
  invoiceWarningText,
  otherWeekText,
  reasonLabel,
  removedByText,
  removedHoursText,
  sendBackConfirmText,
  sendBackHelpText,
  undoConfirmText,
} from '../lib/payrollReviewText'

/**
 * PAYROLL REVIEW (featreq-20b13da0 ship 1, featreq-0b4e42a1 ship 2): the week
 * as Brittany reads it in her spreadsheet. "Normally I download the excel sort
 * by week Sunday-Saturday. Sort by employee and then review the length of time
 * they worked and their description."
 *
 * SHIP 2: on each entry she can tick "OK, looked at", send it back to fix, or
 * deny and remove it (with Undo), all through GET/POST /api/payroll-weeks*.
 * When that read does not answer (an older server during a deploy hand-over)
 * the screen is ship 1's read-only screen, with no button that would not save.
 * Approve week with a real lock is ship 3. Every figure comes from the
 * payroll Hours report's own functions (src/lib/payrollRows.ts), so the two can
 * never put two numbers on one week, and every flag from
 * lib/payroll-week-checks.js, which the server will run too.
 *
 * Owner only: the Time Approvals page renders it only for an owner who is not
 * previewing someone else, and only then does it read the rate history.
 *
 * Totals never look complete when they are not: a person with hours and no
 * rate on file is NAMED beside a total that leaves them out, hours on a day
 * before a person's first cost rate are counted beside the week's cost, and
 * "rates not read yet" or "could not be read" is said in words instead of
 * dashes that would read as "no rate on file".
 */

const EVERYONE = 'everyone'

const fmtDay = (iso: string) => shortDate.format(new Date(`${iso}T12:00:00`))
const weekdayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
/** "Tue Nov 10". */
const fmtDayLong = (iso: string) => `${weekdayFormat.format(new Date(`${iso}T12:00:00`))} ${fmtDay(iso)}`
const yearOf = (iso: string) => iso.slice(0, 4)
/** A clock time in the browser's zone, the same zone every other clock time on the page is shown in. */
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const fmtTime = (iso?: string) => {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date)
}
const fmtSpan = (startAt?: string, endAt?: string) =>
  startAt && endAt ? `${fmtTime(startAt)} – ${fmtTime(endAt)}` : ''
const hoursText = (hours: number) => `${(hours === 0 ? 0 : hours).toFixed(2)}h`
/** A day or week line's hours: "8.17 h". */
const hoursLine = (hours: number) => `${(hours === 0 ? 0 : hours).toFixed(2)} h`
const money = (amount: number | null) => (amount === null ? '—' : currency.format(amount))
/** A total of cent figures, or null ("—") when none of them is a figure at all: no rate on file is not $0.00. */
const moneyTotal = (amounts: readonly (number | null)[]) =>
  amounts.some((amount) => typeof amount === 'number') ? sumPersonCosts(amounts) : null
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const flaggedText = (n: number) => (n === 1 ? '1 flagged entry' : `${n} flagged entries`)
const listOf = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
/** The flags that NEED A LOOK (counted, kept by Show only flagged); one she OK'd ("seen") is not. */
const lookOf = (flags: readonly MarkedFlag[]) => flags.filter((flag) => flag.tier === 'look')
const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] || name

/** What the row can do once the server keeps it (ship 2); absent on the read-only screen. */
type RowActions = {
  tickable: TickableFlagKind[]
  ok: 'current' | 'changed' | null
  sentBack: boolean
  open: 'menu' | 'send_back' | 'deny' | null
  busy: boolean
  error: string
  setOpen: (open: 'menu' | 'send_back' | 'deny' | null) => void
  onOk: () => void
  onRemoveOk: () => void
  onSendBack: (note: string) => void
  onDeny: (note: string) => void
  /** Every entry a deny would remove (the whole shared block for a part), in words. */
  denyParts: string[]
  /** The invoice warnings for those entries (review A), in words. */
  denyWarnings: string[]
  denyTaken: string
  personFirst: string
  /** The notice the person will get, as it will be sent, for the note typed so far. */
  noticeFor: (kind: 'send_back' | 'deny', note: string) => string
}

/** One person's week, built from the report's own rows and money cells. */
type PersonWeek = {
  employee: Employee
  entries: TimeEntry[]
  days: Array<PayrollDayGroup & { cost: number | null; billable: number | null; flags: MarkedFlag[] }>
  costOf: (rowId: string) => number | null
  amountOf: (rowId: string) => number | null
  hours: number
  /** Billable hours (the report's figure), for "who is left out of Billable $". */
  billableHours: number
  /**
   * null ("—") when there is no rate on file at all, AND when every hour of the
   * week falls on days before the person's first rate: then the figure would
   * be $0.00 beside day lines that all read "—", so it reads "—" with the note.
   */
  cost: number | null
  billable: number | null
  /** Hours priced at no cost rate (a day before the person's first rate) while the week has a cost figure. */
  uncostedHours: number
  /** Billable hours with no bill rate while the week has a billable figure. */
  unbilledHours: number
  flaggedEntries: number
  longDays: number
}

function buildPersonWeek(
  employee: Employee,
  entries: TimeEntry[],
  deps: {
    employees: Employee[]
    jobOf: (entry: TimeEntry) => string
    taskOf: (entry: TimeEntry) => string
    splitBlocks: ReturnType<typeof buildSplitBlocks>
    pricing: PayrollPricing
    flagsOf: (entryId: string) => MarkedFlag[]
  },
): PersonWeek {
  const groups = buildPayrollDayGroups(entries, deps)
  const rows = groups.flatMap((group) => group.rows)
  const costCells = rowCostCells(rows, deps.pricing)
  const amountCells = rowAmountCells(rows, deps.pricing)
  const costOf = (rowId: string) => costCells.get(rowId) ?? null
  const amountOf = (rowId: string) => amountCells.get(rowId) ?? null
  const weekCost = deps.pricing.periodCostOf(employee.id, entries)
  const weekBillable = deps.pricing.periodBillableOf(employee.id, entries)
  const days = groups.map((group) => ({
    ...group,
    cost: weekCost === null ? null : moneyTotal(group.rows.map((row) => (row.countedElsewhere ? null : costOf(row.id)))),
    billable: weekBillable === null ? null : moneyTotal(group.rows.map((row) => (row.billable ? amountOf(row.id) : null))),
    flags: dayFlags(group.hours),
  }))
  const figures = payrollPersonFigures(entries)
  const uncostedHours =
    weekCost === null
      ? 0
      : sumDisplayHours(rows.filter((row) => !row.countedElsewhere && costOf(row.id) === null).map((row) => displayHours(row.minutes)))
  const unbilledHours =
    weekBillable === null
      ? 0
      : sumDisplayHours(rows.filter((row) => row.billable && amountOf(row.id) === null).map((row) => displayHours(row.minutes)))
  return {
    employee,
    entries,
    days,
    costOf,
    amountOf,
    hours: figures.hours,
    billableHours: figures.billableHours,
    cost: allUnpriced(weekCost, uncostedHours, figures.hours) ? null : weekCost,
    billable: allUnpriced(weekBillable, unbilledHours, figures.billableHours) ? null : weekBillable,
    uncostedHours,
    unbilledHours,
    flaggedEntries: entries.filter((entry) => lookOf(deps.flagsOf(entry.id)).length > 0).length,
    longDays: days.filter((day) => day.flags.length > 0).length,
  }
}

/** A shared block's own clock span, and whether every part still holds the same stretches. */
type BlockSpan = { agree: boolean; firstStart?: string; lastStop?: string }

/**
 * Read off EVERY entry, like `buildSplitBlocks`. A block "agrees" only when it
 * is a known block and all its parts carry identical stretches; only then is
 * one span the block's span.
 */
function buildBlockSpans(entries: TimeEntry[], blocks: ReturnType<typeof buildSplitBlocks>) {
  const parts = new Map<string, TimeEntry[]>()
  for (const entry of entries) {
    if (entry.groupId) parts.set(entry.groupId, [...(parts.get(entry.groupId) ?? []), entry])
  }
  const spans = new Map<string, BlockSpan>()
  for (const [groupId, list] of parts) {
    const clocks = list.map((entry) => clockSpansOf(entry))
    const key = (clock: ReturnType<typeof clockSpansOf>) =>
      clock.spans.map((span) => `${Date.parse(span.startAt)}-${Date.parse(span.endAt)}`).join('|')
    const agree = blocks.has(groupId) && clocks[0].spans.length > 0 && clocks.every((clock) => key(clock) === key(clocks[0]))
    spans.set(groupId, { agree, firstStart: clocks[0].firstStart, lastStop: clocks[0].lastStop })
  }
  return spans
}

/** One person's own note: the hours that fall on days with no rate. */
function unpricedNote(hours: number, kind: 'cost' | 'bill') {
  return hours > 0 ? [`${hoursText(hours)} with no ${kind} rate on that day`] : []
}

/** True when a person HAS a rate on file but none of the hours fall on a day it covers: the figure is not $0.00, it is unknown. */
function allUnpriced(amount: number | null, unpricedHours: number, hours: number) {
  return amount !== null && hours > 0 && unpricedHours >= hours
}

/** The report's people order: most time first, then by name. */
function byReportOrder(people: Employee[], entries: TimeEntry[]) {
  const minutes = new Map(
    people.map((person) => [
      person.id,
      payrollPersonFigures(entries.filter((entry) => entry.employeeId === person.id)).minutes,
    ]),
  )
  return [...people].sort(
    (a, b) => (minutes.get(b.id) ?? 0) - (minutes.get(a.id) ?? 0) || a.name.localeCompare(b.name),
  )
}

/**
 * A money figure in words, honest about what it leaves out:
 *  - rates not read: '' (the page says why in a line of its own);
 *  - no rate on file: "—";
 *  - otherwise the figure, and "(leaves out ...)" when part of the time is not in it.
 */
function moneyPhrase(status: RateReadStatus, amount: number | null, leftOut: string[]) {
  if (status !== 'ready') return ''
  if (amount === null) return leftOut.length > 0 ? `— (leaves out ${listOf(leftOut)})` : '—'
  return leftOut.length > 0 ? `${currency.format(amount)} (leaves out ${listOf(leftOut)})` : currency.format(amount)
}

/**
 * What a total over several people leaves out: each person with hours and no
 * rate on file, and hours with no rate on their day. `hours` is the hours the
 * figure is ABOUT: all hours for cost, BILLABLE hours for Billable $, so a
 * person with no bill rate who logged only non-billable time is left out of
 * nothing.
 */
function leftOutOf(
  people: Array<{ name: string; hours: number; amount: number | null; unpriced: number }>,
  kind: 'cost' | 'bill',
) {
  // With no figure at all ("—"), naming who has no rate adds nothing; hours on
  // days before a first rate are still named, so the dash is not read as "no rate".
  const total = moneyTotal(people.map((person) => person.amount))
  const none =
    total === null
      ? []
      : people
          .filter((person) => person.amount === null && person.unpriced === 0 && person.hours > 0)
          .map((person) => person.name)
  const parts = none.length > 0 ? [`${listOf(none)}: no ${kind} rate on file`] : []
  for (const person of people) {
    if (person.unpriced > 0) {
      parts.push(`${hoursText(person.unpriced)} of ${person.name}'s time with no ${kind} rate on that day`)
    }
  }
  return parts
}

export function PayrollReviewSection({
  employees,
  inactiveEmployees,
  clients,
  checklists,
  entries,
  submissions,
  today = firmToday(),
  onEntryChange,
  ownerName = '',
}: {
  employees: Employee[]
  inactiveEmployees: Employee[]
  clients: Client[]
  checklists: Checklist[]
  entries: TimeEntry[]
  submissions: WeeklySubmission[]
  /** The firm's day (yyyy-mm-dd); the page opens on the last week that has ended. */
  today?: string
  /** Brings this tab's copy in line after a send-back, deny or Undo the server saved. */
  onEntryChange?: (change: { updated?: TimeEntry; removedIds?: string[]; restored?: TimeEntry[] }) => void
  /** The signed-in owner's name, for the notice preview ("Brittany removed ..."). */
  ownerName?: string
}) {
  const [weekStart, setWeekStart] = useState(() => lastCompletedWeekStart(today))
  const [person, setPerson] = useState<string>(EVERYONE)
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [showPaycheck, setShowPaycheck] = useState(false)
  const { billRateVersions, costRateVersions, status } = useRateVersions(true)
  // Ship 2: her marks and denied entries for the week, from the server. NULL
  // (an older server, or not answered yet) = the read-only screen.
  const [serverWeek, setServerWeek] = useState<PayrollWeekState | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [openRow, setOpenRow] = useState<{ entryId: string; open: 'menu' | 'send_back' | 'deny' } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)
  const [statusLine, setStatusLine] = useState('')
  // Bumped by every read AND every answer a mark, send-back, deny or Undo
  // brings: a read still in flight when a newer answer landed is dropped, so
  // it can never put back what the screen showed before.
  const answerSeq = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    const mine = ++answerSeq.current
    fetchPayrollWeekRequest(weekStart, controller.signal)
      .then((state) => {
        if (live && mine === answerSeq.current) setServerWeek(state ?? null)
      })
      .catch(() => {
        if (live && mine === answerSeq.current) setServerWeek(null)
      })
    return () => {
      live = false
      controller.abort()
    }
    // `entries` too: a deny, an Undo or an edit elsewhere re-reads the workspace,
    // and the marks must be read again against it.
  }, [weekStart, reloadKey, entries])

  const weekEnd = addDaysIso(weekStart, 6)
  const period = payPeriodOf(weekStart)
  const roster = useMemo(() => [...employees, ...inactiveEmployees], [employees, inactiveEmployees])
  const rosterIds = useMemo(() => new Set(roster.map((member) => member.id)), [roster])
  const isOwner = (member: Employee) => member.role === 'Owner'

  const pricing = useMemo(
    () => makePayrollPricing({ billRateVersions, costRateVersions, clients, employees: roster }),
    [billRateVersions, costRateVersions, clients, roster],
  )
  const jobOf = useMemo(() => payrollJobOf(clients, 'Administrative'), [clients])
  const taskOf = useMemo(() => payrollTaskOf(checklists), [checklists])
  // Read off EVERY entry: a part moved to another day or week is still a part.
  const splitBlocks = useMemo(() => buildSplitBlocks(entries), [entries])
  const blockSpans = useMemo(() => buildBlockSpans(entries, splitBlocks), [entries, splitBlocks])

  const within = (from: string, to: string) =>
    entries.filter(
      (entry) =>
        typeof entry.date === 'string' && entry.date >= from && entry.date <= to && rosterIds.has(entry.employeeId),
    )
  const weekEntries = within(weekStart, weekEnd)
  const removedUserIds =
    serverWeek && serverWeek.weekStart === weekStart
      ? serverWeek.weeks.filter((row) => row.deniedEntries.length > 0).map((row) => row.userId)
      : []

  /**
   * Who is shown. "Everyone" is the team without the owners (their own time
   * is picked by name), current members always and former ones only while
   * they have time in the window, so a person removed mid-period is still paid.
   */
  const peopleFor = (windowEntries: TimeEntry[]) => {
    if (person !== EVERYONE) {
      const one = roster.find((member) => member.id === person)
      return one ? [one] : []
    }
    // A person whose time this week was all removed still has a Removed from
    // payroll list (with Undo), so they stay in the list too.
    const withTime = new Set([...windowEntries.map((entry) => entry.employeeId), ...removedUserIds])
    const staff = [
      ...employees.filter((member) => !isOwner(member)),
      ...inactiveEmployees.filter((member) => !isOwner(member) && withTime.has(member.id)),
    ]
    return byReportOrder(staff, windowEntries)
  }
  const people = peopleFor(weekEntries)
  const shownIds = new Set(people.map((member) => member.id))
  const shownEntries = weekEntries.filter((entry) => shownIds.has(entry.employeeId))
  // Overlaps and duplicates are also looked for against the same people's
  // entries on the day before and the day after the week (a Saturday entry
  // that runs past midnight against Sunday's); those are never shown as rows.
  const neighbors = [...within(addDaysIso(weekStart, -1), addDaysIso(weekStart, -1)), ...within(addDaysIso(weekEnd, 1), addDaysIso(weekEnd, 1))].filter(
    (entry) => shownIds.has(entry.employeeId),
  )

  const flags = entryFlags(shownEntries, {
    factsOf: (entry) => {
      const clock = clockSpansOf(entry)
      return {
        logged: howLogged(entry, clock),
        mismatchNote: clockMismatchNote(entry, splitBlocks, clock),
        typedHours: clockMismatchShortNote(entry, splitBlocks, clock) !== '',
      }
    },
    nameOf: (entry) => {
      if (!entry.id) return 'another entry'
      const outside = entry.date < weekStart || entry.date > weekEnd
      return outside ? `${jobOf(entry)} on ${fmtDayLong(entry.date)}` : jobOf(entry)
    },
    formatTime: fmtTime,
    others: [...shownEntries, ...neighbors],
  })

  // Ship 2: only when the server answered for THIS week does the screen act
  // (and only then are her marks read into the flags).
  const live = serverWeek && serverWeek.weekStart === weekStart && serverWeek.actions?.deny ? serverWeek : null
  const rowOf = (userId: string): PayrollWeekRow | undefined => live?.weeks.find((row) => row.userId === userId)
  const nameOfPerson = (userId: string) => roster.find((member) => member.id === userId)?.name ?? ''
  const clientNameOf = (clientId: string) => clients.find((client) => client.id === clientId)?.name ?? ''
  // WHICH other entries an overlap or a possible duplicate names right now,
  // read the way entryFlags reads them (a pair called a duplicate is not also
  // an overlap), so an OK covers those partners and no others.
  const pool = [...shownEntries, ...neighbors]
  const overlapHits: Map<string, Array<{ otherId: string }>> = live ? findOverlaps(pool) : new Map()
  const twiceHits: Map<string, Array<{ otherId: string }>> = live ? findLoggedTwice(pool) : new Map()
  const partnersOf = (entryId: string): MarkPartners => {
    const doubled = [...new Set((twiceHits.get(entryId) ?? []).map((hit) => hit.otherId))]
    const overlap = [
      ...new Set((overlapHits.get(entryId) ?? []).map((hit) => hit.otherId).filter((id) => !doubled.includes(id))),
    ]
    return {
      ...(overlap.length > 0 ? { overlap: overlap.sort() } : {}),
      ...(doubled.length > 0 ? { possible_duplicate: doubled.sort() } : {}),
    }
  }
  const marked = new Map<string, ReturnType<typeof applyEntryMarks>>()
  for (const entry of shownEntries) {
    const base = flags.get(entry.id) ?? []
    marked.set(
      entry.id,
      live
        ? applyEntryMarks(base, {
            entry,
            mark: rowOf(entry.employeeId)?.entryMarks[entry.id] ?? null,
            personName: nameOfPerson(entry.employeeId),
            partners: partnersOf(entry.id),
            clientName: clientNameOf,
            personNameOf: nameOfPerson,
          })
        : { flags: base, ok: null, tickable: [] },
    )
  }
  const flagsOf = (entryId: string): MarkedFlag[] => marked.get(entryId)?.flags ?? []

  /** Put one week row the server answered in place of the one held. */
  const takeRow = (row: PayrollWeekRow | null | undefined) => {
    if (!row) return
    answerSeq.current += 1
    setServerWeek((current) =>
      current && current.weekStart === row.weekStart
        ? { ...current, weeks: [...current.weeks.filter((item) => item.userId !== row.userId), row] }
        : current,
    )
  }
  const failed = (entryId: string, error: unknown) => {
    const message =
      error instanceof ApiError || error instanceof Error ? error.message : 'That did not save. Reload and try again.'
    setRowError({ id: entryId, message })
    // A 409 means the screen was looking at something else: read again.
    if (error instanceof ApiError && (error.status === 409 || error.status === 404)) setReloadKey((key) => key + 1)
  }
  const run = async (entryId: string, work: () => Promise<void>) => {
    setBusyId(entryId)
    setRowError(null)
    try {
      await work()
      setOpenRow(null)
    } catch (error) {
      failed(entryId, error)
    } finally {
      setBusyId(null)
    }
  }
  const blockOf = (entry: TimeEntry) =>
    entry.groupId ? entries.filter((item) => item.groupId === entry.groupId) : [entry]
  const inWeek = (date: string) => date >= weekStart && date <= weekEnd
  const partWords = (part: TimeEntry) =>
    `${fmtDayLong(part.date)} · ${jobOf(part)} · ${taskOf(part)} · ${hoursText(displayHours(Number(part.minutes) || 0))}` +
    (inWeek(part.date) ? '' : ` (${otherWeekText(fmtDay(part.date))})`)
  /** "1.20h, $27.00 at cost, $120.00 billable": hours, then the money while rates are read (a dash for no rate). */
  const takenWords = (parts: TimeEntry[]) => {
    const hours = hoursText(payrollHoursOf(parts))
    if (status !== 'ready' || !parts[0]) return hours
    const userId = parts[0].employeeId
    const cost = pricing.periodCostOf(userId, parts)
    const billable = parts.some((part) => part.billable) ? `${money(pricing.periodBillableOf(userId, parts))} billable` : 'not billable'
    return `${hours}, ${money(cost)} at cost, ${billable}`
  }
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
  /** The invoice warnings for these parts: one per invoice that already bills one of them (read only). */
  const warningsFor = (parts: TimeEntry[]) => {
    const facts: InvoicedFact[] = live?.invoiced ?? []
    const seen = new Set<string>()
    const out: string[] = []
    for (const part of parts) {
      if (part.isAdministrative || !part.clientId || typeof part.date !== 'string') continue
      // Only time that is ON the invoice as hours: billable, and either the
      // client bills by the hour or the entry is ad hoc work on a plan client.
      // A plan client's ordinary time is covered by the plan's fee, not billed.
      if (!part.billable) continue
      const billingMode = clients.find((client) => client.id === part.clientId)?.billingMode
      if (billingMode !== 'hourly' && !part.isAdhoc) continue
      const period = part.date.slice(0, 7)
      for (const fact of facts) {
        if (fact.clientId !== part.clientId || fact.period !== period) continue
        const key = `${fact.invoiceClientId}|${fact.period}`
        if (seen.has(key)) continue
        seen.add(key)
        const monthOf = (period: string) => monthName.format(new Date(`${period}-15T12:00:00Z`))
        out.push(
          invoiceWarningText(
            clientNameOf(fact.invoiceClientId) || 'the client',
            monthOf(fact.carriedTo ?? fact.period),
            fact.sent,
            fact.carriedTo ? monthOf(fact.period) : undefined,
          ),
        )
      }
    }
    return out
  }
  const noticeParts = (parts: TimeEntry[]) =>
    parts.map((part) => ({
      date: part.date,
      job: part.isAdministrative || !part.clientId ? 'Administrative' : clientNameOf(part.clientId),
      task: (part.taskId ? checklists.find((checklist) => checklist.id === part.taskId)?.title : part.taskLabel?.trim()) || '',
    }))
  const actionsFor = (entry: TimeEntry): RowActions | null => {
    if (!live) return null
    const applied = marked.get(entry.id)
    const mark = rowOf(entry.employeeId)?.entryMarks[entry.id]
    const parts = blockOf(entry)
    const open = openRow?.entryId === entry.id ? openRow.open : null
    return {
      tickable: applied?.tickable ?? [],
      ok: applied?.ok ?? null,
      sentBack: entry.approvalStatus === 'rejected',
      open,
      busy: busyId === entry.id,
      error: rowError?.id === entry.id ? rowError.message : '',
      setOpen: (next) => {
        setRowError(null)
        setOpenRow(next ? { entryId: entry.id, open: next } : null)
      },
      onOk: () =>
        void run(entry.id, async () => {
          const kept = applied?.ok === 'current' && mark?.kind === 'ok' ? mark.flags : []
          const flagsToTick = [...new Set([...kept, ...(applied?.tickable ?? [])])]
          const answer = await markPayrollEntryRequest({
            entryId: entry.id,
            signature: entrySignature(entry),
            flags: flagsToTick,
            partners: partnersOf(entry.id),
          })
          takeRow(answer.week)
        }),
      onRemoveOk: () =>
        void run(entry.id, async () => {
          const answer = await markPayrollEntryRequest({ entryId: entry.id, remove: true })
          takeRow(answer.week)
        }),
      onSendBack: (note) =>
        void run(entry.id, async () => {
          const answer = await sendBackPayrollEntryRequest({ entryId: entry.id, signature: entrySignature(entry), note })
          onEntryChange?.({ updated: answer.entry })
          takeRow(answer.week)
        }),
      onDeny: (note) =>
        void run(entry.id, async () => {
          const signatures = Object.fromEntries(parts.map((part) => [part.id, entrySignature(part)]))
          const answer = await denyPayrollEntryRequest({ entryId: entry.id, signatures, note })
          onEntryChange?.({ removedIds: answer.removedIds })
          takeRow(answer.week)
          setStatusLine(deniedStatusText(answer.denial.hours, firstNameOf(nameOfPerson(entry.employeeId) || 'the person')))
        }),
      denyParts: parts.map((part) => partWords(part)),
      denyWarnings: warningsFor(parts),
      denyTaken: takenWords(parts),
      personFirst: firstNameOf(nameOfPerson(entry.employeeId) || 'the person'),
      noticeFor: (kind, note) =>
        kind === 'deny'
          ? deniedMessage({ ownerName, hours: payrollHoursOf(parts), parts: noticeParts(parts), note })
          : sentBackMessage({ ownerName, hours: payrollHoursOf([entry]), parts: noticeParts([entry]), note }),
    }
  }
  const undo = (row: PayrollWeekRow, denial: PayrollDenial) =>
    void run(denial.id, async () => {
      const answer = await undoPayrollDenialRequest({ userId: row.userId, weekStart: row.weekStart, denialId: denial.id })
      onEntryChange?.({ restored: answer.restored })
      takeRow(answer.week)
      setStatusLine('')
    })
  const removedFor = (userId: string) => {
    const row = rowOf(userId)
    return row ? { row, denials: row.deniedEntries } : null
  }

  const weeks = people.map((member) =>
    buildPersonWeek(
      member,
      shownEntries.filter((entry) => entry.employeeId === member.id),
      { employees: roster, jobOf, taskOf, splitBlocks, pricing, flagsOf },
    ),
  )

  const totalHours = sumDisplayHours(weeks.map((week) => week.hours))
  const totalCost = moneyTotal(weeks.map((week) => week.cost))
  const totalBillable = moneyTotal(weeks.map((week) => week.billable))
  const costLeftOut = leftOutOf(
    weeks.map((week) => ({ name: week.employee.name, hours: week.hours, amount: week.cost, unpriced: week.uncostedHours })),
    'cost',
  )
  const billLeftOut = leftOutOf(
    weeks.map((week) => ({ name: week.employee.name, hours: week.billableHours, amount: week.billable, unpriced: week.unbilledHours })),
    'bill',
  )
  const flaggedEntries = weeks.reduce((sum, week) => sum + week.flaggedEntries, 0)
  const longDays = weeks.reduce((sum, week) => sum + week.longDays, 0)

  const submissionLine = (memberId: string) => {
    const submission = submissions.find((item) => item.userId === memberId && item.weekStart === weekStart)
    if (!submission) return 'not submitted'
    const day = (iso?: string) => {
      const firmDay = iso ? dateOnlyInZone(new Date(iso)) : null
      return firmDay ? fmtDay(firmDay) : ''
    }
    const submitted = `submitted ${day(submission.submittedAt)}`.trim()
    if (submission.status === 'approved') {
      const on = day(submission.reviewedAt)
      return `${submitted}, approved${on ? ` ${on}` : ''} (not locked)`
    }
    if (submission.status === 'rejected') return `${submitted}, week sent back`
    return submitted
  }

  const owners = roster.filter(isOwner)
  const staffChoices = roster.filter(
    (member) =>
      !isOwner(member) &&
      (!member.inactiveAt || member.id === person || weekEntries.some((entry) => entry.employeeId === member.id)),
  )
  const selectedName = person === EVERYONE ? 'Everyone' : roster.find((member) => member.id === person)?.name ?? ''
  const weekLabel = `${fmtDay(weekStart)} – ${fmtDay(weekEnd)}, ${yearOf(weekEnd)}`
  const periodLabel = `Week ${period.weekNumber} of pay period ${fmtDay(period.start)} – ${fmtDay(period.end)}`

  return (
    <section className="panel payroll-review" id="payroll-review" aria-label="Payroll review">
      <PrintHeader title="Payroll review" subtitle={`${selectedName} · ${weekLabel}`} />
      <div className="section-heading">
        <div>
          <p className="section-kicker">Payroll</p>
          <h2>Payroll review</h2>
        </div>
        <button type="button" className="ghost-action no-print" onClick={() => window.print()}>
          <Printer size={14} /> Print
        </button>
      </div>

      <p className="payroll-review-purpose no-print">{live ? REVIEW_ACTIONS_TEXT : REVIEW_ONLY_TEXT}</p>
      {live && statusLine ? (
        <p className="payroll-review-status-line no-print" role="status">
          {statusLine}
        </p>
      ) : null}

      <div className="payroll-review-controls no-print">
        <div className="payroll-nav">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous week"
            onClick={() => setWeekStart(addDaysIso(weekStart, -7))}
          >
            <ChevronLeft size={16} />
          </button>
          <strong className="payroll-review-week" aria-live="polite">
            {weekLabel}
          </strong>
          <button
            type="button"
            className="icon-button"
            aria-label="Next week"
            onClick={() => setWeekStart(addDaysIso(weekStart, 7))}
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setWeekStart(lastCompletedWeekStart(today))}
          >
            Last full week
          </button>
        </div>
        <label className="payroll-member-filter">
          <span>Person</span>
          <select value={person} onChange={(event) => setPerson(event.target.value)}>
            <option value={EVERYONE}>Everyone</option>
            {staffChoices.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
            {owners.length > 0 ? (
              <optgroup label="Owners' own time">
                {owners.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <label className="payroll-review-toggle">
          <input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} />
          <span>Show only flagged</span>
        </label>
      </div>
      {person === EVERYONE && owners.length > 0 ? (
        <p className="report-caption muted-text no-print">{OWNERS_LEFT_OUT_TEXT}</p>
      ) : null}

      <p className="payroll-review-period">{periodLabel}</p>

      {status === 'loading' ? <p className="payroll-review-rates">{RATES_LOADING_TEXT}</p> : null}
      {status === 'failed' ? <p className="payroll-review-rates is-error">{RATES_FAILED_TEXT}</p> : null}

      <div className="payroll-review-totals" aria-label="Week totals">
        <div>
          <span className="muted-text">Hours</span>
          <strong>{hoursText(totalHours)}</strong>
        </div>
        <div>
          <span className="muted-text">Pay at cost</span>
          <strong>{moneyPhrase(status, totalCost, costLeftOut)}</strong>
        </div>
        <div>
          <span className="muted-text">Billable $</span>
          <strong>{moneyPhrase(status, totalBillable, billLeftOut)}</strong>
        </div>
        <div>
          <span className="muted-text">Needs a look</span>
          <strong>
            {flaggedText(flaggedEntries)}
            {longDays > 0 ? ` · ${plural(longDays, 'long day')}` : ''}
          </strong>
        </div>
        <button
          type="button"
          className="ghost-action no-print"
          aria-expanded={showPaycheck}
          onClick={() => setShowPaycheck((open) => !open)}
        >
          Paycheck totals
        </button>
      </div>
      <p className="report-caption muted-text">{DASH_MEANS_TEXT}</p>
      <p className="report-caption muted-text">{TOTALS_COUNT_TEXT}</p>

      {showPaycheck ? (
        <PaycheckTotals
          period={period}
          today={today}
          shownLabel={selectedName}
          people={peopleFor(within(period.start, period.end))}
          entriesOf={(from, to) => within(from, to)}
          pricing={pricing}
          status={status}
        />
      ) : null}

      <ul className="payroll-review-status" aria-label="Who is in this week">
        {weeks.map((week) => (
          <li key={week.employee.id}>
            <strong>{week.employee.name}</strong>
            {` · ${hoursLine(week.hours)}`}
            {isOwner(week.employee) ? '' : ` · ${submissionLine(week.employee.id)}`}
            {` · ${flaggedText(week.flaggedEntries)}`}
            {week.longDays > 0 ? ` · ${plural(week.longDays, 'long day')}` : ''}
          </li>
        ))}
      </ul>

      <p className="report-caption muted-text">
        Needs a look: {FLAG_LABELS.manual}, {FLAG_LABELS.overlap}, {FLAG_LABELS.possible_duplicate},{' '}
        {FLAG_LABELS.typed_hours}, {FLAG_LABELS.block_parts}, {FLAG_LABELS.sent_back}, {FLAG_LABELS.long_entry} (more
        than {LONG_ENTRY_HOURS} hours on one entry) and {FLAG_LABELS.long_day} (more than {LONG_DAY_HOURS} hours in one
        day); these are counted and kept by Show only flagged. Notes, not counted: {FLAG_LABELS.clock_edited} and{' '}
        {FLAG_LABELS.not_approved}. Each one says why in a line under it; none of them changes anything.
      </p>
      {live ? (
        <>
          <p className="report-caption muted-text">{OK_KEY_TEXT}</p>
          <p className="report-caption muted-text">{OK_COVERS_TEXT}</p>
          <p className="report-caption muted-text">{CHANGED_KEY_TEXT}</p>
        </>
      ) : null}

      {shownEntries.length === 0 && !weeks.some((week) => (removedFor(week.employee.id)?.denials.length ?? 0) > 0) ? (
        <p className="muted-text payroll-review-empty">No time logged this week.</p>
      ) : (
        weeks.map((week) => (
          <PersonWeekTable
            key={week.employee.id}
            week={week}
            flagsOf={flagsOf}
            flaggedOnly={flaggedOnly}
            splitBlocks={splitBlocks}
            blockSpans={blockSpans}
            status={status}
            actionsFor={live ? actionsFor : null}
            removed={removedFor(week.employee.id)}
            describePart={(part) => ({ job: jobOf(part), task: taskOf(part) })}
            onUndo={undo}
            busyId={busyId}
            rowError={rowError}
            inWeek={inWeek}
            personFirst={firstNameOf(week.employee.name)}
          />
        ))
      )}
    </section>
  )
}

const BASE_COLUMNS = 9

function PersonWeekTable({
  week,
  flagsOf,
  flaggedOnly,
  splitBlocks,
  blockSpans,
  status,
  actionsFor,
  removed,
  describePart,
  onUndo,
  busyId,
  rowError,
  inWeek,
  personFirst,
}: {
  week: PersonWeek
  flagsOf: (entryId: string) => MarkedFlag[]
  flaggedOnly: boolean
  splitBlocks: ReturnType<typeof buildSplitBlocks>
  blockSpans: ReadonlyMap<string, BlockSpan>
  status: RateReadStatus
  actionsFor: ((entry: TimeEntry) => RowActions | null) | null
  removed: { row: PayrollWeekRow; denials: PayrollDenial[] } | null
  describePart: (part: TimeEntry) => { job: string; task: string }
  onUndo: (row: PayrollWeekRow, denial: PayrollDenial) => void
  busyId: string | null
  rowError: { id: string; message: string } | null
  /** True for a date in the week on screen. */
  inWeek: (date: string) => boolean
  personFirst: string
}) {
  // The actions sit in the Flags cell, so the row is no wider than ship 1 measured at 1200px.
  const COLUMNS = BASE_COLUMNS
  const [confirmUndo, setConfirmUndo] = useState<string | null>(null)
  const denials = removed?.denials ?? []
  // Only the parts DATED in this week count toward "removed this week"; a
  // part of a removed block dated in another week is said apart.
  const asEntries = (denial: PayrollDenial) => denial.parts as unknown as TimeEntry[]
  const removedHours = sumDisplayHours(denials.map((denial) => payrollHoursOf(asEntries(denial).filter((part) => inWeek(part.date)))))
  const removedElsewhere = sumDisplayHours(
    denials.map((denial) => payrollHoursOf(asEntries(denial).filter((part) => !inWeek(part.date)))),
  )
  const visibleDays = week.days
    .map((day) => ({
      ...day,
      // A day flagged as long shows ALL its rows, so she can see why it is long.
      shownRows:
        flaggedOnly && day.flags.length === 0
          ? day.rows.filter((row) => lookOf(flagsOf(row.id)).length > 0)
          : day.rows,
    }))
    .filter((day) => !flaggedOnly || day.shownRows.length > 0 || day.flags.length > 0)

  const unpriced = unpricedNote
  const moneyParts = (cost: string, billable: string) =>
    status === 'ready' ? ` · ${cost} cost · ${billable} billable` : ''
  const heading =
    `${week.employee.name} · ${hoursLine(week.hours)}` +
    moneyParts(
      moneyPhrase(status, week.cost, unpriced(week.uncostedHours, 'cost')),
      moneyPhrase(status, week.billable, unpriced(week.unbilledHours, 'bill')),
    )

  return (
    <div className="payroll-review-person" data-person-id={week.employee.id}>
      <h3>{heading}</h3>
      {denials.length > 0 ? (
        <p className="payroll-review-removed-line">{removedHoursText(removedHours, removedElsewhere)}</p>
      ) : null}
      {week.entries.length === 0 ? (
        <p className="muted-text">No time logged this week.</p>
      ) : visibleDays.length === 0 ? (
        <p className="muted-text">Nothing flagged this week.</p>
      ) : (
        <div className="table-wrap">
          <table className="payroll-review-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Client</th>
                <th>Task</th>
                <th>Description</th>
                <th>Hours</th>
                <th>Pay at cost</th>
                <th>Billable $</th>
                <th>Logged</th>
                <th>Flags</th>
              </tr>
            </thead>
            <>
              {visibleDays.map((day) => (
                <Fragment key={day.date}>
                  <tbody className="payroll-review-day-group">
                  <tr className="payroll-review-day" data-day={day.date}>
                    <td colSpan={BASE_COLUMNS - 1}>
                      <strong>
                        {`${fmtDayLong(day.date)} · ${hoursLine(day.hours)}` +
                          moneyParts(moneyPhrase(status, day.cost, []), moneyPhrase(status, day.billable, []))}
                      </strong>
                    </td>
                    <td>
                      <FlagList flags={day.flags} />
                    </td>
                  </tr>
                  </tbody>
                  {day.shownRows.map((row) => (
                    <EntryRows
                      key={row.id}
                      row={row}
                      week={week}
                      flags={flagsOf(row.id)}
                      splitBlocks={splitBlocks}
                      blockSpans={blockSpans}
                      status={status}
                      columns={COLUMNS}
                      actions={actionsFor ? actionsFor(row.entry) : null}
                    />
                  ))}
                </Fragment>
              ))}
            </>
          </table>
          {flaggedOnly ? (
            <p className="muted-text">Showing flagged entries only; the totals count every entry.</p>
          ) : null}
        </div>
      )}
      {removed && denials.length > 0 ? (
        <div className="payroll-review-removed" aria-label={`${REMOVED_HEADING}: ${week.employee.name}`}>
          <h4>{REMOVED_HEADING}</h4>
          <p className="muted-text">{STAFF_REMOVED_NOTE}</p>
          <ul>
            {denials.map((denial) => (
              <li key={denial.id} data-denial-id={denial.id}>
                {denial.parts.map((part) => {
                  const words = describePart(part as unknown as TimeEntry)
                  return (
                    <div key={part.id} className="payroll-review-removed-part">
                      {`${fmtDayLong(part.date)} · ${words.job} · ${words.task} · ${part.description || '—'} · ${hoursText(displayHours(part.minutes))}` +
                        (inWeek(part.date) ? '' : ` (${otherWeekText(fmtDay(part.date))})`)}
                    </div>
                  )
                })}
                <div className="muted-text">
                  {removedByText(firstNameOf(denial.deniedByName), instantDayText(denial.deniedAt), denial.note)}
                  {denial.parts.length > 1 ? ` · ${hoursText(denial.hours)} in all` : ''}
                </div>
                {confirmUndo === denial.id ? (
                  <div className="payroll-review-undo-confirm no-print" role="group" aria-label={UNDO_LABEL}>
                    <span>{undoConfirmText(personFirst)}</span>{' '}
                    <button
                      type="button"
                      className="primary-action"
                      disabled={busyId === denial.id}
                      onClick={() => {
                        setConfirmUndo(null)
                        onUndo(removed.row, denial)
                      }}
                    >
                      {UNDO_CONFIRM_LABEL}
                    </button>{' '}
                    <button type="button" className="ghost-action" onClick={() => setConfirmUndo(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="ghost-action no-print"
                    disabled={busyId === denial.id}
                    onClick={() => setConfirmUndo(denial.id)}
                  >
                    {UNDO_LABEL}
                  </button>
                )}
                {rowError?.id === denial.id ? (
                  <p className="payroll-review-action-error" role="alert">
                    {rowError.message}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The actions at the right of an entry, kept small: one "Actions" button opens
 * a short menu, each choice with a one-line helper under it; Send back and
 * Deny open a sheet under the row that says what will happen and asks for her
 * reason.
 */
function EntryActionsCell({ actions }: { actions: RowActions }) {
  const menuOpen = actions.open === 'menu'
  const item = (label: string, help: string, onClick: () => void) => (
    <button type="button" role="menuitem" aria-label={label} onClick={onClick}>
      <span className="payroll-review-actions-label">{label}</span>
      <span className="payroll-review-actions-help">{help}</span>
    </button>
  )
  return (
    <div className="payroll-review-actions no-print">
      <button
        type="button"
        className="ghost-action payroll-review-actions-toggle"
        aria-expanded={menuOpen}
        disabled={actions.busy}
        onClick={() => actions.setOpen(menuOpen ? null : 'menu')}
      >
        Actions
      </button>
      {menuOpen ? (
        <div className="payroll-review-actions-menu" role="menu">
          {actions.tickable.length > 0 ? item(OK_ACTION_LABEL, OK_HELP_TEXT, actions.onOk) : null}
          {actions.ok ? (
            <button type="button" role="menuitem" onClick={actions.onRemoveOk}>
              {UNDO_OK_LABEL}
            </button>
          ) : null}
          {actions.sentBack
            ? null
            : item(SEND_BACK_LABEL, sendBackHelpText(actions.personFirst), () => actions.setOpen('send_back'))}
          {item(DENY_LABEL, denyHelpText(actions.personFirst), () => actions.setOpen('deny'))}
        </div>
      ) : null}
      {actions.error && (actions.open === null || actions.open === 'menu') ? (
        <p className="payroll-review-action-error" role="alert">
          {actions.error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The confirm sheet under an entry: what will happen, in plain words, any
 * invoice that already bills the time, her reason (required) and the notice
 * exactly as it will be sent.
 */
function EntryActionSheet({ actions, columns }: { actions: RowActions; columns: number }) {
  const [note, setNote] = useState('')
  const [tried, setTried] = useState(false)
  const kind = actions.open
  if (kind !== 'send_back' && kind !== 'deny') return null
  const deny = kind === 'deny'
  const submit = () => {
    setTried(true)
    if (!note.trim()) return
    if (deny) actions.onDeny(note.trim())
    else actions.onSendBack(note.trim())
  }
  const several = actions.denyParts.length > 1
  return (
    <tr className="payroll-review-sheet no-print">
      <td colSpan={columns}>
        <div className="payroll-review-sheet-body" role="group" aria-label={deny ? DENY_LABEL : SEND_BACK_LABEL}>
          <strong>{deny ? DENY_LABEL : SEND_BACK_LABEL}</strong>
          {deny ? (
            <>
              {several ? <p>{DENY_SHARED_TEXT}</p> : null}
              <ul className="payroll-review-sheet-parts">
                {actions.denyParts.map((part) => (
                  <li key={part}>{part}</li>
                ))}
              </ul>
              <p>{denyConfirmText(actions.personFirst, actions.denyTaken)}</p>
              {actions.denyWarnings.map((warning) => (
                <p key={warning} className="payroll-review-invoice-warning" data-warning="invoice">
                  {warning}
                </p>
              ))}
            </>
          ) : (
            <p>{sendBackConfirmText(actions.personFirst)}</p>
          )}
          <label>
            <span>{reasonLabel(actions.personFirst)}</span>
            <textarea value={note} rows={2} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
          </label>
          {tried && !note.trim() ? <p className="payroll-review-action-error">{NOTE_REQUIRED_TEXT}</p> : null}
          <div className="payroll-review-notice-preview" aria-label={NOTICE_PREVIEW_LABEL}>
            <span className="muted-text">{NOTICE_PREVIEW_LABEL}</span>
            <p>{actions.noticeFor(deny ? 'deny' : 'send_back', note)}</p>
          </div>
          {actions.error ? (
            <p className="payroll-review-action-error" role="alert">
              {actions.error}
            </p>
          ) : null}
          <div className="payroll-review-sheet-buttons">
            <button type="button" className="primary-action" disabled={actions.busy} onClick={submit}>
              {deny ? (several ? denyBlockButtonLabel(actions.denyParts.length) : DENY_BUTTON_LABEL) : 'Send back'}
            </button>
            <button type="button" className="ghost-action" disabled={actions.busy} onClick={() => actions.setOpen(null)}>
              Cancel
            </button>
          </div>
        </div>
      </td>
    </tr>
  )
}

/** The NEEDS A LOOK chips, each with its sentence written under it (and on hover). */
function FlagList({ flags }: { flags: MarkedFlag[] }) {
  const look = lookOf(flags)
  // A flag she OK'd still shows, as seen: "Manual entry · OK'd by Brittany Nov 20".
  const seen = flags.filter((flag) => flag.tier === 'seen')
  if (look.length === 0 && seen.length === 0) return null
  return (
    <ul className="payroll-flag-list">
      {look.map((flag) => (
        <li key={flag.kind} data-flag={flag.kind}>
          <span className="payroll-flag-chip" title={flag.sentence}>
            {flag.label}
          </span>{' '}
          <span className="payroll-flag-sentence">{flag.sentence}</span>
        </li>
      ))}
      {seen.map((flag) => (
        <li key={flag.kind} data-flag={flag.kind} data-seen="true">
          <span className="payroll-flag-chip is-seen" title={flag.sentence}>
            {`${flag.label} · ${flag.seenBy ?? ''}`}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * One entry: its main line, then one sub-line per stretch when it was worked in
 * more than one. The sub-lines are PARTS of the line above ("1.00h of the
 * 3.00h above"), never hours to add: none sits in the Hours column.
 */
function EntryRows({
  row,
  week,
  flags,
  splitBlocks,
  blockSpans,
  status,
  columns,
  actions,
}: {
  row: PayrollEntryRow
  week: PersonWeek
  flags: MarkedFlag[]
  splitBlocks: ReturnType<typeof buildSplitBlocks>
  blockSpans: ReadonlyMap<string, BlockSpan>
  status: RateReadStatus
  columns: number
  actions: RowActions | null
}) {
  const COLUMNS = columns
  const entry = row.entry
  const cost = row.countedElsewhere ? null : week.costOf(row.id)
  const amount = week.amountOf(row.id)
  const hours = displayHours(row.minutes)
  const pieces = stretchRows(row.spans, entryFigures(entry, amount, cost))
  const several = pieces.length > 1
  const shared = Boolean(entry.groupId)
  // A part of a block shared between clients carries the block's clock times
  // and only its own part of the hours. "Shared block" + times is said ONLY
  // when it is true: the block is known and every part still holds the same
  // stretches. A part resumed alone, moved or retyped shows its OWN times
  // without those words, and payrollClock's state-aware note under it speaks.
  const block = shared && entry.groupId ? blockSpans.get(entry.groupId) : undefined
  const time = several
    ? `${pieces.length} stretches`
    : shared && block?.agree
      ? `Shared block ${fmtSpan(block.firstStart, block.lastStop) || '(no clock times)'}`
      : fmtSpan(pieces[0]?.startAt, pieces[0]?.endAt) || '—'
  const blockNote = shared ? splitNote(entry, splitBlocks, { forExport: true }) : ''
  const notes = flags.filter((flag) => flag.tier === 'note')
  const editedNote = notes.find((flag) => flag.kind === 'clock_edited')
  const otherNotes = notes.filter((flag) => flag.kind !== 'clock_edited')
  const ready = status === 'ready'
  const costCell = !ready ? '' : row.countedElsewhere ? 'on the first part' : money(cost)
  const billableCell = !row.billable ? 'not billable' : ready ? money(amount) : ''
  // "Manual entry" is said once, by its chip; the Logged column says how
  // everything else was logged, and edited clock times as a note under it.
  const logged = row.logged === 'manual' ? '' : row.logged === 'timer_edited' ? 'Timer' : HOW_LOGGED_LABEL[row.logged]
  return (
    <tbody className="payroll-review-entry-group">
      <tr className="payroll-review-entry" data-entry-id={row.id}>
        <td>
          {time}
          {blockNote ? <div className="payroll-review-block-note">{blockNote}</div> : null}
        </td>
        <td>{row.job}</td>
        <td>{row.task}</td>
        <td className="payroll-review-description">{entry.description || '—'}</td>
        <td>{hoursText(hours)}</td>
        <td>{costCell}</td>
        <td>{billableCell}</td>
        <td>
          {logged}
          {editedNote ? (
            <div className="muted-text payroll-review-note" data-note={editedNote.kind}>
              {`${editedNote.label}: ${editedNote.sentence}`}
            </div>
          ) : null}
        </td>
        <td className="payroll-review-flags">
          {actions ? <EntryActionsCell actions={actions} /> : null}
          <FlagList flags={flags} />
          {otherNotes.map((note) => (
            <div key={note.kind} className="muted-text payroll-review-note" data-note={note.kind}>
              {note.sentence}
            </div>
          ))}
        </td>
      </tr>
      {actions ? <EntryActionSheet key={actions.open ?? 'closed'} actions={actions} columns={COLUMNS} /> : null}
      {several
        ? pieces.map((piece) => (
            <tr key={piece.index} className="payroll-review-stretch" data-entry-id={row.id}>
              <td colSpan={COLUMNS}>
                {shared
                  ? `${piece.label} · ${fmtSpan(piece.startAt, piece.endAt)} · ${hoursText(piece.hours)} of this part's ${hoursText(hours)}`
                  : `${piece.label} · ${fmtSpan(piece.startAt, piece.endAt)} · ${hoursText(piece.hours)} of the ${hoursText(hours)} above`}
              </td>
            </tr>
          ))
        : null}
    </tbody>
  )
}

/**
 * "maybe a button to press paycheck totals and I could see both weeks to be
 * paid total": both weeks of the pay period, per person and in total, with
 * the report's bi-weekly arithmetic (cost and billable over the whole period,
 * priced by the day worked). Not called "to be paid": a later part lets her
 * deny entries, and this counts every entry, approved or not.
 */
function PaycheckTotals({
  period,
  today,
  shownLabel,
  people,
  entriesOf,
  pricing,
  status,
}: {
  period: ReturnType<typeof payPeriodOf>
  today: string
  shownLabel: string
  people: Employee[]
  entriesOf: (from: string, to: string) => TimeEntry[]
  pricing: PayrollPricing
  status: RateReadStatus
}) {
  const [first, second] = period.weekStarts
  const firstEnd = addDaysIso(first, 6)
  const firstEntries = entriesOf(first, firstEnd)
  const secondEntries = entriesOf(second, addDaysIso(second, 6))
  const bothEntries = entriesOf(period.start, period.end)
  const rows = people.map((member) => {
    const mine = (list: TimeEntry[]) => list.filter((entry) => entry.employeeId === member.id)
    const both = mine(bothEntries)
    const repeats = duplicateFullSliceIds(both)
    const unpricedHours = (rateOf: (entry: TimeEntry) => number | null, include: (entry: TimeEntry) => boolean) =>
      sumDisplayHours(both.filter((entry) => include(entry) && rateOf(entry) === null).map((entry) => displayHours(entry.minutes)))
    const bothFigures = payrollPersonFigures(both)
    const cost = pricing.periodCostOf(member.id, bothEntries)
    const billable = pricing.periodBillableOf(member.id, bothEntries)
    const uncosted = cost === null ? 0 : unpricedHours((entry) => pricing.costRateOn(entry.employeeId, entry.date), (entry) => !repeats.has(entry.id))
    const unbilled = billable === null ? 0 : unpricedHours((entry) => pricing.billRateOn(entry), (entry) => entry.billable)
    return {
      uncosted,
      unbilled,
      member,
      firstHours: payrollPersonFigures(mine(firstEntries)).hours,
      secondHours: payrollPersonFigures(mine(secondEntries)).hours,
      hours: bothFigures.hours,
      billableHours: bothFigures.billableHours,
      cost: allUnpriced(cost, uncosted, bothFigures.hours) ? null : cost,
      billable: allUnpriced(billable, unbilled, bothFigures.billableHours) ? null : billable,
    }
  })
  // A week is finished once its Saturday is behind the firm's today.
  const unfinished =
    today <= firstEnd ? 'Weeks 1 and 2 are not finished yet.' : today <= period.end ? 'Week 2 is not finished yet.' : ''
  const weekHead = (start: string) => `${fmtDay(start)} – ${fmtDay(addDaysIso(start, 6))}`
  const totalCost = moneyTotal(rows.map((row) => row.cost))
  const totalBillable = moneyTotal(rows.map((row) => row.billable))
  const leftOut = (kind: 'cost' | 'bill') =>
    leftOutOf(
      rows.map((row) => ({
        name: row.member.name,
        hours: kind === 'cost' ? row.hours : row.billableHours,
        amount: kind === 'cost' ? row.cost : row.billable,
        unpriced: kind === 'cost' ? row.uncosted : row.unbilled,
      })),
      kind,
    )
  return (
    <div className="payroll-review-paycheck" aria-label="Paycheck totals">
      <h3>{`Paycheck totals: both weeks of the pay period ${fmtDay(period.start)} – ${fmtDay(period.end)}, ${yearOf(period.end)} · ${shownLabel}`}</h3>
      <p className="report-caption">
        {PAYCHECK_COUNTS_TEXT}
        {unfinished ? ` ${unfinished}` : ''}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>{`Week 1 (${weekHead(first)})`}</th>
              <th>{`Week 2 (${weekHead(second)})`}</th>
              <th>Hours, both weeks</th>
              <th>Pay at cost</th>
              <th>Billable $</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted-text">
                  No one to show for this pay period.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.member.id}>
                  <td>{row.member.name}</td>
                  <td>{hoursText(row.firstHours)}</td>
                  <td>{hoursText(row.secondHours)}</td>
                  <td>{hoursText(row.hours)}</td>
                  <td>{moneyPhrase(status, row.cost, unpricedNote(row.uncosted, 'cost'))}</td>
                  <td>{moneyPhrase(status, row.billable, unpricedNote(row.unbilled, 'bill'))}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td>
                <strong>{hoursText(sumDisplayHours(rows.map((row) => row.firstHours)))}</strong>
              </td>
              <td>
                <strong>{hoursText(sumDisplayHours(rows.map((row) => row.secondHours)))}</strong>
              </td>
              <td>
                <strong>{hoursText(sumDisplayHours(rows.map((row) => row.hours)))}</strong>
              </td>
              <td>
                <strong>{moneyPhrase(status, totalCost, leftOut('cost'))}</strong>
              </td>
              <td>
                <strong>{moneyPhrase(status, totalBillable, leftOut('bill'))}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="report-caption muted-text">{PAYCHECK_FOOT_TEXT}</p>
    </div>
  )
}
