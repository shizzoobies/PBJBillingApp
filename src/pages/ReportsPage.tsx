import { ChevronLeft, ChevronRight, Download, Printer } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useAppContext } from '../AppContext'
import { PrintHeader } from '../components/PrintHeader'
import { downloadCsv } from '../lib/csv'
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
  currency,
  employeeName,
  formatHours,
  getBillingPeriodLabel,
  getInvoice,
  isInBillingPeriod,
  localDateOnly,
  shortDate,
  weekStartOf,
} from '../lib/utils'

export function ReportsPage() {
  const { data, billingPeriod, ownerMode, firmSettings } = useAppContext()
  const defaultHourlyRate = firmSettings.clientDefaults?.hourlyRate ?? 0

  // Toggle: default ON shows only current team members; flip off to fold
  // in former (soft-deleted) team members so their historical hours are
  // still attributed in the breakdown.
  const [currentTeamOnly, setCurrentTeamOnly] = useState(true)

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
  const ownerBillableMinutes = billingPeriodEntries
    .filter((entry) => entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  const ownerInternalMinutes = billingPeriodEntries
    .filter((entry) => !entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  const ownerTrackedMinutes = ownerBillableMinutes + ownerInternalMinutes
  const activeClientCount = new Set(billingPeriodEntries.map((entry) => entry.clientId)).size

  const employeeReportRows: EmployeeReportRow[] = employeesForReport
    .map((employee) => {
      const entries = billingPeriodEntries.filter((entry) => entry.employeeId === employee.id)
      const billableEntryMinutes = entries
        .filter((entry) => entry.billable)
        .reduce((total, entry) => total + entry.minutes, 0)
      const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0)
      const billRate = typeof employee.billRate === 'number' ? employee.billRate : 0

      return {
        employeeId: employee.id,
        minutes: totalMinutes,
        billableMinutes: billableEntryMinutes,
        internalMinutes: totalMinutes - billableEntryMinutes,
        entryCount: entries.length,
        clientCount: new Set(entries.map((entry) => entry.clientId)).size,
        billableAmount: (billableEntryMinutes / 60) * billRate,
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
        employeeRows={employeeReportRows}
        employees={employeesForNameLookup}
        ownerBillableMinutes={ownerBillableMinutes}
        ownerInternalMinutes={ownerInternalMinutes}
        ownerInvoiceTotal={ownerInvoiceTotal}
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
/** One (day × member × job × task) bucket of the payroll detail. */
type PayrollDetailRow = {
  key: string
  date: string
  member: string
  /** The client the time is billed to; '(Admin)' for non-client time. */
  job: string
  task: string
  minutes: number
  billableMinutes: number
}

/** All the work logged on a single day, plus that day's total. */
type PayrollDayGroup = { date: string; minutes: number; rows: PayrollDetailRow[] }

function PayrollHoursReport({
  checklists,
  clients,
  employees,
  timeEntries,
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
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
          const billable = entries
            .filter((entry) => entry.billable)
            .reduce((sum, entry) => sum + entry.minutes, 0)
          const internal = entries
            .filter((entry) => !entry.billable)
            .reduce((sum, entry) => sum + entry.minutes, 0)
          return {
            id: employee.id,
            name: employee.name,
            minutes: billable + internal,
            billable,
            internal,
            count: entries.length,
          }
        })
        .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    [employees, inRange],
  )

  const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0)
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

  // Total time by DAY by JOB: entries collapsed to one row per
  // (day, member, job, task) so repeated sessions on the same work add up.
  const dayGroups = useMemo(() => {
    const byKey = new Map<string, PayrollDetailRow>()
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
    const byDate = new Map<string, PayrollDayGroup>()
    for (const row of byKey.values()) {
      const group = byDate.get(row.date) ?? { date: row.date, minutes: 0, rows: [] }
      group.rows.push(row)
      group.minutes += row.minutes
      byDate.set(row.date, group)
    }
    return [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((group) => ({
        ...group,
        rows: group.rows.sort(
          (a, b) =>
            a.member.localeCompare(b.member) ||
            a.job.localeCompare(b.job) ||
            a.task.localeCompare(b.task),
        ),
      }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailEntries, employees, clients, checklistTitleById])

  const detailMinutes = dayGroups.reduce((sum, group) => sum + group.minutes, 0)
  const showMemberColumn = memberFilter === 'all'
  const labelSpan = showMemberColumn ? 3 : 2

  const exportCsv = () =>
    downloadCsv(
      `payroll-hours-${periodType}-${start}.csv`,
      ['Employee', 'Tracked hours', 'Billable hours', 'Internal hours', 'Entries'],
      [
        ...rows.map((row) => [
          row.name,
          (row.minutes / 60).toFixed(2),
          (row.billable / 60).toFixed(2),
          (row.internal / 60).toFixed(2),
          row.count,
        ]),
        ['TOTAL', (totalMinutes / 60).toFixed(2), '', '', ''],
      ],
    )

  // Total time by day by job — the aggregated breakdown, ready to pivot.
  const exportByDayJob = () =>
    downloadCsv(
      `payroll-hours-by-day-job-${periodType}-${start}.csv`,
      ['Date', 'Team member', 'Job', 'Task', 'Hours', 'Billable hours'],
      dayGroups.flatMap((group) =>
        group.rows.map((row) => [
          row.date,
          row.member,
          row.job,
          row.task,
          (row.minutes / 60).toFixed(2),
          (row.billableMinutes / 60).toFixed(2),
        ]),
      ),
    )

  // Raw hours: one row per time entry, same columns as the monthly raw export.
  const exportRawHours = () =>
    downloadCsv(
      `payroll-raw-hours-${periodType}-${start}.csv`,
      ['Date', 'Team member', 'Client', 'Task', 'Hours', 'Billable', 'Description'],
      [...detailEntries]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((entry) => [
          entry.date,
          employeeName(employees, entry.employeeId),
          jobOf(entry),
          taskOf(entry),
          (entry.minutes / 60).toFixed(2),
          entry.billable ? 'Yes' : 'No',
          entry.description ?? '',
        ]),
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
            <Download size={14} /> By day &amp; job
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
              <th>Hours</th>
              <th className="no-print">Billable</th>
              <th className="no-print">Internal</th>
              <th className="no-print">Entries</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted-text">
                  No team members to report.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.name}</strong>
                  </td>
                  <td>{formatHours(row.minutes)}</td>
                  <td className="no-print">{formatHours(row.billable)}</td>
                  <td className="no-print">{formatHours(row.internal)}</td>
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
                <strong>{formatHours(totalMinutes)}</strong>
              </td>
              <td className="no-print" />
              <td className="no-print" />
              <td className="no-print" />
            </tr>
          </tfoot>
        </table>
      </div>

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
              <th>Hours</th>
              <th className="no-print">Billable</th>
            </tr>
          </thead>
          <tbody>
            {dayGroups.length === 0 ? (
              <tr>
                <td colSpan={labelSpan + 2} className="muted-text">
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
                      <strong>{formatHours(group.minutes)}</strong>
                    </td>
                    <td className="no-print" />
                  </tr>
                  {group.rows.map((row) => (
                    <tr key={row.key}>
                      <td className="payroll-job-cell">{row.job}</td>
                      {showMemberColumn ? <td>{row.member}</td> : null}
                      <td>{row.task}</td>
                      <td>{formatHours(row.minutes)}</td>
                      <td className="no-print">{formatHours(row.billableMinutes)}</td>
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
                <strong>{formatHours(detailMinutes)}</strong>
              </td>
              <td className="no-print" />
            </tr>
          </tfoot>
        </table>
      </div>
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
  employeeRows,
  employees,
  ownerBillableMinutes,
  ownerInternalMinutes,
  ownerInvoiceTotal,
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
  employeeRows: EmployeeReportRow[]
  employees: Employee[]
  ownerBillableMinutes: number
  ownerInternalMinutes: number
  ownerInvoiceTotal: number
  ownerTrackedMinutes: number
}) {
  const billableRate =
    ownerTrackedMinutes === 0 ? 0 : Math.round((ownerBillableMinutes / ownerTrackedMinutes) * 100)

  const periodSlug = billingPeriod || 'period'
  const exportEmployees = () =>
    downloadCsv(
      `employee-report-${periodSlug}.csv`,
      ['Employee', 'Tracked hours', 'Billable hours', 'Billable $', 'Internal hours', 'Entries', 'Clients'],
      employeeRows.map((row) => [
        employeeName(employees, row.employeeId),
        (row.minutes / 60).toFixed(2),
        (row.billableMinutes / 60).toFixed(2),
        row.billableAmount.toFixed(2),
        (row.internalMinutes / 60).toFixed(2),
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
        (row.minutes / 60).toFixed(2),
        (row.billableMinutes / 60).toFixed(2),
        (row.internalMinutes / 60).toFixed(2),
        row.employeeCount,
        row.invoiceTotal.toFixed(2),
      ]),
    )

  const exportTasks = () =>
    downloadCsv(
      `task-report-${periodSlug}.csv`,
      ['Task', 'Hours', 'Entries'],
      taskRows.map((row) => [row.taskTitle, (row.minutes / 60).toFixed(2), row.entryCount]),
    )

  const exportHoursByMonth = () => {
    const sorted = [...billingPeriodEntries].sort((a, b) => a.date.localeCompare(b.date))
    downloadCsv(
      `hours-by-month-${periodSlug}.csv`,
      ['Date', 'Employee', 'Client', 'Task', 'Hours', 'Billable', 'Description'],
      sorted.map((entry) => {
        const taskTitle = entry.taskId
          ? checklists.find((checklist: Checklist) => checklist.id === entry.taskId)?.title ??
            'Unassigned'
          : entry.taskLabel ?? 'Unassigned'
        const clientDisplay = entry.isAdministrative || !entry.clientId
          ? '(Admin)'
          : clientName(clients, entry.clientId)
        return [
          entry.date,
          employeeName(employees, entry.employeeId),
          clientDisplay,
          taskTitle,
          (entry.minutes / 60).toFixed(2),
          entry.billable ? 'Yes' : 'No',
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
            value={formatHours(ownerTrackedMinutes)}
            detail={`${formatHours(ownerBillableMinutes)} billable`}
          />
          <ReportMetricCard
            label="Internal hours"
            value={formatHours(ownerInternalMinutes)}
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
          columns={['Employee', 'Tracked', 'Billable', 'Billable $', 'Internal', 'Entries', 'Clients']}
          rows={employeeRows.map((row) => [
            employeeName(employees, row.employeeId),
            formatHours(row.minutes),
            formatHours(row.billableMinutes),
            currency.format(row.billableAmount),
            formatHours(row.internalMinutes),
            row.entryCount.toString(),
            row.clientCount.toString(),
          ])}
        />
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
            formatHours(row.minutes),
            formatHours(row.billableMinutes),
            formatHours(row.internalMinutes),
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
              const width =
                ownerTrackedMinutes === 0 ? 0 : (row.minutes / ownerTrackedMinutes) * 100
              return (
                <div className="category-row" key={row.taskId ?? '__unassigned__'}>
                  <div className="category-row-header">
                    <strong>{row.taskTitle}</strong>
                    <span>
                      {formatHours(row.minutes)} · {row.entryCount} entries
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
