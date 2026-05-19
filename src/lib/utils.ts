import type {
  AppData,
  Checklist,
  ChecklistFrequency,
  ChecklistTemplate,
  Client,
  Employee,
  Invoice,
  InvoiceLine,
  SubscriptionPlan,
  TemplateStage,
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
  'specific-months',
]

/** Short month names indexed 1–12 (index 0 unused). */
export const monthShortNames = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Largest day-of-month a specific-months template may use (caps short months). */
export const MAX_DUE_DAY_OF_MONTH = 28

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
  if (frequency === 'specific-months') {
    return 'Specific months'
  }
  return frequency.charAt(0).toUpperCase() + frequency.slice(1)
}

/**
 * Roll-up completion, recursing up to three levels (item → sub-item →
 * sub-sub-item). A node with children is `done` exactly when every child is
 * `done` (children are themselves evaluated by the same rule); a node with no
 * children keeps its own stored `done`. Pure — safe to call anywhere the
 * derived state is needed.
 */
export function isChecklistItemDone(item: {
  done: boolean
  subItems?: { done: boolean; subItems?: { done: boolean }[] }[]
}): boolean {
  if (Array.isArray(item.subItems) && item.subItems.length > 0) {
    return item.subItems.every((sub) => isChecklistItemDone(sub))
  }
  return item.done
}

export function sortChecklists(checklists: Checklist[]) {
  return [...checklists].sort((left, right) => {
    if (left.dueDate !== right.dueDate) {
      return left.dueDate.localeCompare(right.dueDate)
    }

    return left.title.localeCompare(right.title)
  })
}

/**
 * Backwards-compat: take a template that may still have flat `items` and ensure
 * it has a `stages` array. Idempotent — templates that already have stages are
 * returned with their stage shape normalized. Pre-stage templates' top-level
 * assigneeId/viewerIds/editorIds become Stage 1's defaults.
 */
export function ensureTemplateStages(template: ChecklistTemplate): ChecklistTemplate {
  const viewerIds = Array.isArray(template.viewerIds) ? [...template.viewerIds] : []
  const editorIds = Array.isArray(template.editorIds) ? [...template.editorIds] : []
  const existingStages = Array.isArray((template as { stages?: TemplateStage[] }).stages)
    ? (template as { stages?: TemplateStage[] }).stages!
    : null

  if (existingStages && existingStages.length > 0) {
    const stages = existingStages.map((stage, index) => ({
      id: stage.id || makeId('stage'),
      name: stage.name || `Stage ${index + 1}`,
      assigneeId: stage.assigneeId || template.assigneeId,
      offsetDays: Number.isFinite(stage.offsetDays) ? Number(stage.offsetDays) : 0,
      ...(stage.dueDate ? { dueDate: stage.dueDate } : {}),
      viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
      editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
      items: Array.isArray(stage.items) ? stage.items.map((item) => ({ ...item })) : [],
    }))
    return { ...template, viewerIds, editorIds, stages }
  }

  const flatItems = Array.isArray(template.items) ? template.items.map((item) => ({ ...item })) : []
  const stage: TemplateStage = {
    id: makeId('stage'),
    name: 'Stage 1',
    assigneeId: template.assigneeId,
    offsetDays: 0,
    viewerIds,
    editorIds,
    items: flatItems,
  }
  return { ...template, viewerIds, editorIds, stages: [stage] }
}

/**
 * Resolve a stage's due date. An explicit `stage.dueDate` always wins over the
 * `offsetDays` calculation. Otherwise the due date is `baseDate` shifted by the
 * stage's `offsetDays`. Note: per-stage *repeat cadence* is not supported — the
 * template repeats as a whole; only the due date can be per-stage.
 */
export function resolveStageDueDate(stage: TemplateStage, baseDate: string): string {
  if (stage.dueDate) {
    return stage.dueDate
  }
  const offset = Number(stage.offsetDays) || 0
  return offset ? addDays(baseDate, offset) : baseDate
}

