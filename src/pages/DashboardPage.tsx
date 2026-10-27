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
  ShieldCheck,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react'
import {
  isChecklistSkipped,
  pendingSkipReviews,
  skipReasonLabel,
} from '../../lib/checklist-skip.js'
// THE bill-rate chain the invoice is priced with, and the pin rule, so the
// revenue estimate below says what the month run will.
import { billRateAt, ratePeriodAsOf } from '../../lib/rate-history.js'
import {
  blockerWaitLink,
  OWNER_TICK_CLEARS_WAIT_TITLE,
  WAITING_BLOCK_TITLES,
  waitingToggleRefusal,
} from '../../lib/waiting-on-state.js'
import { useAppContext } from '../AppContext'
import {
  DashboardArrangeButton,
  DashboardPanel,
  DashboardPanels,
} from '../components/DashboardLayout'
import { useDashboardArrangement } from '../lib/useDashboardArrangement'
import {
  fetchGlobalActivity,
  fetchRateVersions,
  fetchTeam,
  fetchTeamActivity,
  listInvoicesRequest,
} from '../lib/api'
import { stalledCaseStages, stalledStageSentence } from '../lib/stalledCase'
import { useOpenNextStage } from '../lib/useOpenNextStage'
import { caseRemovalKey, useRemoveCase } from '../lib/useRemoveCase'
import { caseTitleOf, rowsOfCase } from '../../lib/case-removal.js'
import type {
  ActivityEntry,
  BillRateVersion,
  Checklist,
  PastDueInvoiceRow,
  TeamMember,
} from '../lib/types'
import {
  clientName,
  currency,
  daysPastDueLabel,
  describeActivityAction,
  employeeName,
  formatActivityTimestamp,
  formatDecimalHours,
  isInBillingPeriod,
  localDateOnly,
  normalizeBillingMonth,
  pastDueInvoice,
  relativeTime,
  shortDate,
  type PastDueInvoice,
} from '../lib/utils'

const today = () => localDateOnly()

/**
 * "Oct 31, 2026" for a pushed task's new date. The year is spelled out here (it
 * is not in the shared `shortDate`) because a push routinely crosses a year end
 * and "Jan 15" would be genuinely ambiguous on a review queue.
 */
const pushedToDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
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

/**
 * The Dashboard lists a stall only when its finished step was due in the last
 * this-many days: 188 older ones (mostly the August imports) would flood Stuck
 * cases. The card's Open next step now is offered on every stall regardless.
 */
const STALLED_CASE_WINDOW_DAYS = 90

/**
 * What a press of Open next step now on the Dashboard left to say about a case
 * (featreq-9c818fca): "Step N opened." after it worked, or the server's
 * sentence after a refusal. Kept by the view, not the row, because the row
 * leaves: on success the case is no longer stalled, and on "already open" the
 * workspace refresh drops it. The note then sits on the case's own row in the
 * in-flight list, or on a line of its own when that list does not show the case.
 */
type CaseNote = {
  caseId: string
  stageId: string
  title: string
  clientId: string
  kind: 'opened' | 'refused'
  text: string
  link: { to: string; label: string }
}

/** One note per stalled step: the latest press wins. */
function useCaseNotes() {
  const [notes, setNotes] = useState<CaseNote[]>([])
  const addNote = (note: CaseNote) =>
    setNotes((current) => [...current.filter((entry) => entry.stageId !== note.stageId), note])
  return { notes, addNote }
}

/** The note, as the full-width line under a case row. */
function CaseNoteLine({ note }: { note: CaseNote | undefined }) {
  if (!note) return null
  return note.kind === 'opened' ? (
    <p className="dashboard-case-note" role="status">
      {note.text}
    </p>
  ) : (
    <p className="waiting-editor-error dashboard-case-note" role="alert">
      {note.text}
    </p>
  )
}

/** A case's note for its in-flight row: only once its stalled row has left (else that row shows it). */
function caseNoteOutsideRows(notes: CaseNote[], stalledStages: Checklist[], caseId: string) {
  return notes.find(
    (note) =>
      note.caseId === caseId &&
      (note.kind === 'opened' || !stalledStages.some((stage) => stage.id === note.stageId)),
  )
}

/**
 * Remove case on a Dashboard case row (2026-10-27, Alex for Brittany: "we have
 * old stuff and there is no way to get rid of it"). The owner view only, never
 * in preview (the preview shows the staff view, which passes no `removal`).
 */
type CaseRemoval = ReturnType<typeof useRemoveCase> & {
  /** The case's live steps on that client: what goes to the bin. */
  rowsOf: (caseId: string, clientId: string) => Checklist[]
}

/**
 * The button. The case is named by its first step's title (`caseTitleOf`), the
 * same as on the case page, and scoped to the row's client: a case id can span
 * two clients (an imported recipe copy kept its ids).
 */
