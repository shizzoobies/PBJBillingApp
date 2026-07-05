import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import { AddModal } from '../components/AddModal'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { FloatingAddButton } from '../components/FloatingAddButton'
import { highlightMatch } from '../lib/highlight'
import { ListSearch } from '../components/ListSearch'
import { CollapsibleSection } from '../components/SectionKit'
import {
  ApiError,
  type ChecklistTemplate,
  type Client,
  type SubscriptionPlan,
} from '../lib/types'
import { planTemplates, templatePickerLabel } from '../lib/utils'

export function PlansPage() {
  const { data, addPlan, updatePlan, deletePlan, ownerMode } = useAppContext()
  const [addOpen, setAddOpen] = useState(false)
  return (
    <section className="panel" id="plans">
      <PlanLibrary
        plans={data.plans}
        clients={data.clients}
        templates={data.checklistTemplates}
        ownerMode={ownerMode}
        onUpdate={updatePlan}
        onDelete={deletePlan}
        onAddClick={() => setAddOpen(true)}
      />
      {addOpen ? (
        <AddModal title="Create plan" onClose={() => setAddOpen(false)}>
          <PlanBuilder
            variant="modal"
            onCreate={(values) => {
              addPlan(values)
              setAddOpen(false)
            }}
          />
        </AddModal>
      ) : null}
    </section>
  )
}

function PlanBuilder({
  onCreate,
  variant = 'panel',
}: {
  onCreate: (plan: Omit<SubscriptionPlan, 'id'>) => void
  variant?: 'panel' | 'modal'
}) {
  const [name, setName] = useState('Controller Support')
  const [notes, setNotes] = useState('Monthly reporting, close review, and client advisory support.')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name) {
      return
    }

    onCreate({ name, notes })
    setName('')
    setNotes('')
  }

  const form = (
    <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Plan / service name</span>
          <input
            className="input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea
            className="input"
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            value={notes}
          />
        </label>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add plan
        </button>
      </form>
  )

  if (variant === 'modal') {
    return form
  }

  return (
    <CollapsibleSection kicker="Subscription setup" title="Create plan">
      {form}
    </CollapsibleSection>
  )
}

