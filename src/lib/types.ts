export type Role = 'employee' | 'owner'
export type BillingMode = 'hourly' | 'subscription' | 'annual'

/**
 * The firm's named monthly service packages. Picked per-client when billing
 * mode is 'subscription' and used as the invoice line label.
 */
export const MONTHLY_SERVICE_TIERS = [
  'The Crustless',
  'Just the Crust',
  'The Classic',
  'The Jelly Royale',
  'The Ultimate Spread',
  'The Nutty Buddy',
  'The Rescue Spread',
] as const
export type ChecklistFrequency =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'annually'
  | 'specific-months'

export type Employee = {
  id: string
  name: string
  role: 'Bookkeeper' | 'Accountant' | 'Owner'
  /**
   * Optional BILL rate ($/hour) charged to clients for this person's time.
   * Hourly clients are billed off each employee's bill rate (see getInvoice).
   * Separate from the cost/pay rate (margin-only). Null = not set, falls back
   * to the firm's default hourly rate at invoice time.
   */
  billRate?: number | null
  /**
   * ISO timestamp set when an owner removes the team member via the
   * Team page. Only present on entries in `AppData.inactiveEmployees`;
   * absent (or null) on every active member in `AppData.employees`.
   * Inactive members can't sign in or be assigned new work, but their
   * historical attribution on time entries and completed checklists is
   * preserved for the analytics "include former team members" toggle.
   */
  inactiveAt?: string | null
}

export type Client = {
  id: string
  name: string
  contact: string
  billingMode: BillingMode
  hourlyRate: number
  /**
   * Plans/services this client subscribes to. A client may select MULTIPLE
   * plans (rendered as chips in the UI). Plans are now just name + notes
   * labels — they carry no fee. Used purely to label the monthly invoice
   * line. Always an array on read (the store normalizes legacy `planId`
   * rows into a single-element array).
   */
  planIds: string[]
  /**
   * The client's own monthly rate (dollars). The single source of truth for
   * a Monthly (subscription-mode) client's invoice amount — it replaces the
   * old plan-derived fee + per-client override. Only meaningful when
   * `billingMode` is 'subscription'.
   */
  monthlyRate?: number
  /**
   * Which named monthly service package this client is on (e.g. "The
   * Classic"). Only meaningful when `billingMode` is 'subscription'. Drives
   * the invoice line label. One of MONTHLY_SERVICE_TIERS, or unset for a
   * generic "Monthly service" line.
   */
  monthlyServiceTier?: string
  /**
   * Flat yearly fee (dollars) billed ONCE per year. Only meaningful when
   * `billingMode` is 'annual'. The invoice shows this amount only in the
   * client's `annualBillingMonth`; every other month has no subscription line.
   */
  annualRate?: number
  /**
   * Calendar month (1–12) the annual fee is billed in. Only meaningful when
   * `billingMode` is 'annual'. Defaults to January (1) when unset.
   */
  annualBillingMonth?: number
  /**
   * @deprecated Legacy single informational estimated-monthly-hours field.
   * Superseded by the per-role fields below (`estimatedBookkeeperHours`,
   * `estimatedAccountantHours`, `estimatedCfoHours`). Kept optional for
   * back-compat reads + migration only — the store surfaces it as
   * `estimatedBookkeeperHours` when the new role fields are all absent.
   */
  estimatedMonthlyHours?: number
  /**
   * INFORMATIONAL ONLY — estimated monthly Bookkeeper hours for planning.
   * Must NEVER affect any invoice total.
   */
  estimatedBookkeeperHours?: number
  /**
   * INFORMATIONAL ONLY — estimated monthly Accountant hours for planning.
   * Must NEVER affect any invoice total.
   */
  estimatedAccountantHours?: number
  /**
   * INFORMATIONAL ONLY — estimated monthly CFO hours for planning.
   * Must NEVER affect any invoice total.
   */
  estimatedCfoHours?: number
  /**
   * Reusable Contacts (shared across clients) selected on this client.
   * A client may select MULTIPLE contacts. Always an array on read.
   */
  contactIds: string[]
  /**
   * @deprecated Legacy single-plan reference. Kept optional for back-compat
   * reads + migration only — the store backfills `planIds` from it. New
   * writes use `planIds`.
   */
  planId?: string | null
  /**
   * @deprecated Legacy per-client override of the subscription plan's
   * monthly fee. Kept optional for back-compat reads + migration only — the
   * store backfills `monthlyRate` from it. New writes use `monthlyRate`.
   */
  customMonthlyFee?: number | null
  assignedEmployeeIds?: string[]
  /**
   * Server-enforced visibility scoping. Owners always see all clients. A
   * non-owner can only see clients where their user id appears in this array.
   * Auto-populated when a non-owner is assigned to any task on this client.
   */
  assignedBookkeeperIds?: string[]
  // Phase 4: profile + invoice customization
  email?: string
  contactName?: string
  phone?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  logoUrl?: string
  paymentTerms?: string
  footerNote?: string
  quickbooksPayUrl?: string
  invoiceShowTimeBreakdown?: boolean
  invoiceHideInternalHours?: boolean
  invoiceGroupByCategory?: boolean
}

