import { Check, Package as PackageIcon, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import { AddModal } from '../components/AddModal'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { FloatingAddButton } from '../components/FloatingAddButton'
import { highlightMatch } from '../lib/highlight'
import { ListSearch } from '../components/ListSearch'
import { CollapsibleSection } from '../components/SectionKit'
import {
  createPackageRequest,
  createSuggestedChecklistsRequest,
  deletePackageRequest,
  listPackagesRequest,
  suggestPackageChecklistsRequest,
  updatePackageRequest,
  type PackageChecklistProposal,
} from '../lib/api'
import { defaultPackageTemplateIds } from '../lib/packages'
import {
  ApiError,
  type ChecklistTemplate,
  type Client,
  type Package,
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
      <PackageLibrary
        plans={data.plans}
        templates={data.checklistTemplates}
        ownerMode={ownerMode}
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

/* -------------------------------------------------------------------------- */
/* Packages (featreq-f890f05b)                                                */
/* -------------------------------------------------------------------------- */
/*
 * A package is a named COMBINATION of plans the firm already has, plus the
 * blueprint checklists that come with them. It exists so setting up a new
 * client is one press instead of a plan at a time and a checklist at a time.
 *
 * It is NOT a price. Plans are labels on the invoice line — the amount is the
 * client's own monthly rate — so a package changes what the invoice SAYS and
 * what work appears, never what it charges.
 *
 * Packages are endpoint-managed, so this section fetches them itself rather
 * than reading them off the workspace snapshot.
 */

/**
 * "Suggest checklists" — the AI half (featreq-f890f05b).
 *
 * The rule Brittany asked for, in her words: the AI "always asks for approval
 * first, and only creates items after the user confirms". So this panel can
 * only ever do two things, in order: ASK the model (which writes nothing), and
 * then create exactly the proposals she ticked, behind a confirm. Boxes start
 * UNCHECKED — a suggestion she never read must not be one press from existing.
 *
 * A model failure is a sentence in the panel, never a crash and never a
 * half-written template.
 */
function SuggestChecklistsPanel({
  packageId,
  onCreated,
}: {
  packageId: string
  onCreated: (pkg: Package, createdIds: string[]) => void
}) {
  const [proposals, setProposals] = useState<PackageChecklistProposal[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const suggest = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const rows = await suggestPackageChecklistsRequest(packageId)
      setProposals(rows)
      setSelected(new Set())
      if (rows.length === 0) {
        setNote('The AI had nothing to add — this package looks well covered.')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The AI could not suggest checklists.')
    } finally {
      setBusy(false)
    }
  }

  const createSelected = async () => {
    const picked = (proposals ?? []).filter((_, index) => selected.has(index))
    if (picked.length === 0) return
    const confirmed = window.confirm(
      `Create ${picked.length} standard checklist${picked.length === 1 ? '' : 's'}?\n\n` +
        `${picked.map((proposal) => `• ${proposal.title}`).join('\n')}\n\n` +
        'They become blueprint checklists for the whole firm and are added to this package. ' +
        'Nothing is set up on any client until the package is applied.',
    )
    if (!confirmed) return
    setBusy(true)
    setError('')
    try {
      const result = await createSuggestedChecklistsRequest(packageId, picked)
      onCreated(
        result.package,
        result.templates.map((template) => template.id),
      )
      setProposals(null)
      setSelected(new Set())
      setNote(
        `Created ${result.templates.length} checklist${
          result.templates.length === 1 ? '' : 's'
        } and added ${result.templates.length === 1 ? 'it' : 'them'} to this package.`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create those checklists.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field suggest-checklists">
      <small className="field-helper">
        The AI only suggests. Nothing is created until you pick the ones you want and confirm.
      </small>
      <button className="secondary-action" disabled={busy} type="button" onClick={() => void suggest()}>
        {busy && proposals === null ? 'Thinking…' : 'Suggest checklists'}
      </button>
      {proposals && proposals.length > 0 ? (
        <>
          <ul className="suggest-checklists-list">
            {proposals.map((proposal, index) => (
              <li key={`${proposal.title}-${index}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(index)
                        else next.delete(index)
                        return next
                      })
                    }
                  />
                  <strong>{proposal.title}</strong>
                </label>
                <span className="checklist-meta-line">
                  {proposal.frequency} · {proposal.steps.length} step
                  {proposal.steps.length === 1 ? '' : 's'}
                </span>
                <span className="checklist-meta-line">{proposal.why}</span>
              </li>
            ))}
          </ul>
          <button
            className="primary-action"
            disabled={busy || selected.size === 0}
            type="button"
            onClick={() => void createSelected()}
          >
            Create selected ({selected.size})
          </button>
        </>
      ) : null}
      {note ? <p className="muted-text">{note}</p> : null}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  )
}

function PackageForm({
  plans,
  templateOptions,
  initial,
  packageId,
  submitLabel,
  onSubmit,
  onCancel,
  onSuggestionsCreated,
}: {
  plans: SubscriptionPlan[]
  templateOptions: Array<{ id: string; label: string }>
  initial?: Pick<Package, 'name' | 'description' | 'planIds' | 'templateIds'>
  /** Set only when editing a SAVED package — the AI half needs something to attach to. */
  packageId?: string
  submitLabel: string
  onSubmit: (values: {
    name: string
    description: string
    planIds: string[]
    templateIds: string[]
  }) => Promise<void>
  onCancel?: () => void
  onSuggestionsCreated?: (pkg: Package) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [planIds, setPlanIds] = useState<string[]>(initial?.planIds ?? [])
  const [templateIds, setTemplateIds] = useState<string[]>(initial?.templateIds ?? [])
  // Once the owner has touched the checklist picker, the plan picker stops
  // rewriting it underneath them — the default is a starting point, not a rule.
  const [templatesTouched, setTemplatesTouched] = useState(Boolean(initial))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give the package a name.')
      return
    }
    if (planIds.length < 2) {
      setError('A package combines plans — pick at least two.')
      return
    }
    setError('')
    setBusy(true)
    try {
      await onSubmit({ name: name.trim(), description, planIds, templateIds })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the package.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form-grid single package-form" onSubmit={(event) => void handleSubmit(event)}>
      <label className="field">
        <span>Package name</span>
        <input className="input" onChange={(event) => setName(event.target.value)} value={name} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          className="input"
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          value={description}
        />
      </label>
      <div className="field">
        <span>Plans in this package</span>
        <small className="field-helper">
          Two or more. Applying the package adds these to the client&rsquo;s selected services —
          their monthly rate is unchanged.
        </small>
        <ChipMultiSelect
          selectedIds={planIds}
          options={plans.map((plan) => ({ id: plan.id, label: plan.name }))}
          onChange={(nextIds) => {
            setPlanIds(nextIds)
            if (!templatesTouched) setTemplateIds(defaultPackageTemplateIds(nextIds, plans))
          }}
          addLabel="+ Add plan"
          emptyHelper="No plans picked yet."
        />
      </div>
      <div className="field">
        <span>Checklists ({templateIds.length})</span>
        <small className="field-helper">
          Starts as everything the chosen plans already bundle; add or remove from there. These
          are set up on the client when the package is applied.
        </small>
        <ChipMultiSelect
          selectedIds={templateIds}
          options={templateOptions}
          onChange={(nextIds) => {
            setTemplatesTouched(true)
            setTemplateIds(nextIds)
          }}
          addLabel="+ Add checklist"
          emptyHelper={
            templateOptions.length === 0
              ? 'Create a standard blueprint template first to bundle it into a package.'
              : 'No checklists in this package yet.'
          }
        />
      </div>
      {packageId ? (
        <SuggestChecklistsPanel
          packageId={packageId}
          onCreated={(pkg, createdIds) => {
            // The new blueprints are attached server-side; mirror that here so
            // a Save right afterwards does not write the set back without them.
            setTemplateIds((current) => [
              ...current,
              ...createdIds.filter((id) => !current.includes(id)),
            ])
            setTemplatesTouched(true)
            onSuggestionsCreated?.(pkg)
          }}
        />
      ) : null}
      {error ? <p className="field-error">{error}</p> : null}
      <div className="plan-edit-actions">
        <button className="primary-action" disabled={busy} type="submit">
          <Plus size={16} />
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button className="ghost-action" type="button" onClick={onCancel}>
            <X size={14} />
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}

export function PackageLibrary({
  plans,
  templates,
  ownerMode,
}: {
  plans: SubscriptionPlan[]
  templates: ChecklistTemplate[]
  ownerMode: boolean
}) {
  const [packages, setPackages] = useState<Package[]>([])
  const [loadError, setLoadError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listPackagesRequest()
      .then((rows) => {
        if (!cancelled) setPackages(rows)
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof ApiError ? err.message : 'Could not load packages.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  // The same blueprint-only rule a plan follows: a package assigns the firm's
  // client-agnostic standard templates, never a checklist bound to one client.
  const templateOptions = useMemo(
    () =>
      templates
        .filter((template) => template.isStandard)
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((template) => ({ id: template.id, label: templatePickerLabel(template) })),
    [templates],
  )
  const templateTitle = (id: string) =>
    templates.find((template) => template.id === id)?.title ?? 'A deleted checklist'
  const planName = (id: string) => plans.find((plan) => plan.id === id)?.name ?? 'A deleted plan'

  if (!ownerMode) return null

  const handleDelete = async (pkg: Package) => {
    const confirmed = window.confirm(
      `Delete the "${pkg.name}" package?\n\nClients it was already applied to keep their plans and their checklists — deleting a package only removes the shortcut.`,
    )
    if (!confirmed) return
    setPendingId(pkg.id)
    try {
      await deletePackageRequest(pkg.id)
      setPackages((rows) => rows.filter((row) => row.id !== pkg.id))
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not delete the package.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <CollapsibleSection
      kicker="Combine plans"
      title="Packages"
      headerAction={<FloatingAddButton label="Add package" onClick={() => setAddOpen(true)} />}
    >
      <p className="muted-text">
        A package is a set of plans you apply together. Applying one adds its plans to the client
        and sets up its checklists for them. Nothing on the invoice changes — plans are labels,
        and the monthly rate stays as it is.
      </p>
      {loadError ? <p className="field-error">{loadError}</p> : null}
      {packages.length === 0 && !loadError ? (
        <p className="muted-text">No packages yet.</p>
      ) : null}
      <div className="plan-list">
        {packages.map((pkg) => {
          if (editingId === pkg.id) {
            return (
              <article className="plan-row" key={pkg.id}>
                <PackageForm
                  plans={plans}
                  templateOptions={templateOptions}
                  initial={pkg}
                  packageId={pkg.id}
                  submitLabel="Save package"
                  onCancel={() => setEditingId(null)}
                  onSuggestionsCreated={(saved) =>
                    setPackages((rows) => rows.map((row) => (row.id === saved.id ? saved : row)))
                  }
                  onSubmit={async (values) => {
                    const saved = await updatePackageRequest(pkg.id, values)
                    setPackages((rows) => rows.map((row) => (row.id === saved.id ? saved : row)))
                    setEditingId(null)
                  }}
                />
              </article>
            )
          }
          return (
            <article className="plan-row" key={pkg.id}>
              <div>
                <strong>
                  <PackageIcon size={14} /> {pkg.name}
                </strong>
                {pkg.description ? <span>{pkg.description}</span> : null}
                <span className="checklist-meta-line">
                  Plans: {pkg.planIds.map(planName).join(', ')}
                </span>
                <span className="checklist-meta-line">
                  {pkg.templateIds.length} checklist{pkg.templateIds.length === 1 ? '' : 's'}
                  {pkg.templateIds.length > 0
                    ? `: ${pkg.templateIds.map(templateTitle).join(', ')}`
                    : ''}
                </span>
              </div>
              <div className="plan-row-actions">
                <button
                  className="item-delete-btn"
                  type="button"
                  aria-label={`Edit ${pkg.name}`}
                  title="Edit this package"
                  onClick={() => setEditingId(pkg.id)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="item-delete-btn"
                  type="button"
                  aria-label={`Delete ${pkg.name}`}
                  title="Delete this package"
                  disabled={pendingId === pkg.id}
                  onClick={() => void handleDelete(pkg)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          )
        })}
      </div>
      {addOpen ? (
        <AddModal title="Create package" onClose={() => setAddOpen(false)}>
          <PackageForm
            plans={plans}
            templateOptions={templateOptions}
            submitLabel="Create package"
            onSubmit={async (values) => {
              const created = await createPackageRequest(values)
              setPackages((rows) => [...rows, created])
              setAddOpen(false)
            }}
          />
        </AddModal>
      ) : null}
    </CollapsibleSection>
  )
}
