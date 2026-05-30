import { ArrowLeft, ExternalLink, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { AssignedTeamControl } from '../components/AssignedTeamControl'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { RecurringReimbursementsCard } from '../components/RecurringReimbursementsCard'
import { ReimbursementsCard } from '../components/ReimbursementsCard'
import { recordClientProfileActivity, setClientAssignedTeamRequest } from '../lib/api'
import {
  ApiError,
  type AppData,
  type BillingMode,
  type Client,
  type Contact,
  type SubscriptionPlan,
} from '../lib/types'
import {
  clientName,
  deriveChecklistStatus,
  employeeName,
  formatHours,
  getChecklistFrequencyLabel,
  isChecklistItemDone,
  isSafeImageSrc,
  shortDate,
  sortChecklists,
} from '../lib/utils'

export function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>()
  const navigate = useNavigate()
  const { data, ownerMode, updateClient, deleteClient } = useAppContext()
  const [assignedTeamError, setAssignedTeamError] = useState('')

  const client = useMemo(
    () => data.clients.find((entry) => entry.id === clientId),
    [data.clients, clientId],
  )

  // Activity-record debounce: only fire one event per ~60s of editing.
  const lastActivityRef = useRef<number>(0)
  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimeoutRef = useRef<number | null>(null)

  // Track whether the last save came from this page so we can show "Saved".
  // We trigger the indicator on every commit attempt.
  const flashSaved = () => {
    setSavedFlash(true)
    if (savedTimeoutRef.current) {
      window.clearTimeout(savedTimeoutRef.current)
    }
    savedTimeoutRef.current = window.setTimeout(() => setSavedFlash(false), 1500)
  }

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current)
      }
    }
  }, [])

  if (!ownerMode) {
    return <Navigate to="/clients" replace />
  }

  if (!client) {
    return (
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Owner client controls</p>
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
    flashSaved()
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

  return (
    <section className="client-detail">
      <div className="client-detail-header">
        <Link className="back-link" to="/clients">
          <ArrowLeft size={14} />
          Back to clients
        </Link>
        {savedFlash ? <span className="saved-flash">Saved</span> : null}
      </div>

      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Client profile</p>
            <NameField client={client} onCommit={commit} />
          </div>
          <button
            className="danger-action"
            onClick={handleDelete}
            type="button"
          >
            <Trash2 size={14} />
            Delete client
          </button>
        </div>
      </div>

      <ContactSection client={client} contacts={data.contacts} onCommit={commit} />

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Visibility</p>
            <h2>Assigned team</h2>
          </div>
        </div>
        <AssignedTeamControl
          assignedIds={client.assignedBookkeeperIds ?? []}
          employees={data.employees}
          onChange={(nextIds) => {
            // Optimistic local update + server commit. The server validates
            // and returns the canonical record; reconciliation happens via
            // the next /api/app-data refresh.
            updateClient(client.id, { assignedBookkeeperIds: nextIds })
            setAssignedTeamError('')
            void setClientAssignedTeamRequest(client.id, nextIds).catch((err) => {
              setAssignedTeamError(
                err instanceof ApiError ? err.message : 'Could not save assigned team.',
              )
            })
            flashSaved()
          }}
        />
        {assignedTeamError ? <p className="auth-error">{assignedTeamError}</p> : null}
      </section>

      <BillingSection client={client} plans={data.plans} onCommit={commit} />

      <RecurringReimbursementsCard clientId={client.id} />
      <ReimbursementsCard clientId={client.id} />

      <BrandingSection client={client} onCommit={commit} />
      <InvoiceSettingsSection client={client} onCommit={commit} />

      <ActiveChecklistsSection client={client} data={data} />

      <RecurringChecklistsSection client={client} data={data} />

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Activity</p>
            <h2>Recent work for this client</h2>
          </div>
        </div>
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
                      <strong>{checklist.title}</strong>
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
      </section>
    </section>
  )
}

function NameField({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <h2 className="client-detail-title">
      <NameInput
        canonical={client.name}
        key={`${client.id}:${client.name}`}
        onCommit={(value) => onCommit({ name: value })}
      />
    </h2>
  )
}

function NameInput({
  canonical,
  onCommit,
}: {
  canonical: string
  onCommit: (value: string) => void
}) {
  const [value, setValue] = useState(canonical)
  return (
    <input
      aria-label="Client name"
      className="title-input"
      onBlur={() => {
        const trimmed = value.trim()
        if (!trimmed) {
          setValue(canonical)
          return
        }
        if (trimmed !== canonical) {
          onCommit(trimmed)
        }
      }}
      onChange={(event) => setValue(event.target.value)}
      value={value}
    />
  )
}

function ContactSection({
  client,
  contacts,
  onCommit,
}: {
  client: Client
  contacts: Contact[]
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Contact</p>
          <h2>Contacts &amp; address</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <div className="field full-row">
          <span>Contacts</span>
          <ChipMultiSelect
            selectedIds={client.contactIds ?? []}
            options={contacts.map((entry) => ({ id: entry.id, label: entry.name }))}
            onChange={(nextIds) => onCommit({ contactIds: nextIds })}
            addLabel="+ Add contact"
            emptyHelper="No contacts selected. Manage the shared list on the Contacts page."
          />
        </div>
        <TextField
          label="Address line 1"
          onCommit={(value) => onCommit({ addressLine1: value })}
          value={client.addressLine1 ?? ''}
        />
        <TextField
          label="Address line 2"
          onCommit={(value) => onCommit({ addressLine2: value })}
          value={client.addressLine2 ?? ''}
        />
        <TextField
          label="City"
          onCommit={(value) => onCommit({ city: value })}
          value={client.city ?? ''}
        />
        <TextField
          label="State"
          onCommit={(value) => onCommit({ state: value })}
          value={client.state ?? ''}
        />
        <TextField
          label="Postal code"
          onCommit={(value) => onCommit({ postalCode: value })}
          value={client.postalCode ?? ''}
        />
      </div>
    </section>
  )
}

function BillingSection({
  client,
  plans,
  onCommit,
}: {
  client: Client
  plans: SubscriptionPlan[]
  onCommit: (patch: Partial<Client>) => void
}) {
  const isMonthly = client.billingMode === 'subscription'

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Billing</p>
          <h2>Rate and services</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <label className="field">
          <span>Billing type</span>
          <select
            className="input"
            onChange={(event) => onCommit({ billingMode: event.target.value as BillingMode })}
            value={client.billingMode}
          >
            <option value="hourly">Hourly</option>
            <option value="subscription">Monthly</option>
          </select>
        </label>
        {isMonthly ? (
          <NumberField
            label="Monthly rate"
            step="0.01"
            min="0"
            value={client.monthlyRate ?? 0}
            onCommit={(next) => onCommit({ monthlyRate: next })}
            helper="The fixed monthly amount billed to this client."
          />
        ) : (
          <NumberField
            label="Hourly rate"
            step="0.01"
            min="0"
            value={client.hourlyRate}
            onCommit={(next) => onCommit({ hourlyRate: next })}
            helper="Used to bill every billable hour worked for this client."
          />
        )}
        <EstimatedRoleHours client={client} onCommit={onCommit} />
        <div className="field full-row">
          <span>Plans / services</span>
          <ChipMultiSelect
            selectedIds={client.planIds ?? []}
            options={plans.map((plan) => ({ id: plan.id, label: plan.name }))}
            onChange={(nextIds) => onCommit({ planIds: nextIds })}
            addLabel="+ Add plan / service"
            emptyHelper="No plans/services selected yet."
          />
        </div>
      </div>
    </section>
  )
}

