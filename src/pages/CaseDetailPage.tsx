import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, type ActivityEntry, type Checklist } from '../lib/types'
import type { CaseDetail } from '../lib/api'
import { fetchCase } from '../lib/api'
import { useAppContext } from '../AppContext'
import { nextStageNeverOpened, stalledStageSentence } from '../lib/stalledCase'
import { useOpenNextStage } from '../lib/useOpenNextStage'
import { useRemoveCase } from '../lib/useRemoveCase'
import { rowsOfCase, stepCountLabel } from '../../lib/case-removal.js'
import {
  describeActivityAction,
  employeeName,
  formatActivityTimestamp,
  formatHoursMinutes,
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

/**
 * featreq-9c818fca: a step that never opened although the step before it is
 * finished (a stall, `nextStageNeverOpened`). It is not "Awaiting previous
 * stage" - nothing is left to wait for - so it says what happened in the
 * Dashboard's own sentence and, for the owner or the finished step's assignee
 * (not in preview), carries the same Open next step now as the Dashboard row
 * and the step's card. The Dashboard's "Open case" lands here.
 */
function NeverOpenedStep({
  previous,
  canOpen,
  onOpened,
}: {
  previous: Checklist
  canOpen: boolean
  onOpened: (spawned: Checklist) => void
}) {
  const { opening, error, open } = useOpenNextStage(previous.id, onOpened)
  return (
    <>
      <div className="case-timeline-meta">{stalledStageSentence(previous, canOpen)}</div>
      {canOpen ? (
        <button type="button" className="secondary-action" disabled={opening} onClick={() => void open()}>
          {opening ? 'Opening…' : 'Open next step now'}
        </button>
      ) : null}
      {error ? (
        <p className="waiting-editor-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}

export function CaseDetailPage() {
  const params = useParams<{ caseId: string }>()
  const caseId = params.caseId ?? ''
  const { data, role, previewMode, effectiveUser } = useAppContext()
  const [caseRecord, setCaseRecord] = useState<CaseDetail | null>(null)
  // Stages opened from this page, so the new step's row says "Step N opened."
  const [openedStageIds, setOpenedStageIds] = useState<string[]>([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  // Remove case (owner only, not in preview); `reloadKey` re-reads the case after an Undo.
  const removal = useRemoveCase()
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [caseId, reloadKey])

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
  const canRemove = role === 'owner' && !previewMode
  const removedEntry = removal.removed.find((entry) => entry.caseId === caseId)
  const clientLabel = client?.name ?? 'Unknown client'
  if (removedEntry) {
    return (
      <section className="content-grid case-detail">
        <section className="panel">
          <p className="section-kicker">Case timeline</p>
          <h2>{template.title}</h2>
          <p className="checklist-meta-line" role="status">
            Case removed: its {stepCountLabel(removedEntry.stepCount)} {removedEntry.stepCount === 1 ? 'is' : 'are'} in the
            recycle bin.{' '}
            <button
              type="button"
              className="link-button"
              disabled={removal.restoring === caseId}
              onClick={() =>
                void removal.undo(caseId).then(() => {
                  setReloadKey((key) => key + 1)
                })
              }
            >
              {removal.restoring === caseId ? 'Restoring…' : 'Undo'}
            </button>
          </p>
          <Link className="secondary-action" to="/dashboard">
            Back to the Dashboard
          </Link>
        </section>
      </section>
    )
  }
  const openedAt = stages[0]?.checklist?.createdAt || stages[0]?.checklist?.dueDate
  // The stall rule reads the live workspace (fresher than this page's fetch),
  // plus this case's own rows in case the workspace does not hold one.
  const caseRows = stages.flatMap(({ checklist }) => (checklist ? [checklist] : []))
  const workspace = data.checklists ?? []
  const liveRows = [...workspace, ...caseRows.filter((row) => !workspace.some((entry) => entry.id === row.id))]
  const live = (row: Checklist) => workspace.find((entry) => entry.id === row.id) ?? row
  /** The finished step before stage `idx` when stage `idx` never opened, else null. */
  const stalledBefore = (idx: number): Checklist | null => {
    const previous = idx > 0 ? stages[idx - 1]?.checklist : null
    if (stages[idx]?.checklist || !previous) return null
    const current = live(previous)
    return nextStageNeverOpened(current, liveRows) ? current : null
  }
  const markOpened = (stageId: string, spawned: Checklist) => {
    setCaseRecord((record) =>
      record
        ? {
            ...record,
            stages: record.stages.map((entry) =>
              entry.stage.id === stageId ? { ...entry, checklist: spawned } : entry,
            ),
          }
        : record,
    )
    setOpenedStageIds((ids) => [...ids, stageId])
  }
  return (
    <section className="content-grid case-detail">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Case timeline</p>
            <h2>{template.title}</h2>
            <p className="checklist-meta-line">
              {client?.name ?? 'Unknown client'}
              {openedAt ? ` · Case opened ${shortDate.format(new Date(`${openedAt.slice(0, 10)}T12:00:00`))}` : ''}
            </p>
          </div>
          {canRemove ? (
            <button
              type="button"
              className="ghost-action"
              disabled={removal.removing === caseId}
              title="Move every step of this case to the recycle bin"
              onClick={() =>
                void removal.remove({
                  caseId,
                  title: template.title,
                  clientName: clientLabel,
                  stepCount: rowsOfCase(workspace, caseId).length || caseRows.length,
                })
              }
            >
              {removal.removing === caseId ? 'Removing…' : 'Remove case'}
            </button>
          ) : null}
        </div>
        {removal.error?.caseId === caseId ? (
          <p className="waiting-editor-error" role="alert">
            {removal.error.text}
          </p>
        ) : null}
        <ol className="case-timeline">
          {stages.map(({ stage, checklist }, idx) => {
            const total = checklist?.items.length ?? 0
            const done = checklist ? checklist.items.filter((i) => i.done).length : 0
            const loggedMinutes = checklist
              ? data.timeEntries
                  .filter((entry) => entry.taskId === checklist.id)
                  .reduce((sum, entry) => sum + entry.minutes, 0)
              : 0
            const stalledFrom = stalledBefore(idx)
            return (
              <li key={stage.id} className="case-timeline-row">
                <div className="case-timeline-dot" aria-hidden="true">
                  {idx + 1}
                </div>
                <div className="case-timeline-body">
                  <div className="case-timeline-title">
                    <strong>{stage.name}</strong>
                    <span className={stalledFrom ? 'status-pill status-pill-red' : 'status-pill'}>
                      {stalledFrom ? 'Never opened' : stageStatus(checklist)}
                    </span>
                    {openedStageIds.includes(stage.id) ? (
                      <span className="status-pill" role="status">
                        Step {idx + 1} opened.
                      </span>
                    ) : null}
                  </div>
                  <div className="case-timeline-meta">
                    Assignee: {employeeName(data.employees, stage.assigneeId)}
                    {checklist
                      ? ` · ${done}/${total} items done · Due ${shortDate.format(
                          new Date(`${checklist.dueDate}T12:00:00`),
                        )}`
                      : stalledFrom
                        ? ''
                        : ' · Awaiting previous stage'}
                  </div>
                  {stalledFrom ? (
                    <NeverOpenedStep
                      previous={stalledFrom}
                      canOpen={
                        !previewMode && (role === 'owner' || stalledFrom.assigneeId === effectiveUser?.id)
                      }
                      onOpened={(spawned) => markOpened(stage.id, spawned)}
                    />
                  ) : null}
                  {loggedMinutes > 0 ? (
                    <div className="case-timeline-meta">
                      Time logged: {formatHoursMinutes(loggedMinutes)}
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
