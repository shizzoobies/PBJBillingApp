export type Role = 'employee' | 'owner'
export type BillingMode = 'hourly' | 'subscription'
export type ChecklistFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually'

export type Employee = {
  id: string
  name: string
  role: 'Bookkeeper' | 'Senior Bookkeeper' | 'Owner'
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

export type TimeEntry = {
  id: string
  employeeId: string
  clientId: string
  date: string
  minutes: number
  category: string
  description: string
  billable: boolean
  /** Optional link to a checklist (task) this entry was logged against. */
  taskId?: string | null
}

export type ChecklistItem = {
  id: string
  label: string
  done: boolean
  dueDate?: string
  assigneeId?: string
}

export type ChecklistTemplateItem = {
  id: string
  label: string
  dueDate?: string
  assigneeId?: string
}

export type TemplateStage = {
  id: string
  name: string
  assigneeId: string
  offsetDays: number
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
  clients: Client[]
  plans: SubscriptionPlan[]
  timeEntries: TimeEntry[]
  checklistTemplates: ChecklistTemplate[]
  checklists: Checklist[]
  firmSettings?: FirmSettings
}

export type TimerState = {
  employeeId: string
  clientId: string
  description: string
  category: string
  startedAt: number
}

export type InvoiceLine = {
  label: string
  detail: string
  amount: number
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

export type CategoryReportRow = {
  category: string
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
}

export type LoginOption = SessionUser

export type TeamMember = {
  id: string
  name: string
  email: string
  role: Role
  staffRole: string
  magicToken: string | null
  magicUrl: string | null
  tokenRevokedAt: string | null
  lastActiveAt: string | null
  createdAt: string | null
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
