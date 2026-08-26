import { ChevronLeft, ChevronRight, Download, Printer } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useAppContext } from '../AppContext'
import { PrintHeader } from '../components/PrintHeader'
import { downloadCsv } from '../lib/csv'
import { fetchTeam } from '../lib/api'
import {
  allocatePersonCost,
  billableMinutes as sumBillableMinutes,
  displayHours,
  duplicateFullSliceIds,
  internalMinutes as sumInternalMinutes,
  laborCost,
  periodDisplayHours,
  periodMoney,
  sumDisplayHours,
  sumPersonCosts,
  trackedMinutes as sumTrackedMinutes,
} from '../lib/payrollAggregation'
import type {
  Checklist,
  Client,
  ClientReportRow,
  Employee,
  EmployeeReportRow,
  TaskReportRow,
  TimeEntry,
} from '../lib/types'
import {
  addDays,
  clientName,
  decimalHours,
  effectiveSessions,
  formatAuditStamp,
  currency,
  employeeName,
  formatDecimalHours,
  formatHoursTotal,
  getBillingPeriodLabel,
  getInvoice,
  isInBillingPeriod,
  localDateOnly,
  shortDate,
  weekStartOf,
} from '../lib/utils'

/**
 * The one sentence that tells the reader how a Cost figure was built. It stays
 * on the page, but it now says something reassuring instead of something
 * defensive: the obvious arithmetic is the right arithmetic.
 */
const COST_BASIS_NOTE =
  'Cost is the Hours shown times the pay rate — hours are rounded to two decimals first, so ' +
  'multiplying an Hours cell by hand gives the Cost beside it. Both columns add up to their ' +
  'own totals exactly.'

/**
 * The honest footnote for the per-entry Cost column: rows are a BREAKDOWN of
 * what each person is paid for the period, not independent prices. See
 * `allocatePersonCost` — the column sums exactly, at the price of a row sitting
 * a penny or two off its own hours × rate.
 */
const COST_ROW_ROUNDING_NOTE =
  'Each row’s Cost is that person’s pay for the period split across their entries, so the ' +
  'column adds up to the total exactly; a single row can sit a few cents from its own hours ' +
  'times the rate.'

