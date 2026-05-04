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
}

export type ChecklistItem = {
  id: string
  label: string
  done: boolean
}

export type ChecklistTemplateItem = {
  id: string
  label: string
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
  items: ChecklistTemplateItem[]
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
}

export type AppData = {
  employees: Employee[]
  clients: Client[]
  plans: SubscriptionPlan[]
  timeEntries: TimeEntry[]
  checklistTemplates: ChecklistTemplate[]
  checklists: Checklist[]
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

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