export type SubscriptionPlan = {
  id: string
  name: string
  notes: string
}

/**
 * A reusable contact entered once and selected (via dropdown / multi-select)
 * on one or more clients. Contacts are shared across clients and managed on
 * their own owner-only Contacts page.
 */
export type Contact = {
  id: string
  name: string
  email?: string
  phone?: string
  title?: string
  notes?: string
  /**
   * When true the contact is locked — shown read-only on the Contacts page
   * until unlocked, to protect a finished record from accidental edits.
   * Persisted (shared) so the lock survives reloads and other devices.
   */
  locked?: boolean
  /**
   * Per-company email overrides. One contact can appear on many clients with a
   * client-specific email; the base `email` is the default. Each entry maps a
   * `clientId` to the email to use for THAT client. Use `emailForClient()`
   * (lib/utils) to resolve the effective address. Persisted as jsonb in pg.
   */
  companyEmails?: Array<{ clientId: string; email: string }>
  /**
   * Other contacts this contact is related to. Maintained SYMMETRICALLY —
   * linking A→B also adds A to B.linkedContactIds (and unlinking removes both
   * sides). Persisted as text[] in pg.
   */
  linkedContactIds?: string[]
  /**
   * ISO timestamp the contact was archived, or null/undefined when active.
   * Archived contacts are hidden from the active directory and from client
   * contact pickers. Persisted as timestamptz in pg.
   */
  archivedAt?: string | null
}

export type TimeApprovalStatus = 'pending' | 'approved' | 'rejected'

/**
 * A bookkeeper / accountant locks their week for review by submitting a
 * `WeeklySubmission`. The owner then approves (which auto-approves every
 * pending time entry in that week) or rejects with a note. A re-submit
 * after rejection upgrades the existing row back to `pending` — there's
 * always exactly one row per `(userId, weekStart)`.
 */
export type WeeklySubmissionStatus = 'pending' | 'approved' | 'rejected'

export type WeeklySubmission = {
  id: string
  userId: string
  /** ISO date of the Sunday that anchors the week (US Sun-Sat work week). */
  weekStart: string
  /** ISO timestamp of the most recent submit (resets on resubmit). */
  submittedAt: string
  status: WeeklySubmissionStatus
  /** Owner who approved or rejected, set when `status !== 'pending'`. */
  reviewedBy?: string
  reviewedAt?: string
  /** Rejection rationale shown to the submitter. */
  reviewNote?: string
}