function RemoveCaseButton({
  removal,
  caseId,
  clientId,
  fallbackTitle,
  clientLabel,
}: {
  removal: CaseRemoval | undefined
  caseId: string
  clientId: string
  fallbackTitle: string
  clientLabel: string
}) {
  if (!removal) return null
  const busy = removal.removing === caseRemovalKey(caseId, clientId)
  return (
    <button
      type="button"
      className="ghost-action dashboard-case-remove"
      disabled={busy}
      title="Move every step of this case to the recycle bin"
      onClick={() => {
        const rows = removal.rowsOf(caseId, clientId)
        void removal.remove({
          caseId,
          clientId,
          title: caseTitleOf(rows, fallbackTitle),
          clientName: clientLabel,
          stepCount: rows.length,
        })
      }}
    >
      {busy ? 'Removing…' : 'Remove case'}
    </button>
  )
}

/** The server's sentence when a removal was refused, under the case's row. */
function RemoveCaseError({
  removal,
  caseId,
  clientId,
}: {
  removal: CaseRemoval | undefined
  caseId: string
  clientId: string
}) {
  if (!removal?.error || removal.error.key !== caseRemovalKey(caseId, clientId)) return null
  return (
    <p className="waiting-editor-error dashboard-case-note" role="alert">
      {removal.error.text}
    </p>
  )
}

/**
 * "Case removed: <title> for <client>. Undo" - outlives the row it removed. A
 * failed Undo keeps the line and says why under it.
 */
function RemovedCaseLines({ removal }: { removal: CaseRemoval | undefined }) {
  if (!removal || removal.removed.length === 0) return null
  return (
    <>
      {removal.removed.map((entry) => (
        <div key={entry.key}>
          <p className="dashboard-case-removed" role="status">
            Case removed: {entry.title} for {entry.clientName}.{' '}
            <button
              type="button"
              className="link-button"
              disabled={removal.restoring === entry.key}
              onClick={() => void removal.undo(entry.key)}
            >
              {removal.restoring === entry.key ? 'Restoring…' : 'Undo'}
            </button>
          </p>
          {removal.undoError?.key === entry.key ? (
            <p className="waiting-editor-error dashboard-case-removed" role="alert">
              {removal.undoError.text}
            </p>
          ) : null}
        </div>
      ))}
    </>
  )
}

/** The case link: the case timeline, or the step itself for a row without a case. */
function caseLinkFor(stage: Checklist) {
  return stage.caseId
    ? { to: `/cases/${encodeURIComponent(stage.caseId)}`, label: 'Open case →' }
    : { to: `/checklists?focus=${encodeURIComponent(stage.id)}`, label: 'Open step →' }
}

/**
 * featreq-ed73d181 / featreq-9c818fca: cases whose step is finished but whose
 * next step never opened (`stalledCaseStages`). Such a case has no open row
 * anywhere, so it is listed with the cases, says in one sentence what happened
 * and what to do, and carries Open next step now itself - the same action as
 * the button on the step's card (POST /api/checklists/:id/open-next-stage), so
 * the Dashboard is where the problem is fixed, not only where it is found. On
 * success the row leaves (the new step is live, so the case is no longer
 * stalled) and "Step N opened." shows on the case's in-flight row; a refusal
 * shows the server's sentence. `canOpen` mirrors the card and the route: the
 * owner, or the step's assignee, never in preview. `listedCaseIds`: the cases
 * the in-flight list below shows, which carry their own note.
 */
function StalledCaseRows({
  stages,
  clients,
  canOpen,
  notes,
  addNote,
  listedCaseIds,
  removal,
}: {
  stages: Checklist[]
  clients: Parameters<typeof clientName>[0]
  canOpen: (stage: Checklist) => boolean
  notes: CaseNote[]
  addNote: (note: CaseNote) => void
  listedCaseIds: ReadonlySet<string>
  /** Remove case: the owner view only. */
  removal?: CaseRemoval
}) {
  const openedStageIds = new Set(notes.filter((note) => note.kind === 'opened').map((note) => note.stageId))
  const rows = stages.filter((stage) => !openedStageIds.has(stage.id))
  const rowIds = new Set(rows.map((stage) => stage.id))
  // A note whose row has left and whose case the in-flight list does not show.
  const loose = notes.filter((note) => !rowIds.has(note.stageId) && !listedCaseIds.has(note.caseId))
  if (rows.length === 0 && loose.length === 0) return null
  const noteFor = (stage: Checklist, kind: CaseNote['kind'], text: string, link: CaseNote['link']): CaseNote => ({
    caseId: stage.caseId || stage.id,
    stageId: stage.id,
    title: stage.title,
    clientId: stage.clientId,
    kind,
    text,
    link,
  })
  return (
    <ul className="dashboard-cases dashboard-cases-stalled">
      {loose.map((note) => (
        <li key={`note-${note.stageId}`} className="dashboard-case-row">
          <div className="dashboard-case-main">
            <strong>{note.title}</strong>
            <span className="dashboard-case-client">{clientName(clients, note.clientId)}</span>
          </div>
          <Link to={note.link.to} className="dashboard-case-link">
            {note.link.label}
          </Link>
          <CaseNoteLine note={note} />
        </li>
      ))}
      {rows.map((stage) => (
        <StalledCaseRow
          key={stage.id}
          stage={stage}
          clients={clients}
          canOpen={canOpen(stage)}
          refusal={notes.find((note) => note.stageId === stage.id && note.kind === 'refused')}
          removal={removal}
          onOpened={(spawned) => {
            const step = (spawned.stageIndex ?? (stage.stageIndex ?? 0) + 1) + 1
            addNote(
              noteFor(stage, 'opened', `Step ${step} opened.`, {
                to: `/checklists?focus=${encodeURIComponent(spawned.id)}`,
                label: `Open step ${step} →`,
              }),
            )
          }}
          onRefused={(sentence) => addNote(noteFor(stage, 'refused', sentence, caseLinkFor(stage)))}
        />
      ))}
    </ul>
  )
}

