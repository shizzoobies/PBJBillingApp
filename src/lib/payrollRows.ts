import { useEffect, useState } from 'react'
import {
  billRateAt,
  costRateFor,
  latestBillRate,
  latestCostRate,
  ratePeriodAsOf,
} from '../../lib/rate-history.js'
import { fetchRateVersions } from './api'
import {
  allocatePersonCost,
  billableMinutes as sumBillableMinutes,
  billableRevenue,
  displayHours,
  duplicateFullSliceIds,
  internalMinutes as sumInternalMinutes,
  laborCost,
  periodDisplayHours,
  sumDisplayHours,
  trackedMinutes as sumTrackedMinutes,
} from './payrollAggregation'
import {
  clockMismatchNote,
  clockMismatchShortNote,
  clockSpansOf,
  howLogged,
  splitNote,
  splitShortNote,
  type HowLogged,
  type SplitBlock,
} from './payrollClock'
import type {
  BillRateVersion,
  Checklist,
  Client,
  CostRateVersion,
  Employee,
  TimeEntry,
  WorkSession,
} from './types'
import { clientName, employeeName } from './utils'

/**
 * THE PAYROLL ARITHMETIC, in one place for every payroll screen.
 *
 * Lifted out of the payroll Hours report (src/pages/ReportsPage.tsx) for the
 * weekly Payroll review (featreq-20b13da0), so the review and the report call
 * the SAME functions and can never put two numbers on one week: the rate
 * lookups, the per-person period figures, the day-grouped entry rows, and the
 * per-row split of a person's cost and billable money. Nothing here was
 * re-derived; the report's own tests pin it.
 */

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * The rate history (dated bill and cost rates), read from /api/rate-versions:
 * owner-only pay data that never enters the workspace a staff session gets.
 * `enabled` false reads nothing at all (a non-owner screen must not ask).
 *
 * `status` says whether the rates are in: 'loading' until the read answers,
 * 'ready' after it (an empty list is a real answer: nobody has a rate on file),
 * 'failed' when it did not answer. The Hours report ignores it (a failed read
 * prices as "—" there, as it always has); the Payroll review says it in words,
 * so "not read yet" never looks like "no rate on file".
 */
export type RateReadStatus = 'loading' | 'ready' | 'failed'

export function useRateVersions(enabled = true) {
  const [billRateVersions, setBillRateVersions] = useState<BillRateVersion[]>([])
  const [costRateVersions, setCostRateVersions] = useState<CostRateVersion[]>([])
  const [status, setStatus] = useState<RateReadStatus>('loading')
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetchRateVersions(controller.signal)
      .then((versions) => {
        setBillRateVersions(versions.billRateVersions)
        setCostRateVersions(versions.costRateVersions)
        setStatus('ready')
      })
      // Non-fatal: pricing falls back to today's rates and the Cost column
      // simply reads "—", exactly as before.
      .catch(() => {
        if (!controller.signal.aborted) setStatus('failed')
      })
    return () => controller.abort()
  }, [enabled])
  return { billRateVersions, costRateVersions, status }
}

export type PayrollPricing = {
  /** The cost rate in force on the DAY an entry was worked; null = none on file. */
  costRateOn: (employeeId: string, entryDate?: string) => number | null
  /** The bill rate ONE entry bills at: its person, at its client's pin, for its month. */
  billRateOn: (entry: Pick<TimeEntry, 'employeeId' | 'clientId' | 'date'>) => number | null
  /** One person's labor cost over a period, priced by the day each entry was worked; null = no cost rate on file. */
  periodCostOf: (employeeId: string, entries: TimeEntry[]) => number | null
  /** One person's Billable $ over a period, each billable row at its client's pin; null = no bill rate on file. */
  periodBillableOf: (employeeId: string, entries: TimeEntry[]) => number | null
}

