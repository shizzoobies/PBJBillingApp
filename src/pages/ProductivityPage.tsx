import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchActivityRange, fetchTeam } from '../lib/api'
import { useAppContext } from '../AppContext'
import type { ActivityEntry, Employee, TeamMember } from '../lib/types'
import { formatHours, relativeTime } from '../lib/utils'
import {
  bucketByPeriod,
  businessDaysIn,
  calendarDaysIn,
  formatPeriodLabel,
  periodsBetween,
  PRESET_LABELS,
  rangeForPreset,
  type DateRangePreset,
  type Granularity,
} from '../lib/productivity'

// Heatmap auto-switch threshold. Daily granularity over a longer span gets
// auto-bucketed to weekly to keep the cells readable.
const HEATMAP_DAILY_MAX_DAYS = 60

type SortKey =
  | 'name'
  | 'minutes'
  | 'tasks'
  | 'casesAdvanced'
  | 'casesCompleted'
  | 'avgPerDay'
  | 'lastActive'

type SortDir = 'asc' | 'desc'

type EmployeeStats = {
  employeeId: string
  name: string
  role: string
  minutes: number
  billableMinutes: number
  internalMinutes: number
  tasksCompleted: number
  casesAdvanced: number
  casesCompleted: number
  avgPerDay: number
  lastActiveAt: string | null
}

const TODAY_ISO = new Date().toISOString().slice(0, 10)

