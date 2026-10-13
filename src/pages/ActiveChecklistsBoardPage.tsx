import { ChevronDown, ChevronRight, Filter, GripVertical, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  boardChecklistStatus,
  boardStepSummary,
  buildActiveBoard,
  groupBoardColumns,
  UNCATEGORIZED_ID,
  type BoardChecklistStatus,
  type BoardColumn,
  type BoardStepSummary,
} from '../lib/activeBoard'
import { useAppContext } from '../AppContext'
import { inactiveClientIdSet } from '../lib/clientLifecycle'
import { boardChecklistsFor, boardTeamMemberIds } from '../lib/checklistVisibility'
import { isChecklistSkipped } from '../../lib/checklist-skip.js'
import { ListSearch } from '../components/ListSearch'
import { ReportPeriodControl } from '../components/ReportPeriodControl'
import { reportPeriodLabel } from '../lib/reportPeriod'
import { projectUpcomingChecklists } from '../lib/projectRecurring'
import { useAttachedClientNotes } from '../hooks/useAttachedClientNotes'
import { ChecklistCard } from './ChecklistsPage'
import { localDateOnly, MONTH_NAMES, stageNameFor } from '../lib/utils'
import type { Checklist, ServiceCategory } from '../lib/types'

// The Board's "Current step only" choice is a per-user UI preference, so it
// lives in localStorage keyed by user id (the Report period's pattern in
// App.tsx), never in the workspace data. v1 schema: { currentStepOnly }.
const STEP_VIEW_KEY_PREFIX = 'pbj.boardStepView.v1.'

/** The stored choice; ON when absent or when storage is unusable. */
function readStoredCurrentStepOnly(userId: string): boolean {
  try {
    const raw = localStorage.getItem(`${STEP_VIEW_KEY_PREFIX}${userId}`)
    if (!raw) return true
    const parsed = JSON.parse(raw) as { currentStepOnly?: unknown } | null
    return typeof parsed?.currentStepOnly === 'boolean' ? parsed.currentStepOnly : true
  } catch {
    // malformed JSON or unavailable storage - fall back to the default.
    return true
  }
}

