import { ChevronDown, ChevronRight, Copy, GripVertical, Plus } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { FilterBar } from '../components/FilterBar'
import { useFilters } from '../components/useFilters'
import { SharingControl } from '../components/SharingControl'
import type {
  Checklist,
  ChecklistFrequency,
  ChecklistItem,
  ChecklistTemplate,
  ChecklistTemplateItem,
  Client,
  Employee,
  Role,
  TemplateStage,
} from '../lib/types'
import {
  checklistFrequencies,
  clientName,
  employeeName,
  getChecklistFrequencyLabel,
  lastDayOfCurrentMonth,
  makeId,
  shortDate,
} from '../lib/utils'

type Group = 'today' | 'week' | 'later' | 'completed'

function parseBulkLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function groupChecklist(checklist: Checklist, todayDateOnly: string): Group {
  const completed = checklist.items.filter((item) => item.done).length
  const total = checklist.items.length
  if (total > 0 && completed === total) return 'completed'
  if (checklist.dueDate <= todayDateOnly) return 'today'
  // within next 7 days
  const today = new Date(`${todayDateOnly}T12:00:00`)
  const due = new Date(`${checklist.dueDate}T12:00:00`)
  const days = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  if (days <= 7) return 'week'
  return 'later'
}

function statusForChecklist(checklist: Checklist, todayDateOnly: string) {
  const completed = checklist.items.filter((item) => item.done).length
  const total = checklist.items.length
  const allDone = total > 0 && completed === total
  if (allDone) return 'completed'
  if (checklist.dueDate < todayDateOnly) return 'overdue'
  return 'active'
}

function firstName(employees: Employee[], employeeId: string) {
  const employee = employees.find((entry) => entry.id === employeeId)
  if (!employee) return 'Unassigned'
  return employee.name.split(' ')[0]
}

export function ChecklistsPage() {
  const {
    activeEmployeeId,
    visibleChecklists,
    data,
    role,
    ownerMode,
    toggleChecklistItem,
    setChecklistViewers,
    setTemplateViewers,
    addChecklistTemplate,
    updateChecklistTemplate,
    deleteChecklistTemplate,
    addChecklistTemplateItem,
    removeChecklistTemplateItem,
    updateChecklistTemplateItem,
    setChecklistTemplateItemDueDate,
    setChecklistTemplateItemAssignee,
    reorderChecklistTemplateItems,
    bulkAddChecklistTemplateItems,
    duplicateChecklistTemplate,
    addTemplateStage,
    removeTemplateStage,
    patchTemplateStage,
    reorderTemplateStages,
    reorderChecklistItems,
    bulkAddChecklistItems,
    createChecklist,
    updateChecklistItem,
    deleteChecklistItem,
  } = useAppContext()

  return (
    <section className="content-grid two-column" id="checklists">
      <ChecklistPanel
        activeEmployeeId={activeEmployeeId}
        checklists={visibleChecklists}
        clients={data.clients}
        employees={data.employees}
        onBulkAddItems={bulkAddChecklistItems}
        onCreateChecklist={createChecklist}
        onDeleteItem={deleteChecklistItem}
        onReorderItems={reorderChecklistItems}
        onSetViewers={setChecklistViewers}
        onToggle={toggleChecklistItem}
        onUpdateItem={updateChecklistItem}
        ownerMode={ownerMode}
        role={role}
      />
      {ownerMode ? (
        <ChecklistTemplateManager
          clients={data.clients}
          employees={data.employees}
          onAddItem={addChecklistTemplateItem}
          onAddStage={addTemplateStage}
          onBulkAddItems={bulkAddChecklistTemplateItems}
          onCreate={addChecklistTemplate}
          onDeleteItem={removeChecklistTemplateItem}
          onDeleteTemplate={deleteChecklistTemplate}
          onDuplicate={duplicateChecklistTemplate}
          onPatchStage={patchTemplateStage}
          onRemoveStage={removeTemplateStage}
          onReorderItems={reorderChecklistTemplateItems}
          onReorderStages={reorderTemplateStages}
          onSetItemAssignee={setChecklistTemplateItemAssignee}
          onSetItemDueDate={setChecklistTemplateItemDueDate}
          onSetViewers={setTemplateViewers}
          onUpdateItem={updateChecklistTemplateItem}
          onUpdateTemplate={updateChecklistTemplate}
          templates={data.checklistTemplates}
        />
      ) : null}
    </section>
  )
}

