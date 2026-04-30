import { ChevronDown, ChevronRight, Copy, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { FilterBar } from '../components/FilterBar'
import { useFilters } from '../components/useFilters'
import { SharingControl } from '../components/SharingControl'
import type {
  Checklist,
  ChecklistFrequency,
  ChecklistTemplate,
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
    duplicateChecklistTemplate,
  } = useAppContext()

  return (
    <section className="content-grid two-column" id="checklists">
      <ChecklistPanel
        activeEmployeeId={activeEmployeeId}
        checklists={visibleChecklists}
        clients={data.clients}
        employees={data.employees}
        onSetViewers={setChecklistViewers}
        onToggle={toggleChecklistItem}
        role={role}
      />
      {ownerMode ? (
        <ChecklistTemplateManager
          clients={data.clients}
          employees={data.employees}
          onAddItem={addChecklistTemplateItem}
          onCreate={addChecklistTemplate}
          onDeleteItem={removeChecklistTemplateItem}
          onDeleteTemplate={deleteChecklistTemplate}
          onDuplicate={duplicateChecklistTemplate}
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
  onSetViewers,
  onToggle,
  role,
}: {
  activeEmployeeId: string
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  onSetViewers: (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void> | void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
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
                  onSetViewers={onSetViewers}
                  onToggle={onToggle}
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
  onSetViewers,
  onToggle,
  role,
}: {
  activeEmployeeId: string
  checklist: Checklist
  clients: Client[]
  employees: Employee[]
  focused: boolean
  focusRef: React.MutableRefObject<HTMLElement | null> | null
  onSetViewers: (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void> | void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  role: Role
}) {
  const completed = checklist.items.filter((item) => item.done).length
  const viewerIds = checklist.viewerIds ?? []
  const editorIds = checklist.editorIds ?? []
  const isAssignee = checklist.assigneeId === activeEmployeeId
  const isEditor = editorIds.includes(activeEmployeeId)
  const isViewerOnly =
    role !== 'owner' && !isAssignee && viewerIds.includes(activeEmployeeId) && !isEditor
  const canToggle = role === 'owner' || isAssignee || isEditor

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
      <div className="task-list">
        {checklist.items.map((item) => (
          <label className={item.done ? 'task-row done' : 'task-row'} key={item.id}>
            <input
              checked={item.done}
              disabled={!canToggle}
              onChange={() => void onToggle(checklist.id, item.id)}
              type="checkbox"
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
      {role === 'owner' ? (
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

function ChecklistTemplateManager({
  clients,
  employees,
  onAddItem,
  onCreate,
  onDeleteItem,
  onDeleteTemplate,
  onDuplicate,
  onSetViewers,
  onUpdateItem,
  onUpdateTemplate,
  templates,
}: {
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string) => void
  onCreate: (template: Omit<ChecklistTemplate, 'id'>) => void
  onDeleteItem: (templateId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onDuplicate: (templateId: string) => void
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
              onDeleteItem={onDeleteItem}
              onDeleteTemplate={onDeleteTemplate}
              onDuplicate={onDuplicate}
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
    const items = itemDraft
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((label) => ({ id: makeId('template-item'), label }))

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
  onDeleteItem,
  onDeleteTemplate,
  onDuplicate,
  onSetViewers,
  onUpdateItem,
  onUpdateTemplate,
}: {
  template: ChecklistTemplate
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string) => void
  onDeleteItem: (templateId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onDuplicate: (templateId: string) => void
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
      <div className="template-items">
        {template.items.map((item) => (
          <div className="template-item-row" key={item.id}>
            <input
              className="input"
              onChange={(event) => onUpdateItem(template.id, item.id, event.target.value)}
              value={item.label}
            />
            <button
              className="secondary-action danger"
              onClick={() => onDeleteItem(template.id, item.id)}
              type="button"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="secondary-action"
          onClick={() => onAddItem(template.id)}
          type="button"
        >
          <Plus size={16} />
          Add item
        </button>
      </div>
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
