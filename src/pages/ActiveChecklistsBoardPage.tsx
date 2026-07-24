import { ChevronDown, ChevronRight, Filter, GripVertical, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  boardChecklistStatus,
  buildActiveBoard,
  UNCATEGORIZED_ID,
  type BoardChecklistStatus,
  type BoardColumn,
} from '../lib/activeBoard'
import { useAppContext } from '../AppContext'
import { ListSearch } from '../components/ListSearch'
import { ReportPeriodControl } from '../components/ReportPeriodControl'
import { reportPeriodLabel } from '../lib/reportPeriod'
import { projectUpcomingChecklists } from '../lib/projectRecurring'
import { ChecklistCard } from './ChecklistsPage'
import { localDateOnly, MONTH_NAMES, stageNameFor } from '../lib/utils'
import type { Checklist, ServiceCategory } from '../lib/types'

/**
 * The Active Checklists board: one column per service category (Monthly
 * Bookkeeping, Sales Tax, Payroll, …), each listing the clients that still have
 * open work of that type. Collapsible client rows expand to the live checklist.
 * Completing a client's checklist drops it off automatically. The shared Report
 * period scopes the horizon: a client shows while it has open work whose
 * effective due date is on or before the period's end (overdue work stays
 * visible — the board is a horizon view, not a strict window). Staff see only
 * their assigned clients (visibleChecklists is already scoped server-side).
 */
export function ActiveChecklistsBoardPage() {
  const ctx = useAppContext()
  const {
    visibleChecklists,
    visibleClientIds,
    data,
    serviceCategories,
    ownerMode,
    role,
    activeEmployeeId,
    reportPeriod,
    setReportPeriod,
  } = ctx

  const [managingColumns, setManagingColumns] = useState(false)
  const [query, setQuery] = useState('')
  // Upcoming (projected) items default OFF — owner preference: the board opens
  // showing only real, materialized work; the toggle brings ghosts back.
  const [showUpcoming, setShowUpcoming] = useState(false)
  // Client filter: empty = all clients; otherwise the board shows only items for
  // the selected clients (single or multiple).
  const [clientFilter, setClientFilter] = useState<string[]>([])
  // Team-member filter: empty = everyone; otherwise only checklists assigned
  // to the selected member(s).
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([])

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

  // The clients that actually have work on the board right now — the filter only
  // offers clients you could meaningfully pick (and it hides itself for ≤1).
  const clientFilterOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const checklist of visibleChecklists) ids.add(checklist.clientId)
    for (const ghost of projectedGhosts) ids.add(ghost.clientId)
    return [...ids]
      .map((id) => ({ id, label: clientNameById[id] ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [visibleChecklists, projectedGhosts, clientNameById])

  const clientFilterSet = useMemo(() => new Set(clientFilter), [clientFilter])
  const assigneeFilterSet = useMemo(() => new Set(assigneeFilter), [assigneeFilter])

  // Members offered by the team filter: only those with work on the board now.
  const assigneeFilterOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const checklist of visibleChecklists) {
      if (checklist.assigneeId) ids.add(checklist.assigneeId)
    }
    for (const ghost of projectedGhosts) {
      if (ghost.assigneeId) ids.add(ghost.assigneeId)
    }
    const nameById = new Map(data.employees.map((employee) => [employee.id, employee.name]))
    return [...ids]
      .map((id) => ({ id, label: nameById.get(id) ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [visibleChecklists, projectedGhosts, data.employees])

  const board = useMemo(() => {
    const all = [...visibleChecklists, ...projectedGhosts]
    const scoped = all.filter(
      (checklist) =>
        (clientFilterSet.size === 0 || clientFilterSet.has(checklist.clientId)) &&
        (assigneeFilterSet.size === 0 ||
          (checklist.assigneeId ? assigneeFilterSet.has(checklist.assigneeId) : false)),
    )
    return buildActiveBoard({
      checklists: scoped,
      categories: serviceCategories,
      horizonEnd: reportPeriod.to,
      today,
      clientNameById,
    })
  }, [
    visibleChecklists,
    projectedGhosts,
    clientFilterSet,
    assigneeFilterSet,
    serviceCategories,
    reportPeriod.to,
    today,
    clientNameById,
  ])

  const totalOpen = board.columns.reduce((sum, col) => sum + col.openClientCount, 0)

  const filteredColumns = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return board.columns
    return board.columns.map((col) => {
      const filteredClients = col.clients.filter((clientRow) => {
        const nameMatch = clientRow.name.toLowerCase().includes(q)
        const titleMatch = clientRow.checklists.some((c) =>
          c.title.toLowerCase().includes(q),
        )
        return nameMatch || titleMatch
      }).map((clientRow) => {
        const q2 = query.trim().toLowerCase()
        const nameMatch = clientRow.name.toLowerCase().includes(q2)
        return {
          ...clientRow,
          checklists: nameMatch
            ? clientRow.checklists
            : clientRow.checklists.filter((c) => c.title.toLowerCase().includes(q2)),
        }
      })
      return {
        ...col,
        clients: filteredClients,
        openClientCount: filteredClients.length,
      }
    })
  }, [board.columns, query])

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
    />
    )
  }

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
          <div className="board-scroll">
            {filteredColumns.every((col) => col.clients.length === 0) && query.trim() ? (
              <p className="empty-state">No clients or checklists match "{query.trim()}".</p>
            ) : null}
            {filteredColumns.map((column) => (
              <BoardColumnView
                key={column.id}
                column={column}
                renderCard={renderCard}
                statusFor={statusFor}
              />
            ))}
          </div>
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

