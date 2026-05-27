export type Role = 'employee' | 'owner'
export type BillingMode = 'hourly' | 'subscription'
export type ChecklistFrequency =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'annually'
  | 'specific-months'

export type Employee = {
  id: string
  name: string
  role: 'Bookkeeper' | 'Accountant' | 'Owner'
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
  planId: string | null
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
  monthlyFee: number
  includedHours: number
  notes: string
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
  clientId: string
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
}

/** A sub-sub-item on a template item. Template nodes have no `done`. */
export type SubSubChecklistTemplateItem = {
  id: string
  title: string
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
  /** One deeper level of nested sub-sub-items. Empty/undefined when flat. */
  subItems?: SubSubChecklistItem[]
}

/** A nested sub-item on a template item. Template sub-items have no `done`. */
export type SubChecklistTemplateItem = {
  id: string
  title: string
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
  /** One level of nested sub-items. Empty/undefined when the item is flat. */
  subItems?: SubChecklistItem[]
}

export type ChecklistTemplateItem = {
  id: string
  label: string
  dueDate?: string
  assigneeId?: string
  /** Sub-items defined in the template; copied with fresh ids on materialize. */
  subItems?: SubChecklistTemplateItem[]
}

export type TemplateStage = {
  id: string
  name: string
  assigneeId: string
  /**
   * Days after the previous stage's due date. Used only when `dueDate` is not
   * set — an explicit `dueDate` always wins. Note: independent *repeat cadence*
   * per stage is NOT supported; the template repeats as a whole and only the
   * due date can be pinned per stage.
   */
  offsetDays: number
  /**
   * Optional explicit fixed due date (ISO yyyy-mm-dd). When set, the
   * materialized instance for this stage uses it directly instead of the
   * `offsetDays` calculation.
   */
  dueDate?: string
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
   * Only meaningful when `frequency === 'specific-months'`: the designated
   * month numbers (1–12) the checklist runs in. `nextDueDate` advance logic is
   * ignored in that mode.
   */
  scheduledMonths?: number[]
  /**
   * Only meaningful when `frequency === 'specific-months'`: the day of month
   * (1–28; capped to avoid invalid dates in short months) the checklist is due
   * in each designated month. Defaults to the last day of month when unset.
   */
  dueDayOfMonth?: number
  /**
   * A standard template is client-agnostic — it has no client, never
   * materializes checklists on its own, and exists purely as a reusable
   * blueprint that can be applied/copied onto a client.
   */
  isStandard?: boolean
  viewerIds: string[]
  editorIds: string[]
  stages: TemplateStage[]
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
   * ISO timestamp set when an owner soft-deletes the checklist; the row is
   * moved to `AppData.recycledChecklists` and excluded from the active
   * `AppData.checklists` list. Cleared on restore, removed entirely when
   * the bin is emptied. Unset on every active checklist.
   */
  deletedAt?: string | null
}

export type FirmSettings = {
  name: string
  tagline?: string
  logoUrl?: string
  brandColor?: string
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

export type PublicFirmSettings = Pick<FirmSettings, 'name' | 'tagline' | 'logoUrl' | 'brandColor'>

export const DEFAULT_FIRM_SETTINGS: FirmSettings = {
  name: 'PB&J Strategic Accounting',
  tagline: '',
  logoUrl: '',
  brandColor: '#3c2044',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  phone: '',
  email: '',
  website: '',
  ein: '',
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
}

export type TotpStatus = {
  enabled: boolean
  remainingBackupCodes: number
  requiredForRole: boolean
}

export type TotpSetupInit = {
  secret: string
  otpauthUri: string
  qrSvg: string
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
