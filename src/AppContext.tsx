import { createContext, useContext } from 'react'
import type {
  AppData,
  BillingMode,
  Checklist,
  ChecklistTemplate,
  Client,
  Role,
  SessionUser,
  SubscriptionPlan,
  TimeEntry,
  TimerState,
} from './lib/types'

export type AppContextValue = {
  data: AppData
  sessionUser: SessionUser
  role: Role
  ownerMode: boolean
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
  logTime: (entry: Omit<TimeEntry, 'id'>) => Promise<void>
  toggleChecklistItem: (checklistId: string, itemId: string) => Promise<void>
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
  addChecklistTemplateItem: (templateId: string) => void
  updateChecklistTemplateItem: (templateId: string, itemId: string, label: string) => void
  setChecklistTemplateItemDueDate: (
    templateId: string,
    itemId: string,
    dueDate: string,
  ) => void
  setChecklistTemplateItemAssignee: (
    templateId: string,
    itemId: string,
    assigneeId: string,
  ) => void
  reorderChecklistTemplateItems: (templateId: string, orderedIds: string[]) => void
  bulkAddChecklistTemplateItems: (templateId: string, labels: string[]) => void
  removeChecklistTemplateItem: (templateId: string, itemId: string) => void
  duplicateChecklistTemplate: (templateId: string) => void
  reorderChecklistItems: (checklistId: string, orderedIds: string[]) => void
  bulkAddChecklistItems: (checklistId: string, labels: string[]) => void
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
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useAppContext(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) {
    throw new Error('useAppContext must be used inside AppContext.Provider')
  }
  return value
}