export function ProductivityPage() {
  const { data, ownerMode } = useAppContext()
  const [searchParams, setSearchParams] = useSearchParams()

  // ----- Controls (URL-backed) -----
  const presetParam = (searchParams.get('preset') as DateRangePreset | null) ?? 'this-week'
  const granularity: Granularity = searchParams.get('granularity') === 'weekly' ? 'weekly' : 'daily'
  const personParam = searchParams.get('person') ?? ''
  const focusParam = searchParams.get('focus') ?? ''

  const computedRange = useMemo(() => rangeForPreset(presetParam, new Date()), [presetParam])
  const fromIso = searchParams.get('from') || computedRange.from
  const toIso = searchParams.get('to') || computedRange.to

  function patchParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setSearchParams(next, { replace: true })
  }

  function setPreset(value: DateRangePreset) {
    if (value === 'custom') {
      patchParams({ preset: 'custom', from: fromIso, to: toIso })
    } else {
      const range = rangeForPreset(value, new Date())
      patchParams({ preset: value, from: range.from, to: range.to })
    }
  }

  // ----- Activity data -----
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [activityError, setActivityError] = useState<string | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)

  useEffect(() => {
    if (!ownerMode) return
    const controller = new AbortController()
    fetchTeam(controller.signal)
      .then((result) => setTeamMembers(result.users))
      .catch(() => {
        /* non-fatal */
      })
    return () => controller.abort()
  }, [ownerMode])

  useEffect(() => {
    if (!ownerMode) return
    const controller = new AbortController()
    const fromTs = `${fromIso}T00:00:00.000Z`
    const toTs = `${toIso}T23:59:59.999Z`
    const load = async () => {
      setActivityLoading(true)
      setActivityError(null)
      try {
        const result = await fetchActivityRange(fromTs, toTs, 5000, controller.signal)
        if (!controller.signal.aborted) setActivity(result.entries)
      } catch (err) {
        if (controller.signal.aborted) return
        setActivityError(err instanceof Error ? err.message : 'Failed to load activity')
      } finally {
        if (!controller.signal.aborted) setActivityLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [fromIso, toIso, ownerMode])

  // ----- Derived: per-employee stats -----
  const employees: Employee[] = useMemo(
    () => data.employees.filter((emp) => emp.role !== 'Owner'),
    [data.employees],
  )

  const businessDays = useMemo(() => businessDaysIn(fromIso, toIso), [fromIso, toIso])

  const stats: EmployeeStats[] = useMemo(() => {
    const byUser = new Map<string, ActivityEntry[]>()
    for (const entry of activity) {
      const list = byUser.get(entry.userId) ?? []
      list.push(entry)
      byUser.set(entry.userId, list)
    }

    return employees.map((emp) => {
      const entries = data.timeEntries.filter(
        (e) => e.employeeId === emp.id && e.date >= fromIso && e.date <= toIso,
      )
      const minutes = entries.reduce((sum, e) => sum + e.minutes, 0)
      const billableMinutes = entries
        .filter((e) => e.billable)
        .reduce((sum, e) => sum + e.minutes, 0)

      const userActivity = byUser.get(emp.id) ?? []
      // Heuristic: count `checklist_item_checked` events as task completions.
      // The toggle endpoint records this action only when an item is toggled
      // into the `done` state (`checklist_item_unchecked` is the opposite),
      // so a clean per-user "tasks completed in range" count is just the
      // number of `checklist_item_checked` rows for that user in range.
      const tasksCompleted = userActivity.filter(
        (a) => a.action === 'checklist_item_checked',
      ).length
      const casesAdvanced = userActivity.filter((a) => a.action === 'case_advanced').length
      const casesCompleted = userActivity.filter((a) => a.action === 'case_completed').length

      const avgPerDay =
        businessDays > 0 ? Math.round((tasksCompleted / businessDays) * 10) / 10 : 0

      const teamMember = teamMembers.find((m) => m.id === emp.id)
      return {
        employeeId: emp.id,
        name: emp.name,
        role: emp.role,
        minutes,
        billableMinutes,
        internalMinutes: minutes - billableMinutes,
        tasksCompleted,
        casesAdvanced,
        casesCompleted,
        avgPerDay,
        lastActiveAt: teamMember?.lastActiveAt ?? null,
      }
    })
  }, [activity, businessDays, data.timeEntries, employees, fromIso, toIso, teamMembers])

  // ----- Sorting -----
  const [sortKey, setSortKey] = useState<SortKey>('minutes')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sortedStats = useMemo(() => {
    const copy = [...stats]
    copy.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'minutes':
          cmp = a.minutes - b.minutes
          break
        case 'tasks':
          cmp = a.tasksCompleted - b.tasksCompleted
          break
        case 'casesAdvanced':
          cmp = a.casesAdvanced - b.casesAdvanced
          break
        case 'casesCompleted':
          cmp = a.casesCompleted - b.casesCompleted
          break
        case 'avgPerDay':
          cmp = a.avgPerDay - b.avgPerDay
          break
        case 'lastActive': {
          const aTs = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0
          const bTs = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0
          cmp = aTs - bTs
          break
        }
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [stats, sortDir, sortKey])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  if (!ownerMode) return null

  // Focused person: explicit person filter OR row click via `focus`.
  const focusedEmployeeId = personParam || focusParam || ''
  const focusedEmployee = focusedEmployeeId
    ? employees.find((emp) => emp.id === focusedEmployeeId)
    : null

  return (
    <section className="content-grid productivity-layout" id="productivity">
      <header className="productivity-header">
        <h1>Productivity</h1>
        <p className="productivity-subtitle">
          How the team is spending time and moving work forward.
        </p>
      </header>

      <div className="productivity-controls">
        <label className="productivity-control">
          <span>Range</span>
          <select
            value={presetParam}
            onChange={(event) => setPreset(event.target.value as DateRangePreset)}
          >
            {(Object.keys(PRESET_LABELS) as DateRangePreset[]).map((key) => (
              <option key={key} value={key}>
                {PRESET_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        {presetParam === 'custom' ? (
          <>
            <label className="productivity-control">
              <span>From</span>
              <input
                type="date"
                value={fromIso}
                max={toIso}
                onChange={(event) => patchParams({ from: event.target.value })}
              />
            </label>
            <label className="productivity-control">
              <span>To</span>
              <input
                type="date"
                value={toIso}
                min={fromIso}
                max={TODAY_ISO}
                onChange={(event) => patchParams({ to: event.target.value })}
              />
            </label>
          </>
        ) : null}

        <div className="productivity-segmented" role="group" aria-label="Granularity">
          <button
            type="button"
            className={granularity === 'daily' ? 'is-active' : ''}
            onClick={() => patchParams({ granularity: 'daily' })}
          >
            Daily
          </button>
          <button
            type="button"
            className={granularity === 'weekly' ? 'is-active' : ''}
            onClick={() => patchParams({ granularity: 'weekly' })}
          >
            Weekly
          </button>
        </div>

        <label className="productivity-control">
          <span>Person</span>
          <select
            value={personParam}
            onChange={(event) =>
              patchParams({ person: event.target.value || null, focus: null })
            }
          >
            <option value="">All team</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </label>

        <span className="productivity-range-pill">
          {fromIso} → {toIso}
          {activityLoading ? ' · loading…' : ''}
          {activityError ? ` · ${activityError}` : ''}
        </span>
      </div>

      {employees.length === 0 ? (
        <section className="panel">
          <p className="empty-state">No team members yet. Invite some on the Team page.</p>
        </section>
      ) : focusedEmployee ? (
        <PerPersonDetail
          employee={focusedEmployee}
          fromIso={fromIso}
          toIso={toIso}
          granularity={granularity}
          activity={activity}
          stats={stats.find((s) => s.employeeId === focusedEmployee.id) ?? null}
          onClear={() => patchParams({ person: null, focus: null })}
        />
      ) : (
        <TeamComparison
          stats={sortedStats}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={toggleSort}
          onRowClick={(id) => patchParams({ focus: id })}
        />
      )}

      <HeatmapSection
        fromIso={fromIso}
        toIso={toIso}
        granularity={granularity}
        activity={activity}
        timeEntries={data.timeEntries}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Section 1: Team comparison table
// ---------------------------------------------------------------------------

function TeamComparison({
  stats,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
}: {
  stats: EmployeeStats[]
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  onRowClick: (employeeId: string) => void
}) {
  const noData = stats.every((s) => s.minutes === 0 && s.tasksCompleted === 0)

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Team comparison</p>
          <h2>Throughput by person</h2>
        </div>
      </div>
      {noData ? (
        <p className="empty-state">No activity in this range. Try widening the dates.</p>
      ) : (
        <div className="table-wrap">
          <table className="productivity-table">
            <thead>
              <tr>
                <SortableTh label="Name" col="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableTh label="Hours" col="minutes" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <th>Mix (b / i)</th>
                <SortableTh label="Tasks done" col="tasks" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableTh
                  label="Cases handed off"
                  col="casesAdvanced"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTh
                  label="Cases finished"
                  col="casesCompleted"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTh
                  label="Avg items/day"
                  col="avgPerDay"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTh
                  label="Last active"
                  col="lastActive"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => (
                <tr
                  key={row.employeeId}
                  className="productivity-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onRowClick(row.employeeId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRowClick(row.employeeId)
                  }}
                >
                  <td>
                    <strong>{row.name}</strong>
                    <div className="productivity-row-sub">{row.role}</div>
                  </td>
                  <td>{formatHours(row.minutes)}</td>
                  <td>
                    <span className="productivity-pill">
                      {(row.billableMinutes / 60).toFixed(1)} b /{' '}
                      {(row.internalMinutes / 60).toFixed(1)} i
                    </span>
                  </td>
                  <td>{row.tasksCompleted}</td>
                  <td>{row.casesAdvanced}</td>
                  <td>{row.casesCompleted}</td>
                  <td>{row.avgPerDay.toFixed(1)}</td>
                  <td>{relativeTime(row.lastActiveAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="productivity-footnote">
        Heuristic: <em>tasks completed</em> counts <code>checklist_item_checked</code> activity
        events by each user in range. <em>Avg items/day</em> divides by Mon–Fri business days.
      </p>
    </section>
  )
}

function SortableTh({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
}) {
  const active = sortKey === col
  const arrow = !active ? '' : sortDir === 'asc' ? ' ↑' : ' ↓'
  return (
    <th>
      <button type="button" className="productivity-sort-btn" onClick={() => onSort(col)}>
        {label}
        {arrow}
      </button>
    </th>
  )
}

// ---------------------------------------------------------------------------
// Section 2: Per-person detail panel
// ---------------------------------------------------------------------------

function PerPersonDetail({
  employee,
  fromIso,
  toIso,
  granularity,
  activity,
  stats,
  onClear,
}: {
  employee: Employee
  fromIso: string
  toIso: string
  granularity: Granularity
  activity: ActivityEntry[]
  stats: EmployeeStats | null
  onClear: () => void
}) {
  const { data } = useAppContext()
  const periods = useMemo(
    () => periodsBetween(fromIso, toIso, granularity),
    [fromIso, toIso, granularity],
  )

  const userEntries = useMemo(
    () =>
      data.timeEntries.filter(
        (e) => e.employeeId === employee.id && e.date >= fromIso && e.date <= toIso,
      ),
    [data.timeEntries, employee.id, fromIso, toIso],
  )
  const userActivity = useMemo(
    () => activity.filter((a) => a.userId === employee.id),
    [activity, employee.id],
  )

  // Bucket time entries by their `date` field.
  const entriesByPeriod = useMemo(
    () => bucketByPeriod(userEntries, 'date', periods, granularity),
    [userEntries, periods, granularity],
  )
  // Bucket activity by `timestamp`.
  const activityByPeriod = useMemo(
    () => bucketByPeriod(userActivity, 'timestamp', periods, granularity),
    [userActivity, periods, granularity],
  )

  const periodRows = periods.map((p) => {
    const entries = entriesByPeriod[p] ?? []
    const acts = activityByPeriod[p] ?? []
    const minutes = entries.reduce((s, e) => s + e.minutes, 0)
    const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0)
    const items = acts.filter((a) => a.action === 'checklist_item_checked').length
    const cases =
      acts.filter((a) => a.action === 'case_advanced').length +
      acts.filter((a) => a.action === 'case_completed').length
    return { period: p, minutes, billable, items, cases }
  })

  const maxHours = Math.max(1, ...periodRows.map((r) => r.minutes / 60))
  const maxItems = Math.max(1, ...periodRows.map((r) => r.items))

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Per-person detail</p>
          <h2>
            {employee.name} — {fromIso} to {toIso}
          </h2>
        </div>
        <button type="button" className="productivity-back" onClick={onClear}>
          ← Back to team
        </button>
      </div>

      {stats ? (
        <div className="report-metric-grid">
          <MetricCard label="Hours tracked" value={formatHours(stats.minutes)} detail={`${formatHours(stats.billableMinutes)} billable`} />
          <MetricCard label="Tasks completed" value={String(stats.tasksCompleted)} detail={`${stats.avgPerDay.toFixed(1)} / business day`} />
          <MetricCard label="Cases handed off" value={String(stats.casesAdvanced)} detail="advanced to next stage" />
          <MetricCard label="Cases finished" value={String(stats.casesCompleted)} detail="fully closed" />
        </div>
      ) : null}

      {periods.length === 0 ? (
        <p className="empty-state">No periods to chart.</p>
      ) : (
        <div className="productivity-chart">
          <div className="productivity-chart-y">
            <span>{maxHours.toFixed(1)}h</span>
            <span>{(maxHours / 2).toFixed(1)}h</span>
            <span>0h</span>
          </div>
          <div className="productivity-chart-bars">
            {periodRows.map((row) => {
              const hoursPct = (row.minutes / 60 / maxHours) * 100
              const itemsPct = maxItems > 0 ? (row.items / maxItems) * 100 : 0
              return (
                <div className="productivity-chart-period" key={row.period}>
                  <div className="productivity-chart-pair">
                    <div
                      className="productivity-chart-bar productivity-chart-bar-hours"
                      style={{ height: `${Math.max(2, hoursPct)}%` }}
                      title={`${(row.minutes / 60).toFixed(1)} hours`}
                    />
                    <div
                      className="productivity-chart-bar productivity-chart-bar-items"
                      style={{ height: `${Math.max(2, itemsPct)}%` }}
                      title={`${row.items} items`}
                    />
                  </div>
                  <span className="productivity-chart-tick">
                    {formatPeriodLabel(row.period, granularity)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="productivity-chart-legend">
        <span>
          <i className="productivity-legend-swatch productivity-legend-hours" /> Hours tracked
        </span>
        <span>
          <i className="productivity-legend-swatch productivity-legend-items" /> Items completed
        </span>
      </div>

      <div className="table-wrap">
        <table className="productivity-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Hours</th>
              <th>Billable</th>
              <th>Items completed</th>
              <th>Cases moved</th>
            </tr>
          </thead>
          <tbody>
            {periodRows.map((row) => (
              <tr key={row.period}>
                <td>
                  <strong>{formatPeriodLabel(row.period, granularity)}</strong>
                </td>
                <td>{formatHours(row.minutes)}</td>
                <td>{formatHours(row.billable)}</td>
                <td>{row.items}</td>
                <td>{row.cases}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function MetricCard({
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

// ---------------------------------------------------------------------------
// Section 3: Team-wide heatmap
// ---------------------------------------------------------------------------

function HeatmapSection({
  fromIso,
  toIso,
  granularity,
  activity,
  timeEntries,
}: {
  fromIso: string
  toIso: string
  granularity: Granularity
  activity: ActivityEntry[]
  timeEntries: { date: string; minutes: number }[]
}) {
  // Auto-switch: if the user picked daily but the range is huge, force
  // weekly bucketing for legibility. We compute an "effective granularity"
  // here without mutating the page-wide control.
  const totalDays = calendarDaysIn(fromIso, toIso)
  const autoSwitched = granularity === 'daily' && totalDays > HEATMAP_DAILY_MAX_DAYS
  const effective: Granularity = autoSwitched ? 'weekly' : granularity

  const periods = useMemo(
    () => periodsBetween(fromIso, toIso, effective),
    [fromIso, toIso, effective],
  )

  const hoursByPeriod = useMemo(() => {
    const buckets = bucketByPeriod(timeEntries, 'date', periods, effective)
    return periods.map((p) => (buckets[p] ?? []).reduce((s, e) => s + e.minutes, 0) / 60)
  }, [timeEntries, periods, effective])

  const itemsByPeriod = useMemo(() => {
    const filtered = activity.filter((a) => a.action === 'checklist_item_checked')
    const buckets = bucketByPeriod(filtered, 'timestamp', periods, effective)
    return periods.map((p) => (buckets[p] ?? []).length)
  }, [activity, periods, effective])

  const casesByPeriod = useMemo(() => {
    const filtered = activity.filter(
      (a) => a.action === 'case_advanced' || a.action === 'case_completed',
    )
    const buckets = bucketByPeriod(filtered, 'timestamp', periods, effective)
    return periods.map((p) => (buckets[p] ?? []).length)
  }, [activity, periods, effective])

  const rows: Array<{ label: string; values: number[] }> = [
    { label: 'Hours', values: hoursByPeriod },
    { label: 'Items completed', values: itemsByPeriod },
    { label: 'Cases moved', values: casesByPeriod },
  ]

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Team pulse</p>
          <h2>Activity heatmap</h2>
        </div>
      </div>
      {autoSwitched ? (
        <p className="report-caption">
          Range exceeds {HEATMAP_DAILY_MAX_DAYS} days — heatmap auto-switched to weekly buckets
          for readability.
        </p>
      ) : null}
      {periods.length === 0 ? (
        <p className="empty-state">No activity in this range. Try widening the dates.</p>
      ) : (
        <div className="productivity-heatmap">
          <div className="productivity-heatmap-header">
            <span />
            {periods.map((p) => (
              <span key={p} className="productivity-heatmap-tick">
                {formatPeriodLabel(p, effective)}
              </span>
            ))}
          </div>
          {rows.map((row) => {
            const max = Math.max(0, ...row.values)
            return (
              <div className="productivity-heatmap-row" key={row.label}>
                <span className="productivity-heatmap-label">{row.label}</span>
                {row.values.map((value, idx) => {
                  const intensity = max > 0 ? value / max : 0
                  const opacity = value === 0 ? 0.06 : 0.15 + intensity * 0.75
                  const display =
                    row.label === 'Hours' ? `${value.toFixed(1)} hours` : `${value} ${row.label.toLowerCase()}`
                  return (
                    <span
                      key={`${row.label}-${periods[idx]}`}
                      className="productivity-heatmap-cell"
                      style={{ background: `rgba(142, 47, 82, ${opacity.toFixed(3)})` }}
                      title={`${formatPeriodLabel(periods[idx], effective)} — ${display}`}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