/**
 * The report's four rate readers, built once from the rate history.
 *
 * - Cost is read for the day worked: a raise lands on a payday, so a raise
 *   mid-period costs each side of it at its own rate (`laborCost` groups by
 *   person and rate). `null` ("—", never $0.00) when the person has no cost
 *   rate on file at all. Owners are costed like anyone else (featreq-6fdd9e98).
 * - The bill rate for one entry is the person's version at the pin of the
 *   client the hour was worked for (`billRateAt` at `ratePeriodAsOf`), the
 *   chain every invoice line is priced through. `employees` must hold former
 *   team members too, so their hours still price.
 */
export function makePayrollPricing({
  billRateVersions,
  costRateVersions,
  clients,
  employees,
}: {
  billRateVersions: BillRateVersion[]
  costRateVersions: CostRateVersion[]
  clients: Client[]
  employees: Employee[]
}): PayrollPricing {
  const costRateOn = (employeeId: string, entryDate?: string) =>
    costRateFor(costRateVersions, employeeId, entryDate ?? null)
  const periodCostOf = (employeeId: string, entries: TimeEntry[]) =>
    latestCostRate(costRateVersions, employeeId) === null
      ? null
      : laborCost(
          entries.filter((entry) => entry.employeeId === employeeId),
          costRateOn,
        )
  const billRateOn = (entry: Pick<TimeEntry, 'employeeId' | 'clientId' | 'date'>) => {
    const client = clients.find((candidate) => candidate.id === entry.clientId) ?? null
    const employee = employees.find((candidate) => candidate.id === entry.employeeId) ?? {
      id: entry.employeeId,
    }
    const month = typeof entry.date === 'string' && entry.date ? entry.date.slice(0, 7) : null
    return billRateAt(billRateVersions, employee, ratePeriodAsOf(client, month), month, client)
  }
  const periodBillableOf = (employeeId: string, entries: TimeEntry[]) => {
    const employee = employees.find((candidate) => candidate.id === employeeId)
    const onFile =
      latestBillRate(billRateVersions, employeeId) ??
      (typeof employee?.billRate === 'number' && !Number.isNaN(employee.billRate)
        ? employee.billRate
        : null)
    return onFile === null
      ? null
      : billableRevenue(
          entries.filter((entry) => entry.employeeId === employeeId),
          billRateOn,
        )
  }
  return { costRateOn, billRateOn, periodCostOf, periodBillableOf }
}

// ---------------------------------------------------------------------------
// One person's period
// ---------------------------------------------------------------------------

/**
 * One person's figures over a window, as the report's summary row prints them.
 * Hours are the sum of the ROWS' two-decimal hours with full-mode repeats
 * counted once (featreq-7c8f64d7); billable is not deduped (a full-mode split
 * bills each client the whole block on purpose).
 */
export function payrollPersonFigures(entries: TimeEntry[]) {
  const duplicates = duplicateFullSliceIds(entries)
  const trackedRowMinutes = entries
    .filter((entry) => !duplicates.has(entry.id))
    .map((entry) => entry.minutes)
  const billableRowMinutes = entries
    .filter((entry) => entry.billable)
    .map((entry) => entry.minutes)
  return {
    minutes: sumTrackedMinutes(entries),
    billable: sumBillableMinutes(entries),
    internal: sumInternalMinutes(entries),
    trackedRowMinutes,
    billableRowMinutes,
    hours: periodDisplayHours(trackedRowMinutes),
    billableHours: periodDisplayHours(billableRowMinutes),
    count: entries.length,
  }
}

// ---------------------------------------------------------------------------
// Entry rows, grouped by day
// ---------------------------------------------------------------------------

/**
 * ONE TIME ENTRY, reported on its own row. Entries are never merged: two
 * stretches on the same client and task are two separate lines with their own
 * clock in/out, because payroll has to be auditable entry by entry.
 */
