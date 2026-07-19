import { ChevronDown, ChevronRight, Copy, GripVertical, MoreHorizontal, Plus } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChecklistOutliner } from '../components/ChecklistOutliner'
import { FilterBar } from '../components/FilterBar'
import { ListSearch } from '../components/ListSearch'
import { ReportPeriodControl } from '../components/ReportPeriodControl'
import { isInReportPeriod } from '../lib/reportPeriod'
import { useFilters } from '../components/useFilters'
import { SaveBadge } from '../components/SectionKit'
import { SharingControl } from '../components/SharingControl'
import { useSaveFlash } from '../lib/useSaveFlash'
import type {
  AppData,
  Checklist,
  ChecklistFrequency,
  ChecklistItem,
  ChecklistTemplate,
  ChecklistTemplateItem,
  Client,
  Employee,
  ItemDeletionRequest,
  PendingTaskEdit,
  Role,
  TemplateStage,
  TimeEntry,
  WaitingOn,
} from '../lib/types'
import { pruneEmptyOutlineItems } from '../lib/checklistTree'
import { projectUpcomingChecklists } from '../lib/projectRecurring'
import {
  addDays,
  checklistFrequencies,
  checklistHasPendingDeletionRequest,
  clientName,
  dueDateLabel,
  effectiveChecklistDue,
  employeeName,
  ensureTemplateStages,
  formatHours,
  getChecklistFrequencyLabel,
  groupChecklist,
  itemDeletionKey,
  lastDayOfCurrentMonth,
  localDateOnly,
  makeId,
  monthShortNames,
  shortDate,
  stageNameFor,
  stepIsWaiting,
} from '../lib/utils'

type Group = 'overdue' | 'week' | 'month' | 'later' | 'completed'
type GroupByMode = 'status' | 'client'
type CreateMode = 'one-time' | 'repeating' | null

function parseBulkLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
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

/** "every month", "every week" etc. — used in plain-language template copy. */
function frequencyCadence(frequency: ChecklistFrequency): string {
  switch (frequency) {
    case 'daily':
      return 'every day'
    case 'weekly':
      return 'every week'
    case 'biweekly':
      return 'every 2 weeks'
    case 'quarterly':
      return 'every quarter'
    case 'annually':
      return 'every year'
    case 'specific-months':
      return 'in specific months'
    default:
      return 'every month'
  }
}

