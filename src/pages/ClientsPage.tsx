import { ChevronRight, Copy, ListChecks, Plus, ShieldCheck, StickyNote, Timer } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { AddModal } from '../components/AddModal'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { ClientChecklistModal } from '../components/ClientChecklistModal'
import { ClientTimeModal } from '../components/ClientTimeModal'
import { ClientNotesPanel } from '../components/ClientNotesPanel'
import { FloatingAddButton } from '../components/FloatingAddButton'
import { highlightMatch } from '../lib/highlight'
import { ListSearch } from '../components/ListSearch'
import type {
  BillingMode,
  ChecklistTemplate,
  Client,
  ClientDefaults,
  Contact,
  Employee,
  LifecycleStage,
  SubscriptionPlan,
} from '../lib/types'
import {
  currency,
  deriveChecklistStatus,
  employeeName,
  getAssignedEmployeeIds,
  localDateOnly,
  MONTH_NAMES,
} from '../lib/utils'

const BILLING_LABELS: Record<BillingMode, string> = {
  hourly: 'Hourly',
  subscription: 'Monthly',
  annual: 'Annual',
}

// Lifecycle stages in display order, plus their human label. An absent
// `lifecycleStage` is treated as 'active' everywhere (see `lifecycleOf`).
const LIFECYCLE_STAGES: readonly LifecycleStage[] = ['proposal', 'onboarding', 'active']
const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  proposal: 'Proposal',
  onboarding: 'Onboarding',
  active: 'Active',
}

/** The effective lifecycle stage of a client — absent defaults to 'active'. */
function lifecycleOf(client: Client): LifecycleStage {
  return client.lifecycleStage ?? 'active'
}

/** Small color-coded pill showing a client's lifecycle stage. */
function StageBadge({ stage }: { stage: LifecycleStage }) {
  return (
    <span className={`lifecycle-badge lifecycle-badge-${stage}`}>{LIFECYCLE_LABELS[stage]}</span>
  )
}

// Segment control over the stage list: Active · Onboarding · Proposal · All.
type StageSegment = LifecycleStage | 'all'
const STAGE_SEGMENTS: readonly StageSegment[] = ['active', 'onboarding', 'proposal', 'all']
const SEGMENT_LABELS: Record<StageSegment, string> = {
  active: 'Active',
  onboarding: 'Onboarding',
  proposal: 'Proposal',
  all: 'All',
}

function matchesClientQuery(client: Client, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const fields = [
    client.name,
    client.contact ?? '',
    (client as unknown as { contactName?: string }).contactName ?? '',
    (client as unknown as { email?: string }).email ?? '',
    BILLING_LABELS[client.billingMode] ?? '',
  ]
  return fields.some((f) => f.toLowerCase().includes(q))
}

