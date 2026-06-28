import { createContext, useContext } from 'react'
import type { GroupAllocationMode } from './lib/utils'
import type { ReportPeriod } from './lib/reportPeriod'
import type {
  AppData,
  BillingMode,
  Checklist,
  ChecklistTemplate,
  ChecklistTemplateItem,
  Client,
  Contact,
  FeatureRequest,
  FeatureRequestType,
  FirmSettings,
  ItemDeletionRequest,
  Role,
  ServiceCategory,
  SessionUser,
  SubscriptionPlan,
  TemplateStage,
  TimeEntry,
  TimerState,
} from './lib/types'

export type AppContextValue = {
  data: AppData
  sessionUser: SessionUser
  effectiveUser: SessionUser
  role: Role
  ownerMode: boolean
  previewUserId: string | null
  setPreviewUserId: (id: string | null) => void
  previewMode: boolean
  activeEmployeeId: string
  visibleChecklists: Checklist[]
  visibleClients: Client[]
  visibleClientIds: Set<string>
  /**
   * Clients this user is allowed to log time against — strictly their
   * Assigned Team list (`assignedBookkeeperIds`). Owners outside preview
   * mode get every client; while an owner previews a bookkeeper this
   * narrows to the bookkeeper's assignments so the time dropdowns match
   * what the previewed user would actually see.
   */
  timeTrackingClients: Client[]
  visibleEntries: TimeEntry[]
  billingPeriod: string
  setBillingPeriod: (period: string) => void
  /**
   * Shared "Report period" date range used by the Time, Timesheet, Board, and
   * Checklists views. Per-user, persisted in localStorage (NOT server data).
   * Distinct from `billingPeriod`, which is the invoicing month picker.
   */
  reportPeriod: ReportPeriod
  setReportPeriod: (period: ReportPeriod) => void
  timer: TimerState | null
  timerElapsed: string
  startTimer: (timer: TimerState) => void
  updateTimer: (patch: Partial<TimerState>) => void
  cancelTimer: () => void
  stopTimer: (descriptionOverride?: string) => Promise<void>
  logTime: (entry: Omit<TimeEntry, 'id' | 'approvalStatus'>) => Promise<void>
  splitGroupEntry: (
    holding: TimeEntry,
    mode: GroupAllocationMode,
    customMinutes: Record<string, number>,
  ) => Promise<void>
  updateTimeEntry: (
    entryId: string,
    patch: {
      minutes?: number
      description?: string
      billable?: boolean
      taskId?: string | null
      date?: string
      startAt?: string
      endAt?: string
      sessions?: { startAt: string; endAt: string }[]
      employeeId?: string
    },
  ) => Promise<void>
  deleteTimeEntry: (entryId: string) => Promise<void>
  approveTimeEntry: (entryId: string) => Promise<void>
  rejectTimeEntry: (entryId: string, note: string) => Promise<void>
  approveTimeEntriesBatch: (entryIds: string[]) => Promise<void>
  lockTimesheet: (userId: string, period: string) => Promise<void>
  unlockTimesheet: (userId: string, period: string) => Promise<void>
  /**
   * Bookkeeper / accountant submits their own Sun-Sat week for owner
   * review. `weekStart` is the YYYY-MM-DD Sunday that anchors the week.
   * Idempotent: re-submitting after a rejection upgrades the same row.
   */
  submitWeeklyTimesheet: (weekStart: string) => Promise<void>
  /** Owner-only: approve a pending weekly submission. */
  approveWeeklySubmission: (submissionId: string) => Promise<void>
  /** Owner-only: reject a pending weekly submission with a written note. */
  rejectWeeklySubmission: (submissionId: string, note: string) => Promise<void>
  /**
   * Owner-only: add an expense reimbursement to a client. Shows up as a
   * line on the invoice for the month matching the `date`.
   */
  addReimbursement: (input: {
    clientId: string
    date: string
    description: string
    amount: number
  }) => Promise<void>
  /** Owner-only: edit a reimbursement (date / description / amount). */
  updateReimbursement: (
    id: string,
    patch: { date?: string; description?: string; amount?: number },
  ) => Promise<void>
  /** Owner-only: remove a reimbursement. */
  deleteReimbursement: (id: string) => Promise<void>
  /**
   * Owner-only: add a recurring reimbursement to a client. `frequency`
   * controls how often it appears on the invoice (monthly / quarterly /
   * annually), anchored on the month of `startDate`.
   */
  addRecurringReimbursement: (input: {
    clientId: string
    description: string
    amount: number
    frequency: 'monthly' | 'quarterly' | 'annually'
    startDate: string
  }) => Promise<void>
  /** Owner-only: edit a recurring reimbursement (partial patch). */
  updateRecurringReimbursement: (
    id: string,
    patch: {
      description?: string
      amount?: number
      frequency?: 'monthly' | 'quarterly' | 'annually'
      startDate?: string
    },
  ) => Promise<void>
  /** Owner-only: stop a recurring reimbursement by deleting it. */
  deleteRecurringReimbursement: (id: string) => Promise<void>
  toggleChecklistItem: (checklistId: string, itemId: string) => Promise<void>
  /** Toggle one sub-item of a live-checklist item (recomputes parent done). */
  toggleSubItem: (checklistId: string, itemId: string, subItemId: string) => Promise<void>
  /** Add a sub-item under a live-checklist item. */
  addSubItem: (checklistId: string, itemId: string, title: string) => Promise<void>
  /** Remove a sub-item from a live-checklist item. */
  removeSubItem: (checklistId: string, itemId: string, subItemId: string) => Promise<void>
  /** Toggle one sub-sub-item (recomputes its sub-item, then the top item). */
  toggleSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => Promise<void>
  /** Add a sub-sub-item under a sub-item of a live-checklist item. */
  addSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => Promise<void>
  /** Remove a sub-sub-item from a sub-item of a live-checklist item. */
  removeSubSubItem: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => Promise<void>
  setChecklistViewers: (
    checklistId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void>
  setTemplateViewers: (
    templateId: string,
    viewerIds: string[],
    editorIds: string[],
  ) => Promise<void>
  addChecklistTemplate: (template: Omit<ChecklistTemplate, 'id'>) => void
  updateChecklistTemplate: (
    templateId: string,
    updater: (template: ChecklistTemplate) => ChecklistTemplate,
  ) => void
  deleteChecklistTemplate: (templateId: string) => void
  updateChecklist: (
    checklistId: string,
    patch: { title?: string; dueDate?: string; assigneeId?: string; categoryId?: string | null },
  ) => void
  /**
   * The Active Checklists board columns (service categories), loaded from the
   * server independently of the bulk workspace data. Empty until the first
   * fetch resolves.
   */
  serviceCategories: ServiceCategory[]
  /** Owner-only: create a board column. Resolves to the created category. */
  addServiceCategory: (name: string) => Promise<ServiceCategory>
  /** Owner-only: rename and/or reorder a board column. */
  updateServiceCategory: (
    id: string,
    patch: { name?: string; sortOrder?: number },
  ) => Promise<void>
  /** Owner-only: delete a board column (its checklists become Uncategorized). */
  deleteServiceCategory: (id: string) => Promise<void>
  /**
   * Owner-only "Updates" tracker items, loaded from the server independently of
   * the bulk workspace data. Empty for staff (and until the first fetch).
   */
  featureRequests: FeatureRequest[]
  /** Owner-only: create an update. Resolves to the created item. */
  addFeatureRequest: (input: {
    title: string
    description: string
    type: FeatureRequestType
  }) => Promise<FeatureRequest>
  /** Owner-only: patch any field of an update (status/urgent/title/etc.). */
  updateFeatureRequest: (
    id: string,
    patch: Partial<{
      title: string
      description: string
      type: FeatureRequestType
      status: FeatureRequest['status']
      urgent: boolean
      priorityRank: number
      devNotes: string
    }>,
  ) => Promise<void>
  /** Owner-only: re-rank updates to the given id order (drag-to-reorder). */
  reorderFeatureRequests: (orderedIds: string[]) => Promise<void>
  /** Owner-only: delete an update. */
  removeFeatureRequest: (id: string) => Promise<void>
  /**
   * Owner-only: ask the AI to refine an update into a dev-ready spec. Returns
   * the suggested title/description WITHOUT saving (the UI accepts → PATCH).
   */
  refineFeatureRequest: (id: string) => Promise<{ title: string; description: string }>
  addChecklistTemplateItem: (templateId: string, stageId: string) => void
  updateChecklistTemplateItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    label: string,
  ) => void
  setChecklistTemplateItemDueDate: (
    templateId: string,
    stageId: string,
    itemId: string,
    dueDate: string,
  ) => void
  setChecklistTemplateItemAssignee: (
    templateId: string,
    stageId: string,
    itemId: string,
    assigneeId: string,
  ) => void
  reorderChecklistTemplateItems: (
    templateId: string,
    stageId: string,
    orderedIds: string[],
  ) => void
  bulkAddChecklistTemplateItems: (
    templateId: string,
    stageId: string,
    labels: string[],
  ) => void
  removeChecklistTemplateItem: (templateId: string, stageId: string, itemId: string) => void
  /** Add a sub-item under a template item (flows into generated checklists). */
  addChecklistTemplateSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    title: string,
  ) => void
  /** Rename a template item's sub-item. */
  updateChecklistTemplateSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => void
  /** Remove a sub-item from a template item. */
  removeChecklistTemplateSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
  ) => void
  /** Add a sub-sub-item under a template item's sub-item (flows into generated checklists). */
  addChecklistTemplateSubSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    title: string,
  ) => void
  /** Rename a template item's sub-sub-item. */
  updateChecklistTemplateSubSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
    title: string,
  ) => void
  /** Remove a sub-sub-item from a template item's sub-item. */
  removeChecklistTemplateSubSubItem: (
    templateId: string,
    stageId: string,
    itemId: string,
    subItemId: string,
    subSubItemId: string,
  ) => void
  addTemplateStage: (templateId: string) => void
  removeTemplateStage: (templateId: string, stageId: string) => void
  patchTemplateStage: (
    templateId: string,
    stageId: string,
    patch: Partial<TemplateStage>,
  ) => void
  reorderTemplateStages: (templateId: string, orderedStageIds: string[]) => void
  duplicateChecklistTemplate: (templateId: string) => void
  /** Wave 2: create a standard (client-agnostic) reusable blueprint template. */
  createStandardTemplate: (
    payload: Omit<ChecklistTemplate, 'id' | 'clientId' | 'isStandard'>,
  ) => Promise<void>
  /** Wave 2: copy a standard OR regular template onto a client. */
  applyTemplateToClient: (
    templateId: string,
    payload: { clientId: string; firstDueDate?: string; frequency?: string },
  ) => Promise<void>
  /** Wave 2: materialize a Stage-1 checklist instance from a template on demand. */
  generateChecklistFromTemplate: (
    templateId: string,
    payload?: { dueDate?: string },
  ) => Promise<Checklist | null>
  /**
   * Owner-only: open a client's 3-stage onboarding case (Proposal → Onboarding
   * → Client) and move the client to 'proposal'. Returns true on success,
   * false if onboarding was already started or the client was missing.
   */
  startOnboarding: (clientId: string) => Promise<boolean>
  reorderChecklistItems: (checklistId: string, orderedIds: string[]) => void
  bulkAddChecklistItems: (checklistId: string, labels: string[]) => void
  createChecklist: (payload: {
    title: string
    clientId: string
    assigneeId: string
    dueDate: string
    categoryId?: string | null
    /** Items may carry a nested `subItems` tree built in the outliner. */
    items: Array<Pick<ChecklistTemplateItem, 'label' | 'subItems'>>
  }) => Promise<Checklist | null>
  updateChecklistItem: (
    checklistId: string,
    itemId: string,
    patch: {
      title?: string
      dueDate?: string | null
      assigneeId?: string | null
      waitingOn?: string | null
      waiting?: boolean
      waitingForChecklistId?: string | null
    },
  ) => Promise<void>
  updateSubItemWaiting: (
    checklistId: string,
    itemId: string,
    subItemId: string,
    patch: { waiting?: boolean; waitingOn?: string | null; waitingForChecklistId?: string | null },
  ) => Promise<void>
  deleteChecklistItem: (checklistId: string, itemId: string) => Promise<void>
  /**
   * Owner-only soft-delete: moves the checklist to `data.recycledChecklists`
   * (the recycle bin) without losing data. Use when a one-time task should
   * go away (client removed, employee left, task created in error). Time
   * entries referencing the checklist's items via `taskId` are preserved
   * on the server so billing history survives — they just become unlinked.
   */
  deleteChecklist: (checklistId: string) => Promise<void>
  /**
   * Owner-only: approve a staff deletion request — soft-deletes the checklist
   * to the recycle bin (same end state as a direct owner delete).
   */
  approveChecklistDeletion: (checklistId: string) => Promise<void>
  /**
   * Owner-only: reject a staff deletion request — clears the request flags and
   * leaves the checklist active.
   */
  rejectChecklistDeletion: (checklistId: string) => Promise<void>
  /**
   * Pending item-level deletion requests (staff asked to delete a single item /
   * sub-item / sub-sub-item). Owners see all; staff see only those for their
   * assigned clients. Drives the per-item "Deletion requested" badge + the
   * owner queue.
   */
  itemDeletionRequests: ItemDeletionRequest[]
  /**
   * Set of `${checklistId}:${itemId}:${subItemId||''}:${subSubItemId||''}` keys
   * for fast per-item "is a deletion pending?" lookup (see `itemDeletionKey`).
   */
  pendingItemDeletionKeys: Set<string>
  /** Owner-only: approve a pending item-deletion request (executes the delete). */
  approveItemDeletion: (requestId: string) => Promise<void>
  /** Owner-only: reject a pending item-deletion request (deletes nothing). */
  rejectItemDeletion: (requestId: string) => Promise<void>
  /** Owner-only: restore a recycled checklist back to the active list. */
  restoreChecklist: (checklistId: string) => Promise<void>
  /** Owner-only: permanently delete every recycled checklist. Not reversible. */
  emptyChecklistRecycleBin: () => Promise<void>
  /**
   * Owner-only: remove a team member with no barriers. The server reassigns
   * their checklists / templates / time entries to the calling owner so
   * billing history and in-flight work survive, and strips them from every
   * viewer / editor / assigned-team list. The handler mirrors that cleanup
   * on local state so the UI updates immediately. Re-throws on failure so
   * the caller (TeamPage) can surface an error toast.
   */
  deleteTeamMember: (userId: string) => Promise<void>
  updateClientPlan: (clientId: string, billingMode: BillingMode, planId: string | null) => void
  updateClient: (clientId: string, patch: Partial<Client>) => void
  deleteClient: (clientId: string) => void
  addClient: (client: Omit<Client, 'id'>) => Client
  addPlan: (plan: Omit<SubscriptionPlan, 'id'>) => void
  /**
   * Owner-only: patch a subscription plan's editable fields (name / notes).
   * Persists via the bulk app-data autosave — no dedicated endpoint, the
   * same way `updateContact` / `updateClient` do.
   */
  updatePlan: (planId: string, patch: Partial<SubscriptionPlan>) => void
  /**
   * Owner-only: permanently delete a subscription plan. Any clients
   * currently on it are unlinked (their `planId` flips to null and they
   * fall back to hourly billing). Server-side the FK cascade does the
   * unlink; the handler mirrors it on local state.
   */
  deletePlan: (planId: string) => Promise<void>
  /** Owner-only: add a reusable contact (shared across clients). */
  addContact: (contact: Omit<Contact, 'id'>) => void
  /** Owner-only: patch a reusable contact. */
  updateContact: (contactId: string, patch: Partial<Contact>) => void
  /**
   * Owner-only: delete a reusable contact. Also strips its id from every
   * client's `contactIds` so no client references a missing contact.
   */
  deleteContact: (contactId: string) => void
  /**
   * Owner-only: set the full set of contacts a contact is linked to, keeping
   * the relation symmetric (both sides updated). Local-only, persisted by the
   * bulk autosave.
   */
  setContactLinks: (contactId: string, nextLinkedIds: string[]) => void
  /** Owner-only: archive (stamp archivedAt) or unarchive (clear it) a contact. */
  setContactArchived: (contactId: string, archived: boolean) => void
  selectedClientId: string
  setSelectedClientId: (clientId: string) => void
  printInvoice: () => void
  handleLogout: () => Promise<void>
  dataSyncState: 'loading' | 'saving' | 'synced' | 'offline' | 'error'
  syncMessage: string
  firmSettings: FirmSettings
  setFirmSettings: (settings: FirmSettings) => void
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useAppContext(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) {
    throw new Error('useAppContext must be used inside AppContext.Provider')
  }
  return value
}
