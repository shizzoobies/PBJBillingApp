import {
  Building2,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  FileText,
  FolderKanban,
  ListChecks,
  Plus,
  Printer,
  ReceiptText,
  ShieldCheck,
  TimerReset,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import './App.css'

type Role = 'employee' | 'owner'
type BillingMode = 'hourly' | 'subscription'
type ChecklistFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually'

type Employee = {
  id: string
  name: string
  role: 'Bookkeeper' | 'Senior Bookkeeper' | 'Owner'
}

type Client = {
  id: string
  name: string
  contact: string
  billingMode: BillingMode
  hourlyRate: number
  planId: string | null
  assignedEmployeeIds?: string[]
}

type SubscriptionPlan = {
  id: string
  name: string
  monthlyFee: number
  includedHours: number
  notes: string
}

type TimeEntry = {
  id: string
  employeeId: string
  clientId: string
  date: string
  minutes: number
  category: string
  description: string
  billable: boolean
}

type ChecklistItem = {
  id: string
  label: string
  done: boolean
}

type ChecklistTemplateItem = {
  id: string
  label: string
}

type ChecklistTemplate = {
  id: string
  title: string
  clientId: string
  assigneeId: string
  frequency: ChecklistFrequency
  nextDueDate: string
  active: boolean
  items: ChecklistTemplateItem[]
}

type Checklist = {
  id: string
  title: string
  clientId: string
  assigneeId: string
  templateId?: string
  frequency?: ChecklistFrequency
  dueDate: string
  items: ChecklistItem[]
}

type AppData = {
  employees: Employee[]
  clients: Client[]
  plans: SubscriptionPlan[]
  timeEntries: TimeEntry[]
  checklistTemplates: ChecklistTemplate[]
  checklists: Checklist[]
}

type TimerState = {
  employeeId: string
  clientId: string
  description: string
  category: string
  startedAt: number
}

type InvoiceLine = {
  label: string
  detail: string
  amount: number
}

type Invoice = {
  client: Client
  plan: SubscriptionPlan | null
  billableMinutes: number
  entryCount: number
  period: string
  periodLabel: string
  lines: InvoiceLine[]
  total: number
}

type EmployeeReportRow = {
  employeeId: string
  minutes: number
  billableMinutes: number
  internalMinutes: number
  entryCount: number
  clientCount: number
}

type ClientReportRow = {
  clientId: string
  minutes: number
  billableMinutes: number
  internalMinutes: number
  entryCount: number
  employeeCount: number
  invoiceTotal: number
}

type CategoryReportRow = {
  category: string
  minutes: number
  entryCount: number
}

type DataSyncState = 'loading' | 'saving' | 'synced' | 'offline' | 'error'
type AuthState = 'loading' | 'ready'

type SessionUser = {
  id: string
  name: string
  email: string
  role: Role
  staffRole: string
}

type LoginOption = SessionUser

class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
})

const navItems: Array<{ id: string; label: string; icon: LucideIcon; ownerOnly?: boolean }> = [
  { id: 'time', label: 'Time', icon: Clock3 },
  { id: 'checklists', label: 'Checklists', icon: ListChecks },
  { id: 'clients', label: 'Clients', icon: Building2 },
  { id: 'reports', label: 'Reports', icon: FolderKanban, ownerOnly: true },
  { id: 'invoices', label: 'Invoices', icon: ReceiptText, ownerOnly: true },
  { id: 'plans', label: 'Plans', icon: WalletCards, ownerOnly: true },
]

const checklistFrequencies: ChecklistFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly', 'annually']

function dateOffset(days: number) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function currentBillingPeriod() {
  return new Date().toISOString().slice(0, 7)
}

function getBillingPeriodLabel(period: string) {
  const [year, month] = period.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1))
}

function isInBillingPeriod(entry: TimeEntry, period: string) {
  return entry.date.startsWith(period)
}

function getAssignedEmployeeIds(client: Client) {
  return client.assignedEmployeeIds ?? []
}

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T12:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function addMonths(dateString: string, months: number) {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1 + months, day).toISOString().slice(0, 10)
}

function advanceChecklistFrequency(dateString: string, frequency: ChecklistFrequency) {
  if (frequency === 'daily') {
    return addDays(dateString, 1)
  }

  if (frequency === 'weekly') {
    return addDays(dateString, 7)
  }

  if (frequency === 'quarterly') {
    return addMonths(dateString, 3)
  }

  if (frequency === 'annually') {
    return addMonths(dateString, 12)
  }

  return addMonths(dateString, 1)
}

function getChecklistFrequencyLabel(frequency: ChecklistFrequency) {
  return frequency.charAt(0).toUpperCase() + frequency.slice(1)
}

function sortChecklists(checklists: Checklist[]) {
  return [...checklists].sort((left, right) => {
    if (left.dueDate !== right.dueDate) {
      return left.dueDate.localeCompare(right.dueDate)
    }

    return left.title.localeCompare(right.title)
  })
}

function ensureRecurringChecklists(data: AppData) {
  const templates = data.checklistTemplates ?? []
  const existingChecklists = data.checklists ?? []
  const existingKeys = new Set(
    existingChecklists
      .filter((checklist) => checklist.templateId)
      .map((checklist) => `${checklist.templateId}:${checklist.dueDate}`),
  )
  const today = new Date().toISOString().slice(0, 10)
  const checklistTemplates = templates.map((template) => ({
    ...template,
    items: template.items.map((item) => ({ ...item })),
  }))
  const checklists = [...existingChecklists]
  let changed = false

  for (const template of checklistTemplates) {
    if (!template.active || template.items.length === 0) {
      continue
    }

    let safetyCounter = 0
    while (template.nextDueDate <= today && safetyCounter < 60) {
      const instanceKey = `${template.id}:${template.nextDueDate}`
      if (!existingKeys.has(instanceKey)) {
        checklists.push({
          id: makeId('check'),
          templateId: template.id,
          title: template.title,
          clientId: template.clientId,
          assigneeId: template.assigneeId,
          frequency: template.frequency,
          dueDate: template.nextDueDate,
          items: template.items.map((item) => ({
            id: makeId('item'),
            label: item.label,
            done: false,
          })),
        })
        existingKeys.add(instanceKey)
        changed = true
      }

      const nextDueDate = advanceChecklistFrequency(template.nextDueDate, template.frequency)
      if (nextDueDate === template.nextDueDate) {
        break
      }

      template.nextDueDate = nextDueDate
      changed = true
      safetyCounter += 1
    }
  }

  if (!changed) {
    return { changed: false, data }
  }

  return {
    changed: true,
    data: {
      ...data,
      checklistTemplates,
      checklists: sortChecklists(checklists),
    },
  }
}

