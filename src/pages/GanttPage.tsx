import { useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { FilterBar } from '../components/FilterBar'
import { useFilters, type StatusFilter } from '../components/useFilters'
import type { Checklist, Client, Employee } from '../lib/types'
import { clientName, employeeName } from '../lib/utils'

function checklistStatus(checklist: Checklist, todayDateOnly: string): StatusFilter {
  const completed = checklist.items.filter((item) => item.done).length
  const total = checklist.items.length
  const allDone = total > 0 && completed === total
  const overdue = !allDone && checklist.dueDate < todayDateOnly
  if (allDone) return 'completed'
  if (overdue) return 'overdue'
  return 'active'
}

export function GanttPage() {
  const { data, ownerMode } = useAppContext()

  if (!ownerMode) {
    return null
  }

  return (
    <section className="content-grid" id="gantt">
      <GanttView checklists={data.checklists} clients={data.clients} employees={data.employees} />
    </section>
  )
}

function GanttView({
  checklists,
  clients,
  employees,
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
}) {
  const navigate = useNavigate()
  const { assignee, client, status } = useFilters()

  const today = new Date()
  const todayDateOnly = today.toISOString().slice(0, 10)
  const rangeStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const rangeEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0)
  const totalDays = Math.max(
    1,
    Math.round((rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24)) + 1,
  )
  const todayIndex = Math.max(
    0,
    Math.min(
      totalDays - 1,
      Math.round((today.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24)),
    ),
  )
  const todayPercent = (todayIndex / totalDays) * 100

  const monthHeaders: Array<{ label: string; widthPercent: number }> = []
  for (let monthOffset = 0; monthOffset < 2; monthOffset += 1) {
    const monthStart = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + monthOffset, 1)
    const monthEnd = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + monthOffset + 1, 0)
    const monthDays =
      Math.round((monthEnd.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)) + 1
    monthHeaders.push({
      label: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
        monthStart,
      ),
      widthPercent: (monthDays / totalDays) * 100,
    })
  }

  const filtered = checklists.filter((checklist) => {
    if (assignee && checklist.assigneeId !== assignee) return false
    if (client && checklist.clientId !== client) return false
    if (status && status !== 'all') {
      if (checklistStatus(checklist, todayDateOnly) !== status) return false
    }
    return true
  })

  const groupedByAssignee = new Map<string, Checklist[]>()
  for (const checklist of filtered) {
    const existing = groupedByAssignee.get(checklist.assigneeId) ?? []
    existing.push(checklist)
    groupedByAssignee.set(checklist.assigneeId, existing)
  }

  const orderedGroups = [...groupedByAssignee.entries()].sort((left, right) =>
    employeeName(employees, left[0]).localeCompare(employeeName(employees, right[0])),
  )

  const computeBarMetrics = (checklist: Checklist) => {
    const dueDateOnly = checklist.dueDate
    const dueDate = new Date(`${dueDateOnly}T12:00:00`)
    const startSource = checklist.createdAt
      ? new Date(`${checklist.createdAt}T12:00:00`)
      : new Date(dueDate.getTime() - 7 * 24 * 60 * 60 * 1000)

    const startMs = Math.max(rangeStart.getTime(), startSource.getTime())
    const endMs = Math.min(rangeEnd.getTime() + 24 * 60 * 60 * 1000 - 1, dueDate.getTime())
    const inRange =
      endMs >= rangeStart.getTime() && startMs <= rangeEnd.getTime() + 24 * 60 * 60 * 1000

    const startDayIndex = Math.max(
      0,
      Math.round((startMs - rangeStart.getTime()) / (1000 * 60 * 60 * 24)),
    )
    const endDayIndex = Math.min(
      totalDays,
      Math.max(
        startDayIndex + 1,
        Math.round((endMs - rangeStart.getTime()) / (1000 * 60 * 60 * 24)) + 1,
      ),
    )

    const completed = checklist.items.filter((item) => item.done).length
    const total = checklist.items.length
    const allDone = total > 0 && completed === total
    const noneDone = completed === 0
    const overdue = !allDone && dueDateOnly < todayDateOnly

    let stateClass = 'gantt-bar-not-started'
    if (overdue) {
      stateClass = 'gantt-bar-overdue'
    } else if (allDone) {
      stateClass = 'gantt-bar-done'
    } else if (!noneDone) {
      stateClass = 'gantt-bar-progress'
    }

    return {
      inRange,
      leftPercent: (startDayIndex / totalDays) * 100,
      widthPercent: Math.max(1, ((endDayIndex - startDayIndex) / totalDays) * 100),
      diamondPercent:
        (Math.max(
          0,
          Math.min(
            totalDays - 1,
            Math.round((dueDate.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24)),
          ),
        ) /
          totalDays) *
        100,
      completed,
      total,
      stateClass,
    }
  }

  const goToChecklist = (checklistId: string) => {
    navigate(`/checklists?focus=${checklistId}`)
  }

  return (
    <section className="panel gantt-panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner planning</p>
          <h2>Checklist Gantt</h2>
        </div>
      </div>
      <FilterBar employees={employees} clients={clients} />
      <p className="report-caption">
        One bar per checklist instance, grouped by assignee. Click any row to open the underlying
        checklist.
      </p>
      <div className="gantt-legend">
        <span className="gantt-legend-swatch gantt-bar-not-started" /> Not started
        <span className="gantt-legend-swatch gantt-bar-progress" /> In progress
        <span className="gantt-legend-swatch gantt-bar-done" /> Completed
        <span className="gantt-legend-swatch gantt-bar-overdue" /> Overdue
      </div>
      <div className="gantt-wrap">
        <div className="gantt-header">
          {monthHeaders.map((header) => (
            <div
              className="gantt-month"
              key={header.label}
              style={{ width: `${header.widthPercent}%` }}
            >
              {header.label}
            </div>
          ))}
        </div>
        {orderedGroups.length === 0 ? (
          <p className="empty-state">No checklist instances to plot.</p>
        ) : (
          orderedGroups.map(([assigneeId, group]) => (
            <div className="gantt-group" key={assigneeId}>
              <div className="gantt-group-label">{employeeName(employees, assigneeId)}</div>
              <div className="gantt-rows">
                {group
                  .map((checklist) => ({ checklist, metrics: computeBarMetrics(checklist) }))
                  .filter(({ metrics }) => metrics.inRange)
                  .map(({ checklist, metrics }) => (
                    <button
                      type="button"
                      className="gantt-row gantt-row-clickable"
                      key={checklist.id}
                      onClick={() => goToChecklist(checklist.id)}
                      aria-label={`Open ${checklist.title}`}
                    >
                      <div className="gantt-track">
                        <div
                          className="gantt-today"
                          style={{ left: `${todayPercent}%` }}
                          aria-hidden="true"
                        />
                        <div
                          className={`gantt-bar ${metrics.stateClass}`}
                          style={{
                            left: `${metrics.leftPercent}%`,
                            width: `${metrics.widthPercent}%`,
                          }}
                          title={`${checklist.title} - ${clientName(clients, checklist.clientId)} - ${metrics.completed}/${metrics.total} complete`}
                        >
                          <span className="gantt-bar-label">{checklist.title}</span>
                        </div>
                        <div
                          className="gantt-diamond"
                          style={{ left: `calc(${metrics.diamondPercent}% - 6px)` }}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="gantt-meta">
                        <strong>{checklist.title}</strong>
                        <span>
                          {clientName(clients, checklist.clientId)} · {metrics.completed}/
                          {metrics.total} done
                        </span>
                      </div>
                    </button>
                  ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
