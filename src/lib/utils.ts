import type {
  AppData,
  Checklist,
  ChecklistFrequency,
  Client,
  Employee,
  Invoice,
  InvoiceLine,
  SubscriptionPlan,
  TimeEntry,
} from './types'

export const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

export const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
})

export const checklistFrequencies: ChecklistFrequency[] = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'annually',
]

export function dateOffset(days: number) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export function currentBillingPeriod() {
  return new Date().toISOString().slice(0, 7)
}

export function getBillingPeriodLabel(period: string) {
  const [year, month] = period.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
    new Date(year, month - 1, 1),
  )
}

export function isInBillingPeriod(entry: TimeEntry, period: string) {
  return entry.date.startsWith(period)
}

export function getAssignedEmployeeIds(client: Client) {
  return client.assignedEmployeeIds ?? []
}

export function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

export function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T12:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export function addMonths(dateString: string, months: number) {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1 + months, day).toISOString().slice(0, 10)
}

export function advanceChecklistFrequency(dateString: string, frequency: ChecklistFrequency) {
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

export function getChecklistFrequencyLabel(frequency: ChecklistFrequency) {
  return frequency.charAt(0).toUpperCase() + frequency.slice(1)
}

export function sortChecklists(checklists: Checklist[]) {
  return [...checklists].sort((left, right) => {
    if (left.dueDate !== right.dueDate) {
      return left.dueDate.localeCompare(right.dueDate)
    }

    return left.title.localeCompare(right.title)
  })
}

export function ensureRecurringChecklists(data: AppData) {
  const templates = (data.checklistTemplates ?? []).map((template) => ({
    ...template,
    viewerIds: Array.isArray(template.viewerIds) ? template.viewerIds : [],
    editorIds: Array.isArray(template.editorIds) ? template.editorIds : [],
  }))
  const existingChecklists = (data.checklists ?? []).map((checklist) => ({
    ...checklist,
    viewerIds: Array.isArray(checklist.viewerIds) ? checklist.viewerIds : [],
    editorIds: Array.isArray(checklist.editorIds) ? checklist.editorIds : [],
  }))
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
          viewerIds: Array.isArray(template.viewerIds) ? [...template.viewerIds] : [],
          editorIds: Array.isArray(template.editorIds) ? [...template.editorIds] : [],
          createdAt: new Date().toISOString().slice(0, 10),
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

  return {
    changed,
    data: {
      ...data,
      checklistTemplates,
      checklists: sortChecklists(checklists),
    },
  }
}

export function formatHours(minutes: number) {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`
}

export function formatTimeFromMs(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function employeeName(employees: Employee[], employeeId: string) {
  return employees.find((employee) => employee.id === employeeId)?.name ?? 'Unassigned'
}

export function clientName(clients: Client[], clientId: string) {
  return clients.find((client) => client.id === clientId)?.name ?? 'Unknown client'
}

export function getInvoice(
  client: Client,
  entries: TimeEntry[],
  plans: SubscriptionPlan[],
  billingPeriod: string,
): Invoice {
  const billableEntries = entries.filter(
    (entry) =>
      entry.clientId === client.id && entry.billable && isInBillingPeriod(entry, billingPeriod),
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

export function relativeTime(value: string | null | undefined): string {
  if (!value) {
    return 'Never'
  }
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) {
    return 'Never'
  }
  const diffSeconds = Math.round((Date.now() - then) / 1000)
  if (diffSeconds < 0) {
    return 'just now'
  }
  if (diffSeconds < 45) {
    return 'just now'
  }
  if (diffSeconds < 90) {
    return '1 minute ago'
  }
  const diffMinutes = Math.round(diffSeconds / 60)
  if (diffMinutes < 45) {
    return `${diffMinutes} minutes ago`
  }
  if (diffMinutes < 90) {
    return '1 hour ago'
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours} hours ago`
  }
  if (diffHours < 36) {
    return '1 day ago'
  }
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 30) {
    return `${diffDays} days ago`
  }
  const diffMonths = Math.round(diffDays / 30)
  if (diffMonths < 12) {
    return `${diffMonths} months ago`
  }
  const diffYears = Math.round(diffMonths / 12)
  return `${diffYears} years ago`
}

export function formatActivityTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function describeActivityAction(action: string): string {
  switch (action) {
    case 'login_password':
      return 'logged in with password'
    case 'login_via_magic_link':
      return 'logged in via magic link'
    case 'checklist_item_checked':
      return 'checked off'
    case 'checklist_item_unchecked':
      return 'unchecked'
    case 'checklist_created':
      return 'created checklist'
    case 'template_viewers_updated':
      return 'updated template viewers'
    case 'team_invited':
      return 'invited'
    case 'team_revoked':
      return 'revoked link for'
    case 'team_link_regenerated':
      return 'regenerated link for'
    case 'team_link_restored':
      return 'restored access for'
    case 'team_removed':
      return 'removed'
    default:
      return action.replace(/_/g, ' ')
  }
}

export function lastDayOfCurrentMonth() {
  const date = new Date()
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  return last.toISOString().slice(0, 10)
}