function buildChecklistFromStage(
  template: ChecklistTemplate,
  stage: TemplateStage,
  stageIndex: number,
  stageCount: number,
  caseId: string,
  dueDate: string,
): Checklist {
  return {
    id: makeId('check'),
    templateId: template.id,
    title: template.title,
    clientId: template.clientId,
    assigneeId: stage.assigneeId,
    frequency: template.frequency,
    dueDate,
    viewerIds: [...stage.viewerIds],
    editorIds: [...stage.editorIds],
    createdAt: new Date().toISOString().slice(0, 10),
    caseId,
    stageId: stage.id,
    stageIndex,
    stageCount,
    items: stage.items.map((item) => ({
      id: makeId('item'),
      label: item.label,
      done: false,
      ...(item.dueDate ? { dueDate: item.dueDate } : {}),
      ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      ...(Array.isArray(item.subItems) && item.subItems.length > 0
        ? {
            subItems: item.subItems.map((sub) => ({
              id: makeId('subitem'),
              title: sub.title,
              done: false,
              ...(Array.isArray(sub.subItems) && sub.subItems.length > 0
                ? {
                    subItems: sub.subItems.map((subSub) => ({
                      id: makeId('subsubitem'),
                      title: subSub.title,
                      done: false,
                    })),
                  }
                : {}),
            })),
          }
        : {}),
    })),
  }
}

/**
 * Day-of-month a specific-months template's checklist is due in `month` of
 * `year`. Honors `dueDayOfMonth` (capped to 28); falls back to the actual last
 * day of that month when unset. `month` is 1–12.
 */