/** "Jul 28" from a yyyy-mm-dd string, for the due/overdue chips. */
function shortDate(iso: string): string {
  const month = Number(iso.slice(5, 7))
  const day = Number(iso.slice(8, 10))
  return `${(MONTH_NAMES[month - 1] ?? '').slice(0, 3)} ${day}`
}

/** The due / overdue / pending chip itself; reason text only for pending. */
function StatusChip({ status }: { status: BoardChecklistStatus }) {
  if (status.kind === 'pending') {
    const [first] = status.reasons
    const extra = status.waitingCount - 1
    return (
      <span className="board-chip board-chip-pending" title={status.reasons.join(' · ')}>
        Pending — {first}
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
}: {
  column: BoardColumn
  renderCard: (checklist: Checklist) => ReactNode
  statusFor: (checklist: Checklist) => BoardChecklistStatus
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
}: {
  name: string
  checklists: Checklist[]
  renderCard: (checklist: Checklist) => ReactNode
  statusFor: (checklist: Checklist) => BoardChecklistStatus
}) {
  const [open, setOpen] = useState(false)
  // Collapsed roll-up: how many of this client's checklists are blocked vs
  // overdue, so the row reads at a glance without expanding.
  const statuses = checklists.map(statusFor)
  const pendingCount = statuses.filter((status) => status.kind === 'pending').length
  const overdueCount = statuses.filter((status) => status.kind === 'overdue').length
  return (
    <div className="board-client">
      <button
        type="button"
        className="board-client-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="board-client-name">{name}</span>
        {pendingCount > 0 ? (
          <span className="board-chip board-chip-pending">{pendingCount} pending</span>
        ) : null}
        {overdueCount > 0 ? (
          <span className="board-chip board-chip-overdue">{overdueCount} overdue</span>
        ) : null}
        <span className="board-client-count">{checklists.length}</span>
      </button>
      {open ? (
        <div className="board-client-cards">
          {checklists.map((checklist, index) => (
            <div className="board-card-with-status" key={checklist.id}>
              <StatusChip status={statuses[index]} />
              {renderCard(checklist)}
            </div>
          ))}
        </div>
      ) : null}
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
  const [busy, setBusy] = useState(false)

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
    await run(async () => {
      await addServiceCategory(name)
      setNewName('')
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
        <button
          type="button"
          className="primary-action"
          disabled={busy || !newName.trim()}
          onClick={() => void handleAdd()}
        >
          <Plus size={14} /> Add column
        </button>
      </div>
    </div>
  )
}
