import { useMemo, useState } from 'react'
import { filterCompletedTaskRows, type CompletedTaskRow } from '../lib/completedTasks'
import type { Client, Employee } from '../lib/types'
import { clientName, employeeName } from '../lib/utils'

/**
 * Completed tasks — the history of finished work, by client.
 *
 * READ-ONLY BY CONSTRUCTION. It is handed data and nothing else: no toggle, no
 * edit, no re-open callback exists on this component, so there is no control
 * here that could change a task even by accident. Re-opening something is done
 * from In progress, where the permission checks live.
 *
 * SCOPING happened in `completedTaskRows`, which reuses `openTaskAssigneeScope`
 * — the same rule as the open-tasks badge, so "an accountant sees their
 * bookkeepers" has one definition in the app. The rows arrive already narrowed;
 * this component never widens them.
 */
export function CompletedTasksSection({
  rows,
  clients,
  employees,
}: {
  rows: CompletedTaskRow[]
  clients: Client[]
  employees: Employee[]
}) {
  const [clientFilter, setClientFilter] = useState('')
  const [personFilter, setPersonFilter] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Filter options come from the ROWS, not the whole workspace: a bookkeeper's
  // "Person" list is then just the people they can actually see here, and no
  // picker hints at a client they have no completed work for.
  const clientOptions = useMemo(() => optionsFrom(rows, 'clientId', clients), [rows, clients])
  const personOptions = useMemo(
    () => optionsFrom(rows, 'assigneeId', employees),
    [rows, employees],
  )

  const visible = useMemo(
    () =>
      filterCompletedTaskRows(rows, {
        clientId: clientFilter,
        assigneeId: personFilter,
        from,
        to,
      }),
    [rows, clientFilter, personFilter, from, to],
  )

  const hasUndated = visible.some((row) => !row.completedAt)
  const filtersActive = Boolean(clientFilter || personFilter || from || to)

  return (
    <section className="panel" id="completed-tasks">
      <div className="section-heading">
        <div>
          <h2>Completed tasks</h2>
          <p className="muted-text">
            Every finished task, newest first. This view never changes anything — it is the record.
          </p>
        </div>
      </div>

      <div className="filter-bar">
        <label className="filter-field">
          <span>Client</span>
          <select
            className="compact-input"
            value={clientFilter}
            onChange={(event) => setClientFilter(event.target.value)}
          >
            <option value="">All</option>
            {clientOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Person</span>
          <select
            className="compact-input"
            value={personFilter}
            onChange={(event) => setPersonFilter(event.target.value)}
          >
            <option value="">All</option>
            {personOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Completed from</span>
          <input
            className="compact-input"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="filter-field">
          <span>to</span>
          <input
            className="compact-input"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
      </div>

      {/* A date range cannot include a task whose completion date was never
          recorded, so say so rather than letting them silently disappear. */}
      {filtersActive && (from || to) ? (
        <p className="muted-text">
          Tasks completed before the app recorded completion dates are not shown while a date range
          is set.
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Client</th>
              <th>Completed by</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted-text">
                  {rows.length === 0
                    ? 'No completed tasks yet.'
                    : 'No completed tasks match these filters.'}
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row.checklistId}>
                  <td>
                    <strong>{row.title}</strong>
                  </td>
                  <td>{clientName(clients, row.clientId)}</td>
                  <td>{employeeName(employees, row.assigneeId)}</td>
                  <td>
                    {row.completedAt ? (
                      completedStamp(row.completedAt)
                    ) : (
                      // NOT a fabricated date. `completed_at` did not exist
                      // until recently and old rows were deliberately not
                      // backfilled, so the honest answer is that we do not know.
                      <span
                        className="muted-text"
                        title="Completed before the app recorded completion dates"
                      >
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasUndated ? (
        <p className="muted-text">
          “—” means the task was completed before the app started recording completion dates. Those
          dates were never captured, so none is shown.
        </p>
      ) : null}
    </section>
  )
}

/** Long date + time, e.g. "Aug 14, 2026, 9:41 AM". */
const completedFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function completedStamp(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : completedFormat.format(parsed)
}

/** The named records referenced by the rows, de-duplicated and sorted. */
function optionsFrom(
  rows: CompletedTaskRow[],
  key: 'clientId' | 'assigneeId',
  records: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const ids = new Set(rows.map((row) => row[key]).filter(Boolean))
  return records
    .filter((record) => ids.has(record.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
}