export type PayrollEntryRow = {
  id: string
  date: string
  /** Kept so the row can resolve its own person's bill/cost rate. */
  employeeId: string
  /** Kept so the row can resolve its own client's rate month (its pin). */
  clientId: string
  member: string
  job: string
  task: string
  /**
   * The stretches the entry was worked in, earliest first; empty when it was
   * logged as minutes only. The table prints one row per stretch
   * (`stretchRows`), each with its own clock in, clock out and hours.
   */
  spans: WorkSession[]
  /** What a share of a split block is a share of (see `splitNote`); '' for any other entry. */
  splitNote: string
  /** The short forms under the Hours of the entry's later stretch rows (`splitShortNote`, `clockMismatchShortNote`). */
  splitShortNote: string
  mismatchShortNote: string
  /** Said only when the row's time does not come from its clock times (see `clockMismatchNote`). */
  mismatchNote: string
  /** Timer, timer with its clock times edited, manual, or no clock times (see `howLogged`). */
  logged: HowLogged
  minutes: number
  billable: boolean
  billableMinutes: number
  groupId?: string
  groupAllocation?: 'even' | 'full' | 'custom'
  /** Sort key: clock-in epoch ms, `Infinity` when there are no timestamps. */
  startedAtMs: number
  /**
   * True when this slice's WALL TIME was already counted on a sibling slice of
   * the same full-mode group. The row still shows (and still bills) — it just
   * doesn't add its minutes or cost to the day/grand totals a second time.
   */
  countedElsewhere: boolean
  /** The entry itself, for a screen that reads more of it (the review reads its description and approval). */
  entry: TimeEntry
}

/**
 * All the work logged on a single day, plus that day's total. `hours` is the
 * sum of the DISPLAYED hours of the rows underneath it (skipping full-mode
 * repeats), so a day subtotal always equals the column above it, and the grand
 * total is in turn the sum of the day subtotals.
 */
export type PayrollDayGroup = { date: string; hours: number; rows: PayrollEntryRow[] }

/** "Job" = the client the time is billed to; administrative time has none. */
export function payrollJobOf(clients: Client[], adminLabel = '(Admin)') {
  return (entry: TimeEntry) =>
    entry.isAdministrative || !entry.clientId ? adminLabel : clientName(clients, entry.clientId)
}

/** The task: its checklist, else the typed task name, else "Unassigned". */
export function payrollTaskOf(checklists: Checklist[]) {
  const titleById = new Map(checklists.map((checklist) => [checklist.id, checklist.title]))
  return (entry: TimeEntry) =>
    (entry.taskId ? titleById.get(entry.taskId) : entry.taskLabel?.trim()) || 'Unassigned'
}

/**
 * EVERY time entry, grouped under its day. Within a day, entries run in order
 * of their first clock in; minutes-only entries (no timestamps) come last. The
 * totals are built from the entries, and the stretch rows add back to them
 * exactly.
 *
 * Day subtotals count a full-mode group's wall time ONCE (see
 * `duplicateFullSliceIds`). Those rows still render (and still bill); they
 * carry `countedElsewhere` so the subtotal is explainable.
 *
 * `splitBlocks` must be read off EVERY entry, not the window: a share moved to
 * another day is still a share.
 */