export type TimeEntry = {
  id: string
  employeeId: string
  /**
   * The client this time is billed against. EMPTY ('') for administrative
   * work (company meetings, internal training, etc.) — see `isAdministrative`.
   */
  clientId: string
  /**
   * Administrative / internal time that isn't tied to any client (e.g. company
   * meetings). When true, `clientId` is empty, `taskId` is null, and the entry
   * is never billable — the employee just records hours + notes.
   */
  isAdministrative?: boolean
  date: string
  minutes: number
  /**
   * @deprecated Legacy "work type" categorization. Retained for backwards-compat
   * reads only — the DB `category`/`work_type` column is kept (not dropped), but
   * the UI no longer surfaces it. New writes default it server-side.
   */
  category?: string
  description: string
  billable: boolean
  /**
   * Primary categorization: a checklist (task) this entry was logged against.
   * Still optional — admin/internal time may have no task.
   */
  taskId?: string | null
  /**
   * Free-text task name, used when the client has no active checklist to pick
   * (so the user can still say what they worked on). Only meaningful when
   * `taskId` is empty; ignored otherwise.
   */
  taskLabel?: string
  /**
   * Ties this entry to a "group time" batch — one block of work the owner
   * allocated across MULTIPLE clients at once. Every entry created from the
   * same group-time split shares this id (each client still gets its own
   * independent, separately-billed entry). Absent on ordinary single-client
   * and administrative entries.
   */
  groupId?: string
  /**
   * Present only on an UNSPLIT group-time holding entry: the member client ids
   * this tracked block will be split across later. While set (and `clientId`
   * is empty) the entry is a draft — not billable and on no invoice — until the
   * owner splits it, which replaces it with one billed entry per client. The
   * resulting per-client entries carry `groupId` instead, never this field.
   */
  groupClientIds?: string[]
  /**
   * ISO timestamp the entry was first logged/submitted (created). Preserved
   * across saves so the time page can show the most-recently-logged entry at
   * the top ("what I did last"). Absent only on very old legacy rows.
   */
  createdAt?: string
  /** Approval lifecycle. New entries start `pending`; legacy data is `approved`. */
  approvalStatus: TimeApprovalStatus
  /** Rejection reason — set when status is `rejected`. */
  approvalNote?: string
  /** User id of the owner who approved/rejected the entry. */
  approvedBy?: string
  /** ISO timestamp of the approve/reject action. */
  approvedAt?: string
  /**
   * How the entry was captured. Timer-stopped entries (and all legacy/seed
   * data) are `timer`; only the deliberately-gated manual entry form sets
   * `manual`. Defaults to `timer` when absent.
   */
  entryMethod: 'timer' | 'manual'
  /** Required reason text — set only when `entryMethod` is `manual`. */
  manualReason?: string
  /**
   * Exact moment work started, ISO 8601 timestamp. Set for timer entries
   * (from the timer's start) and for manual entries (the user enters it).
   * Optional for back-compat with legacy rows that predate audit timestamps.
   */
  startAt?: string
  /**
   * Exact moment work stopped, ISO 8601 timestamp. For a single-session entry
   * this equals the last session's stop. Optional for legacy rows.
   */
  endAt?: string
  /**
   * The work sessions that make up this entry — each an exact start/stop span.
   * A plain timer or manual entry has one session; "Resume" and "Add time"
   * append more. `minutes` is the sum of the sessions, and `startAt`/`endAt`
   * are the first start / last stop. Empty/absent for legacy rows that predate
   * the sessions model (those fall back to the stored `minutes`).
   */
  sessions?: WorkSession[]
}

/** One exact start/stop span of work within a `TimeEntry`. */
export type WorkSession = {
  startAt: string
  endAt: string
}

/** A per-employee, per-month timesheet lock. Locking signs off the month. */
export type TimesheetLock = {
  id: string
  userId: string
  /** Period in `YYYY-MM` form. */
  period: string
  lockedBy: string
  lockedAt: string
}

/**
 * The deepest checklist node — a sub-sub-item, nested under a `SubChecklistItem`.
 * Three levels total (item → sub-item → sub-sub-item); nothing nests under this.
 */
export type SubSubChecklistItem = {
  id: string
  title: string
  done: boolean
  /** Concrete resolved due date (ISO yyyy-mm-dd), computed at materialization. */
  dueDate?: string
}

/** A sub-sub-item on a template item. Template nodes have no `done`. */
export type SubSubChecklistTemplateItem = {
  id: string
  title: string
  /** Optional fixed due date (ISO yyyy-mm-dd). Wins over `dueDayOfMonth`. */
  dueDate?: string
  /** Optional recurring day-of-month (1–31) resolved per cycle month. */
  dueDayOfMonth?: number
}

/**
 * A nested checklist sub-item. Sub-items nest one level under a parent
 * `ChecklistItem` / `ChecklistTemplateItem` and may themselves carry one
 * deeper level of `subItems` (sub-sub-items) — three levels total, no further.
 * A sub-item carries no per-sub-item assignee or due date (the parent item
 * carries those).
 */