function createSeedData(): AppData {
  return {
    employees: [
      { id: 'emp-avery', name: 'Avery Johnson', role: 'Senior Bookkeeper' },
      { id: 'emp-jordan', name: 'Jordan Ellis', role: 'Bookkeeper' },
      { id: 'emp-patrice', name: 'Patrice Bell', role: 'Owner' },
    ],
    clients: [
      {
        id: 'client-clover',
        name: 'Clover Ridge Dental',
        contact: 'Dr. Maya Kent',
        billingMode: 'hourly',
        hourlyRate: 145,
        planId: null,
        assignedEmployeeIds: ['emp-avery'],
      },
      {
        id: 'client-northstar',
        name: 'Northstar Wellness Co.',
        contact: 'Amara Stone',
        billingMode: 'subscription',
        hourlyRate: 150,
        planId: 'plan-growth',
        assignedEmployeeIds: ['emp-avery'],
      },
      {
        id: 'client-riverbend',
        name: 'Riverbend Market',
        contact: 'Jon Bellamy',
        billingMode: 'subscription',
        hourlyRate: 125,
        planId: 'plan-essentials',
        assignedEmployeeIds: ['emp-jordan'],
      },
    ],
    plans: [
      {
        id: 'plan-essentials',
        name: 'Monthly Close Essentials',
        monthlyFee: 900,
        includedHours: 8,
        notes: 'Bank feeds, reconciliations, and monthly close checklist.',
      },
      {
        id: 'plan-growth',
        name: 'Growth Advisory',
        monthlyFee: 1850,
        includedHours: 15,
        notes: 'Close support, payroll review, owner reporting, and advisory calls.',
      },
      {
        id: 'plan-payroll',
        name: 'Payroll Plus',
        monthlyFee: 520,
        includedHours: 3,
        notes: 'Payroll review, filings checklist, and exception tracking.',
      },
    ],
    timeEntries: [
      {
        id: 'time-1',
        employeeId: 'emp-avery',
        clientId: 'client-northstar',
        date: dateOffset(-1),
        minutes: 135,
        category: 'Bookkeeping',
        description: 'Reconciled operating account and reviewed uncategorized feed items.',
        billable: true,
      },
      {
        id: 'time-2',
        employeeId: 'emp-jordan',
        clientId: 'client-riverbend',
        date: dateOffset(-2),
        minutes: 75,
        category: 'Payroll',
        description: 'Checked payroll register against wage expense and benefits deductions.',
        billable: true,
      },
      {
        id: 'time-3',
        employeeId: 'emp-avery',
        clientId: 'client-clover',
        date: dateOffset(-3),
        minutes: 110,
        category: 'Cleanup',
        description: 'Reviewed dental supply vendor splits and added supporting notes.',
        billable: true,
      },
      {
        id: 'time-4',
        employeeId: 'emp-jordan',
        clientId: 'client-riverbend',
        date: dateOffset(-4),
        minutes: 35,
        category: 'Admin',
        description: 'Internal checklist prep for month-end meeting.',
        billable: false,
      },
    ],
    checklistTemplates: [
      {
        id: 'template-monthly-bookkeeping',
        title: 'Monthly Bookkeeping - CD',
        clientId: 'client-clover',
        assigneeId: 'emp-avery',
        frequency: 'monthly',
        nextDueDate: dateOffset(-2),
        active: true,
        items: [
          { id: 'template-monthly-bookkeeping-1', label: 'Clear Bank Feed - Vystar' },
          { id: 'template-monthly-bookkeeping-2', label: 'Clear Bank Feed - Amex' },
          { id: 'template-monthly-bookkeeping-3', label: 'Reconcile Books to Statements - Vystar CK' },
          { id: 'template-monthly-bookkeeping-4', label: 'Reconcile Books to Statements - Vystar SVG' },
          { id: 'template-monthly-bookkeeping-5', label: 'Reconcile Books to Statements - Vystar Loan' },
          { id: 'template-monthly-bookkeeping-6', label: 'Reconcile Books to Statements - Vystar LOC' },
          { id: 'template-monthly-bookkeeping-7', label: 'Reconcile Books to Statements - Amex' },
          { id: 'template-monthly-bookkeeping-8', label: 'Reconcile Books to Statements - Madison Trust Co' },
        ],
      },
      {
        id: 'template-quarterly-bookkeeping',
        title: 'Quarterly Bookkeeping - CD',
        clientId: 'client-clover',
        assigneeId: 'emp-avery',
        frequency: 'quarterly',
        nextDueDate: dateOffset(70),
        active: true,
        items: [
          { id: 'template-quarterly-bookkeeping-1', label: 'Clear Bank Feed - Vystar' },
          { id: 'template-quarterly-bookkeeping-2', label: 'Clear Bank Feed - Amex' },
          { id: 'template-quarterly-bookkeeping-3', label: 'Reconcile Books to Statements - Vystar CK' },
          { id: 'template-quarterly-bookkeeping-4', label: 'Reconcile Books to Statements - Vystar SVG' },
          { id: 'template-quarterly-bookkeeping-5', label: 'Reconcile Books to Statements - Vystar Loan' },
          { id: 'template-quarterly-bookkeeping-6', label: 'Reconcile Books to Statements - Vystar LOC' },
          { id: 'template-quarterly-bookkeeping-7', label: 'Review each balance sheet item matches statements' },
          { id: 'template-quarterly-bookkeeping-8', label: 'Review each account on the P&L' },
          { id: 'template-quarterly-bookkeeping-9', label: 'Send reports to client' },
          { id: 'template-quarterly-bookkeeping-10', label: 'Client call' },
        ],
      },
      {
        id: 'template-payroll',
        title: 'Payroll - CD',
        clientId: 'client-clover',
        assigneeId: 'emp-jordan',
        frequency: 'weekly',
        nextDueDate: dateOffset(4),
        active: true,
        items: [
          { id: 'template-payroll-1', label: 'Review payroll draft' },
          { id: 'template-payroll-2', label: 'Confirm payroll liabilities' },
          { id: 'template-payroll-3', label: 'Post payroll journal entry' },
        ],
      },
      {
        id: 'template-sales-tax',
        title: 'Monthly Sales Tax - CD',
        clientId: 'client-riverbend',
        assigneeId: 'emp-jordan',
        frequency: 'monthly',
        nextDueDate: dateOffset(20),
        active: true,
        items: [
          { id: 'template-sales-tax-1', label: 'Pull taxable sales report' },
          { id: 'template-sales-tax-2', label: 'Review exemptions and adjustments' },
          { id: 'template-sales-tax-3', label: 'File and confirm payment' },
        ],
      },
      {
        id: 'template-1099',
        title: '1099 Preparation - CD',
        clientId: 'client-clover',
        assigneeId: 'emp-patrice',
        frequency: 'annually',
        nextDueDate: '2026-11-30',
        active: true,
        items: [
          { id: 'template-1099-1', label: 'Review GL for payments made to vendors' },
          { id: 'template-1099-2', label: 'Review GL after final transactions added for YE' },
          { id: 'template-1099-3', label: 'Send 1099 list to client for approval' },
          { id: 'template-1099-4', label: 'Prepare and send 1099s' },
        ],
      },
    ],
    checklists: [],
  }
}

async function fetchAppData(signal: AbortSignal) {
  const response = await fetch('/api/app-data', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load app data (${response.status})`)
  }

  return (await response.json()) as AppData
}

async function saveAppData(data: AppData) {
  const response = await fetch('/api/app-data', {
    credentials: 'same-origin',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to save app data (${response.status})`)
  }
}

async function fetchSession(signal: AbortSignal) {
  const response = await fetch('/api/session', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load session (${response.status})`)
  }

  return (await response.json()) as { user: SessionUser | null }
}

async function fetchLoginOptions(signal: AbortSignal) {
  const response = await fetch('/api/login-options', { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load login options (${response.status})`)
  }

  return (await response.json()) as { users: LoginOption[] }
}

async function loginWithPassword(userId: string, password: string) {
  const response = await fetch('/api/login', {
    credentials: 'same-origin',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId, password }),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to log in (${response.status})`)
  }

  return (await response.json()) as { user: SessionUser }
}

async function logoutSession() {
  const response = await fetch('/api/logout', {
    credentials: 'same-origin',
    method: 'POST',
  })

  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, `Failed to log out (${response.status})`)
  }
}

async function createTimeEntry(entry: Omit<TimeEntry, 'id'>) {
  const response = await fetch('/api/time-entries', {
    credentials: 'same-origin',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(entry),
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to create time entry (${response.status})`)
  }

  return (await response.json()) as TimeEntry
}

async function toggleChecklistItemRequest(checklistId: string, itemId: string) {
  const response = await fetch(`/api/checklists/${checklistId}/items/${itemId}/toggle`, {
    credentials: 'same-origin',
    method: 'POST',
  })

  if (!response.ok) {
    throw new ApiError(response.status, `Failed to update checklist item (${response.status})`)
  }

  return (await response.json()) as Checklist
}

