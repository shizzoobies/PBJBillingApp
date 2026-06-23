import { ArrowLeft, Check, Copy, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChecklistCard, NewTaskForm } from './ChecklistsPage'
import { SectionScopeContext } from '../components/sectionScope'
import { AssignedTeamControl } from '../components/AssignedTeamControl'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { RecurringReimbursementsCard } from '../components/RecurringReimbursementsCard'
import { ReimbursementsCard } from '../components/ReimbursementsCard'
import {
  CollapsibleSection,
  SaveBadge,
  SaveNumberField,
  SaveSelectField,
  SaveTextareaField,
  SaveTextField,
  SaveToggleField,
  SavingTextInput,
} from '../components/SectionKit'
import {
  recordClientProfileActivity,
  setClientAssignedTeamRequest,
} from '../lib/api'
import { ClientNotesPanel } from '../components/ClientNotesPanel'
import { useSaveFlash } from '../lib/useSaveFlash'
import {
  ApiError,
  MONTHLY_SERVICE_TIERS,
  type AppData,
  type BillingMode,
  type ChecklistFrequency,
  type ChecklistTemplate,
  type Client,
  type Contact,
  type Employee,
  type SubscriptionPlan,
} from '../lib/types'
import {
  clientName,
  deriveChecklistStatus,
  emailForClient,
  ensureTemplateStages,
  employeeName,
  formatHours,
  getChecklistFrequencyLabel,
  isDueThisMonth,
  isSafeImageSrc,
  localDateOnly,
  makeId,
  missingPlanTemplatesForClient,
  MONTH_NAMES,
  normalizeBillingMonth,
  planTemplates,
  shortDate,
  sortChecklists,
  stageNameFor,
} from '../lib/utils'

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>()
  const navigate = useNavigate()
  const { data, ownerMode, sessionUser, updateClient, deleteClient } = useAppContext()
  const [assignedTeamError, setAssignedTeamError] = useState('')

  const client = useMemo(
    () => data.clients.find((entry) => entry.id === clientId),
    [data.clients, clientId],
  )

  // Activity-record debounce: only fire one event per ~60s of editing.
  const lastActivityRef = useRef<number>(0)

  // Staff can now reach this page (the route is no longer owner-only). Access is
  // data-level: a non-owner's scoped /api/app-data only contains their assigned
  // clients, so an unassigned id falls through to the "Client not found" state.
  if (!client) {
    return (
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Client controls</p>
            <h2>Client not found</h2>
          </div>
        </div>
        <p>
          <Link className="back-link" to="/clients">
            <ArrowLeft size={14} /> Back to clients
          </Link>
        </p>
      </section>
    )
  }

  const commit = (patch: Partial<Client>) => {
    updateClient(client.id, patch)
    const now = Date.now()
    if (now - lastActivityRef.current > 60_000) {
      lastActivityRef.current = now
      void recordClientProfileActivity(client.id).catch(() => {
        // Activity logging is best-effort.
      })
    }
  }

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete ${client.name}? This removes the client from the workspace. Time entries and checklists referencing this client will be left intact in the data, but the client will no longer appear in lists.`,
      )
    ) {
      return
    }
    deleteClient(client.id)
    navigate('/clients', { replace: true })
  }

  const recentEntries = data.timeEntries
    .filter((entry) => entry.clientId === client.id)
    .slice(0, 8)

  const recentChecklists = sortChecklists(
    data.checklists.filter((checklist) => checklist.clientId === client.id),
  ).slice(0, 8)

  // In-page jump-nav pills. Built conditionally so it mirrors EXACTLY which
  // sections render for the current role — owner-only sections reuse the same
  // `ownerMode` guard that wraps them, so staff never get pills to sections
  // they can't see.
  const jumpItems: Array<{ id: string; label: string }> = [
    { id: 'client-section-profile', label: 'Profile' },
    { id: 'client-section-contacts', label: 'Contacts' },
    ...(ownerMode
      ? [
          { id: 'client-section-team', label: 'Team' },
          { id: 'client-section-billing', label: 'Billing' },
          { id: 'client-section-plan-checklists', label: 'Plan checklists' },
          { id: 'client-section-expenses', label: 'Expenses' },
          { id: 'client-section-branding', label: 'Branding' },
          { id: 'client-section-invoice', label: 'Invoice' },
        ]
      : []),
    { id: 'client-section-checklists', label: 'Checklists' },
    { id: 'client-section-recurring', label: 'Recurring' },
    { id: 'client-section-activity', label: 'Activity' },
    { id: 'client-section-notes', label: 'Notes' },
  ]

  return (
    <SectionScopeContext.Provider value={`client:${client.id}:`}>
    <section className="client-detail">
      <div className="client-detail-header">
        <Link className="back-link" to="/clients">
          <ArrowLeft size={14} />
          Back to clients
        </Link>
      </div>

      <nav className="client-jump-nav" aria-label="Jump to section">
        {jumpItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="client-jump-pill"
            onClick={() =>
              document
                .getElementById(item.id)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            {item.label}
          </button>
        ))}
      </nav>

      {ownerMode ? (
        <CollapsibleSection
          id="client-section-profile"
          kicker="Client profile"
          title="Client name"
          lockable
          headerAction={
            <button className="danger-action" onClick={handleDelete} type="button">
              <Trash2 size={14} />
              Delete client
            </button>
          }
        >
          <NameField client={client} onCommit={commit} />
        </CollapsibleSection>
      ) : (
        // Staff: read-only name. Renaming commits via the owner-only bulk PUT
        // /api/app-data, which would 403 for staff — so no editor, no delete.
        <CollapsibleSection id="client-section-profile" kicker="Client profile" title="Client name">
          <div className="field full-row">
            <span className="field-label-row">Client name</span>
            <h2 className="client-detail-title">{client.name}</h2>
          </div>
        </CollapsibleSection>
      )}

      {ownerMode ? (
        <CollapsibleSection id="client-section-contacts" kicker="Contact" title="Contacts & address" lockable>
          <ContactSectionBody client={client} contacts={data.contacts} onCommit={commit} />
        </CollapsibleSection>
      ) : (
        // Staff: display-only contacts & address (same bulk-save 403 reason).
        <CollapsibleSection id="client-section-contacts" kicker="Contact" title="Contacts & address">
          <ReadOnlyContactSectionBody client={client} contacts={data.contacts} />
        </CollapsibleSection>
      )}

      {ownerMode ? (
        <>
          <CollapsibleSection id="client-section-team" kicker="Visibility" title="Assigned team" lockable>
            <AssignedTeamField
              client={client}
              employees={data.employees}
              onLocalUpdate={(nextIds) =>
                updateClient(client.id, { assignedBookkeeperIds: nextIds })
              }
              onError={setAssignedTeamError}
            />
            {assignedTeamError ? <p className="auth-error">{assignedTeamError}</p> : null}
          </CollapsibleSection>

          <CollapsibleSection id="client-section-billing" kicker="Billing" title="Rate and services" lockable>
            <BillingSectionBody client={client} plans={data.plans} onCommit={commit} />
          </CollapsibleSection>

          <CollapsibleSection id="client-section-plan-checklists" kicker="Billing" title="Plan checklists" lockable>
            <PlanChecklistsBody client={client} data={data} />
          </CollapsibleSection>

          <CollapsibleSection id="client-section-expenses" kicker="Expenses" title="Recurring reimbursements" lockable>
            <RecurringReimbursementsCard clientId={client.id} bare />
          </CollapsibleSection>

          <CollapsibleSection kicker="Expenses" title="Expenses & reimbursements" lockable>
            <ReimbursementsCard clientId={client.id} bare />
          </CollapsibleSection>

          <CollapsibleSection id="client-section-branding" kicker="Branding" title="Logo" lockable>
            <BrandingSectionBody client={client} onCommit={commit} />
          </CollapsibleSection>

          <CollapsibleSection id="client-section-invoice" kicker="Invoice settings" title="Invoice customization" lockable>
            <InvoiceSettingsSectionBody client={client} onCommit={commit} />
          </CollapsibleSection>
        </>
      ) : null}

      <CollapsibleSection id="client-section-checklists" kicker="Work in flight" title="Active checklists">
        <ActiveChecklistsBody client={client} data={data} />
      </CollapsibleSection>

      <CollapsibleSection id="client-section-recurring" kicker="Schedule" title="Recurring checklists">
        <RecurringChecklistsBody client={client} data={data} />
      </CollapsibleSection>

      <CollapsibleSection id="client-section-activity" kicker="Activity" title="Recent work for this client">
        <div className="form-grid two-col">
          <div>
            <h3 className="mini-heading">Recent time entries</h3>
            {recentEntries.length === 0 ? (
              <p className="muted-text">No time entries logged yet.</p>
            ) : (
              <ul className="activity-list">
                {recentEntries.map((entry) => (
                  <li key={entry.id}>
                    <strong>{shortDate.format(new Date(`${entry.date}T12:00:00`))}</strong>
                    <span>
                      {employeeName(data.employees, entry.employeeId)} ·{' '}
                      {formatHours(entry.minutes)} · {entry.category}
                      {entry.billable ? '' : ' (internal)'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mini-heading">Recent checklists</h3>
            {recentChecklists.length === 0 ? (
              <p className="muted-text">No checklists for this client yet.</p>
            ) : (
              <ul className="activity-list">
                {recentChecklists.map((checklist) => {
                  const total = checklist.items.length
                  const done = checklist.items.filter((item) => item.done).length
                  return (
                    <li key={checklist.id}>
                      <Link
                        to={`/checklists?focus=${encodeURIComponent(checklist.id)}`}
                        className="active-checklist-link"
                      >
                        <strong>{checklist.title}</strong>
                      </Link>
                      <span>
                        Due {checklist.dueDate} · {done}/{total} done ·{' '}
                        {clientName(data.clients, checklist.clientId)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="client-section-notes" kicker="Notes" title="Client notes">
        <ClientNotesPanel clientId={client.id} ownerMode={ownerMode} currentUserId={sessionUser.id} />
      </CollapsibleSection>
    </section>
    </SectionScopeContext.Provider>
  )
}

/* -------------------------------------------------------------------------- */
/* Name                                                                       */
/* -------------------------------------------------------------------------- */

function NameField({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  const { state, flash } = useSaveFlash()
  return (
    <div className="field full-row">
      <span className="field-label-row">
        Client name
        <SaveBadge state={state} />
      </span>
      <h2 className="client-detail-title">
        <SavingTextInput
          ariaLabel="Client name"
          className="title-input"
          canonical={client.name}
          onCommit={(value) => {
            const trimmed = value.trim()
            if (!trimmed || trimmed === client.name) return
            onCommit({ name: trimmed })
            flash()
          }}
        />
      </h2>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Contact                                                                    */
/* -------------------------------------------------------------------------- */

function ContactSectionBody({
  client,
  contacts,
  onCommit,
}: {
  client: Client
  contacts: Contact[]
  onCommit: (patch: Partial<Client>) => void
}) {
  // Archived contacts are hidden from the picker. A contact already attached to
  // this client (e.g. attached before it was archived) stays selectable so its
  // chip still renders, but no archived contact can be newly added.
  const selectedIds = client.contactIds ?? []
  const pickerOptions = contacts
    .filter((entry) => !entry.archivedAt || selectedIds.includes(entry.id))
    .map((entry) => ({ id: entry.id, label: entry.name }))
  // The contacts on this client, with the email to use FOR this client
  // (per-company override if set, else the base email).
  const selectedContacts = selectedIds
    .map((id) => contacts.find((entry) => entry.id === id))
    .filter((entry): entry is Contact => Boolean(entry))

  return (
    <div className="form-grid two-col">
      <ChipField
        label="Contacts"
        selectedIds={selectedIds}
        options={pickerOptions}
        onCommit={(nextIds) => onCommit({ contactIds: nextIds })}
        addLabel="+ Add contact"
        emptyHelper="No contacts selected. Manage the shared list on the Contacts page."
      />
      {selectedContacts.length > 0 ? (
        <div className="field full-row client-contact-emails">
          <span className="field-label-row">Contact emails (for this client)</span>
          <ul className="client-contact-email-list">
            {selectedContacts.map((entry) => {
              const email = emailForClient(entry, client.id)
              return (
                <li key={entry.id} className="client-contact-email-row">
                  <strong>{entry.name}</strong>
                  <span className="muted-text">{email || 'No email'}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      <SaveTextField
        label="Address line 1"
        onCommit={(value) => onCommit({ addressLine1: value })}
        value={client.addressLine1 ?? ''}
      />
      <SaveTextField
        label="Address line 2"
        onCommit={(value) => onCommit({ addressLine2: value })}
        value={client.addressLine2 ?? ''}
      />
      <SaveTextField
        label="City"
        onCommit={(value) => onCommit({ city: value })}
        value={client.city ?? ''}
      />
      <SaveTextField
        label="State"
        onCommit={(value) => onCommit({ state: value })}
        value={client.state ?? ''}
      />
      <SaveTextField
        label="Postal code"
        onCommit={(value) => onCommit({ postalCode: value })}
        value={client.postalCode ?? ''}
      />
    </div>
  )
}

// Display-only contacts & address for staff. Editing commits via the owner-only
// bulk PUT /api/app-data (403 for staff), so non-owners get values, not editors.
function ReadOnlyContactSectionBody({
  client,
  contacts,
}: {
  client: Client
  contacts: Contact[]
}) {
  const selectedIds = client.contactIds ?? []
  const selectedContacts = selectedIds
    .map((id) => contacts.find((entry) => entry.id === id))
    .filter((entry): entry is Contact => Boolean(entry))
  const addressLines = [
    client.addressLine1,
    client.addressLine2,
    [client.city, client.state, client.postalCode].filter(Boolean).join(', '),
  ].filter((line) => line && line.trim())

  return (
    <div className="form-grid two-col">
      <div className="field full-row">
        <span className="field-label-row">Contacts</span>
        {selectedContacts.length === 0 ? (
          <p className="muted-text">No contacts selected.</p>
        ) : (
          <ul className="client-contact-email-list">
            {selectedContacts.map((entry) => {
              const email = emailForClient(entry, client.id)
              return (
                <li key={entry.id} className="client-contact-email-row">
                  <strong>{entry.name}</strong>
                  <span className="muted-text">{email || 'No email'}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="field full-row">
        <span className="field-label-row">Address</span>
        {addressLines.length === 0 ? (
          <p className="muted-text">No address on file.</p>
        ) : (
          <p>
            {addressLines.map((line, index) => (
              <span key={index}>
                {line}
                {index < addressLines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Assigned team                                                              */
/* -------------------------------------------------------------------------- */

function AssignedTeamField({
  client,
  employees,
  onLocalUpdate,
  onError,
}: {
  client: Client
  employees: AppData['employees']
  onLocalUpdate: (nextIds: string[]) => void
  onError: (message: string) => void
}) {
  const { state, flash } = useSaveFlash()
  return (
    <div className="field full-row">
      <span className="field-label-row">
        Who can see this client
        <SaveBadge state={state} />
      </span>
      <AssignedTeamControl
        assignedIds={client.assignedBookkeeperIds ?? []}
        employees={employees}
        onChange={(nextIds) => {
          // Optimistic local update + server commit. The server validates
          // and returns the canonical record; reconciliation happens via
          // the next /api/app-data refresh.
          onLocalUpdate(nextIds)
          onError('')
          void setClientAssignedTeamRequest(client.id, nextIds).catch((err) => {
            onError(err instanceof ApiError ? err.message : 'Could not save assigned team.')
          })
          flash()
        }}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Billing                                                                    */
/* -------------------------------------------------------------------------- */

function BillingSectionBody({
  client,
  plans,
  onCommit,
}: {
  client: Client
  plans: SubscriptionPlan[]
  onCommit: (patch: Partial<Client>) => void
}) {
  const isMonthly = client.billingMode === 'subscription'
  const isAnnual = client.billingMode === 'annual'

  return (
    <div className="form-grid two-col">
      <SaveSelectField
        label="Billing type"
        value={client.billingMode}
        onCommit={(value) => onCommit({ billingMode: value as BillingMode })}
        options={[
          { value: 'hourly', label: 'Hourly' },
          { value: 'subscription', label: 'Monthly' },
          { value: 'annual', label: 'Annual' },
        ]}
      />
      {isMonthly ? (
        <SaveNumberField
          key="monthly-rate"
          label="Monthly rate"
          step="0.01"
          min="0"
          value={client.monthlyRate ?? null}
          onCommit={(next) => onCommit({ monthlyRate: next ?? undefined })}
          helper="The fixed monthly amount billed to this client."
        />
      ) : isAnnual ? (
        <SaveNumberField
          key="annual-rate"
          label="Annual fee"
          step="0.01"
          min="0"
          value={client.annualRate ?? null}
          onCommit={(next) => onCommit({ annualRate: next ?? undefined })}
          helper="The flat yearly fee — billed once a year in the month below."
        />
      ) : null}
      {isAnnual ? (
        <SaveSelectField
          label="Billing month"
          value={String(normalizeBillingMonth(client.annualBillingMonth))}
          onCommit={(value) => onCommit({ annualBillingMonth: Number(value) })}
          options={MONTH_NAMES.slice(1).map((name, index) => ({
            value: String(index + 1),
            label: name,
          }))}
        />
      ) : null}
      {isMonthly || isAnnual ? (
        <SaveSelectField
          label={isAnnual ? 'Service package' : 'Monthly service package'}
          value={client.monthlyServiceTier ?? ''}
          onCommit={(value) => onCommit({ monthlyServiceTier: value || undefined })}
          options={[
            { value: '', label: 'Generic (no package)' },
            ...MONTHLY_SERVICE_TIERS.map((tier) => ({ value: tier, label: tier })),
          ]}
        />
      ) : null}
      <EstimatedRoleHours client={client} onCommit={onCommit} />
      <ChipField
        label="Plans / services"
        selectedIds={client.planIds ?? []}
        options={plans.map((plan) => ({ id: plan.id, label: plan.name }))}
        onCommit={(nextIds) => onCommit({ planIds: nextIds })}
        addLabel="+ Add plan / service"
        emptyHelper="No plans/services selected yet."
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Plan checklists                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Deep-clone a checklist template ONTO a client: fresh ids at every level
 * (template, stage, item, sub-item) so the bulk autosave can insert the copy
 * without colliding with the source, with `clientId` retargeted and the origin
 * stamped via `sourceTemplateId`. Everything else — stages, items, categoryId
 * (the board column), frequency, scheduling — is preserved. Mirrors the
 * server-side copyTemplateToClient clone, done locally so the copy persists
 * through the normal workspace autosave.
 */
function cloneTemplateForClient(
  source: ChecklistTemplate,
  clientId: string,
): Omit<ChecklistTemplate, 'id'> {
  const migrated = ensureTemplateStages(source)
  const cloneItems = (items: ChecklistTemplate['stages'][number]['items']) =>
    (items ?? []).map((item) => ({
      ...item,
      id: makeId('template-item'),
      subItems: (item.subItems ?? []).map((sub) => ({
        ...sub,
        id: makeId('template-subitem'),
      })),
    }))
  return {
    title: source.title,
    clientId,
    assigneeId: source.assigneeId || '',
    frequency: source.frequency,
    nextDueDate: source.nextDueDate || localDateOnly(),
    active: true,
    isStandard: false,
    sourceTemplateId: source.id,
    categoryId: source.categoryId ?? null,
    leadDays: source.leadDays,
    scheduledMonths: source.scheduledMonths ? [...source.scheduledMonths] : undefined,
    dueDayOfMonth: source.dueDayOfMonth,
    monthlyDueDays: source.monthlyDueDays ? { ...source.monthlyDueDays } : undefined,
    repeatAnnually: source.repeatAnnually,
    scheduleYear: source.scheduleYear,
    viewerIds: Array.isArray(source.viewerIds) ? [...source.viewerIds] : [],
    editorIds: Array.isArray(source.editorIds) ? [...source.editorIds] : [],
    stages: (migrated.stages ?? []).map((stage) => ({
      ...stage,
      id: makeId('stage'),
      viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
      editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
      items: cloneItems(stage.items),
    })),
  }
}

function PlanChecklistsBody({ client, data }: { client: Client; data: AppData }) {
  const { ownerMode, addChecklistTemplate } = useAppContext()

  // The plans this client is on (planIds chips on the Billing panel).
  const clientPlans = useMemo(
    () =>
      (client.planIds ?? [])
        .map((planId) => data.plans.find((plan) => plan.id === planId))
        .filter((plan): plan is SubscriptionPlan => Boolean(plan)),
    [client.planIds, data.plans],
  )

  if (!ownerMode) return null

  if (clientPlans.length === 0) {
    return (
      <p className="muted-text">
        This client isn&apos;t on any plan yet. Add a plan under{' '}
        <strong>Rate and services</strong> to bundle its checklists here.
      </p>
    )
  }

  const setUpMissing = (plan: SubscriptionPlan) => {
    const missing = missingPlanTemplatesForClient(
      plan,
      data.checklistTemplates,
      client.id,
      data.checklistTemplates,
    )
    for (const template of missing) {
      addChecklistTemplate(cloneTemplateForClient(template, client.id))
    }
  }

  return (
    <div className="plan-checklists">
      {clientPlans.map((plan) => {
        const templates = planTemplates(plan, data.checklistTemplates)
        const missing = missingPlanTemplatesForClient(
          plan,
          data.checklistTemplates,
          client.id,
          data.checklistTemplates,
        )
        const missingIds = new Set(missing.map((template) => template.id))
        return (
          <div className="plan-checklists-group" key={plan.id}>
            <div className="plan-checklists-head">
              <strong>{plan.name}</strong>
              {templates.length > 0 && missing.length > 0 ? (
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => setUpMissing(plan)}
                >
                  <Plus size={14} /> Set up plan checklists ({missing.length})
                </button>
              ) : null}
            </div>
            {templates.length === 0 ? (
              <p className="muted-text">No checklists are bundled with this plan yet.</p>
            ) : (
              <ul className="plan-checklists-list">
                {templates.map((template) => {
                  const isMissing = missingIds.has(template.id)
                  return (
                    <li className="plan-checklists-row" key={template.id}>
                      <span className="apply-existing-info">
                        <strong>{template.title}</strong>
                        <span className="apply-existing-meta">
                          {getChecklistFrequencyLabel(template.frequency)}
                        </span>
                      </span>
                      <span
                        className={
                          isMissing ? 'plan-checklist-status missing' : 'plan-checklist-status ready'
                        }
                      >
                        {isMissing ? (
                          'Not set up'
                        ) : (
                          <>
                            <Check size={12} /> Set up
                          </>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

function EstimatedRoleHours({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  const bookkeeper = client.estimatedBookkeeperHours ?? 0
  const accountant = client.estimatedAccountantHours ?? 0
  const cfo = client.estimatedCfoHours ?? 0
  const total = bookkeeper + accountant + cfo
  return (
    <div className="field full-row estimated-role-hours">
      <span>Estimated monthly hours</span>
      <div className="form-grid two-col">
        <SaveNumberField
          label="Bookkeeper"
          step="any"
          min="0"
          value={client.estimatedBookkeeperHours ?? null}
          onCommit={(next) => onCommit({ estimatedBookkeeperHours: next ?? undefined })}
        />
        <SaveNumberField
          label="Accountant"
          step="any"
          min="0"
          value={client.estimatedAccountantHours ?? null}
          onCommit={(next) => onCommit({ estimatedAccountantHours: next ?? undefined })}
        />
        <SaveNumberField
          label="CFO"
          step="any"
          min="0"
          value={client.estimatedCfoHours ?? null}
          onCommit={(next) => onCommit({ estimatedCfoHours: next ?? undefined })}
        />
      </div>
      <small className="field-helper">
        Total: {total} hrs/mo · For planning only — does not affect invoices.
      </small>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Branding + invoice settings                                                */
/* -------------------------------------------------------------------------- */

function BrandingSectionBody({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <div className="form-grid two-col">
      <SaveTextField
        label="Logo URL"
        onCommit={(value) => onCommit({ logoUrl: value })}
        placeholder="https://..."
        value={client.logoUrl ?? ''}
      />
      <div className="logo-preview">
        {isSafeImageSrc(client.logoUrl) ? (
          <img alt={`${client.name} logo`} src={client.logoUrl} />
        ) : (
          <span className="muted-text">No logo set. Paste a public image URL.</span>
        )}
      </div>
    </div>
  )
}

function InvoiceSettingsSectionBody({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <div className="form-grid two-col">
      <SaveTextField
        label="Payment terms"
        onCommit={(value) => onCommit({ paymentTerms: value })}
        placeholder='e.g. "Net 30" or "Due on receipt"'
        value={client.paymentTerms ?? ''}
      />
      <SaveTextField
        label="QuickBooks 'Pay Now' link"
        helper="Paste the public payment URL from QuickBooks. Will appear as a Pay button on each invoice."
        onCommit={(value) => onCommit({ quickbooksPayUrl: value })}
        placeholder="https://quickbooks.intuit.com/payments/..."
        value={client.quickbooksPayUrl ?? ''}
      />
      <SaveTextareaField
        label="Invoice footer note"
        onCommit={(value) => onCommit({ footerNote: value })}
        value={client.footerNote ?? ''}
      />
      <SaveToggleField
        checked={client.invoiceShowTimeBreakdown ?? true}
        description="Show each time entry on the invoice. When off, the invoice shows a single bookkeeping services line."
        label="Show time breakdown"
        onChange={(value) => onCommit({ invoiceShowTimeBreakdown: value })}
      />
      <SaveToggleField
        checked={client.invoiceHideInternalHours ?? true}
        description="Hide non-billable rows from the invoice."
        label="Hide internal hours"
        onChange={(value) => onCommit({ invoiceHideInternalHours: value })}
      />
      <SaveToggleField
        checked={client.invoiceGroupByCategory ?? false}
        description="Group line items by work-type category with subtotals."
        label="Group by category"
        onChange={(value) => onCommit({ invoiceGroupByCategory: value })}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Chip field (multi-select with its own Saved badge)                         */
/* -------------------------------------------------------------------------- */

function ChipField({
  label,
  selectedIds,
  options,
  onCommit,
  addLabel,
  emptyHelper,
}: {
  label: string
  selectedIds: string[]
  options: Array<{ id: string; label: string }>
  onCommit: (nextIds: string[]) => void
  addLabel: string
  emptyHelper: string
}) {
  const { state, flash } = useSaveFlash()
  return (
    <div className="field full-row">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <ChipMultiSelect
        selectedIds={selectedIds}
        options={options}
        onChange={(nextIds) => {
          onCommit(nextIds)
          flash()
        }}
        addLabel={addLabel}
        emptyHelper={emptyHelper}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Read-only sections (checklists, activity)                                  */
/* -------------------------------------------------------------------------- */

export function ActiveChecklistsBody({ client, data }: { client: Client; data: AppData }) {
  const {
    activeEmployeeId,
    role,
    ownerMode,
    addSubItem,
    addSubSubItem,
    bulkAddChecklistItems,
    deleteChecklist,
    deleteChecklistItem,
    removeSubItem,
    removeSubSubItem,
    reorderChecklistItems,
    setChecklistViewers,
    toggleChecklistItem,
    toggleSubItem,
    toggleSubSubItem,
    updateChecklistItem,
    updateSubItemWaiting,
  } = useAppContext()
  const [dueThisMonthOnly, setDueThisMonthOnly] = useState(false)
  const today = localDateOnly()
  // "Work in flight" = currently active checklists only. A checklist whose
  // every item is done (status 'Done') is finished, not in flight, so it's
  // excluded here. Overdue / In progress / Not started all remain.
  const checklists = sortChecklists(
    data.checklists.filter(
      (entry) =>
        entry.clientId === client.id &&
        !entry.deletedAt &&
        deriveChecklistStatus(entry, today) !== 'Done',
    ),
  )

  // "Due this month": a checklist's effective due = its dueDate (same field the
  // page already shows). Count is computed regardless so the label is accurate.
  const dueThisMonthCount = checklists.filter((entry) =>
    isDueThisMonth(entry.dueDate, today),
  ).length
  const shownChecklists = dueThisMonthOnly
    ? checklists.filter((entry) => isDueThisMonth(entry.dueDate, today))
    : checklists

  if (checklists.length === 0) {
    return <p className="muted-text">No active checklists for this client.</p>
  }

  // Full editable checklist cards — the same editor as the Checklists tab, so
  // an owner can toggle/add/reorder items and edit details right here.
  return (
    <div>
      <div className="client-checklist-toolbar">
        <label className="inline-toggle">
          <input
            type="checkbox"
            checked={dueThisMonthOnly}
            onChange={(event) => setDueThisMonthOnly(event.target.checked)}
          />
          Due this month
        </label>
        <span className="muted-text">
          {dueThisMonthCount} due this month
        </span>
      </div>
      {shownChecklists.length === 0 ? (
        <p className="muted-text">No active checklists due this month.</p>
      ) : (
        <div className="client-checklist-cards">
          {shownChecklists.map((checklist) => (
        <ChecklistCard
          key={checklist.id}
          activeEmployeeId={activeEmployeeId}
          checklist={checklist}
          stageName={stageNameFor(data.checklistTemplates, checklist)}
          clients={data.clients}
          employees={data.employees}
          focused={false}
          focusRef={null}
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
          ))}
        </div>
      )}
    </div>
  )
}

const SIMPLE_FREQUENCIES: ChecklistFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annually',
]

// Pick an existing recurring checklist (a standard blueprint, or one already
// set up on another client) and copy it onto this client.
function ApplyExistingTemplateModal({
  client,
  clients,
  templates,
  onApply,
  onClose,
}: {
  client: Client
  clients: Client[]
  templates: ChecklistTemplate[]
  onApply: (
    templateId: string,
    payload: { clientId: string; firstDueDate?: string; frequency?: string },
  ) => Promise<void>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  // Offer standard blueprints plus templates from OTHER clients. Templates
  // already on this client are skipped (she already has them).
  const pickable = useMemo(
    () =>
      templates
        .filter((template) => template.isStandard || template.clientId !== client.id)
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title)),
    [templates, client.id],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pickable
    return pickable.filter((template) => template.title.toLowerCase().includes(q))
  }, [pickable, query])

  const apply = async (templateId: string) => {
    setBusyId(templateId)
    setError('')
    try {
      await onApply(templateId, { clientId: client.id })
      onClose()
    } catch {
      setError('Could not add that checklist — please try again.')
      setBusyId(null)
    }
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Add an existing recurring checklist"
      >
        <div className="modal-body">
          <h2 className="modal-title">Add an existing recurring checklist</h2>
          <p className="modal-intro">
            Pick a recurring checklist you&apos;ve already created. A copy is added to{' '}
            <strong>{client.name}</strong> — editing it here won&apos;t change the original.
          </p>
          <label className="field">
            <input
              aria-label="Search existing recurring checklists"
              className="input"
              type="search"
              placeholder="Search by name…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {filtered.length === 0 ? (
            <p className="muted-text">
              {pickable.length === 0
                ? "You haven't created any recurring checklists to reuse yet."
                : `No matches for “${query.trim()}”.`}
            </p>
          ) : (
            <ul className="apply-existing-list">
              {filtered.map((template) => (
                <li className="apply-existing-row" key={template.id}>
                  <div className="apply-existing-info">
                    <strong>{template.title}</strong>
                    <span className="apply-existing-meta">
                      {getChecklistFrequencyLabel(template.frequency)} ·{' '}
                      {template.isStandard
                        ? 'Standard blueprint'
                        : `From ${clientName(clients, template.clientId)}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="primary-action"
                    disabled={busyId !== null}
                    onClick={() => void apply(template.id)}
                  >
                    {busyId === template.id ? 'Adding…' : 'Add'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error ? <p className="auth-error">{error}</p> : null}
          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RecurringChecklistsBody({ client, data }: { client: Client; data: AppData }) {
  const {
    role,
    activeEmployeeId,
    ownerMode,
    addChecklistTemplate,
    createChecklist,
    updateChecklistTemplate,
    applyTemplateToClient,
  } = useAppContext()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [picking, setPicking] = useState(false)

  // Every client-bound recurring template targeting this client. Standard
  // (client-agnostic) blueprints are excluded — they never belong to a client.
  const templates = useMemo(
    () =>
      data.checklistTemplates
        .filter((template) => !template.isStandard && template.clientId === client.id)
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title)),
    [data.checklistTemplates, client.id],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return templates
    return templates.filter((template) => {
      const freq = getChecklistFrequencyLabel(template.frequency).toLowerCase()
      const assignee = employeeName(data.employees, template.assigneeId).toLowerCase()
      return (
        template.title.toLowerCase().includes(q) || freq.includes(q) || assignee.includes(q)
      )
    })
  }, [templates, query, data.employees])

  // Mirrors the Checklists page: create the template (bulk-saved) and, when
  // "start the first one now" is chosen, also materialize a Stage-1 instance.
  const handleCreateRepeating = async (
    template: Omit<ChecklistTemplate, 'id'>,
    startFirstNow: boolean,
  ) => {
    addChecklistTemplate(template)
    if (startFirstNow) {
      const stageOne = template.stages[0]
      if (stageOne && stageOne.items.length > 0) {
        const today = localDateOnly()
        const firstDue =
          template.nextDueDate && template.nextDueDate < today ? template.nextDueDate : today
        try {
          await createChecklist({
            title: template.title,
            clientId: template.clientId,
            assigneeId: stageOne.assigneeId || template.assigneeId,
            dueDate: firstDue,
            items: stageOne.items.map((item) => ({ label: item.label })),
          })
        } catch {
          /* template still created; the instance can be generated later */
        }
      }
    }
    setAdding(false)
  }

  return (
    <>
      {ownerMode && !adding ? (
        <div className="recurring-add-row">
          <button type="button" className="primary-action" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add recurring checklist
          </button>
          <button type="button" className="secondary-action" onClick={() => setPicking(true)}>
            <Copy size={14} /> Add from existing
          </button>
        </div>
      ) : null}

      {ownerMode && picking ? (
        <ApplyExistingTemplateModal
          client={client}
          clients={data.clients}
          templates={data.checklistTemplates}
          onApply={applyTemplateToClient}
          onClose={() => setPicking(false)}
        />
      ) : null}

      {ownerMode && adding ? (
        <NewTaskForm
          mode="repeating"
          activeEmployeeId={activeEmployeeId}
          clients={[client]}
          employees={data.employees}
          role={role}
          onCancel={() => setAdding(false)}
          onCreateOneTime={async (payload) => {
            await createChecklist(payload)
          }}
          onCreateRepeating={handleCreateRepeating}
        />
      ) : null}

      {templates.length === 0 ? (
        <p className="muted-text">No recurring checklists assigned to this client yet.</p>
      ) : (
        <>
          <label className="field" style={{ margin: '12px 0' }}>
            <input
              aria-label="Search recurring checklists"
              className="input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, frequency, or assignee…"
              type="search"
              value={query}
            />
          </label>
          {filtered.length === 0 ? (
            <p className="muted-text">No recurring checklists match “{query.trim()}”.</p>
          ) : (
            <ul className="active-checklist-list">
              {filtered.map((template) => (
                <RecurringTemplateRow
                  key={template.id}
                  template={template}
                  employees={data.employees}
                  canEdit={ownerMode}
                  onUpdate={updateChecklistTemplate}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )
}

function RecurringTemplateRow({
  template,
  employees,
  canEdit,
  onUpdate,
}: {
  template: ChecklistTemplate
  employees: Employee[]
  canEdit: boolean
  onUpdate: (
    templateId: string,
    updater: (template: ChecklistTemplate) => ChecklistTemplate,
  ) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(template.title)
  const [assigneeId, setAssigneeId] = useState(template.assigneeId)
  const [frequency, setFrequency] = useState<ChecklistFrequency>(template.frequency)
  const jumpTo = `/checklists?focusTemplate=${encodeURIComponent(template.id)}`

  const openEditor = () => {
    setTitle(template.title)
    setAssigneeId(template.assigneeId)
    setFrequency(template.frequency)
    setEditing(true)
  }
  const save = () => {
    onUpdate(template.id, (current) => ({
      ...current,
      title: title.trim() || current.title,
      assigneeId,
      frequency,
    }))
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="active-checklist-row recurring-edit-row">
        <input
          className="input"
          aria-label="Checklist name"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="recurring-edit-fields">
          <label className="field">
            <span>Assignee</span>
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
          <label className="field">
            <span>Frequency</span>
            <select
              className="input"
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as ChecklistFrequency)}
            >
              {template.frequency === 'specific-months' ? (
                <option value="specific-months">Specific months (edit on Checklists)</option>
              ) : null}
              {SIMPLE_FREQUENCIES.map((freq) => (
                <option key={freq} value={freq}>
                  {getChecklistFrequencyLabel(freq)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="button-row">
          <button type="button" className="primary-action" onClick={save}>
            Save
          </button>
          <button type="button" className="secondary-action" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="active-checklist-row">
      <div className="active-checklist-main">
        <Link to={jumpTo} className="active-checklist-link">
          <strong>{template.title}</strong>
        </Link>
        {canEdit ? (
          <button
            type="button"
            className={
              template.active
                ? 'repeating-task-toggle-pill on'
                : 'repeating-task-toggle-pill off'
            }
            title="Turn this recurring checklist on or off"
            onClick={() =>
              onUpdate(template.id, (current) => ({ ...current, active: !current.active }))
            }
          >
            {template.active ? 'On' : 'Off'}
          </button>
        ) : (
          <span
            className={
              template.active
                ? 'repeating-task-toggle-pill on'
                : 'repeating-task-toggle-pill off'
            }
          >
            {template.active ? 'On' : 'Off'}
          </span>
        )}
      </div>
      <div className="active-checklist-meta">
        <span>Assignee: {employeeName(employees, template.assigneeId)}</span>
        <span>{getChecklistFrequencyLabel(template.frequency)}</span>
        {canEdit ? (
          <button type="button" className="active-checklist-link recurring-edit-btn" onClick={openEditor}>
            <Pencil size={12} style={{ verticalAlign: 'middle' }} /> Edit
          </button>
        ) : null}
        <Link to={jumpTo} className="active-checklist-link">
          Items <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
        </Link>
      </div>
    </li>
  )
}