export type SubChecklistItem = {
  id: string
  title: string
  /**
   * For sub-items WITH sub-sub-items this is DERIVED — `true` exactly when
   * every sub-sub-item is done. Kept in sync on every change so the top item's
   * roll-up still works. Sub-items with no sub-sub-items behave as before.
   */
  done: boolean
  /** Concrete resolved due date (ISO yyyy-mm-dd), computed at materialization. */
  dueDate?: string
  /**
   * Flagged as blocked/delayed (the "waiting on" toggle). When true the step is
   * stalled and surfaces on the owner's Delayed page; `waitingOn` says why.
   */
  waiting?: boolean
  /** Free-text note explaining what this sub-step is waiting on. */
  waitingOn?: string
  /** Optional id of a checklist this sub-step is waiting on (see ChecklistItem). */
  waitingForChecklistId?: string
  /** One deeper level of nested sub-sub-items. Empty/undefined when flat. */
  subItems?: SubSubChecklistItem[]
}

/** A nested sub-item on a template item. Template sub-items have no `done`. */
export type SubChecklistTemplateItem = {
  id: string
  title: string
  /** Optional fixed due date (ISO yyyy-mm-dd). Wins over `dueDayOfMonth`. */
  dueDate?: string
  /** Optional recurring day-of-month (1–31) resolved per cycle month. */
  dueDayOfMonth?: number
  /** Sub-sub-items defined in the template; copied with fresh ids on materialize. */
  subItems?: SubSubChecklistTemplateItem[]
}

export type ChecklistItem = {
  id: string
  label: string
  /**
   * For items WITH sub-items this is DERIVED — `true` exactly when every
   * sub-item is done. It is kept in sync on every sub-item change so all
   * existing `item.done` readers (progress ratios, stage hand-off) work
   * unchanged. Items with no sub-items behave exactly as before.
   */
  done: boolean
  dueDate?: string
  assigneeId?: string
  /**
   * Flagged as blocked/delayed (the "waiting on" toggle). When true the step is
   * stalled and surfaces on the owner's Delayed page; `waitingOn` says why.
   */
  waiting?: boolean
  /**
   * Free-text "waiting on" note explaining why an unfinished item is blocked
   * (e.g. "client to send Q2 bank statements"). Owner-visible context for why
   * a step hasn't been completed.
   */
  waitingOn?: string
  /**
   * Optional id of another checklist (task) this step is waiting on. When that
   * checklist is completed, this step's assignee is notified that they're no
   * longer blocked. Only meaningful while `waiting` is true.
   */
  waitingForChecklistId?: string
  /** One level of nested sub-items. Empty/undefined when the item is flat. */
  subItems?: SubChecklistItem[]
}

export type ChecklistTemplateItem = {
  id: string
  label: string
  dueDate?: string
  /** Optional recurring day-of-month (1–31) resolved per cycle month. */
  dueDayOfMonth?: number
  assigneeId?: string
  /** Sub-items defined in the template; copied with fresh ids on materialize. */
  subItems?: SubChecklistTemplateItem[]
}

export type TemplateStage = {
  id: string
  name: string
  assigneeId: string
  /**
   * Days BEFORE the deadline (the task's due date, or the previous stage's due
   * date) this stage is due — so hand-off stages land on/before the end of the
   * month, not after. Used only when `dueDate` is not set — an explicit
   * `dueDate` always wins. Note: independent *repeat cadence* per stage is NOT
   * supported; the template repeats as a whole and only the due date can be
   * pinned per stage.
   */
  offsetDays: number
  /**
   * Optional explicit fixed due date (ISO yyyy-mm-dd). When set, the
   * materialized instance for this stage uses it directly instead of the
   * `offsetDays` calculation.
   */
  dueDate?: string
  /**
   * Optional recurring day-of-month (1–31). When set (and `dueDate` is not),
   * the materialized instance for this stage is due on the Nth of the cycle
   * month, clamped to that month's length. Wins over `offsetDays`.
   */
  dueDayOfMonth?: number
  viewerIds: string[]
  editorIds: string[]
  items: ChecklistTemplateItem[]
}