function formatHours(minutes: number) {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`
}

function formatTimeFromMs(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function employeeName(employees: Employee[], employeeId: string) {
  return employees.find((employee) => employee.id === employeeId)?.name ?? 'Unassigned'
}

function clientName(clients: Client[], clientId: string) {
  return clients.find((client) => client.id === clientId)?.name ?? 'Unknown client'
}

function getInvoice(client: Client, entries: TimeEntry[], plans: SubscriptionPlan[], billingPeriod: string): Invoice {
  const billableEntries = entries.filter(
    (entry) => entry.clientId === client.id && entry.billable && isInBillingPeriod(entry, billingPeriod),
  )
  const billableMinutes = billableEntries.reduce((total, entry) => total + entry.minutes, 0)
  const billableAmount = (billableMinutes / 60) * client.hourlyRate
  const plan = client.planId ? plans.find((item) => item.id === client.planId) ?? null : null
  const periodLabel = getBillingPeriodLabel(billingPeriod)

  if (client.billingMode === 'subscription' && plan) {
    const includedMinutes = plan.includedHours * 60
    const overageMinutes = Math.max(0, billableMinutes - includedMinutes)
    const lines: InvoiceLine[] = [
      {
        label: `${plan.name} subscription`,
        detail: `${plan.includedHours} included hours`,
        amount: plan.monthlyFee,
      },
      {
        label: 'Billable time tracked',
        detail: `${formatHours(billableMinutes)} this period`,
        amount: 0,
      },
    ]

    if (overageMinutes > 0) {
      lines.push({
        label: 'Hourly overage',
        detail: `${formatHours(overageMinutes)} at ${currency.format(client.hourlyRate)}/hr`,
        amount: (overageMinutes / 60) * client.hourlyRate,
      })
    }

    return {
      client,
      plan,
      billableMinutes,
      entryCount: billableEntries.length,
      period: billingPeriod,
      periodLabel,
      lines,
      total: lines.reduce((total, line) => total + line.amount, 0),
    }
  }

  return {
    client,
    plan,
    billableMinutes,
    entryCount: billableEntries.length,
    period: billingPeriod,
    periodLabel,
    lines: [
      {
        label: 'Billable hours',
        detail: `${formatHours(billableMinutes)} at ${currency.format(client.hourlyRate)}/hr`,
        amount: billableAmount,
      },
    ],
    total: billableAmount,
  }
}

function App() {
  const [data, setData] = useState<AppData>(createSeedData)
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null)
  const [loginOptions, setLoginOptions] = useState<LoginOption[]>([])
  const [loginError, setLoginError] = useState('')
  const [loginPending, setLoginPending] = useState(false)
  const [dataSyncState, setDataSyncState] = useState<DataSyncState>('loading')
  const [serverPersistenceEnabled, setServerPersistenceEnabled] = useState(false)
  const [activeEmployeeId, setActiveEmployeeId] = useState('emp-avery')
  const [activeSection, setActiveSection] = useState('time')
  const [selectedClientId, setSelectedClientId] = useState('client-northstar')
  const [billingPeriod, setBillingPeriod] = useState(currentBillingPeriod())
  const [timer, setTimer] = useState<TimerState | null>(null)
  const [now, setNow] = useState(0)
  const skipAutosaveRef = useRef(0)
  const role = sessionUser?.role ?? 'employee'

  useEffect(() => {
    const controller = new AbortController()

    const load = async () => {
      try {
        const [loginResponse, sessionResponse] = await Promise.all([
          fetchLoginOptions(controller.signal),
          fetchSession(controller.signal),
        ])
        setLoginOptions(loginResponse.users)
        setSessionUser(sessionResponse.user)
        if (sessionResponse.user?.role === 'employee') {
          setActiveEmployeeId(sessionResponse.user.id)
        }
      } catch {
        if (controller.signal.aborted) {
          return
        }
      } finally {
        if (!controller.signal.aborted) {
          setAuthState('ready')
        }
      }
    }

    void load()

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!sessionUser) {
      return
    }

    const controller = new AbortController()

    const load = async () => {
      try {
        const remoteData = ensureRecurringChecklists(await fetchAppData(controller.signal)).data
        skipAutosaveRef.current += 1
        setData(remoteData)
        setServerPersistenceEnabled(true)
        setDataSyncState('synced')
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }

        if (error instanceof ApiError && error.status === 401) {
          setSessionUser(null)
          setServerPersistenceEnabled(false)
          setDataSyncState('offline')
          return
        }

        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
      }
    }

    void load()

    return () => controller.abort()
  }, [sessionUser])

  useEffect(() => {
    if (!serverPersistenceEnabled) {
      return
    }

    if (skipAutosaveRef.current > 0) {
      skipAutosaveRef.current -= 1
      setDataSyncState('synced')
      return
    }

    const timeoutId = window.setTimeout(() => {
      const persist = async () => {
        try {
          setDataSyncState('saving')
          await saveAppData(data)
          setDataSyncState('synced')
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            setSessionUser(null)
            setServerPersistenceEnabled(false)
            return
          }

          setDataSyncState('error')
        }
      }

      void persist()
    }, 250)

    return () => window.clearTimeout(timeoutId)
  }, [data, serverPersistenceEnabled])

  useEffect(() => {
    if (!timer) {
      return
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [timer])

  const visibleChecklists = useMemo(() => {
    if (role === 'owner') {
      return sortChecklists(data.checklists)
    }

    return sortChecklists(data.checklists.filter((checklist) => checklist.assigneeId === activeEmployeeId))
  }, [activeEmployeeId, data.checklists, role])

  const visibleClientIds = useMemo(() => {
    if (role === 'owner') {
      return new Set(data.clients.map((client) => client.id))
    }

    return new Set([
      ...data.clients
        .filter((client) => getAssignedEmployeeIds(client).includes(activeEmployeeId))
        .map((client) => client.id),
      ...data.checklists
        .filter((checklist) => checklist.assigneeId === activeEmployeeId)
        .map((checklist) => checklist.clientId),
      ...data.timeEntries
        .filter((entry) => entry.employeeId === activeEmployeeId)
        .map((entry) => entry.clientId),
    ])
  }, [activeEmployeeId, data.checklists, data.clients, data.timeEntries, role])

  const visibleClients = useMemo(
    () => data.clients.filter((client) => visibleClientIds.has(client.id)),
    [data.clients, visibleClientIds],
  )

  const visibleEntries = useMemo(() => {
    if (role === 'owner') {
      return data.timeEntries
    }

    return data.timeEntries.filter((entry) => entry.employeeId === activeEmployeeId)
  }, [activeEmployeeId, data.timeEntries, role])

  const selectedClient = data.clients.find((client) => client.id === selectedClientId) ?? data.clients[0]
  const invoice = getInvoice(selectedClient, data.timeEntries, data.plans, billingPeriod)
  const periodVisibleEntries = visibleEntries.filter((entry) => isInBillingPeriod(entry, billingPeriod))
  const billingPeriodEntries = data.timeEntries.filter((entry) => isInBillingPeriod(entry, billingPeriod))
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)

  const billableMinutes = periodVisibleEntries
    .filter((entry) => entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  const openChecklistItems = visibleChecklists.reduce(
    (total, checklist) => total + checklist.items.filter((item) => !item.done).length,
    0,
  )
  const ownerInvoiceTotal = data.clients.reduce(
    (total, client) => total + getInvoice(client, data.timeEntries, data.plans, billingPeriod).total,
    0,
  )
  const ownerBillableMinutes = billingPeriodEntries
    .filter((entry) => entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  const ownerInternalMinutes = billingPeriodEntries
    .filter((entry) => !entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  const ownerTrackedMinutes = ownerBillableMinutes + ownerInternalMinutes
  const activeClientCount = new Set(billingPeriodEntries.map((entry) => entry.clientId)).size
  const employeeReportRows: EmployeeReportRow[] = data.employees
    .filter((employee) => employee.role !== 'Owner')
    .map((employee) => {
      const entries = billingPeriodEntries.filter((entry) => entry.employeeId === employee.id)
      const billableEntryMinutes = entries.filter((entry) => entry.billable).reduce((total, entry) => total + entry.minutes, 0)
      const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0)

      return {
        employeeId: employee.id,
        minutes: totalMinutes,
        billableMinutes: billableEntryMinutes,
        internalMinutes: totalMinutes - billableEntryMinutes,
        entryCount: entries.length,
        clientCount: new Set(entries.map((entry) => entry.clientId)).size,
      }
    })
    .sort((left, right) => right.minutes - left.minutes)
  const clientReportRows: ClientReportRow[] = data.clients
    .map((client) => {
      const entries = billingPeriodEntries.filter((entry) => entry.clientId === client.id)
      const billableEntryMinutes = entries.filter((entry) => entry.billable).reduce((total, entry) => total + entry.minutes, 0)
      const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0)

      return {
        clientId: client.id,
        minutes: totalMinutes,
        billableMinutes: billableEntryMinutes,
        internalMinutes: totalMinutes - billableEntryMinutes,
        entryCount: entries.length,
        employeeCount: new Set(entries.map((entry) => entry.employeeId)).size,
        invoiceTotal: getInvoice(client, data.timeEntries, data.plans, billingPeriod).total,
      }
    })
    .sort((left, right) => right.minutes - left.minutes)
  const categoryTotals = new Map<string, CategoryReportRow>()

  for (const entry of billingPeriodEntries) {
    const existing = categoryTotals.get(entry.category) ?? { category: entry.category, minutes: 0, entryCount: 0 }
    existing.minutes += entry.minutes
    existing.entryCount += 1
    categoryTotals.set(entry.category, existing)
  }

  const categoryReportRows: CategoryReportRow[] = [...categoryTotals.values()].sort(
    (left, right) => right.minutes - left.minutes,
  )

  const handleNav = (sectionId: string) => {
    setActiveSection(sectionId)
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const updateWorkspaceData = (updater: (current: AppData) => AppData) => {
    setData((current) => ensureRecurringChecklists(updater(current)).data)
  }

  const applyServerDataUpdate = (updater: (current: AppData) => AppData) => {
    skipAutosaveRef.current += 1
    setData(updater)
  }

  const logTime = async (entry: Omit<TimeEntry, 'id'>) => {
    try {
      setDataSyncState('saving')
      const newEntry = await createTimeEntry(entry)
      applyServerDataUpdate((current) => ({
        ...current,
        timeEntries: [newEntry, ...current.timeEntries],
      }))
      setSelectedClientId(newEntry.clientId)
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }

      setDataSyncState('error')
    }
  }

  const stopTimer = async () => {
    if (!timer) {
      return
    }

    await logTime({
      employeeId: timer.employeeId,
      clientId: timer.clientId,
      date: new Date().toISOString().slice(0, 10),
      minutes: Math.max(1, Math.round((Date.now() - timer.startedAt) / 60000)),
      category: timer.category,
      description: timer.description,
      billable: true,
    })
    setTimer(null)
  }

  const toggleChecklistItem = async (checklistId: string, itemId: string) => {
    try {
      setDataSyncState('saving')
      const updatedChecklist = await toggleChecklistItemRequest(checklistId, itemId)
      applyServerDataUpdate((current) => ({
        ...current,
        checklists: current.checklists.map((checklist) =>
          checklist.id === checklistId ? updatedChecklist : checklist,
        ),
      }))
      setDataSyncState('synced')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSessionUser(null)
        setServerPersistenceEnabled(false)
        setDataSyncState('offline')
        return
      }

      setDataSyncState('error')
    }
  }

  const addChecklistTemplate = (template: Omit<ChecklistTemplate, 'id'>) => {
    updateWorkspaceData((current) => ({
      ...current,
      checklistTemplates: [...current.checklistTemplates, { ...template, id: makeId('template') }],
    }))
  }

  const updateChecklistTemplate = (templateId: string, updater: (template: ChecklistTemplate) => ChecklistTemplate) => {
    updateWorkspaceData((current) => ({
      ...current,
      checklistTemplates: current.checklistTemplates.map((template) =>
        template.id === templateId ? updater(template) : template,
      ),
    }))
  }

  const deleteChecklistTemplate = (templateId: string) => {
    updateWorkspaceData((current) => ({
      ...current,
      checklistTemplates: current.checklistTemplates.filter((template) => template.id !== templateId),
    }))
  }

  const addChecklistTemplateItem = (templateId: string) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: [...template.items, { id: makeId('template-item'), label: 'New checklist item' }],
    }))
  }

  const updateChecklistTemplateItem = (templateId: string, itemId: string, label: string) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: template.items.map((item) => (item.id === itemId ? { ...item, label } : item)),
    }))
  }

  const removeChecklistTemplateItem = (templateId: string, itemId: string) => {
    updateChecklistTemplate(templateId, (template) => ({
      ...template,
      items: template.items.filter((item) => item.id !== itemId),
    }))
  }

  const updateClientPlan = (clientId: string, billingMode: BillingMode, planId: string | null) => {
    updateWorkspaceData((current) => ({
      ...current,
      clients: current.clients.map((client) =>
        client.id === clientId ? { ...client, billingMode, planId } : client,
      ),
    }))
  }

  const addClient = (client: Omit<Client, 'id'>) => {
    updateWorkspaceData((current) => ({
      ...current,
      clients: [{ ...client, id: makeId('client') }, ...current.clients],
    }))
  }

  const addPlan = (plan: Omit<SubscriptionPlan, 'id'>) => {
    updateWorkspaceData((current) => ({
      ...current,
      plans: [{ ...plan, id: makeId('plan') }, ...current.plans],
    }))
  }

  const printInvoice = () => {
    window.setTimeout(() => window.print(), 50)
  }

  const startTimer = (nextTimer: TimerState) => {
    setNow(nextTimer.startedAt)
    setTimer(nextTimer)
  }

  const handleLogin = async (userId: string, password: string) => {
    setLoginPending(true)
    setLoginError('')

    try {
      const response = await loginWithPassword(userId, password)
      setSessionUser(response.user)
      if (response.user.role === 'employee') {
        setActiveEmployeeId(response.user.id)
      }
      setDataSyncState('loading')
    } catch (error) {
      setLoginError(error instanceof ApiError && error.status === 401 ? 'Invalid password.' : 'Login failed.')
    } finally {
      setLoginPending(false)
    }
  }

  const handleLogout = async () => {
    try {
      await logoutSession()
    } finally {
      setSessionUser(null)
      setServerPersistenceEnabled(false)
      setDataSyncState('loading')
      setTimer(null)
    }
  }

  const ownerMode = role === 'owner'
  const roleLabel = ownerMode ? 'Owner access' : sessionUser?.staffRole ?? 'Employee access'
  const syncMessage =
    dataSyncState === 'loading'
      ? 'Loading server-backed workspace data...'
      : dataSyncState === 'saving'
        ? 'Saving changes to the server...'
        : dataSyncState === 'synced'
          ? 'Server-backed persistence is active.'
          : dataSyncState === 'error'
            ? 'Latest changes could not be saved to the server.'
            : 'API unavailable. Showing seed data until the backend is reachable.'

  if (authState === 'loading') {
    return <LoginScreen loading loginOptions={loginOptions} onLogin={handleLogin} />
  }

  if (!sessionUser) {
    return (
      <LoginScreen
        error={loginError}
        loading={loginPending}
        loginOptions={loginOptions}
        onLogin={handleLogin}
      />
    )
  }

  return (
    <>
      <div className="app-shell">
        <aside className="sidebar" aria-label="Primary navigation">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              PB
            </div>
            <div>
              <strong>PB&amp;J</strong>
              <span>Strategic Accounting</span>
            </div>
          </div>

          <nav className="nav-list">
            {navItems
              .filter((item) => ownerMode || !item.ownerOnly)
              .map((item) => {
                const Icon = item.icon
                return (
                  <button
                    className={item.id === activeSection ? 'nav-item active' : 'nav-item'}
                    key={item.id}
                    onClick={() => handleNav(item.id)}
                    type="button"
                  >
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </button>
                )
              })}
          </nav>

          <div className="security-note">
            <ShieldCheck size={17} />
            <span>{ownerMode ? 'All client billing visible' : 'Assigned to me only'}</span>
          </div>
        </aside>

        <main className="workspace">
          <header className="topbar">
            <div>
              <p className="eyeline">PB&amp;J Strategic Accounting</p>
              <h1>Time, checklists, and client billing</h1>
              <p className={`sync-banner sync-${dataSyncState}`}>{syncMessage}</p>
            </div>
            <div className="topbar-actions">
              <label className="period-control">
                <CalendarDays size={16} />
                <span>Billing month</span>
                <input
                  aria-label="Billing month"
                  onChange={(event) => setBillingPeriod(event.target.value)}
                  type="month"
                  value={billingPeriod}
                />
              </label>
              <div className="account-pill" aria-label="Current account">
                <strong>{sessionUser.name}</strong>
                <span>{sessionUser.staffRole}</span>
              </div>
              <button className="logout-button" onClick={handleLogout} type="button">
                Log out
              </button>
            </div>
          </header>

          <section className="summary-strip" aria-label="Workspace summary">
            <SummaryItem
              icon={Clock3}
              label={ownerMode ? 'Team billable time' : 'My billable time'}
              value={formatHours(billableMinutes)}
              detail={`${periodVisibleEntries.length} in ${billingPeriodLabel}`}
            />
            <SummaryItem
              icon={ListChecks}
              label={ownerMode ? 'Open checklist items' : 'Assigned checklist items'}
              value={openChecklistItems.toString()}
              detail={
                ownerMode
                  ? `${visibleChecklists.length} live checklists from ${data.checklistTemplates.length} templates`
                  : `${visibleChecklists.length} assigned checklists`
              }
            />
            <SummaryItem
              icon={CircleDollarSign}
              label={ownerMode ? 'Invoice draft total' : 'Visible clients'}
              value={ownerMode ? currency.format(ownerInvoiceTotal) : visibleClients.length.toString()}
              detail={ownerMode ? billingPeriodLabel : roleLabel}
            />
          </section>

          <section className="content-grid two-column" id="time">
            <TimeCapture
              activeEmployeeId={activeEmployeeId}
              clients={visibleClients}
              employees={data.employees}
              onLog={logTime}
              onStartTimer={startTimer}
              onStopTimer={stopTimer}
              role={role}
              timer={timer}
              timerElapsed={timer ? formatTimeFromMs(now - timer.startedAt) : '0:00'}
            />
            <RecentTimeEntries clients={data.clients} employees={data.employees} entries={visibleEntries} role={role} />
          </section>

          <section className="content-grid two-column" id="checklists">
            <ChecklistPanel
              checklists={visibleChecklists}
              clients={data.clients}
              employees={data.employees}
              onToggle={toggleChecklistItem}
              role={role}
            />
            {ownerMode ? (
              <ChecklistTemplateManager
                clients={data.clients}
                employees={data.employees}
                onAddItem={addChecklistTemplateItem}
                onCreate={addChecklistTemplate}
                onDeleteItem={removeChecklistTemplateItem}
                onDeleteTemplate={deleteChecklistTemplate}
                onUpdateItem={updateChecklistTemplateItem}
                onUpdateTemplate={updateChecklistTemplate}
                templates={data.checklistTemplates}
              />
            ) : (
              <VisibilityPanel visibleClients={visibleClients} />
            )}
          </section>

          <section className={ownerMode ? 'content-grid client-layout' : 'panel'} id="clients">
            <div className={ownerMode ? 'panel' : undefined}>
              <div className="section-heading">
                <div>
                  <p className="section-kicker">{ownerMode ? 'Owner client controls' : 'Assigned client work'}</p>
                  <h2>Clients</h2>
                </div>
              </div>
              <ClientTable
                clients={visibleClients}
                employees={data.employees}
                onUpdatePlan={updateClientPlan}
                ownerMode={ownerMode}
                plans={data.plans}
              />
            </div>
            {ownerMode && (
              <ClientBuilder
                employees={data.employees.filter((employee) => employee.role !== 'Owner')}
                onCreate={addClient}
                plans={data.plans}
              />
            )}
          </section>

          {ownerMode && (
            <>
              <section className="content-grid reports-layout" id="reports">
                <ReportsOverview
                  activeClientCount={activeClientCount}
                  billingPeriodLabel={billingPeriodLabel}
                  categoryRows={categoryReportRows}
                  clientRows={clientReportRows}
                  clients={data.clients}
                  employeeRows={employeeReportRows}
                  employees={data.employees}
                  ownerBillableMinutes={ownerBillableMinutes}
                  ownerInternalMinutes={ownerInternalMinutes}
                  ownerInvoiceTotal={ownerInvoiceTotal}
                  ownerTrackedMinutes={ownerTrackedMinutes}
                />
              </section>

              <section className="content-grid invoice-layout" id="invoices">
                <div className="panel">
                  <div className="section-heading">
                    <div>
                      <p className="section-kicker">Owner billing</p>
                      <h2>Invoices</h2>
                    </div>
                    <button className="primary-action" onClick={printInvoice} type="button">
                      <Printer size={16} />
                      Print invoice
                    </button>
                  </div>
                  <label className="field">
                    <span>Client</span>
                    <select
                      className="input"
                      onChange={(event) => setSelectedClientId(event.target.value)}
                      value={selectedClientId}
                    >
                      {data.clients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="invoice-context">
                    <span>{billingPeriodLabel}</span>
                    <span>{invoice.entryCount} billable entries</span>
                    <span>{formatHours(invoice.billableMinutes)} tracked</span>
                  </div>
                  <InvoicePreview invoice={invoice} />
                </div>
                <BillingQueue
                  billingPeriod={billingPeriod}
                  clients={data.clients}
                  entries={data.timeEntries}
                  plans={data.plans}
                />
              </section>

              <section className="content-grid two-column" id="plans">
                <PlanBuilder onCreate={addPlan} />
                <PlanLibrary plans={data.plans} />
              </section>
            </>
          )}
        </main>
      </div>

      <div className="print-document" aria-hidden="true">
        <InvoiceDocument invoice={invoice} />
      </div>
    </>
  )
}

function LoginScreen({
  error,
  loading = false,
  loginOptions,
  onLogin,
}: {
  error?: string
  loading?: boolean
  loginOptions: LoginOption[]
  onLogin: (userId: string, password: string) => Promise<void>
}) {
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('pbj-demo')
  const selectedUserId = userId || loginOptions[0]?.id || ''

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedUserId || !password || loading) {
      return
    }

    await onLogin(selectedUserId, password)
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyeline">PB&amp;J Strategic Accounting</p>
        <h1>Sign in to the workspace</h1>
        <p className="auth-copy">
          This prototype now uses server-backed sessions. Use the temporary password <strong>`pbj-demo`</strong> for
          any seeded account unless `AUTH_DEMO_PASSWORD` has been changed on the server.
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Account</span>
            <select className="input" onChange={(event) => setUserId(event.target.value)} value={selectedUserId}>
              {loginOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.staffRole})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button className="primary-action auth-submit" disabled={loading || loginOptions.length === 0} type="submit">
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}

function SummaryItem({
  detail,
  icon: Icon,
  label,
  value,
}: {
  detail: string
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="summary-item">
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  )
}

function TimeCapture({
  activeEmployeeId,
  clients,
  employees,
  onLog,
  onStartTimer,
  onStopTimer,
  role,
  timer,
  timerElapsed,
}: {
  activeEmployeeId: string
  clients: Client[]
  employees: Employee[]
  onLog: (entry: Omit<TimeEntry, 'id'>) => Promise<void>
  onStartTimer: (timer: TimerState) => void
  onStopTimer: () => Promise<void>
  role: Role
  timer: TimerState | null
  timerElapsed: string
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  const [hours, setHours] = useState('1.25')
  const [category, setCategory] = useState('Bookkeeping')
  const [description, setDescription] = useState('Reviewed transactions and added client notes.')
  const [billable, setBillable] = useState(true)
  const [submitError, setSubmitError] = useState('')
  const [submitPending, setSubmitPending] = useState(false)
  const effectiveClientId = clients.some((client) => client.id === clientId) ? clientId : clients[0]?.id ?? ''
  const effectiveEmployeeId = role === 'owner' ? employeeId : activeEmployeeId

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const numericHours = Number(hours)
    if (!effectiveClientId || Number.isNaN(numericHours) || numericHours <= 0) {
      return
    }

    setSubmitPending(true)
    setSubmitError('')

    try {
      await onLog({
        employeeId: effectiveEmployeeId,
        clientId: effectiveClientId,
        date: new Date().toISOString().slice(0, 10),
        minutes: Math.round(numericHours * 60),
        category,
        description,
        billable,
      })
      setDescription('')
      setHours('0.50')
    } catch {
      setSubmitError('Time entry could not be saved.')
    } finally {
      setSubmitPending(false)
    }
  }

  const handleStartTimer = () => {
    if (!effectiveClientId) {
      return
    }

    onStartTimer({
      employeeId: effectiveEmployeeId,
      clientId: effectiveClientId,
      description: description || 'Timed bookkeeping work',
      category,
      startedAt: Date.now(),
    })
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Assigned to me</p>
          <h2>Log time</h2>
        </div>
        <div className={timer ? 'timer-pill running' : 'timer-pill'}>
          <TimerReset size={16} />
          <span>{timer ? timerElapsed : '0:00'}</span>
        </div>
      </div>

      <form className="form-grid" onSubmit={handleSubmit}>
        {role === 'owner' && (
          <label className="field">
            <span>Employee</span>
            <select className="input" onChange={(event) => setEmployeeId(event.target.value)} value={employeeId}>
              {employees
                .filter((employee) => employee.role !== 'Owner')
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Client</span>
          <select className="input" onChange={(event) => setClientId(event.target.value)} value={effectiveClientId}>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Work type</span>
          <select className="input" onChange={(event) => setCategory(event.target.value)} value={category}>
            <option>Bookkeeping</option>
            <option>Payroll</option>
            <option>Cleanup</option>
            <option>Advisory</option>
            <option>Admin</option>
          </select>
        </label>
        <label className="field">
          <span>Hours spent</span>
          <input
            className="input"
            min="0.25"
            onChange={(event) => setHours(event.target.value)}
            step="0.25"
            type="number"
            value={hours}
          />
        </label>
        <label className="field full-span">
          <span>What did you do?</span>
          <textarea
            className="input"
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            value={description}
          />
        </label>
        <label className="check-row full-span">
          <input checked={billable} onChange={(event) => setBillable(event.target.checked)} type="checkbox" />
          <span>Billable</span>
        </label>
        {submitError ? <p className="auth-error full-span">{submitError}</p> : null}
        <div className="button-row full-span">
          <button className="primary-action" disabled={submitPending} type="submit">
            <Clock3 size={16} />
            {submitPending ? 'Saving...' : 'Log time'}
          </button>
          {timer ? (
            <button className="secondary-action danger" disabled={submitPending} onClick={() => void onStopTimer()} type="button">
              <TimerReset size={16} />
              Stop &amp; log
            </button>
          ) : (
            <button className="secondary-action" disabled={submitPending} onClick={handleStartTimer} type="button">
              <TimerReset size={16} />
              Start timer
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function RecentTimeEntries({
  clients,
  employees,
  entries,
  role,
}: {
  clients: Client[]
  employees: Employee[]
  entries: TimeEntry[]
  role: Role
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">{role === 'owner' ? 'Team activity' : 'My activity'}</p>
          <h2>Recent time</h2>
        </div>
      </div>
      <div className="entry-list">
        {entries.slice(0, 6).map((entry) => (
          <article className="entry-row" key={entry.id}>
            <div>
              <strong>{clientName(clients, entry.clientId)}</strong>
              <span>{entry.description}</span>
              <small>
                {entry.category} · {employeeName(employees, entry.employeeId)}
              </small>
            </div>
            <div className="entry-meta">
              <strong>{formatHours(entry.minutes)}</strong>
              <span>{entry.billable ? 'Billable' : 'Internal'}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function ChecklistPanel({
  checklists,
  clients,
  employees,
  onToggle,
  role,
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  onToggle: (checklistId: string, itemId: string) => Promise<void> | void
  role: Role
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">{role === 'owner' ? 'Owner checklist view' : 'Assigned checklist'}</p>
          <h2>Live checklists</h2>
        </div>
      </div>
      <div className="checklist-stack">
        {checklists.length === 0 ? <p className="empty-state">No checklist instances are due yet.</p> : null}
        {checklists.map((checklist) => {
          const completed = checklist.items.filter((item) => item.done).length
          return (
            <article className="checklist-block" key={checklist.id}>
              <header>
                <div>
                  <strong>{checklist.title}</strong>
                  <span>
                    {clientName(clients, checklist.clientId)} · {employeeName(employees, checklist.assigneeId)}
                  </span>
                </div>
                <div className="checklist-meta">
                  {checklist.frequency ? (
                    <span className="status-pill">{getChecklistFrequencyLabel(checklist.frequency)}</span>
                  ) : null}
                  <small>Due {shortDate.format(new Date(`${checklist.dueDate}T12:00:00`))}</small>
                </div>
              </header>
              <div className="progress-track">
                <span style={{ width: `${checklist.items.length === 0 ? 0 : (completed / checklist.items.length) * 100}%` }} />
              </div>
              <div className="task-list">
                {checklist.items.map((item) => (
                  <label className={item.done ? 'task-row done' : 'task-row'} key={item.id}>
                    <input checked={item.done} onChange={() => void onToggle(checklist.id, item.id)} type="checkbox" />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function ChecklistTemplateManager({
  clients,
  employees,
  onAddItem,
  onCreate,
  onDeleteItem,
  onDeleteTemplate,
  onUpdateItem,
  onUpdateTemplate,
  templates,
}: {
  clients: Client[]
  employees: Employee[]
  onAddItem: (templateId: string) => void
  onCreate: (template: Omit<ChecklistTemplate, 'id'>) => void
  onDeleteItem: (templateId: string, itemId: string) => void
  onDeleteTemplate: (templateId: string) => void
  onUpdateItem: (templateId: string, itemId: string, label: string) => void
  onUpdateTemplate: (templateId: string, updater: (template: ChecklistTemplate) => ChecklistTemplate) => void
  templates: ChecklistTemplate[]
}) {
  const [title, setTitle] = useState('Weekly bookkeeping review')
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [assigneeId, setAssigneeId] = useState(employees[0]?.id ?? '')
  const [frequency, setFrequency] = useState<ChecklistFrequency>('weekly')
  const [nextDueDate, setNextDueDate] = useState(dateOffset(7))
  const [itemDraft, setItemDraft] = useState('Review uncategorized transactions\nReview payroll clearing account')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const items = itemDraft
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((label) => ({ id: makeId('template-item'), label }))

    if (!title || !clientId || !assigneeId || !nextDueDate || items.length === 0) {
      return
    }

    onCreate({
      title,
      clientId,
      assigneeId,
      frequency,
      nextDueDate,
      active: true,
      items,
    })

    setTitle('')
    setItemDraft('')
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner template controls</p>
          <h2>Recurring checklist templates</h2>
        </div>
      </div>
      <div className="template-manager">
        <form className="form-grid single" onSubmit={handleSubmit}>
          <label className="field">
            <span>Template title</span>
            <input className="input" onChange={(event) => setTitle(event.target.value)} value={title} />
          </label>
          <label className="field">
            <span>Client</span>
            <select className="input" onChange={(event) => setClientId(event.target.value)} value={clientId}>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Assigned employee</span>
            <select className="input" onChange={(event) => setAssigneeId(event.target.value)} value={assigneeId}>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Frequency</span>
            <select className="input" onChange={(event) => setFrequency(event.target.value as ChecklistFrequency)} value={frequency}>
              {checklistFrequencies.map((option) => (
                <option key={option} value={option}>
                  {getChecklistFrequencyLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Next due date</span>
            <input
              className="input"
              onChange={(event) => setNextDueDate(event.target.value)}
              type="date"
              value={nextDueDate}
            />
          </label>
          <label className="field">
            <span>Template items (one per line)</span>
            <textarea
              className="input"
              onChange={(event) => setItemDraft(event.target.value)}
              rows={5}
              value={itemDraft}
            />
          </label>
          <button className="primary-action" type="submit">
            <Plus size={16} />
            Add recurring template
          </button>
        </form>

        <div className="template-list">
          {templates.map((template) => (
            <article className="template-card" key={template.id}>
              <div className="template-card-header">
                <div>
                  <strong>{template.title}</strong>
                  <span>
                    {clientName(clients, template.clientId)} · {employeeName(employees, template.assigneeId)}
                  </span>
                </div>
                <button className="secondary-action danger" onClick={() => onDeleteTemplate(template.id)} type="button">
                  Remove template
                </button>
              </div>
              <div className="template-grid">
                <label className="field">
                  <span>Title</span>
                  <input
                    className="input"
                    onChange={(event) => onUpdateTemplate(template.id, (current) => ({ ...current, title: event.target.value }))}
                    value={template.title}
                  />
                </label>
                <label className="field">
                  <span>Client</span>
                  <select
                    className="input"
                    onChange={(event) => onUpdateTemplate(template.id, (current) => ({ ...current, clientId: event.target.value }))}
                    value={template.clientId}
                  >
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Employee</span>
                  <select
                    className="input"
                    onChange={(event) => onUpdateTemplate(template.id, (current) => ({ ...current, assigneeId: event.target.value }))}
                    value={template.assigneeId}
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
                    onChange={(event) =>
                      onUpdateTemplate(template.id, (current) => ({
                        ...current,
                        frequency: event.target.value as ChecklistFrequency,
                      }))
                    }
                    value={template.frequency}
                  >
                    {checklistFrequencies.map((option) => (
                      <option key={option} value={option}>
                        {getChecklistFrequencyLabel(option)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Next due date</span>
                  <input
                    className="input"
                    onChange={(event) =>
                      onUpdateTemplate(template.id, (current) => ({ ...current, nextDueDate: event.target.value }))
                    }
                    type="date"
                    value={template.nextDueDate}
                  />
                </label>
                <label className="check-row template-toggle">
                  <input
                    checked={template.active}
                    onChange={(event) =>
                      onUpdateTemplate(template.id, (current) => ({ ...current, active: event.target.checked }))
                    }
                    type="checkbox"
                  />
                  <span>Active recurring template</span>
                </label>
              </div>
              <div className="template-items">
                {template.items.map((item) => (
                  <div className="template-item-row" key={item.id}>
                    <input
                      className="input"
                      onChange={(event) => onUpdateItem(template.id, item.id, event.target.value)}
                      value={item.label}
                    />
                    <button className="secondary-action danger" onClick={() => onDeleteItem(template.id, item.id)} type="button">
                      Remove
                    </button>
                  </div>
                ))}
                <button className="secondary-action" onClick={() => onAddItem(template.id)} type="button">
                  <Plus size={16} />
                  Add item
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function VisibilityPanel({ visibleClients }: { visibleClients: Client[] }) {
  return (
    <section className="panel visibility-panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Access boundary</p>
          <h2>Visible work</h2>
        </div>
      </div>
      <div className="visibility-copy">
        <ShieldCheck size={34} />
        <p>
          This employee view is scoped to assigned checklists, clients, and time entries. Owner-only invoices,
          subscription controls, and other employees' hours are hidden from this role.
        </p>
      </div>
      <div className="client-chip-list">
        {visibleClients.map((client) => (
          <span key={client.id}>{client.name}</span>
        ))}
      </div>
    </section>
  )
}

function ReportsOverview({
  activeClientCount,
  billingPeriodLabel,
  categoryRows,
  clientRows,
  clients,
  employeeRows,
  employees,
  ownerBillableMinutes,
  ownerInternalMinutes,
  ownerInvoiceTotal,
  ownerTrackedMinutes,
}: {
  activeClientCount: number
  billingPeriodLabel: string
  categoryRows: CategoryReportRow[]
  clientRows: ClientReportRow[]
  clients: Client[]
  employeeRows: EmployeeReportRow[]
  employees: Employee[]
  ownerBillableMinutes: number
  ownerInternalMinutes: number
  ownerInvoiceTotal: number
  ownerTrackedMinutes: number
}) {
  const billableRate = ownerTrackedMinutes === 0 ? 0 : Math.round((ownerBillableMinutes / ownerTrackedMinutes) * 100)

  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Owner reporting</p>
            <h2>Month summary</h2>
          </div>
        </div>
        <p className="report-caption">Reporting for {billingPeriodLabel}.</p>
        <div className="report-metric-grid">
          <ReportMetricCard
            label="Tracked hours"
            value={formatHours(ownerTrackedMinutes)}
            detail={`${formatHours(ownerBillableMinutes)} billable`}
          />
          <ReportMetricCard
            label="Internal hours"
            value={formatHours(ownerInternalMinutes)}
            detail={`${billableRate}% billable mix`}
          />
          <ReportMetricCard
            label="Projected billing"
            value={currency.format(ownerInvoiceTotal)}
            detail={`${activeClientCount} active clients`}
          />
          <ReportMetricCard
            label="Employee coverage"
            value={employeeRows.filter((row) => row.minutes > 0).length.toString()}
            detail="Staff with hours this month"
          />
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Hours by person</p>
            <h2>Employee report</h2>
          </div>
        </div>
        <ReportTable
          columns={['Employee', 'Tracked', 'Billable', 'Internal', 'Entries', 'Clients']}
          rows={employeeRows.map((row) => [
            employeeName(employees, row.employeeId),
            formatHours(row.minutes),
            formatHours(row.billableMinutes),
            formatHours(row.internalMinutes),
            row.entryCount.toString(),
            row.clientCount.toString(),
          ])}
        />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Hours by client</p>
            <h2>Client report</h2>
          </div>
        </div>
        <ReportTable
          columns={['Client', 'Tracked', 'Billable', 'Internal', 'Staff', 'Projected billing']}
          rows={clientRows.map((row) => [
            clientName(clients, row.clientId),
            formatHours(row.minutes),
            formatHours(row.billableMinutes),
            formatHours(row.internalMinutes),
            row.employeeCount.toString(),
            currency.format(row.invoiceTotal),
          ])}
        />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Work mix</p>
            <h2>Category breakdown</h2>
          </div>
        </div>
        <div className="report-stack">
          {categoryRows.length === 0 ? (
            <p className="empty-state">No time entries have been logged for this billing month yet.</p>
          ) : (
            categoryRows.map((row) => {
              const width = ownerTrackedMinutes === 0 ? 0 : (row.minutes / ownerTrackedMinutes) * 100
              return (
                <div className="category-row" key={row.category}>
                  <div className="category-row-header">
                    <strong>{row.category}</strong>
                    <span>
                      {formatHours(row.minutes)} · {row.entryCount} entries
                    </span>
                  </div>
                  <div className="category-bar">
                    <span style={{ width: `${width}%` }} />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>
    </>
  )
}

function ReportMetricCard({ detail, label, value }: { detail: string; label: string; value: string }) {
  return (
    <div className="report-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function ReportTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row[0]}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${columns[cellIndex]}-${cell}`}>{cellIndex === 0 ? <strong>{cell}</strong> : cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ClientBuilder({
  employees,
  onCreate,
  plans,
}: {
  employees: Employee[]
  onCreate: (client: Omit<Client, 'id'>) => void
  plans: SubscriptionPlan[]
}) {
  const [name, setName] = useState('Summit Retail Co.')
  const [contact, setContact] = useState('Jamie Miller')
  const [hourlyRate, setHourlyRate] = useState('135')
  const [billingMode, setBillingMode] = useState<BillingMode>('hourly')
  const [planId, setPlanId] = useState(plans[0]?.id ?? '')
  const [assignedEmployeeIds, setAssignedEmployeeIds] = useState<string[]>(
    employees[0] ? [employees[0].id] : [],
  )

  const toggleEmployee = (employeeId: string) => {
    setAssignedEmployeeIds((current) =>
      current.includes(employeeId) ? current.filter((id) => id !== employeeId) : [...current, employeeId],
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const rate = Number(hourlyRate)
    if (!name || !contact || Number.isNaN(rate) || rate <= 0 || assignedEmployeeIds.length === 0) {
      return
    }

    onCreate({
      name,
      contact,
      billingMode,
      hourlyRate: rate,
      planId: billingMode === 'subscription' ? planId || plans[0]?.id || null : null,
      assignedEmployeeIds,
    })
    setName('')
    setContact('')
    setHourlyRate('135')
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner setup</p>
          <h2>Add client</h2>
        </div>
      </div>
      <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Client name</span>
          <input className="input" onChange={(event) => setName(event.target.value)} value={name} />
        </label>
        <label className="field">
          <span>Primary contact</span>
          <input className="input" onChange={(event) => setContact(event.target.value)} value={contact} />
        </label>
        <label className="field">
          <span>Hourly rate</span>
          <input
            className="input"
            min="1"
            onChange={(event) => setHourlyRate(event.target.value)}
            step="5"
            type="number"
            value={hourlyRate}
          />
        </label>
        <label className="field">
          <span>Billing type</span>
          <select
            className="input"
            onChange={(event) => setBillingMode(event.target.value as BillingMode)}
            value={billingMode}
          >
            <option value="hourly">Hourly</option>
            <option value="subscription">Subscription</option>
          </select>
        </label>
        {billingMode === 'subscription' && (
          <label className="field">
            <span>Subscription plan</span>
            <select className="input" onChange={(event) => setPlanId(event.target.value)} value={planId}>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="assignment-field">
          <legend>Assigned employees</legend>
          {employees.map((employee) => (
            <label className="check-row" key={employee.id}>
              <input
                checked={assignedEmployeeIds.includes(employee.id)}
                onChange={() => toggleEmployee(employee.id)}
                type="checkbox"
              />
              <span>{employee.name}</span>
            </label>
          ))}
        </fieldset>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add client
        </button>
      </form>
    </section>
  )
}

function ClientTable({
  clients,
  employees,
  onUpdatePlan,
  ownerMode,
  plans,
}: {
  clients: Client[]
  employees: Employee[]
  onUpdatePlan: (clientId: string, billingMode: BillingMode, planId: string | null) => void
  ownerMode: boolean
  plans: SubscriptionPlan[]
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Contact</th>
            <th>Billing</th>
            <th>Rate</th>
            <th>Assigned team</th>
            <th>Subscription plan</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => {
            const plan = plans.find((item) => item.id === client.planId)
            return (
              <tr key={client.id}>
                <td>
                  <strong>{client.name}</strong>
                </td>
                <td>{client.contact}</td>
                <td>
                  {ownerMode ? (
                    <select
                      className="compact-input"
                      onChange={(event) =>
                        onUpdatePlan(
                          client.id,
                          event.target.value as BillingMode,
                          event.target.value === 'hourly' ? null : client.planId ?? plans[0]?.id ?? null,
                        )
                      }
                      value={client.billingMode}
                    >
                      <option value="hourly">Hourly</option>
                      <option value="subscription">Subscription</option>
                    </select>
                  ) : (
                    <span className="status-pill">{client.billingMode}</span>
                  )}
                </td>
                <td>{currency.format(client.hourlyRate)}/hr</td>
                <td>
                  <div className="client-chip-list compact">
                    {getAssignedEmployeeIds(client).length > 0 ? (
                      getAssignedEmployeeIds(client).map((employeeId) => (
                        <span key={employeeId}>{employeeName(employees, employeeId)}</span>
                      ))
                    ) : (
                      <span>Unassigned</span>
                    )}
                  </div>
                </td>
                <td>
                  {ownerMode && client.billingMode === 'subscription' ? (
                    <select
                      className="compact-input"
                      onChange={(event) => onUpdatePlan(client.id, 'subscription', event.target.value)}
                      value={client.planId ?? plans[0]?.id ?? ''}
                    >
                      {plans.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    plan?.name ?? 'Hourly billing'
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function InvoicePreview({ invoice }: { invoice: Invoice }) {
  return (
    <div className="invoice-preview">
      <div className="invoice-preview-header">
        <div>
          <span>Invoice draft</span>
          <strong>{invoice.client.name}</strong>
          <span>{invoice.periodLabel}</span>
        </div>
        <strong>{currency.format(invoice.total)}</strong>
      </div>
      <div className="invoice-lines">
        {invoice.lines.map((line) => (
          <div className="invoice-line" key={`${line.label}-${line.detail}`}>
            <div>
              <strong>{line.label}</strong>
              <span>{line.detail}</span>
            </div>
            <span>{currency.format(line.amount)}</span>
          </div>
        ))}
      </div>
      <div className="invoice-total-row">
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </div>
    </div>
  )
}

function BillingQueue({
  billingPeriod,
  clients,
  entries,
  plans,
}: {
  billingPeriod: string
  clients: Client[]
  entries: TimeEntry[]
  plans: SubscriptionPlan[]
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Ready to review</p>
          <h2>Billing queue</h2>
        </div>
      </div>
      <div className="queue-list">
        {clients.map((client) => {
          const invoice = getInvoice(client, entries, plans, billingPeriod)
          return (
            <article className="queue-row" key={client.id}>
              <div>
                <strong>{client.name}</strong>
                <span>
                  {client.billingMode === 'subscription' ? 'Subscription plan' : 'Billable hours'} ·{' '}
                  {formatHours(invoice.billableMinutes)}
                </span>
              </div>
              <strong>{currency.format(invoice.total)}</strong>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function PlanBuilder({ onCreate }: { onCreate: (plan: Omit<SubscriptionPlan, 'id'>) => void }) {
  const [name, setName] = useState('Controller Support')
  const [monthlyFee, setMonthlyFee] = useState('2400')
  const [includedHours, setIncludedHours] = useState('18')
  const [notes, setNotes] = useState('Monthly reporting, close review, and client advisory support.')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fee = Number(monthlyFee)
    const hours = Number(includedHours)
    if (!name || Number.isNaN(fee) || Number.isNaN(hours)) {
      return
    }

    onCreate({ name, monthlyFee: fee, includedHours: hours, notes })
    setName('')
    setMonthlyFee('1200')
    setIncludedHours('10')
    setNotes('')
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Subscription setup</p>
          <h2>Create plan</h2>
        </div>
      </div>
      <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Plan name</span>
          <input className="input" onChange={(event) => setName(event.target.value)} value={name} />
        </label>
        <label className="field">
          <span>Monthly fee</span>
          <input
            className="input"
            min="0"
            onChange={(event) => setMonthlyFee(event.target.value)}
            step="50"
            type="number"
            value={monthlyFee}
          />
        </label>
        <label className="field">
          <span>Included hours</span>
          <input
            className="input"
            min="0"
            onChange={(event) => setIncludedHours(event.target.value)}
            step="1"
            type="number"
            value={includedHours}
          />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea className="input" onChange={(event) => setNotes(event.target.value)} rows={3} value={notes} />
        </label>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add plan
        </button>
      </form>
    </section>
  )
}

function PlanLibrary({ plans }: { plans: SubscriptionPlan[] }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Available templates</p>
          <h2>Plans</h2>
        </div>
      </div>
      <div className="plan-list">
        {plans.map((plan) => (
          <article className="plan-row" key={plan.id}>
            <div>
              <strong>{plan.name}</strong>
              <span>{plan.notes}</span>
            </div>
            <div>
              <strong>{currency.format(plan.monthlyFee)}</strong>
              <span>{plan.includedHours}h included</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  const issuedDate = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date())

  return (
    <section className="print-sheet">
      <header>
        <div>
          <strong>PB&amp;J Strategic Accounting</strong>
          <span>Strategic bookkeeping, payroll, and advisory support</span>
        </div>
        <FileText size={34} />
      </header>
      <div className="print-meta">
        <div>
          <span>Bill to</span>
          <strong>{invoice.client.name}</strong>
          <small>{invoice.client.contact}</small>
        </div>
        <div>
          <span>Issued</span>
          <strong>{issuedDate}</strong>
          <small>{invoice.client.billingMode === 'subscription' ? 'Subscription plan' : 'Billable hours'}</small>
          <small>{invoice.periodLabel}</small>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Detail</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={`${line.label}-${line.detail}`}>
              <td>{line.label}</td>
              <td>{line.detail}</td>
              <td>{currency.format(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer>
        <span>Total due</span>
        <strong>{currency.format(invoice.total)}</strong>
      </footer>
      <p>Thank you for trusting PB&amp;J Strategic Accounting.</p>
    </section>
  )
}

export default App
