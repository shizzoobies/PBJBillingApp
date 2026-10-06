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
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChecklistCard, NewTaskForm } from './ChecklistsPage'
import { SectionScopeContext } from '../components/sectionScope'
import { AssignedTeamControl } from '../components/AssignedTeamControl'
import { AutopayPanel } from '../components/AutopayPanel'
import { BilledOnCard } from '../components/BilledOnCard'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { ClientTimeModal } from '../components/ClientTimeModal'
import { RecurringReimbursementsCard } from '../components/RecurringReimbursementsCard'
import { ReimbursementsCard } from '../components/ReimbursementsCard'
import { projectUpcomingChecklists } from '../lib/projectRecurring'
import { cloneChecklistTemplate } from '../lib/cloneChecklistTemplate'
import { inactiveClientIdSet, isInactiveClient, markInactiveConfirm } from '../lib/clientLifecycle'
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
  type ClientRetainer,
  applyPackageRequest,
  fetchClientInvoiceCount,
  fetchRateVersions,
  issueRetainerInvoiceRequest,
  listClientRetainersRequest,
  listPackagesRequest,
  recordClientProfileActivity,
  setClientAssignedTeamRequest,
  setClientInvoiceNote,
  setClientHourlyRatePeriod,
} from '../lib/api'
import { applyPackageConfirmText, packagesCoveringPlans } from '../lib/packages'
import { ClientNotesPanel } from '../components/ClientNotesPanel'
import { useAttachedClientNotes } from '../hooks/useAttachedClientNotes'
import { pendingNoteCount as pendingNoteCountOf, useClientPendingNotes } from '../hooks/useClientPendingNotes'
import { ClientStatementsPanel } from '../components/ClientStatementsPanel'
import { useSaveFlash } from '../lib/useSaveFlash'
import {
  ApiError,
  MONTHLY_SERVICE_TIERS,
  type AppData,
  type BillingMode,
  type BillRateVersion,
  type Checklist,
  type ChecklistFrequency,
  type ChecklistTemplate,
  type Client,
  type Contact,
  type Employee,
  type Package,
  type SubscriptionPlan,
  type TimeBreakdownMode,
  type TimeEntry,
} from '../lib/types'
// The one place 'off' is decided, shared with the generator and the invoice
// preview so all three agree about what an unset client means.
import { normalizeTimeBreakdownMode } from '../../lib/invoice-lines.js'
import { mailingAddressLines } from '../../lib/mailing-address.js'
// The one rule for whether Delete is offered; the server enforces the same one.
import { clientDeleteVerdict } from '../../lib/client-delete-rule.js'
import { dateOnlyInZone } from '../../lib/firm-time.js'
import { retainerPosition } from '../lib/retainerPosition'
// The one resolver for "what did this person's hour bill at back then" —
// shared with the invoice, so the block below can never quote a rate the
// invoice would not charge.
import { billRateAt } from '../../lib/rate-history.js'
import {
  addDays,
  clientName,
  currency,
  effectiveSessions,
  emailForClient,
  employeeName,
  formatAuditStamp,
  formatDecimalHours,
  formatHoursMinutes,
  getBillingPeriodLabel,
  getChecklistFrequencyLabel,
  INVOICE_NOTE_MAX_LENGTH,
  isDueThisMonth,
  isSafeImageSrc,
  localDateOnly,
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
/* Client notes section                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The "Client notes" section, with the pending-notes count pill in its HEADER
 * (featreq-b688e73c). The pending notes are owned HERE, not by the notes box:
 * a CollapsibleSection unmounts its children when collapsed, so a count that
 * the box fetched and reported up would vanish exactly when the section is
 * folded away. The box is handed this state rather than fetching its own.
 */
export function ClientNotesSection({
  clientId,
  ownerMode,
  currentUserId,
}: {
  clientId: string
  ownerMode: boolean
  currentUserId: string
}) {
  const pendingNotesState = useClientPendingNotes(clientId)
  const waiting = pendingNoteCountOf(pendingNotesState.notes)
  return (
    <CollapsibleSection
      id="client-section-notes"
      kicker="Notes"
      title="Client notes"
      headerAction={
        waiting > 0 ? (
          <span className="pending-note-count-pill">{waiting} waiting for a checklist</span>
        ) : undefined
      }
    >
      <ClientNotesPanel
        clientId={clientId}
        ownerMode={ownerMode}
        currentUserId={currentUserId}
        pendingState={pendingNotesState}
      />
    </CollapsibleSection>
  )
}

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

  // Whether this client may be deleted (lib/client-delete-rule.js). Time is
  // known locally; invoices are not in the workspace payload, so they are asked
  // of the server - and only when there is no time, since time already decides.
  // Until that answer arrives the verdict is unknown and Delete is not offered.
  const hasTime = useMemo(
    () => (data.timeEntries ?? []).some((entry) => entry.clientId === clientId),
    [data.timeEntries, clientId],
  )
  // The answer carries the client it is about, so one fetched for the previous
  // client can never be read as this one's.
  const [invoiceAnswer, setInvoiceAnswer] = useState<{ id: string; count: number } | null>(null)
  const invoiceCount = invoiceAnswer && invoiceAnswer.id === clientId ? invoiceAnswer.count : null
  useEffect(() => {
    if (!ownerMode || !clientId || hasTime) return
    let cancelled = false
    fetchClientInvoiceCount(clientId)
      .then((count) => {
        if (!cancelled) setInvoiceAnswer({ id: clientId, count })
      })
      .catch(() => {
        // Unknown stays unknown: Delete stays hidden, and the server refuses
        // the delete on its own regardless.
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode, clientId, hasTime])
  const deleteVerdict = hasTime
    ? clientDeleteVerdict({ timeEntryCount: 1 })
    : invoiceCount === null
      ? null
      : clientDeleteVerdict({ invoiceCount })

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
        `Delete ${client.name}? This permanently removes the client and its checklists, recurring checklists and reimbursements. This cannot be undone.`,
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
              {deleteVerdict?.deletable ? (
                <button className="danger-action" onClick={handleDelete} type="button">
                  <Trash2 size={14} />
                  Delete client
                </button>
              ) : null}
              {deleteVerdict && !deleteVerdict.deletable ? (
                <p className="muted-text">
                  {retired ? deleteVerdict.retiredReason : deleteVerdict.reason}
                </p>
              ) : null}
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

      <CollapsibleSection id="client-section-statements" kicker="Statements" title="Statement dates">
        <ClientStatementsPanel clientId={client.id} />
      </CollapsibleSection>

      <ClientNotesSection
        clientId={client.id}
        ownerMode={ownerMode}
        currentUserId={sessionUser.id}
      />
      </div>
      ) : null}

      {/* Owner-only in full: staff never get this tab, because every panel in
          it is one they could not see before either. */}
      {activeSection === 'billing' && ownerMode ? (
        <div className="client-tab-panel" id={CLIENT_SECTION_ANCHORS.billing} role="tabpanel">
          {/* The master's counterpart to the "Billed on" card below, and first
              for the same reason: nothing else in this tab matters while the
              combined invoice has nowhere to go — the server refuses the send
              outright until a receiving company is picked here. */}
          {client.isBillingMaster ? (
            <CollapsibleSection
              id="client-section-invoice-recipient"
              kicker="Billing"
              title="Combined invoice recipient"
              lockable
            >
              <MasterInvoiceRecipientBody
                client={client}
                clients={data.clients}
                onCommit={commit}
              />
            </CollapsibleSection>
          ) : null}

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
            {/* A company billed on a master's combined invoice has no invoice
                of its own to charge, so autopay lives on the master. */}
            {client.billToClientId ? null : (
              <AutopayPanel
                key={client.id}
                clientId={client.id}
                neverEmailed={client.invoiceNoEmail === true}
              />
            )}
          </CollapsibleSection>

          {/* Its OWN card, deliberately apart from the opt-out switch in Invoice
              customization: that one stops the invoice being made at all, this
              one only stops it being emailed. */}
          <CollapsibleSection id="client-section-invoice-delivery" kicker="Invoice settings" title="Invoice delivery" lockable>
            <InvoiceDeliverySectionBody client={client} onCommit={commit} />
          </CollapsibleSection>

          <CollapsibleSection
            id="client-section-retainer"
            kicker="Engagement"
            title="Retainer invoice"
            lockable
          >
            <RetainerSectionBody key={client.id} client={client} />
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
  const addressLines = mailingAddressLines(client)

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
        Assigned team
        <SaveBadge state={state} />
      </span>
      <small className="field-helper">
        Who works this account. This list decides who sees the client&rsquo;s invoices. People
        given a task on the client see its checklists and can log time either way.
      </small>
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
      <HourlyRatesField client={client} />
      <EstimatedRoleHours client={client} onCommit={onCommit} />
      <ChipField
        label="Plans / services"
        selectedIds={client.planIds ?? []}
        options={plans.map((plan) => ({ id: plan.id, label: plan.name }))}
        onCommit={(nextIds) => onCommit({ planIds: nextIds })}
        addLabel="+ Add plan / service"
        emptyHelper="No plans/services selected yet."
      />
      <ApplyPackageField client={client} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Hourly rates — the client's pin (docs/plans/rate-history-2026-09.md §5)     */
/* -------------------------------------------------------------------------- */

/**
 * What this client bills each person at, and the one control that changes it.
 *
 * Hourly clients only: Monthly and Annual bill a fee, so a person's rate says
 * nothing about them and the block is simply absent. Owner-only: rates are
 * between the owner and the client, and a staff session receives a null pin
 * and an empty ledger anyway (`scopeAppDataForSession`).
 *
 * The rates are resolved CLIENT-SIDE through `billRateAt` — the same function
 * the invoice prices with — rather than asking the server for a computed list.
 * Two implementations of "what does this client pay for Lisa's hour" is the
 * thing this whole build exists to avoid.
 *
 * The AGE line is the feature Brittany actually asked for: she does a yearly
 * rate review per client and wants to see, at a glance, which ones are overdue
 * one. An anniversary reminder engine is explicitly out of scope (spec §6).
 */
export function HourlyRatesField({ client }: { client: Client }) {
  const { data, ownerMode } = useAppContext()
  const [billRateVersions, setBillRateVersions] = useState<BillRateVersion[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [moveTo, setMoveTo] = useState('')
  // The client as the MOVE endpoint just returned it, stamped with the pin the
  // prop carried when the move was made. The pin has its own endpoint
  // precisely so the bulk autosave cannot carry it, so this is a
  // component-local echo rather than a workspace edit: it shows the owner the
  // move she just made without marking anything dirty, and it is dropped
  // during render the moment the next /api/app-data refresh moves the prop.
  type MoveEcho = { clientId: string; was: string | null; client: Client }
  const [moved, setMoved] = useState<MoveEcho | null>(null)

  const hidden = !ownerMode || client.billingMode !== 'hourly'

  useEffect(() => {
    if (hidden) return
    const controller = new AbortController()
    // A staff session 403s and gets empty lists back rather than an error —
    // the block is hidden for them anyway, this just keeps it quiet.
    void fetchRateVersions(controller.signal)
      .then(({ billRateVersions: rows }) => setBillRateVersions(rows))
      .catch(() => {})
    return () => controller.abort()
  }, [hidden])

  if (hidden) return null

  // The next /api/app-data refresh is the authority: the echo only stands
  // while the prop still shows the pin the move was made against.
  const echoing =
    moved && moved.clientId === client.id && moved.was === (client.hourlyRatePeriod ?? null)
  const shown = echoing ? moved.client : client
  const pin = shown.hourlyRatePeriod ?? null
  const history = shown.hourlyRateHistory ?? []
  // NEXT month, because a rate change the owner agrees with a client almost
  // always starts at the next billing period — moving the CURRENT month would
  // reprice work already done at the old rate. Local, not UTC: on the last
  // evening of a month `toISOString()` would offer the month we are in.
  const now = new Date()
  const nextMonth = localDateOnly(new Date(now.getFullYear(), now.getMonth() + 1, 1)).slice(0, 7)
  const chosen = moveTo || nextMonth
  // The month the invoice would price at: the pin, or — for an UNPINNED
  // client — today's billing period, exactly as `rateFor` in
  // lib/invoice-lines.js resolves `ratePeriod ?? billingPeriod`.
  const currentPeriod = localDateOnly(now).slice(0, 7)
  const resolveAt = pin ?? currentPeriod

  const rows = (data.employees ?? [])
    .map((employee) => {
      // The invoice's own chain (`billRateAt`): the versioned rate at the
      // month, else the person's first rate once it has started, else — only
      // for someone with no versions — their live `billRate`. Only someone
      // with none of those is left off; their hours fall through to the
      // client's own rate.
      const rate = billRateAt(billRateVersions, employee, pin, currentPeriod)
      return { id: employee.id, name: employee.name, rate }
    })
    .filter((row) => row.rate !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  const monthsOld = (() => {
    if (!pin) return null
    const [year, month] = pin.split('-').map(Number)
    if (!Number.isFinite(year) || !Number.isFinite(month)) return null
    return (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month)
  })()
  // After the default forward move the pin is AHEAD of today, so the age is
  // negative — say when the new rates start rather than "-1 months ago".
  const plural = (count: number) => `${count} ${count === 1 ? 'month' : 'months'}`
  const ageText =
    monthsOld === null
      ? ''
      : monthsOld < 0
        ? ` — starts in ${plural(-monthsOld)}`
        : monthsOld === 0
          ? ' — this month'
          : ` — ${plural(monthsOld)} ago`

  const move = async () => {
    if (!/^\d{4}-\d{2}$/.test(chosen)) return
    setBusy(true)
    setError('')
    try {
      const updated = await setClientHourlyRatePeriod(client.id, chosen)
      setMoved({ clientId: client.id, was: client.hourlyRatePeriod ?? null, client: updated })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move the rates.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field full-row">
      <span>Hourly rates</span>
      <small className="field-helper">
        What this client is billed for each person&rsquo;s time. Changing a person&rsquo;s rate on
        the Team page does not move this client &mdash; press Move to current rates at their
        review.
      </small>
      {rows.length === 0 ? (
        <p className="muted-text">
          Nobody has a bill rate on file for {getBillingPeriodLabel(resolveAt)} &mdash; hours
          bill at the client&rsquo;s own rate instead.
        </p>
      ) : (
        <ul className="recap-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>{row.name}</span>
              <span>{currency.format(row.rate as number)}/hr</span>
            </li>
          ))}
        </ul>
      )}
      {pin ? (
        <p className="muted-text">
          Rates from {getBillingPeriodLabel(pin)}
          {ageText}
        </p>
      ) : (
        <p className="muted-text">Current rates (not pinned)</p>
      )}
      <div className="team-cost-input-row team-rate-from">
        <label htmlFor={`rate-move-${client.id}`} className="team-cost-hint">
          Move to current rates from
        </label>
        <input
          id={`rate-move-${client.id}`}
          type="month"
          value={chosen}
          onChange={(event) => setMoveTo(event.target.value)}
        />
        <button
          type="button"
          className="team-icon-button"
          disabled={busy}
          onClick={() => void move()}
        >
          {busy ? 'Moving…' : 'Move to current rates'}
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {history.length > 0 ? (
        <div className="team-rate-history">
          <button
            type="button"
            className="team-icon-button"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            Rate month history ({history.length})
          </button>
          {historyOpen ? (
            <ul className="recap-list">
              {history.map((entry, index) => (
                <li key={`${entry.to}-${index}`}>
                  <span>
                    {entry.from
                      ? `${getBillingPeriodLabel(entry.from)} → ${getBillingPeriodLabel(entry.to)}`
                      : getBillingPeriodLabel(entry.to)}
                  </span>
                  <span>{String(entry.changedAt).slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Apply a package (featreq-f890f05b)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The "+ Add package" pill, next to "+ Add plan / service".
 *
 * Hidden for a BILLING MASTER (it holds no work of its own) and for a RETIRED
 * client (the app stops offering retired clients for new work) — the same two
 * exclusions `workableClients` makes, applied to the client in front of us
 * rather than to a picker. The server refuses both anyway; this just stops the
 * app presenting a choice it will not honor.
 *
 * Packages are endpoint-managed, so they are fetched here rather than read off
 * the workspace snapshot.
 */
export function ApplyPackageField({ client }: { client: Client }) {
  const { data, ownerMode } = useAppContext()
  const [packages, setPackages] = useState<Package[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState('')
  const [error, setError] = useState('')

  const hidden = !ownerMode || client.isBillingMaster === true || isInactiveClient(client)

  useEffect(() => {
    if (hidden) return
    let cancelled = false
    void listPackagesRequest()
      .then((rows) => {
        if (!cancelled) setPackages(rows)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load packages.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [hidden])

  if (hidden) return null

  // The preview matches the server's skip rule exactly — a client template
  // stamped with this blueprint's id — so the dialog cannot promise a checklist
  // the apply then skips.
  const alreadyFromBlueprint = new Set(
    data.checklistTemplates
      .filter((template) => template.clientId === client.id && template.sourceTemplateId)
      .map((template) => template.sourceTemplateId as string),
  )

  const apply = async (pkg: Package) => {
    const addedPlanNames = pkg.planIds
      .filter((planId) => !(client.planIds ?? []).includes(planId))
      .map((planId) => data.plans.find((plan) => plan.id === planId)?.name)
      .filter((name): name is string => Boolean(name))
    const attached = pkg.templateIds
      .map((id) => data.checklistTemplates.find((template) => template.id === id))
      .filter((template): template is ChecklistTemplate => Boolean(template))
    const newChecklistTitles = attached
      .filter((template) => !alreadyFromBlueprint.has(template.id))
      .map((template) => template.title)
    const skippedCount = attached.length - newChecklistTitles.length

    const confirmed = window.confirm(
      applyPackageConfirmText({
        packageName: pkg.name,
        clientName: client.name,
        addedPlanNames,
        newChecklistTitles,
        skippedCount,
      }),
    )
    if (!confirmed) return
    setBusy(true)
    setError('')
    setOutcome('')
    try {
      const applied = await applyPackageRequest(client.id, pkg.id)
      setMenuOpen(false)
      setOutcome(
        `Applied "${pkg.name}": ${applied.addedPlanIds.length} plan${
          applied.addedPlanIds.length === 1 ? '' : 's'
        } added, ${applied.clonedTemplateIds.length} checklist${
          applied.clonedTemplateIds.length === 1 ? '' : 's'
        } created${
          applied.skippedTemplateIds.length > 0
            ? `, ${applied.skippedTemplateIds.length} already set up and skipped`
            : ''
        }. The invoice amount is unchanged.`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not apply the package.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field full-row package-apply-field">
      <span>Packages</span>
      <small className="field-helper">
        Apply a set of plans and their checklists in one press. The monthly rate is not touched.
      </small>
      {/* The same pill/menu markup ChipMultiSelect uses, so "+ Add package"
          reads as a sibling of "+ Add plan / service" rather than a new
          control. It picks ONE package and acts, so it is not a chip list. */}
      <div className="sharing-control">
        <div className="sharing-chips">
          <div className="sharing-add">
            <button
              type="button"
              className="add-person-pill"
              disabled={busy}
              onClick={() => setMenuOpen((open) => !open)}
            >
              + Add package
            </button>
            {menuOpen ? (
              <div className="sharing-add-menu" role="menu">
                {packages.length === 0 ? (
                  <p className="sharing-add-empty">
                    No packages yet — build one on the{' '}
                    <Link to="/plans?tab=packages">Plans page</Link>.
                  </p>
                ) : (
                  packages.map((pkg) => (
                    <button
                      key={pkg.id}
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => void apply(pkg)}
                    >
                      {pkg.name}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {outcome ? <p className="muted-text">{outcome}</p> : null}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Combined invoice recipient (billing masters)                               */
/* -------------------------------------------------------------------------- */

/**
 * Billing masters only: WHICH sub's contacts the combined invoice email goes
 * to. A master has no contacts of its own — "sends invoice to sub client you
 * choose" — and the server refuses a send outright while nothing is picked
 * (409 `master_recipient_unset`), so this select is the difference between
 * the master's invoice being emailable and not.
 *
 * Offered: the master's active subs, plus the current pick even if that sub
 * has since been retired — dropping it would render the select blank and
 * silently re-point the master on the next save, the same rule the client
 * pickers follow (`workableClients`' keepIds). The value rides the ordinary
 * client write, where `sanitizeClientBillingLinks` keeps it only while it
 * names one of this master's own subs, so a company moved out from under the
 * master clears itself rather than lingering as a stale target.
 */
export function MasterInvoiceRecipientBody({
  client,
  clients,
  onCommit,
}: {
  client: Client
  clients: Client[]
  onCommit: (patch: Partial<Client>) => void
}) {
  const current = client.invoiceRecipientClientId ?? ''
  const subs = clients
    .filter(
      (entry) =>
        entry.billToClientId === client.id && (entry.id === current || !isInactiveClient(entry)),
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  if (subs.length === 0) {
    return (
      <p className="muted-text">
        No companies bill to this master yet, so there is no one whose contacts could receive
        its invoice. Point a company at this master first, then pick the recipient here.
      </p>
    )
  }

  return (
    <div className="form-grid two-col">
      <SaveSelectField
        label="Send the combined invoice to"
        // A stale value naming a non-sub shows as Not set — which is exactly
        // how the server will treat it at send time.
        value={subs.some((sub) => sub.id === current) ? current : ''}
        onCommit={(value) => onCommit({ invoiceRecipientClientId: value || null })}
        options={[
          { value: '', label: 'Not set — sending is refused' },
          ...subs.map((sub) => ({
            value: sub.id,
            label: isInactiveClient(sub) ? `${sub.name} (inactive)` : sub.name,
          })),
        ]}
      />
      <p className="muted-text">
        The combined invoice is emailed to this company&apos;s contacts, under the
        master&apos;s name. It can be changed any month — the next send uses whatever is
        picked then.
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Retainer invoice                                                           */
/* -------------------------------------------------------------------------- */

/** Earliest "date paid" accepted for a recorded retainer; the server enforces the same floor. */
const RETAINER_PAID_ON_FLOOR = '2000-01-01'

/** "June 10, 2026" from a YYYY-MM-DD, with no time-zone drift. */
const longDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** "June 2026" from a YYYY-MM-DD. */
const monthYear = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** The day (en-US long form) a stored instant falls on, on the firm's calendar. */
const stampDay = (stamp: string | null) => {
  const day = stamp ? dateOnlyInZone(new Date(stamp)) : null
  return day ? longDate(day) : ''
}

/** How this retainer came to be, in the words she uses. */
function retainerOrigin(row: ClientRetainer) {
  if (row.recordedOutsideApp) return `Recorded as paid outside the app on ${stampDay(row.paidAt)}`
  if (row.status === 'paid') {
    return row.sentAt
      ? `Sent ${stampDay(row.sentAt)}, paid ${stampDay(row.paidAt)}`
      : `Paid ${stampDay(row.paidAt)}`
  }
  if (row.status === 'draft' || row.status === 'reviewed') {
    return 'Draft, not sent yet. Review and send it from the Invoices page.'
  }
  return `Sent ${stampDay(row.sentAt)}, not paid yet`
}

/**
 * The Retainer invoice section (featreq-9d3721d4).
 *
 * With no retainer on file it is the form that opens an engagement. Once one
 * is recorded or sent (any status but void) it is the retainer's POSITION
 * instead: the amount, what has been applied as credit, what remains, and how
 * each retainer came to be, with exactly two actions, Increase retainer and
 * Apply. The blank form is no longer the default then; it opens from Increase
 * retainer only. The position is read from the server, so it is there after a
 * reload.
 *
 * INCREASE is a second retainer through the same request and the same
 * record-only choice, not an edit of the first: each retainer is its own
 * invoice with its own number and its own credit, so an increase never
 * rewrites a document that was already sent or recorded. APPLY goes to the
 * Invoices page: a credit is applied to ONE invoice at a time from that
 * invoice's editor ("Apply retainer credit", offered on a draft or reviewed
 * invoice), sized to that invoice, and nothing applies it automatically.
 */
export function RetainerSectionBody({ client }: { client: Client }) {
  const [rows, setRows] = useState<ClientRetainer[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [increasing, setIncreasing] = useState(false)
  // Opening the form although the retainers on file could not be read.
  const [issueAnyway, setIssueAnyway] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    listClientRetainersRequest(client.id).then(
      (listed) => {
        if (stale) return
        setRows(listed)
        setLoadFailed(false)
        setIssueAnyway(false)
      },
      () => {
        if (!stale) setLoadFailed(true)
      },
    )
    return () => {
      stale = true
    }
  }, [client.id, reloadKey])

  if (rows === null && !loadFailed) {
    return (
      <div className="retainer-issue">
        <p className="retainer-issue-help">Loading the retainer on file…</p>
      </div>
    )
  }

  const onFile = rows !== null && rows.length > 0
  const showPosition = onFile && !increasing
  // A failed read means one may already be on file that she cannot see, so the
  // blank form stays closed until she says she means it.
  const showForm = !showPosition && (!loadFailed || issueAnyway || increasing)

  return (
    <div className="retainer-issue">
      {loadFailed ? (
        <p className="invoice-run-error" role="alert">
          Could not load the retainer on file, so this may not be the whole picture.{' '}
          <button type="button" className="link-button" onClick={() => setReloadKey((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : null}
      {notice ? <p className="invoice-run-note">{notice}</p> : null}
      {showPosition ? (
        <RetainerPosition
          rows={rows}
          billedOnMaster={Boolean(client.billToClientId)}
          onIncrease={() => setIncreasing(true)}
        />
      ) : null}
      {!showPosition && !showForm ? (
        <p className="retainer-issue-help">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              if (
                window.confirm(
                  'The retainers already on file for this client could not be checked, so a new one may duplicate one that exists. Open the form anyway?',
                )
              ) {
                setIssueAnyway(true)
              }
            }}
          >
            Issue anyway
          </button>
        </p>
      ) : null}
      {showForm ? (
        <RetainerIssueForm
          client={client}
          additional={onFile}
          onCancel={onFile ? () => setIncreasing(false) : undefined}
          onIssued={(message) => {
            setNotice(message)
            setIncreasing(false)
            setReloadKey((n) => n + 1)
          }}
        />
      ) : null}
    </div>
  )
}

/** The amount, the credit applied, the balance, each retainer's story, and the two actions. */
function RetainerPosition({
  rows,
  billedOnMaster,
  onIncrease,
}: {
  rows: ClientRetainer[]
  /** A company billed on its master's combined invoice has no invoice of its own to credit. */
  billedOnMaster: boolean
  onIncrease: () => void
}) {
  const position = retainerPosition(rows)
  return (
    <>
      <div role="group" aria-label="Retainer position" className="retainer-position">
        <dl>
          <div>
            <dt>Retainer</dt>
            <dd>{currency.format(position.total)}</dd>
          </div>
          <div>
            <dt>Applied as credit</dt>
            <dd>{currency.format(position.applied)}</dd>
          </div>
          <div>
            <dt>Remaining balance</dt>
            <dd>{currency.format(position.remaining)}</dd>
          </div>
          {position.awaiting > 0 ? (
            <div>
              <dt>Awaiting payment</dt>
              <dd>{currency.format(position.awaiting)}</dd>
            </div>
          ) : null}
        </dl>
        <ul className="retainer-position-list">
          {rows.map((row) => (
            <li key={row.id}>
              <strong>{row.number ?? row.id}</strong> <span>{currency.format(row.total)}</span>
              <br />
              <span>{retainerOrigin(row)}</span>
              {row.credit ? (
                <>
                  <br />
                  {row.credit.status === 'draft' || row.credit.status === 'reviewed' ? (
                    // Not final: re-sized on every save, and voiding the invoice
                    // puts the retainer back on account.
                    <span>
                      {`Credit pending on ${row.credit.status} ${row.credit.number ?? row.credit.invoiceId} (${monthYear(`${row.credit.period}-01`)}), re-sized if the invoice changes`}
                    </span>
                  ) : (
                    <>
                      <span>
                        {`Applied ${currency.format(row.credit.amount)} on ${row.credit.number ?? row.credit.invoiceId} (${monthYear(`${row.credit.period}-01`)})`}
                      </span>
                      {row.credit.amount < row.total ? (
                        <span>
                          {` The other ${currency.format(row.total - row.credit.amount)} is yours to return outside the app.`}
                        </span>
                      ) : null}
                    </>
                  )}
                </>
              ) : row.status === 'paid' ? (
                <>
                  <br />
                  <span>{`Remaining ${currency.format(row.total)}, not applied yet`}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <p className="retainer-issue-help">
        {billedOnMaster
          ? "This company is billed on its master's combined invoice, which cannot take its retainer credit, so there is nothing to apply here. To add to what the client has paid, use Increase retainer."
          : 'To apply one, open the invoice on the Invoices page while it is a draft or reviewed and press Apply retainer credit. Each retainer is applied on its own invoice, one retainer per invoice, sized to that invoice; nothing applies it on its own. To add to what the client has paid, use Increase retainer.'}
      </p>
      <div className="retainer-actions">
        <button type="button" className="secondary-action" onClick={onIncrease}>
          Increase retainer
        </button>
        {billedOnMaster ? null : position.remaining > 0 ? (
          <Link className="secondary-action" to="/invoices">
            Apply
          </Link>
        ) : (
          <button
            type="button"
            className="secondary-action"
            disabled
            title="Nothing is paid and waiting to be applied"
          >
            Apply
          </button>
        )}
      </div>
    </>
  )
}

/**
 * Issue the retainer invoice that opens an engagement, or an additional one.
 *
 * MANUAL, and it lives here rather than in the month run because that is what
 * it actually is: the app has no idea when an engagement letter comes back
 * signed, so this button IS that event. One amount, an optional note, and a
 * confirm — everything after it is the ordinary invoice life, on the Invoices
 * page, so this deliberately does not grow a second editor.
 *
 * "Record it only" (featreq-9d3721d4) is for a retainer that was already
 * invoiced and paid OUTSIDE the app: it is saved straight as a paid retainer,
 * visible and creditable later, and nothing is emailed.
 */
function RetainerIssueForm({
  client,
  additional,
  onIssued,
  onCancel,
}: {
  client: Client
  /** An increase on a retainer already on file rather than the first one. */
  additional: boolean
  onIssued: (message: string) => void
  onCancel?: () => void
}) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [recordOnly, setRecordOnly] = useState(false)
  // Empty means "today": the date is sent only when she moves it.
  const [paidOn, setPaidOn] = useState('')
  const today = localDateOnly()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const value = Number(amount)
  const valid = Number.isFinite(value) && value > 0

  const issue = async () => {
    if (!valid) return
    const paidDay = paidOn || today
    // A date field emits years like 0202 while one is being typed.
    if (recordOnly && paidDay < RETAINER_PAID_ON_FLOOR) {
      setError('Enter a valid date paid.')
      return
    }
    // A money document going out under a number that is then real. Worth one
    // question, because there is no delete — the way back is voiding it.
    const question = recordOnly
      ? `Record a ${currency.format(value)} retainer for ${client.name} as paid on ` +
        `${longDate(paidDay)}, filed under ${monthYear(paidDay)}? ` +
        'Nothing is emailed. It appears on the Invoices page as a paid retainer and can be ' +
        'credited on a later invoice. It is left out of Download for QBO.'
      : `Issue a ${currency.format(value)} retainer invoice for ${client.name}? ` +
        'It appears as a draft on the Invoices page, where you review and send it like any other.'
    if (!window.confirm(question)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const invoice = await (recordOnly
        ? issueRetainerInvoiceRequest(client.id, value, note.trim() || undefined, {
            recordOnly: true,
            ...(paidOn ? { paidOn } : {}),
          })
        : issueRetainerInvoiceRequest(client.id, value, note.trim() || undefined))
      const number = invoice.number ?? invoice.id
      setAmount('')
      setNote('')
      setRecordOnly(false)
      setPaidOn('')
      onIssued(
        recordOnly
          ? `Recorded ${number} as paid.`
          : `Issued ${number} as a draft. Review and send it from the Invoices page.`,
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : recordOnly
            ? 'Could not record the retainer. Nothing was saved.'
            : 'Could not issue the retainer invoice.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="retainer-issue-help">
        {additional
          ? 'An increase is a second retainer for this client, issued or recorded the same way as the first. The first one is not changed. '
          : 'Issue this once the engagement letter is signed. '}
        When the engagement ends, the paid retainer is offered back as a credit on the invoice you
        choose — you decide which one. If the retainer was already invoiced and paid outside the
        app, tick the box to record it as paid instead: nothing is emailed, and it stays on file to
        credit later.
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
            disabled={busy}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <input
            className="input"
            value={note}
            placeholder="Shown on the invoice line"
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={recordOnly}
          disabled={busy}
          onChange={(event) => setRecordOnly(event.target.checked)}
        />
        <span>Already invoiced and paid outside the app - record it only</span>
      </label>
      {recordOnly ? (
        <label className="field">
          <span>Date paid</span>
          <input
            className="input"
            type="date"
            value={paidOn || today}
            min={RETAINER_PAID_ON_FLOOR}
            max={today}
            disabled={busy}
            onChange={(event) => setPaidOn(event.target.value === today ? '' : event.target.value)}
          />
        </label>
      ) : null}
      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="retainer-actions">
        <button
          type="button"
          className="secondary-action"
          disabled={busy || !valid}
          title={
            valid
              ? recordOnly
                ? 'Record a paid retainer for this client'
                : 'Issue a retainer invoice for this client'
              : 'Enter an amount first'
          }
          onClick={() => void issue()}
        >
          {recordOnly
            ? busy
              ? 'Recording…'
              : 'Record retainer…'
            : busy
              ? 'Issuing…'
              : 'Issue retainer invoice…'}
        </button>
        {onCancel ? (
          <button type="button" className="secondary-action" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Plan checklists                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Deep-clone a checklist template ONTO a client. The clone itself now lives in
 * src/lib/cloneChecklistTemplate.ts, shared with the Checklists tab's
 * "Duplicate" — the two had drifted and one of them was back-filling history
 * (featreq-0bc2437e). Everything this path relied on is unchanged: fresh ids at
 * every level so the bulk autosave inserts the copy rather than colliding with
 * the source, `clientId` retargeted, the origin stamped via `sourceTemplateId`,
 * and the START FLOOR — the copy begins at its first cycle on or after today
 * and carries its own creation stamp, so neither materializer fills in the
 * months before the client was set up (featreq-c133daf8).
 *
 * This copy is born ACTIVE, unlike a Duplicate: its client is chosen up front,
 * so there is no window in which it could generate work for the wrong one.
 */
function cloneTemplateForClient(
  source: ChecklistTemplate,
  clientId: string,
): Omit<ChecklistTemplate, 'id'> {
  return cloneChecklistTemplate(source, { clientId, active: true })
}

export function PlanChecklistsBody({ client, data }: { client: Client; data: AppData }) {
  const { ownerMode, addChecklistTemplate } = useAppContext()
  const [packages, setPackages] = useState<Package[]>([])
  const [loaded, setLoaded] = useState(false)

  // Packages are endpoint-managed (not in AppData), so they are fetched here,
  // the way ApplyPackageField does. The panel paints nothing until the fetch
  // settles, so per-plan groups never flash and then collapse into a package;
  // a failed fetch leaves the per-plan groups, which is what the panel showed
  // before packages existed.
  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listPackagesRequest()
      .then((rows) => {
        if (!cancelled) setPackages(rows)
      })
      .catch(() => {})
      .then(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  // The plans this client is on (planIds chips on the Billing panel).
  const clientPlans = useMemo(
    () =>
      (client.planIds ?? [])
        .map((planId) => data.plans.find((plan) => plan.id === planId))
        .filter((plan): plan is SubscriptionPlan => Boolean(plan)),
    [client.planIds, data.plans],
  )

  // A package covers the client when every plan it combines is on the client;
  // its plans then fold into one group instead of one group per plan
  // (featreq-3ce2d75d). Plans no package covers keep their own group.
  const coveringPackages = useMemo(
    () => packagesCoveringPlans(client.planIds ?? [], packages),
    [client.planIds, packages],
  )

  // What each group lists. A package group mirrors the package exactly: only
  // its own checklist set, nothing a covered plan bundles beyond it
  // (featreq-3ce2d75d). A covered plan still gets no group of its own. A
  // checklist shows in the first group that lists it, never twice across groups.
  const groups = useMemo(() => {
    const shown = new Set<string>()
    const take = (ids: readonly string[]) => {
      const fresh = ids.filter((id, index) => !shown.has(id) && ids.indexOf(id) === index)
      for (const id of fresh) shown.add(id)
      return fresh
    }
    const result: {
      key: string
      name: string
      kind: 'plan' | 'package'
      templateIds: string[]
      handledElsewhere: boolean
    }[] = []
    const covered = new Set<string>()
    for (const pkg of coveringPackages) {
      const own = planTemplates(pkg, data.checklistTemplates).map((template) => template.id)
      for (const planId of pkg.planIds) covered.add(planId)
      const templateIds = take(own)
      result.push({
        key: `pkg-${pkg.id}`,
        name: pkg.name,
        kind: 'package',
        templateIds,
        handledElsewhere: own.length > 0 && templateIds.length === 0,
      })
    }
    for (const plan of clientPlans) {
      if (covered.has(plan.id)) continue
      const own = planTemplates(plan, data.checklistTemplates).map((template) => template.id)
      const templateIds = take(own)
      result.push({
        key: plan.id,
        name: plan.name,
        kind: 'plan',
        templateIds,
        handledElsewhere: own.length > 0 && templateIds.length === 0,
      })
    }
    return result
  }, [clientPlans, coveringPackages, data.checklistTemplates])

  if (!ownerMode) return null

  if (clientPlans.length === 0) {
    return (
      <p className="muted-text">
        This client isn&apos;t on any plan yet. Add a plan under{' '}
        <strong>Rate and services</strong> to bundle its checklists here.
      </p>
    )
  }

  // Nothing paints until the packages fetch settles (see the effect above).
  if (!loaded) return null

  // One group, for a plan or a package: the template list, the Set up / Not set
  // up status and the clone are the same for both.
  const renderGroup = ({
    key,
    name,
    kind,
    templateIds,
    handledElsewhere,
  }: (typeof groups)[number]) => {
    const source = { templateIds }
    const templates = planTemplates(source, data.checklistTemplates)
    const missing = missingPlanTemplatesForClient(
      source,
      data.checklistTemplates,
      client.id,
      data.checklistTemplates,
    )
    const missingIds = new Set(missing.map((template) => template.id))
    return (
      <div className="plan-checklists-group" key={key}>
        <div className="plan-checklists-head">
          <strong>{name}</strong>
          {kind === 'package' ? <span className="plan-checklists-kind">Package</span> : null}
          {templates.length > 0 && missing.length > 0 ? (
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                for (const template of missing) {
                  addChecklistTemplate(cloneTemplateForClient(template, client.id))
                }
              }}
            >
              <Plus size={14} /> Set up {kind} checklists ({missing.length})
            </button>
          ) : null}
        </div>
        {templates.length === 0 ? (
          <p className="muted-text">
            {handledElsewhere
              ? 'Its checklists are listed above.'
              : `No checklists are bundled with this ${kind} yet.`}
          </p>
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
  }

  return (
    <div className="plan-checklists">
      {groups.map(renderGroup)}
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

/**
 * "Note on every invoice": the text that starts the note to the client on every
 * NEW invoice for this client (featreq-459bdfc2 item 7). Saved through its own
 * endpoint - the bulk workspace save never carries it - and only after the
 * server accepts it does the page's copy of the client change.
 */
function InvoiceNoteField({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  const [error, setError] = useState('')
  const keep = async (value: string) => {
    setError('')
    try {
      const updated = await setClientInvoiceNote(client.id, value)
      onCommit({ invoiceNote: updated.invoiceNote ?? null })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that note.')
    }
  }
  return (
    <>
      <SaveTextareaField
        maxLength={INVOICE_NOTE_MAX_LENGTH}
        label="Note on every invoice"
        helper="Starts the note to the client on every new invoice for this client. Invoices already created keep their own note. Leave it empty for none."
        onCommit={(value) => void keep(value)}
        value={client.invoiceNote ?? ''}
      />
      {error ? (
        <p className="auth-error full-row" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}

/**
 * "Generate the invoice but never email it" (Rivercity). Exported for its own
 * test for the same reason `InvoiceSettingsSectionBody` is. The invoice is still
 * generated, reviewed and tracked here; only the email (and so the Send button
 * and the payment link) goes away, and Mark reviewed marks it sent instead.
 */
export function InvoiceDeliverySectionBody({
  client,
  onCommit,
}: {
  client: Client
  onCommit: (patch: Partial<Client>) => void
}) {
  return (
    <div className="form-grid two-col">
      <SaveToggleField
        checked={client.invoiceNoEmail ?? false}
        description="The invoice is still generated here and reviewed like any other, but it is never emailed. There is no Send button or payment link, and Mark reviewed marks it sent without an email. Use it for a client you deliver invoices to outside the app."
        label="Generate the invoice but never email it"
        onChange={(value) => onCommit({ invoiceNoEmail: value })}
      />
    </div>
  )
}

// Exported for its own test, exactly as `MasterInvoiceRecipientBody` is: the
// toggles here decide whether a client is billed at all, and rendering the whole
// page to reach them would test the page instead.
export function InvoiceSettingsSectionBody({
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
      <InvoiceNoteField client={client} onCommit={onCommit} />
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
      {/* The whole of featreq-006f12f6. On, this client leaves the platform's
          billing entirely: nothing is generated for them, nothing can be sent,
          and no payment link exists — they keep whatever method they were on. */}
      <SaveToggleField
        checked={client.platformInvoicingOptOut ?? false}
        description="No invoices are generated or sent for this client here; they are billed outside the app."
        label="Opt out of platform invoicing"
        onChange={(value) => onCommit({ platformInvoicingOptOut: value })}
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

  // The notes attached to the cards below, fetched ONCE for all of them. Keyed
  // on every checklist of the client, not the "due this month" subset, so
  // flipping that toggle does not refetch.
  const attachedNotesFor = useAttachedClientNotes(
    checklists.filter((entry) => !entry.projected).map((entry) => entry.id),
  )

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
          attachedNotes={attachedNotesFor(checklist.id)}
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
  // already on this client are skipped (she already has them). A retired
  // client's templates are never offered for new work (featreq-60f24838) —
  // standard blueprints aren't tied to a client, so they're untouched.
  const pickable = useMemo(() => {
    const inactiveIds = inactiveClientIdSet(clients)
    return templates
      .filter(
        (template) =>
          template.isStandard ||
          (template.clientId !== client.id && !inactiveIds.has(template.clientId)),
      )
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [templates, client.id, clients])
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