function ChecklistPanel({
  activeEmployeeId,
  checklists,
  clients,
  employees,
  onBulkAddItems,
  onCreateChecklist,
  onDeleteItem,
  onReorderItems,
  onSetViewers,
  onToggle,
  onUpdateItem,
  ownerMode,
  role,
}: {
  activeEmployeeId: string
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  onBulkAddItems: (checklistId: string, labels: string[]) => void
  onCreateChecklist: (payload: {
    title: string
    clientId: string
    assigneeId: string
    dueDate: string
    items: Array<{ label: string }>
  }) => Promise<void>
  onDeleteItem: (checklistId: string, itemId: string) => Promise<void>
  onReorderItems: (checklistId: string, orderedIds: string[]) => void
  onSetViewers: (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void> | void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  onUpdateItem: (
    checklistId: string,
    itemId: string,
    patch: { title?: string; dueDate?: string | null; assigneeId?: string | null },
  ) => Promise<void>
  ownerMode: boolean
  role: Role
}) {
  const todayDateOnly = new Date().toISOString().slice(0, 10)
  const { assignee, client, status } = useFilters()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusId = searchParams.get('focus')
  const focusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!focusId) return
    if (focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    // clear focus param after handling so it doesn't keep re-firing
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams)
      next.delete('focus')
      setSearchParams(next, { replace: true })
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [focusId, searchParams, setSearchParams])

  const filtered = useMemo(() => {
    return checklists.filter((checklist) => {
      if (assignee && checklist.assigneeId !== assignee) return false
      if (client && checklist.clientId !== client) return false
      if (status && status !== 'all') {
        if (statusForChecklist(checklist, todayDateOnly) !== status) return false
      }
      return true
    })
  }, [checklists, assignee, client, status, todayDateOnly])

  const grouped: Record<Group, Checklist[]> = {
    today: [],
    week: [],
    later: [],
    completed: [],
  }
  for (const checklist of filtered) {
    grouped[groupChecklist(checklist, todayDateOnly)].push(checklist)
  }

  const groupConfig: Array<{ key: Group; label: string; defaultOpen: boolean }> = [
    { key: 'today', label: 'Due today / overdue', defaultOpen: true },
    { key: 'week', label: 'This week', defaultOpen: true },
    { key: 'later', label: 'Later', defaultOpen: false },
    { key: 'completed', label: 'Completed', defaultOpen: false },
  ]

  const [showNewChecklist, setShowNewChecklist] = useState(false)
  // Server currently restricts /api/checklists POST to owners; gate the UI to match.
  const canCreateOneOff = role === 'owner'

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">
            {role === 'owner' ? 'Owner checklist view' : 'Assigned checklist'}
          </p>
          <h2>Active checklists</h2>
        </div>
        {canCreateOneOff ? (
          <button
            type="button"
            className="primary-action"
            onClick={() => setShowNewChecklist((value) => !value)}
            aria-expanded={showNewChecklist}
          >
            <Plus size={14} />
            {showNewChecklist ? 'Cancel' : 'New checklist'}
          </button>
        ) : null}
      </div>
      {showNewChecklist && canCreateOneOff ? (
        <NewChecklistForm
          activeEmployeeId={activeEmployeeId}
          clients={clients}
          employees={employees}
          onCancel={() => setShowNewChecklist(false)}
          onCreate={async (payload) => {
            await onCreateChecklist(payload)
            setShowNewChecklist(false)
          }}
          role={role}
        />
      ) : null}
      <FilterBar employees={employees} clients={clients} />
      <div className="checklist-stack">
        {filtered.length === 0 ? (
          <p className="empty-state">No checklist instances match your filters.</p>
        ) : null}
        {groupConfig.map((group) =>
          grouped[group.key].length === 0 ? null : (
            <ChecklistGroup
              key={group.key}
              defaultOpen={group.defaultOpen}
              label={group.label}
              count={grouped[group.key].length}
            >
              {grouped[group.key].map((checklist) => (
                <ChecklistCard
                  key={checklist.id}
                  activeEmployeeId={activeEmployeeId}
                  checklist={checklist}
                  clients={clients}
                  employees={employees}
                  focused={checklist.id === focusId}
                  focusRef={checklist.id === focusId ? focusRef : null}
                  onBulkAddItems={onBulkAddItems}
                  onDeleteItem={onDeleteItem}
                  onReorderItems={onReorderItems}
                  onSetViewers={onSetViewers}
                  onToggle={onToggle}
                  onUpdateItem={onUpdateItem}
                  ownerMode={ownerMode}
                  role={role}
                />
              ))}
            </ChecklistGroup>
          ),
        )}
      </div>
    </section>
  )
}

function ChecklistGroup({
  defaultOpen,
  label,
  count,
  children,
}: {
  defaultOpen: boolean
  label: string
  count: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="checklist-group">
      <button
        type="button"
        className="checklist-group-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <strong>{label}</strong>
        <span>{count}</span>
      </button>
      {open ? <div className="checklist-group-body">{children}</div> : null}
    </div>
  )
}