function PlanLibrary({
  plans,
  clients,
  templates,
  ownerMode,
  onUpdate,
  onDelete,
  onAddClick,
}: {
  plans: SubscriptionPlan[]
  clients: Client[]
  templates: ChecklistTemplate[]
  ownerMode: boolean
  onUpdate: (planId: string, patch: Partial<SubscriptionPlan>) => void
  onDelete: (planId: string) => Promise<void>
  onAddClick: () => void
}) {
  // Templates the owner can bundle into a plan. A plan pulls ONLY from the
  // firm's standard (client-agnostic) BLUEPRINTS — never a client-bound
  // checklist — so a plan stays a reusable recipe, not tied to one client.
  const templateOptions = templates
    .filter((template) => template.isStandard)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((template) => ({ id: template.id, label: templatePickerLabel(template) }))
  const [query, setQuery] = useState('')
  const filteredPlans = plans.filter((plan) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return plan.name.toLowerCase().includes(q) || (plan.notes ?? '').toLowerCase().includes(q)
  })
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editNotes, setEditNotes] = useState('')

  const startEdit = (plan: SubscriptionPlan) => {
    setEditingId(plan.id)
    setEditName(plan.name)
    setEditNotes(plan.notes)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditName('')
    setEditNotes('')
  }

  const saveEdit = (plan: SubscriptionPlan) => {
    const name = editName.trim()
    if (!name) return
    onUpdate(plan.id, { name, notes: editNotes })
    cancelEdit()
  }

  const handleDelete = async (plan: SubscriptionPlan) => {
    // Tell the owner exactly which clients will be unlinked so they go in
    // eyes-open. Unlinked clients keep their billing history but flip to
    // hourly going forward (planId becomes null).
    const attached = clients.filter((client) => (client.planIds ?? []).includes(plan.id))
    const attachedSummary =
      attached.length === 0
        ? 'No clients are currently on this plan/service.'
        : attached.length === 1
          ? `1 client has this plan/service: ${attached[0].name}. It will be removed from their selected services (their billing is unaffected).`
          : `${attached.length} clients have this plan/service: ${attached
              .map((client) => client.name)
              .join(', ')}. It will be removed from their selected services (their billing is unaffected).`

    const confirmed = window.confirm(
      `Delete "${plan.name}"?\n\n${attachedSummary}\n\nThis can't be undone.`,
    )
    if (!confirmed) return
    setPendingId(plan.id)
    try {
      await onDelete(plan.id)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Could not delete the plan.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <CollapsibleSection
      kicker="Available templates"
      title="Plans"
      lockable
      stickyHeader
      headerAction={
        ownerMode ? <FloatingAddButton label="Add plan" onClick={onAddClick} /> : undefined
      }
    >
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder="Search plans…"
        resultCount={filteredPlans.length}
        total={plans.length}
      />
      {query.trim() && filteredPlans.length === 0 ? (
        <p className="list-search-empty">
          No plans match &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : null}
      <div className="plan-list">
        {filteredPlans.map((plan) => {
          const attachedCount = clients.filter((client) =>
            (client.planIds ?? []).includes(plan.id),
          ).length
          const isEditing = editingId === plan.id
          return (
            <article className="plan-row" key={plan.id}>
              {isEditing ? (
                <div className="plan-edit-form">
                  <label className="field">
                    <span>Plan / service name</span>
                    <input
                      className="input"
                      onChange={(event) => setEditName(event.target.value)}
                      value={editName}
                    />
                  </label>
                  <label className="field">
                    <span>Notes</span>
                    <textarea
                      className="input"
                      onChange={(event) => setEditNotes(event.target.value)}
                      rows={3}
                      value={editNotes}
                    />
                  </label>
                  <div className="plan-edit-actions">
                    <button
                      className="primary-action"
                      type="button"
                      onClick={() => saveEdit(plan)}
                    >
                      <Check size={14} />
                      Save
                    </button>
                    <button className="ghost-action" type="button" onClick={cancelEdit}>
                      <X size={14} />
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <strong>{highlightMatch(plan.name, query)}</strong>
                    <span>{plan.notes}</span>
                    {attachedCount > 0 ? (
                      <span className="checklist-meta-line">
                        {attachedCount} client{attachedCount === 1 ? '' : 's'} on this plan
                      </span>
                    ) : null}
                    <PlanTemplatesField
                      plan={plan}
                      templates={templates}
                      templateOptions={templateOptions}
                      ownerMode={ownerMode}
                      onUpdate={onUpdate}
                    />
                  </div>
                  {ownerMode ? (
                    <div className="plan-row-actions">
                      <button
                        className="item-delete-btn"
                        type="button"
                        aria-label={`Edit ${plan.name}`}
                        title="Edit this plan"
                        onClick={() => startEdit(plan)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        className="item-delete-btn"
                        type="button"
                        aria-label={`Delete ${plan.name}`}
                        title="Delete this plan (any attached clients will be unlinked)"
                        disabled={pendingId === plan.id}
                        onClick={() => void handleDelete(plan)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </article>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

// The checklist templates bundled with a plan. Owners edit the set via a
// ChipMultiSelect; non-owners (and the read view) see a plain summary. Because
// each template carries a board category, linking templates here transitively
// connects the plan → checklists → board.
function PlanTemplatesField({
  plan,
  templates,
  templateOptions,
  ownerMode,
  onUpdate,
}: {
  plan: SubscriptionPlan
  templates: ChecklistTemplate[]
  templateOptions: Array<{ id: string; label: string }>
  ownerMode: boolean
  onUpdate: (planId: string, patch: Partial<SubscriptionPlan>) => void
}) {
  // Only BLUEPRINT (standard) templates count as a plan's checklists — filter
  // out any stale client-bound ids so nothing from another source shows here.
  // Passing the blueprint-only id set as the selection also means an owner's
  // next edit persists a clean, blueprint-only templateIds.
  const chosen = planTemplates(plan, templates).filter((template) => template.isStandard)
  const chosenBlueprintIds = chosen.map((template) => template.id)

  if (!ownerMode) {
    if (chosen.length === 0) return null
    return (
      <span className="checklist-meta-line">
        Plan checklists: {chosen.map((template) => template.title).join(', ')}
      </span>
    )
  }

  return (
    <div className="plan-templates-field">
      <span className="checklist-meta-line">Plan checklists</span>
      <ChipMultiSelect
        selectedIds={chosenBlueprintIds}
        options={templateOptions}
        onChange={(nextIds) => onUpdate(plan.id, { templateIds: nextIds })}
        addLabel="+ Add checklist template"
        emptyHelper={
          templateOptions.length === 0
            ? 'Create a standard blueprint template first to bundle it into a plan.'
            : 'No blueprint checklists bundled with this plan yet.'
        }
      />
    </div>
  )
}
