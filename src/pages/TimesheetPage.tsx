import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppContext } from '../AppContext'
import { ReportPeriodControl } from '../components/ReportPeriodControl'
import {
  isInReportPeriod,
  isSingleWeek,
  presetRange,
  type ReportPeriod,
} from '../lib/reportPeriod'
import type { TimeEntry, WeeklySubmission } from '../lib/types'
import {
  clientName,
  employeeName,
  formatHours,
  formatHoursMinutes,
  getWeekLabel,
  localDateOnly,
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

/** A custom one-week (Sun–Sat) report period anchored on `weekStartIso`. */
function weekReportPeriod(weekStartIso: string): ReportPeriod {
  const { start, end } = weekRangeOf(weekStartIso)
  return { preset: 'custom', from: start, to: end }
}

export function TimesheetPage() {
  const { data, role, visibleEntries, activeEmployeeId, reportPeriod, setReportPeriod } =
    useAppContext()
  const employees = data.employees
  const clients = data.clients
  const checklists = data.checklists

  const [selectedEmployeeId, setSelectedEmployeeId] = useState(activeEmployeeId)

  // Owners pick whose timesheet to view; everyone else sees their own.
  const viewedEmployeeId = role === 'owner' ? selectedEmployeeId : activeEmployeeId

  const today = localDateOnly()
  // Single-week mode keeps the full weekly submit/lock workflow; a wider range
  // is a read-only multi-week view.
  const singleWeek = isSingleWeek(reportPeriod, today)
  // The Sun–Sat week the weekly workflow operates on (derived from the range).
  const weekStart = reportPeriod.from

  const days = useMemo(() => {
    const inRange = visibleEntries.filter(
      (entry) =>
        entry.employeeId === viewedEmployeeId && isInReportPeriod(entry.date, reportPeriod),
    )
    const byDate = new Map<string, Segment[]>()
    for (const entry of inRange) {
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
  }, [visibleEntries, viewedEmployeeId, reportPeriod])

  const rangeTotal = days.reduce((sum, day) => sum + day.total, 0)

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
          <div className="timesheet-toolbar-left">
            <ReportPeriodControl value={reportPeriod} onChange={setReportPeriod} />
            {singleWeek ? (
              <div className="timesheet-weeknav">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous week"
                  onClick={() => setReportPeriod(weekReportPeriod(shiftWeek(weekStart, -1)))}
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="timesheet-weeklabel">{getWeekLabel(weekStart)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next week"
                  onClick={() => setReportPeriod(weekReportPeriod(shiftWeek(weekStart, 1)))}
                >
                  <ChevronRight size={16} />
                </button>
                <button
                  type="button"
                  className="ghost-action"
                  onClick={() => {
                    const { from, to } = presetRange('week', today)
                    setReportPeriod({ preset: 'week', from, to })
                  }}
                >
                  This week
                </button>
              </div>
            ) : null}
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
              <span>{singleWeek ? 'Week total' : 'Total'}</span>
              <strong>{formatHoursMinutes(rangeTotal)}</strong>
            </div>
          </div>
        </div>

        {singleWeek ? (
          <WeeklyTimesheetControls
            weekStart={weekStart}
            viewedEmployeeId={viewedEmployeeId}
            weekMinutes={rangeTotal}
          />
        ) : (
          <p className="timesheet-multiweek-hint">
            Showing a multi-week range (read-only). Select a single week (Report period → This
            week) to submit or lock a timesheet.
          </p>
        )}

        {days.length === 0 ? (
          <p className="empty-state">
            No time logged for {employeeName(employees, viewedEmployeeId)} in this period.
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

/**
 * The weekly submit / lock / submission-status controls for a single Sun–Sat
 * week, derived from the report period's `weekStart`. Shown only in single-week
 * mode so the weekly workflow stays intact (a bookkeeper submits their week for
 * owner review; the owner locks it). Owners don't submit — they review — so the
 * submit button is shown only to staff for their own week.
 */
function WeeklyTimesheetControls({
  weekStart,
  viewedEmployeeId,
  weekMinutes,
}: {
  weekStart: string
  viewedEmployeeId: string
  weekMinutes: number
}) {
  const { data, role, activeEmployeeId, previewMode, submitWeeklyTimesheet } = useAppContext()
  const employees = data.employees
  const submissions: WeeklySubmission[] = data.weeklySubmissions ?? []
  const locks = data.timesheetLocks ?? []

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // The submitting/owned timesheet is the viewed employee's; a staff member can
  // only submit their OWN week.
  const isOwnWeek = viewedEmployeeId === activeEmployeeId
  const submission = submissions.find(
    (entry) => entry.userId === viewedEmployeeId && entry.weekStart === weekStart,
  )
  const monthLocked = locks.some(
    (lock) => lock.userId === viewedEmployeeId && lock.period === weekStart.slice(0, 7),
  )

  const reviewer =
    submission?.reviewedBy && submission.status !== 'pending'
      ? employees.find((employee) => employee.id === submission.reviewedBy)?.name
      : null

  // Individual entries can be sent back while the WEEK stays "pending", so the
  // week status alone never reveals that something needs redoing.
  const { start: weekFrom, end: weekTo } = weekRangeOf(weekStart)
  const sentBack = (data.timeEntries ?? []).filter(
    (entry) =>
      entry.employeeId === viewedEmployeeId &&
      entry.date >= weekFrom &&
      entry.date <= weekTo &&
      entry.approvalStatus === 'rejected',
  ).length

  // Owners review, they don't submit; staff submit only their own week and only
  // when it isn't already pending/approved (a rejected week can be resubmitted).
  const canSubmit =
    role !== 'owner' &&
    isOwnWeek &&
    !previewMode &&
    (!submission || submission.status === 'rejected')

  const buttonLabel =
    submission?.status === 'rejected'
      ? 'Resubmit this week'
      : submission?.status === 'pending'
        ? 'Awaiting review'
        : submission?.status === 'approved'
          ? 'Approved'
          : 'Submit week for review'

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await submitWeeklyTimesheet(weekStart)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="timesheet-week-controls">
      <div className="timesheet-week-status">
        <span className="status-pill">{formatHours(weekMinutes)} logged</span>
        {submission?.status === 'pending' ? (
          <span className="status-pill">Pending review</span>
        ) : null}
        {submission?.status === 'approved' ? (
          <span className="status-pill">Approved{reviewer ? ` by ${reviewer}` : ''}</span>
        ) : null}
        {submission?.status === 'rejected' ? (
          <span className="status-pill">Rejected{reviewer ? ` by ${reviewer}` : ''}</span>
        ) : null}
        {sentBack > 0 ? (
          <span
            className="status-pill status-pill--sent-back"
            title="Some entries in this week were sent back — edit and resubmit them on the Time page."
          >
            {sentBack} sent back
          </span>
        ) : null}
        {monthLocked ? <span className="status-pill">Month locked</span> : null}
      </div>

      {role !== 'owner' && isOwnWeek ? (
        <button
          type="button"
          className="primary-action"
          disabled={!canSubmit || submitting}
          onClick={handleSubmit}
          title={
            submission?.status === 'approved'
              ? 'This week is already approved.'
              : submission?.status === 'pending'
                ? 'Already submitted — an owner is reviewing.'
                : previewMode
                  ? 'Cannot submit while previewing as another user.'
                  : 'Lock this week and send it to an owner for review.'
          }
        >
          {submitting ? 'Submitting…' : buttonLabel}
        </button>
      ) : null}

      {submission?.status === 'rejected' && submission.reviewNote ? (
        <p className="auth-error" style={{ margin: 0 }}>
          <strong>Rejection note:</strong> {submission.reviewNote}
        </p>
      ) : null}
      {error ? <p className="auth-error">{error}</p> : null}
    </div>
  )
}
