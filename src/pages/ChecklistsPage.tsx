import { ChevronDown, ChevronRight, Copy, GripVertical, Plus } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react'
import { useSearchParams } from 'react-router-dom'
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
    reorderChecklistItems,
    bulkAddChecklistItems,
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
          onBulkAddItems={bulkAddChecklistTemplateItems}
          onCreate={addChecklistTemplate}
          onDeleteItem={removeChecklistTemplateItem}
          onDeleteTemplate={deleteChecklistTemplate}
          onDuplicate={duplicateChecklistTemplate}
          onReorderItems={reorderChecklistTemplateItems}
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

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">
            {role === 'owner' ? 'Owner checklist view' : 'Assigned checklist'}
          </p>
          <h2>Live checklists</h2>
        </div>
      </div>
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
  const viewerIds = checklist.viewerIds ?? []
  const editorIds = checklist.editorIds ?? []
  const isAssignee = checklist.assigneeId === activeEmployeeId
  const isEditor = editorIds.includes(activeEmployeeId)
  const isViewerOnly =
    role !== 'owner' && !isAssignee && viewerIds.includes(activeEmployeeId) && !isEditor
  // Whether the current viewer can edit checklist structure (reorder, bulk add)
  const canEditStructure = role === 'owner' || isAssignee || isEditor

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
        <ChecklistBulkAdd
          onAdd={(labels) => onBulkAddItems(checklist.id, labels)}
        />
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
              <span className="drag-handle" aria-hidden="true">
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

