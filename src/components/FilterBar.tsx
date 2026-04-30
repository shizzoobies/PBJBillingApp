import type { Client, Employee } from '../lib/types'
import { useFilters } from './useFilters'

export function FilterBar({
  employees,
  clients,
  showStatus = true,
}: {
  employees: Employee[]
  clients: Client[]
  showStatus?: boolean
}) {
  const { assignee, client, status, setAssignee, setClient, setStatus, clear, isActive } =
    useFilters()

  return (
    <div className="filter-bar">
      <label className="filter-field">
        <span>Assignee</span>
        <select
          className="compact-input"
          onChange={(event) => setAssignee(event.target.value)}
          value={assignee}
        >
          <option value="">All</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field">
        <span>Client</span>
        <select
          className="compact-input"
          onChange={(event) => setClient(event.target.value)}
          value={client}
        >
          <option value="">All</option>
          {clients.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      {showStatus ? (
        <label className="filter-field">
          <span>Status</span>
          <select
            className="compact-input"
            onChange={(event) => setStatus(event.target.value)}
            value={status}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="overdue">Overdue</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      ) : null}
      {isActive ? (
        <button type="button" className="clear-filters-link" onClick={clear}>
          Clear filters
        </button>
      ) : null}
    </div>
  )
}