export function buildPayrollDayGroups(
  entries: TimeEntry[],
  {
    employees,
    jobOf,
    taskOf,
    splitBlocks,
  }: {
    employees: Employee[]
    jobOf: (entry: TimeEntry) => string
    taskOf: (entry: TimeEntry) => string
    splitBlocks: ReadonlyMap<string, SplitBlock>
  },
): PayrollDayGroup[] {
  const rows = entries.map((entry) => {
    // Earliest start, latest stop, and the stretches in time order: the
    // stored order is the order they were typed or added.
    const clock = clockSpansOf(entry)
    const spans = clock.spans
    const startedAtMs = clock.firstStart ? Date.parse(clock.firstStart) : Number.NaN
    return {
      id: entry.id,
      date: entry.date,
      employeeId: entry.employeeId,
      clientId: entry.clientId,
      member: employeeName(employees, entry.employeeId),
      job: jobOf(entry),
      task: taskOf(entry),
      spans,
      splitNote: splitNote(entry, splitBlocks),
      splitShortNote: splitShortNote(entry, splitBlocks),
      mismatchNote: clockMismatchNote(entry, splitBlocks, clock),
      mismatchShortNote: clockMismatchShortNote(entry, splitBlocks, clock),
      logged: howLogged(entry, clock),
      minutes: entry.minutes,
      billable: entry.billable,
      billableMinutes: entry.billable ? entry.minutes : 0,
      groupId: entry.groupId,
      groupAllocation: entry.groupAllocation,
      startedAtMs: Number.isNaN(startedAtMs) ? Number.POSITIVE_INFINITY : startedAtMs,
      countedElsewhere: false,
      entry,
    }
  })
  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startedAtMs - b.startedAtMs ||
      a.member.localeCompare(b.member) ||
      a.job.localeCompare(b.job) ||
      a.task.localeCompare(b.task),
  )
  // Computed AFTER the sort so the slice that "counts" is the first one the
  // reader sees, and the hint lands on the repeats below it.
  const duplicates = duplicateFullSliceIds(rows)
  const byDate = new Map<string, PayrollDayGroup>()
  for (const row of rows) {
    const countedElsewhere = duplicates.has(row.id)
    const group = byDate.get(row.date) ?? { date: row.date, hours: 0, rows: [] }
    group.rows.push({ ...row, countedElsewhere })
    if (!countedElsewhere) {
      group.hours = sumDisplayHours([group.hours, displayHours(row.minutes)])
    }
    byDate.set(row.date, group)
  }
  // `rows` is already date-ordered, so insertion order is date order.
  return [...byDate.values()]
}

/**
 * Per-ENTRY money cells, by row id.
 *
 * A row cannot be priced on its own AND add up to what the person is paid for
 * the period, so each person's period figure is split across their own rows
 * (`allocatePersonCost`), one split per (person, rate) group: the column sums
 * EXACTLY, at the price of a row landing a penny or two off its own hours x
 * rate. The report builds both its Cost cells (`include` skips full-mode
 * repeats: the firm pays for the block once) and its Billable $ cells here.
 */
export function allocateRowMoney(
  rows: readonly PayrollEntryRow[],
  rateOf: (row: PayrollEntryRow) => number | null,
  minutesOf: (row: PayrollEntryRow) => number,
  include: (row: PayrollEntryRow) => boolean = () => true,
): Map<string, number | null> {
  const groups = new Map<string, { rate: number | null; rows: { id: string; minutes: number }[] }>()
  for (const row of rows) {
    if (!include(row)) continue
    const rate = rateOf(row)
    const key = `${row.employeeId} ${rate ?? ''}`
    const found = groups.get(key)
    if (found) found.rows.push({ id: row.id, minutes: minutesOf(row) })
    else groups.set(key, { rate, rows: [{ id: row.id, minutes: minutesOf(row) }] })
  }
  const byRowId = new Map<string, number | null>()
  for (const group of groups.values()) {
    const amounts = allocatePersonCost(
      group.rows.map((row) => row.minutes),
      group.rate,
    )
    group.rows.forEach((row, index) => byRowId.set(row.id, amounts[index]))
  }
  return byRowId
}

/** The report's per-row Cost cells: at the cost rate on the row's day, full-mode repeats left out. */
export function rowCostCells(rows: readonly PayrollEntryRow[], pricing: Pick<PayrollPricing, 'costRateOn'>) {
  return allocateRowMoney(
    rows,
    (row) => pricing.costRateOn(row.employeeId, row.date),
    (row) => row.minutes,
    (row) => !row.countedElsewhere,
  )
}

/** The report's per-row Billable $ cells: each billable row at its client's pin, not deduped. */
export function rowAmountCells(rows: readonly PayrollEntryRow[], pricing: Pick<PayrollPricing, 'billRateOn'>) {
  return allocateRowMoney(
    rows,
    (row) => pricing.billRateOn(row),
    (row) => row.billableMinutes,
  )
}