function ChecklistBulkAdd({ onAdd }: { onAdd: (labels: string[]) => void }) {
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
        Bulk add
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

function ChecklistTemplateManager({
  clients,
  employees,
  onAddItem,
  onBulkAddItems,
  onCreate,
  onDeleteItem,
  onDeleteTemplate,
  onDuplicate,
  onReorderItems,
  onSetItemAssignee,
  onSetItemDueDate,
  onSetViewers,
  onUpdateItem,
  onUpdateTemplate,
  templates,
}: {
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string) => void
  onBulkAddItems: (templateId: string, labels: string[]) => void
  onCreate: (template: Omit<ChecklistTemplate, 'id'>) => void
  onDeleteItem: (templateId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onDuplicate: (templateId: string) => void
  onReorderItems: (templateId: string, orderedIds: string[]) => void
  onSetItemAssignee: (templateId: string, itemId: string, assigneeId: string) => void
  onSetItemDueDate: (templateId: string, itemId: string, dueDate: string) => void
  onSetViewers: (templateId: string, viewerIds: string[], editorIds: string[]) => void
  onUpdateItem: (templateId: string, itemId: string, label: string) => void
  onUpdateTemplate: (
    templateId: string,
    updater: (template: ChecklistTemplate) => ChecklistTemplate,
  ) => void
  templates: ChecklistTemplate[]
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner template controls</p>
          <h2>Recurring checklist templates</h2>
        </div>
      </div>
      <div className="template-manager">
        <QuickTemplateForm clients={clients} employees={employees} onCreate={onCreate} />
        <div className="template-list">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              clients={clients}
              employees={employees}
              onAddItem={onAddItem}
              onBulkAddItems={onBulkAddItems}
              onDeleteItem={onDeleteItem}
              onDeleteTemplate={onDeleteTemplate}
              onDuplicate={onDuplicate}
              onReorderItems={onReorderItems}
              onSetItemAssignee={onSetItemAssignee}
              onSetItemDueDate={onSetItemDueDate}
              onSetViewers={onSetViewers}
              onUpdateItem={onUpdateItem}
              onUpdateTemplate={onUpdateTemplate}
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
    const items = parseBulkLines(itemDraft).map((label) => ({
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

    onCreate({
      title: title.trim(),
      clientId: clientId || clients[0]?.id || '',
      assigneeId: assigneeId || employees[0]?.id || '',
      frequency,
      nextDueDate,
      active: true,
      viewerIds: [],
      editorIds: [],
      items,
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

function TemplateCard({
  template,
  clients,
  employees,
  onAddItem,
  onBulkAddItems,
  onDeleteItem,
  onDeleteTemplate,
  onDuplicate,
  onReorderItems,
  onSetItemAssignee,
  onSetItemDueDate,
  onSetViewers,
  onUpdateItem,
  onUpdateTemplate,
}: {
  template: ChecklistTemplate
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string) => void
  onBulkAddItems: (templateId: string, labels: string[]) => void
  onDeleteItem: (templateId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onDuplicate: (templateId: string) => void
  onReorderItems: (templateId: string, orderedIds: string[]) => void
  onSetItemAssignee: (templateId: string, itemId: string, assigneeId: string) => void
  onSetItemDueDate: (templateId: string, itemId: string, dueDate: string) => void
  onSetViewers: (templateId: string, viewerIds: string[], editorIds: string[]) => void
  onUpdateItem: (templateId: string, itemId: string, label: string) => void
  onUpdateTemplate: (
    templateId: string,
    updater: (template: ChecklistTemplate) => ChecklistTemplate,
  ) => void
}) {
  return (
    <article className="template-card" key={template.id}>
      <div className="template-card-header">
        <div>
          <strong>{template.title}</strong>
          <span>
            {clientName(clients, template.clientId)} ·{' '}
            {employeeName(employees, template.assigneeId)}
          </span>
        </div>
        <div className="template-card-actions">
          <button
            className="secondary-action"
            onClick={() => onDuplicate(template.id)}
            type="button"
            title="Create a new template pre-filled from this one"
          >
            <Copy size={14} />
            Duplicate
          </button>
          <button
            className="secondary-action danger"
            onClick={() => onDeleteTemplate(template.id)}
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
              onUpdateTemplate(template.id, (current) => ({
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
              onUpdateTemplate(template.id, (current) => ({
                ...current,
                clientId: event.target.value,
              }))
            }
            value={template.clientId}
          >
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Employee</span>
          <select
            className="input"
            onChange={(event) =>
              onUpdateTemplate(template.id, (current) => ({
                ...current,
                assigneeId: event.target.value,
              }))
            }
            value={template.assigneeId}
          >
            {employees.map((employee) => (
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
              onUpdateTemplate(template.id, (current) => ({
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
              onUpdateTemplate(template.id, (current) => ({
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
              onUpdateTemplate(template.id, (current) => ({
                ...current,
                active: event.target.checked,
              }))
            }
            type="checkbox"
          />
          <span>Active recurring template</span>
        </label>
      </div>
      <DraggableTemplateItems
        employees={employees}
        items={template.items}
        onDeleteItem={(itemId) => onDeleteItem(template.id, itemId)}
        onReorderItems={(orderedIds) => onReorderItems(template.id, orderedIds)}
        onSetItemAssignee={(itemId, assigneeId) =>
          onSetItemAssignee(template.id, itemId, assigneeId)
        }
        onSetItemDueDate={(itemId, dueDate) =>
          onSetItemDueDate(template.id, itemId, dueDate)
        }
        onUpdateItem={(itemId, label) => onUpdateItem(template.id, itemId, label)}
      />
      <button
        className="secondary-action"
        onClick={() => onAddItem(template.id)}
        type="button"
      >
        <Plus size={16} />
        Add item
      </button>
      <ChecklistBulkAdd onAdd={(labels) => onBulkAddItems(template.id, labels)} />
      <SharingControl
        assigneeId={template.assigneeId}
        editorIds={template.editorIds ?? []}
        employees={employees}
        onChange={(nextViewerIds, nextEditorIds) =>
          onSetViewers(template.id, nextViewerIds, nextEditorIds)
        }
        viewerIds={template.viewerIds ?? []}
      />
    </article>
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