function StalledCaseRow({
  stage,
  clients,
  canOpen,
  refusal,
  removal,
  onOpened,
  onRefused,
}: {
  stage: Checklist
  clients: Parameters<typeof clientName>[0]
  canOpen: boolean
  refusal: CaseNote | undefined
  removal: CaseRemoval | undefined
  onOpened: (spawned: Checklist) => void
  onRefused: (sentence: string) => void
}) {
  const stageIndex = stage.stageIndex ?? 0
  const stageCount = stage.stageCount ?? 1
  const { opening, open } = useOpenNextStage(stage.id, onOpened, onRefused)
  // The case page lists every step of the case, finished ones included. The
  // Checklists page's In-progress list files a finished step out of sight
  // (featreq-9c818fca), so it is the fallback for a row without a case id only.
  const caseLink = caseLinkFor(stage)
  return (
    <li className="dashboard-case-row">
      <div className="dashboard-case-main">
        <strong>{stage.title}</strong>
        <span className="dashboard-case-client">{clientName(clients, stage.clientId)}</span>
      </div>
      <div className="dashboard-case-stage">
        Step {stageIndex + 1} of {stageCount} done
      </div>
      <span className="status-pill status-pill-red">Finished, next step never opened</span>
      {canOpen ? (
        <button type="button" className="secondary-action" disabled={opening} onClick={() => void open()}>
          {opening ? 'Opening…' : 'Open next step now'}
        </button>
      ) : null}
      <Link to={caseLink.to} className="dashboard-case-link">
        {caseLink.label}
      </Link>
      <RemoveCaseButton
        removal={removal}
        caseId={stage.caseId || stage.id}
        clientId={stage.clientId}
        fallbackTitle={stage.title}
        clientLabel={clientName(clients, stage.clientId)}
      />
      <p className="dashboard-case-note">{stalledStageSentence(stage, canOpen)}</p>
      {/* While the press runs, the earlier refusal is stale. */}
      {opening ? null : <CaseNoteLine note={refusal} />}
      <RemoveCaseError removal={removal} caseId={stage.caseId || stage.id} clientId={stage.clientId} />
    </li>
  )
}

export function DashboardPage() {
  const { role, previewMode } = useAppContext()

  // Owners get the owner view by default; employees and previewing owners get
  // the employee view.
  const showEmployeeView = previewMode || role !== 'owner'

  return showEmployeeView ? <EmployeeDashboardView /> : <OwnerDashboardView />
}

/**
 * Owner-only: this year's skipped AND pushed recurring tasks awaiting review.
 *
 * Both kinds share this one section because they are one question to her —
 * "this recurring task did not happen as scheduled, and here is who and why".
 * A pushed row names the date it moved to; a skipped row does not, because
 * there isn't one.
 *
 * Renders NOTHING for anyone else — `checklistSkips` is empty for staff (the
 * endpoint 403s), and the role check here makes that explicit rather than
 * relying on an empty array. It also renders nothing when there is nothing to
 * review, so a clean dashboard stays clean.
 *
 * "Reviewed" clears the row from this list and keeps the record forever — the
 * same audit-trail decision as the completed-tasks history.
 */
function SkippedTasksReviewSection({ panel }: { panel: 'skipped' }) {
  const { checklistSkips, reviewChecklistSkip, data, role, previewMode } = useAppContext()
  const [busyId, setBusyId] = useState<string | null>(null)

  const rows = useMemo(
    () => pendingSkipReviews(checklistSkips, new Date().getFullYear()),
    [checklistSkips],
  )

  if (role !== 'owner' || previewMode) return null
  if (rows.length === 0) return null

  return (
    <DashboardPanel
      panel={panel}
      label="Skipped and pushed tasks to review"
      title={`Skipped and pushed tasks to review (${rows.length})`}
    >
      <ul className="dashboard-cases">
        {rows.map((skip) => (
          <li key={skip.id} className="dashboard-case-row">
            <div className="dashboard-case-main">
              <strong>{skip.title}</strong>
              <span className="dashboard-case-client">
                {skip.clientId ? clientName(data.clients, skip.clientId) : 'No client'}
              </span>
              <span className="dashboard-case-client">
                {skip.reasonNote}
              </span>
            </div>
            <div className="dashboard-case-stage">
              {/* What actually happened, before why. A push names its date —
                  it is the thing she is being asked to accept. */}
              {skip.kind === 'push' && skip.newDueDate
                ? `Pushed to ${pushedToDate.format(new Date(`${skip.newDueDate}T12:00:00`))}`
                : 'Skipped'}
              {` · ${skipReasonLabel(skip.reasonCategory)}`}
            </div>
            <div className="dashboard-case-holder">
              {skip.skippedByName ?? employeeName(data.employees, skip.skippedBy ?? '')}
              {skip.skippedAt ? ` · ${formatActivityTimestamp(skip.skippedAt)}` : ''}
            </div>
            <button
              type="button"
              className="secondary-action"
              disabled={busyId === skip.id}
              onClick={() => {
                setBusyId(skip.id)
                void reviewChecklistSkip(skip.id).finally(() => setBusyId(null))
              }}
              title="Clear this off your dashboard — the record is kept."
            >
              {busyId === skip.id ? 'Saving…' : 'Reviewed'}
            </button>
          </li>
        ))}
      </ul>
    </DashboardPanel>
  )
}