export type ChecklistTemplate = {
  id: string
  title: string
  clientId: string
  assigneeId: string
  frequency: ChecklistFrequency
  nextDueDate: string
  active: boolean
  /**
   * Lead time: how many days BEFORE its due date a recurring instance should
   * appear, so the team can start it early instead of it popping up only when
   * it's already due. 0 / unset = appears on the due date (legacy behavior).
   * Applies to the cadence frequencies (daily…annually); specific-months
   * already generates at the start of each designated month.
   */
  leadDays?: number
  /**
   * Only meaningful when `frequency === 'specific-months'`: the designated
   * month numbers (1–12) the checklist runs in. `nextDueDate` advance logic is
   * ignored in that mode.
   */
  scheduledMonths?: number[]
  /**
   * @deprecated Legacy single shared day-of-month for specific-months. Kept as
   * a fallback for templates created before per-month due dates existed; new
   * templates use `monthlyDueDays`. Honored only when `monthlyDueDays` has no
   * entry for a given month.
   */
  dueDayOfMonth?: number
  /**
   * Only meaningful when `frequency === 'specific-months'`: a per-month due-day
   * map keyed by month number (1–12, as a string key) → day-of-month. Each
   * selected month's checklist is due on its own day, clamped to that month's
   * real length (so Jan can be the 31st, Feb the 28th/29th). Months absent from
   * the map fall back to `dueDayOfMonth`, then to the last day of the month.
   */
  monthlyDueDays?: Record<string, number>
  /**
   * Only meaningful when `frequency === 'specific-months'`. When `false`, the
   * template only generates occurrences during `scheduleYear`; when `true` or
   * undefined it repeats every year (the legacy behavior). Semantically
   * defaults to `true` so existing templates are unaffected.
   */
  repeatAnnually?: boolean
  /**
   * Only meaningful when `frequency === 'specific-months'` and
   * `repeatAnnually === false`: the calendar year this template's designated
   * months apply to. Set at creation time.
   */
  scheduleYear?: number
  /**
   * A standard template is client-agnostic — it has no client, never
   * materializes checklists on its own, and exists purely as a reusable
   * blueprint that can be applied/copied onto a client.
   */
  isStandard?: boolean
  viewerIds: string[]
  editorIds: string[]
  stages: TemplateStage[]
  /**
   * Optional service category (column) this template belongs to on the Active
   * Checklists board — references a {@link ServiceCategory} id. Checklists
   * generated/applied from this template inherit it. Unset = "Uncategorized".
   */
  categoryId?: string | null
  /** @deprecated Kept transiently for backwards-compat reads; new writes serialize `stages`. */
  items?: ChecklistTemplateItem[]
}

export type Checklist = {
  id: string
  title: string
  clientId: string
  assigneeId: string
  templateId?: string
  frequency?: ChecklistFrequency
  dueDate: string
  viewerIds: string[]
  editorIds: string[]
  createdAt?: string
  items: ChecklistItem[]
  caseId?: string
  stageId?: string
  stageIndex?: number
  stageCount?: number
  /**
   * Optional service category (column) for the Active Checklists board —
   * references a {@link ServiceCategory} id. Inherited from the template when
   * generated/applied. Unset = "Uncategorized".
   */
  categoryId?: string | null
  /**
   * ISO timestamp set when an owner soft-deletes the checklist; the row is
   * moved to `AppData.recycledChecklists` and excluded from the active
   * `AppData.checklists` list. Cleared on restore, removed entirely when
   * the bin is emptied. Unset on every active checklist.
   */
  deletedAt?: string | null
}

/**
 * A service category = one column on the Active Checklists board (e.g.
 * "Monthly Bookkeeping", "Sales Tax", "Payroll"). Owner-managed; templates and
 * checklists reference it by id via `categoryId`. `sortOrder` drives left-to-
 * right column order.
 */
export type ServiceCategory = {
  id: string
  name: string
  sortOrder: number
}

/**
 * Owner-configurable defaults applied when creating a NEW client. Lets the
 * firm set its house rate / terms / invoice prefs once instead of retyping
 * them on every new client. Only affects the Add-client form's starting
 * values — existing clients are never changed.
 */
export type ClientDefaults = {
  billingMode?: BillingMode
  hourlyRate?: number
  monthlyRate?: number
  paymentTerms?: string
  footerNote?: string
  invoiceShowTimeBreakdown?: boolean
  invoiceHideInternalHours?: boolean
  invoiceGroupByCategory?: boolean
}