function ActiveChecklistsSection({
  client,
  data,
}: {
  client: Client
  data: AppData
}) {
  const today = new Date().toISOString().slice(0, 10)
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

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Work in flight</p>
          <h2>Active checklists</h2>
        </div>
      </div>
      {checklists.length === 0 ? (
        <p className="muted-text">No active checklists for this client.</p>
      ) : (
        <ul className="active-checklist-list">
          {checklists.map((checklist) => {
            const total = checklist.items.length
            const done = checklist.items.filter((item) => isChecklistItemDone(item)).length
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            const status = deriveChecklistStatus(checklist, today)
            const statusClass = status.toLowerCase().replace(/\s+/g, '-')
            const stageLabel =
              checklist.stageCount && checklist.stageCount > 1
                ? `Step ${(checklist.stageIndex ?? 0) + 1} of ${checklist.stageCount}`
                : null
            const frequencyLabel = checklist.frequency
              ? getChecklistFrequencyLabel(checklist.frequency)
              : null
            return (
              <li className="active-checklist-row" key={checklist.id}>
                <div className="active-checklist-main">
                  {checklist.caseId ? (
                    <Link
                      to={`/cases/${encodeURIComponent(checklist.caseId)}`}
                      className="active-checklist-link"
                    >
                      <strong>{checklist.title}</strong>
                    </Link>
                  ) : (
                    <strong>{checklist.title}</strong>
                  )}
                  <span className={`status-badge status-${statusClass}`}>{status}</span>
                </div>
                <div className="active-checklist-meta">
                  <span>Assignee: {employeeName(data.employees, checklist.assigneeId)}</span>
                  <span>
                    {done} / {total} steps ({pct}%)
                  </span>
                  <span>Due {shortDate.format(new Date(`${checklist.dueDate}T12:00:00`))}</span>
                  {stageLabel ? <span>{stageLabel}</span> : null}
                  {frequencyLabel ? <span>{frequencyLabel}</span> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function RecurringChecklistsSection({
  client,
  data,
}: {
  client: Client
  data: AppData
}) {
  const [query, setQuery] = useState('')

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
        template.title.toLowerCase().includes(q) ||
        freq.includes(q) ||
        assignee.includes(q)
      )
    })
  }, [templates, query, data.employees])

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Schedule</p>
          <h2>Recurring checklists</h2>
        </div>
        {templates.length > 0 ? <span className="status-pill">{templates.length}</span> : null}
      </div>
      {templates.length === 0 ? (
        <p className="muted-text">No recurring checklists assigned to this client.</p>
      ) : (
        <>
          <label className="field" style={{ marginBottom: 12 }}>
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
              {filtered.map((template) => {
                const jumpTo = `/checklists?focusTemplate=${encodeURIComponent(template.id)}`
                return (
                  <li className="active-checklist-row" key={template.id}>
                    <div className="active-checklist-main">
                      <Link to={jumpTo} className="active-checklist-link">
                        <strong>{template.title}</strong>
                      </Link>
                      <span
                        className={
                          template.active
                            ? 'repeating-task-toggle-pill on'
                            : 'repeating-task-toggle-pill off'
                        }
                      >
                        {template.active ? 'On' : 'Off'}
                      </span>
                    </div>
                    <div className="active-checklist-meta">
                      <span>Assignee: {employeeName(data.employees, template.assigneeId)}</span>
                      <span>{getChecklistFrequencyLabel(template.frequency)}</span>
                      <Link to={jumpTo} className="active-checklist-link">
                        View <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                      </Link>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </section>
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
        <NumberField
          label="Bookkeeper"
          step="0.5"
          min="0"
          value={bookkeeper}
          onCommit={(next) => onCommit({ estimatedBookkeeperHours: next })}
        />
        <NumberField
          label="Accountant"
          step="0.5"
          min="0"
          value={accountant}
          onCommit={(next) => onCommit({ estimatedAccountantHours: next })}
        />
        <NumberField
          label="CFO"
          step="0.5"
          min="0"
          value={cfo}
          onCommit={(next) => onCommit({ estimatedCfoHours: next })}
        />
      </div>
      <small className="field-helper">
        Total: {total} hrs/mo · For planning only — does not affect invoices.
      </small>
    </div>
  )
}

function NumberField({
  label,
  helper,
  min,
  step,
  value,
  onCommit,
}: {
  label: string
  helper?: string
  min?: string
  step?: string
  value: number
  onCommit: (value: number) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <NumberInputControl
        canonical={value}
        min={min}
        step={step}
        onCommit={(next) => {
          if (next === null) return
          onCommit(next)
        }}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

function NumberInputControl({
  canonical,
  min,
  step,
  placeholder,
  onCommit,
}: {
  canonical: number | null
  min?: string
  step?: string
  placeholder?: string
  onCommit: (value: number | null) => void
}) {
  const [draft, setDraft] = useState(canonical === null ? '' : String(canonical))
  return (
    <input
      className="input"
      min={min ?? '0'}
      step={step ?? '0.01'}
      type="number"
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const trimmed = draft.trim()
        if (trimmed === '') {
          if (canonical !== null) onCommit(null)
          return
        }
        const parsed = Number(trimmed)
        if (Number.isNaN(parsed)) {
          setDraft(canonical === null ? '' : String(canonical))
          return
        }
        if (parsed !== canonical) {
          onCommit(parsed)
        }
      }}
    />
  )
}

function BrandingSection({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Branding</p>
          <h2>Logo</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
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
    </section>
  )
}

function InvoiceSettingsSection({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Invoice settings</p>
          <h2>Invoice customization</h2>
        </div>
      </div>
      <div className="form-grid two-col">
        <TextField
          label="Payment terms"
          onCommit={(value) => onCommit({ paymentTerms: value })}
          placeholder='e.g. "Net 30" or "Due on receipt"'
          value={client.paymentTerms ?? ''}
        />
        <TextField
          label="QuickBooks 'Pay Now' link"
          helper="Paste the public payment URL from QuickBooks. Will appear as a Pay button on each invoice."
          onCommit={(value) => onCommit({ quickbooksPayUrl: value })}
          placeholder="https://quickbooks.intuit.com/payments/..."
          value={client.quickbooksPayUrl ?? ''}
        />
        <label className="field full-row">
          <span>Invoice footer note</span>
          <BlurTextarea
            onCommit={(value) => onCommit({ footerNote: value })}
            value={client.footerNote ?? ''}
          />
        </label>
        <ToggleField
          checked={client.invoiceShowTimeBreakdown ?? true}
          description="Show each time entry on the invoice. When off, the invoice shows a single bookkeeping services line."
          label="Show time breakdown"
          onChange={(value) => onCommit({ invoiceShowTimeBreakdown: value })}
        />
        <ToggleField
          checked={client.invoiceHideInternalHours ?? true}
          description="Hide non-billable rows from the invoice."
          label="Hide internal hours"
          onChange={(value) => onCommit({ invoiceHideInternalHours: value })}
        />
        <ToggleField
          checked={client.invoiceGroupByCategory ?? false}
          description="Group line items by work-type category with subtotals."
          label="Group by category"
          onChange={(value) => onCommit({ invoiceGroupByCategory: value })}
        />
      </div>
    </section>
  )
}

function TextField({
  label,
  helper,
  onCommit,
  placeholder,
  type,
  value,
}: {
  label: string
  helper?: string
  onCommit: (value: string) => void
  placeholder?: string
  type?: string
  value: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <TextInputControl
        canonical={value}
        key={value}
        onCommit={onCommit}
        placeholder={placeholder}
        type={type ?? 'text'}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

function TextInputControl({
  canonical,
  onCommit,
  placeholder,
  type,
}: {
  canonical: string
  onCommit: (value: string) => void
  placeholder?: string
  type: string
}) {
  const [draft, setDraft] = useState(canonical)
  return (
    <input
      className="input"
      onBlur={() => {
        if (draft !== canonical) {
          onCommit(draft)
        }
      }}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      type={type}
      value={draft}
    />
  )
}

function BlurTextarea({
  onCommit,
  value,
}: {
  onCommit: (value: string) => void
  value: string
}) {
  return <TextareaControl canonical={value} key={value} onCommit={onCommit} />
}

function TextareaControl({
  canonical,
  onCommit,
}: {
  canonical: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(canonical)
  return (
    <textarea
      className="input"
      onBlur={() => {
        if (draft !== canonical) {
          onCommit(draft)
        }
      }}
      onChange={(event) => setDraft(event.target.value)}
      rows={3}
      value={draft}
    />
  )
}

function ToggleField({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean
  description: string
  label: string
  onChange: (value: boolean) => void
}) {
  return (
    <label className="field toggle-field">
      <span className="toggle-label">
        <input
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <strong>{label}</strong>
      </span>
      <small className="field-helper">{description}</small>
    </label>
  )
}