export function ReportsPage() {
  const { data, billingPeriod, ownerMode, firmSettings } = useAppContext()
  const defaultHourlyRate = firmSettings.clientDefaults?.hourlyRate ?? 0

  // Toggle: default ON shows only current team members; flip off to fold
  // in former (soft-deleted) team members so their historical hours are
  // still attributed in the breakdown.
  const [currentTeamOnly, setCurrentTeamOnly] = useState(true)

  /**
   * Cost/pay rates, keyed by team member id.
   *
   * Sourced from /api/team rather than app-data ON PURPOSE. `cost_rate` is
   * owner-only pay data and `read()` deliberately does not select it, so it
   * never enters the shared workspace blob that staff sessions receive. The
   * team endpoint is already owner-gated (403 otherwise) and this page is
   * owner-only, so reading it here adds no new exposure.
   *
   * A missing entry means NO cost rate, which is not an error: an owner draws
   * no hourly wage, so their time carries no labor cost and the column shows
   * "—" for them permanently.
   */
  const [costRates, setCostRates] = useState<Record<string, number | null>>({})
  useEffect(() => {
    const controller = new AbortController()
    fetchTeam(controller.signal)
      .then(({ users }) =>
        setCostRates(
          Object.fromEntries(users.map((member) => [member.id, member.costRate ?? null])),
        ),
      )
      // Non-fatal: the Cost column simply reads "—" if rates can't be loaded.
      .catch(() => {})
    return () => controller.abort()
  }, [])

  if (!ownerMode) {
    return null
  }

  // Owners ARE included in the employee report now: the firm bills the owner's
  // own billable hours off her bill rate, so excluding owners made the team
  // billable total read zero whenever an owner did the billable work.
  const inactiveEmployees = data.inactiveEmployees ?? []
  const employeesForReport = currentTeamOnly
    ? data.employees
    : [...data.employees, ...inactiveEmployees]
  const employeesForNameLookup = [...data.employees, ...inactiveEmployees]

  const billingPeriodEntries = data.timeEntries.filter((entry) =>
    isInBillingPeriod(entry, billingPeriod),
  )
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)
  const ownerInvoiceTotal = data.clients.reduce(
    (total, client) =>
      total +
      getInvoice(
        client,
        data.timeEntries,
        data.plans,
        billingPeriod,
        data.reimbursements ?? [],
        data.recurringReimbursements ?? [],
        data.employees,
        defaultHourlyRate,
      ).total,
    0,
  )
  const ownerBillableMinutes = sumBillableMinutes(billingPeriodEntries)
  const ownerInternalMinutes = billingPeriodEntries
    .filter((entry) => !entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  /**
   * Minutes as LOGGED — the denominator for anything that divides one slice of
   * the logged time by the whole (billable mix, the hours-by-task bars). It
   * deliberately still counts every full-mode slice, because those bars and
   * ratios are built from the same un-deduped per-entry sums.
   */
  const ownerLoggedMinutes = ownerBillableMinutes + ownerInternalMinutes
  /** Wall time actually worked: a full-mode group block counts once. */
  const ownerTrackedMinutes = sumTrackedMinutes(billingPeriodEntries)
  const activeClientCount = new Set(billingPeriodEntries.map((entry) => entry.clientId)).size

  const employeeReportRows: EmployeeReportRow[] = employeesForReport
    .map((employee) => {
      const entries = billingPeriodEntries.filter((entry) => entry.employeeId === employee.id)
      const billableEntryMinutes = sumBillableMinutes(entries)
      // Tracked is WALL TIME (full-mode group blocks counted once); billable is
      // not deduped, so tracked is no longer billable + internal by definition.
      const totalMinutes = sumTrackedMinutes(entries)
      const billRate = typeof employee.billRate === 'number' ? employee.billRate : 0
      // THE ROWS, kept. Hours and money are both built from these — the sum of
      // the rows' two-decimal hours — so the printed Hours cell multiplies
      // straight into the money beside it (featreq-7c8f64d7).
      const duplicates = duplicateFullSliceIds(entries)
      const trackedRowMinutes = entries
        .filter((entry) => !duplicates.has(entry.id))
        .map((entry) => entry.minutes)
      const billableRowMinutes = entries
        .filter((entry) => entry.billable)
        .map((entry) => entry.minutes)

      return {
        employeeId: employee.id,
        minutes: totalMinutes,
        billableMinutes: billableEntryMinutes,
        trackedRowMinutes,
        billableRowMinutes,
        hours: periodDisplayHours(trackedRowMinutes),
        billableHours: periodDisplayHours(billableRowMinutes),
        internalMinutes: sumInternalMinutes(entries),
        entryCount: entries.length,
        clientCount: new Set(entries.map((entry) => entry.clientId)).size,
        billableAmount: periodMoney(billableRowMinutes, billRate) ?? 0,
      }
    })
    .sort((left, right) => right.minutes - left.minutes)

  const clientReportRows: ClientReportRow[] = data.clients
    .map((client) => {
      const entries = billingPeriodEntries.filter((entry) => entry.clientId === client.id)
      const billableEntryMinutes = entries
        .filter((entry) => entry.billable)
        .reduce((total, entry) => total + entry.minutes, 0)
      const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0)

      return {
        clientId: client.id,
        minutes: totalMinutes,
        billableMinutes: billableEntryMinutes,
        internalMinutes: totalMinutes - billableEntryMinutes,
        entryCount: entries.length,
        employeeCount: new Set(entries.map((entry) => entry.employeeId)).size,
        invoiceTotal: getInvoice(
          client,
          data.timeEntries,
          data.plans,
          billingPeriod,
          data.reimbursements ?? [],
          data.recurringReimbursements ?? [],
          data.employees,
          defaultHourlyRate,
        ).total,
      }
    })
    .sort((left, right) => right.minutes - left.minutes)

  // Hours by task: sum minutes grouped by the linked checklist. Entries with
  // no task fall under a synthetic "Unassigned" bucket (taskId === null).
  const taskTotals = new Map<string, TaskReportRow>()
  for (const entry of billingPeriodEntries) {
    const taskId = entry.taskId ?? null
    const key = taskId ?? '__unassigned__'
    const taskTitle = taskId
      ? data.checklists.find((checklist: Checklist) => checklist.id === taskId)?.title ??
        'Unassigned'
      : 'Unassigned'
    const existing = taskTotals.get(key) ?? {
      taskId,
      taskTitle,
      minutes: 0,
      entryCount: 0,
    }
    existing.minutes += entry.minutes
    existing.entryCount += 1
    taskTotals.set(key, existing)
  }

  const taskReportRows: TaskReportRow[] = [...taskTotals.values()].sort(
    (left, right) => right.minutes - left.minutes,
  )

  return (
    <section className="content-grid reports-layout" id="reports">
      <PrintHeader title="Owner Reports" subtitle={billingPeriodLabel} />
      <div className="page-actions no-print">
        {inactiveEmployees.length > 0 ? (
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 8 }}
            title={`${inactiveEmployees.length} former team member${
              inactiveEmployees.length === 1 ? '' : 's'
            } on file`}
          >
            <input
              type="checkbox"
              checked={currentTeamOnly}
              onChange={(event) => setCurrentTeamOnly(event.target.checked)}
            />
            <span>Current team only</span>
          </label>
        ) : null}
        <button
          type="button"
          className="ghost-action"
          onClick={() => window.print()}
        >
          <Printer size={14} />
          Print
        </button>
      </div>
      <PayrollHoursReport
        checklists={data.checklists}
        clients={data.clients}
        employees={employeesForReport}
        costRates={costRates}
        timeEntries={data.timeEntries}
      />
      <ReportsOverview
        activeClientCount={activeClientCount}
        billingPeriod={billingPeriod}
        billingPeriodEntries={billingPeriodEntries}
        billingPeriodLabel={billingPeriodLabel}
        checklists={data.checklists}
        taskRows={taskReportRows}
        clientRows={clientReportRows}
        clients={data.clients}
        costRates={costRates}
        employeeRows={employeeReportRows}
        employees={employeesForNameLookup}
        ownerBillableMinutes={ownerBillableMinutes}
        ownerInternalMinutes={ownerInternalMinutes}
        ownerInvoiceTotal={ownerInvoiceTotal}
        ownerLoggedMinutes={ownerLoggedMinutes}
        ownerTrackedMinutes={ownerTrackedMinutes}
      />
    </section>
  )
}

/**
 * Payroll hours report: total hours worked per team member over a WEEKLY or
 * BI-WEEKLY period, independent of the billing month. Both period types are
 * anchored to the app's Sun–Sat week (the same weeks staff submit), so bi-weekly
 * = two consecutive Sun–Sat weeks. To line the bi-weekly window up with the
 * firm's payroll cycle, the owner sets the start date (or navigates) to a day in
 * their pay period's first week; Prev/Next then steps by a full period, keeping
 * the cadence.
 */
/**
 * One (day × member × job × task) bucket — the COLLAPSED shape, used only by
 * the "By day & job (summary)" CSV. The on-screen/printed table reports every
 * entry individually (see {@link PayrollEntryRow}).
 */
type PayrollSummaryRow = {
  key: string
  date: string
  member: string
  /** The client the time is billed to; '(Admin)' for non-client time. */
  job: string
  task: string
  minutes: number
  billableMinutes: number
}

/**
 * ONE TIME ENTRY, reported on its own row. Entries are never merged: two
 * stretches on the same client and task are two separate lines with their own
 * clock in/out, because payroll has to be auditable entry by entry.
 */
