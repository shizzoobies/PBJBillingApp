import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, type ActivityEntry } from '../lib/types'
import type { CaseDetail } from '../lib/api'
import { fetchCase } from '../lib/api'
import { useAppContext } from '../AppContext'
import {
  describeActivityAction,
  employeeName,
  formatActivityTimestamp,
  formatHours,
  shortDate,
} from '../lib/utils'

function stageStatus(checklist: CaseDetail['stages'][number]['checklist']) {
  if (!checklist) return 'Not started'
  const total = checklist.items.length
  const done = checklist.items.filter((item) => item.done).length
  if (total > 0 && done === total) return 'Completed'
  if (done > 0) return 'In progress'
  return 'Open'
}

export function CaseDetailPage() {
  const params = useParams<{ caseId: string }>()
  const caseId = params.caseId ?? ''
  const { data } = useAppContext()
  const [caseRecord, setCaseRecord] = useState<CaseDetail | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    if (!caseId) return
    const controller = new AbortController()
    fetchCase(caseId, controller.signal)
      .then((record) => {
        if (controller.signal.aborted) return
        setCaseRecord(record)
        setStatus('ready')
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setError(err instanceof ApiError ? err.message : 'Failed to load case')
        setStatus('error')
      })
    return () => controller.abort()
  }, [caseId])

  const loading = status === 'loading'

  if (loading) {
    return (
      <section className="content-grid">
        <p className="empty-state">Loading case…</p>
      </section>
    )
  }

  if (error || !caseRecord) {
    return (
      <section className="content-grid">
        <p className="empty-state">{error || 'Case not found.'}</p>
      </section>
    )
  }

  const { template, client, stages, activity } = caseRecord
  const openedAt = stages[0]?.checklist?.createdAt || stages[0]?.checklist?.dueDate
  return (
    <section className="content-grid case-detail">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Case timeline</p>
            <h2>{template.title}</h2>
            <p className="checklist-meta-line">
              {client?.name ?? 'Unknown client'}
              {openedAt ? ` · Case opened ${shortDate.format(new Date(`${openedAt}T12:00:00`))}` : ''}
            </p>
          </div>
        </div>
        <ol className="case-timeline">
          {stages.map(({ stage, checklist }, idx) => {
            const total = checklist?.items.length ?? 0
            const done = checklist ? checklist.items.filter((i) => i.done).length : 0
            const loggedMinutes = checklist
              ? data.timeEntries
                  .filter((entry) => entry.taskId === checklist.id)
                  .reduce((sum, entry) => sum + entry.minutes, 0)
              : 0
            return (
              <li key={stage.id} className="case-timeline-row">
                <div className="case-timeline-dot" aria-hidden="true">
                  {idx + 1}
                </div>
                <div className="case-timeline-body">
                  <div className="case-timeline-title">
                    <strong>{stage.name}</strong>
                    <span className="status-pill">{stageStatus(checklist)}</span>
                  </div>
                  <div className="case-timeline-meta">
                    Assignee: {employeeName(data.employees, stage.assigneeId)}
                    {checklist
                      ? ` · ${done}/${total} items done · Due ${shortDate.format(
                          new Date(`${checklist.dueDate}T12:00:00`),
                        )}`
                      : ' · Awaiting previous stage'}
                  </div>
                  {loggedMinutes > 0 ? (
                    <div className="case-timeline-meta">
                      Time logged: {formatHours(loggedMinutes)}
                    </div>
                  ) : null}
                  {checklist ? (
                    <Link
                      className="secondary-action"
                      to={`/checklists?focus=${encodeURIComponent(checklist.id)}`}
                    >
                      Open checklist
                    </Link>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Activity</p>
            <h2>Case activity</h2>
          </div>
        </div>
        {activity.length === 0 ? (
          <p className="empty-state">No activity recorded for this case yet.</p>
        ) : (
          <ul className="activity-list">
            {activity.map((entry: ActivityEntry) => (
              <li key={entry.id} className="activity-row">
                <span className="activity-action">{describeActivityAction(entry.action)}</span>
                <span className="activity-target">{entry.target}</span>
                <span className="activity-time">{formatActivityTimestamp(entry.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
