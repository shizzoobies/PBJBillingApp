import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
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
  return (
    <section className="content-grid two-column" id="plans">
      <PlanBuilder onCreate={addPlan} />
      <PlanLibrary
        plans={data.plans}
        clients={data.clients}
        templates={data.checklistTemplates}
        ownerMode={ownerMode}
        onUpdate={updatePlan}
        onDelete={deletePlan}
      />
    </section>
  )
}

function PlanBuilder({
  onCreate,
}: {
  onCreate: (plan: Omit<SubscriptionPlan, 'id'>) => void
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

  return (
    <CollapsibleSection kicker="Subscription setup" title="Create plan">
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
}: {
  plans: SubscriptionPlan[]
  clients: Client[]
  templates: ChecklistTemplate[]
  ownerMode: boolean
  onUpdate: (planId: string, patch: Partial<SubscriptionPlan>) => void
  onDelete: (planId: string) => Promise<void>
}) {
  // Templates the owner can bundle into a plan. Standard (client-agnostic)
  // blueprints come first since they're the intended building blocks, then
  // every other template so existing client checklists can be reused too.
  const templateOptions = templates
    .slice()
    .sort((a, b) => {
      if (Boolean(a.isStandard) !== Boolean(b.isStandard)) {
        return a.isStandard ? -1 : 1
      }
      return a.title.localeCompare(b.title)
    })
    .map((template) => ({ id: template.id, label: templatePickerLabel(template) }))
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
    <CollapsibleSection kicker="Available templates" title="Plans" lockable>
      <div className="plan-list">
        {plans.map((plan) => {
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
                    <strong>{plan.name}</strong>
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
  const chosen = planTemplates(plan, templates)

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
        selectedIds={plan.templateIds ?? []}
        options={templateOptions}
        onChange={(nextIds) => onUpdate(plan.id, { templateIds: nextIds })}
        addLabel="+ Add checklist template"
        emptyHelper={
          templateOptions.length === 0
            ? 'Create a recurring checklist first to bundle it into a plan.'
            : 'No checklist templates bundled with this plan yet.'
        }
      />
    </div>
  )
}