function writeStoredCurrentStepOnly(userId: string, currentStepOnly: boolean) {
  try {
    localStorage.setItem(`${STEP_VIEW_KEY_PREFIX}${userId}`, JSON.stringify({ currentStepOnly }))
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

// featreq-54bf39b6: "Hide empty columns" - the same per-user localStorage
// pattern as the step view. v1 schema: { hideEmpty }.
const HIDE_EMPTY_KEY_PREFIX = 'pbj.boardHideEmpty.v1.'

/** The stored choice; ON when absent or when storage is unusable. */
function readStoredHideEmpty(userId: string): boolean {
  try {
    const raw = localStorage.getItem(`${HIDE_EMPTY_KEY_PREFIX}${userId}`)
    if (!raw) return true
    const parsed = JSON.parse(raw) as { hideEmpty?: unknown } | null
    return typeof parsed?.hideEmpty === 'boolean' ? parsed.hideEmpty : true
  } catch {
    // malformed JSON or unavailable storage - fall back to the default.
    return true
  }
}

function writeStoredHideEmpty(userId: string, hideEmpty: boolean) {
  try {
    localStorage.setItem(`${HIDE_EMPTY_KEY_PREFIX}${userId}`, JSON.stringify({ hideEmpty }))
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

/** A Board group's key and label: the null group (ungrouped columns) is "Other". */
const OTHER_GROUP_KEY = '__other__'
const OTHER_GROUP_LABEL = 'Other'

/**
 * The Active Checklists board: one column per service category (Monthly
 * Bookkeeping, Sales Tax, Payroll, …), each listing the clients that still have
 * open work of that type. Collapsible client rows expand to the live checklist.
 * Completing a client's checklist drops it off automatically. The shared Report
 * period scopes the horizon: a client shows while it has open work whose
 * effective due date is on or before the period's end (overdue work stays
 * visible — the board is a horizon view, not a strict window).
 *
 * WHOSE WORK IT SHOWS: only what the viewer is ACTIVE on — the same "mine"
 * predicate the Checklists tab uses. A bookkeeper sees hers; an accountant sees
 * hers, plus her bookkeepers' when she ticks "Show my bookkeepers'"; an owner
 * still sees the whole board. The narrowing is re-derived here from the
 * session's own feed rather than read off `visibleChecklists` because the board
 * folds in extras that memo can't carry — projected ghosts and the team reveal —
 * and both must pass through the same scoping. (`visibleChecklists` now keys off
 * the EFFECTIVE identity too, so preview no longer depends on this local
 * derivation.) This only ever narrows the feed the session already holds; it
 * can't widen anything.
 */
export function ActiveChecklistsBoardPage() {
  const ctx = useAppContext()
  const {
    visibleClientIds,
    data,
    serviceCategories,
    ownerMode,
    role,
    activeEmployeeId,
    effectiveUser,
    sessionUser,
    reportPeriod,
    setReportPeriod,
  } = ctx

  const [managingColumns, setManagingColumns] = useState(false)
  const [query, setQuery] = useState('')
  // Upcoming (projected) items default OFF — owner preference: the board opens
  // showing only real, materialized work; the toggle brings ghosts back.
  const [showUpcoming, setShowUpcoming] = useState(false)
  // Accountants only, and OFF by default: the standard board is her own work.
  // Ticking it folds in the bookkeepers under her (see `boardTeamMemberIds` for
  // how "under her" is derived — off the live work on her clients, not off the
  // owner-picked team, which is the money gate).
  const [showTeam, setShowTeam] = useState(false)
  // Client filter: empty = all clients; otherwise the board shows only items for
  // the selected clients (single or multiple).
  const [clientFilter, setClientFilter] = useState<string[]>([])
  // Team-member filter: empty = everyone; otherwise only checklists assigned
  // to the selected member(s).
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([])
  // featreq-338b1507: "Current step only" - ON by default, remembered per
  // signed-in user on this device (like the Report period). Read again when the
  // user changes, without an effect: the stored pair says whose choice it is.
  const stepViewUserId = sessionUser?.id ?? activeEmployeeId
  const [stepView, setStepView] = useState(() => ({
    userId: stepViewUserId,
    currentStepOnly: readStoredCurrentStepOnly(stepViewUserId),
  }))
  const currentStepOnly =
    stepView.userId === stepViewUserId ? stepView.currentStepOnly : readStoredCurrentStepOnly(stepViewUserId)
  const setCurrentStepOnly = (next: boolean) => {
    setStepView({ userId: stepViewUserId, currentStepOnly: next })
    writeStoredCurrentStepOnly(stepViewUserId, next)
  }
  // featreq-54bf39b6: "Hide empty columns" - ON by default, remembered the same way.
  const [hideEmptyView, setHideEmptyView] = useState(() => ({
    userId: stepViewUserId,
    hideEmpty: readStoredHideEmpty(stepViewUserId),
  }))
  const hideEmpty =
    hideEmptyView.userId === stepViewUserId ? hideEmptyView.hideEmpty : readStoredHideEmpty(stepViewUserId)
  const setHideEmpty = (next: boolean) => {
    setHideEmptyView({ userId: stepViewUserId, hideEmpty: next })
    writeStoredHideEmpty(stepViewUserId, next)
  }
  // Each group's header, for the overview strip's scroll-to.
  const groupHeaderRefs = useRef(new Map<string, HTMLElement>())

  const today = localDateOnly()

  const clientNameById = useMemo(
    () => Object.fromEntries(data.clients.map((client) => [client.id, client.name])),
    [data.clients],
  )

  // Quick-glance due-vs-pending status per checklist (pending = a step is
  // flagged waiting; the chip carries the "why"). Resolved here once so the
  // structured person-blockers can show a real name.
  const employeeNameById = useMemo(
    () => Object.fromEntries(data.employees.map((employee) => [employee.id, employee.name])),
    [data.employees],
  )
  const statusFor = (checklist: Checklist): BoardChecklistStatus =>
    boardChecklistStatus(checklist, today, employeeNameById)

  // Read-only projection of upcoming (not-yet-materialized) recurring instances.
  // Pure + derived only — these ghosts are NEVER written to context data /
  // visibleChecklists, autosave, or any endpoint (see lib/projectRecurring.ts).
  // Scoped to the clients the user can see, exactly like real checklists.
  const projectedGhosts = useMemo(() => {
    if (!showUpcoming) return [] as Checklist[]
    return projectUpcomingChecklists(data, {
      fromDateOnly: today,
      horizonEndDateOnly: reportPeriod.to,
    }).filter((ghost) => visibleClientIds.has(ghost.clientId))
  }, [showUpcoming, data, today, reportPeriod.to, visibleClientIds])

  // The session's own checklist feed, minus quietly-skipped occurrences (the
  // same narrowing App.tsx applies). Both the toggle's roster and the board read
  // it, so they can never disagree about who is doing live work here.
  const feed = useMemo(
    () => data.checklists.filter((checklist) => !isChecklistSkipped(checklist)),
    [data.checklists],
  )

  // The bookkeepers under this viewer, if any — empty for a bookkeeper and for
  // an owner, so the toggle only appears where it means something.
  const teamMemberIds = useMemo(
    () =>
      boardTeamMemberIds({
        viewerId: activeEmployeeId,
        isOwner: ownerMode,
        staffRole: effectiveUser?.staffRole,
        checklists: feed,
        checklistTemplates: data.checklistTemplates,
        employees: data.employees,
      }),
    [
      activeEmployeeId,
      ownerMode,
      effectiveUser?.staffRole,
      feed,
      data.checklistTemplates,
      data.employees,
    ],
  )

  // Whose card is this, when it isn't yours? Names the teammate on cards the
  // "Show my bookkeepers'" toggle folded in, so a revealed card never reads as
  // your own work. Null for your own tasks and for owners (whose board is
  // everyone's by definition — the team filter already answers "whose").
  const teamTagFor = (checklist: Checklist): string | null => {
    const assigneeId = checklist.assigneeId ?? ''
    if (!assigneeId || !teamMemberIds.includes(assigneeId)) return null
    return employeeNameById[assigneeId] ?? 'A teammate'
  }

  // Everything the board may render, scoped to whom it belongs to. Built from
  // the session's own feed so previewing a staff member shows their board, not
  // the owner's. Projected ghosts ride along and get scoped identically.
  const boardChecklists = useMemo(
    () =>
      boardChecklistsFor([...feed, ...projectedGhosts], {
        viewerId: activeEmployeeId,
        isOwner: ownerMode,
        staffRole: effectiveUser?.staffRole,
        checklistTemplates: data.checklistTemplates,
        employees: data.employees,
        includeTeam: showTeam,
      }),
    [
      feed,
      data.checklistTemplates,
      data.employees,
      projectedGhosts,
      activeEmployeeId,
      ownerMode,
      effectiveUser?.staffRole,
      showTeam,
    ],
  )

  // The clients that actually have work on the board right now — the filter only
  // offers clients you could meaningfully pick (and it hides itself for ≤1).
  const clientFilterOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const checklist of boardChecklists) ids.add(checklist.clientId)
    return [...ids]
      .map((id) => ({ id, label: clientNameById[id] ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [boardChecklists, clientNameById])

  const clientFilterSet = useMemo(() => new Set(clientFilter), [clientFilter])
  const assigneeFilterSet = useMemo(() => new Set(assigneeFilter), [assigneeFilter])

  // Members offered by the team filter: only those with work on the board now.
  const assigneeFilterOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const checklist of boardChecklists) {
      if (checklist.assigneeId) ids.add(checklist.assigneeId)
    }
    const nameById = new Map(data.employees.map((employee) => [employee.id, employee.name]))
    return [...ids]
      .map((id) => ({ id, label: nameById.get(id) ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [boardChecklists, data.employees])

  const board = useMemo(() => {
    const scoped = boardChecklists.filter(
      (checklist) =>
        (clientFilterSet.size === 0 || clientFilterSet.has(checklist.clientId)) &&
        (assigneeFilterSet.size === 0 ||
          (checklist.assigneeId ? assigneeFilterSet.has(checklist.assigneeId) : false)),
    )
    return buildActiveBoard({
      checklists: scoped,
      categories: serviceCategories,
      // Lets the board recover the column for instances that were generated
      // before their template had a category (those carry categoryId: null).
      templates: data.checklistTemplates,
      horizonEnd: reportPeriod.to,
      today,
      clientNameById,
    })
  }, [
    boardChecklists,
    clientFilterSet,
    assigneeFilterSet,
    serviceCategories,
    data.checklistTemplates,
    reportPeriod.to,
    today,
    clientNameById,
  ])

  const totalOpen = board.columns.reduce((sum, col) => sum + col.openClientCount, 0)

  // Where each real checklist on the board is (the step it is on), for the
  // "Current step only" view and its search. Ghosts have none.
  const stepSummaryById = useMemo(() => {
    const byId = new Map<string, BoardStepSummary>()
    if (!currentStepOnly) return byId
    for (const col of board.columns) {
      for (const clientRow of col.clients) {
        for (const checklist of clientRow.checklists) {
          if (checklist.projected) continue
          byId.set(checklist.id, boardStepSummary(checklist, data.checklistTemplates, employeeNameById))
        }
      }
    }
    return byId
  }, [currentStepOnly, board.columns, data.checklistTemplates, employeeNameById])

  const filteredColumns = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return board.columns
    // featreq-60f24838: a typed search must not surface a retired client's row.
    const inactiveIds = inactiveClientIdSet(data.clients)
    // In "Current step only" the search also finds a checklist by the step it
    // is on (stepSummaryById is empty when the view is off).
    const checklistMatches = (c: Checklist) =>
      c.title.toLowerCase().includes(q) ||
      (stepSummaryById.get(c.id)?.stepLabel ?? '').toLowerCase().includes(q)
    return board.columns.map((col) => {
      const filteredClients = col.clients.filter((clientRow) => {
        if (inactiveIds.has(clientRow.clientId)) return false
        const nameMatch = clientRow.name.toLowerCase().includes(q)
        const titleMatch = clientRow.checklists.some(checklistMatches)
        return nameMatch || titleMatch
      }).map((clientRow) => {
        const nameMatch = clientRow.name.toLowerCase().includes(q)
        return {
          ...clientRow,
          checklists: nameMatch
            ? clientRow.checklists
            : clientRow.checklists.filter(checklistMatches),
        }
      })
      return {
        ...col,
        clients: filteredClients,
        openClientCount: filteredClients.length,
      }
    })
  }, [board.columns, query, data.clients, stepSummaryById])

  // featreq-54bf39b6: columns grouped by their category's group, counted AFTER
  // the filters and the search. With no group on any column there is no strip
  // and no header - the board is exactly what it was.
  const hasGroups = serviceCategories.some((category) => Boolean(category.groupName?.trim()))
  const boardGroups = useMemo(
    () => (hasGroups ? groupBoardColumns(filteredColumns, serviceCategories) : []),
    [hasGroups, filteredColumns, serviceCategories],
  )
  // "Hide empty columns": a column with nobody on it right now is left out.
  const isShown = (col: BoardColumn) => !hideEmpty || col.clients.length > 0
  const groupKey = (name: string | null) => name ?? OTHER_GROUP_KEY
  const scrollToGroup = (key: string) => {
    groupHeaderRefs.current.get(key)?.scrollIntoView?.({ block: 'nearest', inline: 'start' })
  }

  // The notes attached to the cards on the board, fetched ONCE for all of them
  // (a projected ghost has no id the server knows). Taken from the board BEFORE
  // the search box narrows it, so typing in it does not refetch.
  const boardCardIds = useMemo(
    () =>
      board.columns.flatMap((col) =>
        col.clients.flatMap((clientRow) =>
          clientRow.checklists.filter((c) => !c.projected).map((c) => c.id),
        ),
      ),
    [board.columns],
  )
  const attachedNotesFor = useAttachedClientNotes(boardCardIds)

  // Full-fidelity card, wired to the same context handlers the Checklists page
  // uses — so checking items off the board behaves identically (and completing
  // a checklist drops its client off the column on the next render). Projected
  // "upcoming" ghosts render as a faded, NON-interactive informational card —
  // none of the mutation handlers above are ever passed to them.
  const renderCard = (checklist: Checklist): ReactNode => {
    if (checklist.projected) {
      return <ProjectedCard key={checklist.id} checklist={checklist} />
    }
    return (
    <ChecklistCard
      key={checklist.id}
      activeEmployeeId={activeEmployeeId}
      checklist={checklist}
      stageName={stageNameFor(data.checklistTemplates, checklist)}
      clients={data.clients}
      employees={data.employees}
      focused={false}
      focusRef={null}
      onAddSubItem={ctx.addSubItem}
      onAddSubSubItem={ctx.addSubSubItem}
      onBulkAddItems={ctx.bulkAddChecklistItems}
      onDeleteChecklist={ctx.deleteChecklist}
      onDeleteItem={ctx.deleteChecklistItem}
      onRemoveSubItem={ctx.removeSubItem}
      onRemoveSubSubItem={ctx.removeSubSubItem}
      onReorderItems={ctx.reorderChecklistItems}
      onSetViewers={ctx.setChecklistViewers}
      onToggle={ctx.toggleChecklistItem}
      onToggleSubItem={ctx.toggleSubItem}
      onUpdateSubItemWaiting={ctx.updateSubItemWaiting}
      onToggleSubSubItem={ctx.toggleSubSubItem}
      onUpdateItem={ctx.updateChecklistItem}
      ownerMode={ownerMode}
      role={role}
      timeEntries={data.timeEntries}
      attachedNotes={attachedNotesFor(checklist.id)}
    />
    )
  }

  const renderColumn = (column: BoardColumn): ReactNode => (
    <BoardColumnView
      key={column.id}
      column={column}
      renderCard={renderCard}
      statusFor={statusFor}
      teamTagFor={teamTagFor}
      currentStepOnly={currentStepOnly}
      stepSummaryFor={(checklist) => stepSummaryById.get(checklist.id) ?? null}
    />
  )

  return (
    <section className="content-grid one-column" id="active-board">
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Active Checklists</h2>
            <p className="section-subtitle">
              {totalOpen === 0
                ? 'Nothing open in this period — nice.'
                : `${totalOpen} client${totalOpen === 1 ? '' : 's'} with open work · through ${reportPeriodLabel(reportPeriod)}`}
            </p>
          </div>
          <div className="board-controls">
            <ListSearch
              value={query}
              onChange={setQuery}
              placeholder="Search board…"
              resultCount={filteredColumns.reduce((sum, col) => sum + col.openClientCount, 0)}
              total={totalOpen}
            />
            {clientFilterOptions.length > 1 ? (
              <BoardFilter
                noun="client"
                options={clientFilterOptions}
                selected={clientFilter}
                onChange={setClientFilter}
              />
            ) : null}
            {assigneeFilterOptions.length > 1 ? (
              <BoardFilter
                noun="team member"
                options={assigneeFilterOptions}
                selected={assigneeFilter}
                onChange={setAssigneeFilter}
              />
            ) : null}
            <ReportPeriodControl value={reportPeriod} onChange={setReportPeriod} />
            <label className="upcoming-toggle">
              <input
                type="checkbox"
                checked={showUpcoming}
                onChange={(event) => setShowUpcoming(event.target.checked)}
              />
              Show upcoming
            </label>
            <label
              className="upcoming-toggle"
              title="Show each checklist's current step and the next two instead of the whole checklist."
            >
              <input
                type="checkbox"
                checked={currentStepOnly}
                onChange={(event) => setCurrentStepOnly(event.target.checked)}
              />
              Current step only
            </label>
            <label
              className="upcoming-toggle"
              title="Leave out the columns with nothing on them right now. Untick to see every column."
            >
              <input
                type="checkbox"
                checked={hideEmpty}
                onChange={(event) => setHideEmpty(event.target.checked)}
              />
              Hide empty columns
            </label>
            {teamMemberIds.length > 0 ? (
              <label
                className="upcoming-toggle"
                title="The people doing live work on the clients you can see."
              >
                <input
                  type="checkbox"
                  checked={showTeam}
                  onChange={(event) => setShowTeam(event.target.checked)}
                />
                Show my bookkeepers’
              </label>
            ) : null}
            {ownerMode ? (
              <button
                type="button"
                className="secondary-action"
                onClick={() => setManagingColumns((value) => !value)}
                aria-expanded={managingColumns}
              >
                Manage columns
              </button>
            ) : null}
          </div>
        </div>

        {ownerMode && managingColumns ? (
          <ManageColumns categories={serviceCategories} onClose={() => setManagingColumns(false)} />
        ) : null}

        {serviceCategories.length === 0 ? (
          <p className="empty-state">
            No board columns yet.
            {ownerMode ? ' Use “Manage columns” to add one.' : ''}
          </p>
        ) : (
          <>
            {hasGroups ? (
              <nav className="board-group-strip" aria-label="Board groups">
                {boardGroups.map((group) => {
                  const key = groupKey(group.name)
                  return (
                    <button
                      key={key}
                      type="button"
                      className="board-group-chip"
                      // A group with every column hidden has no header to go to.
                      disabled={!group.columns.some(isShown)}
                      onClick={() => scrollToGroup(key)}
                    >
                      <span>{group.name ?? OTHER_GROUP_LABEL}</span>{' '}
                      <span className="status-pill">{group.openClientCount}</span>
                    </button>
                  )
                })}
              </nav>
            ) : null}
            <div className="board-scroll">
              {filteredColumns.every((col) => col.clients.length === 0) && query.trim() ? (
                <p className="empty-state">No clients or checklists match "{query.trim()}".</p>
              ) : null}
              {hasGroups
                ? boardGroups.map((group) => {
                    const shownColumns = group.columns.filter(isShown)
                    if (shownColumns.length === 0) return null
                    const key = groupKey(group.name)
                    const label = group.name ?? OTHER_GROUP_LABEL
                    return (
                      <section key={key} className="board-group" aria-label={label}>
                        <div
                          className="board-group-header"
                          ref={(element) => {
                            if (element) groupHeaderRefs.current.set(key, element)
                            else groupHeaderRefs.current.delete(key)
                          }}
                        >
                          <strong>{label}</strong>
                          <span className="status-pill">{group.openClientCount}</span>
                        </div>
                        <div className="board-group-columns">{shownColumns.map(renderColumn)}</div>
                      </section>
                    )
                  })
                : filteredColumns.filter(isShown).map(renderColumn)}
            </div>
          </>
        )}
      </section>
    </section>
  )
}

/**
 * A faded, NON-interactive informational card for a projected ("upcoming")
 * recurring occurrence that has not yet been materialized. No checkboxes, no
 * expand-to-edit, no delete — purely a heads-up that the task is coming. None of
 * the board's mutation handlers are wired here, so a projected item can never
 * trigger a write (and its `projected:` id never reaches the server).
 */
function ProjectedCard({ checklist }: { checklist: Checklist }): ReactNode {
  const dueLabel = formatGhostDueDate(checklist.dueDate)
  return (
    <article
      className="checklist-card projected"
      aria-disabled="true"
      title={`Upcoming · due ${dueLabel}`}
    >
      <div className="checklist-card-head">
        <div className="checklist-card-title">
          <span className="upcoming-badge">Upcoming</span>
          <strong>{checklist.title}</strong>
        </div>
        <span className="projected-due">Due {dueLabel}</span>
      </div>
      <p className="projected-note">
        Not yet created — this recurring task will appear here when it’s due.
      </p>
    </article>
  )
}

/** Friendly "Mon D, YYYY" for a yyyy-mm-dd due date (parsed at noon to avoid TZ slips). */
function formatGhostDueDate(dueDate: string): string {
  const parsed = new Date(`${dueDate}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return dueDate
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed)
}

/**
 * Compact toolbar dropdown to filter the board — by client or by team member
 * (the `noun` prop names what's being filtered). Empty selection = all;
 * checking one or more narrows the board. Multi-select via checkboxes;
 * "Clear" resets to all.
 */
function BoardFilter({
  noun,
  options,
  selected,
  onChange,
}: {
  /** Singular label for the thing filtered, e.g. "client" or "team member". */
  noun: string
  options: Array<{ id: string; label: string }>
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // Close when clicking outside the control.
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const selectedSet = new Set(selected)
  const toggle = (id: string) => {
    const next = new Set(selectedSet)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }
  const label =
    selected.length === 0
      ? `All ${noun}s`
      : selected.length === 1
        ? options.find((option) => option.id === selected[0])?.label ?? `1 ${noun}`
        : `${selected.length} ${noun}s`

  return (
    <div className="board-client-filter" ref={ref}>
      <button
        type="button"
        className="secondary-action"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Filter size={14} /> {label} <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="board-client-filter-menu" role="menu">
          <div className="board-client-filter-head">
            <span>Filter by {noun}</span>
            {selected.length > 0 ? (
              <button type="button" className="link-button" onClick={() => onChange([])}>
                Clear
              </button>
            ) : null}
          </div>
          <div className="board-client-filter-list">
            {options.map((option) => (
              <label key={option.id} className="board-client-filter-item">
                <input
                  type="checkbox"
                  checked={selectedSet.has(option.id)}
                  onChange={() => toggle(option.id)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** "Jul 28" from a yyyy-mm-dd string, for the due/overdue chips. MONTH_NAMES is 1-based (index 0 unused). */
function shortDate(iso: string): string {
  const month = Number(iso.slice(5, 7))
  const day = Number(iso.slice(8, 10))
  return `${(MONTH_NAMES[month] ?? '').slice(0, 3)} ${day}`
}

/** The due / overdue / waiting chip itself; reason text only for waiting (the same word the card's badge and the Waiting filter use). */
function StatusChip({ status }: { status: BoardChecklistStatus }) {
  if (status.kind === 'pending') {
    const [first] = status.reasons
    const extra = status.waitingCount - 1
    return (
      <span className="board-chip board-chip-pending" title={status.reasons.join(' · ')}>
        Waiting — {first}
        {extra > 0 ? ` (+${extra} more)` : ''}
      </span>
    )
  }
  if (status.kind === 'overdue') {
    return <span className="board-chip board-chip-overdue">Overdue — was due {shortDate(status.due)}</span>
  }
  return <span className="board-chip board-chip-due">Due {shortDate(status.due)}</span>
}

function BoardColumnView({
  column,
  renderCard,
  statusFor,
  teamTagFor,
  currentStepOnly,
  stepSummaryFor,
}: {
  column: BoardColumn
  renderCard: (checklist: Checklist) => ReactNode
  statusFor: (checklist: Checklist) => BoardChecklistStatus
  /** Teammate's name when this card belongs to someone under the viewer. */
  teamTagFor: (checklist: Checklist) => string | null
  currentStepOnly: boolean
  /** Where a real checklist is; null for a projected ghost. */
  stepSummaryFor: (checklist: Checklist) => BoardStepSummary | null
}) {
  return (
    <div className="board-column" data-uncategorized={column.id === UNCATEGORIZED_ID}>
      <div className="board-column-header">
        <strong>{column.name}</strong>
        <span className="status-pill">{column.openClientCount}</span>
      </div>
      <div className="board-column-body">
        {column.clients.length === 0 ? (
          <p className="board-column-empty">No open clients.</p>
        ) : (
          column.clients.map((clientRow) => (
            <BoardClientRow
              key={clientRow.clientId}
              name={clientRow.name}
              checklists={clientRow.checklists}
              renderCard={renderCard}
              statusFor={statusFor}
              teamTagFor={teamTagFor}
              currentStepOnly={currentStepOnly}
              stepSummaryFor={stepSummaryFor}
            />
          ))
        )}
      </div>
    </div>
  )
}

function BoardClientRow({
  name,
  checklists,
  renderCard,
  statusFor,
  teamTagFor,
  currentStepOnly,
  stepSummaryFor,
}: {
  name: string
  checklists: Checklist[]
  renderCard: (checklist: Checklist) => ReactNode
  statusFor: (checklist: Checklist) => BoardChecklistStatus
  teamTagFor: (checklist: Checklist) => string | null
  currentStepOnly: boolean
  stepSummaryFor: (checklist: Checklist) => BoardStepSummary | null
}) {
  const [open, setOpen] = useState(false)
  // Collapsed roll-up: how many of this client's checklists are blocked vs
  // overdue, so the row reads at a glance without expanding.
  const statuses = checklists.map(statusFor)
  const pendingCount = statuses.filter((status) => status.kind === 'pending').length
  const overdueCount = statuses.filter((status) => status.kind === 'overdue').length
  const rollUp = (
    <>
      <span className="board-client-name">{name}</span>
      {pendingCount > 0 ? (
        <span className="board-chip board-chip-pending">{pendingCount} waiting</span>
      ) : null}
      {overdueCount > 0 ? (
        <span className="board-chip board-chip-overdue">{overdueCount} overdue</span>
      ) : null}
      <span className="board-client-count">{checklists.length}</span>
    </>
  )

  // "Current step only": the row is always open and each checklist shows where
  // it is instead of its whole card. Ghosts keep their Upcoming card.
  if (currentStepOnly) {
    return (
      <div className="board-client">
        <div className="board-client-toggle board-client-head">{rollUp}</div>
        <div className="board-client-cards">
          {checklists.map((checklist, index) => {
            const teamTag = teamTagFor(checklist)
            const summary = checklist.projected ? null : stepSummaryFor(checklist)
            return (
              <div
                className="board-card-with-status"
                data-team={teamTag ? 'true' : undefined}
                key={checklist.id}
              >
                <div className="board-card-chips">
                  <StatusChip status={statuses[index]} />
                  {teamTag ? (
                    <span className="board-chip board-chip-team">{teamTag}’s</span>
                  ) : null}
                </div>
                {summary ? (
                  <BoardStepBlock checklist={checklist} summary={summary} />
                ) : (
                  renderCard(checklist)
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="board-client">
      <button
        type="button"
        className="board-client-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {rollUp}
      </button>
      {open ? (
        <div className="board-client-cards">
          {checklists.map((checklist, index) => {
            const teamTag = teamTagFor(checklist)
            return (
              <div
                className="board-card-with-status"
                data-team={teamTag ? 'true' : undefined}
                key={checklist.id}
              >
                <div className="board-card-chips">
                  <StatusChip status={statuses[index]} />
                  {teamTag ? (
                    <span className="board-chip board-chip-team">{teamTag}’s</span>
                  ) : null}
                </div>
                {renderCard(checklist)}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * "Current step only" (featreq-338b1507): the STEP one checklist is on, in bold
 * ("Step N of M - <stage>" on a staged case, else its name), who it is for, how
 * many of its tasks are done and the next stage - never the tasks themselves
 * (Brittany: the step is the unit, the items under it are its tasks). The
 * status chip above already carries Due / Overdue / Waiting.
 */
function BoardStepBlock({ checklist, summary }: { checklist: Checklist; summary: BoardStepSummary }) {
  return (
    <div className="board-step-block">
      {summary.stepLabel !== checklist.title ? (
        <span className="board-step-title">{checklist.title}</span>
      ) : null}
      <strong className="board-step-label">{summary.stepLabel}</strong>
      <span className="board-step-meta">
        {summary.assigneeName ? <span className="board-step-who">{summary.assigneeName}</span> : null}
        <span className="board-step-count">
          {summary.taskCount === 0
            ? 'No tasks yet'
            : `${summary.taskDoneCount} of ${summary.taskCount} ${summary.taskCount === 1 ? 'task' : 'tasks'} done`}
        </span>
      </span>
      {summary.nextStepLabel ? <span className="board-step-next">{summary.nextStepLabel}</span> : null}
      <Link className="board-step-open" to={`/checklists?focus=${encodeURIComponent(checklist.id)}`}>
        Open checklist
      </Link>
    </div>
  )
}

/**
 * Owner-only column manager: add, rename, reorder (up/down), and delete board
 * columns. Each action persists immediately via the context mutators (which
 * round-trip to the server and refresh the list).
 */
function ManageColumns({
  categories,
  onClose,
}: {
  categories: ServiceCategory[]
  onClose: () => void
}) {
  const { addServiceCategory, updateServiceCategory, deleteServiceCategory } = useAppContext()
  const [newName, setNewName] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [busy, setBusy] = useState(false)
  // The group names already in use, offered by every Group input.
  const groupNames = [
    ...new Set(categories.map((category) => category.groupName?.trim() ?? '').filter(Boolean)),
  ]

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      /* surfaced by the failed request; keep the panel usable */
    } finally {
      setBusy(false)
    }
  }

  const handleAdd = async () => {
    const name = newName.trim()
    if (!name) return
    const group = newGroup.trim()
    await run(async () => {
      if (group) await addServiceCategory(name, group)
      else await addServiceCategory(name)
      setNewName('')
      setNewGroup('')
    })
  }

  const move = (index: number, direction: -1 | 1) => {
    const current = categories[index]
    const target = categories[index + direction]
    if (!current || !target) return
    void run(async () => {
      // Swap sort orders so the two columns trade places.
      await updateServiceCategory(current.id, { sortOrder: target.sortOrder })
      await updateServiceCategory(target.id, { sortOrder: current.sortOrder })
    })
  }

  return (
    <div className="manage-columns">
      <div className="manage-columns-head">
        <h3>Board columns</h3>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Done">
          <X size={16} />
        </button>
      </div>
      <ul className="manage-columns-list">
        {categories.map((category, index) => (
          <li key={category.id} className="manage-columns-row">
            <GripVertical size={14} className="manage-columns-grip" aria-hidden="true" />
            <input
              className="input"
              defaultValue={category.name}
              aria-label={`Rename ${category.name}`}
              disabled={busy}
              onBlur={(event) => {
                const next = event.target.value.trim()
                if (next && next !== category.name) {
                  void run(() => updateServiceCategory(category.id, { name: next }))
                }
              }}
            />
            <ColumnGroupInput
              category={category}
              disabled={busy}
              onSave={(groupName) => void run(() => updateServiceCategory(category.id, { groupName }))}
            />
            <div className="manage-columns-actions">
              <button
                type="button"
                className="icon-button"
                aria-label="Move up"
                disabled={busy || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Move down"
                disabled={busy || index === categories.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Delete ${category.name}`}
                disabled={busy}
                onClick={() => {
                  const confirmed = window.confirm(
                    `Delete the “${category.name}” column?\n\nChecklists in it aren't deleted — they move to an “Uncategorized” column until you re-tag them.`,
                  )
                  if (confirmed) void run(() => deleteServiceCategory(category.id))
                }}
              >
                <X size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="manage-columns-add">
        <input
          className="input"
          placeholder="New column name…"
          value={newName}
          disabled={busy}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void handleAdd()
            }
          }}
        />
        <input
          className="input"
          placeholder="Group (optional)"
          aria-label="Group for the new column"
          list="board-group-names"
          value={newGroup}
          disabled={busy}
          onChange={(event) => setNewGroup(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void handleAdd()
            }
          }}
        />
        <button
          type="button"
          className="primary-action"
          disabled={busy || !newName.trim()}
          onClick={() => void handleAdd()}
        >
          <Plus size={14} /> Add column
        </button>
      </div>
      <datalist id="board-group-names">
        {groupNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  )
}

/**
 * A column's Group (featreq-54bf39b6) in Manage columns: saves on blur or
 * Enter, trimmed; an empty box clears the group (null). The value last sent is
 * remembered so the blur that follows an Enter does not save it twice.
 */
function ColumnGroupInput({
  category,
  disabled,
  onSave,
}: {
  category: ServiceCategory
  disabled: boolean
  onSave: (groupName: string | null) => void
}) {
  const lastSaved = useRef(category.groupName ?? '')
  const save = (value: string) => {
    const next = value.trim()
    if (next === lastSaved.current) return
    lastSaved.current = next
    onSave(next || null)
  }
  return (
    <input
      className="input"
      defaultValue={category.groupName ?? ''}
      placeholder="Group"
      aria-label={`Group for ${category.name}`}
      list="board-group-names"
      disabled={disabled}
      onBlur={(event) => save(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          save(event.currentTarget.value)
        }
      }}
    />
  )
}
