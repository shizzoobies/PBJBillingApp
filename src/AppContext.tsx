import { createContext, useContext } from 'react'
import type {
  AppData,
  BillingMode,
  Checklist,
  ChecklistTemplate,
  Client,
  FirmSettings,
  Role,
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
  visibleEntries: TimeEntry[]
  billingPeriod: string
  setBillingPeriod: (period: string) => void
  timer: TimerState | null
  timerElapsed: string
  startTimer: (timer: TimerState) => void
  stopTimer: () => Promise<void>
  logTime: (entry: Omit<TimeEntry, 'id' | 'approvalStatus'>) => Promise<void>
  updateTimeEntry: (
    entryId: string,
    patch: {
      minutes?: number
      description?: string
      billable?: boolean
      taskId?: string | null
      date?: string
    },
  ) => Promise<void>
  deleteTimeEntry: (entryId: string) => Promise<void>
  approveTimeEntry: (entryId: string) => Promise<void>
  rejectTimeEntry: (entryId: string, note: string) => Promise<void>
  approveTimeEntriesBatch: (entryIds: string[]) => Promise<void>
  lockTimesheet: (userId: string, period: string) => Promise<void>
  unlockTimesheet: (userId: string, period: string) => Promise<void>
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
  reorderChecklistItems: (checklistId: string, orderedIds: string[]) => void
  bulkAddChecklistItems: (checklistId: string, labels: string[]) => void
  createChecklist: (payload: {
    title: string
    clientId: string
    assigneeId: string
    dueDate: string
    items: Array<{ label: string }>
  }) => Promise<Checklist | null>
  updateChecklistItem: (
    checklistId: string,
    itemId: string,
    patch: { title?: string; dueDate?: string | null; assigneeId?: string | null },
  ) => Promise<void>
  deleteChecklistItem: (checklistId: string, itemId: string) => Promise<void>
  updateClientPlan: (clientId: string, billingMode: BillingMode, planId: string | null) => void
  updateClient: (clientId: string, patch: Partial<Client>) => void
  deleteClient: (clientId: string) => void
  addClient: (client: Omit<Client, 'id'>) => void
  addPlan: (plan: Omit<SubscriptionPlan, 'id'>) => void
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
