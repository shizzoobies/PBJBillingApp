import {
  Archive,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Pencil,
  Plus,
  RotateCcw,
  Timer,
  Trash2,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChecklistCard, NewTaskForm } from './ChecklistsPage'
import { SectionScopeContext } from '../components/sectionScope'
import { AssignedTeamControl } from '../components/AssignedTeamControl'
import { BilledOnCard } from '../components/BilledOnCard'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { ClientTimeModal } from '../components/ClientTimeModal'
import { RecurringReimbursementsCard } from '../components/RecurringReimbursementsCard'
import { ReimbursementsCard } from '../components/ReimbursementsCard'
import { projectUpcomingChecklists } from '../lib/projectRecurring'
import { isInactiveClient, markInactiveConfirm } from '../lib/clientLifecycle'
import {
  activeChecklistsForClient,
  CLIENT_SECTION_ANCHORS,
  resolveClientSection,
  summarizeClientMonthTime,
  type ClientMonthTime,
  type ClientSection,
} from '../lib/clientSections'
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
  issueRetainerInvoiceRequest,
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
  type Checklist,
  type ChecklistFrequency,
  type ChecklistTemplate,
  type Client,
  type Contact,
  type Employee,
  type SubscriptionPlan,
  type TimeBreakdownMode,
  type TimeEntry,
} from '../lib/types'
// The one place 'off' is decided, shared with the generator and the invoice
// preview so all three agree about what an unset client means.
import { normalizeTimeBreakdownMode } from '../../lib/invoice-lines.js'
import {
  addDays,
  clientName,
  currency,
  effectiveSessions,
  emailForClient,
  ensureTemplateStages,
  employeeName,
  formatAuditStamp,
  formatDecimalHours,
  formatHoursMinutes,
  getChecklistFrequencyLabel,
  isDueThisMonth,
  isSafeImageSrc,
  localDateOnly,
  makeId,
  missingPlanTemplatesForClient,
  MONTH_NAMES,
  normalizeBillingMonth,
  planTemplates,
  sessionMinutes,
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
  const { data, ownerMode, sessionUser, updateClient, deleteClient, setClientLifecycle } =
    useAppContext()
  const [assignedTeamError, setAssignedTeamError] = useState('')
  // Whether the shared "Track time" modal is open for this client.
  const [trackingTime, setTrackingTime] = useState(false)
  // True while a retire/reactivate round-trip is in flight.
  const [lifecycleBusy, setLifecycleBusy] = useState(false)

  const client = useMemo(
    () => data.clients.find((entry) => entry.id === clientId),
    [data.clients, clientId],
  )

  // Activity-record debounce: only fire one event per ~60s of editing.
  const lastActivityRef = useRef<number>(0)

  // ---- Which tab is open --------------------------------------------------
  // DERIVED from the URL, not stored in state, so a deep link always wins.
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()

  const today = localDateOnly()
  // Both tab counts are computed from the SAME helper the tab body lists with,
  // so a label can never contradict what is under it.
  const openChecklistCount = useMemo(
    () => activeChecklistsForClient(data.checklists, client?.id ?? '', today).length,
    [data.checklists, client?.id, today],
  )
  const monthTime = useMemo(
    () => summarizeClientMonthTime(data.timeEntries, client?.id ?? '', today.slice(0, 7)),
    [data.timeEntries, client?.id, today],
  )

  // Billing is entirely owner-only panels, so staff never get the tab at all —
  // the same `ownerMode` guard that wraps those panels, applied to navigation.
  const tabs: Array<{ key: ClientSection; label: string; count?: number }> = [
    { key: 'overview', label: 'Overview' },
    ...(ownerMode ? [{ key: 'billing' as const, label: 'Billing' }] : []),
    { key: 'checklists', label: 'Checklists', count: openChecklistCount },
    { key: 'time', label: 'Time', count: monthTime.entryCount },
  ]

  const activeSection = resolveClientSection({
    tabParam: searchParams.get('tab'),
    hash: location.hash,
    available: tabs.map((tab) => tab.key),
  })

  // Always WRITE the param, even for Overview: the resolver reads the URL on
  // every render, so a tab click that left no trace would not survive one.
  const setSection = (next: ClientSection) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

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

  const retired = isInactiveClient(client)

  const handleLifecycle = async (stage: 'inactive' | 'active') => {
    if (stage === 'inactive' && !window.confirm(markInactiveConfirm(client.name))) return
    setLifecycleBusy(true)
    try {
      await setClientLifecycle(client.id, stage)
    } finally {
      setLifecycleBusy(false)
    }
  }

  const recentChecklists = sortChecklists(
    data.checklists.filter((checklist) => checklist.clientId === client.id),
  ).slice(0, 8)

  return (
    <SectionScopeContext.Provider value={`client:${client.id}:`}>
    <section className="client-detail">
      <div className="client-detail-header">
        <Link className="back-link" to="/clients">
          <ArrowLeft size={14} />
          Back to clients
        </Link>
        {/* A retired client's page stays fully readable — every tab, every
            entry, every invoice. The banner exists so nobody wonders why this
            client has vanished from their dropdowns, and it carries the one
            action that undoes it. */}
        {retired ? (
          <div className="client-inactive-banner" role="status">
            <span className="lifecycle-badge lifecycle-badge-inactive">Inactive</span>
            <span>
              This client is inactive. Their full history is here, but they are hidden from
              client lists and pickers, no new time or checklists are generated for them, and
              they are skipped by the monthly invoice run.
            </span>
            {ownerMode ? (
              <button
                type="button"
                className="secondary-action"
                disabled={lifecycleBusy}
                onClick={() => handleLifecycle('active')}
              >
                <RotateCcw size={14} /> {lifecycleBusy ? 'Saving…' : 'Reactivate'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Overview / Billing / Checklists / Time. Navigation only: every panel
          below renders exactly as it did, it is just no longer stacked into one
          very long scroll. */}
      <div className="task-area-tabs" role="tablist" aria-label="Client sections">
        {tabs.map((tab) => {
          const isActive = tab.key === activeSection
          const classes = [
            'task-area-tab',
            isActive ? 'is-active' : '',
            tab.count === 0 ? 'is-empty' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={classes}
              onClick={() => setSection(tab.key)}
            >
              {tab.label}
              {tab.count === undefined ? null : (
                <span className="task-area-tab-count">{tab.count}</span>
              )}
            </button>
          )
        })}
      </div>

      {activeSection === 'overview' ? (
      <div className="client-tab-panel" id={CLIENT_SECTION_ANCHORS.overview} role="tabpanel">
      {ownerMode ? (
        <CollapsibleSection
          id="client-section-profile"
          kicker="Client profile"
          title="Client name"
          lockable
          headerAction={
            <div className="button-row">
              {/* Sits beside Delete on purpose: this is the answer for the
                  client who has left but whose books you still need. Retiring
                  keeps everything; deleting does not. */}
              {retired ? (
                <button
                  className="secondary-action"
                  disabled={lifecycleBusy}
                  onClick={() => handleLifecycle('active')}
                  type="button"
                >
                  <RotateCcw size={14} />
                  {lifecycleBusy ? 'Saving…' : 'Reactivate'}
                </button>
              ) : (
                <button
                  className="secondary-action"
                  disabled={lifecycleBusy}
                  onClick={() => handleLifecycle('inactive')}
                  title="Retire this client: hide them from lists and pickers, keeping all their history"
                  type="button"
                >
                  <Archive size={14} />
                  {lifecycleBusy ? 'Saving…' : 'Mark inactive'}
                </button>
              )}
              <button className="danger-action" onClick={handleDelete} type="button">
                <Trash2 size={14} />
                Delete client
              </button>
            </div>
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

          <CollapsibleSection id="client-section-branding" kicker="Branding" title="Logo" lockable>
            <BrandingSectionBody client={client} onCommit={commit} />
          </CollapsibleSection>
        </>
      ) : null}

      <CollapsibleSection id="client-section-notes" kicker="Notes" title="Client notes">
        <ClientNotesPanel clientId={client.id} ownerMode={ownerMode} currentUserId={sessionUser.id} />
      </CollapsibleSection>
      </div>
      ) : null}

      {/* Owner-only in full: staff never get this tab, because every panel in
          it is one they could not see before either. */}
      {activeSection === 'billing' && ownerMode ? (
        <div className="client-tab-panel" id={CLIENT_SECTION_ANCHORS.billing} role="tabpanel">
          {/* FIRST in the tab, and only for a company whose work is billed
              elsewhere: everything under it — rate, plans, reimbursements —
              feeds someone else's document, and reading those panels without
              knowing that is how "why has this client never been invoiced?"
              starts. */}
          {client.billToClientId ? (
            <CollapsibleSection
              id="client-section-billed-on"
              kicker="Billing"
              title="Billed on"
              lockable
            >
              {/* Keyed by client: navigating from one company to another is a
                  fresh card, never last company's invoices under this one's
                  heading while the new fetch is in the air. */}
              <BilledOnCard
                key={client.id}
                clientId={client.id}
                masterName={
                  data.clients.find((entry) => entry.id === client.billToClientId)?.name ?? null
                }
              />
            </CollapsibleSection>
          ) : null}

          <CollapsibleSection id="client-section-billing" kicker="Billing" title="Rate and services" lockable>
            <BillingSectionBody client={client} plans={data.plans} onCommit={commit} />
          </CollapsibleSection>

          <CollapsibleSection id="client-section-plan-checklists" kicker="Billing" title="Plan checklists" lockable>
            <PlanChecklistsBody client={client} data={data} />
          </CollapsibleSection>

          {/* A billing master collects nothing of its own — "no data entered or
              collected but shows data for the 4 combined". The server refuses
              reimbursement writes against one, so these two add-forms would be
              a pair of doors that only ever answer no. They are the surfaces
              the plan meant by "hide those surfaces in the UI for a master";
              each company's own page keeps both, unchanged. */}
          {client.isBillingMaster ? null : (
            <>
              <CollapsibleSection id="client-section-expenses" kicker="Expenses" title="Recurring reimbursements" lockable>
                <RecurringReimbursementsCard clientId={client.id} bare />
              </CollapsibleSection>

              <CollapsibleSection kicker="Expenses" title="Expenses & reimbursements" lockable>
                <ReimbursementsCard clientId={client.id} bare />
              </CollapsibleSection>
            </>
          )}

          <CollapsibleSection id="client-section-invoice" kicker="Invoice settings" title="Invoice customization" lockable>
            <InvoiceSettingsSectionBody client={client} onCommit={commit} />
          </CollapsibleSection>

          <CollapsibleSection
            id="client-section-retainer"
            kicker="Engagement"
            title="Retainer invoice"
            lockable
          >
            <RetainerSectionBody client={client} />
          </CollapsibleSection>
        </div>
      ) : null}

      {activeSection === 'checklists' ? (
        <div className="client-tab-panel" id={CLIENT_SECTION_ANCHORS.checklists} role="tabpanel">
          <CollapsibleSection id="client-section-checklists" kicker="Work in flight" title="Active checklists">
            <ActiveChecklistsBody client={client} data={data} />
          </CollapsibleSection>

          <CollapsibleSection id="client-section-recurring" kicker="Schedule" title="Recurring checklists">
            <RecurringChecklistsBody client={client} data={data} />
          </CollapsibleSection>

          {/* The other half of what used to be "Recent work for this client" —
              its time column now has a whole tab of its own. */}
          <CollapsibleSection id="client-section-activity" kicker="Activity" title="Recent checklists">
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
          </CollapsibleSection>
        </div>
      ) : null}

      {activeSection === 'time' ? (
        <div className="client-tab-panel" id={CLIENT_SECTION_ANCHORS.time} role="tabpanel">
          <CollapsibleSection id="client-section-time" kicker="Activity" title="Time for this client">
            <ClientTimeBody
              client={client}
              data={data}
              month={monthTime}
              onTrackTime={() => setTrackingTime(true)}
              // Every entry below still lists in full; only the button that
              // would log a NEW one goes away.
              canTrackTime={!retired}
            />
          </CollapsibleSection>
        </div>
      ) : null}

      {trackingTime ? (
        <ClientTimeModal client={client} onClose={() => setTrackingTime(false)} />
      ) : null}
    </section>
    </SectionScopeContext.Provider>
  )
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How many entries the Time tab shows before "Show all". Not a hard cap — the
 * rest are one click away, and the list scrolls inside its own box either way.
 * A silent 8-entry cap on the old activity list hid older work from anyone who
 * logged more than a week of it.
 */
const RECENT_TIME_PREVIEW = 12

/**
 * This client's time, from the entries the viewer ALREADY holds — a
 * bookkeeper's `/api/app-data` is scoped to their own entries, so the server
 * decides what appears here and this adds no request of its own. Read-only:
 * editing an entry still lives on the Time page, which owns the lock and
 * approval rules.
 */
function ClientTimeBody({
  client,
  data,
  month,
  onTrackTime,
  canTrackTime,
}: {
  client: Client
  data: AppData
  /** This month's totals — the same numbers the Time tab's count label uses. */
  month: ClientMonthTime
  onTrackTime: () => void
  /** False for a retired client: read their time, don't log more of it. */
  canTrackTime: boolean
}) {
  const [showAll, setShowAll] = useState(false)

  const entries = useMemo(
    () =>
      data.timeEntries
        .filter((entry) => entry.clientId === client.id)
        .slice()
        .sort(
          (left, right) =>
            right.date.localeCompare(left.date) ||
            (right.createdAt ?? '').localeCompare(left.createdAt ?? ''),
        ),
    [data.timeEntries, client.id],
  )
  const shown = showAll ? entries : entries.slice(0, RECENT_TIME_PREVIEW)

  return (
    <div>
      <div className="client-time-summary">
        <div className="client-time-summary-item">
          {/* Summary totals for reading/analysis — two decimals. The per-entry
              and per-session rows below stay in h/m: they are individual pieces
              of work, where "23m" reads better than "0.38h". */}
          <strong>{formatDecimalHours(month.trackedMinutes)}</strong>
          <span>Tracked this month</span>
        </div>
        <div className="client-time-summary-item">
          <strong>{formatDecimalHours(month.billableMinutes)}</strong>
          <span>Billable this month</span>
        </div>
        <div className="client-time-summary-item">
          <strong>{month.entryCount}</strong>
          <span>{month.entryCount === 1 ? 'Entry this month' : 'Entries this month'}</span>
        </div>
      </div>

      <div className="button-row">
        {canTrackTime ? (
          <button type="button" className="primary-action" onClick={onTrackTime}>
            <Timer size={14} /> Track time
          </button>
        ) : null}
        <Link to="/time" className="secondary-action">
          Open Time page
        </Link>
      </div>

      {entries.length === 0 ? (
        <p className="muted-text">No time logged for this client yet.</p>
      ) : (
        <>
          <div className="entry-list entry-list--scroll">
            {shown.map((entry) => (
              <ClientTimeEntryRow
                key={entry.id}
                entry={entry}
                employeeLabel={employeeName(data.employees, entry.employeeId)}
                checklists={data.checklists}
              />
            ))}
          </div>
          {entries.length > RECENT_TIME_PREVIEW ? (
            <button
              type="button"
              className="link-action"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll
                ? `Show latest ${RECENT_TIME_PREVIEW}`
                : `Show all ${entries.length} entries`}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

/** One entry, read-only, in the Time page's own row idiom. */
function ClientTimeEntryRow({
  entry,
  employeeLabel,
  checklists,
}: {
  entry: TimeEntry
  employeeLabel: string
  checklists: Checklist[]
}) {
  // Clock in/out for the audit — falls back to the startAt/endAt envelope so
  // timer and legacy entries show their times here too.
  const sessions = effectiveSessions(entry)
  const linkedTask = entry.taskId
    ? checklists.find((checklist) => checklist.id === entry.taskId)
    : null
  const taskTitle = linkedTask ? linkedTask.title : entry.taskLabel?.trim() || null
  const statusLabel =
    entry.approvalStatus === 'approved'
      ? 'Approved'
      : entry.approvalStatus === 'rejected'
        ? 'Rejected'
        : 'Pending'

  return (
    <article className="entry-row">
      <div>
        <strong>{employeeLabel}</strong>
        <span>{entry.description}</span>
        <small>{shortDate.format(new Date(`${entry.date}T12:00:00`))}</small>
        {sessions.length > 0 ? (
          <div className="entry-sessions">
            {sessions.map((session, index) => (
              <small className="entry-audit-times" key={`${session.startAt}-${index}`}>
                {sessions.length > 1 ? `${index + 1}. ` : ''}
                {formatAuditStamp(session.startAt)} → {formatAuditStamp(session.endAt)} ·{' '}
                {formatHoursMinutes(sessionMinutes(session))}
              </small>
            ))}
          </div>
        ) : null}
        <div className="entry-tags">
          <span className={`time-status-pill time-status-${entry.approvalStatus}`}>
            {statusLabel}
          </span>
          {entry.entryMethod === 'manual' ? <span className="manual-badge">Manual</span> : null}
          {taskTitle ? <span className="task-chip">Task: {taskTitle}</span> : null}
        </div>
        {entry.approvalStatus === 'rejected' && entry.approvalNote ? (
          <small className="entry-reject-note">Rejected: {entry.approvalNote}</small>
        ) : null}
      </div>
      <div className="entry-meta">
        <strong>{formatHoursMinutes(entry.minutes)}</strong>
        <span>{entry.billable ? 'Billable' : 'Internal'}</span>
      </div>
    </article>
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
/* Retainer invoice                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Issue the retainer invoice that opens an engagement.
 *
 * MANUAL, and it lives here rather than in the month run because that is what
 * it actually is: the app has no idea when an engagement letter comes back
 * signed, so this button IS that event. One amount, an optional note, and a
 * confirm — everything after it is the ordinary invoice life, on the Invoices
 * page, so this deliberately does not grow a second editor.
 */
function RetainerSectionBody({ client }: { client: Client }) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<string | null>(null)

  const value = Number(amount)
  const valid = Number.isFinite(value) && value > 0

  const issue = async () => {
    if (!valid) return
    // A money document going out under a number that is then real. Worth one
    // question, because there is no delete — the way back is voiding it.
    if (
      !window.confirm(
        `Issue a ${currency.format(value)} retainer invoice for ${client.name}? ` +
          'It appears as a draft on the Invoices page, where you review and send it like any other.',
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    setIssued(null)
    try {
      const invoice = await issueRetainerInvoiceRequest(client.id, value, note.trim() || undefined)
      setIssued(invoice.number ?? invoice.id)
      setAmount('')
      setNote('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue the retainer invoice.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="retainer-issue">
      <p className="retainer-issue-help">
        Issue this once the engagement letter is signed. When the engagement ends, the paid
        retainer is offered back as a credit on the invoice you choose — you decide which one.
      </p>
      <div className="form-grid two-col">
        <label className="field">
          <span>Retainer amount</span>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            placeholder="0.00"
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <input
            className="input"
            value={note}
            placeholder="Shown on the invoice line"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </div>
      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}
      {issued ? (
        <p className="invoice-run-note">
          Issued {issued} as a draft. Review and send it from the Invoices page.
        </p>
      ) : null}
      <button
        type="button"
        className="secondary-action"
        disabled={busy || !valid}
        title={valid ? 'Issue a retainer invoice for this client' : 'Enter an amount first'}
        onClick={() => void issue()}
      >
        {busy ? 'Issuing…' : 'Issue retainer invoice…'}
      </button>
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
      {/* Her control, and the whole of featreq-…: off unless she turns it on,
          and then at the level of detail she picks. The lines this adds are
          informational — they never change what the client owes — so there is
          no confirm and no warning here; the worst it can do is say too much. */}
      <SaveSelectField
        label="Time breakdown on the invoice"
        value={normalizeTimeBreakdownMode(client.invoiceTimeBreakdownMode)}
        onCommit={(value) =>
          onCommit({ invoiceTimeBreakdownMode: value as TimeBreakdownMode })
        }
        options={[
          { value: 'off', label: 'Off — no time on the invoice' },
          { value: 'person', label: 'One line per person (total hours)' },
          { value: 'day', label: 'Per person, per day' },
          { value: 'week', label: 'Per person, per week' },
          { value: 'entry', label: 'Every entry for the month' },
        ]}
      />
      {normalizeTimeBreakdownMode(client.invoiceTimeBreakdownMode) !== 'off' ? (
        <SaveToggleField
          checked={client.invoiceTimeBreakdownAmounts ?? false}
          description="Add what each line of time was worth. It is shown for information only — the invoice total does not change."
          label="Show amounts on the breakdown"
          onChange={(value) => onCommit({ invoiceTimeBreakdownAmounts: value })}
        />
      ) : null}
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
      {/* Off for everyone until someone turns it on for one client. Bank
          transfer stays the default and the no-fee channel either way. */}
      <SaveToggleField
        checked={client.cardPaymentsEnabled ?? false}
        description="Also offer a card option in the emailed invoice. The client pays the card processing fee, so the firm still receives the invoice total in full."
        label="Pay by card"
        onChange={(value) => onCommit({ cardPaymentsEnabled: value })}
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
    visibleChecklists,
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
  // excluded here. Overdue / In progress / Not started all remain. Shared with
  // the Checklists tab's count so the two can't disagree.
  //
  // Sourced from `visibleChecklists`, NOT `data.checklists`: on a client two
  // people share, `data.checklists` carries both of their tasks (that read
  // scope is deliberate), so this panel used to hand a bookkeeper a fully
  // editable card for a colleague's active checklist. `visibleChecklists` is
  // the same "mine" set the Checklists tab's In-progress list uses — owners
  // still get everything.
  const checklists = sortChecklists(
    activeChecklistsForClient(visibleChecklists, client.id, today),
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
    // For staff this is now a statement about THEM, not the client — a
    // colleague may well have live work here that is none of their business.
    return (
      <p className="muted-text">
        {ownerMode ? 'No active checklists for this client.' : 'No active task at this time'}
      </p>
    )
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
          hideClientName
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

  // Read-only projection of the recurring instances coming up for THIS client
  // over the next ~2 months — the same engine the Board/Gantt use (pure, never
  // persisted). Lets a team member see what's on the way, not just the recipes.
  const today = localDateOnly()
  const upcoming = useMemo(
    () =>
      projectUpcomingChecklists(data, {
        fromDateOnly: today,
        horizonEndDateOnly: addDays(today, 60),
      })
        .filter((ghost) => ghost.clientId === client.id)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [data, client.id, today],
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

  // A retired client's existing recipes stay listed below (they are history,
  // and they come back live the moment the client is reactivated) — but there
  // is no point authoring a new one that the materializer will skip.
  const retired = isInactiveClient(client)

  return (
    <>
      {ownerMode && !adding && !retired ? (
        <div className="recurring-add-row">
          <button type="button" className="primary-action" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add recurring checklist
          </button>
          <button type="button" className="secondary-action" onClick={() => setPicking(true)}>
            <Copy size={14} /> Add from existing
          </button>
        </div>
      ) : null}
      {retired ? (
        <p className="muted-text">
          This client is inactive, so no new checklists are generated for them. Their recipes are
          kept below and resume if the client is reactivated.
        </p>
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

      {upcoming.length > 0 ? (
        <div className="recurring-upcoming">
          <h3 className="mini-heading">Upcoming (next 60 days)</h3>
          <ul className="active-checklist-list">
            {upcoming.map((ghost) => (
              <li key={ghost.id} className="active-checklist-row">
                <div className="active-checklist-main">
                  <strong>{ghost.title}</strong>
                  <span className="upcoming-badge">Upcoming</span>
                </div>
                <div className="active-checklist-meta">
                  <span>Due {shortDate.format(new Date(`${ghost.dueDate}T12:00:00`))}</span>
                  <span>{employeeName(data.employees, ghost.assigneeId)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
        {/* The title links to the full editor on the Checklists page, which is
            owner-only — so staff get plain text (no dead-end link). */}
        {canEdit ? (
          <Link to={jumpTo} className="active-checklist-link">
            <strong>{template.title}</strong>
          </Link>
        ) : (
          <strong>{template.title}</strong>
        )}
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
        {/* "Items" jumps to the owner-only editor — owners only; staff see the
            actual steps on the generated checklists in "Active checklists". */}
        {canEdit ? (
          <Link to={jumpTo} className="active-checklist-link">
            Items <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
          </Link>
        ) : null}
      </div>
    </li>
  )
}
