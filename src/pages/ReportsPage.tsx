import { Download, Printer } from 'lucide-react'
import { useAppContext } from '../AppContext'
import { PrintHeader } from '../components/PrintHeader'
import { downloadCsv } from '../lib/csv'
import type {
  CategoryReportRow,
  Client,
  ClientReportRow,
  Employee,
  EmployeeReportRow,
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

  if (!ownerMode) {
    return null
  }

  const billingPeriodEntries = data.timeEntries.filter((entry) =>
    isInBillingPeriod(entry, billingPeriod),
  )
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)
  const ownerInvoiceTotal = data.clients.reduce(
    (total, client) =>
      total + getInvoice(client, data.timeEntries, data.plans, billingPeriod).total,
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

  const employeeReportRows: EmployeeReportRow[] = data.employees
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
        invoiceTotal: getInvoice(client, data.timeEntries, data.plans, billingPeriod).total,
      }
    })
    .sort((left, right) => right.minutes - left.minutes)

  const categoryTotals = new Map<string, CategoryReportRow>()
  for (const entry of billingPeriodEntries) {
    const existing = categoryTotals.get(entry.category) ?? {
      category: entry.category,
      minutes: 0,
      entryCount: 0,
    }
    existing.minutes += entry.minutes
    existing.entryCount += 1
    categoryTotals.set(entry.category, existing)
  }

  const categoryReportRows: CategoryReportRow[] = [...categoryTotals.values()].sort(
    (left, right) => right.minutes - left.minutes,
  )

  return (
    <section className="content-grid reports-layout" id="reports">
      <PrintHeader title="Owner Reports" subtitle={billingPeriodLabel} />
      <div className="page-actions no-print">
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
        billingPeriodLabel={billingPeriodLabel}
        categoryRows={categoryReportRows}
        clientRows={clientReportRows}
        clients={data.clients}
        employeeRows={employeeReportRows}
        employees={data.employees}
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
  billingPeriodLabel,
  categoryRows,
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
  billingPeriodLabel: string
  categoryRows: CategoryReportRow[]
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

  const exportCategories = () =>
    downloadCsv(
      `category-report-${periodSlug}.csv`,
      ['Category', 'Hours', 'Entries'],
      categoryRows.map((row) => [row.category, (row.minutes / 60).toFixed(2), row.entryCount]),
    )

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
            <p className="section-kicker">Work mix</p>
            <h2>Category breakdown</h2>
          </div>
          <button type="button" className="ghost-action no-print" onClick={exportCategories}>
            <Download size={14} />
            Download CSV
          </button>
        </div>
        <div className="report-stack">
          {categoryRows.length === 0 ? (
            <p className="empty-state">No time entries have been logged for this billing month yet.</p>
          ) : (
            categoryRows.map((row) => {
              const width =
                ownerTrackedMinutes === 0 ? 0 : (row.minutes / ownerTrackedMinutes) * 100
              return (
                <div className="category-row" key={row.category}>
                  <div className="category-row-header">
                    <strong>{row.category}</strong>
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