export function ClientsPage() {
  const { ownerMode, visibleClients, data, updateClientPlan, updateClient, addClient, startOnboarding } =
    useAppContext()
  const [query, setQuery] = useState('')
  // Owner-only stage segment. Default to 'active' so the normal list isn't
  // cluttered with prospects/onboarding.
  const [stageSegment, setStageSegment] = useState<StageSegment>('active')
  // Owner-only "+" add flow: the add-client modal, the just-created client
  // awaiting the "Open their checklist now?" prompt, and the client whose
  // checklist modal is open (jumped to from that prompt).
  const [addOpen, setAddOpen] = useState(false)
  const [postAddClient, setPostAddClient] = useState<Client | null>(null)
  const [modalClient, setModalClient] = useState<Client | null>(null)

  const handleCreateClient = (values: Omit<Client, 'id'>) => {
    const created = addClient(values)
    setAddOpen(false)
    setPostAddClient(created)
  }

  const searchedClients = visibleClients.filter((c) => matchesClientQuery(c, query))
  // Per-segment counts (over the search-filtered list, so counts reflect the
  // current query). Staff view ignores segments entirely.
  const segmentCounts: Record<StageSegment, number> = {
    active: searchedClients.filter((c) => lifecycleOf(c) === 'active').length,
    onboarding: searchedClients.filter((c) => lifecycleOf(c) === 'onboarding').length,
    proposal: searchedClients.filter((c) => lifecycleOf(c) === 'proposal').length,
    all: searchedClients.length,
  }
  // Owner list also respects the stage segment; staff list is search-only.
  const filteredClients = ownerMode
    ? searchedClients.filter((c) => stageSegment === 'all' || lifecycleOf(c) === stageSegment)
    : searchedClients

  // Client ids that have at least one ACTIVE checklist — not soft-deleted and
  // not fully Done. Drives the green tint on each row's Checklist button so a
  // client with live work-in-progress stands out at a glance.
  const todayDateOnly = localDateOnly()
  const clientsWithActiveChecklists = new Set(
    (data.checklists ?? [])
      .filter(
        (checklist) =>
          !checklist.deletedAt &&
          deriveChecklistStatus(checklist, todayDateOnly) !== 'Done',
      )
      .map((checklist) => checklist.clientId),
  )

  if (!ownerMode) {
    return (
      <section className="content-grid two-column" id="clients">
        <div className="panel">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Assigned client work</p>
              <h2>Clients</h2>
            </div>
          </div>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder="Search clients…"
            resultCount={filteredClients.length}
            total={visibleClients.length}
          />
          {query.trim() && filteredClients.length === 0 ? (
            <p className="list-search-empty">No clients match &ldquo;{query.trim()}&rdquo;.</p>
          ) : null}
          <ClientTable
            clients={filteredClients}
            clientsWithActiveChecklists={clientsWithActiveChecklists}
            employees={data.employees}
            onUpdatePlan={updateClientPlan}
            ownerMode={ownerMode}
            plans={data.plans}
            query={query}
          />
        </div>
        <VisibilityPanel visibleClients={visibleClients} />
      </section>
    )
  }

  // Owner view: single-column list panel. The add form lives behind the
  // floating "+" button → modal, and a just-created client offers a jump
  // straight into its checklist.
  return (
    <section className="panel" id="clients">
      <div className="list-sticky-head">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Owner client controls</p>
            <h2>Clients</h2>
          </div>
          <FloatingAddButton label="Add client" onClick={() => setAddOpen(true)} />
        </div>
        <ListSearch
          value={query}
          onChange={setQuery}
          placeholder="Search clients…"
          resultCount={filteredClients.length}
          total={visibleClients.length}
        />
        {query.trim() && searchedClients.length === 0 ? (
          <p className="list-search-empty">No clients match &ldquo;{query.trim()}&rdquo;.</p>
        ) : null}
        <div className="stage-segment" role="tablist" aria-label="Filter clients by stage">
          {STAGE_SEGMENTS.map((segment) => (
            <button
              key={segment}
              type="button"
              role="tab"
              aria-selected={stageSegment === segment}
              className={
                stageSegment === segment
                  ? 'stage-segment-tab is-active'
                  : 'stage-segment-tab'
              }
              onClick={() => setStageSegment(segment)}
            >
              {SEGMENT_LABELS[segment]}
              <span className="stage-segment-count">{segmentCounts[segment]}</span>
            </button>
          ))}
        </div>
      </div>
      <ClientTable
        clients={filteredClients}
        clientsWithActiveChecklists={clientsWithActiveChecklists}
        employees={data.employees}
        onUpdatePlan={updateClientPlan}
        onUpdateClient={updateClient}
        onStartOnboarding={startOnboarding}
        ownerMode={ownerMode}
        plans={data.plans}
        query={query}
      />

      {addOpen ? (
        <AddModal title="Add client" onClose={() => setAddOpen(false)}>
          <ClientBuilder
            variant="modal"
            // Owners do client work too, so they're assignable here (visibility
            // scoping is moot — owners always see every client).
            employees={data.employees}
            onCreate={handleCreateClient}
            plans={data.plans}
            contacts={data.contacts}
            defaults={data.firmSettings?.clientDefaults}
          />
        </AddModal>
      ) : null}

      {postAddClient ? (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPostAddClient(null)
          }}
        >
          <div
            className="modal-panel add-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${postAddClient.name} added`}
          >
            <div className="modal-body">
              <h2 className="modal-title">{postAddClient.name} added</h2>
              <p className="modal-intro">Open their checklist now?</p>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => setPostAddClient(null)}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => {
                    setModalClient(postAddClient)
                    setPostAddClient(null)
                  }}
                >
                  <ListChecks size={16} />
                  Open checklist
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {modalClient ? (
        <ClientChecklistModal client={modalClient} onClose={() => setModalClient(null)} />
      ) : null}
    </section>
  )
}