/**
 * Owner-only: every invoice that is past the firm's own thirty-day line,
 * oldest first — the list to work down when she wants to know who to chase.
 *
 * The invoices are FETCHED here rather than read off `data`. Invoices are
 * deliberately not part of the workspace bulk save (they are money documents
 * and the bulk save wipes and restores that table), so AppContext does not hold
 * them and putting them there to fill in one dashboard section would be the
 * wrong trade. One owner-only GET with no period — past due is not a question
 * about the month on the top bar, it is a question about every month.
 *
 * Which invoices count is `pastDueInvoice`, the same rule the month run's Past
 * due tab uses, so the two can never give different answers. A failed payment
 * wins over past due in that rule, which is why an invoice sitting in the month
 * run's Payment failed tab is deliberately absent from here.
 *
 * Renders nothing for staff, nothing while an owner is previewing as somebody
 * else, and nothing when the list is empty — a clean dashboard stays clean.
 */
function PastDueInvoicesSection({ panel }: { panel: 'past_due' }) {
  const { data, role, previewMode } = useAppContext()
  const [invoices, setInvoices] = useState<PastDueInvoiceRow[]>([])
  const hidden = role !== 'owner' || previewMode

  useEffect(() => {
    if (hidden) return
    let cancelled = false
    // `pastDue: 1` — the server applies the rule and answers with the six
    // fields below. Without it this asked for every invoice the firm has ever
    // written, lines and email logs included, to render a handful of rows.
    listInvoicesRequest(undefined, { pastDue: true })
      .then((rows) => {
        if (!cancelled) setInvoices(rows)
      })
      .catch(() => {
        // Non-fatal, like the activity feed: the rest of the dashboard renders.
      })
    return () => {
      cancelled = true
    }
  }, [hidden])

  const rows = useMemo(() => {
    const today = localDateOnly()
    const found: Array<{ invoice: PastDueInvoiceRow; pastDue: PastDueInvoice }> = []
    for (const invoice of invoices) {
      const pastDue = pastDueInvoice(invoice, today)
      // Oldest line first: the one that has been owed longest is the one to
      // call about, and that order does not change while she reads it.
      if (pastDue) found.push({ invoice, pastDue })
    }
    return found.sort((a, b) => a.pastDue.dueDate.localeCompare(b.pastDue.dueDate))
  }, [invoices])

  if (hidden || rows.length === 0) return null

  return (
    <DashboardPanel panel={panel} label="Invoices past due" title={`Invoices past due (${rows.length})`}>
      <ul className="dashboard-cases">
        {rows.map(({ invoice, pastDue }) => (
          <li key={invoice.id} className="dashboard-case-row">
            <div className="dashboard-case-main">
              <strong>{invoice.number ?? invoice.id}</strong>
              <span className="dashboard-case-client">
                {clientName(data.clients, invoice.clientId)}
              </span>
            </div>
            <div className="dashboard-case-stage">
              {invoice.sentAt ? `sent ${shortDate.format(new Date(invoice.sentAt))}` : 'never sent'}
            </div>
            <div className="dashboard-case-holder">
              {daysPastDueLabel(pastDue.daysPastDue)} past due
            </div>
            <span className="dashboard-case-client">{currency.format(invoice.total)}</span>
            <Link to="/invoices" className="dashboard-case-link">
              Open invoices →
            </Link>
          </li>
        ))}
      </ul>
    </DashboardPanel>
  )
}

