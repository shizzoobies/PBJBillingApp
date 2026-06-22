import { Download, Printer } from 'lucide-react'
import { useState } from 'react'
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
  clientName,
  currency,
  employeeName,
  formatHours,
  getBillingPeriodLabel,
  getInvoice,
  isInBillingPeriod,
} from '../lib/utils'

export function ReportsPage() {
  const { data, billingPeriod, ownerMode } = useAppContext()

  // Toggle: default ON shows only current team members; flip off to fold
  // in former (soft-deleted) team members so their historical hours are
  // still attributed in the breakdown.
  const [currentTeamOnly, setCurrentTeamOnly] = useState(true)

  if (!ownerMode) {
    return null
  }

  const inactiveEmployees = (data.inactiveEmployees ?? []).filter(
    (employee) => employee.role !== 'Owner',
  )
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
    .filter((employee) => employee.role !== 'Owner')
    .map((employee) => {
      const entries = billingPeriodEntries.filter((entry) => entry.employeeId === employee.id)
      const billableEntryMinutes = entries
        .filter((entry) => entry.billable)
        .reduce((total, entry) => total + entry.minutes, 0)
      const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0)

      return {
        employeeId: employee.id,
        minutes: totalMinutes,
        billableMinutes: billableEntryMinutes,
        internalMinutes: totalMinutes - billableEntryMinutes,
        entryCount: entries.length,
        clientCount: new Set(entries.map((entry) => entry.clientId)).size,
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
      ['Employee', 'Tracked hours', 'Billable hours', 'Internal hours', 'Entries', 'Clients'],
      employeeRows.map((row) => [
        employeeName(employees, row.employeeId),
        (row.minutes / 60).toFixed(2),
        (row.billableMinutes / 60).toFixed(2),
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
          columns={['Employee', 'Tracked', 'Billable', 'Internal', 'Entries', 'Clients']}
          rows={employeeRows.map((row) => [
            employeeName(employees, row.employeeId),
            formatHours(row.minutes),
            formatHours(row.billableMinutes),
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