export type FirmSettings = {
  name: string
  tagline?: string
  logoUrl?: string
  brandColor?: string
  /** Defaults pre-filled on the Add-client form. */
  clientDefaults?: ClientDefaults
  /**
   * Color used for text rendered on top of the brand color (sidebar, etc).
   * Defaults to white so any brand color picked still has legible text.
   */
  sidebarTextColor?: string
  /**
   * Color used specifically for the currently-active sidebar nav item.
   * Defaults to white so an unconfigured workspace looks identical to
   * the previous single-color behavior; pick a contrasting value to
   * make the current page stand out from the inactive items.
   */
  sidebarActiveTextColor?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  phone?: string
  email?: string
  website?: string
  ein?: string
}

export type PublicFirmSettings = Pick<
  FirmSettings,
  | 'name'
  | 'tagline'
  | 'logoUrl'
  | 'brandColor'
  | 'sidebarTextColor'
  | 'sidebarActiveTextColor'
>

export const DEFAULT_FIRM_SETTINGS: FirmSettings = {
  name: 'PB&J Strategic Accounting',
  tagline: '',
  logoUrl: '',
  brandColor: '#e8f4fb',
  sidebarTextColor: '#13344a',
  sidebarActiveTextColor: '#ff43a4',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  phone: '',
  email: '',
  website: '',
  ein: '',
  clientDefaults: {
    billingMode: 'hourly',
    hourlyRate: 125,
    monthlyRate: 0,
    paymentTerms: '',
    footerNote: '',
    invoiceShowTimeBreakdown: true,
    invoiceHideInternalHours: true,
    invoiceGroupByCategory: false,
  },
}

export type AppData = {
  employees: Employee[]
  /**
   * Soft-deleted (removed) team members. Owner-only — non-owners see an
   * empty array via server-side scoping. Used by analytics pages so a
   * "include former team members" toggle has real historical data to
   * surface; not used anywhere else.
   */
  inactiveEmployees: Employee[]
  clients: Client[]
  plans: SubscriptionPlan[]
  /** Reusable contacts shared across clients (owner-managed). */
  contacts: Contact[]
  timeEntries: TimeEntry[]
  checklistTemplates: ChecklistTemplate[]
  checklists: Checklist[]
  /**
   * Soft-deleted checklists awaiting restore or bin empty. Owner-only;
   * non-owners always see an empty array via server-side scoping.
   */
  recycledChecklists: Checklist[]
  timesheetLocks: TimesheetLock[]
  /**
   * Weekly lock-for-review submissions. Owners see every user's
   * submissions; non-owners see only their own (server-scoped).
   */
  weeklySubmissions: WeeklySubmission[]
  /**
   * Owner-managed expense reimbursements that show up as invoice lines
   * on the client's monthly invoice (matched by date → billing month).
   */
  reimbursements: Reimbursement[]
  /**
   * Owner-managed recurring expense reimbursements (monthly / quarterly /
   * annual) that auto-populate the matching invoice without an entry per
   * period. Synthesized into lines by `getInvoice`.
   */
  recurringReimbursements: RecurringReimbursement[]
  firmSettings?: FirmSettings
}

export type TimerState = {
  employeeId: string
  clientId: string
  description: string
  startedAt: number
  /** Optional task this timed work is attached to. */
  taskId?: string | null
  /** Free-text task name when the client has no active checklist to pick. */
  taskLabel?: string
  /** Administrative / internal timing — no client or task. */
  isAdministrative?: boolean
  /**
   * Group timing: the member client ids this block will be split across for
   * billing later. When set, the timer is tracking against a group — on stop it
   * saves a single unsplit holding entry (no single client) the owner splits
   * afterward. Mutually exclusive with `clientId` / `isAdministrative`.
   */
  groupClientIds?: string[]
  /**
   * When set, this timer is RESUMING an existing pending entry: stopping it
   * appends a new session to that entry (keeping it pending) instead of
   * creating a brand-new entry.
   */
  resumeEntryId?: string
}

export type InvoiceLine = {
  label: string
  detail: string
  amount: number
}

/**
 * Per-client out-of-pocket expense the firm fronts and bills back to the
 * client on their next invoice. Each `Reimbursement` shows up as a line on
 * the invoice for the month its `date` falls in (and contributes to the
 * total). Owner-managed; bookkeepers can see them but not edit.
 *
 * This is the **one-off** flavor — for things-that-recur use
 * `RecurringReimbursement`, which auto-populates the line on every matching
 * monthly invoice.
 */