function OwnerDashboardView() {
  const {
    data,
    sessionUser,
    activeEmployeeId,
    billingPeriod,
    toggleChecklistItem,
    setPreviewUserId,
    firmSettings,
    previewMode,
  } = useAppContext()
  const navigate = useNavigate()
  const defaultHourlyRate = firmSettings.clientDefaults?.hourlyRate ?? 0
  // Remove case (owner only; this view never renders in preview, said again).
  const removeCaseControls = useRemoveCase()
  const caseRemoval: CaseRemoval | undefined = previewMode
    ? undefined
    : { ...removeCaseControls, rowsOf: (caseId, clientId) => rowsOfCase(data.checklists, caseId, clientId) }
  // Her own arrangement of the panels below (order, shown, starts collapsed).
  const arrangement = useDashboardArrangement({ view: 'owner', userId: sessionUser.id, readOnly: false })
  // A panel's own fetch waits until the saved layout is known (this browser's
  // hint or the server's answer), so a hidden panel asks for nothing.
  const teamShown = arrangement.known && arrangement.shows('team')
  const kpiShown = arrangement.known && arrangement.shows('kpi')
  const activityShown = arrangement.shows('activity')

  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])

  /**
   * The dated bill rates, so Projected billing below prices each hourly
   * client at the month it is pinned to rather than at each person's live
   * `billRate` — which mirrors the NEWEST version, a raise dated ahead
   * included, and used to inflate this figure past what the invoice will say
   * for every client still on older rates. Owner-only, like this whole view;
   * a 403 answers empty lists and the fallback chain prices as before.
   * Only the month-at-a-glance panel reads them, so a hidden one asks for none.
   */
  const [billRateVersions, setBillRateVersions] = useState<BillRateVersion[]>([])
  useEffect(() => {
    if (!kpiShown) return
    const controller = new AbortController()
    fetchRateVersions(controller.signal)
      .then((versions) => setBillRateVersions(versions.billRateVersions))
      // Non-fatal: the estimate falls back to live rates, exactly as before.
      .catch(() => {})
    return () => controller.abort()
  }, [kpiShown])

  // Fetch team once so we can show lastActiveAt per member (not while the Team
  // panel is hidden: nothing else reads it).
  useEffect(() => {
    if (!teamShown) return
    const controller = new AbortController()
    fetchTeam(controller.signal)
      .then((result) => setTeamMembers(result.users))
      .catch(() => {
        /* non-fatal */
      })
    return () => controller.abort()
  }, [teamShown])

  // Initial + 60s polling for global activity feed. The first load always runs:
  // the Stuck cases alert reads it. The poll only while the panel is shown.
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
    const intervalId = activityShown
      ? window.setInterval(() => {
          void load()
        }, 60_000)
      : null

    return () => {
      cancelled = true
      controller.abort()
      if (intervalId !== null) window.clearInterval(intervalId)
    }
  }, [activityShown])

  const todayIso = today()
  const weekEndIso = addDays(todayIso, 7)
  const sevenDaysAgo = addDays(todayIso, -7)
  const firstName = sessionUser.name.split(' ')[0]

  // The overdue RULE is untouched — a skipped occurrence simply never reaches
  // it, exactly as on the Checklists page. A task deliberately moved to its next
  // occurrence is not late.
  const overdueChecklists = data.checklists.filter(
    (c) => !isChecklistSkipped(c) && c.dueDate && c.dueDate < todayIso && !isComplete(c),
  )
  const dueThisWeekChecklists = data.checklists.filter(
    (c) =>
      !isChecklistSkipped(c) &&
      c.dueDate &&
      c.dueDate >= todayIso &&
      c.dueDate <= weekEndIso &&
      !isComplete(c),
  )

  // featreq-ed73d181: finished steps whose next step never opened, every case
  // whose finished step was due in the last STALLED_CASE_WINDOW_DAYS.
  const stalledSince = addDays(todayIso, -STALLED_CASE_WINDOW_DAYS)
  const stalledStages = useMemo(
    () => stalledCaseStages(data.checklists, stalledSince),
    [data.checklists, stalledSince],
  )
  const caseNotes = useCaseNotes()

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
    // A case whose next step never opened is stuck however recent its activity.
    const ids = new Set<string>(stalledStages.map((stage) => stage.caseId || stage.id))
    for (const c of data.checklists) {
      if (!c.caseId) continue
      // A skipped step is closed out for its cycle, not a stale open step.
      if (isChecklistSkipped(c)) continue
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
  }, [activity, data.checklists, sevenDaysAgo, stalledStages])

  const unbilledMinutes = data.timeEntries
    .filter((entry) => entry.billable && isInBillingPeriod(entry, billingPeriod))
    .reduce((total, entry) => total + entry.minutes, 0)

  // A skipped task is closed out for its cycle without its steps being ticked,
  // so it never rolls up complete; the queue leaves it out like the cards above.
  const myChecklists = data.checklists.filter(
    (c) => !isChecklistSkipped(c) && c.assigneeId === activeEmployeeId && !isComplete(c),
  )
  const queueToday = myChecklists.filter((c) => !c.dueDate || c.dueDate <= todayIso)
  const queueWeek = myChecklists.filter(
    (c) => c.dueDate && c.dueDate > todayIso && c.dueDate <= weekEndIso,
  )
  const queueLater = myChecklists.filter((c) => c.dueDate && c.dueDate > weekEndIso)

  const teammates = data.employees.filter((e) => e.role !== 'Owner')
  // Soft-deleted team members (owner-only — bookkeepers get an empty
  // array). Used for the "current team only" analytics toggle on the
  // Team section below. Doesn't affect the "preview as" picker, which
  // sticks to active members only.
  const inactiveTeammates = (data.inactiveEmployees ?? []).filter(
    (e) => e.role !== 'Owner',
  )
  const [currentTeamOnly, setCurrentTeamOnly] = useState(true)
  const analyticsMembers = currentTeamOnly
    ? teammates
    : [...teammates, ...inactiveTeammates]

  // A skipped step is neither finished nor open, so it never counts toward a
  // case in flight: a case whose only open step is skipped drops off.
  const casesInFlight = useMemo(() => {
    const byCase = new Map<string, Checklist[]>()
    for (const c of data.checklists) {
      if (!c.caseId) continue
      if (isChecklistSkipped(c)) continue
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
    if (client.billingMode === 'subscription') {
      // Monthly billing uses the client's own monthly rate. No overage math.
      const monthlyRate =
        typeof client.monthlyRate === 'number' && !Number.isNaN(client.monthlyRate)
          ? client.monthlyRate
          : 0
      return total + monthlyRate
    }
    if (client.billingMode === 'annual') {
      // Annual billing only contributes in the client's chosen billing month.
      const annualRate =
        typeof client.annualRate === 'number' && !Number.isNaN(client.annualRate)
          ? client.annualRate
          : 0
      const billingMonth = normalizeBillingMonth(client.annualBillingMonth)
      const periodMonth = Number(billingPeriod.slice(5, 7))
      return total + (periodMonth === billingMonth ? annualRate : 0)
    }
    // Hourly billing is per-employee: each person's billable hours for this
    // client are charged at their bill rate AT THIS CLIENT'S PIN for the month
    // (`billRateAt` at `ratePeriodAsOf`, the chain the invoice lines are priced
    // through), or the firm default. A client still on June's rates is priced
    // at June's here, the same as its invoice will be.
    const ratePeriod = ratePeriodAsOf(client, billingPeriod)
    const hourlyTotal = monthEntries
      .filter((entry) => entry.clientId === client.id && entry.billable)
      .reduce((sum, entry) => {
        const employee = data.employees.find((e) => e.id === entry.employeeId)
        const rate =
          billRateAt(
            billRateVersions,
            employee ?? { id: entry.employeeId },
            ratePeriod,
            billingPeriod,
          ) ?? defaultHourlyRate
        return sum + (entry.minutes / 60) * rate
      }, 0)
    return total + hourlyTotal
  }, 0)
  const activeClientCount = new Set(monthEntries.map((e) => e.clientId)).size

  return (
    <DashboardPanels arrangement={arrangement} className="dashboard-page">
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
          <DashboardArrangeButton arrangement={arrangement} />
        </div>
      </header>

      <DashboardPanel panel="alerts" label="Alerts" className="dashboard-alerts" collapsible={false}>
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
          <strong>{formatDecimalHours(unbilledMinutes)}</strong>
          <span>Unbilled hours</span>
          <small>hours</small>
        </button>
      </DashboardPanel>

      <DashboardPanel panel="queue" label="Your queue">
        {myChecklists.length === 0 ? (
          <p className="empty-state">Nothing in your queue. Nicely done.</p>
        ) : (
          <div className="dashboard-queue">
            <QueueGroup
              title="Today"
              checklists={queueToday}
              onToggle={toggleChecklistItem}
              clients={data.clients}
              ownerTicks
            />
            <QueueGroup
              title="This week"
              checklists={queueWeek}
              onToggle={toggleChecklistItem}
              clients={data.clients}
              ownerTicks
            />
            <QueueGroup
              title="Later"
              checklists={queueLater}
              onToggle={toggleChecklistItem}
              clients={data.clients}
              ownerTicks
            />
          </div>
        )}
      </DashboardPanel>

      <DashboardPanel
        panel="team"
        label="Team"
        headerExtra={
          inactiveTeammates.length > 0 ? (
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
              title={`${inactiveTeammates.length} former team member${
                inactiveTeammates.length === 1 ? '' : 's'
              } on file`}
            >
              <input
                type="checkbox"
                checked={currentTeamOnly}
                onChange={(event) => setCurrentTeamOnly(event.target.checked)}
              />
              <span>Current team only</span>
            </label>
          ) : null
        }
      >
        {analyticsMembers.length === 0 ? (
          <p className="empty-state">
            No bookkeepers yet. <Link to="/team">Invite one →</Link>
          </p>
        ) : (
          <div className="dashboard-team-grid">
            {analyticsMembers.map((member) => {
              // A skipped task is neither open nor overdue, as in the queue.
              const memberChecklists = data.checklists.filter(
                (c) => !isChecklistSkipped(c) && c.assigneeId === member.id && !isComplete(c),
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
      </DashboardPanel>

      <DashboardPanel panel="cases" label="Cases in flight">
        <p className="dashboard-section-caption">
          Multi-step cases under way, step by step; a red row needs a hand and says what to do.
        </p>
        <RemovedCaseLines removal={caseRemoval} />
        {/* The owner may open any next step (the route's rule). */}
        <StalledCaseRows
          stages={stalledStages}
          clients={data.clients}
          canOpen={() => true}
          notes={caseNotes.notes}
          addNote={caseNotes.addNote}
          listedCaseIds={new Set(limitedCases.map((row) => row.caseId))}
          removal={caseRemoval}
        />
        {limitedCases.length === 0 && stalledStages.length === 0 ? (
          <p className="empty-state">No multi-step cases in flight.</p>
        ) : limitedCases.length === 0 ? null : (
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
                  <RemoveCaseButton
                    removal={caseRemoval}
                    caseId={row.caseId}
                    clientId={row.current.clientId}
                    fallbackTitle={row.current.title}
                    clientLabel={clientName(data.clients, row.current.clientId)}
                  />
                  <CaseNoteLine note={caseNoteOutsideRows(caseNotes.notes, stalledStages, row.caseId)} />
                  <RemoveCaseError removal={caseRemoval} caseId={row.caseId} clientId={row.current.clientId} />
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
      </DashboardPanel>

      <SkippedTasksReviewSection panel="skipped" />

      <PastDueInvoicesSection panel="past_due" />

      <DashboardPanel panel="activity" label="Recent activity">
        {activity.length === 0 ? (
          <p className="empty-state">No recent activity.</p>
        ) : (
          <ul className="dashboard-activity">
            {activity.map((entry) => {
              const actor = data.employees.find((e) => e.id === entry.userId)
              // 'system' is the app itself (the automatic invoice reminders).
              const actorName =
                actor?.name ?? (entry.userId === 'system' ? 'Automatic reminder' : entry.userId)
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
      </DashboardPanel>

      <DashboardPanel panel="kpi" label="This month at a glance" className="dashboard-kpi">
        <div className="dashboard-kpi-row">
          <div className="kpi-stat">
            <Clock3 size={16} />
            <strong>{formatDecimalHours(hoursMinutes)}</strong>
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
      </DashboardPanel>
    </DashboardPanels>
  )
}

function TwoFaBanner({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const storageKey = `pbj_2fa_banner_dismissed_${userId}`
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== '1'
    } catch {
      return false
    }
  })

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, '1')
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: '#eef6fb',
        border: '1px solid #b6d9ef',
        borderRadius: 10,
        padding: '10px 16px',
        marginBottom: 16,
        fontSize: 14,
      }}
      role="status"
    >
      <ShieldCheck size={18} style={{ color: '#1d6fa4', flexShrink: 0 }} />
      <span style={{ flex: 1 }}>Protect your account with two-factor authentication.</span>
      <button
        className="primary-action"
        onClick={() => navigate('/security')}
        style={{ padding: '4px 12px', fontSize: 13 }}
        type="button"
      >
        Set up
      </button>
      <button
        aria-label="Dismiss"
        onClick={dismiss}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          color: '#666',
          padding: '0 4px',
        }}
        type="button"
      >
        ×
      </button>
    </div>
  )
}

function EmployeeDashboardView() {
  const {
    data,
    effectiveUser,
    role,
    sessionUser,
    billingPeriod,
    toggleChecklistItem,
    previewMode,
    waitingOnMe,
    waitingOnDone,
  } = useAppContext()
  const navigate = useNavigate()

  const userId = effectiveUser.id
  const firstName = effectiveUser.name.split(' ')[0]
  // Their own arrangement; in preview, the previewed person's, read-only.
  const arrangement = useDashboardArrangement({ view: 'staff', userId, readOnly: previewMode })

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

  // Same as the owner view: the overdue rule is unchanged, a skipped occurrence
  // just isn't in the list it reads.
  const overdueChecklists = data.checklists.filter(
    (c) =>
      !isChecklistSkipped(c) &&
      c.assigneeId === userId &&
      c.dueDate &&
      c.dueDate < todayIso &&
      !isComplete(c),
  )
  const dueThisWeekChecklists = data.checklists.filter(
    (c) =>
      !isChecklistSkipped(c) &&
      c.assigneeId === userId &&
      c.dueDate &&
      c.dueDate >= todayIso &&
      c.dueDate <= weekEndIso &&
      !isComplete(c),
  )

  // Stuck cases (employee variant): the EFFECTIVE user holds the current stage
  // (i.e. is the assignee on the in-progress checklist) and there's been no
  // activity on that case's checklist in 3+ days. Also (featreq-ed73d181) a case
  // whose finished step is theirs and whose next step never opened: they can
  // revive it from the card (Open next step now is the owner's or the assignee's).
  const stalledSince = addDays(todayIso, -STALLED_CASE_WINDOW_DAYS)
  const myStalledStages = useMemo(
    () => stalledCaseStages(data.checklists, stalledSince).filter((stage) => stage.assigneeId === userId),
    [data.checklists, userId, stalledSince],
  )
  const caseNotes = useCaseNotes()
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
    const ids = new Set<string>(myStalledStages.map((stage) => stage.caseId || stage.id))
    for (const c of data.checklists) {
      if (!c.caseId) continue
      if (isChecklistSkipped(c)) continue
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
  }, [activity, data.checklists, threeDaysAgo, userId, myStalledStages])

  // Same as the owner view: a skipped task is not in the queue.
  const myChecklists = data.checklists.filter(
    (c) => !isChecklistSkipped(c) && c.assigneeId === userId && !isComplete(c),
  )
  const queueToday = myChecklists.filter((c) => !c.dueDate || c.dueDate <= todayIso)
  const queueWeek = myChecklists.filter(
    (c) => c.dueDate && c.dueDate > todayIso && c.dueDate <= weekEndIso,
  )
  const queueLater = myChecklists.filter((c) => c.dueDate && c.dueDate > weekEndIso)

  // Watching: viewer-only (not assignee, not editor). A skipped task is left
  // out, as in the queue.
  const watching = data.checklists.filter((c) => {
    if (isChecklistSkipped(c)) return false
    if (c.assigneeId === userId) return false
    if ((c.editorIds ?? []).includes(userId)) return false
    return (c.viewerIds ?? []).includes(userId)
  })

  // My cases in flight: distinct caseIds where the user is on at least one
  // stage (current or past) AND the case isn't fully complete. Skipped steps
  // are left out, as in the owner's Cases in flight.
  const myCases = useMemo(() => {
    const byCase = new Map<string, Checklist[]>()
    for (const c of data.checklists) {
      if (!c.caseId) continue
      if (isChecklistSkipped(c)) continue
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
  const activeClientCount = touchedClientIds.size

  // Bookkeepers can't visit /reports (owner-only); route them to /time instead.
  const kpiHref = role === 'owner' ? '/reports' : '/time'

  // Show the 2FA nudge banner to non-owners who haven't enabled it yet,
  // but not while the owner is previewing as an employee.
  const showTwofaBanner = !previewMode && role !== 'owner' && sessionUser.totpEnabled === false

  return (
    <DashboardPanels arrangement={arrangement} className="dashboard-page">
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
          <DashboardArrangeButton arrangement={arrangement} />
        </div>
      </header>

      {showTwofaBanner ? <TwoFaBanner userId={sessionUser.id} /> : null}

      <DashboardPanel panel="alerts" label="Alerts" className="dashboard-alerts" collapsible={false}>
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
      </DashboardPanel>

      {/* Shows only while somebody is waiting on them. */}
      <DashboardPanel panel="waiting" label="Waiting on you" empty={waitingOnMe.length === 0}>
        <ul className="dashboard-waiting-on-you">
          {waitingOnMe.map((row) => (
            <li key={row.waitingOnId} className="waiting-on-you-row">
              <div className="waiting-on-you-main">
                {/* Her Delayed page, not the checklist: she may not be on the
                    task, and Checklists lists only the tasks she is on. */}
                <Link className="waiting-on-you-step" to={blockerWaitLink(row.waitingOnId)}>
                  {row.checklistTitle}
                  <span className="waiting-on-you-sub">
                    {' › '}
                    {row.itemLabel}
                    {row.subLabel ? ` › ${row.subLabel}` : ''}
                  </span>
                </Link>
                <span className="waiting-on-you-meta">
                  {row.clientName} · {row.requestedByName} is waiting
                  {row.note ? ` · ${row.note}` : ''}
                </span>
              </div>
              <button
                type="button"
                className="waiting-on-you-done"
                disabled={previewMode}
                onClick={() => void waitingOnDone(row.checklistId, row.waitingOnId)}
              >
                Mark done
              </button>
            </li>
          ))}
        </ul>
      </DashboardPanel>

      <DashboardPanel panel="my_queue" label="My queue">
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
      </DashboardPanel>

      <DashboardPanel panel="watching" label="Watching">
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
      </DashboardPanel>

      <DashboardPanel panel="my_cases" label="My cases in flight">
        <p className="dashboard-section-caption">
          Multi-step cases you have a step on; a red row needs a hand and says what to do.
        </p>
        {/* Theirs to open: the list is filtered to their own steps; never in preview. */}
        <StalledCaseRows
          stages={myStalledStages}
          clients={data.clients}
          canOpen={(stage) => !previewMode && stage.assigneeId === userId}
          notes={caseNotes.notes}
          addNote={caseNotes.addNote}
          listedCaseIds={new Set(myCases.map((row) => row.caseId))}
        />
        {myCases.length === 0 && myStalledStages.length === 0 ? (
          <p className="empty-state">No cases in flight.</p>
        ) : myCases.length === 0 ? null : (
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
                  <CaseNoteLine note={caseNoteOutsideRows(caseNotes.notes, myStalledStages, row.caseId)} />
                </li>
              )
            })}
          </ul>
        )}
      </DashboardPanel>

      <DashboardPanel panel="my_activity" label="My recent activity">
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
      </DashboardPanel>

      <DashboardPanel panel="my_kpi" label="My month at a glance" className="dashboard-kpi">
        <div className="dashboard-kpi-row">
          <div className="kpi-stat">
            <Clock3 size={16} />
            <strong>{formatDecimalHours(hoursMinutes)}</strong>
            <span>Hours tracked</span>
          </div>
          <div className="kpi-stat">
            <TrendingUp size={16} />
            <strong>{billablePct}%</strong>
            <span>Billable</span>
          </div>
          <div className="kpi-stat">
            <Clock3 size={16} />
            <strong>{formatDecimalHours(billableMonthMinutes)}</strong>
            <span>Billable hours</span>
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
      </DashboardPanel>
    </DashboardPanels>
  )
}

function QueueGroup({
  title,
  checklists,
  onToggle,
  clients,
  disabled = false,
  ownerTicks = false,
}: {
  title: string
  checklists: Checklist[]
  onToggle: (checklistId: string, itemId: string) => Promise<void>
  clients: { id: string; name: string }[]
  disabled?: boolean
  /** The real owner: a waiting step stays tickable and her tick closes the wait. */
  ownerTicks?: boolean
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
                {c.items.map((item) => {
                  const waitRefusal = waitingToggleRefusal(item)
                  const blocked = waitRefusal !== null && !ownerTicks
                  return (
                    <li key={item.id}>
                      <label
                        title={
                          disabled
                            ? 'Disabled in preview mode'
                            : waitRefusal
                              ? ownerTicks
                                ? OWNER_TICK_CLEARS_WAIT_TITLE
                                : WAITING_BLOCK_TITLES[waitRefusal.where]
                              : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          checked={item.done}
                          disabled={disabled || blocked}
                          onChange={() => void onToggle(c.id, item.id)}
                        />
                        <span className={item.done ? 'queue-item-done' : ''}>
                          {item.done ? <CheckCircle2 size={12} /> : null}
                          {item.label}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
