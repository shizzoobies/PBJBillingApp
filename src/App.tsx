import {
  Building2,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  FileText,
  ListChecks,
  Plus,
  Printer,
  ReceiptText,
  ShieldCheck,
  TimerReset,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import './App.css'

type Role = 'employee' | 'owner'
type BillingMode = 'hourly' | 'subscription'

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

type Checklist = {
  id: string
  title: string
  clientId: string
  assigneeId: string
  dueDate: string
  items: ChecklistItem[]
}

type AppData = {
  employees: Employee[]
  clients: Client[]
  plans: SubscriptionPlan[]
  timeEntries: TimeEntry[]
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
  { id: 'invoices', label: 'Invoices', icon: ReceiptText, ownerOnly: true },
  { id: 'plans', label: 'Plans', icon: WalletCards, ownerOnly: true },
]

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
    checklists: [
      {
        id: 'check-1',
        title: 'April month-end close',
        clientId: 'client-northstar',
        assigneeId: 'emp-avery',
        dueDate: dateOffset(3),
        items: [
          { id: 'check-1-a', label: 'Match bank feed to statement balance', done: true },
          { id: 'check-1-b', label: 'Review payroll clearing account', done: false },
          { id: 'check-1-c', label: 'Send owner report draft', done: false },
        ],
      },
      {
        id: 'check-2',
        title: 'Weekly bookkeeping review',
        clientId: 'client-riverbend',
        assigneeId: 'emp-jordan',
        dueDate: dateOffset(1),
        items: [
          { id: 'check-2-a', label: 'Categorize new transactions', done: true },
          { id: 'check-2-b', label: 'Flag vendor receipts missing support', done: false },
          { id: 'check-2-c', label: 'Confirm payroll liability balance', done: false },
        ],
      },
      {
        id: 'check-3',
        title: 'Cleanup sprint',
        clientId: 'client-clover',
        assigneeId: 'emp-avery',
        dueDate: dateOffset(5),
        items: [
          { id: 'check-3-a', label: 'Audit chart of accounts for duplicate categories', done: false },
          { id: 'check-3-b', label: 'Prepare catch-up questions for client', done: false },
        ],
      },
    ],
  }
}

