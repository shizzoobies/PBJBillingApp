import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppContext } from '../AppContext'
import type { TimeEntry } from '../lib/types'
import {
  clientName,
  currentWeekStart,
  employeeName,
  formatHoursMinutes,
  getWeekLabel,
  sessionMinutes,
  shiftWeek,
  weekRangeOf,
} from '../lib/utils'

// One row in the timesheet: a single work session, or the whole entry when it
// has no session breakdown (legacy/manual entries).
type Segment = {
  entry: TimeEntry
  startAt?: string
  endAt?: string
  minutes: number
}

function entrySegments(entry: TimeEntry): Segment[] {
  if (entry.sessions && entry.sessions.length > 0) {
    return entry.sessions.map((session) => ({
      entry,
      startAt: session.startAt,
      endAt: session.endAt,
      minutes: sessionMinutes(session),
    }))
  }
  return [{ entry, startAt: entry.startAt, endAt: entry.endAt, minutes: entry.minutes }]
}

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
})

function formatClock(iso?: string) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : TIME_FMT.format(date)
}

function formatDayLabel(date: string) {
  const parsed = new Date(`${date}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(parsed)
  return `${weekday} ${parsed.getMonth() + 1}/${parsed.getDate()}`
}

export function TimesheetPage() {
  const { data, role, visibleEntries, activeEmployeeId } = useAppContext()
  const employees = data.employees
  const clients = data.clients
  const checklists = data.checklists

  const [weekStart, setWeekStart] = useState(currentWeekStart)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(activeEmployeeId)

  // Owners pick whose timesheet to view; everyone else sees their own.
  const viewedEmployeeId = role === 'owner' ? selectedEmployeeId : activeEmployeeId
  const { start, end } = weekRangeOf(weekStart)

  const days = useMemo(() => {
    const inWeek = visibleEntries.filter(
      (entry) =>
        entry.employeeId === viewedEmployeeId && entry.date >= start && entry.date <= end,
    )
    const byDate = new Map<string, Segment[]>()
    for (const entry of inWeek) {
      const list = byDate.get(entry.date) ?? []
      list.push(...entrySegments(entry))
      byDate.set(entry.date, list)
    }
    return [...byDate.entries()]
      // Most-recent day first, like the rest of the time views.
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, segments]) => ({
        date,
        segments: segments
          .slice()
          .sort((x, y) => (x.startAt ?? '').localeCompare(y.startAt ?? '')),
        total: segments.reduce((sum, seg) => sum + seg.minutes, 0),
      }))
  }, [visibleEntries, viewedEmployeeId, start, end])

  const weekTotal = days.reduce((sum, day) => sum + day.total, 0)

  const taskTitle = (entry: TimeEntry) => {
    if (entry.isAdministrative) return 'Administrative'
    if (!entry.taskId) return null
    return checklists.find((checklist) => checklist.id === entry.taskId)?.title ?? null
  }

  return (
    <section className="content-grid" id="timesheet">
      <header className="page-header time-page-header">
        <div>
          <p className="section-kicker">Time tracking</p>
          <h1>Timesheet</h1>
          <p className="productivity-subtitle">
            What {role === 'owner' ? 'each person' : 'you'} worked on, day by day.
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="timesheet-toolbar">
          <div className="timesheet-weeknav">
            <button
              type="button"
              className="icon-button"
              aria-label="Previous week"
              onClick={() => setWeekStart((current) => shiftWeek(current, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="timesheet-weeklabel">{getWeekLabel(weekStart)}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Next week"
              onClick={() => setWeekStart((current) => shiftWeek(current, 1))}
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              className="ghost-action"
              onClick={() => setWeekStart(currentWeekStart())}
            >
              This week
            </button>
          </div>

          <div className="timesheet-toolbar-right">
            {role === 'owner' ? (
              <label className="field timesheet-employee">
                <span>Team member</span>
                <select
                  className="input"
                  value={selectedEmployeeId}
                  onChange={(event) => setSelectedEmployeeId(event.target.value)}
                >
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="timesheet-weektotal">
              <span>Week total</span>
              <strong>{formatHoursMinutes(weekTotal)}</strong>
            </div>
          </div>
        </div>

        {days.length === 0 ? (
          <p className="empty-state">
            No time logged for {employeeName(employees, viewedEmployeeId)} this week.
          </p>
        ) : (
          <div className="timesheet-days">
            {days.map((day) => (
              <div className="timesheet-day" key={day.date}>
                <div className="timesheet-day-head">
                  <strong>{formatDayLabel(day.date)}</strong>
                  <span className="timesheet-day-total">{formatHoursMinutes(day.total)}</span>
                </div>
                <div className="timesheet-rows">
                  {day.segments.map((segment, index) => {
                    const title = taskTitle(segment.entry)
                    const client = segment.entry.isAdministrative
                      ? 'Administrative'
                      : clientName(clients, segment.entry.clientId)
                    return (
                      <div className="timesheet-row" key={`${segment.entry.id}-${index}`}>
                        <div className="timesheet-row-what">
                          <span className="timesheet-client">{client}</span>
                          {title && title !== client ? (
                            <span className="timesheet-task">{title}</span>
                          ) : null}
                          {segment.entry.description ? (
                            <span className="timesheet-desc">{segment.entry.description}</span>
                          ) : null}
                        </div>
                        <span className="timesheet-time">{formatClock(segment.startAt)}</span>
                        <span className="timesheet-arrow">→</span>
                        <span className="timesheet-time">{formatClock(segment.endAt)}</span>
                        <span className="timesheet-dur">{formatHoursMinutes(segment.minutes)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}