/** Ordinal suffix for a day number — 1st, 2nd, 3rd, 21st… */
function ordinalDay(day: number): string {
  const mod100 = day % 100
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`
  switch (day % 10) {
    case 1:
      return `${day}st`
    case 2:
      return `${day}nd`
    case 3:
      return `${day}rd`
    default:
      return `${day}th`
  }
}

/**
 * Plain-language schedule line for a specific-months template, e.g.
 * "Runs in Jan, Apr, Jul, Oct — due on the 15th." Falls back gracefully when
 * no months are selected yet.
 */
function specificMonthsSummary(template: ChecklistTemplate): string {
  const months = (template.scheduledMonths ?? [])
    .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
    .sort((a, b) => a - b)
  if (months.length === 0) {
    return 'Runs in specific months — pick at least one month below.'
  }
  const monthList = months.map((m) => monthShortNames[m]).join(', ')
  const dueClause =
    typeof template.dueDayOfMonth === 'number'
      ? ` — due on the ${ordinalDay(template.dueDayOfMonth)}.`
      : ' — due on the last day of the month.'
  return `Runs in ${monthList}${dueClause}`
}

export function ChecklistsPage() {
  const {
    activeEmployeeId,
    visibleChecklists,
    data,
    role,
    ownerMode,
    toggleChecklistItem,
    toggleSubItem,
    addSubItem,
    removeSubItem,
    toggleSubSubItem,
    addSubSubItem,
    removeSubSubItem,
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
    addChecklistTemplateSubItem,
    updateChecklistTemplateSubItem,
    removeChecklistTemplateSubItem,
    addChecklistTemplateSubSubItem,
    updateChecklistTemplateSubSubItem,
    removeChecklistTemplateSubSubItem,
    duplicateChecklistTemplate,
    createStandardTemplate,
    applyTemplateToClient,
    generateChecklistFromTemplate,
    addTemplateStage,
    removeTemplateStage,
    patchTemplateStage,
    reorderTemplateStages,
    reorderChecklistItems,
    bulkAddChecklistItems,
    createChecklist,
    updateChecklistItem,
    updateSubItemWaiting,
    deleteChecklistItem,
    deleteChecklist,
    approveChecklistDeletion,
    rejectChecklistDeletion,
    itemDeletionRequests,
    approveItemDeletion,
    rejectItemDeletion,
    pendingTaskEdits,
    approvePendingTaskEdit,
    rejectPendingTaskEdit,
    restoreChecklist,
    emptyChecklistRecycleBin,
  } = useAppContext()

  const [searchParams, setSearchParams] = useSearchParams()

  // Point the in-progress list at a freshly-created/generated checklist. Setting
  // `?focus=<id>` both scrolls to the card and auto-expands its (possibly
  // collapsed) group, so the user always sees the new checkable task.
  const focusChecklist = (checklistId: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('focus', checklistId)
    setSearchParams(next, { replace: true })
  }

  // The unified "+ New" dropdown. Mode controls whether the create form is in
  // one-time or repeating shape; both paths render the SAME NewTaskForm.
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (event: MouseEvent) => {
      if (!menuRef.current) return
      if (menuRef.current.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  const handleCreateOneTime = async (payload: {
    title: string
    clientId: string
    assigneeId: string
    dueDate: string
    categoryId?: string | null
    items: Array<Pick<ChecklistTemplateItem, 'label' | 'subItems'>>
  }) => {
    const created = await createChecklist(payload)
    if (created) focusChecklist(created.id)
    setCreateMode(null)
  }

  // "Generate a task now" on a template row — materializes a Stage-1 instance
  // and focuses it so its group auto-expands.
  const handleGenerateNow = async (templateId: string, opts?: { dueDate?: string }) => {
    const created = await generateChecklistFromTemplate(templateId, opts)
    if (created) focusChecklist(created.id)
  }

  const handleCreateRepeating = async (
    template: Omit<ChecklistTemplate, 'id'>,
    startFirstNow: boolean,
  ) => {
    addChecklistTemplate(template)
    // "Start the first one now": independently of the future recurrence
    // schedule, immediately create a checkable Stage-1 instance dated today or
    // the template's first due date (whichever is sooner) so the user has
    // something to check off right away. This goes through the dedicated
    // /api/checklists endpoint, so it doesn't depend on the template having
    // been persisted server-side yet.
    if (startFirstNow) {
      const stageOne = template.stages[0]
      if (stageOne && stageOne.items.length > 0) {
        const today = localDateOnly()
        const firstDue = template.nextDueDate < today ? template.nextDueDate : today
        try {
          const created = await createChecklist({
            title: template.title,
            clientId: template.clientId,
            assigneeId: stageOne.assigneeId || template.assigneeId,
            dueDate: firstDue,
            items: stageOne.items.map((item) => ({ label: item.label })),
          })
          if (created) focusChecklist(created.id)
        } catch {
          // Template still created; the instance can be generated later via
          // "Generate a task now".
        }
      }
    }
    setCreateMode(null)
  }

  return (
    <section className="content-grid one-column" id="checklists">
      {/* The approver queue is shown to ANY user who is the approver of ≥1
          pending edit (the server already scopes the list: owner sees all,
          staff see only edits routed to them). */}
      <PendingTaskEditsSection
        edits={pendingTaskEdits}
        checklists={visibleChecklists}
        clients={data.clients}
        employees={data.employees}
        onApprove={approvePendingTaskEdit}
        onReject={rejectPendingTaskEdit}
      />
      {ownerMode ? (
        <PendingDeletionsSection
          checklists={visibleChecklists}
          clients={data.clients}
          employees={data.employees}
          onApprove={approveChecklistDeletion}
          onReject={rejectChecklistDeletion}
          itemRequests={itemDeletionRequests}
          onApproveItem={approveItemDeletion}
          onRejectItem={rejectItemDeletion}
        />
      ) : null}
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Tasks</h2>
          </div>
          {ownerMode ? (
            <div className="new-task-menu" ref={menuRef}>
              <button
                type="button"
                className="primary-action"
                onClick={() => setMenuOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Plus size={14} />
                New
                <ChevronDown size={14} />
              </button>
              {menuOpen ? (
                <div className="new-task-menu-popover" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="new-task-menu-item"
                    onClick={() => {
                      setCreateMode('one-time')
                      setMenuOpen(false)
                    }}
                  >
                    <strong>One-time task</strong>
                    <span>For a single thing that needs to get done once.</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="new-task-menu-item"
                    onClick={() => {
                      setCreateMode('repeating')
                      setMenuOpen(false)
                    }}
                  >
                    <strong>Repeating task</strong>
                    <span>For something that comes back on a schedule.</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            // Staff can create ONE-TIME tasks for their assigned clients.
            // Repeating templates stay owner-only (firm-standard recurring work).
            <button
              type="button"
              className="primary-action"
              onClick={() => setCreateMode('one-time')}
            >
              <Plus size={14} />
              New task
            </button>
          )}
        </div>

        {createMode && (ownerMode || createMode === 'one-time') ? (
          <NewTaskForm
            mode={createMode}
            activeEmployeeId={activeEmployeeId}
            clients={data.clients}
            employees={data.employees}
            role={role}
            onCancel={() => setCreateMode(null)}
            onCreateOneTime={handleCreateOneTime}
            onCreateRepeating={handleCreateRepeating}
          />
        ) : null}

        <ChecklistInProgressSection
          activeEmployeeId={activeEmployeeId}
          checklists={visibleChecklists}
          checklistTemplates={data.checklistTemplates}
          clients={data.clients}
          employees={data.employees}
          onAddSubItem={addSubItem}
          onAddSubSubItem={addSubSubItem}
          onBulkAddItems={bulkAddChecklistItems}
          onDeleteChecklist={deleteChecklist}
          onDeleteItem={deleteChecklistItem}
          onRemoveSubItem={removeSubItem}
          onRemoveSubSubItem={removeSubSubItem}
          onReorderItems={reorderChecklistItems}
          onSetViewers={setChecklistViewers}
          onToggle={toggleChecklistItem}
          onToggleSubItem={toggleSubItem}
          onUpdateSubItemWaiting={updateSubItemWaiting}
          onToggleSubSubItem={toggleSubSubItem}
          onUpdateItem={updateChecklistItem}
          ownerMode={ownerMode}
          role={role}
          timeEntries={data.timeEntries}
        />
      </section>

      {ownerMode ? (
        <RepeatingTasksManager
          clients={data.clients}
          employees={data.employees}
          onAddItem={addChecklistTemplateItem}
          onAddStage={addTemplateStage}
          onAddSubItem={addChecklistTemplateSubItem}
          onAddSubSubItem={addChecklistTemplateSubSubItem}
          onApplyToClient={applyTemplateToClient}
          onBulkAddItems={bulkAddChecklistTemplateItems}
          onDeleteItem={removeChecklistTemplateItem}
          onDeleteTemplate={deleteChecklistTemplate}
          onDuplicate={duplicateChecklistTemplate}
          onGenerateNow={handleGenerateNow}
          onPatchStage={patchTemplateStage}
          onRemoveSubItem={removeChecklistTemplateSubItem}
          onRemoveSubSubItem={removeChecklistTemplateSubSubItem}
          onRemoveStage={removeTemplateStage}
          onReorderItems={reorderChecklistTemplateItems}
          onReorderStages={reorderTemplateStages}
          onSetItemAssignee={setChecklistTemplateItemAssignee}
          onSetItemDueDate={setChecklistTemplateItemDueDate}
          onSetViewers={setTemplateViewers}
          onUpdateItem={updateChecklistTemplateItem}
          onUpdateSubItem={updateChecklistTemplateSubItem}
          onUpdateSubSubItem={updateChecklistTemplateSubSubItem}
          onUpdateTemplate={updateChecklistTemplate}
          templates={data.checklistTemplates}
        />
      ) : null}

      {ownerMode ? (
        <StandardTemplatesManager
          clients={data.clients}
          employees={data.employees}
          onAddItem={addChecklistTemplateItem}
          onAddStage={addTemplateStage}
          onAddSubItem={addChecklistTemplateSubItem}
          onAddSubSubItem={addChecklistTemplateSubSubItem}
          onApplyToClient={applyTemplateToClient}
          onBulkAddItems={bulkAddChecklistTemplateItems}
          onCreateStandard={createStandardTemplate}
          onDeleteItem={removeChecklistTemplateItem}
          onDeleteTemplate={deleteChecklistTemplate}
          onPatchStage={patchTemplateStage}
          onRemoveStage={removeTemplateStage}
          onRemoveSubItem={removeChecklistTemplateSubItem}
          onRemoveSubSubItem={removeChecklistTemplateSubSubItem}
          onReorderItems={reorderChecklistTemplateItems}
          onReorderStages={reorderTemplateStages}
          onSetItemAssignee={setChecklistTemplateItemAssignee}
          onSetItemDueDate={setChecklistTemplateItemDueDate}
          onSetViewers={setTemplateViewers}
          onUpdateItem={updateChecklistTemplateItem}
          onUpdateSubItem={updateChecklistTemplateSubItem}
          onUpdateSubSubItem={updateChecklistTemplateSubSubItem}
          onUpdateTemplate={updateChecklistTemplate}
          templates={data.checklistTemplates}
        />
      ) : null}

      {ownerMode ? (
        <RecycleBinSection
          clients={data.clients}
          employees={data.employees}
          onEmptyBin={emptyChecklistRecycleBin}
          onRestore={restoreChecklist}
          recycledChecklists={data.recycledChecklists ?? []}
        />
      ) : null}

      {/* Team members see the firm's standard blueprints read-only (the owner
          keeps the full editor above). Lets them know what standard work exists
          so they don't re-create it; an owner applies one to a client. */}
      {!ownerMode ? (
        <>
          <StaffRecurringTemplatesView data={data} />
          <StaffStandardTemplatesView
            templates={data.checklistTemplates}
            employees={data.employees}
          />
        </>
      ) : null}
    </section>
  )
}

/**
 * Read-only view of the RECURRING checklists the owner set up for the clients
 * this team member is assigned to (the server already scopes `checklistTemplates`
 * to those clients). Grouped by client, collapsible, searchable, each template
 * showing its cadence + next due date and its steps — so staff can see what's
 * coming up on their clients and don't re-create a recurring checklist that
 * already exists. Writes stay with the owner; adding items happens on the live
 * (generated) checklist instance. Renders nothing when there are none.
 */
function StaffRecurringTemplatesView({ data }: { data: AppData }) {
  const { clients, employees, checklistTemplates } = data
  const [query, setQuery] = useState('')
  const [openClients, setOpenClients] = useState<Set<string>>(new Set())

  // Soonest upcoming occurrence per template, so each row can show "next: <date>".
  const nextDueByTemplate = useMemo(() => {
    const today = localDateOnly()
    const ghosts = projectUpcomingChecklists(data, {
      fromDateOnly: today,
      horizonEndDateOnly: addDays(today, 120),
    })
    const map = new Map<string, string>()
    for (const ghost of ghosts) {
      if (!ghost.templateId) continue
      const current = map.get(ghost.templateId)
      if (!current || ghost.dueDate < current) map.set(ghost.templateId, ghost.dueDate)
    }
    return map
  }, [data])

  const groups = useMemo(() => {
    const byClient = new Map<
      string,
      { clientId: string; clientName: string; templates: ChecklistTemplate[] }
    >()
    for (const template of checklistTemplates) {
      if (template.isStandard) continue
      const group = byClient.get(template.clientId) ?? {
        clientId: template.clientId,
        clientName: clientName(clients, template.clientId),
        templates: [],
      }
      group.templates.push(template)
      byClient.set(template.clientId, group)
    }
    const list = [...byClient.values()]
    list.forEach((group) => group.templates.sort((a, b) => a.title.localeCompare(b.title)))
    return list.sort((a, b) => a.clientName.localeCompare(b.clientName))
  }, [checklistTemplates, clients])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return groups
    return groups
      .map((group) => {
        if (group.clientName.toLowerCase().includes(q)) return group
        return {
          ...group,
          templates: group.templates.filter((template) =>
            template.title.toLowerCase().includes(q),
          ),
        }
      })
      .filter((group) => group.templates.length > 0)
  }, [groups, q])

  if (groups.length === 0) return null
  const totalTemplates = groups.reduce((sum, group) => sum + group.templates.length, 0)
  const searching = q.length > 0

  const toggleClient = (clientId: string) =>
    setOpenClients((prev) => {
      const next = new Set(prev)
      if (next.has(clientId)) next.delete(clientId)
      else next.add(clientId)
      return next
    })

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Your clients</p>
          <h2>Recurring checklists</h2>
          <p className="section-subtitle">
            The repeating checklists set up for your clients, grouped by client and shown
            read-only. Check here before starting one so you don&apos;t duplicate it — add your
            work on the active checklist once it&apos;s generated.
          </p>
        </div>
      </div>
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder={`Search ${totalTemplates} recurring checklist${totalTemplates === 1 ? '' : 's'} or client…`}
      />
      {filtered.length === 0 ? (
        <p className="muted-text">No recurring checklists match &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <div className="staff-recurring-groups">
          {filtered.map((group) => {
            const open = searching || openClients.has(group.clientId)
            return (
              <div className="staff-recurring-client" key={group.clientId}>
                <button
                  type="button"
                  className="setup-cat-header"
                  aria-expanded={open}
                  onClick={() => toggleClient(group.clientId)}
                >
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className="section-kicker">{group.clientName}</span>
                  <span className="setup-cat-count">
                    {group.templates.length} recurring
                  </span>
                </button>
                {open ? (
                  <ul className="staff-template-list">
                    {group.templates.map((template) => {
                      const nextDue = nextDueByTemplate.get(template.id)
                      return (
                        <StaffStandardTemplateRow
                          key={template.id}
                          template={template}
                          employees={employees}
                          extraMeta={
                            <>
                              {template.frequency
                                ? getChecklistFrequencyLabel(template.frequency)
                                : 'recurring'}
                              {nextDue
                                ? ` · next ${shortDate.format(new Date(`${nextDue}T12:00:00`))}`
                                : ''}
                            </>
                          }
                        />
                      )
                    })}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/**
 * Read-only view of the firm's STANDARD (client-agnostic) checklist blueprints,
 * shown to team members. They can browse the standard steps but cannot edit,
 * apply, or delete — that stays with the owner. Renders nothing when there are
 * no standard templates.
 */
function StaffStandardTemplatesView({
  templates,
  employees,
}: {
  templates: ChecklistTemplate[]
  employees: Employee[]
}) {
  const standards = useMemo(
    () =>
      templates
        .filter((template) => template.isStandard)
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title)),
    [templates],
  )
  if (standards.length === 0) return null
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Blueprints</p>
          <h2>Standard templates</h2>
          <p className="section-subtitle">
            Your firm&apos;s reusable checklist blueprints, shown read-only. Ask an owner to
            apply one to a client to put it to work.
          </p>
        </div>
      </div>
      <ul className="staff-template-list">
        {standards.map((template) => (
          <StaffStandardTemplateRow
            key={template.id}
            template={template}
            employees={employees}
          />
        ))}
      </ul>
    </section>
  )
}

/** One collapsible, read-only template row (title → its steps). `extraMeta`
 *  appends context (e.g. a recurring template's cadence + next due date). */
function StaffStandardTemplateRow({
  template,
  employees,
  extraMeta,
}: {
  template: ChecklistTemplate
  employees: Employee[]
  extraMeta?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const stages = ensureTemplateStages(template).stages
  const totalSteps = stages.reduce((sum, stage) => sum + stage.items.length, 0)
  const multiStage = stages.length > 1
  return (
    <li className="staff-template-row">
      <button
        type="button"
        className="staff-template-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>{template.title}</strong>
        <span className="staff-template-meta">
          {totalSteps} step{totalSteps === 1 ? '' : 's'}
          {multiStage ? ` · ${stages.length} hand-off steps` : ''}
          {extraMeta ? <> · {extraMeta}</> : null}
        </span>
      </button>
      {open ? (
        <div className="staff-template-body">
          {totalSteps === 0 ? (
            <p className="muted-text">No steps defined yet.</p>
          ) : (
            stages.map((stage) => (
              <div key={stage.id} className="staff-template-stage">
                {multiStage ? (
                  <p className="staff-template-stage-name">
                    {stage.name}
                    {stage.assigneeId ? ` · ${employeeName(employees, stage.assigneeId)}` : ''}
                  </p>
                ) : null}
                <ul className="staff-template-steps">
                  {stage.items.map((item) => (
                    <li key={item.id}>
                      {item.label}
                      {item.subItems && item.subItems.length > 0 ? (
                        <ul className="staff-template-substeps">
                          {item.subItems.map((sub) => (
                            <li key={sub.id}>{sub.title}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      ) : null}
    </li>
  )
}

/**
 * Owner-only recycle bin. Lists every soft-deleted checklist with a Restore
 * action, plus a single "Empty bin" button that permanently purges them all.
 * Collapsed by default so the bottom of the Checklists page stays clean; the
 * pill in the header counts what's inside so an owner sees at a glance
 * whether there's anything to clean up.
 */
/**
 * Owner-only queue of checklists a staff member has asked to delete. Sits at
 * the top of the Checklists page; each row offers Approve (soft-delete to bin)
 * or Reject (clear the request). Hidden entirely when there are none pending.
 */
function PendingDeletionsSection({
  checklists,
  clients,
  employees,
  onApprove,
  onReject,
  itemRequests,
  onApproveItem,
  onRejectItem,
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  onApprove: (checklistId: string) => Promise<void>
  onReject: (checklistId: string) => Promise<void>
  itemRequests: ItemDeletionRequest[]
  onApproveItem: (requestId: string) => Promise<void>
  onRejectItem: (requestId: string) => Promise<void>
}) {
  const pending = checklists
    .filter(checklistHasPendingDeletionRequest)
    .sort((a, b) =>
      (b.deletionRequestedAt ?? '').localeCompare(a.deletionRequestedAt ?? ''),
    )
  const pendingItems = [...itemRequests].sort((a, b) =>
    String(b.requestedAt ?? '').localeCompare(String(a.requestedAt ?? '')),
  )
  const total = pending.length + pendingItems.length
  if (total === 0) return null

  const checklistTitleFor = (checklistId: string) =>
    checklists.find((c) => c.id === checklistId)?.title ?? 'a task'

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Deletion requests</h2>
          <p className="section-subtitle">
            A bookkeeper asked to delete these. Approve a whole task to move it to the recycle bin,
            or approve a single item to remove just that item. Reject to keep things as they are.
          </p>
        </div>
        <span className="status-pill">{total}</span>
      </div>
      {pending.length > 0 ? (
        <ul
          className="pending-deletions-list"
          style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}
        >
          {pending.map((checklist) => (
            <li
              key={checklist.id}
              className="pending-deletion-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 0',
                borderTop: '1px solid var(--border-subtle, #eee)',
              }}
            >
              <div>
                <strong>{checklist.title}</strong>
                <div className="checklist-meta-line">
                  {clientName(clients, checklist.clientId)} ·{' '}
                  Requested by{' '}
                  {checklist.deletionRequestedBy
                    ? employeeName(employees, checklist.deletionRequestedBy)
                    : 'a team member'}{' '}
                  ·{' '}
                  {checklist.deletionRequestedAt
                    ? shortDate.format(new Date(checklist.deletionRequestedAt))
                    : 'recently'}
                </div>
              </div>
              <div style={{ display: 'inline-flex', gap: 8 }}>
                <button
                  type="button"
                  className="secondary-action danger"
                  onClick={() => void onApprove(checklist.id)}
                  title="Approve — move this task to the recycle bin"
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => void onReject(checklist.id)}
                  title="Reject — keep this task active"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {pendingItems.length > 0 ? (
        <>
          <p className="section-subtitle" style={{ marginTop: pending.length > 0 ? 16 : 0 }}>
            Item deletions
          </p>
          <ul
            className="pending-deletions-list"
            style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}
          >
            {pendingItems.map((req) => (
              <li
                key={req.id}
                className="pending-deletion-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 0',
                  borderTop: '1px solid var(--border-subtle, #eee)',
                }}
              >
                <div>
                  <strong>{req.label || '(item)'}</strong>
                  <div className="checklist-meta-line">
                    {clientName(clients, req.clientId)} · in &ldquo;{checklistTitleFor(req.checklistId)}
                    &rdquo; · Requested by{' '}
                    {req.requestedByName ||
                      (req.requestedBy ? employeeName(employees, req.requestedBy) : 'a team member')}{' '}
                    ·{' '}
                    {req.requestedAt ? shortDate.format(new Date(req.requestedAt)) : 'recently'}
                  </div>
                </div>
                <div style={{ display: 'inline-flex', gap: 8 }}>
                  <button
                    type="button"
                    className="secondary-action danger"
                    onClick={() => void onApproveItem(req.id)}
                    title="Approve — remove this item"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => void onRejectItem(req.id)}
                    title="Reject — keep this item"
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

/**
 * Queue of task edits routed to the current user for approval (a non-creator
 * edited someone else's task). Shown to any user who is the approver of ≥1
 * pending edit (the server scopes the list: owner sees all, staff see only
 * edits routed to them). Each row: task title + client, requester, the readable
 * summary, and Approve / Reject. Hidden entirely when there's nothing pending.
 */
function PendingTaskEditsSection({
  edits,
  checklists,
  clients,
  employees,
  onApprove,
  onReject,
}: {
  edits: PendingTaskEdit[]
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  onApprove: (editId: string) => Promise<void>
  onReject: (editId: string) => Promise<void>
}) {
  const pending = [...edits].sort((a, b) =>
    String(b.requestedAt ?? '').localeCompare(String(a.requestedAt ?? '')),
  )
  if (pending.length === 0) return null

  const checklistFor = (checklistId: string) => checklists.find((c) => c.id === checklistId)

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Edits awaiting your approval</h2>
          <p className="section-subtitle">
            A team member proposed changes to a task you created. Approve to apply the change, or
            reject to discard it — the task stays as-is until you decide.
          </p>
        </div>
        <span className="status-pill">{pending.length}</span>
      </div>
      <ul
        className="pending-deletions-list"
        style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}
      >
        {pending.map((edit) => {
          const target = checklistFor(edit.checklistId)
          const title = target?.title ?? 'a task'
          const clientLabel = target ? clientName(clients, target.clientId) : ''
          return (
            <li
              key={edit.id}
              className="pending-deletion-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 0',
                borderTop: '1px solid var(--border-subtle, #eee)',
              }}
            >
              <div>
                <strong>{title}</strong>
                <div className="checklist-meta-line">
                  {clientLabel ? `${clientLabel} · ` : ''}
                  Requested by{' '}
                  {edit.requestedByName ||
                    (edit.requestedBy ? employeeName(employees, edit.requestedBy) : 'a team member')}
                </div>
                <div className="checklist-meta-line pending-edit-summary">{edit.summary}</div>
              </div>
              <div style={{ display: 'inline-flex', gap: 8 }}>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => void onApprove(edit.id)}
                  title="Approve — apply this change"
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => void onReject(edit.id)}
                  title="Reject — discard this change"
                >
                  Reject
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function RecycleBinSection({
  clients,
  employees,
  onEmptyBin,
  onRestore,
  recycledChecklists,
}: {
  clients: Client[]
  employees: Employee[]
  onEmptyBin: () => Promise<void>
  onRestore: (checklistId: string) => Promise<void>
  recycledChecklists: Checklist[]
}) {
  const [open, setOpen] = useState(false)
  const count = recycledChecklists.length

  const handleEmpty = () => {
    if (count === 0) return
    const confirmed = window.confirm(
      `Empty the recycle bin?\n\n${count} task${count === 1 ? '' : 's'} will be permanently deleted. This cannot be undone. Time entries logged against them are kept either way.`,
    )
    if (confirmed) {
      void onEmptyBin()
    }
  }

  // Newest deletions first so the most recent cleanup is what the owner sees.
  const sorted = [...recycledChecklists].sort((a, b) => {
    const aTime = a.deletedAt ?? ''
    const bTime = b.deletedAt ?? ''
    return bTime.localeCompare(aTime)
  })

  return (
    <section className="panel">
      <div className="section-heading">
        <button
          type="button"
          className="recycle-bin-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          style={{
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <h2 style={{ margin: 0 }}>Recycle bin</h2>
          <span className="status-pill">{count}</span>
        </button>
        {open && count > 0 ? (
          <button
            type="button"
            className="secondary-action danger"
            onClick={handleEmpty}
            title="Permanently delete every task in the bin"
          >
            Empty bin ({count})
          </button>
        ) : null}
      </div>

      {open ? (
        count === 0 ? (
          <p className="checklist-empty-hint">The recycle bin is empty.</p>
        ) : (
          <ul
            className="recycle-bin-list"
            style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}
          >
            {sorted.map((checklist) => (
              <li
                key={checklist.id}
                className="recycle-bin-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 0',
                  borderTop: '1px solid var(--border-subtle, #eee)',
                }}
              >
                <div>
                  <strong>{checklist.title}</strong>
                  <div className="checklist-meta-line">
                    {clientName(clients, checklist.clientId)} ·{' '}
                    {employeeName(employees, checklist.assigneeId)} ·{' '}
                    Deleted{' '}
                    {checklist.deletedAt
                      ? shortDate.format(new Date(checklist.deletedAt))
                      : 'recently'}
                  </div>
                </div>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => void onRestore(checklist.id)}
                  title="Restore this task to the in-progress list"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}

function ChecklistInProgressSection({
  activeEmployeeId,
  checklists,
  checklistTemplates,
  clients,
  employees,
  onAddSubItem,
  onAddSubSubItem,
  onBulkAddItems,
  onDeleteChecklist,
  onDeleteItem,
  onRemoveSubItem,
  onRemoveSubSubItem,
  onReorderItems,
  onSetViewers,
  onToggle,
  onToggleSubItem,
  onUpdateSubItemWaiting,
  onToggleSubSubItem,
  onUpdateItem,
  ownerMode,
  role,
  timeEntries,
}: {
  activeEmployeeId: string
  checklists: Checklist[]
  checklistTemplates: ChecklistTemplate[]
  clients: Client[]
  employees: Employee[]
  onAddSubItem: (checklistId: string, itemId: string, title: string) => void
  onAddSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => void
  onBulkAddItems: (checklistId: string, labels: string[]) => void
  onDeleteChecklist: (checklistId: string) => Promise<void>
  onDeleteItem: (checklistId: string, itemId: string) => Promise<void>
  onRemoveSubItem: (checklistId: string, itemId: string, subItemId: string) => void
  onRemoveSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => void
  onReorderItems: (checklistId: string, orderedIds: string[]) => void
  onSetViewers: (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void> | void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  onToggleSubItem: (checklistId: string, itemId: string, subItemId: string) => void
  onUpdateSubItemWaiting: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    patch: { waiting?: boolean; waitingOn?: string | null; waitingForChecklistId?: string | null },
  ) => void
  onToggleSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => void
  onUpdateItem: (
    checklistId: string,
    itemId: string,
    patch: {
      title?: string
      dueDate?: string | null
      assigneeId?: string | null
      waitingOn?: string | null
      waiting?: boolean
      waitingForChecklistId?: string | null
    },
  ) => Promise<void>
  ownerMode: boolean
  role: Role
  timeEntries: TimeEntry[]
}) {
  const todayDateOnly = localDateOnly()
  const { reportPeriod, setReportPeriod } = useAppContext()
  const { assignee, client, status } = useFilters()
  const [query, setQuery] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const focusId = searchParams.get('focus')
  const focusRef = useRef<HTMLElement | null>(null)

  // Group-by choice is persisted in a URL search param (?group=client), the
  // same pattern FilterBar uses with useSearchParams.
  const groupBy: GroupByMode = searchParams.get('group') === 'client' ? 'client' : 'status'
  const setGroupBy = (next: GroupByMode) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'client') {
      params.set('group', 'client')
    } else {
      params.delete('group')
    }
    setSearchParams(params, { replace: true })
  }

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
    const q = query.trim().toLowerCase()
    return checklists.filter((checklist) => {
      if (!isInReportPeriod(effectiveChecklistDue(checklist), reportPeriod)) return false
      if (assignee && checklist.assigneeId !== assignee) return false
      if (client && checklist.clientId !== client) return false
      if (status && status !== 'all') {
        if (statusForChecklist(checklist, todayDateOnly) !== status) return false
      }
      if (q) {
        const nameMatch = clientName(clients, checklist.clientId).toLowerCase().includes(q)
        const titleMatch = checklist.title.toLowerCase().includes(q)
        if (!nameMatch && !titleMatch) return false
      }
      return true
    })
  }, [checklists, assignee, client, status, todayDateOnly, query, clients, reportPeriod])

  // Status grouping (current behavior, unchanged).
  const groupedByStatus: Record<Group, Checklist[]> = {
    overdue: [],
    week: [],
    month: [],
    later: [],
    completed: [],
  }
  for (const checklist of filtered) {
    groupedByStatus[groupChecklist(checklist, todayDateOnly)].push(checklist)
  }
  // Within each bucket, soonest-due first (by effective due — same basis as
  // the bucketing — so the most urgent task is at the top).
  for (const key of Object.keys(groupedByStatus) as Group[]) {
    groupedByStatus[key].sort((a, b) =>
      effectiveChecklistDue(a).localeCompare(effectiveChecklistDue(b)),
    )
  }

  const groupConfig: Array<{ key: Group; label: string; defaultOpen: boolean }> = [
    { key: 'overdue', label: 'Overdue', defaultOpen: true },
    { key: 'week', label: 'Due this week', defaultOpen: true },
    { key: 'month', label: 'Due this month', defaultOpen: true },
    { key: 'later', label: 'Later', defaultOpen: false },
    { key: 'completed', label: 'Completed', defaultOpen: false },
  ]

  // Client grouping: each client is a collapsible section, sorted alphabetically;
  // checklists within a client sorted by due date.
  const clientGroups = useMemo(() => {
    const byClient = new Map<string, Checklist[]>()
    for (const checklist of filtered) {
      const list = byClient.get(checklist.clientId) ?? []
      list.push(checklist)
      byClient.set(checklist.clientId, list)
    }
    return [...byClient.entries()]
      .map(([clientId, list]) => ({
        clientId,
        label: clientName(clients, clientId),
        checklists: [...list].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [filtered, clients])

  const renderCard = (checklist: Checklist) => (
    <ChecklistCard
      key={checklist.id}
      activeEmployeeId={activeEmployeeId}
      checklist={checklist}
      stageName={stageNameFor(checklistTemplates, checklist)}
      clients={clients}
      employees={employees}
      focused={checklist.id === focusId}
      focusRef={checklist.id === focusId ? focusRef : null}
      onAddSubItem={onAddSubItem}
      onAddSubSubItem={onAddSubSubItem}
      onBulkAddItems={onBulkAddItems}
      onDeleteChecklist={onDeleteChecklist}
      onDeleteItem={onDeleteItem}
      onRemoveSubItem={onRemoveSubItem}
      onRemoveSubSubItem={onRemoveSubSubItem}
      onReorderItems={onReorderItems}
      onSetViewers={onSetViewers}
      onToggle={onToggle}
      onToggleSubItem={onToggleSubItem}
      onUpdateSubItemWaiting={onUpdateSubItemWaiting}
      onToggleSubSubItem={onToggleSubSubItem}
      onUpdateItem={onUpdateItem}
      ownerMode={ownerMode}
      role={role}
      timeEntries={timeEntries}
    />
  )

  return (
    <div className="checklist-in-progress">
      <div className="subsection-heading">
        <h3>In progress</h3>
        <div className="group-by-toggle" role="group" aria-label="Group by">
          <span className="group-by-label">Group by:</span>
          <button
            type="button"
            className={groupBy === 'status' ? 'group-by-btn active' : 'group-by-btn'}
            aria-pressed={groupBy === 'status'}
            onClick={() => setGroupBy('status')}
          >
            Due date
          </button>
          <button
            type="button"
            className={groupBy === 'client' ? 'group-by-btn active' : 'group-by-btn'}
            aria-pressed={groupBy === 'client'}
            onClick={() => setGroupBy('client')}
          >
            Client
          </button>
        </div>
      </div>
      <div className="filter-row">
        <FilterBar employees={employees} clients={clients} />
        <ReportPeriodControl value={reportPeriod} onChange={setReportPeriod} />
        <ListSearch
          value={query}
          onChange={setQuery}
          placeholder="Search checklists…"
          resultCount={filtered.length}
          total={checklists.length}
        />
      </div>
      <div className="checklist-stack">
        {checklists.length === 0 ? (
          <p className="empty-state">No tasks in progress. Hit + New to add one.</p>
        ) : filtered.length === 0 && query.trim() ? (
          <p className="empty-state">No tasks match "{query.trim()}".</p>
        ) : filtered.length === 0 ? (
          <p className="empty-state">No tasks match your filters.</p>
        ) : null}
        {groupBy === 'status'
          ? groupConfig.map((group) =>
              groupedByStatus[group.key].length === 0 ? null : (
                <ChecklistGroup
                  key={group.key}
                  defaultOpen={group.defaultOpen}
                  label={group.label}
                  count={groupedByStatus[group.key].length}
                  focusInside={
                    Boolean(focusId) &&
                    groupedByStatus[group.key].some((c) => c.id === focusId)
                  }
                >
                  {groupedByStatus[group.key].map(renderCard)}
                </ChecklistGroup>
              ),
            )
          : clientGroups.map((group) => (
              <ChecklistGroup
                key={group.clientId}
                defaultOpen
                label={group.label}
                count={group.checklists.length}
                focusInside={
                  Boolean(focusId) && group.checklists.some((c) => c.id === focusId)
                }
              >
                {group.checklists.map(renderCard)}
              </ChecklistGroup>
            ))}
      </div>
    </div>
  )
}

function ChecklistGroup({
  defaultOpen,
  label,
  count,
  children,
  focusInside = false,
}: {
  defaultOpen: boolean
  label: string
  count: number
  children: React.ReactNode
  /**
   * When the `?focus=` checklist lands inside this group, auto-expand it so a
   * just-created one-time task or just-generated instance is visible even if
   * it landed in a collapsed group ("Later" / "Completed").
   */
  focusInside?: boolean
}) {
  const [userOpen, setUserOpen] = useState(defaultOpen)
  // Auto-expand when the `?focus=` checklist lands inside this group, so a
  // just-created one-time task or just-generated instance is visible even if
  // it landed in a collapsed group. `focusInside` is transient (the focus URL
  // param self-clears after ~1.5s), so it simply forces the group open while
  // active — derived during render, no effect or ref mutation needed.
  const open = userOpen || focusInside
  return (
    <div className="checklist-group">
      <button
        type="button"
        className="checklist-group-header"
        onClick={() => setUserOpen((value) => !value)}
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

export function ChecklistCard({
  activeEmployeeId,
  checklist,
  stageName,
  clients,
  employees,
  focused,
  focusRef,
  hideClientName = false,
  onAddSubItem,
  onAddSubSubItem,
  onBulkAddItems,
  onDeleteChecklist,
  onDeleteItem,
  onRemoveSubItem,
  onRemoveSubSubItem,
  onReorderItems,
  onSetViewers,
  onToggle,
  onToggleSubItem,
  onUpdateSubItemWaiting,
  onToggleSubSubItem,
  onUpdateItem,
  ownerMode,
  role,
  timeEntries,
}: {
  activeEmployeeId: string
  checklist: Checklist
  /** Current stage's name for multi-stage checklists (resolved from template). */
  stageName?: string
  clients: Client[]
  employees: Employee[]
  focused: boolean
  focusRef: React.MutableRefObject<HTMLElement | null> | null
  /** On the client's own page the client is already obvious — hide the big
   *  client-name heading and lead with the checklist title instead. */
  hideClientName?: boolean
  onAddSubItem: (checklistId: string, itemId: string, title: string) => void
  onAddSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => void
  onBulkAddItems: (checklistId: string, labels: string[]) => void
  onDeleteChecklist: (checklistId: string) => Promise<void>
  onDeleteItem: (checklistId: string, itemId: string) => Promise<void>
  onRemoveSubItem: (checklistId: string, itemId: string, subItemId: string) => void
  onRemoveSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => void
  onReorderItems: (checklistId: string, orderedIds: string[]) => void
  onSetViewers: (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void> | void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  onToggleSubItem: (checklistId: string, itemId: string, subItemId: string) => void
  onUpdateSubItemWaiting: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    patch: { waiting?: boolean; waitingOn?: string | null; waitingForChecklistId?: string | null },
  ) => void
  onToggleSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => void
  onUpdateItem: (
    checklistId: string,
    itemId: string,
    patch: {
      title?: string
      dueDate?: string | null
      assigneeId?: string | null
      waitingOn?: string | null
      waiting?: boolean
      waitingForChecklistId?: string | null
    },
  ) => Promise<void>
  ownerMode: boolean
  role: Role
  timeEntries: TimeEntry[]
}) {
  const todayDateOnly = localDateOnly()
  const completed = checklist.items.filter((item) => item.done).length
  const allDone = checklist.items.length > 0 && completed === checklist.items.length
  const viewerIds = checklist.viewerIds ?? []
  const editorIds = checklist.editorIds ?? []
  const isAssignee = checklist.assigneeId === activeEmployeeId
  const isEditor = editorIds.includes(activeEmployeeId)
  // A non-owner can also edit any checklist whose client they're assigned to —
  // resolve the checklist's client and check both assignment lists. This mirrors
  // the server's visible-client allowance so staff can edit the shared board for
  // their clients (not just tasks they're the assignee/editor of).
  const checklistClient = clients.find((c) => c.id === checklist.clientId)
  const isAssignedToClient =
    !!checklistClient &&
    ((checklistClient.assignedEmployeeIds ?? []).includes(activeEmployeeId) ||
      (checklistClient.assignedBookkeeperIds ?? []).includes(activeEmployeeId))
  // A non-owner who is neither assignee nor editor nor assigned to the client
  // sees the task read-only.
  const isViewerOnly = role !== 'owner' && !isAssignee && !isEditor && !isAssignedToClient
  // Whether the current viewer can edit checklist structure (reorder, bulk add)
  const canEditStructure = role === 'owner' || isAssignee || isEditor || isAssignedToClient
  // A staff member has asked an owner to delete this task; surfaces a badge and
  // (for owners) Approve / Reject actions, and disables re-requesting.
  const pendingDeletion = checklistHasPendingDeletionRequest(checklist)

  // Inline edit of the active checklist's own fields (title, due date,
  // assignee). Item-level edits stay on their own controls below. Any authorized
  // editor (owner / assignee / editor / client-assigned) can open this; the
  // server applies the owner's + the creator's edits directly and ROUTES
  // everyone else's to the task's approver.
  const {
    updateChecklistMeta,
    approveChecklistDeletion,
    rejectChecklistDeletion,
    pendingTaskEditChecklistIds,
    serviceCategories,
    addSeriesChecklistItem,
  } = useAppContext()
  const [editingMeta, setEditingMeta] = useState(false)
  // When the owner adds a task to a live RECURRING instance, ask whether it's
  // for this checklist only or the whole series. Holds the pending label(s)
  // until they pick; null = no prompt open.
  const [seriesPromptLabels, setSeriesPromptLabels] = useState<string[] | null>(null)
  const [metaTitle, setMetaTitle] = useState(checklist.title)
  const [metaDue, setMetaDue] = useState(checklist.dueDate)
  const [metaAssignee, setMetaAssignee] = useState(checklist.assigneeId)
  // Board column (service category). '' = Uncategorized. Editing this is how an
  // uncategorized checklist gets moved into the right board column.
  const [metaCategoryId, setMetaCategoryId] = useState(checklist.categoryId ?? '')
  // Inline "sent for approval" note shown after a routed save.
  const [metaPendingNote, setMetaPendingNote] = useState<string | null>(null)
  // True when this task already has a pending edit awaiting approval.
  const hasPendingEdit = pendingTaskEditChecklistIds.has(checklist.id)
  const openMetaEditor = () => {
    setMetaTitle(checklist.title)
    setMetaDue(checklist.dueDate)
    setMetaAssignee(checklist.assigneeId)
    setMetaCategoryId(checklist.categoryId ?? '')
    setMetaPendingNote(null)
    setEditingMeta(true)
  }
  const saveMetaEditor = () => {
    // Don't route a projected ghost (never persisted server-side).
    if (checklist.projected) {
      setEditingMeta(false)
      return
    }
    const title = metaTitle.trim()
    void (async () => {
      const result = await updateChecklistMeta(checklist.id, {
        title: title || checklist.title,
        dueDate: metaDue || checklist.dueDate,
        assigneeId: metaAssignee || checklist.assigneeId,
        // '' → null so choosing "Uncategorized" clears the column.
        categoryId: metaCategoryId || null,
      })
      if (result && 'pending' in result) {
        const approverName = employeeName(employees, result.pending.approverId ?? '')
        setMetaPendingNote(`Sent to ${approverName} for approval.`)
      } else {
        setMetaPendingNote(null)
      }
    })()
    setEditingMeta(false)
  }

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
    // A non-owner assigned to the checklist's client can toggle any item on it
    // (matches the server's visible-client allowance + canEditStructure).
    if (isAssignedToClient) return true
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
          {editingMeta ? (
            <div className="checklist-meta-editor">
              <input
                className="input"
                aria-label="Checklist title"
                value={metaTitle}
                onChange={(event) => setMetaTitle(event.target.value)}
              />
              <div className="checklist-meta-editor-row">
                <label className="field">
                  <span>Due date</span>
                  <input
                    className="input"
                    type="date"
                    value={metaDue}
                    onChange={(event) => setMetaDue(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Assignee</span>
                  <select
                    className="input"
                    value={metaAssignee}
                    onChange={(event) => setMetaAssignee(event.target.value)}
                  >
                    {employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Board column</span>
                  <select
                    className="input"
                    value={metaCategoryId}
                    onChange={(event) => setMetaCategoryId(event.target.value)}
                  >
                    <option value="">Uncategorized</option>
                    {serviceCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="primary-action" onClick={saveMetaEditor}>
                  Save
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => setEditingMeta(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {hideClientName ? (
                <strong className="checklist-card-title">{checklist.title}</strong>
              ) : (
                <>
                  {/* Client name leads (bold + larger) so a long list is easy to
                      scan by client; the checklist name sits just below it. */}
                  <strong className="checklist-card-client">
                    {clientName(clients, checklist.clientId)}
                  </strong>
                  <span className="checklist-card-title-sub">{checklist.title}</span>
                </>
              )}
              {showStageBadge ? (
                <span className="stage-badge">
                  Step {stageNumber} of {stageCount}
                  {stageName ? ` · ${stageName}` : ''} ·{' '}
                  {completed}/{checklist.items.length} done
                  {checklist.caseId && ownerMode ? (
                    <Link
                      className="stage-badge-link"
                      to={`/cases/${encodeURIComponent(checklist.caseId)}`}
                    >
                      Open case
                    </Link>
                  ) : null}
                </span>
              ) : checklist.items.length > 0 ? (
                <span className="checklist-progress-badge">
                  {completed}/{checklist.items.length} done
                </span>
              ) : null}
              <span className="checklist-meta-line">
                {employeeName(employees, checklist.assigneeId)} · Due{' '}
                <strong>{shortDate.format(new Date(`${checklist.dueDate}T12:00:00`))}</strong>
                {checklist.frequency
                  ? ` · ${getChecklistFrequencyLabel(checklist.frequency)}`
                  : ''}
                {!allDone
                  ? (() => {
                      const effDue = effectiveChecklistDue(checklist)
                      const fromStep = effDue !== checklist.dueDate
                      return (
                        <span
                          className={`checklist-due-cue${effDue < todayDateOnly ? ' overdue' : ''}`}
                        >
                          {fromStep ? 'next step ' : ''}
                          {dueDateLabel(effDue, todayDateOnly)}
                        </span>
                      )
                    })()
                  : null}
              </span>
            </>
          )}
          {(() => {
            const totalMinutes = timeEntries
              .filter((entry) => entry.taskId === checklist.id)
              .reduce((sum, entry) => sum + entry.minutes, 0)
            return totalMinutes > 0 ? (
              <span className="checklist-meta-line">Time logged: {formatHours(totalMinutes)}</span>
            ) : null
          })()}
          {metaPendingNote ? (
            <span className="checklist-meta-line pending-edit-note">{metaPendingNote}</span>
          ) : null}
        </div>
        <div className="checklist-meta">
          {handedOff ? <span className="status-pill">Handed off</span> : null}
          {isViewerOnly ? <span className="status-pill">View only</span> : null}
          {hasPendingEdit ? (
            <span
              className="status-pill pending-edit-pill"
              title="An edit to this task is waiting for approval."
            >
              Edit pending approval
            </span>
          ) : null}
          {pendingDeletion ? (
            <span className="status-pill" title="A bookkeeper asked to delete this — an owner must approve.">
              Deletion requested
            </span>
          ) : null}
          {ownerMode && pendingDeletion ? (
            <>
              <button
                type="button"
                className="secondary-action danger"
                onClick={() => void approveChecklistDeletion(checklist.id)}
                title="Approve the deletion request — moves the task to the recycle bin"
              >
                Approve deletion
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={() => void rejectChecklistDeletion(checklist.id)}
                title="Reject the deletion request — keeps the task active"
              >
                Reject
              </button>
            </>
          ) : null}
          {/* The actions menu is available to anyone who can edit the task's
              structure (owner, assignee, or editor). For an owner "Delete"
              soft-deletes immediately; for staff it sends a deletion REQUEST
              the owner approves. Re-requesting is disabled once pending. */}
          {canEditStructure ? (
            <CardActionsMenu
              showEdit={!editingMeta && !checklist.projected}
              showDelete={!pendingDeletion}
              deleteLabel={ownerMode ? 'Delete task' : 'Request deletion'}
              onEdit={openMetaEditor}
              onDelete={() => {
                if (ownerMode) {
                  // Owner: deletion moves the task to the owner-only recycle bin
                  // (recoverable until the bin is emptied). The confirm names the
                  // task and calls out that billing data survives.
                  const confirmed = window.confirm(
                    `Move "${checklist.title}" to the recycle bin?\n\nIt will disappear from the in-progress list and any time entries logged against it stay intact. You can restore it (or empty the bin) from the Recycle bin section below.`,
                  )
                  if (confirmed) {
                    void onDeleteChecklist(checklist.id)
                  }
                } else {
                  // Staff: request deletion — needs owner approval.
                  const confirmed = window.confirm(
                    `Request deletion of "${checklist.title}"?\n\nAn owner must approve before it's removed. The task stays active until then.`,
                  )
                  if (confirmed) {
                    void onDeleteChecklist(checklist.id)
                  }
                }
              }}
            />
          ) : null}
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
        onAddSubItem={(itemId, title) => onAddSubItem(checklist.id, itemId, title)}
        onAddSubSubItem={(itemId, subItemId, title) =>
          onAddSubSubItem(checklist.id, itemId, subItemId, title)
        }
        onCanToggle={canToggleItem}
        onDeleteItem={(itemId) => onDeleteItem(checklist.id, itemId)}
        onRemoveSubItem={(itemId, subItemId) =>
          onRemoveSubItem(checklist.id, itemId, subItemId)
        }
        onRemoveSubSubItem={(itemId, subItemId, subSubItemId) =>
          onRemoveSubSubItem(checklist.id, itemId, subItemId, subSubItemId)
        }
        onReorderItems={onReorderItems}
        onToggle={onToggle}
        onToggleSubItem={(itemId, subItemId) =>
          onToggleSubItem(checklist.id, itemId, subItemId)
        }
        onUpdateSubItemWaiting={(itemId, subItemId, patch) =>
          onUpdateSubItemWaiting(checklist.id, itemId, subItemId, patch)
        }
        onToggleSubSubItem={(itemId, subItemId, subSubItemId) =>
          onToggleSubSubItem(checklist.id, itemId, subItemId, subSubItemId)
        }
        onUpdateItem={(itemId, patch) => onUpdateItem(checklist.id, itemId, patch)}
        todayDateOnly={todayDateOnly}
      />
      {canEditStructure
        ? (() => {
            // On a live recurring instance the owner can add to just this
            // checklist or to the whole series (the template → future instances);
            // everyone/everything else adds to this checklist directly.
            const canSeries = ownerMode && Boolean(checklist.templateId)
            const handleAdd = (labels: string[]) => {
              const clean = labels.map((label) => label.trim()).filter(Boolean)
              if (clean.length === 0) return
              if (canSeries) setSeriesPromptLabels(clean)
              else onBulkAddItems(checklist.id, clean)
            }
            return (
              <>
                <InlineAddItemRow onAdd={(label) => handleAdd([label])} placeholder="Add an item..." />
                <ChecklistBulkAdd label="Paste a list" onAdd={(labels) => handleAdd(labels)} />
                {seriesPromptLabels ? (
                  <div className="series-scope-prompt" role="group" aria-label="Where to add this task">
                    <span className="series-scope-text">
                      Add{' '}
                      {seriesPromptLabels.length === 1
                        ? `“${seriesPromptLabels[0]}”`
                        : `${seriesPromptLabels.length} items`}{' '}
                      to…
                    </span>
                    <div className="series-scope-actions">
                      <button
                        type="button"
                        className="secondary-action"
                        onClick={() => {
                          onBulkAddItems(checklist.id, seriesPromptLabels)
                          setSeriesPromptLabels(null)
                        }}
                      >
                        This checklist only
                      </button>
                      <button
                        type="button"
                        className="primary-action"
                        onClick={() => {
                          onBulkAddItems(checklist.id, seriesPromptLabels)
                          seriesPromptLabels.forEach((label) =>
                            addSeriesChecklistItem(checklist, label),
                          )
                          setSeriesPromptLabels(null)
                        }}
                      >
                        This + all future
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setSeriesPromptLabels(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )
          })()
        : null}
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

/**
 * The editor shown under a checklist item / sub-item once it's flagged
 * "waiting". Gives a roomy note textarea, a quick "waiting on a person" picker
 * (fills the note with a team member's name), and a Clear button to un-flag it.
 */
/**
 * "…" overflow menu for a task card's owner actions (edit / delete).
 * Same handlers the two standalone buttons used to call — only the
 * presentation moved behind a menu so every card isn't shouting a
 * Delete button. Click-outside and Escape both close it.
 */
function CardActionsMenu({
  showEdit,
  showDelete = true,
  deleteLabel = 'Delete task',
  onEdit,
  onDelete,
}: {
  showEdit: boolean
  showDelete?: boolean
  deleteLabel?: string
  onEdit: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: globalThis.MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="card-menu" ref={containerRef}>
      <button
        type="button"
        className="card-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Task actions"
        title="Task actions"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div className="card-menu-list" role="menu">
          {showEdit ? (
            <button
              type="button"
              role="menuitem"
              className="card-menu-item"
              onClick={() => {
                setOpen(false)
                onEdit()
              }}
            >
              Edit details
            </button>
          ) : null}
          {showDelete ? (
            <button
              type="button"
              role="menuitem"
              className="card-menu-item danger"
              onClick={() => {
                setOpen(false)
                onDelete()
              }}
            >
              {deleteLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function WaitingEditor({
  note,
  employees,
  availableTasks,
  waitingForChecklistId,
  waitingOns,
  activeEmployeeId,
  onSetNote,
  onSetWaitingFor,
  onClear,
  onAddWaitingOn,
  onCancelWaitingOn,
  onDoneWaitingOn,
}: {
  note: string
  employees: Employee[]
  availableTasks: Array<{ id: string; title: string }>
  waitingForChecklistId?: string
  /** Structured person-blockers on this node (pending). */
  waitingOns: WaitingOn[]
  activeEmployeeId: string
  onSetNote: (next: string | null) => void
  onSetWaitingFor: (next: string | null) => void
  onClear: () => void
  /** Flag a new person-blocker on this step. */
  onAddWaitingOn: (blockerId: string) => void
  /** Cancel a pending blocker (the blocked side). */
  onCancelWaitingOn: (waitingOnId: string) => void
  /** Mark a pending blocker done (only shown when the current user IS the blocker). */
  onDoneWaitingOn: (waitingOnId: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const { state, flash } = useSaveFlash()

  // Save the note (trimmed); null clears it. Flashes the "Saved" badge.
  const save = (value: string) => {
    const next = value.trim()
    if (next !== (note ?? '')) {
      onSetNote(next === '' ? null : next)
      flash()
    }
  }

  return (
    <div className="waiting-editor">
      <div className="waiting-editor-row">
        <span className="waiting-editor-label">⏳ Waiting on</span>
        <SaveBadge state={state} />
        <select
          className="waiting-person-select"
          aria-label="Waiting on a person"
          value=""
          onChange={(event) => {
            const blockerId = event.target.value
            if (blockerId) onAddWaitingOn(blockerId)
          }}
        >
          <option value="">+ Waiting on a person…</option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.name}
            </option>
          ))}
        </select>
        <button type="button" className="waiting-clear-btn" onClick={onClear}>
          Clear
        </button>
      </div>
      {waitingOns.length > 0 ? (
        <ul className="waiting-blocker-list">
          {waitingOns.map((entry) => {
            const blockerName = employeeName(employees, entry.blockerId)
            const iAmBlocker = entry.blockerId === activeEmployeeId
            return (
              <li key={entry.id} className="waiting-blocker-chip">
                <span className="waiting-blocker-name">Waiting on {blockerName}</span>
                {entry.note ? (
                  <span className="waiting-blocker-note">{entry.note}</span>
                ) : null}
                {iAmBlocker ? (
                  <button
                    type="button"
                    className="waiting-blocker-done"
                    title="Mark what they needed as done — notifies the assignee and flagger"
                    onClick={() => onDoneWaitingOn(entry.id)}
                  >
                    Mark done
                  </button>
                ) : null}
                <button
                  type="button"
                  className="waiting-blocker-cancel"
                  aria-label={`Cancel waiting on ${blockerName}`}
                  title="No longer waiting on this person"
                  onClick={() => onCancelWaitingOn(entry.id)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <textarea
        ref={textareaRef}
        key={note}
        className="waiting-note-textarea"
        rows={2}
        placeholder="e.g. the client to send statements (free-text note)"
        defaultValue={note}
        onBlur={(event) => save(event.target.value)}
      />
      {availableTasks.length > 0 ? (
        <label className="waiting-for-row">
          <span>Waiting for another task to finish? (we'll notify you when it's done)</span>
          <select
            className="waiting-person-select"
            value={waitingForChecklistId ?? ''}
            onChange={(event) => {
              onSetWaitingFor(event.target.value || null)
              flash()
            }}
          >
            <option value="">— not waiting on a task —</option>
            {availableTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}

function DraggableTaskList({
  canEdit,
  canReorder,
  checklistId,
  employees,
  items,
  onAddSubItem,
  onAddSubSubItem,
  onCanToggle,
  onDeleteItem,
  onRemoveSubItem,
  onRemoveSubSubItem,
  onReorderItems,
  onToggle,
  onToggleSubItem,
  onUpdateSubItemWaiting,
  onToggleSubSubItem,
  onUpdateItem,
  todayDateOnly,
}: {
  canEdit: boolean
  canReorder: boolean
  checklistId: string
  employees: Employee[]
  items: ChecklistItem[]
  onAddSubItem: (itemId: string, title: string) => void
  onAddSubSubItem: (itemId: string, subItemId: string, title: string) => void
  onCanToggle: (item: ChecklistItem) => boolean
  onDeleteItem: (itemId: string) => Promise<void>
  onRemoveSubItem: (itemId: string, subItemId: string) => void
  onRemoveSubSubItem: (itemId: string, subItemId: string, subSubItemId: string) => void
  onReorderItems: (checklistId: string, orderedIds: string[]) => void
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  onToggleSubItem: (itemId: string, subItemId: string) => void
  onUpdateSubItemWaiting: (
    itemId: string,
    subItemId: string,
    patch: { waiting?: boolean; waitingOn?: string | null; waitingForChecklistId?: string | null },
  ) => void
  onToggleSubSubItem: (itemId: string, subItemId: string, subSubItemId: string) => void
  onUpdateItem: (
    itemId: string,
    patch: {
      title?: string
      dueDate?: string | null
      assigneeId?: string | null
      waitingOn?: string | null
      waiting?: boolean
      waitingForChecklistId?: string | null
    },
  ) => Promise<void>
  todayDateOnly: string
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // Other checklists for this client — candidates to "wait on" (notified when
  // that one is completed). Pulled from context to avoid prop-drilling.
  // `pendingItemDeletionKeys` drives the per-item "Deletion requested" badge +
  // disabling its delete control (can't re-request a pending deletion).
  const {
    data: appData,
    pendingItemDeletionKeys,
    activeEmployeeId: meId,
    addWaitingOn,
    waitingOnCancel,
    waitingOnDone,
  } = useAppContext()
  const hasPendingDeletion = (
    itemId: string,
    subItemId?: string | null,
    subSubItemId?: string | null,
  ) => pendingItemDeletionKeys.has(itemDeletionKey(checklistId, itemId, subItemId, subSubItemId))
  const availableTasks = useMemo(() => {
    const current = appData.checklists.find((entry) => entry.id === checklistId)
    if (!current) return []
    return appData.checklists
      .filter(
        (entry) =>
          entry.id !== checklistId && !entry.deletedAt && entry.clientId === current.clientId,
      )
      .map((entry) => ({ id: entry.id, title: entry.title }))
  }, [appData.checklists, checklistId])

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
        const subItems = item.subItems ?? []
        const hasSubItems = subItems.length > 0
        const allowToggle = onCanToggle(item)
        const overdue = Boolean(
          item.dueDate && !item.done && item.dueDate < todayDateOnly,
        )
        const classes = ['task-row']
        if (item.done) classes.push('done')
        if (hasSubItems) classes.push('has-sub-items')
        if (draggingId === item.id) classes.push('dragging')
        if (dropTargetId === item.id) classes.push('drop-target')
        const subDoneCount = subItems.filter((sub) => sub.done).length
        return (
          <div key={item.id} className="task-item">
            <div
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
                title={hasSubItems ? 'Checking this checks every sub-step' : undefined}
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
                  {hasSubItems ? (
                    <span className="sub-item-count">
                      {subDoneCount}/{subItems.length}
                    </span>
                  ) : null}
                </span>
                {stepIsWaiting(item) ? (
                  <span className="task-row-waiting" title="Why this step isn't done yet">
                    {item.waitingOn ? `Waiting on: ${item.waitingOn}` : 'Waiting'}
                  </span>
                ) : null}
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
                      aria-label="Who does this step"
                      className="item-assignee-select"
                      title="Who does this step — defaults to the checklist's assignee"
                      value={item.assigneeId ?? ''}
                      onChange={(e) => {
                        void onUpdateItem(item.id, {
                          assigneeId: e.target.value === '' ? null : e.target.value,
                        })
                      }}
                    >
                      <option value="">Same as checklist</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>
                          {emp.name.split(' ')[0]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label="Toggle waiting on"
                      aria-pressed={item.waiting ?? false}
                      className={`item-waiting-toggle${item.waiting ? ' is-waiting' : ''}`}
                      title={
                        item.waiting
                          ? 'Waiting on — click to clear'
                          : 'Flag as waiting on something'
                      }
                      onClick={() => {
                        if (item.waiting) {
                          void onUpdateItem(item.id, { waiting: false, waitingOn: null })
                        } else {
                          void onUpdateItem(item.id, { waiting: true })
                        }
                      }}
                    >
                      ⏳ Waiting
                    </button>
                    <button
                      type="button"
                      aria-label="Delete item"
                      className="item-delete-btn"
                      disabled={hasPendingDeletion(item.id)}
                      title={
                        hasPendingDeletion(item.id)
                          ? 'Deletion already requested — waiting on owner approval'
                          : 'Delete item'
                      }
                      onClick={() => void onDeleteItem(item.id)}
                    >
                      ×
                    </button>
                    {hasPendingDeletion(item.id) ? (
                      <span className="item-deletion-pending" title="An owner must approve this deletion.">
                        Deletion requested
                      </span>
                    ) : null}
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
            {canEdit && stepIsWaiting(item) ? (
              <WaitingEditor
                note={item.waitingOn ?? ''}
                employees={employees}
                availableTasks={availableTasks}
                waitingForChecklistId={item.waitingForChecklistId}
                waitingOns={item.waitingOns ?? []}
                activeEmployeeId={meId}
                onSetNote={(next) => void onUpdateItem(item.id, { waitingOn: next })}
                onSetWaitingFor={(next) =>
                  void onUpdateItem(item.id, { waitingForChecklistId: next })
                }
                onClear={() =>
                  void onUpdateItem(item.id, {
                    waiting: false,
                    waitingOn: null,
                    waitingForChecklistId: null,
                  })
                }
                onAddWaitingOn={(blockerId) =>
                  void addWaitingOn(checklistId, { itemId: item.id, blockerId })
                }
                onCancelWaitingOn={(waitingOnId) =>
                  void waitingOnCancel(checklistId, waitingOnId)
                }
                onDoneWaitingOn={(waitingOnId) => void waitingOnDone(checklistId, waitingOnId)}
              />
            ) : null}
            {(hasSubItems || canEdit) ? (
              <div className="sub-item-list">
                {subItems.map((sub) => {
                  const subSubItems = sub.subItems ?? []
                  const hasSubSubItems = subSubItems.length > 0
                  const subSubDoneCount = subSubItems.filter((s) => s.done).length
                  return (
                    <div key={sub.id} className="sub-item-group">
                      <div className={sub.done ? 'sub-item-row done' : 'sub-item-row'}>
                        <input
                          checked={sub.done}
                          disabled={!allowToggle}
                          onChange={() => onToggleSubItem(item.id, sub.id)}
                          title={
                            hasSubSubItems
                              ? 'Checking this checks every sub-step'
                              : undefined
                          }
                          type="checkbox"
                        />
                        <span className="sub-item-title">{sub.title}</span>
                        {hasSubSubItems ? (
                          <span className="sub-item-count">
                            {subSubDoneCount}/{subSubItems.length}
                          </span>
                        ) : null}
                        {stepIsWaiting(sub) ? (
                          <span
                            className="task-row-waiting sub-waiting-badge"
                            title="Why this sub-step isn't done yet"
                          >
                            {sub.waitingOn ? `Waiting on: ${sub.waitingOn}` : 'Waiting'}
                          </span>
                        ) : null}
                        {canEdit ? (
                          <button
                            type="button"
                            aria-label="Toggle waiting on"
                            aria-pressed={sub.waiting ?? false}
                            className={`item-waiting-toggle sub-item-waiting-toggle${
                              sub.waiting ? ' is-waiting' : ''
                            }`}
                            title={
                              sub.waiting
                                ? 'Waiting on — click to clear'
                                : 'Flag as waiting on something'
                            }
                            onClick={() => {
                              if (sub.waiting) {
                                void onUpdateSubItemWaiting(item.id, sub.id, {
                                  waiting: false,
                                  waitingOn: null,
                                })
                              } else {
                                void onUpdateSubItemWaiting(item.id, sub.id, { waiting: true })
                              }
                            }}
                          >
                            ⏳ Waiting
                          </button>
                        ) : null}
                        {canEdit ? (
                          <button
                            type="button"
                            aria-label="Delete sub-step"
                            className="item-delete-btn sub-item-delete"
                            disabled={hasPendingDeletion(item.id, sub.id)}
                            title={
                              hasPendingDeletion(item.id, sub.id)
                                ? 'Deletion already requested — waiting on owner approval'
                                : 'Delete sub-step'
                            }
                            onClick={() => onRemoveSubItem(item.id, sub.id)}
                          >
                            ×
                          </button>
                        ) : null}
                        {hasPendingDeletion(item.id, sub.id) ? (
                          <span className="item-deletion-pending" title="An owner must approve this deletion.">
                            Deletion requested
                          </span>
                        ) : null}
                      </div>
                      {canEdit && stepIsWaiting(sub) ? (
                        <WaitingEditor
                          note={sub.waitingOn ?? ''}
                          employees={employees}
                          availableTasks={availableTasks}
                          waitingForChecklistId={sub.waitingForChecklistId}
                          waitingOns={sub.waitingOns ?? []}
                          activeEmployeeId={meId}
                          onSetNote={(next) =>
                            void onUpdateSubItemWaiting(item.id, sub.id, { waitingOn: next })
                          }
                          onSetWaitingFor={(next) =>
                            void onUpdateSubItemWaiting(item.id, sub.id, {
                              waitingForChecklistId: next,
                            })
                          }
                          onClear={() =>
                            void onUpdateSubItemWaiting(item.id, sub.id, {
                              waiting: false,
                              waitingOn: null,
                              waitingForChecklistId: null,
                            })
                          }
                          onAddWaitingOn={(blockerId) =>
                            void addWaitingOn(checklistId, {
                              itemId: item.id,
                              subItemId: sub.id,
                              blockerId,
                            })
                          }
                          onCancelWaitingOn={(waitingOnId) =>
                            void waitingOnCancel(checklistId, waitingOnId)
                          }
                          onDoneWaitingOn={(waitingOnId) =>
                            void waitingOnDone(checklistId, waitingOnId)
                          }
                        />
                      ) : null}
                      {(hasSubSubItems || canEdit) ? (
                        <div className="sub-sub-item-list">
                          {subSubItems.map((subSub) => (
                            <div
                              key={subSub.id}
                              className={
                                subSub.done ? 'sub-item-row done' : 'sub-item-row'
                              }
                            >
                              <input
                                checked={subSub.done}
                                disabled={!allowToggle}
                                onChange={() =>
                                  onToggleSubSubItem(item.id, sub.id, subSub.id)
                                }
                                type="checkbox"
                              />
                              <span className="sub-item-title">{subSub.title}</span>
                              {canEdit ? (
                                <button
                                  type="button"
                                  aria-label="Delete sub-step"
                                  className="item-delete-btn sub-item-delete"
                                  disabled={hasPendingDeletion(item.id, sub.id, subSub.id)}
                                  title={
                                    hasPendingDeletion(item.id, sub.id, subSub.id)
                                      ? 'Deletion already requested — waiting on owner approval'
                                      : 'Delete sub-step'
                                  }
                                  onClick={() =>
                                    onRemoveSubSubItem(item.id, sub.id, subSub.id)
                                  }
                                >
                                  ×
                                </button>
                              ) : null}
                              {hasPendingDeletion(item.id, sub.id, subSub.id) ? (
                                <span className="item-deletion-pending" title="An owner must approve this deletion.">
                                  Deletion requested
                                </span>
                              ) : null}
                            </div>
                          ))}
                          {canEdit ? (
                            <SubItemAddRow
                              onAdd={(title) => onAddSubSubItem(item.id, sub.id, title)}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                {canEdit ? (
                  <SubItemAddRow onAdd={(title) => onAddSubItem(item.id, title)} />
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Inline "+ Add sub-step" affordance, rendered under a checklist item. Starts
 * as a clearly-labeled control; expands into a tiny input on click. Visible
 * only to users who can edit the checklist. The `label` defaults to a clear
 * "Add sub-step" so the affordance is discoverable (the client asked for the
 * scattered sub-step controls to be obvious).
 */
function SubItemAddRow({
  onAdd,
  label = 'Add sub-step',
}: {
  onAdd: (title: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const submit = () => {
    const value = draft.trim()
    if (!value) return
    onAdd(value)
    setDraft('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
    if (event.key === 'Escape') {
      setDraft('')
      setOpen(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="sub-item-add-link"
        onClick={() => setOpen(true)}
      >
        <Plus size={12} />
        {label}
      </button>
    )
  }

  return (
    <div className="sub-item-add-row">
      <input
        ref={inputRef}
        autoFocus
        className="sub-item-add-input"
        aria-label="Add a sub-step"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!draft.trim()) setOpen(false)
        }}
        placeholder="Sub-step..."
        type="text"
        value={draft}
      />
      <button
        type="button"
        aria-label="Add sub-step"
        className="inline-add-btn"
        disabled={draft.trim().length === 0}
        onClick={submit}
        title="Add sub-step (Enter)"
      >
        <Plus size={12} />
      </button>
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

/**
 * "Specific months" scheduling editor: 12 month checkboxes (Jan–Dec) plus a
 * "Due day of month" number input (1–28). Used by both the create form and the
 * template editor when frequency is `specific-months`.
 */
function SpecificMonthsPicker({
  scheduledMonths,
  monthlyDueDays,
  onChangeMonths,
  onChangeMonthDue,
  repeatAnnually,
  onChangeRepeatAnnually,
}: {
  scheduledMonths: number[]
  monthlyDueDays: Record<string, number> | undefined
  onChangeMonths: (months: number[]) => void
  onChangeMonthDue: (month: number, day: number | undefined) => void
  repeatAnnually: boolean
  onChangeRepeatAnnually: (value: boolean) => void
}) {
  const toggleMonth = (month: number) => {
    const set = new Set(scheduledMonths)
    if (set.has(month)) {
      set.delete(month)
    } else {
      set.add(month)
    }
    onChangeMonths([...set].sort((a, b) => a - b))
  }

  const currentYear = new Date().getFullYear()
  const todayStr = localDateOnly()

  return (
    <div className="specific-months">
      <span className="specific-months-label">Which months</span>
      <div className="specific-months-grid">
        {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
          <label key={month} className="specific-months-month">
            <input
              type="checkbox"
              checked={scheduledMonths.includes(month)}
              onChange={() => toggleMonth(month)}
            />
            <span>{monthShortNames[month]}</span>
          </label>
        ))}
      </div>
      <label className="specific-months-repeat">
        <input
          type="checkbox"
          checked={repeatAnnually}
          onChange={(event) => onChangeRepeatAnnually(event.target.checked)}
        />
        <span>Repeat every year</span>
      </label>
      {scheduledMonths.length > 0 ? (
        <div className="specific-months-due-dates">
          <span className="specific-months-label">Due date in each month</span>
          {scheduledMonths.map((month) => {
            const lastDay = new Date(currentYear, month, 0).getDate()
            const stored = monthlyDueDays ? Number(monthlyDueDays[month]) : NaN
            const day = Number.isFinite(stored) && stored >= 1 ? Math.min(stored, lastDay) : lastDay
            const value = `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            // A month whose due date has already passed is auto-completed by the
            // materializer; flag it here so the owner sees that at a glance.
            const isPast = value < todayStr
            return (
              <label key={month} className="specific-months-due-row">
                <span className="specific-months-due-month">{monthShortNames[month]}</span>
                <input
                  className="input"
                  type="date"
                  value={value}
                  onChange={(event) => {
                    const raw = event.target.value
                    if (!raw) {
                      onChangeMonthDue(month, undefined)
                      return
                    }
                    const picked = Number(raw.split('-')[2])
                    if (!Number.isFinite(picked)) return
                    onChangeMonthDue(month, Math.min(Math.max(1, picked), lastDay))
                  }}
                />
                {isPast ? (
                  <span className="specific-months-complete-badge">Complete</span>
                ) : null}
              </label>
            )
          })}
          <small className="new-task-hint">
            Each selected month&apos;s task is due on the day you pick — any day of
            that month. The due date always stays within its month; clear a date
            to use that month&apos;s last day.
          </small>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The unified create form. Used for BOTH one-time and repeating tasks.
 * The only differences are:
 *   - "How often" picker is rendered only in repeating mode
 *   - "+ Add a hand-off step" link is rendered only in repeating mode
 *   - On submit, repeating mode constructs a ChecklistTemplate (with stages),
 *     one-time mode posts a Checklist
 */
export function NewTaskForm({
  mode,
  activeEmployeeId,
  clients,
  employees,
  role,
  onCancel,
  onCreateOneTime,
  onCreateRepeating,
}: {
  mode: 'one-time' | 'repeating'
  activeEmployeeId: string
  clients: Client[]
  employees: Employee[]
  role: Role
  onCancel: () => void
  onCreateOneTime: (payload: {
    title: string
    clientId: string
    assigneeId: string
    dueDate: string
    categoryId?: string | null
    items: Array<Pick<ChecklistTemplateItem, 'label' | 'subItems'>>
  }) => Promise<void>
  onCreateRepeating: (
    template: Omit<ChecklistTemplate, 'id'>,
    startFirstNow: boolean,
  ) => void
}) {
  // Board columns (service categories), so a new task can be filed into one.
  const { serviceCategories } = useAppContext()

  // Owners can pick any employee. Non-owners are filtered out at the panel
  // level today (server only permits owners to create), but keep this guard
  // so that if the server later allows employees, they only see themselves.
  const assignableEmployees = useMemo(() => {
    if (role === 'owner') return employees
    return employees.filter((employee) => employee.id === activeEmployeeId)
  }, [employees, role, activeEmployeeId])

  // Smart defaults
  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name)),
    [clients],
  )
  const defaultAssigneeId =
    assignableEmployees.find((emp) => emp.id === activeEmployeeId)?.id ??
    assignableEmployees[0]?.id ??
    ''

  const [title, setTitle] = useState('')
  const [clientId, setClientId] = useState(sortedClients[0]?.id ?? '')
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId)
  const [dueDate, setDueDate] = useState(lastDayOfCurrentMonth())
  const [categoryId, setCategoryId] = useState('')
  const [frequency, setFrequency] = useState<ChecklistFrequency>('monthly')
  const [scheduledMonths, setScheduledMonths] = useState<number[]>([])
  const [monthlyDueDays, setMonthlyDueDays] = useState<Record<string, number>>({})
  // Specific-months "Repeat every year" toggle. Defaults ON to match the
  // historical (always-repeat) behavior.
  const [repeatAnnually, setRepeatAnnually] = useState(true)

  const setMonthDue = (month: number, day: number | undefined) => {
    setMonthlyDueDays((prev) => {
      const next = { ...prev }
      if (day === undefined) {
        delete next[month]
      } else {
        next[month] = day
      }
      return next
    })
  }
  // The first stage's steps as a nested outliner tree (item → sub → sub-sub).
  const [itemTree, setItemTree] = useState<ChecklistTemplateItem[]>([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Specific-months mode hides the next-due-date picker (it isn't used) and
  // shows the 12-month checkboxes instead.
  const isSpecificMonths = mode === 'repeating' && frequency === 'specific-months'
  // Repeating mode: default ON. When checked, a checkable Stage-1 instance is
  // created immediately on save so the user can start right away, independent
  // of the recurrence schedule.
  const [startFirstNow, setStartFirstNow] = useState(true)

  // Hand-off (multi-stage) toggle. Only available in repeating mode.
  // When enabled, we render an editor for additional stages.
  const [extraStages, setExtraStages] = useState<TemplateStage[]>([])
  const showHandOffControls = mode === 'repeating'

  const addHandOffStage = () => {
    setExtraStages((current) => [
      ...current,
      {
        id: makeId('stage'),
        name: `Step ${current.length + 2}`,
        assigneeId: defaultAssigneeId,
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: [],
      },
    ])
  }

  const updateExtraStage = (stageId: string, patch: Partial<TemplateStage>) => {
    setExtraStages((current) =>
      current.map((stage) => (stage.id === stageId ? { ...stage, ...patch } : stage)),
    )
  }

  const removeExtraStage = (stageId: string) => {
    setExtraStages((current) => current.filter((stage) => stage.id !== stageId))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return

    const trimmedTitle = title.trim()
    // The outliner can leave blank rows mid-edit — drop empties at every level.
    const items = pruneEmptyOutlineItems(itemTree)

    if (!trimmedTitle) {
      setError('Give the task a title.')
      return
    }
    if (!clientId) {
      setError('Pick a client.')
      return
    }
    if (!assigneeId) {
      setError('Pick who does this.')
      return
    }
    // Specific-months templates don't use a fixed due date; they need at
    // least one designated month instead.
    if (!isSpecificMonths && !dueDate) {
      setError('Pick a due date.')
      return
    }
    if (isSpecificMonths && scheduledMonths.length === 0) {
      setError('Pick at least one month.')
      return
    }
    if (items.length === 0) {
      setError('Add at least one step.')
      return
    }

    setError('')

    if (mode === 'one-time') {
      setSubmitting(true)
      try {
        await onCreateOneTime({
          title: trimmedTitle,
          clientId,
          assigneeId,
          dueDate,
          categoryId: categoryId || null,
          items,
        })
        setTitle('')
        setItemTree([])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create task.')
      } finally {
        setSubmitting(false)
      }
      return
    }

    // Repeating mode: build a ChecklistTemplate. The first stage is the
    // user's main step list (nested outliner tree); extra hand-off stages
    // are appended.
    const firstStage: TemplateStage = {
      id: makeId('stage'),
      name: 'Step 1',
      assigneeId,
      offsetDays: 0,
      viewerIds: [],
      editorIds: [],
      items,
    }
    onCreateRepeating(
      {
        title: trimmedTitle,
        clientId,
        assigneeId,
        frequency,
        // Specific-months templates have no fixed next-due date — the
        // designated months drive generation instead.
        nextDueDate: isSpecificMonths ? '' : dueDate,
        active: true,
        viewerIds: [],
        editorIds: [],
        categoryId: categoryId || null,
        stages: [firstStage, ...extraStages],
        ...(isSpecificMonths
          ? {
              scheduledMonths,
              monthlyDueDays,
              repeatAnnually,
              // Pin the year so a non-repeating template only fires this year.
              scheduleYear: new Date().getFullYear(),
            }
          : {}),
      },
      // "Start the first one now" is not offered for specific-months — those
      // generate automatically when a designated month arrives.
      isSpecificMonths ? false : startFirstNow,
    )
    setTitle('')
    setItemTree([])
    setExtraStages([])
  }

  return (
    <form className="new-task-form" onSubmit={handleSubmit}>
      <div className="new-task-form-mode-pill">
        {mode === 'one-time' ? 'New one-time task' : 'New repeating task'}
      </div>

      <label className="new-task-field">
        <span>Title</span>
        <input
          className="input"
          placeholder="What needs to get done?"
          onChange={(event) => setTitle(event.target.value)}
          value={title}
          autoFocus
        />
      </label>

      <div className="new-task-field-row">
        <label className="new-task-field">
          <span>For which client</span>
          <select
            className="input"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          >
            {sortedClients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>

        <label className="new-task-field">
          <span>Who does this</span>
          <select
            className="input"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            {assignableEmployees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>

        <label className="new-task-field">
          <span>Board column</span>
          <select
            className="input"
            title="Which column on the Active Checklists board this appears in"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Uncategorized</option>
            {serviceCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>

        {isSpecificMonths ? null : (
          <label className="new-task-field">
            <span>Due</span>
            <input
              className="input"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </label>
        )}

        {mode === 'repeating' ? (
          <label className="new-task-field">
            <span>How often</span>
            <select
              className="input"
              value={frequency}
              onChange={(event) =>
                setFrequency(event.target.value as ChecklistFrequency)
              }
            >
              {checklistFrequencies.map((option) => (
                <option key={option} value={option}>
                  {getChecklistFrequencyLabel(option)}
                </option>
              ))}
            </select>
            <small className="new-task-hint">
              Tasks repeat at this rate. The next one will appear automatically.
            </small>
          </label>
        ) : null}
      </div>

      {isSpecificMonths ? (
        <SpecificMonthsPicker
          scheduledMonths={scheduledMonths}
          monthlyDueDays={monthlyDueDays}
          onChangeMonths={setScheduledMonths}
          onChangeMonthDue={setMonthDue}
          repeatAnnually={repeatAnnually}
          onChangeRepeatAnnually={setRepeatAnnually}
        />
      ) : null}

      <div className="new-task-field">
        <span>Steps</span>
        <ChecklistOutliner
          items={itemTree}
          onChange={setItemTree}
          ariaLabel="Task steps"
          addPlaceholder="Add a step, then press Enter"
        />
      </div>

      {showHandOffControls ? (
        <div className="hand-off-block">
          {extraStages.length === 0 ? (
            <button
              type="button"
              className="link-action"
              onClick={addHandOffStage}
            >
              + Add a hand-off step
            </button>
          ) : (
            <div className="hand-off-stages">
              {extraStages.map((stage, index) => (
                <div key={stage.id} className="hand-off-stage-row stage-card">
                  <div className="hand-off-stage-header">
                    <span className="stage-index-pill">Step {index + 2}</span>
                    <input
                      className="input stage-name-input"
                      value={stage.name}
                      aria-label="Step name"
                      onChange={(event) =>
                        updateExtraStage(stage.id, { name: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="item-delete-btn"
                      title="Remove this hand-off"
                      aria-label="Remove hand-off"
                      onClick={() => removeExtraStage(stage.id)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="hand-off-stage-fields">
                    <label className="new-task-field">
                      <span>Who picks it up</span>
                      <select
                        className="input"
                        value={stage.assigneeId}
                        onChange={(event) =>
                          updateExtraStage(stage.id, { assigneeId: event.target.value })
                        }
                      >
                        {employees.map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <StageScheduleControl
                    dueDate={stage.dueDate}
                    dueDayOfMonth={stage.dueDayOfMonth}
                    onChange={(next) =>
                      updateExtraStage(stage.id, {
                        dueDate: next.dueDate,
                        dueDayOfMonth: next.dueDayOfMonth,
                      })
                    }
                  />
                  <div className="new-task-field">
                    <span>Steps for this hand-off</span>
                    <ChecklistOutliner
                      items={stage.items}
                      onChange={(items) => updateExtraStage(stage.id, { items })}
                      ariaLabel={`Steps for ${stage.name}`}
                      addPlaceholder="Add a step, then press Enter"
                    />
                  </div>
                </div>
              ))}
              <button type="button" className="link-action" onClick={addHandOffStage}>
                + Add another hand-off step
              </button>
            </div>
          )}
          <small className="new-task-hint">
            Use this if a different person picks up after the first person finishes.
          </small>
        </div>
      ) : null}

      {mode === 'repeating' && !isSpecificMonths ? (
        <label className="start-first-now-row">
          <input
            type="checkbox"
            checked={startFirstNow}
            onChange={(event) => setStartFirstNow(event.target.checked)}
          />
          <span>Create the first checklist now so you can start right away.</span>
        </label>
      ) : null}

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
          {submitting ? 'Saving...' : 'Create'}
        </button>
      </div>
    </form>
  )
}

/**
 * Inline "pick a client → apply" control. Used by both the regular
 * "Copy to client" action and the standard-template "Apply to client" action.
 * Opens a small client picker; on confirm, calls `onApply` and resets.
 */
function ApplyToClientControl({
  clients,
  label,
  title,
  onApply,
}: {
  clients: Client[]
  label: string
  title: string
  onApply: (clientId: string) => Promise<void>
}) {
  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name)),
    [clients],
  )
  const [open, setOpen] = useState(false)
  const [clientId, setClientId] = useState(sortedClients[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleApply = async () => {
    if (!clientId || busy) return
    setBusy(true)
    setError('')
    try {
      await onApply(clientId)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy template.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="secondary-action"
        title={title}
        onClick={() => setOpen(true)}
      >
        <Copy size={14} />
        {label}
      </button>
    )
  }

  return (
    <div className="apply-to-client">
      <select
        className="compact-input"
        aria-label="Target client"
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
      >
        {sortedClients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="primary-action"
        disabled={busy || !clientId}
        onClick={handleApply}
      >
        {busy ? 'Copying...' : label}
      </button>
      <button
        type="button"
        className="secondary-action"
        disabled={busy}
        onClick={() => {
          setOpen(false)
          setError('')
        }}
      >
        Cancel
      </button>
      {error ? <span className="apply-to-client-error">{error}</span> : null}
    </div>
  )
}

type RepeatingTasksManagerProps = {
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string, stageId: string) => void
  onAddStage: (templateId: string) => void
  /** Wave 2: copy a standard OR regular template onto a (possibly different) client. */
  onApplyToClient: (
    templateId: string,
    payload: { clientId: string; firstDueDate?: string; frequency?: string },
  ) => Promise<void>
  onBulkAddItems: (templateId: string, stageId: string, labels: string[]) => void
  onDeleteItem: (templateId: string, stageId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  /** Optional: "Duplicate" a regular repeating task. Omitted for standard templates. */
  onDuplicate?: (templateId: string) => void
  /** Sub-bullet editing on template items (flows into generated checklists). */
  onAddSubItem: (templateId: string, stageId: string, itemId: string, title: string) => void
  onUpdateSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => void
  onRemoveSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
  ) => void
  /** Sub-sub-bullet editing on template items (the deepest template level). */
  onAddSubSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => void
  onUpdateSubSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
    title: string,
  ) => void
  onRemoveSubSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => void
  /** Wave 2: materialize a Stage-1 instance on demand ("Generate a task now"). */
  onGenerateNow?: (templateId: string, opts?: { dueDate?: string }) => Promise<void>
  /** Wave 2: present standard templates differently (no client / no recurrence). */
  standardMode?: boolean
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

/**
 * Compact list of repeating tasks. Each row collapses by default to a single
 * inbox-style line; only one row open at a time.
 */
function RepeatingTasksManager(props: RepeatingTasksManagerProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  // Per-client groups collapse independently to cut clutter; default expanded.
  const [collapsedClients, setCollapsedClients] = useState<Set<string>>(new Set())
  const [searchParams, setSearchParams] = useSearchParams()
  const focusTemplateId = searchParams.get('focusTemplate')
  const focusRef = useRef<HTMLElement | null>(null)

  const toggleOpen = (templateId: string) => {
    setOpenId((current) => (current === templateId ? null : templateId))
  }
  const toggleClient = (clientId: string) => {
    setCollapsedClients((prev) => {
      const next = new Set(prev)
      if (next.has(clientId)) next.delete(clientId)
      else next.add(clientId)
      return next
    })
  }

  // Client-bound repeating tasks only — standard (client-agnostic) templates
  // live in their own section.
  const regularTemplates = props.templates.filter((template) => !template.isStandard)

  // Group the repeating tasks under their client so the list stays organized.
  const clientGroups = (() => {
    const byClient = new Map<string, ChecklistTemplate[]>()
    for (const template of regularTemplates) {
      const list = byClient.get(template.clientId) ?? []
      list.push(template)
      byClient.set(template.clientId, list)
    }
    return [...byClient.entries()]
      .map(([clientId, templates]) => ({
        clientId,
        label: clientName(props.clients, clientId),
        templates: templates.slice().sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })()

  // Deep-link support: another page (e.g. the client detail "Recurring
  // checklists" card) can navigate here with ?focusTemplate=<id> to open and
  // scroll to a specific repeating task. We expand it, scroll it into view,
  // then strip the param so it doesn't keep re-firing.
  useEffect(() => {
    if (!focusTemplateId) return
    const exists = regularTemplates.some((template) => template.id === focusTemplateId)
    if (!exists) return
    // Defer the open + scroll out of the effect body (avoids a synchronous
    // setState-in-effect) and gives the row a tick to expand before scrolling.
    const scrollTimer = window.setTimeout(() => {
      setOpenId(focusTemplateId)
      // Make sure the focused task's client group is expanded so it's visible.
      const focusTemplate = regularTemplates.find((t) => t.id === focusTemplateId)
      if (focusTemplate) {
        setCollapsedClients((prev) => {
          if (!prev.has(focusTemplate.clientId)) return prev
          const next = new Set(prev)
          next.delete(focusTemplate.clientId)
          return next
        })
      }
      focusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
    const clearTimer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams)
      next.delete('focusTemplate')
      setSearchParams(next, { replace: true })
    }, 1500)
    return () => {
      window.clearTimeout(scrollTimer)
      window.clearTimeout(clearTimer)
    }
  }, [focusTemplateId, regularTemplates, searchParams, setSearchParams])

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Repeating tasks</h2>
        </div>
      </div>
      <div className="repeating-task-list">
        {regularTemplates.length === 0 ? (
          <p className="empty-state">No repeating tasks yet. Hit + New to add one.</p>
        ) : null}
        {clientGroups.map((group) => {
          const collapsed = collapsedClients.has(group.clientId)
          return (
            <div className="repeating-client-group" key={group.clientId}>
              <button
                type="button"
                className="repeating-client-header"
                aria-expanded={!collapsed}
                onClick={() => toggleClient(group.clientId)}
              >
                {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                <strong>{group.label}</strong>
                <span className="repeating-client-count">{group.templates.length}</span>
              </button>
              {collapsed ? null : (
                <div className="repeating-client-body">
                  {group.templates.map((template) => (
                    <RepeatingTaskRow
                      key={template.id}
                      {...props}
                      template={template}
                      open={openId === template.id}
                      onToggleOpen={() => toggleOpen(template.id)}
                      rowRef={template.id === focusTemplateId ? focusRef : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

type RepeatingTaskRowProps = Omit<RepeatingTasksManagerProps, 'templates'> & {
  template: ChecklistTemplate
  open: boolean
  onToggleOpen: () => void
  rowRef?: RefObject<HTMLElement | null>
}

function RepeatingTaskRow(props: RepeatingTaskRowProps) {
  const { template, open, onToggleOpen, rowRef } = props
  const isSpecificMonths = template.frequency === 'specific-months'
  const dueLabel = template.nextDueDate
    ? shortDate.format(new Date(`${template.nextDueDate}T12:00:00`))
    : '—'
  // Plain-language reminder that a repeating task is a recipe, not a checklist.
  // Standard templates are blueprints — they never generate on their own.
  const explainerLine = props.standardMode
    ? 'A reusable blueprint — it never generates a checklist on its own. Use "Apply to client" to put it to work.'
    : isSpecificMonths
      ? specificMonthsSummary(template)
      : `Generates a checklist ${frequencyCadence(template.frequency)} — next on ${dueLabel}.`

  return (
    <article
      ref={rowRef}
      className={`${open ? 'repeating-task-row open' : 'repeating-task-row'}${
        rowRef ? ' repeating-task-row-focused' : ''
      }`}
    >
      <button
        type="button"
        className="repeating-task-summary"
        onClick={onToggleOpen}
        aria-expanded={open}
      >
        <span className="repeating-task-title">{template.title}</span>
        <span className="repeating-task-meta">
          {props.standardMode
            ? 'Standard template'
            : clientName(props.clients, template.clientId)}
        </span>
        <span className="repeating-task-meta">
          Who: {employeeName(props.employees, template.assigneeId)}
        </span>
        <span className="repeating-task-meta">
          How often: {getChecklistFrequencyLabel(template.frequency)}
        </span>
        <span className="repeating-task-meta">
          {props.standardMode
            ? ''
            : isSpecificMonths
              ? `Months: ${
                  (template.scheduledMonths ?? [])
                    .filter((m) => m >= 1 && m <= 12)
                    .sort((a, b) => a - b)
                    .map((m) => monthShortNames[m])
                    .join(', ') || 'none yet'
                }`
              : `Next due: ${dueLabel}`}
        </span>
        <span
          className={
            template.active
              ? 'repeating-task-toggle-pill on'
              : 'repeating-task-toggle-pill off'
          }
        >
          {template.active ? 'On' : 'Off'}
        </span>
        <span className="repeating-task-chevron" aria-hidden="true">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      <p className="repeating-task-explainer">{explainerLine}</p>
      {open ? <TemplateEditor {...props} /> : null}
    </article>
  )
}

function TemplateEditor(props: RepeatingTaskRowProps) {
  const { template } = props
  // The Active Checklists board columns — lets the owner sort this template
  // (and the checklists it generates) into a board column.
  const { serviceCategories } = useAppContext()
  const stages = template.stages ?? []
  return (
    <div className="repeating-task-body">
      <div className="template-card-actions">
        {props.standardMode ? (
          <ApplyToClientControl
            clients={props.clients}
            label="Apply to client"
            title="Create a real, client-bound repeating task copied from this standard template"
            onApply={(clientId) =>
              props.onApplyToClient(template.id, {
                clientId,
                frequency: template.frequency,
              })
            }
          />
        ) : (
          <>
            {props.onGenerateNow ? (
              <button
                className="primary-action"
                onClick={() => void props.onGenerateNow?.(template.id)}
                type="button"
                title="Pull the next occurrence forward — create a checkable checklist now without waiting for the schedule"
              >
                <Plus size={14} />
                Start now
              </button>
            ) : null}
            <ApplyToClientControl
              clients={props.clients}
              label="Copy to client"
              title="Duplicate this repeating task onto another client"
              onApply={(clientId) =>
                props.onApplyToClient(template.id, {
                  clientId,
                  frequency: template.frequency,
                })
              }
            />
          </>
        )}
        {props.onDuplicate ? (
          <button
            className="secondary-action"
            onClick={() => props.onDuplicate?.(template.id)}
            type="button"
            title="Create a new repeating task pre-filled from this one"
          >
            <Copy size={14} />
            Duplicate
          </button>
        ) : null}
        <button
          className="secondary-action danger"
          onClick={() => props.onDeleteTemplate(template.id)}
          type="button"
        >
          Remove
        </button>
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
        {props.standardMode ? null : (
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
        )}
        <label className="field">
          <span>Who does this</span>
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
          <span>Board column</span>
          <select
            className="input"
            title="Which column on the Active Checklists board this lands in"
            value={template.categoryId ?? ''}
            onChange={(event) =>
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                categoryId: event.target.value === '' ? null : event.target.value,
              }))
            }
          >
            <option value="">Uncategorized</option>
            {serviceCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>How often</span>
          <select
            className="input"
            onChange={(event) => {
              const nextFrequency = event.target.value as ChecklistFrequency
              props.onUpdateTemplate(template.id, (current) => ({
                ...current,
                frequency: nextFrequency,
                // Switching INTO specific-months clears the unused next-due
                // date; switching OUT of it restores a sensible default.
                nextDueDate:
                  nextFrequency === 'specific-months'
                    ? ''
                    : current.nextDueDate || lastDayOfCurrentMonth(),
              }))
            }}
            value={template.frequency}
          >
            {checklistFrequencies.map((option) => (
              <option key={option} value={option}>
                {getChecklistFrequencyLabel(option)}
              </option>
            ))}
          </select>
        </label>
        {template.frequency === 'specific-months' ? null : (
          <label className="field">
            <span>Next due</span>
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
        )}
        {template.frequency === 'specific-months' ? null : (
          <label className="field">
            <span>Show before due (days)</span>
            <input
              className="input"
              type="number"
              min="0"
              max="120"
              title="How many days before its due date this task appears, so the team can start it early. 0 = appears on the due date."
              value={template.leadDays ?? 0}
              onChange={(event) => {
                const value = Number(event.target.value)
                const leadDays =
                  Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 120) : 0
                props.onUpdateTemplate(template.id, (current) => ({ ...current, leadDays }))
              }}
            />
          </label>
        )}
        <label className="repeating-task-on-off-row">
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
          <span>{template.active ? 'On' : 'Off'}</span>
        </label>
      </div>
      {template.frequency === 'specific-months' ? (
        <SpecificMonthsPicker
          scheduledMonths={template.scheduledMonths ?? []}
          monthlyDueDays={template.monthlyDueDays}
          repeatAnnually={template.repeatAnnually !== false}
          onChangeRepeatAnnually={(value) =>
            props.onUpdateTemplate(template.id, (current) => ({
              ...current,
              repeatAnnually: value,
              // Pin the schedule year the moment annual repeat is turned off so
              // the materializer knows which single year to fire in.
              ...(value ? {} : { scheduleYear: current.scheduleYear ?? new Date().getFullYear() }),
            }))
          }
          onChangeMonths={(months) =>
            props.onUpdateTemplate(template.id, (current) => ({
              ...current,
              scheduledMonths: months,
            }))
          }
          onChangeMonthDue={(month, day) =>
            props.onUpdateTemplate(template.id, (current) => {
              const next = { ...current }
              const map = { ...(next.monthlyDueDays ?? {}) }
              if (day === undefined) {
                delete map[month]
              } else {
                map[month] = day
              }
              next.monthlyDueDays = map
              return next
            })
          }
        />
      ) : null}
      <StagesAccordion {...props} stages={stages} />
      <button
        className="secondary-action"
        onClick={() => props.onAddStage(template.id)}
        type="button"
      >
        <Plus size={16} />
        Add hand-off step
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
    </div>
  )
}

function StagesAccordion(props: RepeatingTaskRowProps & { stages: TemplateStage[] }) {
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
                aria-label={isOpen ? 'Collapse step' : 'Expand step'}
                title={isOpen ? 'Collapse step' : 'Expand step'}
                onClick={() => toggleStageOpen(stage.id)}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <span className="stage-index-pill">Step {index + 1}</span>
              <input
                className="input stage-name-input"
                value={stage.name}
                onChange={(event) =>
                  props.onPatchStage(template.id, stage.id, { name: event.target.value })
                }
              />
              <button
                aria-label="Remove step"
                className="item-delete-btn"
                title="Remove step"
                type="button"
                onClick={() => {
                  if (
                    stage.items.length > 0 &&
                    !window.confirm('This step has items. Remove anyway?')
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
                  <span>Who does this step</span>
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
              </div>
              <StageScheduleControl
                dueDate={stage.dueDate}
                dueDayOfMonth={stage.dueDayOfMonth}
                onChange={(next) =>
                  props.onPatchStage(template.id, stage.id, {
                    dueDate: next.dueDate ?? '',
                    dueDayOfMonth: next.dueDayOfMonth,
                  })
                }
              />
              <div className="stage-steps-outline">
                <span className="stage-steps-box-label">Steps</span>
                <ChecklistOutliner
                  items={stage.items}
                  onChange={(items) =>
                    props.onUpdateTemplate(template.id, (current) => ({
                      ...current,
                      stages: (current.stages ?? []).map((s) =>
                        s.id === stage.id ? { ...s, items } : s,
                      ),
                    }))
                  }
                  ariaLabel={`Steps for ${stage.name}`}
                  addPlaceholder="Add a step, then press Enter"
                />
              </div>
              {stage.items.length > 0 ? (
                <details className="stage-fine-tune">
                  <summary>Fine-tune items (reorder, dates, assignees)</summary>
                  <DraggableTemplateItems
                    employees={props.employees}
                    items={stage.items}
                    onAddSubItem={(itemId, title) =>
                      props.onAddSubItem(template.id, stage.id, itemId, title)
                    }
                    onAddSubSubItem={(itemId, subItemId, title) =>
                      props.onAddSubSubItem(template.id, stage.id, itemId, subItemId, title)
                    }
                    onDeleteItem={(itemId) =>
                      props.onDeleteItem(template.id, stage.id, itemId)
                    }
                    onRemoveSubItem={(itemId, subItemId) =>
                      props.onRemoveSubItem(template.id, stage.id, itemId, subItemId)
                    }
                    onRemoveSubSubItem={(itemId, subItemId, subSubItemId) =>
                      props.onRemoveSubSubItem(
                        template.id,
                        stage.id,
                        itemId,
                        subItemId,
                        subSubItemId,
                      )
                    }
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
                    onUpdateSubItem={(itemId, subItemId, title) =>
                      props.onUpdateSubItem(template.id, stage.id, itemId, subItemId, title)
                    }
                    onUpdateSubSubItem={(itemId, subItemId, subSubItemId, title) =>
                      props.onUpdateSubSubItem(
                        template.id,
                        stage.id,
                        itemId,
                        subItemId,
                        subSubItemId,
                        title,
                      )
                    }
                  />
                  <InlineAddItemRow
                    onAdd={(label) =>
                      props.onBulkAddItems(template.id, stage.id, [label])
                    }
                    placeholder="Add an item..."
                  />
                </details>
              ) : null}
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

/**
 * Per-stage due-date control. A stage either inherits its due date from the
 * offset ("N days after previous step") or pins an explicit fixed date.
 * Picking "Specific date" reveals a date input. Independent *repeat cadence*
 * per stage is intentionally not offered — the template repeats as a whole.
 */
function StageScheduleControl({
  dueDate,
  dueDayOfMonth,
  onChange,
}: {
  dueDate?: string
  dueDayOfMonth?: number
  /**
   * Sets the stage's due spec. Setting one of `dueDate` / `dueDayOfMonth`
   * clears the other; the "No specific due date" choice clears both.
   */
  onChange: (next: { dueDate?: string; dueDayOfMonth?: number }) => void
}) {
  const { state, flash } = useSaveFlash()
  const emit = (next: { dueDate?: string; dueDayOfMonth?: number }) => {
    onChange(next)
    flash()
  }
  const mode: 'none' | 'day' | 'date' = dueDate
    ? 'date'
    : typeof dueDayOfMonth === 'number'
      ? 'day'
      : 'none'
  return (
    <div className="stage-schedule">
      <span className="stage-schedule-title">
        Due <SaveBadge state={state} />
      </span>
      <div className="stage-schedule-options">
        <label className="stage-schedule-radio">
          <input
            type="radio"
            checked={mode === 'none'}
            onChange={() => emit({ dueDate: undefined, dueDayOfMonth: undefined })}
          />
          <span>No specific due date</span>
        </label>
        <label className="stage-schedule-radio">
          <input
            type="radio"
            checked={mode === 'day'}
            onChange={() => emit({ dueDate: undefined, dueDayOfMonth: dueDayOfMonth ?? 1 })}
          />
          <span>
            Day of the month
            {mode === 'day' ? (
              <input
                className="compact-input stage-schedule-offset"
                type="number"
                min={1}
                max={31}
                value={dueDayOfMonth ?? 1}
                onChange={(event) => {
                  const value = Math.min(Math.max(Number(event.target.value) || 1, 1), 31)
                  emit({ dueDate: undefined, dueDayOfMonth: value })
                }}
              />
            ) : null}
          </span>
        </label>
        <label className="stage-schedule-radio">
          <input
            type="radio"
            checked={mode === 'date'}
            onChange={() =>
              emit({
                dueDate: dueDate || localDateOnly(),
                dueDayOfMonth: undefined,
              })
            }
          />
          <span>
            Specific date
            {mode === 'date' ? (
              <input
                className="compact-input stage-schedule-date"
                type="date"
                value={dueDate ?? ''}
                onChange={(event) =>
                  emit({ dueDate: event.target.value || undefined, dueDayOfMonth: undefined })
                }
              />
            ) : null}
          </span>
        </label>
      </div>
    </div>
  )
}

function DraggableTemplateItems({
  employees,
  items,
  onAddSubItem,
  onAddSubSubItem,
  onDeleteItem,
  onRemoveSubItem,
  onRemoveSubSubItem,
  onReorderItems,
  onSetItemAssignee,
  onSetItemDueDate,
  onUpdateItem,
  onUpdateSubItem,
  onUpdateSubSubItem,
}: {
  employees: Employee[]
  items: ChecklistTemplateItem[]
  onAddSubItem: (itemId: string, title: string) => void
  onAddSubSubItem: (itemId: string, subItemId: string, title: string) => void
  onDeleteItem: (itemId: string) => void
  onRemoveSubItem: (itemId: string, subItemId: string) => void
  onRemoveSubSubItem: (itemId: string, subItemId: string, subSubItemId: string) => void
  onReorderItems: (orderedIds: string[]) => void
  onSetItemAssignee: (itemId: string, assigneeId: string) => void
  onSetItemDueDate: (itemId: string, dueDate: string) => void
  onUpdateItem: (itemId: string, label: string) => void
  onUpdateSubItem: (itemId: string, subItemId: string, title: string) => void
  onUpdateSubSubItem: (
    itemId: string,
    subItemId: string,
    subSubItemId: string,
    title: string,
  ) => void
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
        const subItems = item.subItems ?? []
        return (
          <div key={item.id} className="template-item">
            <div
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
                aria-label="Who does this step"
                className="compact-input"
                title="Who does this step — defaults to the checklist's assignee"
                onChange={(event) => onSetItemAssignee(item.id, event.target.value)}
                value={item.assigneeId ?? ''}
              >
                <option value="">Same as checklist</option>
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
            <div className="sub-item-list template-sub-item-list">
              {subItems.map((sub) => {
                const subSubItems = sub.subItems ?? []
                return (
                  <div key={sub.id} className="sub-item-group">
                    <div className="sub-item-row template-sub-item-row">
                      <span className="sub-item-bullet" aria-hidden="true" />
                      <input
                        aria-label="Sub-step"
                        className="input sub-item-edit-input"
                        onChange={(event) =>
                          onUpdateSubItem(item.id, sub.id, event.target.value)
                        }
                        value={sub.title}
                      />
                      <button
                        type="button"
                        aria-label="Delete sub-step"
                        className="item-delete-btn sub-item-delete"
                        title="Delete sub-step"
                        onClick={() => onRemoveSubItem(item.id, sub.id)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="sub-sub-item-list template-sub-item-list">
                      {subSubItems.map((subSub) => (
                        <div
                          key={subSub.id}
                          className="sub-item-row template-sub-item-row"
                        >
                          <span className="sub-item-bullet" aria-hidden="true" />
                          <input
                            aria-label="Sub-step"
                            className="input sub-item-edit-input"
                            onChange={(event) =>
                              onUpdateSubSubItem(
                                item.id,
                                sub.id,
                                subSub.id,
                                event.target.value,
                              )
                            }
                            value={subSub.title}
                          />
                          <button
                            type="button"
                            aria-label="Delete sub-step"
                            className="item-delete-btn sub-item-delete"
                            title="Delete sub-step"
                            onClick={() =>
                              onRemoveSubSubItem(item.id, sub.id, subSub.id)
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <SubItemAddRow
                        onAdd={(title) => onAddSubSubItem(item.id, sub.id, title)}
                      />
                    </div>
                  </div>
                )
              })}
              <SubItemAddRow onAdd={(title) => onAddSubItem(item.id, title)} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Wave 2 C5: standard (client-agnostic) templates                            */
/* -------------------------------------------------------------------------- */

type StandardTemplatesManagerProps = Omit<
  RepeatingTasksManagerProps,
  'templates' | 'onDuplicate' | 'onGenerateNow' | 'standardMode'
> & {
  /** Create a new standard (client-agnostic) blueprint template. */
  onCreateStandard: (
    payload: Omit<ChecklistTemplate, 'id' | 'clientId' | 'isStandard'>,
  ) => Promise<void>
  templates: ChecklistTemplate[]
}

/**
 * Owner-only library of reusable, client-agnostic templates. A standard
 * template never materializes a checklist on its own — it is a blueprint that
 * gets copied onto a client via "Apply to client".
 */
function StandardTemplatesManager(props: StandardTemplatesManagerProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const standardTemplates = props.templates.filter((template) => template.isStandard)

  const toggleOpen = (templateId: string) => {
    setOpenId((current) => (current === templateId ? null : templateId))
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Standard templates</h2>
          <p className="section-subtext">
            Reusable, client-agnostic blueprints. Apply one to a client to turn
            it into a real repeating task.
          </p>
        </div>
        <button
          type="button"
          className="primary-action"
          onClick={() => setCreating((value) => !value)}
        >
          <Plus size={14} />
          {creating ? 'Close' : 'New standard template'}
        </button>
      </div>

      {creating ? (
        <StandardTemplateForm
          employees={props.employees}
          onCancel={() => setCreating(false)}
          onCreate={async (payload) => {
            await props.onCreateStandard(payload)
            setCreating(false)
          }}
        />
      ) : null}

      <div className="repeating-task-list">
        {standardTemplates.length === 0 ? (
          <p className="empty-state">
            No standard templates yet. Create one to reuse across clients.
          </p>
        ) : null}
        {standardTemplates.map((template) => (
          <RepeatingTaskRow
            key={template.id}
            {...props}
            standardMode
            template={template}
            open={openId === template.id}
            onToggleOpen={() => toggleOpen(template.id)}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Create-a-standard-template form. Same shape as a repeating task minus the
 * client field — a standard template carries title, who, frequency and steps,
 * but is not bound to any client.
 */
function StandardTemplateForm({
  employees,
  onCancel,
  onCreate,
}: {
  employees: Employee[]
  onCancel: () => void
  onCreate: (
    payload: Omit<ChecklistTemplate, 'id' | 'clientId' | 'isStandard'>,
  ) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [assigneeId, setAssigneeId] = useState(employees[0]?.id ?? '')
  const [frequency, setFrequency] = useState<ChecklistFrequency>('monthly')
  // The template's steps as a nested outliner tree (item → sub → sub-sub).
  const [itemTree, setItemTree] = useState<ChecklistTemplateItem[]>([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return

    const trimmedTitle = title.trim()
    // The outliner can leave blank rows mid-edit — drop empties at every level.
    const items = pruneEmptyOutlineItems(itemTree)

    if (!trimmedTitle) {
      setError('Give the template a title.')
      return
    }
    if (!assigneeId) {
      setError('Pick who does this.')
      return
    }
    if (items.length === 0) {
      setError('Add at least one step.')
      return
    }

    setError('')
    const firstStage: TemplateStage = {
      id: makeId('stage'),
      name: 'Step 1',
      assigneeId,
      offsetDays: 0,
      viewerIds: [],
      editorIds: [],
      items,
    }

    setSubmitting(true)
    try {
      await onCreate({
        title: trimmedTitle,
        assigneeId,
        frequency,
        // Standard templates never materialize, so the next-due date is only a
        // default the client-bound copies inherit. End of month is sensible.
        nextDueDate: lastDayOfCurrentMonth(),
        active: true,
        viewerIds: [],
        editorIds: [],
        stages: [firstStage],
      })
      setTitle('')
      setItemTree([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create template.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="new-task-form" onSubmit={handleSubmit}>
      <div className="new-task-form-mode-pill">New standard template</div>

      <label className="new-task-field">
        <span>Title</span>
        <input
          className="input"
          placeholder="e.g. Monthly close checklist"
          onChange={(event) => setTitle(event.target.value)}
          value={title}
          autoFocus
        />
      </label>

      <div className="new-task-field-row">
        <label className="new-task-field">
          <span>Who does this</span>
          <select
            className="input"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>

        <label className="new-task-field">
          <span>How often</span>
          <select
            className="input"
            value={frequency}
            onChange={(event) =>
              setFrequency(event.target.value as ChecklistFrequency)
            }
          >
            {checklistFrequencies.map((option) => (
              <option key={option} value={option}>
                {getChecklistFrequencyLabel(option)}
              </option>
            ))}
          </select>
          <small className="new-task-hint">
            Copies applied to a client inherit this as their default cadence.
          </small>
        </label>
      </div>

      <div className="new-task-field">
        <span>Steps</span>
        <ChecklistOutliner
          items={itemTree}
          onChange={setItemTree}
          ariaLabel="Template steps"
          addPlaceholder="Add a step, then press Enter"
        />
      </div>

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
          {submitting ? 'Saving...' : 'Create standard template'}
        </button>
      </div>
    </form>
  )
}
