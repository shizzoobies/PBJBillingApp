import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Lock,
  Pencil,
  Trash2,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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

/* -------------------------------------------------------------------------- */
/* Per-field save confirmation                                                */
/* -------------------------------------------------------------------------- */

type SaveFlashState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Drives a small per-field "Saving… / Saved / Couldn't save" badge. Call
 * `flash()` the moment a field commits a change. It shows "Saving…", then
 * shortly after resolves to "Saved" (or "Couldn't save" if the workspace sync
 * has errored / gone offline). The authoritative error display is the global
 * sync indicator in the header — this is the reassuring near-the-field echo.
 */
function useSaveFlash(): { state: SaveFlashState; flash: () => void } {
  const { dataSyncState } = useAppContext()
  // Keep the latest sync state readable inside the deferred timer without
  // re-arming the timer on every state change.
  const syncRef = useRef(dataSyncState)
  const [state, setState] = useState<SaveFlashState>('idle')
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    syncRef.current = dataSyncState
  }, [dataSyncState])

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => window.clearTimeout(t))
      timersRef.current = []
    }
  }, [])

  const flash = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = []
    setState('saving')
    timersRef.current.push(
      window.setTimeout(() => {
        const s = syncRef.current
        const ok = s !== 'error' && s !== 'offline'
        setState(ok ? 'saved' : 'error')
        if (ok) {
          timersRef.current.push(window.setTimeout(() => setState('idle'), 1800))
        }
      }, 850),
    )
  }

  return { state, flash }
}

function SaveBadge({ state }: { state: SaveFlashState }) {
  if (state === 'idle') return null
  if (state === 'saving') {
    return <span className="save-badge save-badge-saving">Saving…</span>
  }
  if (state === 'saved') {
    return (
      <span className="save-badge save-badge-saved">
        <Check size={11} /> Saved
      </span>
    )
  }
  return <span className="save-badge save-badge-error">Couldn’t save</span>
}