function VisibilityPanel({ visibleClients }: { visibleClients: Client[] }) {
  return (
    <section className="panel visibility-panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Access boundary</p>
          <h2>Visible work</h2>
        </div>
      </div>
      <div className="visibility-copy">
        <ShieldCheck size={34} />
        <p>
          This employee view is scoped to assigned checklists, clients, and time entries.
          Owner-only invoices, subscription controls, and other employees&apos; hours are hidden
          from this role.
        </p>
      </div>
      <div className="client-chip-list">
        {visibleClients.map((client) => (
          <span key={client.id}>{client.name}</span>
        ))}
      </div>
    </section>
  )
}

function ClientBuilder({
  employees,
  onCreate,
  plans,
  contacts,
  defaults,
  variant = 'panel',
}: {
  employees: Employee[]
  onCreate: (client: Omit<Client, 'id'>) => void
  plans: SubscriptionPlan[]
  contacts: Contact[]
  defaults?: ClientDefaults
  variant?: 'panel' | 'modal'
}) {
  // Owner-configured house defaults (Settings → "Default values for new
  // clients"). Fall back to the historical hard-coded values when unset.
  const defaultHourly = defaults?.hourlyRate != null ? String(defaults.hourlyRate) : '125'
  const defaultMonthly =
    defaults?.monthlyRate != null && defaults.monthlyRate > 0 ? String(defaults.monthlyRate) : ''
  const defaultBillingMode: BillingMode = defaults?.billingMode ?? 'hourly'

  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [hourlyRate, setHourlyRate] = useState(defaultHourly)
  const [monthlyRate, setMonthlyRate] = useState(defaultMonthly)
  const [annualRate, setAnnualRate] = useState('')
  const [annualBillingMonth, setAnnualBillingMonth] = useState('1')
  const [estimatedBookkeeperHours, setEstimatedBookkeeperHours] = useState('')
  const [estimatedAccountantHours, setEstimatedAccountantHours] = useState('')
  const [estimatedCfoHours, setEstimatedCfoHours] = useState('')
  const [billingMode, setBillingMode] = useState<BillingMode>(defaultBillingMode)
  // Initial lifecycle stage — most clients are added Active; pick Proposal to
  // start them as a prospect.
  const [initialStage, setInitialStage] = useState<LifecycleStage>('active')
  const [planIds, setPlanIds] = useState<string[]>([])
  const [contactIds, setContactIds] = useState<string[]>([])
  const [assignedEmployeeIds, setAssignedEmployeeIds] = useState<string[]>(
    employees[0] ? [employees[0].id] : [],
  )

  const toggleEmployee = (employeeId: string) => {
    setAssignedEmployeeIds((current) =>
      current.includes(employeeId)
        ? current.filter((id) => id !== employeeId)
        : [...current, employeeId],
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Hourly billing is now per-EMPLOYEE (bill rate set on the Team page), so
    // there's no per-client hourly rate to enter. We still persist a non-zero
    // `hourlyRate` (the firm default) for back-compat with the stored column.
    const rate = Number(hourlyRate)
    const hourlyForStore = Number.isFinite(rate) && rate > 0 ? rate : 0
    if (!name || !contact || assignedEmployeeIds.length === 0) {
      return
    }

    const parsedMonthly = Number(monthlyRate)
    const parsedAnnual = Number(annualRate)
    const parsedBookkeeper = Number(estimatedBookkeeperHours)
    const parsedAccountant = Number(estimatedAccountantHours)
    const parsedCfo = Number(estimatedCfoHours)
    onCreate({
      name,
      contact,
      billingMode,
      hourlyRate: hourlyForStore,
      planIds,
      contactIds,
      ...(billingMode === 'subscription' && monthlyRate.trim() && !Number.isNaN(parsedMonthly)
        ? { monthlyRate: parsedMonthly }
        : {}),
      ...(billingMode === 'annual' && annualRate.trim() && !Number.isNaN(parsedAnnual)
        ? { annualRate: parsedAnnual, annualBillingMonth: Number(annualBillingMonth) }
        : {}),
      ...(estimatedBookkeeperHours.trim() && !Number.isNaN(parsedBookkeeper)
        ? { estimatedBookkeeperHours: parsedBookkeeper }
        : {}),
      ...(estimatedAccountantHours.trim() && !Number.isNaN(parsedAccountant)
        ? { estimatedAccountantHours: parsedAccountant }
        : {}),
      ...(estimatedCfoHours.trim() && !Number.isNaN(parsedCfo)
        ? { estimatedCfoHours: parsedCfo }
        : {}),
      // Silently seed the firm's default invoice prefs / terms onto the new
      // client (these aren't fields on the Add form — they live on the client
      // detail page — but a new client should still inherit the house default).
      ...(defaults?.paymentTerms ? { paymentTerms: defaults.paymentTerms } : {}),
      ...(defaults?.footerNote ? { footerNote: defaults.footerNote } : {}),
      ...(defaults?.invoiceShowTimeBreakdown !== undefined
        ? { invoiceShowTimeBreakdown: defaults.invoiceShowTimeBreakdown }
        : {}),
      ...(defaults?.invoiceHideInternalHours !== undefined
        ? { invoiceHideInternalHours: defaults.invoiceHideInternalHours }
        : {}),
      ...(defaults?.invoiceGroupByCategory !== undefined
        ? { invoiceGroupByCategory: defaults.invoiceGroupByCategory }
        : {}),
      // Only persist a non-default stage so most clients stay simply 'active'
      // (absent ⇒ active downstream).
      ...(initialStage !== 'active' ? { lifecycleStage: initialStage } : {}),
      assignedEmployeeIds,
    })
    setName('')
    setContact('')
    setInitialStage('active')
    setHourlyRate(defaultHourly)
    setMonthlyRate(defaultMonthly)
    setAnnualRate('')
    setAnnualBillingMonth('1')
    setEstimatedBookkeeperHours('')
    setEstimatedAccountantHours('')
    setEstimatedCfoHours('')
    setBillingMode(defaultBillingMode)
    setPlanIds([])
    setContactIds([])
  }

  const totalEstimatedHours =
    (Number(estimatedBookkeeperHours) || 0) +
    (Number(estimatedAccountantHours) || 0) +
    (Number(estimatedCfoHours) || 0)

  const form = (
    <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Client name</span>
          <input
            className="input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="field">
          <span>Primary contact</span>
          <input
            className="input"
            onChange={(event) => setContact(event.target.value)}
            value={contact}
          />
        </label>
        <label className="field">
          <span>Billing type</span>
          <select
            className="input"
            onChange={(event) => setBillingMode(event.target.value as BillingMode)}
            value={billingMode}
          >
            <option value="hourly">Hourly</option>
            <option value="subscription">Monthly</option>
            <option value="annual">Annual</option>
          </select>
        </label>
        <label className="field">
          <span>Initial stage</span>
          <select
            className="input"
            onChange={(event) => setInitialStage(event.target.value as LifecycleStage)}
            value={initialStage}
          >
            {LIFECYCLE_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {LIFECYCLE_LABELS[stage]}
              </option>
            ))}
          </select>
        </label>
        {billingMode === 'hourly' ? (
          <p className="muted-text" style={{ gridColumn: '1 / -1', margin: 0 }}>
            Hourly clients are billed off each team member's bill rate (set on the
            Team page) — no per-client rate to enter.
          </p>
        ) : billingMode === 'annual' ? (
          <>
            <label className="field">
              <span>Annual fee</span>
              <input
                className="input"
                min="0"
                onChange={(event) => setAnnualRate(event.target.value)}
                step="0.01"
                type="number"
                value={annualRate}
              />
            </label>
            <label className="field">
              <span>Billing month</span>
              <select
                className="input"
                onChange={(event) => setAnnualBillingMonth(event.target.value)}
                value={annualBillingMonth}
              >
                {MONTH_NAMES.slice(1).map((name, index) => (
                  <option key={name} value={String(index + 1)}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="field">
            <span>Monthly rate</span>
            <input
              className="input"
              min="0"
              onChange={(event) => setMonthlyRate(event.target.value)}
              step="0.01"
              type="number"
              value={monthlyRate}
            />
          </label>
        )}
        <div className="field">
          <span>Estimated monthly hours</span>
          <div className="form-grid two-col">
            <label className="field">
              <span>Bookkeeper</span>
              <input
                className="input"
                min="0"
                onChange={(event) => setEstimatedBookkeeperHours(event.target.value)}
                step="any"
                type="number"
                value={estimatedBookkeeperHours}
              />
            </label>
            <label className="field">
              <span>Accountant</span>
              <input
                className="input"
                min="0"
                onChange={(event) => setEstimatedAccountantHours(event.target.value)}
                step="any"
                type="number"
                value={estimatedAccountantHours}
              />
            </label>
            <label className="field">
              <span>CFO</span>
              <input
                className="input"
                min="0"
                onChange={(event) => setEstimatedCfoHours(event.target.value)}
                step="any"
                type="number"
                value={estimatedCfoHours}
              />
            </label>
          </div>
          <small className="field-helper">
            Total: {totalEstimatedHours} hrs/mo · For planning only — does not affect invoices.
          </small>
        </div>
        <div className="field">
          <span>Plans / services</span>
          <ChipMultiSelect
            selectedIds={planIds}
            options={plans.map((plan) => ({ id: plan.id, label: plan.name }))}
            onChange={setPlanIds}
            addLabel="+ Add plan / service"
            emptyHelper="No plans/services selected yet."
          />
        </div>
        <div className="field">
          <span>Contacts</span>
          <ChipMultiSelect
            selectedIds={contactIds}
            options={contacts.map((entry) => ({ id: entry.id, label: entry.name }))}
            onChange={setContactIds}
            addLabel="+ Add contact"
            emptyHelper="No contacts selected yet."
          />
        </div>
        <fieldset className="assignment-field">
          <legend>Assigned employees</legend>
          {employees.map((employee) => (
            <label className="check-row" key={employee.id}>
              <input
                checked={assignedEmployeeIds.includes(employee.id)}
                onChange={() => toggleEmployee(employee.id)}
                type="checkbox"
              />
              <span>{employee.name}</span>
            </label>
          ))}
        </fieldset>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add client
        </button>
      </form>
  )

  if (variant === 'modal') {
    return form
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner setup</p>
          <h2>Add client</h2>
        </div>
      </div>
      {form}
    </section>
  )
}

/**
 * Owner-only picker inside the client-row "Template" modal: choose a standard
 * template (blueprint) or copy a recurring template from another client onto
 * this one. Reuses the same apply-to-client endpoint as the Checklists page —
 * this surface exists so the action is findable from client management too.
 */
function ApplyTemplateForm({
  client,
  clients,
  templates,
  onApply,
  onDone,
}: {
  client: Client
  clients: Client[]
  templates: ChecklistTemplate[]
  onApply: (templateId: string) => Promise<void>
  onDone: () => void
}) {
  const standardTemplates = templates
    .filter((template) => template.isStandard)
    .sort((a, b) => a.title.localeCompare(b.title))
  // A client's own templates are excluded — copying one onto the same client
  // is the Checklists page's "Duplicate", not an apply.
  const otherClientTemplates = templates
    .filter((template) => !template.isStandard && template.clientId !== client.id)
    .sort((a, b) => a.title.localeCompare(b.title))
  const clientName = (id: string) => clients.find((item) => item.id === id)?.name ?? 'Unknown client'

  const [templateId, setTemplateId] = useState(
    standardTemplates[0]?.id ?? otherClientTemplates[0]?.id ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (standardTemplates.length === 0 && otherClientTemplates.length === 0) {
    return (
      <p className="muted-text">
        No templates exist yet. Create a standard template (or a recurring checklist on any
        client) from the Checklists page first.
      </p>
    )
  }

  const handleApply = async () => {
    if (!templateId || busy) return
    setBusy(true)
    setError('')
    try {
      await onApply(templateId)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the template.')
      setBusy(false)
    }
  }

  return (
    <>
      <label className="field">
        <span>Template</span>
        <select
          className="input"
          value={templateId}
          onChange={(event) => setTemplateId(event.target.value)}
        >
          {standardTemplates.length > 0 ? (
            <optgroup label="Standard templates">
              {standardTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.title}
                </option>
              ))}
            </optgroup>
          ) : null}
          {otherClientTemplates.length > 0 ? (
            <optgroup label="Copy from another client">
              {otherClientTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.title} — {clientName(template.clientId)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <p className="muted-text">
        This creates a new recurring checklist on {client.name} with the template's stages and
        steps. You can adjust its schedule and assignees afterwards on the Checklists page.
      </p>
      {error ? <p className="auth-error">{error}</p> : null}
      <div className="button-row">
        <button
          type="button"
          className="primary-action"
          disabled={busy || !templateId}
          onClick={handleApply}
        >
          {busy ? 'Applying…' : 'Apply template'}
        </button>
        <button type="button" className="secondary-action" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </>
  )
}

function ClientTable({
  clients,
  clientsWithActiveChecklists,
  employees,
  onUpdatePlan,
  onUpdateClient,
  onStartOnboarding,
  ownerMode,
  plans,
  query = '',
}: {
  clients: Client[]
  /** Client ids with at least one active (not done, not deleted) checklist. */
  clientsWithActiveChecklists: Set<string>
  employees: Employee[]
  onUpdatePlan: (clientId: string, billingMode: BillingMode, planId: string | null) => void
  /** Owner-only: manual lifecycle-stage override. Omitted in the staff view. */
  onUpdateClient?: (clientId: string, patch: Partial<Client>) => void
  /** Owner-only: start a client's onboarding case. Omitted in the staff view. */
  onStartOnboarding?: (clientId: string) => Promise<boolean>
  ownerMode: boolean
  plans: SubscriptionPlan[]
  query?: string
}) {
  const { sessionUser, data, applyTemplateToClient } = useAppContext()
  const [modalClient, setModalClient] = useState<Client | null>(null)
  const [notesClient, setNotesClient] = useState<Client | null>(null)
  // Client whose "Track time" modal is open (start a timer without leaving the list).
  const [timeClient, setTimeClient] = useState<Client | null>(null)
  // Client whose "Apply template" modal is open (owner-only).
  const [templateClient, setTemplateClient] = useState<Client | null>(null)
  // Client id currently mid-onboarding-request, so its button shows a pending
  // state and can't be double-clicked.
  const [onboardingId, setOnboardingId] = useState<string | null>(null)

  const handleStartOnboarding = async (clientId: string) => {
    if (!onStartOnboarding) return
    setOnboardingId(clientId)
    try {
      await onStartOnboarding(clientId)
    } finally {
      setOnboardingId(null)
    }
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Contact</th>
            <th>Stage</th>
            {ownerMode ? <th>Billing</th> : null}
            {ownerMode ? <th>Rate</th> : null}
            <th>Assigned team</th>
            {ownerMode ? <th>Plans / services</th> : null}
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => {
            const clientPlans = (client.planIds ?? [])
              .map((id) => plans.find((item) => item.id === id))
              .filter((item): item is SubscriptionPlan => Boolean(item))
            return (
              <tr key={client.id}>
                <td>
                  {/* Everyone links through to the client detail page — staff
                      get a read-only, staff-scoped view (recurring checklists,
                      active checklists, contacts). Owner-only sections there are
                      hidden for staff; the route itself isn't owner-gated. */}
                  <Link className="client-name-link" to={`/clients/${client.id}`}>
                    <strong>{highlightMatch(client.name, query)}</strong>
                    <ChevronRight size={14} />
                  </Link>
                </td>
                <td>{client.contact}</td>
                <td>
                  <div className="stage-cell">
                    <StageBadge stage={lifecycleOf(client)} />
                    {ownerMode && onUpdateClient ? (
                      <select
                        className="compact-input stage-override"
                        aria-label={`Set stage for ${client.name}`}
                        title="Manually move this client between stages"
                        onChange={(event) =>
                          onUpdateClient(client.id, {
                            lifecycleStage: event.target.value as LifecycleStage,
                          })
                        }
                        value={lifecycleOf(client)}
                      >
                        {LIFECYCLE_STAGES.map((stage) => (
                          <option key={stage} value={stage}>
                            {LIFECYCLE_LABELS[stage]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                </td>
                {ownerMode ? (
                  <td>
                    <select
                      className="compact-input"
                      onChange={(event) =>
                        onUpdatePlan(
                          client.id,
                          event.target.value as BillingMode,
                          client.planId ?? null,
                        )
                      }
                      value={client.billingMode}
                    >
                      <option value="hourly">Hourly</option>
                      <option value="subscription">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </td>
                ) : null}
                {ownerMode ? (
                  <td>
                    {client.billingMode === 'subscription'
                      ? `${currency.format(client.monthlyRate ?? 0)}/mo`
                      : client.billingMode === 'annual'
                        ? `${currency.format(client.annualRate ?? 0)}/yr`
                        : 'Per-employee'}
                  </td>
                ) : null}
                <td>
                  <div className="client-chip-list compact">
                    {getAssignedEmployeeIds(client).length > 0 ? (
                      getAssignedEmployeeIds(client).map((employeeId) => (
                        <span key={employeeId}>{employeeName(employees, employeeId)}</span>
                      ))
                    ) : (
                      <span>Unassigned</span>
                    )}
                  </div>
                </td>
                {ownerMode ? (
                  <td>
                    {clientPlans.length > 0 ? (
                      <div className="client-chip-list compact">
                        {clientPlans.map((plan) => (
                          <span key={plan.id}>{plan.name}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="muted-text">None</span>
                    )}
                  </td>
                ) : null}
                <td>
                  <div className="client-row-actions">
                    {ownerMode && onStartOnboarding && lifecycleOf(client) === 'active' ? (
                      <button
                        type="button"
                        className="secondary-action compact-action"
                        title="Create the 3-stage onboarding checklist and move this client to Proposal"
                        disabled={onboardingId === client.id}
                        onClick={() => handleStartOnboarding(client.id)}
                      >
                        {onboardingId === client.id ? 'Starting…' : 'Start onboarding'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={
                        clientsWithActiveChecklists.has(client.id)
                          ? 'secondary-action compact-action has-active-checklists'
                          : 'secondary-action compact-action'
                      }
                      title={
                        clientsWithActiveChecklists.has(client.id)
                          ? 'Open checklist & notes — this client has active checklists'
                          : 'Open checklist & notes'
                      }
                      onClick={() => setModalClient(client)}
                    >
                      <ListChecks size={14} /> Checklist
                    </button>
                    <button
                      type="button"
                      className="secondary-action compact-action"
                      title="Start tracking time for this client"
                      onClick={() => setTimeClient(client)}
                    >
                      <Timer size={14} /> Time
                    </button>
                    {ownerMode ? (
                      <button
                        type="button"
                        className="secondary-action compact-action"
                        title="Apply a recurring checklist template to this client"
                        onClick={() => setTemplateClient(client)}
                      >
                        <Copy size={14} /> Template
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-action compact-action"
                      title="Add or read notes for this client"
                      onClick={() => setNotesClient(client)}
                    >
                      <StickyNote size={14} /> Note
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {modalClient ? (
        <ClientChecklistModal client={modalClient} onClose={() => setModalClient(null)} />
      ) : null}
      {timeClient ? (
        <ClientTimeModal client={timeClient} onClose={() => setTimeClient(null)} />
      ) : null}
      {templateClient ? (
        <AddModal
          title={`Apply template · ${templateClient.name}`}
          onClose={() => setTemplateClient(null)}
        >
          <ApplyTemplateForm
            client={templateClient}
            clients={data.clients}
            templates={data.checklistTemplates}
            onApply={(templateId) =>
              applyTemplateToClient(templateId, { clientId: templateClient.id })
            }
            onDone={() => setTemplateClient(null)}
          />
        </AddModal>
      ) : null}
      {notesClient ? (
        <AddModal title={`Notes · ${notesClient.name}`} onClose={() => setNotesClient(null)}>
          <ClientNotesPanel
            clientId={notesClient.id}
            ownerMode={ownerMode}
            currentUserId={sessionUser.id}
          />
        </AddModal>
      ) : null}
    </div>
  )
}
