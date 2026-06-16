import { ChevronDown, ChevronRight, GripVertical, Plus, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import {
  buildActiveBoard,
  boardPeriodRange,
  UNCATEGORIZED_ID,
  type BoardColumn,
  type PeriodType,
} from '../lib/activeBoard'
import { useAppContext } from '../AppContext'
import { ChecklistCard } from './ChecklistsPage'
import { stageNameFor } from '../lib/utils'
import type { Checklist, ServiceCategory } from '../lib/types'

const PERIOD_OPTIONS: Array<{ value: PeriodType; label: string }> = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
]

/**
 * The Active Checklists board: one column per service category (Monthly
 * Bookkeeping, Sales Tax, Payroll, …), each listing the clients that still have
 * open work of that type. Collapsible client rows expand to the live checklist.
 * Completing a client's checklist drops it off automatically. A period toggle
 * scopes the horizon (week / month / quarter). Staff see only their assigned
 * clients (visibleChecklists is already scoped server-side).
 */
export function ActiveChecklistsBoardPage() {
  const ctx = useAppContext()
  const {
    visibleChecklists,
    data,
    serviceCategories,
    ownerMode,
    role,
    activeEmployeeId,
  } = ctx

  const [periodType, setPeriodType] = useState<PeriodType>('month')
  const [managingColumns, setManagingColumns] = useState(false)

  const today = new Date().toISOString().slice(0, 10)

  const clientNameById = useMemo(
    () => Object.fromEntries(data.clients.map((client) => [client.id, client.name])),
    [data.clients],
  )

  const board = useMemo(
    () =>
      buildActiveBoard({
        checklists: visibleChecklists,
        categories: serviceCategories,
        periodType,
        today,
        clientNameById,
      }),
    [visibleChecklists, serviceCategories, periodType, today, clientNameById],
  )

  const range = boardPeriodRange(periodType, today)
  const totalOpen = board.columns.reduce((sum, col) => sum + col.openClientCount, 0)

  // Full-fidelity card, wired to the same context handlers the Checklists page
  // uses — so checking items off the board behaves identically (and completing
  // a checklist drops its client off the column on the next render).
  const renderCard = (checklist: Checklist): ReactNode => (
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

  return (
    <section className="content-grid one-column" id="active-board">
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Active Checklists</h2>
            <p className="section-subtitle">
              {totalOpen === 0
                ? 'Nothing open in this period — nice.'
                : `${totalOpen} client${totalOpen === 1 ? '' : 's'} with open work · ${range.start} → ${range.end}`}
            </p>
          </div>
          <div className="board-controls">
            <div className="group-by-toggle" role="group" aria-label="Period">
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={periodType === option.value ? 'group-by-btn active' : 'group-by-btn'}
                  aria-pressed={periodType === option.value}
                  onClick={() => setPeriodType(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
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
            {board.columns.map((column) => (
              <BoardColumnView key={column.id} column={column} renderCard={renderCard} />
            ))}
          </div>
        )}
      </section>
    </section>
  )
}

function BoardColumnView({
  column,
  renderCard,
}: {
  column: BoardColumn
  renderCard: (checklist: Checklist) => ReactNode
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
}: {
  name: string
  checklists: Checklist[]
  renderCard: (checklist: Checklist) => ReactNode
}) {
  const [open, setOpen] = useState(false)
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
        <span className="board-client-count">{checklists.length}</span>
      </button>
      {open ? <div className="board-client-cards">{checklists.map(renderCard)}</div> : null}
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