/** Always-accurate workspace sync status shown in the page header. */
function SyncIndicator() {
  const { dataSyncState } = useAppContext()
  if (dataSyncState === 'saving') {
    return <span className="sync-indicator sync-saving">Saving…</span>
  }
  if (dataSyncState === 'synced') {
    return (
      <span className="sync-indicator sync-ok">
        <Check size={13} /> All changes saved
      </span>
    )
  }
  if (dataSyncState === 'error') {
    return <span className="sync-indicator sync-bad">Couldn’t save — retrying</span>
  }
  if (dataSyncState === 'offline') {
    return <span className="sync-indicator sync-bad">Offline — changes not saved</span>
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Collapsible + lockable section wrapper                                     */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a client-page panel with two owner conveniences:
 *  - Collapse: every section can be collapsed (expanded by default).
 *  - Lock: editable sections start LOCKED so fields can't be changed by
 *    accident. The owner clicks "Edit" to unlock, makes changes, then "Done".
 *    When locked, the body is rendered `inert` — every input/button/select
 *    inside is non-interactive and non-focusable without touching each control.
 *
 * `bare` children (the reimbursement cards) opt out of their own panel chrome
 * so they sit cleanly inside this wrapper.
 */
function ClientSection({
  kicker,
  title,
  headerAction,
  lockable = false,
  children,
}: {
  kicker?: string
  title: string
  headerAction?: ReactNode
  lockable?: boolean
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [locked, setLocked] = useState(true)

  return (
    <section className={`panel client-section${collapsed ? ' collapsed' : ''}`}>
      <div className="section-heading client-section-heading">
        <button
          type="button"
          className="section-collapse-btn"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          title={collapsed ? 'Expand section' : 'Collapse section'}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        </button>
        <div className="client-section-title">
          {kicker ? <p className="section-kicker">{kicker}</p> : null}
          <h2>{title}</h2>
        </div>
        <div className="client-section-actions">
          {headerAction}
          {lockable ? (
            <button
              type="button"
              className={`section-lock-btn${locked ? '' : ' unlocked'}`}
              onClick={() => setLocked((value) => !value)}
              title={locked ? 'Unlock to edit these fields' : 'Lock to prevent accidental edits'}
            >
              {locked ? (
                <>
                  <Pencil size={13} /> Edit
                </>
              ) : (
                <>
                  <Lock size={13} /> Done
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>
      {collapsed ? null : (
        <div
          className={`client-section-body${lockable && locked ? ' locked' : ''}`}
          inert={lockable && locked ? true : undefined}
        >
          {lockable && locked ? (
            <p className="section-locked-hint">
              <Lock size={12} /> Locked — click <strong>Edit</strong> to make changes.
            </p>
          ) : null}
          {children}
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

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
        <SyncIndicator />
      </div>

      <ClientSection
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
      </ClientSection>

      <ClientSection kicker="Contact" title="Contacts & address" lockable>
        <ContactSectionBody client={client} contacts={data.contacts} onCommit={commit} />
      </ClientSection>

      <ClientSection kicker="Visibility" title="Assigned team" lockable>
        <AssignedTeamField
          client={client}
          employees={data.employees}
          onLocalUpdate={(nextIds) => updateClient(client.id, { assignedBookkeeperIds: nextIds })}
          onError={setAssignedTeamError}
        />
        {assignedTeamError ? <p className="auth-error">{assignedTeamError}</p> : null}
      </ClientSection>

      <ClientSection kicker="Billing" title="Rate and services" lockable>
        <BillingSectionBody client={client} plans={data.plans} onCommit={commit} />
      </ClientSection>

      <ClientSection kicker="Expenses" title="Recurring reimbursements" lockable>
        <RecurringReimbursementsCard clientId={client.id} bare />
      </ClientSection>

      <ClientSection kicker="Expenses" title="Expenses & reimbursements" lockable>
        <ReimbursementsCard clientId={client.id} bare />
      </ClientSection>

      <ClientSection kicker="Branding" title="Logo" lockable>
        <BrandingSectionBody client={client} onCommit={commit} />
      </ClientSection>

      <ClientSection kicker="Invoice settings" title="Invoice customization" lockable>
        <InvoiceSettingsSectionBody client={client} onCommit={commit} />
      </ClientSection>

      <ClientSection kicker="Work in flight" title="Active checklists">
        <ActiveChecklistsBody client={client} data={data} />
      </ClientSection>

      <ClientSection kicker="Schedule" title="Recurring checklists">
        <RecurringChecklistsBody client={client} data={data} />
      </ClientSection>

      <ClientSection kicker="Activity" title="Recent work for this client">
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
      </ClientSection>
    </section>
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
        <NameInput
          canonical={client.name}
          onCommit={(value) => {
            onCommit({ name: value })
            flash()
          }}
        />
      </h2>
    </div>
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
  const [prev, setPrev] = useState(canonical)
  const [focused, setFocused] = useState(false)
  if (canonical !== prev) {
    setPrev(canonical)
    if (!focused) setValue(canonical)
  }
  return (
    <input
      aria-label="Client name"
      className="title-input"
      onFocus={() => setFocused(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      onBlur={() => {
        setFocused(false)
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
  return (
    <div className="form-grid two-col">
      <ChipField
        label="Contacts"
        selectedIds={client.contactIds ?? []}
        options={contacts.map((entry) => ({ id: entry.id, label: entry.name }))}
        onCommit={(nextIds) => onCommit({ contactIds: nextIds })}
        addLabel="+ Add contact"
        emptyHelper="No contacts selected. Manage the shared list on the Contacts page."
      />
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

  return (
    <div className="form-grid two-col">
      <SelectField
        label="Billing type"
        value={client.billingMode}
        onCommit={(value) => onCommit({ billingMode: value as BillingMode })}
        options={[
          { value: 'hourly', label: 'Hourly' },
          { value: 'subscription', label: 'Monthly' },
        ]}
      />
      {isMonthly ? (
        <NumberField
          key="monthly-rate"
          label="Monthly rate"
          step="0.01"
          min="0"
          value={client.monthlyRate ?? 0}
          onCommit={(next) => onCommit({ monthlyRate: next })}
          helper="The fixed monthly amount billed to this client."
        />
      ) : (
        <NumberField
          key="hourly-rate"
          label="Hourly rate"
          step="0.01"
          min="0"
          value={client.hourlyRate}
          onCommit={(next) => onCommit({ hourlyRate: next })}
          helper="Used to bill every billable hour worked for this client."
        />
      )}
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
      <TextareaField
        label="Invoice footer note"
        onCommit={(value) => onCommit({ footerNote: value })}
        value={client.footerNote ?? ''}
      />
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
  )
}

/* -------------------------------------------------------------------------- */
/* Read-only sections (checklists, activity)                                  */
/* -------------------------------------------------------------------------- */

function ActiveChecklistsBody({ client, data }: { client: Client; data: AppData }) {
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

  if (checklists.length === 0) {
    return <p className="muted-text">No active checklists for this client.</p>
  }

  return (
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
  )
}

function RecurringChecklistsBody({ client, data }: { client: Client; data: AppData }) {
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
        template.title.toLowerCase().includes(q) || freq.includes(q) || assignee.includes(q)
      )
    })
  }, [templates, query, data.employees])

  if (templates.length === 0) {
    return <p className="muted-text">No recurring checklists assigned to this client.</p>
  }

  return (
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
  )
}

/* -------------------------------------------------------------------------- */
/* Reusable editable field wrappers (each owns its own Saved badge)           */
/* -------------------------------------------------------------------------- */

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
  const { state, flash } = useSaveFlash()
  return (
    <label className="field">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <TextInputControl
        canonical={value}
        onCommit={(next) => {
          onCommit(next)
          flash()
        }}
        placeholder={placeholder}
        type={type ?? 'text'}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

function TextareaField({
  label,
  onCommit,
  value,
}: {
  label: string
  onCommit: (value: string) => void
  value: string
}) {
  const { state, flash } = useSaveFlash()
  return (
    <label className="field full-row">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <TextareaControl
        canonical={value}
        onCommit={(next) => {
          onCommit(next)
          flash()
        }}
      />
    </label>
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
  const { state, flash } = useSaveFlash()
  return (
    <label className="field">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <NumberInputControl
        canonical={value}
        min={min}
        step={step}
        onCommit={(next) => {
          if (next === null) return
          onCommit(next)
          flash()
        }}
      />
      {helper ? <small className="field-helper">{helper}</small> : null}
    </label>
  )
}

function SelectField({
  label,
  value,
  options,
  onCommit,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onCommit: (value: string) => void
}) {
  const { state, flash } = useSaveFlash()
  return (
    <label className="field">
      <span className="field-label-row">
        {label}
        <SaveBadge state={state} />
      </span>
      <select
        className="input"
        value={value}
        onChange={(event) => {
          onCommit(event.target.value)
          flash()
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

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
  const { state, flash } = useSaveFlash()
  return (
    <label className="field toggle-field">
      <span className="toggle-label">
        <input
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked)
            flash()
          }}
          type="checkbox"
        />
        <strong>{label}</strong>
        <SaveBadge state={state} />
      </span>
      <small className="field-helper">{description}</small>
    </label>
  )
}

/* -------------------------------------------------------------------------- */
/* Low-level inputs: commit on debounce + Enter + blur, resync when idle       */
/* -------------------------------------------------------------------------- */

// Commit shortly after typing stops (in addition to blur + Enter) so a value
// reliably saves even if the field is left without an explicit blur (e.g. a
// quick refresh or navigation). Resyncs to the canonical value when it changes
// upstream AND the field isn't being actively edited.
const COMMIT_DEBOUNCE_MS = 700

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
  const [prev, setPrev] = useState(canonical)
  const [focused, setFocused] = useState(false)
  const timerRef = useRef<number | null>(null)

  if (canonical !== prev) {
    setPrev(canonical)
    if (!focused) setDraft(canonical)
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const fire = (value: string) => {
    if (value !== canonical) onCommit(value)
  }

  return (
    <input
      className="input"
      type={type}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => fire(next), COMMIT_DEBOUNCE_MS)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      onBlur={() => {
        setFocused(false)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        fire(draft)
      }}
    />
  )
}

function TextareaControl({
  canonical,
  onCommit,
}: {
  canonical: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(canonical)
  const [prev, setPrev] = useState(canonical)
  const [focused, setFocused] = useState(false)
  const timerRef = useRef<number | null>(null)

  if (canonical !== prev) {
    setPrev(canonical)
    if (!focused) setDraft(canonical)
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const fire = (value: string) => {
    if (value !== canonical) onCommit(value)
  }

  return (
    <textarea
      className="input"
      rows={3}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => fire(next), COMMIT_DEBOUNCE_MS)
      }}
      onBlur={() => {
        setFocused(false)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        fire(draft)
      }}
    />
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
  const [prev, setPrev] = useState(canonical)
  const [focused, setFocused] = useState(false)
  const timerRef = useRef<number | null>(null)

  if (canonical !== prev) {
    setPrev(canonical)
    if (!focused) setDraft(canonical === null ? '' : String(canonical))
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const fire = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (canonical !== null) onCommit(null)
      return
    }
    const parsed = Number(trimmed)
    if (Number.isNaN(parsed)) return
    if (parsed !== canonical) onCommit(parsed)
  }

  return (
    <input
      className="input"
      min={min ?? '0'}
      step={step ?? '0.01'}
      type="number"
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (timerRef.current) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => fire(next), COMMIT_DEBOUNCE_MS)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      onBlur={() => {
        setFocused(false)
        if (timerRef.current) window.clearTimeout(timerRef.current)
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
        if (parsed !== canonical) onCommit(parsed)
      }}
    />
  )
}