function ChecklistCard({
  activeEmployeeId,
  checklist,
  clients,
  employees,
  focused,
  focusRef,
  onBulkAddItems,
  onDeleteItem,
  onReorderItems,
  onSetViewers,
  onToggle,
  onUpdateItem,
  ownerMode,
  role,
}: {
  activeEmployeeId: string
  checklist: Checklist
  clients: Client[]
  employees: Employee[]
  focused: boolean
  focusRef: React.MutableRefObject<HTMLElement | null> | null
  onBulkAddItems: (checklistId: string, labels: string[]) => void
  onDeleteItem: (checklistId: string, itemId: string) => Promise<void>
  onReorderItems: (checklistId: string, orderedIds: string[]) => void
  onSetViewers: (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void> | void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  onUpdateItem: (
    checklistId: string,
    itemId: string,
    patch: { title?: string; dueDate?: string | null; assigneeId?: string | null },
  ) => Promise<void>
  ownerMode: boolean
  role: Role
}) {
  const todayDateOnly = new Date().toISOString().slice(0, 10)
  const completed = checklist.items.filter((item) => item.done).length
  const allDone = checklist.items.length > 0 && completed === checklist.items.length
  const viewerIds = checklist.viewerIds ?? []
  const editorIds = checklist.editorIds ?? []
  const isAssignee = checklist.assigneeId === activeEmployeeId
  const isEditor = editorIds.includes(activeEmployeeId)
  const isViewerOnly =
    role !== 'owner' && !isAssignee && viewerIds.includes(activeEmployeeId) && !isEditor
  // Whether the current viewer can edit checklist structure (reorder, bulk add)
  const canEditStructure = role === 'owner' || isAssignee || isEditor

  const stageCount = checklist.stageCount ?? 1
  const stageIndex = checklist.stageIndex ?? 0
  const showStageBadge = stageCount > 1
  const stageNumber = stageIndex + 1
  const isLastStage = stageNumber >= stageCount
  // When all items are checked off and there's a next stage, the next stage's
  // assignee gets a fresh checklist; show a hand-off indicator instead of the
  // toggle controls. We don't know the next assignee's name from this scope,
  // so we just report the hand-off generically.
  const handedOff = allDone && !isLastStage

  const canToggleItem = (item: ChecklistItem) => {
    if (role === 'owner') return true
    if (isEditor) return true
    if (item.assigneeId) {
      // Item explicitly assigned - only that person (plus owner/editor handled above)
      return item.assigneeId === activeEmployeeId
    }
    return isAssignee
  }

  return (
    <article
      className={focused ? 'checklist-block focused' : 'checklist-block'}
      ref={focusRef as React.RefObject<HTMLElement>}
    >
      <header>
        <div>
          <strong>{checklist.title}</strong>
          {showStageBadge ? (
            <span className="stage-badge">
              Stage {stageNumber} of {stageCount}
              {checklist.caseId && ownerMode ? (
                <Link
                  className="stage-badge-link"
                  to={`/cases/${encodeURIComponent(checklist.caseId)}`}
                >
                  Open case
                </Link>
              ) : null}
            </span>
          ) : null}
          <span className="checklist-meta-line">
            {clientName(clients, checklist.clientId)} ·{' '}
            {employeeName(employees, checklist.assigneeId)} · Due{' '}
            {shortDate.format(new Date(`${checklist.dueDate}T12:00:00`))}
            {checklist.frequency
              ? ` · ${getChecklistFrequencyLabel(checklist.frequency)}`
              : ''}
          </span>
        </div>
        <div className="checklist-meta">
          {handedOff ? <span className="status-pill">Handed off</span> : null}
          {isViewerOnly ? <span className="status-pill">View only</span> : null}
        </div>
      </header>
      <div className="progress-track">
        <span
          style={{
            width: `${checklist.items.length === 0 ? 0 : (completed / checklist.items.length) * 100}%`,
          }}
        />
      </div>
      {canEditStructure && checklist.items.length === 0 ? (
        <p className="checklist-empty-hint">No items yet — add one below.</p>
      ) : null}
      <DraggableTaskList
        canEdit={canEditStructure}
        canReorder={canEditStructure}
        checklistId={checklist.id}
        employees={employees}
        items={checklist.items}
        onCanToggle={canToggleItem}
        onDeleteItem={(itemId) => onDeleteItem(checklist.id, itemId)}
        onReorderItems={onReorderItems}
        onToggle={onToggle}
        onUpdateItem={(itemId, patch) => onUpdateItem(checklist.id, itemId, patch)}
        todayDateOnly={todayDateOnly}
      />
      {canEditStructure ? (
        <>
          <InlineAddItemRow
            onAdd={(label) => onBulkAddItems(checklist.id, [label])}
            placeholder="Add an item..."
          />
          <ChecklistBulkAdd
            label="Paste a list"
            onAdd={(labels) => onBulkAddItems(checklist.id, labels)}
          />
        </>
      ) : null}
      {ownerMode ? (
        <SharingControl
          assigneeId={checklist.assigneeId}
          editorIds={editorIds}
          employees={employees}
          onChange={(nextViewerIds, nextEditorIds) =>
            void onSetViewers(checklist.id, nextViewerIds, nextEditorIds)
          }
          viewerIds={viewerIds}
        />
      ) : null}
    </article>
  )
}

function DraggableTaskList({
  canEdit,
  canReorder,
  checklistId,
  employees,
  items,
  onCanToggle,
  onDeleteItem,
  onReorderItems,
  onToggle,
  onUpdateItem,
  todayDateOnly,
}: {
  canEdit: boolean
  canReorder: boolean
  checklistId: string
  employees: Employee[]
  items: ChecklistItem[]
  onCanToggle: (item: ChecklistItem) => boolean
  onDeleteItem: (itemId: string) => Promise<void>
  onReorderItems: (checklistId: string, orderedIds: string[]) => void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  onUpdateItem: (
    itemId: string,
    patch: { title?: string; dueDate?: string | null; assigneeId?: string | null },
  ) => Promise<void>
  todayDateOnly: string
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const handleDragStart = (event: DragEvent<HTMLDivElement>, itemId: string) => {
    if (!canReorder) return
    setDraggingId(itemId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', itemId)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>, itemId: string) => {
    if (!canReorder || !draggingId || draggingId === itemId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetId(itemId)
  }

  const handleDragLeave = () => {
    setDropTargetId(null)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    if (!canReorder || !draggingId || draggingId === targetId) {
      setDraggingId(null)
      setDropTargetId(null)
      return
    }
    const orderedIds = items.map((item) => item.id)
    const fromIdx = orderedIds.indexOf(draggingId)
    const toIdx = orderedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) {
      setDraggingId(null)
      setDropTargetId(null)
      return
    }
    orderedIds.splice(fromIdx, 1)
    orderedIds.splice(toIdx, 0, draggingId)
    onReorderItems(checklistId, orderedIds)
    setDraggingId(null)
    setDropTargetId(null)
  }

  const handleDragEnd = () => {
    setDraggingId(null)
    setDropTargetId(null)
  }

  return (
    <div className="task-list">
      {items.map((item) => {
        const allowToggle = onCanToggle(item)
        const overdue = Boolean(
          item.dueDate && !item.done && item.dueDate < todayDateOnly,
        )
        const classes = ['task-row']
        if (item.done) classes.push('done')
        if (draggingId === item.id) classes.push('dragging')
        if (dropTargetId === item.id) classes.push('drop-target')
        return (
          <div
            key={item.id}
            className={classes.join(' ')}
            draggable={canReorder}
            onDragStart={(event) => handleDragStart(event, item.id)}
            onDragOver={(event) => handleDragOver(event, item.id)}
            onDragLeave={handleDragLeave}
            onDrop={(event) => handleDrop(event, item.id)}
            onDragEnd={handleDragEnd}
          >
            {canReorder ? (
              <span
                className="drag-handle"
                aria-hidden="true"
                title="Drag to reorder"
              >
                <GripVertical size={14} />
              </span>
            ) : null}
            <input
              checked={item.done}
              disabled={!allowToggle}
              onChange={() => void onToggle(checklistId, item.id)}
              type="checkbox"
            />
            <span className="task-row-body">
              <span className="task-row-title">
                {overdue ? (
                  <span
                    className="overdue-dot"
                    aria-label="Overdue"
                    title="Overdue"
                  />
                ) : null}
                {item.label}
              </span>
              {canEdit ? (
                <span className="task-row-inline-controls">
                  <input
                    aria-label="Due date"
                    className="item-date-input"
                    title="Item due date (optional)"
                    type="date"
                    value={item.dueDate ?? ''}
                    onChange={(e) => {
                      void onUpdateItem(item.id, {
                        dueDate: e.target.value === '' ? null : e.target.value,
                      })
                    }}
                  />
                  <select
                    aria-label="Assignee"
                    className="item-assignee-select"
                    title="Assign to (optional)"
                    value={item.assigneeId ?? ''}
                    onChange={(e) => {
                      void onUpdateItem(item.id, {
                        assigneeId: e.target.value === '' ? null : e.target.value,
                      })
                    }}
                  >
                    <option value="">Inherits</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name.split(' ')[0]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label="Delete item"
                    className="item-delete-btn"
                    title="Delete item"
                    onClick={() => void onDeleteItem(item.id)}
                  >
                    ×
                  </button>
                </span>
              ) : (
                item.dueDate || item.assigneeId ? (
                  <span className="task-row-chips">
                    {item.dueDate ? (
                      <span className="task-chip">
                        Due {shortDate.format(new Date(`${item.dueDate}T12:00:00`))}
                      </span>
                    ) : null}
                    {item.assigneeId ? (
                      <span className="task-chip">{firstName(employees, item.assigneeId)}</span>
                    ) : null}
                  </span>
                ) : null
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function InlineAddItemRow({
  onAdd,
  placeholder,
}: {
  onAdd: (label: string) => void
  placeholder: string
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const submit = () => {
    const value = draft.trim()
    if (!value) return
    onAdd(value)
    setDraft('')
    // Keep focus so users can rapid-fire add multiple items.
    inputRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="inline-add-row">
      <span className="inline-add-checkbox" aria-hidden="true" />
      <input
        ref={inputRef}
        className="inline-add-input"
        aria-label="Add an item"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        type="text"
        value={draft}
      />
      <button
        type="button"
        aria-label="Add item"
        className="inline-add-btn"
        disabled={draft.trim().length === 0}
        onClick={submit}
        title="Add item (Enter)"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}

function ChecklistBulkAdd({
  label = 'Bulk add',
  onAdd,
}: {
  label?: string
  onAdd: (labels: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const lines = useMemo(() => parseBulkLines(draft), [draft])

  const handleAdd = () => {
    if (lines.length === 0) return
    onAdd(lines)
    setDraft('')
    setOpen(false)
  }

  return (
    <div className="bulk-add">
      <button
        type="button"
        className="secondary-action bulk-add-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {label}
      </button>
      {open ? (
        <div className="bulk-add-body">
          <textarea
            className="input"
            placeholder={'One item per line.\n# lines starting with # are ignored'}
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            value={draft}
          />
          <div className="bulk-add-footer">
            <span className="bulk-add-preview">
              Will add {lines.length} item{lines.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="secondary-action"
              disabled={lines.length === 0}
              onClick={handleAdd}
            >
              <Plus size={14} />
              Add as items
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function NewChecklistForm({
  activeEmployeeId,
  clients,
  employees,
  onCancel,
  onCreate,
  role,
}: {
  activeEmployeeId: string
  clients: Client[]
  employees: Employee[]
  onCancel: () => void
  onCreate: (payload: {
    title: string
    clientId: string
    assigneeId: string
    dueDate: string
    items: Array<{ label: string }>
  }) => Promise<void>
  role: Role
}) {
  // Owners can pick any employee. Non-owners are filtered out at the panel
  // level today (server only permits owners to create), but keep this guard
  // so that if the server later allows employees, they only see themselves.
  const assignableEmployees = useMemo(() => {
    if (role === 'owner') return employees
    return employees.filter((employee) => employee.id === activeEmployeeId)
  }, [employees, role, activeEmployeeId])

  const [title, setTitle] = useState('')
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [assigneeId, setAssigneeId] = useState(
    assignableEmployees[0]?.id ?? activeEmployeeId,
  )
  const [dueDate, setDueDate] = useState(lastDayOfCurrentMonth())
  const [itemDraft, setItemDraft] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    const trimmedTitle = title.trim()
    const items = parseBulkLines(itemDraft).map((label) => ({ label }))

    if (!trimmedTitle) {
      setError('Give the checklist a title.')
      return
    }
    if (!clientId) {
      setError('Pick a client.')
      return
    }
    if (!assigneeId) {
      setError('Pick an assignee.')
      return
    }
    if (!dueDate) {
      setError('Pick a due date.')
      return
    }
    if (items.length === 0) {
      setError('Add at least one item — type one per line.')
      return
    }

    setError('')
    setSubmitting(true)
    try {
      await onCreate({
        title: trimmedTitle,
        clientId,
        assigneeId,
        dueDate,
        items,
      })
      setTitle('')
      setItemDraft('')
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create checklist.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="quick-template-form new-checklist-form" onSubmit={handleSubmit}>
      <div className="quick-row">
        <input
          className="input quick-title"
          placeholder="Checklist title (e.g. Onboard Riverbend)"
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </div>
      <div className="quick-row quick-row-meta">
        <select
          className="compact-input"
          aria-label="Client"
          onChange={(event) => setClientId(event.target.value)}
          value={clientId}
        >
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
        <select
          className="compact-input"
          aria-label="Assignee"
          onChange={(event) => setAssigneeId(event.target.value)}
          value={assigneeId}
        >
          {assignableEmployees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Due date"
          className="compact-input"
          onChange={(event) => setDueDate(event.target.value)}
          type="date"
          value={dueDate}
        />
      </div>
      <textarea
        className="input quick-items"
        placeholder={
          'One item per line.\n# lines starting with # are ignored.\nReconcile bank feeds\nReview payroll clearing'
        }
        onChange={(event) => setItemDraft(event.target.value)}
        rows={4}
        value={itemDraft}
      />
      {error ? <p className="auth-error">{error}</p> : null}
      <div className="form-row-actions">
        <button
          type="button"
          className="secondary-action"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button className="primary-action" type="submit" disabled={submitting}>
          <Plus size={16} />
          {submitting ? 'Creating...' : 'Create checklist'}
        </button>
      </div>
    </form>
  )
}

type TemplateManagerProps = {
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string, stageId: string) => void
  onAddStage: (templateId: string) => void
  onBulkAddItems: (templateId: string, stageId: string, labels: string[]) => void
  onCreate: (template: Omit<ChecklistTemplate, 'id'>) => void
  onDeleteItem: (templateId: string, stageId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onDuplicate: (templateId: string) => void
  onPatchStage: (
    templateId: string,
    stageId: string,
    patch: Partial<TemplateStage>,
  ) => void
  onRemoveStage: (templateId: string, stageId: string) => void
  onReorderItems: (templateId: string, stageId: string, orderedIds: string[]) => void
  onReorderStages: (templateId: string, orderedStageIds: string[]) => void
  onSetItemAssignee: (
    templateId: string,
    stageId: string,
    itemId: string,
    assigneeId: string,
  ) => void
  onSetItemDueDate: (
    templateId: string,
    stageId: string,
    itemId: string,
    dueDate: string,
  ) => void
  onSetViewers: (templateId: string, viewerIds: string[], editorIds: string[]) => void
  onUpdateItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    label: string,
  ) => void
  onUpdateTemplate: (
    templateId: string,
    updater: (template: ChecklistTemplate) => ChecklistTemplate,
  ) => void
  templates: ChecklistTemplate[]
}

function ChecklistTemplateManager(props: TemplateManagerProps) {
  const [showNewTemplate, setShowNewTemplate] = useState(false)
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner template controls</p>
          <h2>Recurring templates</h2>
        </div>
        <button
          type="button"
          className="primary-action"
          onClick={() => setShowNewTemplate((value) => !value)}
          aria-expanded={showNewTemplate}
        >
          <Plus size={14} />
          {showNewTemplate ? 'Cancel' : 'New template'}
        </button>
      </div>
      <div className="template-manager">
        {showNewTemplate ? (
          <QuickTemplateForm
            clients={props.clients}
            employees={props.employees}
            onCreate={(template) => {
              props.onCreate(template)
              setShowNewTemplate(false)
            }}
          />
        ) : null}
        <div className="template-list">
          {props.templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              clients={props.clients}
              employees={props.employees}
              onAddItem={props.onAddItem}
              onAddStage={props.onAddStage}
              onBulkAddItems={props.onBulkAddItems}
              onDeleteItem={props.onDeleteItem}
              onDeleteTemplate={props.onDeleteTemplate}
              onDuplicate={props.onDuplicate}
              onPatchStage={props.onPatchStage}
              onRemoveStage={props.onRemoveStage}
              onReorderItems={props.onReorderItems}
              onReorderStages={props.onReorderStages}
              onSetItemAssignee={props.onSetItemAssignee}
              onSetItemDueDate={props.onSetItemDueDate}
              onSetViewers={props.onSetViewers}
              onUpdateItem={props.onUpdateItem}
              onUpdateTemplate={props.onUpdateTemplate}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function QuickTemplateForm({
  clients,
  employees,
  onCreate,
}: {
  clients: Client[]
  employees: Employee[]
  onCreate: (template: Omit<ChecklistTemplate, 'id'>) => void
}) {
  // Sensible defaults: monthly cadence, due last day of current month, title blank, items textarea
  const [title, setTitle] = useState('')
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [assigneeId, setAssigneeId] = useState(employees[0]?.id ?? '')
  const [frequency, setFrequency] = useState<ChecklistFrequency>('monthly')
  const [nextDueDate, setNextDueDate] = useState(lastDayOfCurrentMonth())
  const [itemDraft, setItemDraft] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const items: ChecklistTemplateItem[] = parseBulkLines(itemDraft).map((label) => ({
      id: makeId('template-item'),
      label,
    }))

    if (!title.trim()) {
      setError('Give the template a title.')
      return
    }
    if (items.length === 0) {
      setError('Add at least one item — type one per line.')
      return
    }
    setError('')

    const stage: TemplateStage = {
      id: makeId('stage'),
      name: 'Stage 1',
      assigneeId: assigneeId || employees[0]?.id || '',
      offsetDays: 0,
      viewerIds: [],
      editorIds: [],
      items,
    }

    onCreate({
      title: title.trim(),
      clientId: clientId || clients[0]?.id || '',
      assigneeId: assigneeId || employees[0]?.id || '',
      frequency,
      nextDueDate,
      active: true,
      viewerIds: [],
      editorIds: [],
      stages: [stage],
    })

    setTitle('')
    setItemDraft('')
  }

  return (
    <form className="quick-template-form" onSubmit={handleSubmit}>
      <div className="quick-row">
        <input
          className="input quick-title"
          placeholder="Template title (e.g. Monthly close — Riverbend)"
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </div>
      <div className="quick-row quick-row-meta">
        <select
          className="compact-input"
          aria-label="Client"
          onChange={(event) => setClientId(event.target.value)}
          value={clientId}
        >
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
        <select
          className="compact-input"
          aria-label="Assignee"
          onChange={(event) => setAssigneeId(event.target.value)}
          value={assigneeId}
        >
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name}
            </option>
          ))}
        </select>
        <select
          className="compact-input"
          aria-label="Frequency"
          onChange={(event) => setFrequency(event.target.value as ChecklistFrequency)}
          value={frequency}
        >
          {checklistFrequencies.map((option) => (
            <option key={option} value={option}>
              {getChecklistFrequencyLabel(option)}
            </option>
          ))}
        </select>
        <input
          aria-label="First due date"
          className="compact-input"
          onChange={(event) => setNextDueDate(event.target.value)}
          type="date"
          value={nextDueDate}
        />
      </div>
      <textarea
        className="input quick-items"
        placeholder="One item per line.&#10;Reconcile bank feeds&#10;Review payroll clearing&#10;Send month-end report"
        onChange={(event) => setItemDraft(event.target.value)}
        rows={5}
        value={itemDraft}
      />
      {error ? <p className="auth-error">{error}</p> : null}
      <button className="primary-action" type="submit">
        <Plus size={16} />
        Save template
      </button>
    </form>
  )
}

type TemplateCardProps = {
  template: ChecklistTemplate
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string, stageId: string) => void
  onAddStage: (templateId: string) => void
  onBulkAddItems: (templateId: string, stageId: string, labels: string[]) => void
  onDeleteItem: (templateId: string, stageId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onDuplicate: (templateId: string) => void
  onPatchStage: (
    templateId: string,
    stageId: string,
    patch: Partial<TemplateStage>,
  ) => void
  onRemoveStage: (templateId: string, stageId: string) => void
  onReorderItems: (templateId: string, stageId: string, orderedIds: string[]) => void
  onReorderStages: (templateId: string, orderedStageIds: string[]) => void
  onSetItemAssignee: (
    templateId: string,
    stageId: string,
    itemId: string,
    assigneeId: string,
  ) => void
  onSetItemDueDate: (
    templateId: string,
    stageId: string,
    itemId: string,
    dueDate: string,
  ) => void
  onSetViewers: (templateId: string, viewerIds: string[], editorIds: string[]) => void
  onUpdateItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    label: string,
  ) => void
  onUpdateTemplate: (
    templateId: string,
    updater: (template: ChecklistTemplate) => ChecklistTemplate,
  ) => void
}

function TemplateCard(props: TemplateCardProps) {
  const { template } = props
  const stages = template.stages ?? []
  return (
    <article className="template-card" key={template.id}>
      <div className="template-card-header">
        <div>
          <strong>{template.title}</strong>
          <span>
            {clientName(props.clients, template.clientId)} ·{' '}
            {employeeName(props.employees, template.assigneeId)}
          </span>
        </div>
        <div className="template-card-actions">
          <button
            className="secondary-action"
            onClick={() => props.onDuplicate(template.id)}
            type="button"
            title="Create a new template pre-filled from this one"
          >
            <Copy size={14} />
            Duplicate
          </button>
          <button
            className="secondary-action danger"
            onClick={() => props.onDeleteTemplate(template.id)}
            type="button"
          >
            Remove
          </button>
        </div>
      </div>
      <div className="template-grid">
        <label className="field">
          <span>Title</span>
          <input
            className="input"
            onChange={(event) =>
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                title: event.target.value,
              }))
            }
            value={template.title}
          />
        </label>
        <label className="field">
          <span>Client</span>
          <select
            className="input"
            onChange={(event) =>
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                clientId: event.target.value,
              }))
            }
            value={template.clientId}
          >
            {props.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Default assignee</span>
          <select
            className="input"
            onChange={(event) =>
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                assigneeId: event.target.value,
              }))
            }
            value={template.assigneeId}
          >
            {props.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Frequency</span>
          <select
            className="input"
            onChange={(event) =>
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                frequency: event.target.value as ChecklistFrequency,
              }))
            }
            value={template.frequency}
          >
            {checklistFrequencies.map((option) => (
              <option key={option} value={option}>
                {getChecklistFrequencyLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Next due date</span>
          <input
            className="input"
            onChange={(event) =>
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                nextDueDate: event.target.value,
              }))
            }
            type="date"
            value={template.nextDueDate}
          />
        </label>
        <label className="check-row template-toggle">
          <input
            checked={template.active}
            onChange={(event) =>
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                active: event.target.checked,
              }))
            }
            type="checkbox"
          />
          <span>Active recurring template</span>
        </label>
      </div>
      <StagesAccordion {...props} stages={stages} />
      <button
        className="secondary-action"
        onClick={() => props.onAddStage(template.id)}
        type="button"
      >
        <Plus size={16} />
        Add stage
      </button>
      <SharingControl
        assigneeId={template.assigneeId}
        editorIds={template.editorIds ?? []}
        employees={props.employees}
        onChange={(nextViewerIds, nextEditorIds) =>
          props.onSetViewers(template.id, nextViewerIds, nextEditorIds)
        }
        viewerIds={template.viewerIds ?? []}
      />
    </article>
  )
}

function StagesAccordion(props: TemplateCardProps & { stages: TemplateStage[] }) {
  const { stages, template } = props
  // Stage-level drag-and-drop reorders entire stages by their header.
  const [draggingStageId, setDraggingStageId] = useState<string | null>(null)
  const [dropTargetStageId, setDropTargetStageId] = useState<string | null>(null)
  // Single-stage templates auto-expand for the common case; multi-stage stays
  // collapsed by default.
  const [openStageIds, setOpenStageIds] = useState<Set<string>>(() =>
    stages.length === 1 ? new Set(stages.map((stage) => stage.id)) : new Set(),
  )
  const toggleStageOpen = (stageId: string) => {
    setOpenStageIds((current) => {
      const next = new Set(current)
      if (next.has(stageId)) {
        next.delete(stageId)
      } else {
        next.add(stageId)
      }
      return next
    })
  }

  const handleStageDragStart = (event: DragEvent<HTMLDivElement>, stageId: string) => {
    setDraggingStageId(stageId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', stageId)
  }

  const handleStageDragOver = (event: DragEvent<HTMLDivElement>, stageId: string) => {
    if (!draggingStageId || draggingStageId === stageId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetStageId(stageId)
  }

  const handleStageDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    if (!draggingStageId || draggingStageId === targetId) {
      setDraggingStageId(null)
      setDropTargetStageId(null)
      return
    }
    const order = stages.map((stage) => stage.id)
    const fromIdx = order.indexOf(draggingStageId)
    const toIdx = order.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) {
      setDraggingStageId(null)
      setDropTargetStageId(null)
      return
    }
    order.splice(fromIdx, 1)
    order.splice(toIdx, 0, draggingStageId)
    props.onReorderStages(template.id, order)
    setDraggingStageId(null)
    setDropTargetStageId(null)
  }

  const handleStageDragEnd = () => {
    setDraggingStageId(null)
    setDropTargetStageId(null)
  }

  return (
    <div className="stages-accordion">
      {stages.map((stage, index) => {
        const stageClasses = ['stage-card']
        if (draggingStageId === stage.id) stageClasses.push('dragging')
        if (dropTargetStageId === stage.id) stageClasses.push('drop-target')
        const isOpen = openStageIds.has(stage.id)
        return (
          <div key={stage.id} className={stageClasses.join(' ')}>
            <div
              className="stage-card-header"
              draggable
              onDragStart={(event) => handleStageDragStart(event, stage.id)}
              onDragOver={(event) => handleStageDragOver(event, stage.id)}
              onDragLeave={() => setDropTargetStageId(null)}
              onDrop={(event) => handleStageDrop(event, stage.id)}
              onDragEnd={handleStageDragEnd}
            >
              <span className="drag-handle" aria-hidden="true" title="Drag to reorder">
                <GripVertical size={14} />
              </span>
              <button
                type="button"
                className="stage-toggle-btn"
                aria-expanded={isOpen}
                aria-label={isOpen ? 'Collapse stage' : 'Expand stage'}
                title={isOpen ? 'Collapse stage' : 'Expand stage'}
                onClick={() => toggleStageOpen(stage.id)}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <span className="stage-index-pill">Stage {index + 1}</span>
              <input
                className="input stage-name-input"
                value={stage.name}
                onChange={(event) =>
                  props.onPatchStage(template.id, stage.id, { name: event.target.value })
                }
              />
              <button
                aria-label="Remove stage"
                className="item-delete-btn"
                title="Remove stage"
                type="button"
                onClick={() => {
                  if (
                    stage.items.length > 0 &&
                    !window.confirm('This stage has items. Remove stage anyway?')
                  ) {
                    return
                  }
                  props.onRemoveStage(template.id, stage.id)
                }}
              >
                ×
              </button>
            </div>
            {isOpen ? (
            <div className="stage-card-body">
              <div className="stage-meta-row">
                <label className="field">
                  <span>Stage assignee</span>
                  <select
                    className="input"
                    value={stage.assigneeId}
                    onChange={(event) =>
                      props.onPatchStage(template.id, stage.id, {
                        assigneeId: event.target.value,
                      })
                    }
                  >
                    {props.employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>
                    {index === 0
                      ? 'Days after template due date'
                      : 'Days after previous stage'}
                  </span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={stage.offsetDays}
                    onChange={(event) =>
                      props.onPatchStage(template.id, stage.id, {
                        offsetDays: Number(event.target.value) || 0,
                      })
                    }
                  />
                </label>
              </div>
              <DraggableTemplateItems
                employees={props.employees}
                items={stage.items}
                onDeleteItem={(itemId) => props.onDeleteItem(template.id, stage.id, itemId)}
                onReorderItems={(orderedIds) =>
                  props.onReorderItems(template.id, stage.id, orderedIds)
                }
                onSetItemAssignee={(itemId, assigneeId) =>
                  props.onSetItemAssignee(template.id, stage.id, itemId, assigneeId)
                }
                onSetItemDueDate={(itemId, dueDate) =>
                  props.onSetItemDueDate(template.id, stage.id, itemId, dueDate)
                }
                onUpdateItem={(itemId, label) =>
                  props.onUpdateItem(template.id, stage.id, itemId, label)
                }
              />
              <InlineAddItemRow
                onAdd={(label) =>
                  props.onBulkAddItems(template.id, stage.id, [label])
                }
                placeholder="Add an item..."
              />
              <ChecklistBulkAdd
                label="Paste a list"
                onAdd={(labels) => props.onBulkAddItems(template.id, stage.id, labels)}
              />
              <SharingControl
                assigneeId={stage.assigneeId}
                editorIds={stage.editorIds ?? []}
                employees={props.employees}
                onChange={(nextViewerIds, nextEditorIds) =>
                  props.onPatchStage(template.id, stage.id, {
                    viewerIds: nextViewerIds,
                    editorIds: nextEditorIds,
                  })
                }
                viewerIds={stage.viewerIds ?? []}
              />
            </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function DraggableTemplateItems({
  employees,
  items,
  onDeleteItem,
  onReorderItems,
  onSetItemAssignee,
  onSetItemDueDate,
  onUpdateItem,
}: {
  employees: Employee[]
  items: ChecklistTemplateItem[]
  onDeleteItem: (itemId: string) => void
  onReorderItems: (orderedIds: string[]) => void
  onSetItemAssignee: (itemId: string, assigneeId: string) => void
  onSetItemDueDate: (itemId: string, dueDate: string) => void
  onUpdateItem: (itemId: string, label: string) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const handleDragStart = (event: DragEvent<HTMLDivElement>, itemId: string) => {
    setDraggingId(itemId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', itemId)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>, itemId: string) => {
    if (!draggingId || draggingId === itemId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetId(itemId)
  }

  const handleDragLeave = () => {
    setDropTargetId(null)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null)
      setDropTargetId(null)
      return
    }
    const orderedIds = items.map((item) => item.id)
    const fromIdx = orderedIds.indexOf(draggingId)
    const toIdx = orderedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) {
      setDraggingId(null)
      setDropTargetId(null)
      return
    }
    orderedIds.splice(fromIdx, 1)
    orderedIds.splice(toIdx, 0, draggingId)
    onReorderItems(orderedIds)
    setDraggingId(null)
    setDropTargetId(null)
  }

  const handleDragEnd = () => {
    setDraggingId(null)
    setDropTargetId(null)
  }

  return (
    <div className="template-items">
      {items.map((item) => {
        const classes = ['template-item-row']
        if (draggingId === item.id) classes.push('dragging')
        if (dropTargetId === item.id) classes.push('drop-target')
        return (
          <div
            key={item.id}
            className={classes.join(' ')}
            draggable
            onDragStart={(event) => handleDragStart(event, item.id)}
            onDragOver={(event) => handleDragOver(event, item.id)}
            onDragLeave={handleDragLeave}
            onDrop={(event) => handleDrop(event, item.id)}
            onDragEnd={handleDragEnd}
          >
            <span className="drag-handle" aria-hidden="true">
              <GripVertical size={14} />
            </span>
            <input
              className="input"
              onChange={(event) => onUpdateItem(item.id, event.target.value)}
              value={item.label}
            />
            <input
              aria-label="Item due date"
              className="compact-input"
              onChange={(event) => onSetItemDueDate(item.id, event.target.value)}
              type="date"
              value={item.dueDate ?? ''}
            />
            <select
              aria-label="Item assignee"
              className="compact-input"
              onChange={(event) => onSetItemAssignee(item.id, event.target.value)}
              value={item.assigneeId ?? ''}
            >
              <option value="">Inherits</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
            <button
              className="secondary-action danger"
              onClick={() => onDeleteItem(item.id)}
              type="button"
            >
              Remove
            </button>
          </div>
        )
      })}
    </div>
  )
}
