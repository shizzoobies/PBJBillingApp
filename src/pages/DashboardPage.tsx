import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Eye,
  ListChecks,
  PlayCircle,
  Plus,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react'
import { useAppContext } from '../AppContext'
import { fetchGlobalActivity, fetchTeam, fetchTeamActivity } from '../lib/api'
import type { ActivityEntry, Checklist, TeamMember } from '../lib/types'
import {
  clientName,
  currency,
  describeActivityAction,
  employeeName,
  formatActivityTimestamp,
  formatHours,
  isInBillingPeriod,
  relativeTime,
} from '../lib/utils'

const today = () => new Date().toISOString().slice(0, 10)
const addDays = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function isComplete(checklist: Checklist) {
  return checklist.items.length > 0 && checklist.items.every((item) => item.done)
}

function isInProgress(checklist: Checklist) {
  const done = checklist.items.filter((item) => item.done).length
  return done > 0 && done < checklist.items.length
}

export function DashboardPage() {
  const { role, previewMode } = useAppContext()

  // Owners get the owner view by default; employees and previewing owners get
  // the employee view.
  const showEmployeeView = previewMode || role !== 'owner'

  return showEmployeeView ? <EmployeeDashboardView /> : <OwnerDashboardView />
}

function OwnerDashboardView() {
  const {
    data,
    sessionUser,
    activeEmployeeId,
    billingPeriod,
    toggleChecklistItem,
    setPreviewUserId,
  } = useAppContext()
  const navigate = useNavigate()

  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])

  // Fetch team once so we can show lastActiveAt per member.
  useEffect(() => {
    const controller = new AbortController()
    fetchTeam(controller.signal)
      .then((result) => setTeamMembers(result.users))
      .catch(() => {
        /* non-fatal */
      })
    return () => controller.abort()
  }, [])

  // Initial + 60s polling for global activity feed.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const load = async () => {
      try {
        const result = await fetchGlobalActivity(15, controller.signal)
        if (!cancelled) {
          setActivity(result.entries)
        }
      } catch {
        // Silent failure; the rest of the dashboard still renders.
      }
    }

    void load()
    const intervalId = window.setInterval(() => {
      void load()
    }, 60_000)

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [])

  const todayIso = today()
  const weekEndIso = addDays(todayIso, 7)
  const sevenDaysAgo = addDays(todayIso, -7)
  const firstName = sessionUser.name.split(' ')[0]

  const overdueChecklists = data.checklists.filter(
    (c) => c.dueDate && c.dueDate < todayIso && !isComplete(c),
  )
  const dueThisWeekChecklists = data.checklists.filter(
    (c) => c.dueDate && c.dueDate >= todayIso && c.dueDate <= weekEndIso && !isComplete(c),
  )

  const stuckCaseIds = useMemo(() => {
    const checklistRecency = new Map<string, string>()
    for (const entry of activity) {
      if (typeof entry.target === 'string') {
        for (const c of data.checklists) {
          if (entry.target.includes(c.id)) {
            const prev = checklistRecency.get(c.id)
            if (!prev || prev < entry.timestamp) {
              checklistRecency.set(c.id, entry.timestamp)
            }
          }
        }
      }
    }
    const cutoffIso = `${sevenDaysAgo}T00:00:00.000Z`
    const ids = new Set<string>()
    for (const c of data.checklists) {
      if (!c.caseId) continue
      if (isComplete(c)) continue
      if (!isInProgress(c)) continue
      const lastActivity = checklistRecency.get(c.id)
      const lastActivityOk = lastActivity && lastActivity >= cutoffIso
      const created = c.createdAt
      const createdRecent = created && created >= cutoffIso
      if (!lastActivityOk && !createdRecent) {
        ids.add(c.caseId)
      }
    }
    return ids
  }, [activity, data.checklists, sevenDaysAgo])

  const unbilledMinutes = data.timeEntries
    .filter((entry) => entry.billable && isInBillingPeriod(entry, billingPeriod))
    .reduce((total, entry) => total + entry.minutes, 0)

  const myChecklists = data.checklists.filter(
    (c) => c.assigneeId === activeEmployeeId && !isComplete(c),
  )
  const queueToday = myChecklists.filter((c) => !c.dueDate || c.dueDate <= todayIso)
  const queueWeek = myChecklists.filter(
    (c) => c.dueDate && c.dueDate > todayIso && c.dueDate <= weekEndIso,
  )
  const queueLater = myChecklists.filter((c) => c.dueDate && c.dueDate > weekEndIso)

  const teammates = data.employees.filter((e) => e.role !== 'Owner')

  const casesInFlight = useMemo(() => {
    const byCase = new Map<string, Checklist[]>()
    for (const c of data.checklists) {
      if (!c.caseId) continue
      const list = byCase.get(c.caseId) ?? []
      list.push(c)
      byCase.set(c.caseId, list)
    }
    const rows: Array<{
      caseId: string
      checklists: Checklist[]
      current: Checklist
      completedCount: number
      totalCount: number
    }> = []
    for (const [caseId, checklists] of byCase) {
      const total = checklists.length
      const completed = checklists.filter(isComplete).length
      const inProgress = checklists.find((c) => !isComplete(c))
      if (completed > 0 && inProgress) {
        rows.push({
          caseId,
          checklists,
          current: inProgress,
          completedCount: completed,
          totalCount: total,
        })
      }
    }
    rows.sort((a, b) => (a.current.dueDate < b.current.dueDate ? -1 : 1))
    return rows
  }, [data.checklists])

  const limitedCases = casesInFlight.slice(0, 10)

  const monthEntries = data.timeEntries.filter((entry) => isInBillingPeriod(entry, billingPeriod))
  const hoursMinutes = monthEntries.reduce((sum, e) => sum + e.minutes, 0)
  const billableMonthMinutes = monthEntries
    .filter((e) => e.billable)
    .reduce((sum, e) => sum + e.minutes, 0)
  const billablePct = hoursMinutes > 0 ? Math.round((billableMonthMinutes / hoursMinutes) * 100) : 0
  const projectedBilling = data.clients.reduce((total, client) => {
    const minutes = monthEntries
      .filter((entry) => entry.clientId === client.id && entry.billable)
      .reduce((sum, e) => sum + e.minutes, 0)
    if (client.billingMode === 'subscription' && client.planId) {
      const plan = data.plans.find((p) => p.id === client.planId)
      if (plan) {
        const includedMinutes = plan.includedHours * 60
        const overage = Math.max(0, minutes - includedMinutes)
        return total + plan.monthlyFee + (overage / 60) * client.hourlyRate
      }
    }
    return total + (minutes / 60) * client.hourlyRate
  }, 0)
  const activeClientCount = new Set(monthEntries.map((e) => e.clientId)).size

  return (
    <div className="dashboard-page">
      <div className="dashboard-view-as">
        <label>
          <Eye size={14} />
          <span>Viewing as:</span>
          <select
            value=""
            onChange={(event) => {
              const value = event.target.value
              if (value) {
                setPreviewUserId(value)
                navigate('/dashboard')
              }
            }}
          >
            <option value="">Me</option>
            {teammates.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <header className="dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p className="dashboard-greeting">Welcome back, {firstName}</p>
        </div>
        <div className="dashboard-quick-actions">
          <Link className="quick-action" to="/checklists?new=one-time">
            <Plus size={16} /> New task
          </Link>
          <Link className="quick-action" to="/team">
            <UserPlus size={16} /> Invite bookkeeper
          </Link>
          <Link className="quick-action" to="/clients">
            <Plus size={16} /> Add client
          </Link>
          <Link className="quick-action" to="/notifications">
            <Bell size={16} /> Notifications
          </Link>
        </div>
      </header>

      <section className="dashboard-alerts" aria-label="Alerts">
        <button
          type="button"
          className="alert-card alert-red"
          onClick={() => navigate('/checklists?status=overdue')}
        >
          <AlertTriangle size={20} />
          <strong>{overdueChecklists.length}</strong>
          <span>Overdue</span>
          <small>tasks</small>
        </button>
        <button
          type="button"
          className="alert-card alert-amber"
          onClick={() => navigate('/checklists?status=active')}
        >
          <CalendarClock size={20} />
          <strong>{dueThisWeekChecklists.length}</strong>
          <span>Due this week</span>
          <small>this week</small>
        </button>
        <button
          type="button"
          className="alert-card alert-amber"
          onClick={() => navigate('/checklists?status=active')}
        >
          <PlayCircle size={20} />
          <strong>{stuckCaseIds.size}</strong>
          <span>Stuck cases</span>
          <small>cases</small>
        </button>
        <button
          type="button"
          className="alert-card alert-info"
          onClick={() => navigate('/reports')}
          title="Approximation: total billable hours this month (no invoice-sent state yet)"
        >
          <CircleDollarSign size={20} />
          <strong>{formatHours(unbilledMinutes)}</strong>
          <span>Unbilled hours</span>
          <small>hours</small>
        </button>
      </section>

      <section className="dashboard-section" aria-label="Your queue">
        <h2>Your queue</h2>
        {myChecklists.length === 0 ? (
          <p className="empty-state">Nothing in your queue. Nicely done.</p>
        ) : (
          <div className="dashboard-queue">
            <QueueGroup
              title="Today"
              checklists={queueToday}
              onToggle={toggleChecklistItem}
              clients={data.clients}
            />
            <QueueGroup
              title="This week"
              checklists={queueWeek}
              onToggle={toggleChecklistItem}
              clients={data.clients}
            />
            <QueueGroup
              title="Later"
              checklists={queueLater}
              onToggle={toggleChecklistItem}
              clients={data.clients}
            />
          </div>
        )}
      </section>

      <section className="dashboard-section" aria-label="Team">
        <h2>Team</h2>
        {teammates.length === 0 ? (
          <p className="empty-state">
            No bookkeepers yet. <Link to="/team">Invite one →</Link>
          </p>
        ) : (
          <div className="dashboard-team-grid">
            {teammates.map((member) => {
              const memberChecklists = data.checklists.filter(
                (c) => c.assigneeId === member.id && !isComplete(c),
              )
              const overdueCount = memberChecklists.filter(
                (c) => c.dueDate && c.dueDate < todayIso,
              ).length
              const teamMember = teamMembers.find((m) => m.id === member.id)
              return (
                <div key={member.id} className="team-card">
                  <div className="team-card-name">
                    <strong>{member.name}</strong>
                    <span>{member.role}</span>
                  </div>
                  <div className="team-card-stats">
                    <span>
                      <ListChecks size={14} /> {memberChecklists.length} open
                    </span>
                    <span className={overdueCount > 0 ? 'team-card-overdue' : ''}>
                      <AlertTriangle size={14} /> {overdueCount} overdue
                    </span>
                  </div>
                  <div className="team-card-meta">
                    Last active: {relativeTime(teamMember?.lastActiveAt ?? null)}
                  </div>
                  <Link to={`/checklists?assignee=${member.id}`} className="team-card-link">
                    View their tasks →
                  </Link>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="dashboard-section" aria-label="Cases in flight">
        <h2>Cases in flight</h2>
        {limitedCases.length === 0 ? (
          <p className="empty-state">No multi-step cases in flight.</p>
        ) : (
          <ul className="dashboard-cases">
            {limitedCases.map((row) => {
              const stuck = stuckCaseIds.has(row.caseId)
              const stageIndex = row.current.stageIndex ?? row.completedCount
              const stageCount = row.current.stageCount ?? row.totalCount
              return (
                <li key={row.caseId} className="dashboard-case-row">
                  <div className="dashboard-case-main">
                    <strong>{row.current.title}</strong>
                    <span className="dashboard-case-client">
                      {clientName(data.clients, row.current.clientId)}
                    </span>
                  </div>
                  <div className="dashboard-case-stage">
                    Step {stageIndex + 1} of {stageCount}
                  </div>
                  <div className="dashboard-case-holder">
                    {employeeName(data.employees, row.current.assigneeId)}
                  </div>
                  {stuck ? <span className="status-pill status-pill-red">Stuck</span> : null}
                  <Link to={`/cases/${row.caseId}`} className="dashboard-case-link">
                    Open case →
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
        {casesInFlight.length > limitedCases.length ? (
          <Link to="/checklists?status=active" className="dashboard-section-more">
            View all cases →
          </Link>
        ) : null}
      </section>

      <section className="dashboard-section" aria-label="Recent activity">
        <h2>Recent activity</h2>
        {activity.length === 0 ? (
          <p className="empty-state">No recent activity.</p>
        ) : (
          <ul className="dashboard-activity">
            {activity.map((entry) => {
              const actor = data.employees.find((e) => e.id === entry.userId)
              const actorName = actor?.name ?? entry.userId
              return (
                <li key={entry.id}>
                  <span className="dashboard-activity-actor">{actorName}</span>
                  <span className="dashboard-activity-action">
                    {describeActivityAction(entry.action)}
                  </span>
                  <span className="dashboard-activity-target">{entry.target}</span>
                  <span className="dashboard-activity-time">
                    {formatActivityTimestamp(entry.timestamp)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="dashboard-kpi" aria-label="This month at a glance">
        <h2>This month at a glance</h2>
        <div className="dashboard-kpi-row">
          <div className="kpi-stat">
            <Clock3 size={16} />
            <strong>{formatHours(hoursMinutes)}</strong>
            <span>Hours tracked</span>
          </div>
          <div className="kpi-stat">
            <TrendingUp size={16} />
            <strong>{billablePct}%</strong>
            <span>Billable</span>
          </div>
          <div className="kpi-stat">
            <CircleDollarSign size={16} />
            <strong>{currency.format(projectedBilling)}</strong>
            <span>Projected billing</span>
          </div>
          <div className="kpi-stat">
            <Users size={16} />
            <strong>{activeClientCount}</strong>
            <span>Active clients</span>
          </div>
        </div>
        <Link to="/reports" className="dashboard-section-more">
          View full report →
        </Link>
      </section>
    </div>
  )
}

function EmployeeDashboardView() {
  const {
    data,
    effectiveUser,
    role,
    billingPeriod,
    toggleChecklistItem,
    previewMode,
  } = useAppContext()
  const navigate = useNavigate()

  const userId = effectiveUser.id
  const firstName = effectiveUser.name.split(' ')[0]

  const [activity, setActivity] = useState<ActivityEntry[]>([])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const load = async () => {
      try {
        const result = await fetchTeamActivity(userId, 10)
        if (!cancelled) setActivity(result.entries)
      } catch {
        if (!cancelled) setActivity([])
      }
    }
    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [userId])

  const todayIso = today()
  const weekEndIso = addDays(todayIso, 7)
  const threeDaysAgo = addDays(todayIso, -3)

  const overdueChecklists = data.checklists.filter(
    (c) => c.assigneeId === userId && c.dueDate && c.dueDate < todayIso && !isComplete(c),
  )
  const dueThisWeekChecklists = data.checklists.filter(
    (c) =>
      c.assigneeId === userId &&
      c.dueDate &&
      c.dueDate >= todayIso &&
      c.dueDate <= weekEndIso &&
      !isComplete(c),
  )

  // Stuck cases (employee variant): the EFFECTIVE user holds the current stage
  // (i.e. is the assignee on the in-progress checklist) and there's been no
  // activity on that case's checklist in 3+ days.
  const stuckCaseIds = useMemo(() => {
    const checklistRecency = new Map<string, string>()
    for (const entry of activity) {
      if (typeof entry.target === 'string') {
        for (const c of data.checklists) {
          if (entry.target.includes(c.id)) {
            const prev = checklistRecency.get(c.id)
            if (!prev || prev < entry.timestamp) {
              checklistRecency.set(c.id, entry.timestamp)
            }
          }
        }
      }
    }
    const cutoffIso = `${threeDaysAgo}T00:00:00.000Z`
    const ids = new Set<string>()
    for (const c of data.checklists) {
      if (!c.caseId) continue
      if (c.assigneeId !== userId) continue
      if (isComplete(c)) continue
      const lastActivity = checklistRecency.get(c.id)
      const lastActivityOk = lastActivity && lastActivity >= cutoffIso
      const created = c.createdAt
      const createdRecent = created && created >= cutoffIso
      if (!lastActivityOk && !createdRecent) {
        ids.add(c.caseId)
      }
    }
    return ids
  }, [activity, data.checklists, threeDaysAgo, userId])

  const myChecklists = data.checklists.filter(
    (c) => c.assigneeId === userId && !isComplete(c),
  )
  const queueToday = myChecklists.filter((c) => !c.dueDate || c.dueDate <= todayIso)
  const queueWeek = myChecklists.filter(
    (c) => c.dueDate && c.dueDate > todayIso && c.dueDate <= weekEndIso,
  )
  const queueLater = myChecklists.filter((c) => c.dueDate && c.dueDate > weekEndIso)

  // Watching: viewer-only (not assignee, not editor).
  const watching = data.checklists.filter((c) => {
    if (c.assigneeId === userId) return false
    if ((c.editorIds ?? []).includes(userId)) return false
    return (c.viewerIds ?? []).includes(userId)
  })

  // My cases in flight: distinct caseIds where the user is on at least one
  // stage (current or past) AND the case isn't fully complete.
  const myCases = useMemo(() => {
    const byCase = new Map<string, Checklist[]>()
    for (const c of data.checklists) {
      if (!c.caseId) continue
      const list = byCase.get(c.caseId) ?? []
      list.push(c)
      byCase.set(c.caseId, list)
    }
    const rows: Array<{
      caseId: string
      current: Checklist
    }> = []
    for (const [caseId, checklists] of byCase) {
      const everInvolved = checklists.some((c) => c.assigneeId === userId)
      if (!everInvolved) continue
      const inProgress = checklists.find((c) => !isComplete(c))
      if (!inProgress) continue
      rows.push({ caseId, current: inProgress })
    }
    rows.sort((a, b) => (a.current.dueDate < b.current.dueDate ? -1 : 1))
    return rows
  }, [data.checklists, userId])

  // KPI strip — scoped to effective user.
  const monthEntries = data.timeEntries.filter(
    (entry) => entry.employeeId === userId && isInBillingPeriod(entry, billingPeriod),
  )
  const hoursMinutes = monthEntries.reduce((sum, e) => sum + e.minutes, 0)
  const billableMonthMinutes = monthEntries
    .filter((e) => e.billable)
    .reduce((sum, e) => sum + e.minutes, 0)
  const billablePct = hoursMinutes > 0 ? Math.round((billableMonthMinutes / hoursMinutes) * 100) : 0
  const touchedClientIds = new Set(monthEntries.map((e) => e.clientId))
  const projectedBilling = data.clients.reduce((total, client) => {
    if (!touchedClientIds.has(client.id)) return total
    const minutes = monthEntries
      .filter((entry) => entry.clientId === client.id && entry.billable)
      .reduce((sum, e) => sum + e.minutes, 0)
    return total + (minutes / 60) * client.hourlyRate
  }, 0)
  const activeClientCount = touchedClientIds.size

  // Bookkeepers can't visit /reports (owner-only); route them to /time instead.
  const kpiHref = role === 'owner' ? '/reports' : '/time'

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p className="dashboard-greeting">Welcome back, {firstName}</p>
        </div>
        <div className="dashboard-quick-actions">
          <Link className="quick-action" to="/notifications">
            <Bell size={16} /> Notifications
          </Link>
          <Link className="quick-action" to="/time">
            <Clock3 size={16} /> My time
          </Link>
        </div>
      </header>

      <section className="dashboard-alerts" aria-label="Alerts">
        <button
          type="button"
          className="alert-card alert-red"
          onClick={() => navigate(`/checklists?assignee=${userId}&status=overdue`)}
        >
          <AlertTriangle size={20} />
          <strong>{overdueChecklists.length}</strong>
          <span>Overdue</span>
          <small>tasks</small>
        </button>
        <button
          type="button"
          className="alert-card alert-amber"
          onClick={() => navigate(`/checklists?assignee=${userId}&status=active`)}
        >
          <CalendarClock size={20} />
          <strong>{dueThisWeekChecklists.length}</strong>
          <span>Due this week</span>
          <small>this week</small>
        </button>
        <button
          type="button"
          className="alert-card alert-amber"
          onClick={() => navigate(`/checklists?assignee=${userId}&status=active`)}
        >
          <PlayCircle size={20} />
          <strong>{stuckCaseIds.size}</strong>
          <span>Stuck</span>
          <small>cases</small>
        </button>
      </section>

      <section className="dashboard-section" aria-label="My queue">
        <h2>My queue</h2>
        {myChecklists.length === 0 ? (
          <p className="empty-state">Nothing in your queue. Nicely done.</p>
        ) : (
          <div className="dashboard-queue">
            <QueueGroup
              title="Today"
              checklists={queueToday}
              onToggle={toggleChecklistItem}
              clients={data.clients}
              disabled={previewMode}
            />
            <QueueGroup
              title="This week"
              checklists={queueWeek}
              onToggle={toggleChecklistItem}
              clients={data.clients}
              disabled={previewMode}
            />
            <QueueGroup
              title="Later"
              checklists={queueLater}
              onToggle={toggleChecklistItem}
              clients={data.clients}
              disabled={previewMode}
            />
          </div>
        )}
      </section>

      <section className="dashboard-section" aria-label="Watching">
        <h2>Watching</h2>
        {watching.length === 0 ? (
          <p className="empty-state">Nothing you're watching.</p>
        ) : (
          <ul className="dashboard-watching">
            {watching.map((c) => {
              const doneCount = c.items.filter((item) => item.done).length
              return (
                <li key={c.id} className="dashboard-watching-row">
                  <div className="dashboard-case-main">
                    <strong>{c.title}</strong>
                    <span className="dashboard-case-client">
                      {clientName(data.clients, c.clientId)}
                    </span>
                  </div>
                  <div className="dashboard-case-holder">
                    {employeeName(data.employees, c.assigneeId)}
                  </div>
                  <div className="dashboard-case-stage">Due {c.dueDate || '—'}</div>
                  <div className="dashboard-case-stage">
                    {doneCount}/{c.items.length}
                  </div>
                  <Link to={`/checklists?focus=${c.id}`} className="dashboard-case-link">
                    Open →
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="dashboard-section" aria-label="My cases in flight">
        <h2>My cases in flight</h2>
        {myCases.length === 0 ? (
          <p className="empty-state">No cases in flight.</p>
        ) : (
          <ul className="dashboard-cases">
            {myCases.map((row) => {
              const stageIndex = row.current.stageIndex ?? 0
              const stageCount = row.current.stageCount ?? 1
              const holderIsMe = row.current.assigneeId === userId
              return (
                <li key={row.caseId} className="dashboard-case-row">
                  <div className="dashboard-case-main">
                    <strong>{row.current.title}</strong>
                    <span className="dashboard-case-client">
                      {clientName(data.clients, row.current.clientId)}
                    </span>
                  </div>
                  <div className="dashboard-case-stage">
                    Step {stageIndex + 1} of {stageCount}
                  </div>
                  <div className="dashboard-case-holder">
                    {holderIsMe
                      ? 'You'
                      : `→ ${employeeName(data.employees, row.current.assigneeId)}`}
                  </div>
                  <Link to={`/cases/${row.caseId}`} className="dashboard-case-link">
                    Open case →
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="dashboard-section" aria-label="My recent activity">
        <h2>My recent activity</h2>
        {activity.length === 0 ? (
          <p className="empty-state">No recent activity.</p>
        ) : (
          <ul className="dashboard-activity">
            {activity.map((entry) => (
              <li key={entry.id}>
                <span className="dashboard-activity-actor">{firstName}</span>
                <span className="dashboard-activity-action">
                  {describeActivityAction(entry.action)}
                </span>
                <span className="dashboard-activity-target">{entry.target}</span>
                <span className="dashboard-activity-time">
                  {formatActivityTimestamp(entry.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dashboard-kpi" aria-label="My month at a glance">
        <h2>My month at a glance</h2>
        <div className="dashboard-kpi-row">
          <div className="kpi-stat">
            <Clock3 size={16} />
            <strong>{formatHours(hoursMinutes)}</strong>
            <span>Hours tracked</span>
          </div>
          <div className="kpi-stat">
            <TrendingUp size={16} />
            <strong>{billablePct}%</strong>
            <span>Billable</span>
          </div>
          <div className="kpi-stat">
            <CircleDollarSign size={16} />
            <strong>{currency.format(projectedBilling)}</strong>
            <span>Projected billing</span>
          </div>
          <div className="kpi-stat">
            <Users size={16} />
            <strong>{activeClientCount}</strong>
            <span>Active clients</span>
          </div>
        </div>
        <Link to={kpiHref} className="dashboard-section-more">
          {role === 'owner' ? 'View full report →' : 'Open my time →'}
        </Link>
      </section>
    </div>
  )
}

function QueueGroup({
  title,
  checklists,
  onToggle,
  clients,
  disabled = false,
}: {
  title: string
  checklists: Checklist[]
  onToggle: (checklistId: string, itemId: string) => Promise<void>
  clients: { id: string; name: string }[]
  disabled?: boolean
}) {
  const navigate = useNavigate()
  if (checklists.length === 0) return null
  return (
    <div className="queue-group">
      <h3>
        {title} <span className="queue-count">{checklists.length}</span>
      </h3>
      <ul>
        {checklists.map((c) => {
          const remaining = c.items.filter((item) => !item.done).length
          return (
            <li key={c.id} className="queue-row">
              <div
                className="queue-row-header"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/checklists?focus=${c.id}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') navigate(`/checklists?focus=${c.id}`)
                }}
              >
                <strong>{c.title}</strong>
                <span className="queue-row-meta">
                  {clientName(clients as never, c.clientId)} · {remaining} of {c.items.length} ·{' '}
                  Due {c.dueDate || '—'}
                </span>
              </div>
              <ul className={`queue-row-items${disabled ? ' preview-disabled' : ''}`}>
                {c.items.map((item) => (
                  <li key={item.id}>
                    <label title={disabled ? 'Disabled in preview mode' : undefined}>
                      <input
                        type="checkbox"
                        checked={item.done}
                        disabled={disabled}
                        onChange={() => void onToggle(c.id, item.id)}
                      />
                      <span className={item.done ? 'queue-item-done' : ''}>
                        {item.done ? <CheckCircle2 size={12} /> : null}
                        {item.label}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