type PayrollEntryRow = {
  id: string
  date: string
  /** Kept so the row can resolve its own person's bill/cost rate. */
  employeeId: string
  member: string
  job: string
  task: string
  /** First start / last stop of the entry; '' when it was logged as minutes only. */
  clockIn: string
  clockOut: string
  sessionCount: number
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
}

/** All the work logged on a single day, plus that day's total. */
/**
 * `hours` is the sum of the DISPLAYED hours of the rows underneath it (skipping
 * full-mode repeats), so a day subtotal always equals the column above it, and
 * the grand total is in turn the sum of the day subtotals. Both levels
 * reconcile because the composition is the same at each one.
 */
type PayrollDayGroup = { date: string; hours: number; rows: PayrollEntryRow[] }

function PayrollHoursReport({
  checklists,
  clients,
  employees,
  costRates,
  timeEntries,
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  /** Cost/pay rate by member id; missing or null = no cost rate (see below). */
  costRates: Record<string, number | null>
  timeEntries: TimeEntry[]
}) {
  const [periodType, setPeriodType] = useState<'weekly' | 'biweekly'>('biweekly')
  // Reference date for the period; the window snaps to its Sun–Sat week.
  const [anchorDate, setAnchorDate] = useState<string>(() => localDateOnly())
  // Detail scope: 'all' or one team member (payroll is usually run per person).
  const [memberFilter, setMemberFilter] = useState<string>('all')

  const spanDays = periodType === 'weekly' ? 7 : 14
  const start = weekStartOf(anchorDate)
  const end = addDays(start, spanDays - 1)

  // Scope to the report's roster so the summary and the day/job detail always
  // add up to the same total (entries from off-roster members are excluded).
  const rosterIds = useMemo(() => new Set(employees.map((employee) => employee.id)), [employees])
  const inRange = useMemo(
    () =>
      timeEntries.filter(
        (entry) =>
          typeof entry.date === 'string' &&
          entry.date >= start &&
          entry.date <= end &&
          rosterIds.has(entry.employeeId),
      ),
    [timeEntries, start, end, rosterIds],
  )

  const rows = useMemo(
    () =>
      employees
        .map((employee) => {
          const entries = inRange.filter((entry) => entry.employeeId === employee.id)
          // Billable is NOT deduped (a full-mode split bills each client the
          // whole block on purpose); hours worked IS, so the two no longer add
          // up to each other and `minutes` is computed on its own.
          const billable = sumBillableMinutes(entries)
          const internal = sumInternalMinutes(entries)
          // null = no rate configured, rendered as "—" rather than "$0.00".
          const rate =
            typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
              ? employee.billRate
              : null
          // Row minutes, not just their sum: the costing hours are the sum of
          // the ROWS' two-decimal hours (featreq-7c8f64d7), which is also the
          // figure this table prints.
          const duplicates = duplicateFullSliceIds(entries)
          const trackedRowMinutes = entries
            .filter((entry) => !duplicates.has(entry.id))
            .map((entry) => entry.minutes)
          const billableRowMinutes = entries
            .filter((entry) => entry.billable)
            .map((entry) => entry.minutes)
          return {
            id: employee.id,
            name: employee.name,
            minutes: sumTrackedMinutes(entries),
            billable,
            internal,
            trackedRowMinutes,
            billableRowMinutes,
            hours: periodDisplayHours(trackedRowMinutes),
            billableHours: periodDisplayHours(billableRowMinutes),
            amount: periodMoney(billableRowMinutes, rate),
            count: entries.length,
          }
        })
        .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    [employees, inRange],
  )

  /**
   * TOTALS ARE THE SUM OF THE ROWS ON SCREEN, not the rounding of the minutes
   * behind them. Three rows of 0.17h + 0.17h + 0.75h read 1.09h even though the
   * underlying 10 + 10 + 45 minutes round to 1.08h — and 1.09 is the honest
   * total, because it is the one the owner gets when she adds the column.
   *
   * This was tolerable while Hours was a reading aid beside an exact Minutes
   * column. Hours is now the costing figure and the only time column on the
   * report, so a total that contradicts its own column is not tolerable.
   */
  const totalHours = sumDisplayHours(rows.map((row) => row.hours))
  const totalBillableHours = sumDisplayHours(rows.map((row) => row.billableHours))
  const totalAmount = rows.reduce((sum, row) => sum + (row.amount ?? 0), 0)
  const fmtDay = (iso: string) => shortDate.format(new Date(`${iso}T12:00:00`))
  const rangeLabel = `${fmtDay(start)} – ${fmtDay(end)}`

  const step = (direction: -1 | 1) => setAnchorDate(addDays(start, direction * spanDays))
  const goThisPeriod = () => setAnchorDate(localDateOnly())

  // "Job" = the client the time is billed to; admin time has no client.
  const checklistTitleById = useMemo(
    () => new Map(checklists.map((checklist) => [checklist.id, checklist.title])),
    [checklists],
  )
  const jobOf = (entry: TimeEntry) =>
    entry.isAdministrative || !entry.clientId ? '(Admin)' : clientName(clients, entry.clientId)
  const taskOf = (entry: TimeEntry) =>
    (entry.taskId ? checklistTitleById.get(entry.taskId) : entry.taskLabel?.trim()) || 'Unassigned'

  const detailEntries = useMemo(
    () =>
      memberFilter === 'all'
        ? inRange
        : inRange.filter((entry) => entry.employeeId === memberFilter),
    [inRange, memberFilter],
  )

  /**
   * EVERY time entry, on its own row, grouped under its day. Entries are NOT
   * collapsed by (day, job, task) any more: two stretches of work on the same
   * client are two separate lines with their own clock in/out, because payroll
   * has to be auditable entry by entry. Within a day, rows run in clock-in
   * order; minutes-only entries (no timestamps) come last.
   *
   * Day subtotals count a full-mode group's wall time ONCE — see
   * `duplicateFullSliceIds`. Those rows still render (and still bill); they
   * just carry a "counted once" hint so the subtotal is explainable.
   */
  const dayGroups = useMemo<PayrollDayGroup[]>(() => {
    const rows = detailEntries.map((entry) => {
      const spans = effectiveSessions(entry)
      const first = spans[0]
      const last = spans[spans.length - 1]
      const startedAtMs = first ? Date.parse(first.startAt) : Number.NaN
      return {
        id: entry.id,
        date: entry.date,
        employeeId: entry.employeeId,
        member: employeeName(employees, entry.employeeId),
        job: jobOf(entry),
        task: taskOf(entry),
        clockIn: first ? formatAuditStamp(first.startAt) : '',
        clockOut: last ? formatAuditStamp(last.endAt) : '',
        sessionCount: spans.length,
        minutes: entry.minutes,
        billable: entry.billable,
        billableMinutes: entry.billable ? entry.minutes : 0,
        groupId: entry.groupId,
        groupAllocation: entry.groupAllocation,
        startedAtMs: Number.isNaN(startedAtMs) ? Number.POSITIVE_INFINITY : startedAtMs,
        countedElsewhere: false,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailEntries, employees, clients, checklistTitleById])

  // The collapsed (day × member × job × task) view — CSV export only.
  const daySummaryRows = useMemo<PayrollSummaryRow[]>(() => {
    const byKey = new Map<string, PayrollSummaryRow>()
    for (const entry of detailEntries) {
      const job = jobOf(entry)
      const task = taskOf(entry)
      const key = `${entry.date}|${entry.employeeId}|${job}|${task}`
      const existing = byKey.get(key)
      if (existing) {
        existing.minutes += entry.minutes
        if (entry.billable) existing.billableMinutes += entry.minutes
      } else {
        byKey.set(key, {
          key,
          date: entry.date,
          member: employeeName(employees, entry.employeeId),
          job,
          task,
          minutes: entry.minutes,
          billableMinutes: entry.billable ? entry.minutes : 0,
        })
      }
    }
    return [...byKey.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.member.localeCompare(b.member) ||
        a.job.localeCompare(b.job) ||
        a.task.localeCompare(b.task),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailEntries, employees, clients, checklistTitleById])

  // Grand total = the sum of the DAY SUBTOTALS, each of which is the sum of its
  // own rows. Every level of the table adds up to the level above it.
  const detailHours = sumDisplayHours(dayGroups.map((group) => group.hours))
  const detailRows = dayGroups.flatMap((group) => group.rows)
  const showMemberColumn = memberFilter === 'all'
  // Columns before Hours: Day/job, [Team member], Task, Clock in, Clock out, Sessions.
  const labelSpan = showMemberColumn ? 6 : 5

  // Billable $ from the person's bill rate — the SAME basis the overview's
  // `billableAmount` already uses, so the two reports can't disagree. It is
  // revenue, not what the firm pays out: there is no pay-rate field, which is
  // exactly why the column is labeled "Billable $" and not "Cost".
  const billRateOf = (employeeId: string) => {
    const employee = employees.find((candidate) => candidate.id === employeeId)
    return typeof employee?.billRate === 'number' && !Number.isNaN(employee.billRate)
      ? employee.billRate
      : null
  }
  /**
   * `null` = this person has NO bill rate configured, which is different from
   * earning $0 and must not be printed as "$0.00". Half the roster has no rate
   * set in production, so rendering those as zero would put a wrong number on a
   * payroll document. They render as "—" instead.
   */

  const money = (amount: number | null) => (amount === null ? '—' : currency.format(amount))

  /**
   * Labor COST — what the firm pays for the time. Distinct from Billable $ in
   * two ways that both matter:
   *
   *  - it uses the cost/pay rate, not the bill rate; and
   *  - it applies to ALL hours worked, not just billable ones. You pay for
   *    internal time too, which is the whole point of comparing the two.
   *
   * Priced by `personPeriodCost` off the person's two-decimal hours — the same
   * hours printed in the Hours cell — so the Cost cell is reproducible by hand
   * and a column of these adds up to the total printed underneath it. `null` =
   * no cost rate, and for an OWNER that is the correct, permanent answer rather
   * than a missing value: an owner draws no hourly wage, so her time carries no
   * labor cost. Never render it as $0.00, and never treat the blank as
   * something to be filled in.
   */
  const costFor = (employeeId: string, minutesPerRow: number[]) =>
    periodMoney(minutesPerRow, costRates[employeeId])

  // Every cost total is the SUM OF THE PER-PERSON CENTS, never a float sum of
  // the parts — that is what lets the owner add the Cost column up by hand.
  const totalCost = sumPersonCosts(rows.map((row) => costFor(row.id, row.trackedRowMinutes)))

  // Cost counts a full-mode group's wall time once — the firm pays for the
  // block, not for each client it was billed to — and `laborCost` groups by
  // person before rounding, so this lands on the same rule as the table above.
  const detailCost = laborCost(detailRows, (employeeId) => costRates[employeeId])

  /**
   * Per-ENTRY Cost cells, by row id.
   *
   * A row cannot be priced on its own AND add up to what the person is paid for
   * the period — that is the grain conflict, and the total is the half that has
   * to be right. So each person's period cost is split across their own rows
   * (`allocatePersonCost`), which makes the column sum EXACTLY at the price of a
   * row landing a penny or two off its own hours × rate. Full-mode repeats are
   * excluded and render "—": the firm pays for the block once.
   */
  const detailCostByRowId = (() => {
    const rowsByEmployee = new Map<string, { id: string; minutes: number }[]>()
    for (const row of detailRows) {
      if (row.countedElsewhere) continue
      const mine = rowsByEmployee.get(row.employeeId) ?? []
      mine.push({ id: row.id, minutes: row.minutes })
      rowsByEmployee.set(row.employeeId, mine)
    }
    const byRowId = new Map<string, number | null>()
    for (const [employeeId, mine] of rowsByEmployee) {
      const costs = allocatePersonCost(
        mine.map((row) => row.minutes),
        costRates[employeeId],
      )
      mine.forEach((row, index) => byRowId.set(row.id, costs[index]))
    }
    return byRowId
  })()
  const rowCostOf = (rowId: string) => detailCostByRowId.get(rowId) ?? null

  // Billable hours and $ are NOT deduped: full mode bills each client the whole
  // block deliberately, and this is the billing side of the report. The hours
  // total is still the sum of the displayed rows.
  const detailBillableHours = sumDisplayHours(
    detailRows.map((row) => displayHours(row.billableMinutes)),
  )

  /**
   * Per-ENTRY Billable $ cells, by row id — the same treatment Cost gets above,
   * and for the same reason.
   *
   * Pricing each row off its own raw minutes is what put $1,631.69 under a
   * billable-hours column reading 14.16 (14.16 x 115 = $1,628.40). The person's
   * period total is the half that has to be right, so it is `periodMoney` off
   * the displayed hours, and the rows are a largest-remainder split of it.
   */
  const detailAmountByRowId = (() => {
    const rowsByEmployee = new Map<string, { id: string; minutes: number }[]>()
    for (const row of detailRows) {
      const mine = rowsByEmployee.get(row.employeeId) ?? []
      mine.push({ id: row.id, minutes: row.billableMinutes })
      rowsByEmployee.set(row.employeeId, mine)
    }
    const byRowId = new Map<string, number | null>()
    for (const [employeeId, mine] of rowsByEmployee) {
      const amounts = allocatePersonCost(
        mine.map((row) => row.minutes),
        billRateOf(employeeId),
      )
      mine.forEach((row, index) => byRowId.set(row.id, amounts[index]))
    }
    return byRowId
  })()
  const rowAmountOf = (rowId: string) => detailAmountByRowId.get(rowId) ?? null

  const detailAmount = detailRows.reduce(
    (sum, row) => sum + (rowAmountOf(row.id) ?? 0),
    0,
  )

  // The original five columns keep their names and positions — they are what
  // the owner's own spreadsheets point at. `Cost` is appended after them. The
  // exact-minutes and 4dp-hours columns that used to follow are gone: they
  // existed only to re-derive a cost the printed hours could not reproduce, and
  // `Tracked hours` × rate now reproduces `Cost` on its own.
  const exportCsv = () =>
    downloadCsv(
      `payroll-hours-${periodType}-${start}.csv`,
      ['Employee', 'Tracked hours', 'Billable hours', 'Internal hours', 'Entries', 'Cost'],
      [
        ...rows.map((row) => [
          row.name,
          row.hours.toFixed(2),
          row.billableHours.toFixed(2),
          decimalHours(row.internal),
          row.count,
          // Blank, not 0.00, when the person has no cost rate.
          costFor(row.id, row.trackedRowMinutes)?.toFixed(2) ?? '',
        ]),
        // Same summed-rows total the on-screen footer shows, so the CSV and the
        // printout can never hand her two different numbers.
        ['TOTAL', totalHours.toFixed(2), '', '', '', totalCost.toFixed(2)],
      ],
    )

  // Total time by day by job — the aggregated breakdown, ready to pivot. This
  // stays COLLAPSED on purpose; the table below (and the Raw hours CSV) are the
  // per-entry surfaces.
  const exportByDayJob = () =>
    downloadCsv(
      `payroll-hours-by-day-job-${periodType}-${start}.csv`,
      ['Date', 'Team member', 'Job', 'Task', 'Hours', 'Billable hours'],
      daySummaryRows.map((row) => [
        row.date,
        row.member,
        row.job,
        row.task,
        decimalHours(row.minutes),
        decimalHours(row.billableMinutes),
      ]),
    )

  // Raw hours: one row per time entry, including the CLOCK IN / CLOCK OUT stamps
  // so payroll can be audited against when the work actually happened. An entry
  // logged as minutes only (no timer/manual timestamps) leaves them blank; a
  // multi-session entry reports its first start and last stop, with the session
  // count so a split day is obvious.
  const exportRawHours = () =>
    downloadCsv(
      `payroll-raw-hours-${periodType}-${start}.csv`,
      [
        'Date',
        'Team member',
        'Client',
        'Task',
        'Clock in',
        'Clock out',
        'Sessions',
        'Hours',
        'Billable',
        'Billable hours',
        'Billable $',
        'Cost',
        'Description',
      ],
      [...detailEntries]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((entry) => {
          const spans = effectiveSessions(entry)
          const first = spans[0]
          const last = spans[spans.length - 1]
          return [
            entry.date,
            employeeName(employees, entry.employeeId),
            jobOf(entry),
            taskOf(entry),
            first ? formatAuditStamp(first.startAt) : '',
            last ? formatAuditStamp(last.endAt) : '',
            spans.length,
            decimalHours(entry.minutes),
            entry.billable ? 'Yes' : 'No',
            entry.billable ? decimalHours(entry.minutes) : '0.00',
            // Blank, not 0.00, when the person has no bill rate configured —
            // a spreadsheet should not be told they billed nothing.
            rowAmountOf(entry.id)?.toFixed(2) ?? '',
            // The SAME allocated cent the on-screen detail row shows, so the
            // export and the printout agree and the column sums to the report's
            // total. Blank when there is no cost rate — and blank on a
            // full-mode repeat, which the screen shows as "—" (the block is
            // paid once). The export used to charge every repeat again.
            rowCostOf(entry.id)?.toFixed(2) ?? '',
            entry.description ?? '',
          ]
        }),
    )

  return (
    <section className="panel report-section" id="payroll-hours">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Payroll</p>
          <h2>Hours report</h2>
        </div>
        <div className="payroll-exports no-print">
          <button type="button" className="ghost-action" onClick={exportCsv}>
            <Download size={14} /> Summary CSV
          </button>
          <button type="button" className="ghost-action" onClick={exportByDayJob}>
            <Download size={14} /> By day &amp; job (summary)
          </button>
          <button type="button" className="ghost-action" onClick={exportRawHours}>
            <Download size={14} /> Raw hours
          </button>
        </div>
      </div>

      <div className="payroll-controls no-print">
        <div className="payroll-period-toggle" role="group" aria-label="Period length">
          <button
            type="button"
            className={periodType === 'weekly' ? 'is-active' : ''}
            aria-pressed={periodType === 'weekly'}
            onClick={() => setPeriodType('weekly')}
          >
            Weekly
          </button>
          <button
            type="button"
            className={periodType === 'biweekly' ? 'is-active' : ''}
            aria-pressed={periodType === 'biweekly'}
            onClick={() => setPeriodType('biweekly')}
          >
            Bi-weekly
          </button>
        </div>
        <div className="payroll-nav">
          <button type="button" className="icon-button" aria-label="Previous period" onClick={() => step(-1)}>
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            className="payroll-date"
            aria-label="Period start date"
            value={anchorDate}
            onChange={(event) => setAnchorDate(event.target.value || localDateOnly())}
          />
          <button type="button" className="icon-button" aria-label="Next period" onClick={() => step(1)}>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="link-button" onClick={goThisPeriod}>
            This period
          </button>
        </div>
      </div>

      <p className="report-caption">
        {periodType === 'biweekly' ? 'Bi-weekly' : 'Weekly'} period: <strong>{rangeLabel}</strong>.
        {periodType === 'biweekly'
          ? ' Two Sun–Sat weeks. Set the start to a day in your pay-period’s first week to line it up with payroll; ‹ › move by a full period.'
          : ' Sun–Sat week; ‹ › move by a week.'}
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Team member</th>
              {/* Hours is the costing column: Cost is this figure × the pay
                  rate. An exact "Minutes" column used to sit beside it to
                  explain why the two didn't multiply out — that gap is gone,
                  and so is the column. */}
              <th>Hours</th>
              <th>Billable</th>
              <th>Billable $</th>
              <th>Cost</th>
              <th className="no-print">Internal</th>
              <th className="no-print">Entries</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted-text">
                  No team members to report.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.name}</strong>
                  </td>
                  {/* Hours and the money beside them come from the SAME
                      figure — the sum of this person's rows' two-decimal
                      hours — so each cell is hours x rate by hand. */}
                  <td>{row.hours.toFixed(2)}h</td>
                  <td>{row.billableHours.toFixed(2)}h</td>
                  <td>{money(row.amount)}</td>
                  {/* Cost is on HOURS WORKED, not billable hours — the firm
                      pays for internal time too. "—" for the owner. */}
                  <td>{money(costFor(row.id, row.trackedRowMinutes))}</td>
                  <td className="no-print">{formatDecimalHours(row.internal)}</td>
                  <td className="no-print">{row.count}</td>
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
                <strong>{formatHoursTotal(totalHours)}</strong>
              </td>
              <td>
                <strong>{formatHoursTotal(totalBillableHours)}</strong>
              </td>
              <td>
                <strong>{currency.format(totalAmount)}</strong>
              </td>
              {/* The sum of the cent-rounded cells directly above, so adding
                  the column up by hand lands here exactly. Members with no cost
                  rate contribute nothing — which is the firm's real labor cost. */}
              <td>
                <strong>{currency.format(totalCost)}</strong>
              </td>
              <td className="no-print" />
              <td className="no-print" />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="report-caption muted-text">{COST_BASIS_NOTE}</p>

      <div className="section-heading payroll-detail-heading">
        <div>
          <p className="section-kicker">Detail</p>
          <h3>Time by day and job</h3>
        </div>
        <label className="payroll-member-filter no-print">
          <span>Team member</span>
          <select
            value={memberFilter}
            onChange={(event) => setMemberFilter(event.target.value)}
          >
            <option value="all">All team members</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day / job</th>
              {showMemberColumn ? <th>Team member</th> : null}
              <th>Task</th>
              <th>Clock in</th>
              <th>Clock out</th>
              <th>Sessions</th>
              <th>Hours</th>
              <th>Billable</th>
              <th>Billable $</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {dayGroups.length === 0 ? (
              <tr>
                <td colSpan={labelSpan + 4} className="muted-text">
                  No time logged in this period.
                </td>
              </tr>
            ) : (
              dayGroups.map((group) => (
                <Fragment key={group.date}>
                  <tr className="payroll-day-row">
                    <td colSpan={labelSpan}>
                      <strong>{fmtDay(group.date)}</strong>
                    </td>
                    <td>
                      <strong>{formatHoursTotal(group.hours)}</strong>
                    </td>
                    <td />
                    <td />
                    <td />
                  </tr>
                  {group.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="payroll-job-cell">{row.job}</td>
                      {showMemberColumn ? <td>{row.member}</td> : null}
                      <td>{row.task}</td>
                      {/* Blank for an entry logged as minutes only — it has no
                          timestamps to report, which is itself worth seeing. */}
                      <td>{row.clockIn || '—'}</td>
                      <td>{row.clockOut || '—'}</td>
                      <td>{row.sessionCount || '—'}</td>
                      {/* Two decimals, never one. Split allocations are small by
                          construction — 33 of the 138 in production render as
                          "0.0h" under one-decimal rounding, and the rounded rows
                          add up to 2.9h more than was actually entered. */}
                      <td>
                        {formatDecimalHours(row.minutes)}
                        {row.countedElsewhere ? (
                          <div
                            className="muted-text"
                            title="Every client on this full-mode group split is billed the whole block. The hours and cost are counted once, on the first row of the group."
                          >
                            full block · counted once
                          </div>
                        ) : null}
                      </td>
                      <td>{formatDecimalHours(row.billableMinutes)}</td>
                      <td>{money(rowAmountOf(row.id))}</td>
                      {/* Deduped rows show no cost: the firm pays for the block
                          once, and the first row of the group carries it. */}
                      <td>{row.countedElsewhere ? '—' : money(rowCostOf(row.id))}</td>
                    </tr>
                  ))}
                </Fragment>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={labelSpan}>
                <strong>Total</strong>
              </td>
              <td>
                <strong>{formatHoursTotal(detailHours)}</strong>
              </td>
              <td>
                <strong>{formatHoursTotal(detailBillableHours)}</strong>
              </td>
              <td>
                <strong>{currency.format(detailAmount)}</strong>
              </td>
              <td>
                <strong>{currency.format(detailCost)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="report-caption muted-text">{COST_ROW_ROUNDING_NOTE}</p>
    </section>
  )
}

function ReportsOverview({
  activeClientCount,
  billingPeriod,
  billingPeriodEntries,
  billingPeriodLabel,
  checklists,
  taskRows,
  clientRows,
  clients,
  costRates,
  employeeRows,
  employees,
  ownerBillableMinutes,
  ownerInternalMinutes,
  ownerInvoiceTotal,
  ownerLoggedMinutes,
  ownerTrackedMinutes,
}: {
  activeClientCount: number
  billingPeriod: string
  billingPeriodEntries: TimeEntry[]
  billingPeriodLabel: string
  checklists: Checklist[]
  taskRows: TaskReportRow[]
  clientRows: ClientReportRow[]
  clients: Client[]
  /** Cost/pay rate by member id; missing or null = no cost rate. */
  costRates: Record<string, number | null>
  employeeRows: EmployeeReportRow[]
  employees: Employee[]
  ownerBillableMinutes: number
  ownerInternalMinutes: number
  ownerInvoiceTotal: number
  /** Minutes as logged (full-mode slices included) — the ratio denominator. */
  ownerLoggedMinutes: number
  ownerTrackedMinutes: number
}) {
  // Ratios and bars divide un-deduped sums, so they divide by the un-deduped
  // total; dividing by wall time would let a full-mode split read over 100%.
  const billableRate =
    ownerLoggedMinutes === 0 ? 0 : Math.round((ownerBillableMinutes / ownerLoggedMinutes) * 100)

  /**
   * Labor COST for this person's tracked hours — literally the same rule the
   * payroll tables use, via the same helper: ALL hours worked (internal
   * included) × their cost rate, cent-rounded once per person.
   *
   * `null` = no cost rate, which for an OWNER is the correct permanent answer
   * rather than a missing setting — she draws no hourly wage, so her time
   * carries no labor cost. It renders "—", never "$0.00".
   *
   * "Cent-rounded once per person" now means off that person's two-decimal
   * hours, so the Tracked hours cell beside it multiplies straight into Cost.
   */
  const overviewCostFor = (employeeId: string, minutesPerRow: number[]) =>
    periodMoney(minutesPerRow, costRates[employeeId])

  const periodSlug = billingPeriod || 'period'
  const exportEmployees = () =>
    downloadCsv(
      `employee-report-${periodSlug}.csv`,
      [
        'Employee',
        'Tracked hours',
        'Billable hours',
        'Billable $',
        'Cost',
        'Internal hours',
        'Entries',
        'Clients',
      ],
      employeeRows.map((row) => [
        employeeName(employees, row.employeeId),
        // The summed-rows hours — literally the figure Cost and Billable $ are
        // built from, so multiplying either by the rate reproduces the cell.
        row.hours.toFixed(2),
        row.billableHours.toFixed(2),
        row.billableAmount.toFixed(2),
        // Blank, not 0.00, when the person has no cost rate.
        overviewCostFor(row.employeeId, row.trackedRowMinutes)?.toFixed(2) ?? '',
        decimalHours(row.internalMinutes),
        row.entryCount,
        row.clientCount,
      ]),
    )

  const exportClients = () =>
    downloadCsv(
      `client-report-${periodSlug}.csv`,
      [
        'Client',
        'Tracked hours',
        'Billable hours',
        'Internal hours',
        'Staff',
        'Projected billing',
      ],
      clientRows.map((row) => [
        clientName(clients, row.clientId),
        decimalHours(row.minutes),
        decimalHours(row.billableMinutes),
        decimalHours(row.internalMinutes),
        row.employeeCount,
        row.invoiceTotal.toFixed(2),
      ]),
    )

  const exportTasks = () =>
    downloadCsv(
      `task-report-${periodSlug}.csv`,
      ['Task', 'Hours', 'Entries'],
      taskRows.map((row) => [row.taskTitle, decimalHours(row.minutes), row.entryCount]),
    )

  // Same bill-rate basis as the payroll report and the overview's
  // billableAmount, so no two surfaces can put a different dollar figure on the
  // same hour. Revenue, not payroll cost — there is no pay-rate field.
  const overviewAmountFor = (employeeId: string, billableMinutes: number) => {
    const employee = employees.find((candidate: Employee) => candidate.id === employeeId)
    const rate =
      typeof employee?.billRate === 'number' && !Number.isNaN(employee.billRate)
        ? employee.billRate
        : null
    return rate === null ? null : (billableMinutes / 60) * rate
  }

  const exportHoursByMonth = () => {
    const sorted = [...billingPeriodEntries].sort((a, b) => a.date.localeCompare(b.date))
    downloadCsv(
      `hours-by-month-${periodSlug}.csv`,
      [
        'Date',
        'Employee',
        'Client',
        'Task',
        'Clock in',
        'Clock out',
        'Sessions',
        'Hours',
        'Billable',
        'Billable hours',
        'Billable $',
        'Description',
      ],
      sorted.map((entry) => {
        const taskTitle = entry.taskId
          ? checklists.find((checklist: Checklist) => checklist.id === entry.taskId)?.title ??
            'Unassigned'
          : entry.taskLabel ?? 'Unassigned'
        const clientDisplay = entry.isAdministrative || !entry.clientId
          ? '(Admin)'
          : clientName(clients, entry.clientId)
        // Clock in/out = first start, last stop. Blank for minutes-only entries.
        const spans = effectiveSessions(entry)
        const first = spans[0]
        const last = spans[spans.length - 1]
        return [
          entry.date,
          employeeName(employees, entry.employeeId),
          clientDisplay,
          taskTitle,
          first ? formatAuditStamp(first.startAt) : '',
          last ? formatAuditStamp(last.endAt) : '',
          spans.length,
          decimalHours(entry.minutes),
          entry.billable ? 'Yes' : 'No',
          entry.billable ? decimalHours(entry.minutes) : '0.00',
          overviewAmountFor(entry.employeeId, entry.billable ? entry.minutes : 0)?.toFixed(2) ?? '',
          entry.description,
        ]
      }),
    )
  }

  return (
    <>
      <section className="panel report-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Owner reporting</p>
            <h2>Month summary</h2>
          </div>
        </div>
        <p className="report-caption">Reporting for {billingPeriodLabel}.</p>
        <div className="report-metric-grid">
          <ReportMetricCard
            label="Tracked hours"
            value={formatDecimalHours(ownerTrackedMinutes)}
            detail={`${formatDecimalHours(ownerBillableMinutes)} billable`}
          />
          <ReportMetricCard
            label="Internal hours"
            value={formatDecimalHours(ownerInternalMinutes)}
            detail={`${billableRate}% billable mix`}
          />
          <ReportMetricCard
            label="Projected billing"
            value={currency.format(ownerInvoiceTotal)}
            detail={`${activeClientCount} active clients`}
          />
          <ReportMetricCard
            label="Employee coverage"
            value={employeeRows.filter((row) => row.minutes > 0).length.toString()}
            detail="Staff with hours this month"
          />
        </div>
      </section>

      <section className="panel report-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Hours by person</p>
            <h2>Employee report</h2>
          </div>
          <button
            type="button"
            className="ghost-action no-print"
            onClick={exportEmployees}
          >
            <Download size={14} />
            Download CSV
          </button>
        </div>
        <ReportTable
          columns={[
            'Employee',
            'Tracked',
            'Billable',
            'Billable $',
            'Cost',
            'Internal',
            'Entries',
            'Clients',
          ]}
          rows={employeeRows.map((row) => {
            const cost = overviewCostFor(row.employeeId, row.trackedRowMinutes)
            return [
              employeeName(employees, row.employeeId),
              `${row.hours.toFixed(2)}h`,
              `${row.billableHours.toFixed(2)}h`,
              currency.format(row.billableAmount),
              // "—" (never $0.00) when there's no cost rate — see overviewCostFor.
              cost === null ? '—' : currency.format(cost),
              formatDecimalHours(row.internalMinutes),
              row.entryCount.toString(),
              row.clientCount.toString(),
            ]
          })}
        />
        {/* The same sentence the payroll report carries — this is the table she
            prints, so the basis has to be legible here too. */}
        <p className="report-caption muted-text">{COST_BASIS_NOTE}</p>
      </section>

      <section className="panel report-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Hours by client</p>
            <h2>Client report</h2>
          </div>
          <button type="button" className="ghost-action no-print" onClick={exportClients}>
            <Download size={14} />
            Download CSV
          </button>
        </div>
        <ReportTable
          columns={['Client', 'Tracked', 'Billable', 'Internal', 'Staff', 'Projected billing']}
          rows={clientRows.map((row) => [
            clientName(clients, row.clientId),
            formatDecimalHours(row.minutes),
            formatDecimalHours(row.billableMinutes),
            formatDecimalHours(row.internalMinutes),
            row.employeeCount.toString(),
            currency.format(row.invoiceTotal),
          ])}
        />
      </section>

      <section className="panel report-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Raw export</p>
            <h2>Hours by month</h2>
          </div>
          <button type="button" className="ghost-action no-print" onClick={exportHoursByMonth}>
            <Download size={14} />
            Hours by month (CSV)
          </button>
        </div>
      </section>

      <section className="panel report-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Work mix</p>
            <h2>Hours by task</h2>
          </div>
          <button type="button" className="ghost-action no-print" onClick={exportTasks}>
            <Download size={14} />
            Download CSV
          </button>
        </div>
        <div className="report-stack">
          {taskRows.length === 0 ? (
            <p className="empty-state">No time entries have been logged for this billing month yet.</p>
          ) : (
            taskRows.map((row) => {
              // Against minutes as LOGGED — `taskRows` sums every entry, so a
              // full-mode split's slices are all in the numerator too.
              const width =
                ownerLoggedMinutes === 0 ? 0 : (row.minutes / ownerLoggedMinutes) * 100
              return (
                <div className="category-row" key={row.taskId ?? '__unassigned__'}>
                  <div className="category-row-header">
                    <strong>{row.taskTitle}</strong>
                    <span>
                      {formatDecimalHours(row.minutes)} · {row.entryCount} entries
                    </span>
                  </div>
                  <div className="category-bar">
                    <span style={{ width: `${width}%` }} />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>
    </>
  )
}

function ReportMetricCard({
  detail,
  label,
  value,
}: {
  detail: string
  label: string
  value: string
}) {
  return (
    <div className="report-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function ReportTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row[0]}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${columns[cellIndex]}-${cell}`}>
                  {cellIndex === 0 ? <strong>{cell}</strong> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