function useStoredState<T>(key: string, createInitialValue: () => T) {
  const [value, setValue] = useState<T>(() => {
    const initialValue = createInitialValue()
    if (typeof window === 'undefined') {
      return initialValue
    }

    const stored = window.localStorage.getItem(key)
    if (!stored) {
      return initialValue
    }

    try {
      return JSON.parse(stored) as T
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])

  return [value, setValue] as const
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
  const [data, setData] = useStoredState<AppData>('pbj-accounting-prototype-v1', createSeedData)
  const [role, setRole] = useState<Role>('owner')
  const [activeEmployeeId, setActiveEmployeeId] = useState('emp-avery')
  const [activeSection, setActiveSection] = useState('time')
  const [selectedClientId, setSelectedClientId] = useState('client-northstar')
  const [billingPeriod, setBillingPeriod] = useState(currentBillingPeriod())
  const [timer, setTimer] = useState<TimerState | null>(null)
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!timer) {
      return
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [timer])

  const visibleChecklists = useMemo(() => {
    if (role === 'owner') {
      return data.checklists
    }

    return data.checklists.filter((checklist) => checklist.assigneeId === activeEmployeeId)
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

  const handleNav = (sectionId: string) => {
    setActiveSection(sectionId)
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const logTime = (entry: Omit<TimeEntry, 'id'>) => {
    const newEntry = { ...entry, id: makeId('time') }
    setData((current) => ({
      ...current,
      timeEntries: [newEntry, ...current.timeEntries],
    }))
    setSelectedClientId(entry.clientId)
  }

  const stopTimer = () => {
    if (!timer) {
      return
    }

    logTime({
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

  const toggleChecklistItem = (checklistId: string, itemId: string) => {
    setData((current) => ({
      ...current,
      checklists: current.checklists.map((checklist) =>
        checklist.id === checklistId
          ? {
              ...checklist,
              items: checklist.items.map((item) =>
                item.id === itemId ? { ...item, done: !item.done } : item,
              ),
            }
          : checklist,
      ),
    }))
  }

  const addChecklist = (checklist: Omit<Checklist, 'id'>) => {
    setData((current) => ({
      ...current,
      checklists: [{ ...checklist, id: makeId('check') }, ...current.checklists],
    }))
  }

  const updateClientPlan = (clientId: string, billingMode: BillingMode, planId: string | null) => {
    setData((current) => ({
      ...current,
      clients: current.clients.map((client) =>
        client.id === clientId ? { ...client, billingMode, planId } : client,
      ),
    }))
  }

  const addClient = (client: Omit<Client, 'id'>) => {
    setData((current) => ({
      ...current,
      clients: [{ ...client, id: makeId('client') }, ...current.clients],
    }))
  }

  const addPlan = (plan: Omit<SubscriptionPlan, 'id'>) => {
    setData((current) => ({
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

  const ownerMode = role === 'owner'
  const roleLabel = ownerMode ? 'Owner view' : 'Employee view'

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
              <div className="segmented" aria-label="Demo role">
                <button
                  className={!ownerMode ? 'selected' : ''}
                  onClick={() => setRole('employee')}
                  type="button"
                >
                  Employee
                </button>
                <button className={ownerMode ? 'selected' : ''} onClick={() => setRole('owner')} type="button">
                  Owner
                </button>
              </div>
              {!ownerMode && (
                <select
                  aria-label="Active employee"
                  className="select-control"
                  onChange={(event) => setActiveEmployeeId(event.target.value)}
                  value={activeEmployeeId}
                >
                  {data.employees
                    .filter((employee) => employee.role !== 'Owner')
                    .map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                </select>
              )}
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
              detail={`${visibleChecklists.length} active checklists`}
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
              <ChecklistBuilder
                clients={data.clients}
                employees={data.employees.filter((employee) => employee.role !== 'Owner')}
                onCreate={addChecklist}
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
  onLog: (entry: Omit<TimeEntry, 'id'>) => void
  onStartTimer: (timer: TimerState) => void
  onStopTimer: () => void
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
  const effectiveClientId = clients.some((client) => client.id === clientId) ? clientId : clients[0]?.id ?? ''
  const effectiveEmployeeId = role === 'owner' ? employeeId : activeEmployeeId

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const numericHours = Number(hours)
    if (!effectiveClientId || Number.isNaN(numericHours) || numericHours <= 0) {
      return
    }

    onLog({
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
        <div className="button-row full-span">
          <button className="primary-action" type="submit">
            <Clock3 size={16} />
            Log time
          </button>
          {timer ? (
            <button className="secondary-action danger" onClick={onStopTimer} type="button">
              <TimerReset size={16} />
              Stop &amp; log
            </button>
          ) : (
            <button className="secondary-action" onClick={handleStartTimer} type="button">
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
  onToggle: (checklistId: string, itemId: string) => void
  role: Role
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">{role === 'owner' ? 'Owner checklist view' : 'Assigned checklist'}</p>
          <h2>Checklists</h2>
        </div>
      </div>
      <div className="checklist-stack">
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
                <small>Due {shortDate.format(new Date(`${checklist.dueDate}T12:00:00`))}</small>
              </header>
              <div className="progress-track">
                <span style={{ width: `${(completed / checklist.items.length) * 100}%` }} />
              </div>
              <div className="task-list">
                {checklist.items.map((item) => (
                  <label className={item.done ? 'task-row done' : 'task-row'} key={item.id}>
                    <input checked={item.done} onChange={() => onToggle(checklist.id, item.id)} type="checkbox" />
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

function ChecklistBuilder({
  clients,
  employees,
  onCreate,
}: {
  clients: Client[]
  employees: Employee[]
  onCreate: (checklist: Omit<Checklist, 'id'>) => void
}) {
  const [title, setTitle] = useState('New monthly checklist')
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [assigneeId, setAssigneeId] = useState(employees[0]?.id ?? '')
  const [itemText, setItemText] = useState('Review uncategorized transactions')
  const [dueDate, setDueDate] = useState(dateOffset(7))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title || !clientId || !assigneeId || !itemText) {
      return
    }

    onCreate({
      title,
      clientId,
      assigneeId,
      dueDate,
      items: [{ id: makeId('item'), label: itemText, done: false }],
    })
    setTitle('')
    setItemText('')
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner setup</p>
          <h2>Create checklist</h2>
        </div>
      </div>
      <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Checklist title</span>
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
          <span>Employee</span>
          <select className="input" onChange={(event) => setAssigneeId(event.target.value)} value={assigneeId}>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Due date</span>
          <input className="input" onChange={(event) => setDueDate(event.target.value)} type="date" value={dueDate} />
        </label>
        <label className="field">
          <span>First item</span>
          <input className="input" onChange={(event) => setItemText(event.target.value)} value={itemText} />
        </label>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add checklist
        </button>
      </form>
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