export function resolveSpecificMonthsDueDate(
  template: Pick<ChecklistTemplate, 'dueDayOfMonth'>,
  year: number,
  month: number,
): string {
  const day =
    typeof template.dueDayOfMonth === 'number' &&
    template.dueDayOfMonth >= 1 &&
    template.dueDayOfMonth <= 28
      ? template.dueDayOfMonth
      : new Date(year, month, 0).getDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function ensureRecurringChecklists(data: AppData) {
  const templates = (data.checklistTemplates ?? []).map((template) => ensureTemplateStages(template))
  const existingChecklists = (data.checklists ?? []).map((checklist) => ({
    ...checklist,
    viewerIds: Array.isArray(checklist.viewerIds) ? checklist.viewerIds : [],
    editorIds: Array.isArray(checklist.editorIds) ? checklist.editorIds : [],
  }))

  // Backfill case/stage fields on legacy checklists.
  let changed = false
  const templatesById = new Map(templates.map((template) => [template.id, template] as const))
  const checklistsBackfilled = existingChecklists.map((checklist) => {
    const next = { ...checklist }
    let mutated = false
    if (!next.caseId) {
      next.caseId = next.id
      mutated = true
    }
    if (typeof next.stageIndex !== 'number') {
      next.stageIndex = 0
      mutated = true
    }
    if (typeof next.stageCount !== 'number') {
      next.stageCount = 1
      mutated = true
    }
    if (!next.stageId && next.templateId) {
      const owningTemplate = templatesById.get(next.templateId)
      const firstStage = owningTemplate?.stages?.[0]
      if (firstStage) {
        next.stageId = firstStage.id
        next.stageCount = owningTemplate!.stages.length
        mutated = true
      }
    }
    if (mutated) changed = true
    return next
  })

  // Materialise stage 1 instances for due/overdue templates.
  const today = new Date().toISOString().slice(0, 10)
  const existingKeys = new Set(
    checklistsBackfilled
      .filter((checklist) => checklist.templateId)
      .map((checklist) => `${checklist.templateId}:${checklist.dueDate}:${checklist.stageIndex ?? 0}`),
  )
  const checklists = [...checklistsBackfilled]

  // Year-month instance keys (`${templateId}:${YYYY-MM}`) for specific-months
  // templates. Derived from each existing checklist's due date so re-running
  // materialization never double-generates a designated month.
  const existingMonthKeys = new Set(
    checklistsBackfilled
      .filter((checklist) => checklist.templateId && checklist.dueDate)
      .map((checklist) => `${checklist.templateId}:${checklist.dueDate.slice(0, 7)}`),
  )

  const todayDate = new Date()
  const currentYear = todayDate.getFullYear()

  for (const template of templates) {
    const stages = template.stages ?? []
    // Standard templates are blueprints only — they never materialize.
    if (template.isStandard || !template.active || stages.length === 0 || stages[0].items.length === 0) {
      continue
    }

    // Specific-months mode: ignore nextDueDate advance logic. For each
    // designated month of the current year that has already started, generate
    // a Stage-1 instance unless one already exists for that template+month.
    if (template.frequency === 'specific-months') {
      const months = Array.isArray(template.scheduledMonths) ? template.scheduledMonths : []
      for (const month of months) {
        if (!Number.isInteger(month) || month < 1 || month > 12) continue
        // Has this month started? (today on or after the 1st of that month.)
        const monthStart = new Date(currentYear, month - 1, 1)
        if (todayDate < monthStart) continue
        const monthKey = `${template.id}:${currentYear}-${String(month).padStart(2, '0')}`
        if (existingMonthKeys.has(monthKey)) continue
        const stageOne = stages[0]
        const stageOneDue = resolveSpecificMonthsDueDate(template, currentYear, month)
        const caseId = makeId('case')
        checklists.push(
          buildChecklistFromStage(template, stageOne, 0, stages.length, caseId, stageOneDue),
        )
        existingMonthKeys.add(monthKey)
        existingKeys.add(`${template.id}:${stageOneDue}:0`)
        changed = true
      }
      continue
    }

    let safetyCounter = 0
    while (template.nextDueDate <= today && safetyCounter < 60) {
      const instanceKey = `${template.id}:${template.nextDueDate}:0`
      if (!existingKeys.has(instanceKey)) {
        const stageOne = stages[0]
        const stageOneDue = resolveStageDueDate(stageOne, template.nextDueDate)
        const caseId = makeId('case')
        checklists.push(
          buildChecklistFromStage(
            template,
            stageOne,
            0,
            stages.length,
            caseId,
            stageOneDue,
          ),
        )
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
      checklistTemplates: templates,
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
    case 'login_via_email_link':
      return 'signed in via email link'
    case 'login_link_requested':
      return 'requested a sign-in link for'
    case 'signed_out':
      return 'signed out'
    case 'session_revoked':
      return 'revoked a session for'
    case 'team_link_resent':
      return 'resent sign-in link to'
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
    case 'client_profile_updated':
      return 'updated client profile'
    case 'client_team_updated':
      return 'updated client assigned team'
    case 'case_started':
      return 'started case'
    case 'case_advanced':
      return 'advanced case'
    case 'case_completed':
      return 'completed case'
    case 'template_stage_added':
      return 'added template stage'
    case 'template_stage_removed':
      return 'removed template stage'
    case 'template_stage_edited':
      return 'edited template stage'
    case 'template_stages_reordered':
      return 'reordered template stages'
    case 'standard_template_created':
      return 'created standard template'
    case 'template_applied_to_client':
      return 'applied template to client'
    case 'template_copied_to_client':
      return 'copied template to client'
    case 'totp_enabled':
      return 'enabled two-factor authentication'
    case 'totp_disabled':
      return 'disabled two-factor authentication'
    case 'totp_backup_codes_regenerated':
      return 'regenerated backup codes for'
    case 'totp_used_backup_code':
      return 'used a backup code'
    case 'totp_reset_by_admin':
      return 'reset two-factor for'
    default:
      return action.replace(/_/g, ' ')
  }
}

export function lastDayOfCurrentMonth() {
  const date = new Date()
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  return last.toISOString().slice(0, 10)
}