export type Reimbursement = {
  id: string
  clientId: string
  /** YYYY-MM-DD — drives which monthly invoice the line appears on. */
  date: string
  description: string
  /** Dollars, positive. The invoice line shows this verbatim. */
  amount: number
}

export type RecurringReimbursementFrequency = 'monthly' | 'quarterly' | 'annually'

/**
 * Per-client recurring expense (e.g. a monthly software subscription the
 * firm fronts, an annual filing fee). Doesn't store generated rows —
 * `getInvoice` computes whether it applies to each billing period based
 * on `startDate` + `frequency` and synthesizes a line on the fly.
 * Owner-managed; bookkeepers see-only same as one-off reimbursements.
 */
export type RecurringReimbursement = {
  id: string
  clientId: string
  description: string
  /** Dollars, positive. */
  amount: number
  frequency: RecurringReimbursementFrequency
  /**
   * YYYY-MM-DD — the first billing period this hits is the month of
   * `startDate`. Quarterly recurs every 3 months from that anchor,
   * annually recurs in the same month each year.
   */
  startDate: string
}

export type Invoice = {
  client: Client
  plan: SubscriptionPlan | null
  billableMinutes: number
  entryCount: number
  period: string
  periodLabel: string
  lines: InvoiceLine[]
  total: number
}

export type EmployeeReportRow = {
  employeeId: string
  minutes: number
  billableMinutes: number
  internalMinutes: number
  entryCount: number
  clientCount: number
  /** Billable $ = (billableMinutes / 60) * (employee.billRate ?? 0). */
  billableAmount: number
}

export type ClientReportRow = {
  clientId: string
  minutes: number
  billableMinutes: number
  internalMinutes: number
  entryCount: number
  employeeCount: number
  invoiceTotal: number
}

export type TaskReportRow = {
  /** Linked checklist id, or `null` for entries with no task ("Unassigned"). */
  taskId: string | null
  taskTitle: string
  minutes: number
  entryCount: number
}

export type DataSyncState = 'loading' | 'saving' | 'synced' | 'offline' | 'error'
export type AuthState = 'loading' | 'ready'

export type SessionUser = {
  id: string
  name: string
  email: string
  role: Role
  staffRole: string
  /** TOTP two-factor enrollment flag — present when the server includes it. */
  totpEnabled?: boolean
}

export type TeamMember = {
  id: string
  name: string
  email: string
  role: Role
  staffRole: string
  /**
   * @deprecated Email-gated auth removed surfacing of the legacy magic link.
   * Field stays optional for transition reads only — UI should not rely on it.
   */
  magicUrl?: string | null
  tokenRevokedAt: string | null
  lastActiveAt: string | null
  createdAt: string | null
  /** TOTP two-factor enrollment flag. */
  totpEnabled?: boolean
  /**
   * Optional cost/pay rate ($/hour) — owner-only, informational, powers the
   * assistant's margin analytics. Never affects invoices. Null = not set.
   */
  costRate?: number | null
  /**
   * Optional BILL rate ($/hour) charged to clients for this person's time.
   * Unlike costRate this DOES feed invoices (hourly clients are billed off
   * each employee's bill rate). Null = not set. Owner-only to edit.
   */
  billRate?: number | null
}

export type TotpStatus = {
  enabled: boolean
  remainingBackupCodes: number
  requiredForRole: boolean
}

export type TotpSetupInit = {
  secret: string
  otpauthUri: string
  /** Data-URL PNG of the otpauth QR — rendered into an `<img>` (no HTML sink). */
  qrDataUrl: string
  /** @deprecated Raw SVG markup. Kept optional for transition; prefer `qrDataUrl`. */
  qrSvg?: string
}

export type TeamSession = {
  id: string
  userId: string
  createdAt: string | null
  lastSeenAt: string | null
  userAgent: string | null
  ipAddress: string | null
}

export type ActivityEntry = {
  id: string
  userId: string
  action: string
  target: string
  timestamp: string
}

export type NotificationEvent =
  | 'task_assigned'
  | 'case_advanced'
  | 'case_completed'
  | 'invoice_ready'
  | 'time_entry_manual'
  | 'waiting_cleared'

export type NotificationEntry = {
  id: string
  userId: string
  event: NotificationEvent | string
  message: string
  link: string | null
  payload: Record<string, unknown>
  readAt: string | null
  createdAt: string
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
