/**
 * "To 100%" setup-completeness engine — a pure, derived view over the workspace
 * that surfaces what the owner still needs to fill in for the app to be fully
 * set up (clients missing rates, team without bill rates, contacts not linked,
 * plans without checklists, etc.). No data-model change: it reads the data the
 * client already holds and returns a flat list of actionable issues, each with
 * a deep-link to where it's fixed. Tested in src/__tests__/completeness.test.ts.
 */
import type {
  Checklist,
  ChecklistTemplate,
  Client,
  Contact,
  Employee,
  SubscriptionPlan,
} from './types'
import { isChecklistItemDone, missingPlanTemplatesForClient, unlinkedContacts } from './utils'

export type SetupCategory = 'Billing' | 'Clients' | 'Checklists' | 'Team' | 'Contacts' | 'Plans'
export type SetupSeverity = 'high' | 'medium' | 'low'

/**
 * A focused fix an issue can offer, so "Fix" opens a small modal on just the
 * missing field instead of navigating to the whole client/team page. Issues
 * with no `fix` fall back to their deep-link (`to`).
 */
export type SetupFix =
  | { kind: 'clientNumber'; clientId: string; field: 'monthlyRate' | 'annualRate'; label: string }
  | { kind: 'clientText'; clientId: string; field: 'email'; label: string }
  | { kind: 'clientTeam'; clientId: string }
  | { kind: 'planChecklists'; clientId: string; templateIds: string[] }

export interface SetupIssue {
  /** Stable id so React keys + tests are deterministic. */
  id: string
  category: SetupCategory
  /** Short imperative description of what's missing. */
  title: string
  /** Optional extra context. */
  detail?: string
  /** Optional focused fix (opens a quick-fix modal); absent = use the deep-link. */
  fix?: SetupFix
  /**
   * Optional list of the specific outstanding things behind this issue, by
   * name — so a suggestion isn't just a count ("3 checklists not yet added")
   * but names each one ("Monthly Bookkeeping", "Payroll", "Sales Tax"). The
   * count always matches `items.length`.
   */
  items?: string[]
  /** Route to go fix it (react-router path). */
  to: string
  severity: SetupSeverity
}

export interface CompletenessInput {
  clients: Client[]
  contacts: Contact[]
  plans: SubscriptionPlan[]
  /** Active employees only (inactive/former members aren't actionable). */
  employees: Employee[]
  checklistTemplates: ChecklistTemplate[]
  /** Live checklists — used only to say whether a recipe has ever generated. */
  checklists?: Checklist[]
}

const isPositive = (value: unknown): boolean =>
  typeof value === 'number' && !Number.isNaN(value) && value > 0

/**
 * Derive every outstanding setup item. Order: highest-severity categories first
 * (Billing, Clients), then Team, Plans, Contacts. Within a category, issues are
 * in input order so the list is stable.
 */
export function computeSetupIssues(input: CompletenessInput): SetupIssue[] {
  const { clients, contacts, plans, employees, checklistTemplates } = input
  const issues: SetupIssue[] = []
  const planById = new Map(plans.map((plan) => [plan.id, plan]))

  for (const client of clients) {
    const where = `/clients/${client.id}`

    // Billing rate not set for subscription / annual clients. (Hourly clients
    // bill off per-employee bill rates — covered by the Team check below.)
    if (client.billingMode === 'subscription' && !isPositive(client.monthlyRate)) {
      issues.push({
        id: `billing:monthly:${client.id}`,
        category: 'Billing',
        title: `Set a monthly rate for ${client.name}`,
        detail: 'This Monthly client has no monthly rate, so its invoice is $0.',
        fix: { kind: 'clientNumber', clientId: client.id, field: 'monthlyRate', label: 'Monthly rate' },
        to: where,
        severity: 'high',
      })
    }
    if (client.billingMode === 'annual' && !isPositive(client.annualRate)) {
      issues.push({
        id: `billing:annual:${client.id}`,
        category: 'Billing',
        title: `Set an annual rate for ${client.name}`,
        detail: 'This Annual client has no annual fee, so its invoice is $0.',
        fix: { kind: 'clientNumber', clientId: client.id, field: 'annualRate', label: 'Annual fee' },
        to: where,
        severity: 'high',
      })
    }

    // No billing email — can't email the invoice.
    if (!client.email || !client.email.trim()) {
      issues.push({
        id: `client:email:${client.id}`,
        category: 'Clients',
        title: `Add a billing email for ${client.name}`,
        detail: 'Needed to email this client their invoice.',
        fix: { kind: 'clientText', clientId: client.id, field: 'email', label: 'Billing email' },
        to: where,
        severity: 'medium',
      })
    }

    // No assigned team member.
    if (!client.assignedEmployeeIds || client.assignedEmployeeIds.length === 0) {
      issues.push({
        id: `client:team:${client.id}`,
        category: 'Clients',
        title: `Assign a team member to ${client.name}`,
        fix: { kind: 'clientTeam', clientId: client.id },
        to: where,
        severity: 'medium',
      })
    }

    // No contacts on the client.
    if (!client.contactIds || client.contactIds.length === 0) {
      issues.push({
        id: `client:contacts:${client.id}`,
        category: 'Clients',
        title: `Add a contact for ${client.name}`,
        to: where,
        severity: 'low',
      })
    }

    // On a plan, but the plan's checklists aren't set up on this client.
    const clientTemplates = checklistTemplates.filter(
      (template) => template.clientId === client.id,
    )
    for (const planId of client.planIds ?? []) {
      const plan = planById.get(planId)
      if (!plan) continue
      const missing = missingPlanTemplatesForClient(
        plan,
        checklistTemplates,
        client.id,
        clientTemplates,
      )
      if (missing.length > 0) {
        issues.push({
          id: `client:plan-checklists:${client.id}:${plan.id}`,
          category: 'Clients',
          title: `Set up ${plan.name} checklists for ${client.name}`,
          detail: `${missing.length} plan checklist${missing.length === 1 ? '' : 's'} not yet added:`,
          // Name each missing checklist so the owner sees exactly which ones are
          // outstanding, not just a count. Already-added ones are filtered out
          // by `missingPlanTemplatesForClient`, so this lists only what's left.
          items: missing.map((template) => template.title),
          fix: {
            kind: 'planChecklists',
            clientId: client.id,
            templateIds: missing.map((template) => template.id),
          },
          to: where,
          severity: 'medium',
        })
      }
    }
  }

  // Recurring checklists that are MISCONFIGURED and will therefore never
  // generate. A recipe missing a mandatory field fails silently — nothing is
  // created and nothing says so — so these are surfaced by name with the exact
  // field that's missing. Mirrors the materializer's own gate conditions
  // (see materializeRecurringChecklists); if you change one, change both.
  const instancesByTemplate = new Map<string, number>()
  for (const checklist of input.checklists ?? []) {
    if (!checklist.templateId) continue
    instancesByTemplate.set(
      checklist.templateId,
      (instancesByTemplate.get(checklist.templateId) ?? 0) + 1,
    )
  }
  const currentYear = new Date().getFullYear()

  for (const template of checklistTemplates) {
    // Standard blueprints are recipes to copy, not schedules — they're never
    // meant to generate, so an empty one isn't a fault.
    if (template.isStandard) continue

    const stages = template.stages ?? []
    const clientLabel = template.clientId
      ? (clients.find((client) => client.id === template.clientId)?.name ?? 'a client')
      : ''
    const name = clientLabel ? `${template.title} · ${clientLabel}` : template.title
    const to = `/checklists?focusTemplate=${template.id}`
    const neverRan = (instancesByTemplate.get(template.id) ?? 0) === 0
    // The strongest evidence something is wrong: it has produced nothing, ever.
    const evidence = neverRan
      ? ' It has never generated a checklist.'
      : ' New ones have stopped generating.'
    const flag = (id: string, title: string, detail: string, severity: SetupSeverity = 'high') => {
      issues.push({
        id: `checklist-template:${id}:${template.id}`,
        category: 'Checklists',
        title,
        detail,
        to,
        severity,
      })
    }

    if (!template.clientId) {
      flag(
        'no-client',
        `Pick a client for the "${template.title}" recurring checklist`,
        `It isn't attached to a client, so it can't generate anything.${evidence}`,
      )
      continue
    }
    // Switched off — that may well be deliberate, so it's flagged gently rather
    // than as a fault, but she still sees why nothing is appearing.
    if (!template.active) {
      flag(
        'inactive',
        `"${name}" is turned off`,
        `It's set to inactive, so it won't generate any new checklists until it's turned back on.`,
        'medium',
      )
      continue
    }
    if (stages.length === 0) {
      flag(
        'no-stages',
        `Add steps to the "${name}" recurring checklist`,
        `It has no stages set up, so nothing can be generated from it.${evidence}`,
      )
      continue
    }
    if ((stages[0].items ?? []).length === 0) {
      flag(
        'no-steps',
        `Add steps to the "${name}" recurring checklist`,
        `Its first stage has no steps, so it never generates.${evidence} Open it and add the steps that should be done each time.`,
      )
      continue
    }
    if (template.frequency === 'specific-months') {
      const months = Array.isArray(template.scheduledMonths) ? template.scheduledMonths : []
      if (months.filter((month) => Number.isInteger(month) && month >= 1 && month <= 12).length === 0) {
        flag(
          'no-months',
          `Choose which months "${name}" runs in`,
          `It repeats in specific months but no months are selected, so it never generates.${evidence}`,
        )
        continue
      }
      if (template.repeatAnnually === false && template.scheduleYear !== currentYear) {
        flag(
          'stale-year',
          `"${name}" is scheduled for ${template.scheduleYear ?? 'another year'} only`,
          `"Repeat every year" is off and its scheduled year isn't ${currentYear}, so it won't generate this year.`,
          'medium',
        )
        continue
      }
    } else if (!template.nextDueDate) {
      flag(
        'no-due-date',
        `Set a due date for the "${name}" recurring checklist`,
        `It has no next due date, so the schedule never starts.${evidence}`,
      )
      continue
    }
    // It WILL generate — but with nobody named, only an owner could ever tick
    // its steps off (completing a step is limited to the assigned person).
    if (!stages[0].assigneeId) {
      flag(
        'no-assignee',
        `Assign someone to the "${name}" recurring checklist`,
        'Its first stage has no assignee, so the checklists it creates land on nobody and only an owner can complete them.',
        'medium',
      )
    }
  }

  // Team members without a bill rate can't have their billable hours invoiced.
  for (const employee of employees) {
    if (!isPositive(employee.billRate)) {
      issues.push({
        id: `team:bill-rate:${employee.id}`,
        category: 'Team',
        title: `Set a bill rate for ${employee.name}`,
        detail: "Their billable hours fall back to the firm default rate until set.",
        // Bill rate lives on the Team page (updates there don't flow through the
        // client workspace data), so this one deep-links rather than quick-fixes.
        to: '/team',
        severity: 'medium',
      })
    }
  }

  // Plans with no checklist templates attached.
  for (const plan of plans) {
    if (!plan.templateIds || plan.templateIds.length === 0) {
      issues.push({
        id: `plan:templates:${plan.id}`,
        category: 'Plans',
        title: `Add checklist templates to the ${plan.name} plan`,
        to: '/plans',
        severity: 'low',
      })
    }
  }

  // Contacts not linked to any client.
  for (const contact of unlinkedContacts(contacts, clients)) {
    issues.push({
      id: `contact:unlinked:${contact.id}`,
      category: 'Contacts',
      title: `Link ${contact.name} to a client (or archive them)`,
      to: '/contacts',
      severity: 'low',
    })
  }

  return issues
}

const CATEGORY_ORDER: SetupCategory[] = [
  'Billing',
  // Checklists sit high: a recipe that silently never generates is invisible
  // work not getting done.
  'Checklists',
  'Clients',
  'Team',
  'Plans',
  'Contacts',
]

export interface SetupCategoryGroup {
  category: SetupCategory
  issues: SetupIssue[]
}

/** Group issues by category in display order, dropping empty categories. */
export function groupSetupIssues(issues: SetupIssue[]): SetupCategoryGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    issues: issues.filter((issue) => issue.category === category),
  })).filter((group) => group.issues.length > 0)
}

/** One active checklist that still has unchecked steps. */
export interface IncompleteChecklist {
  checklistId: string
  title: string
  dueDate?: string
  /** The labels of the steps that are NOT done, in checklist order. */
  incompleteItems: string[]
  incompleteCount: number
  totalCount: number
}

/** A client and the checklist work still outstanding on it. */
export interface IncompleteChecklistGroup {
  clientId: string
  clientName: string
  totalIncomplete: number
  checklists: IncompleteChecklist[]
}

/**
 * The operational companion to `computeSetupIssues`: every UNCHECKED checklist
 * step across active checklists, named and grouped by client — so the To-100%
 * page shows the actual outstanding checklist work, not just how many items are
 * left. This is the "checklist part" the setup checks above never looked at.
 *
 * A step counts as incomplete when `isChecklistItemDone` is false, which rolls
 * sub-steps up (an item with any unfinished sub-step is itself unfinished).
 * Completed steps are omitted; checklists with nothing left, and soft-deleted
 * checklists, are dropped entirely. Groups are ordered most-incomplete first;
 * within a group, checklists are ordered by due date then title.
 */
export function computeIncompleteChecklists(
  checklists: Checklist[],
  clients: Client[],
): IncompleteChecklistGroup[] {
  const clientNameById = new Map(clients.map((client) => [client.id, client.name]))
  const byClient = new Map<string, IncompleteChecklistGroup>()

  for (const checklist of checklists) {
    if (checklist.deletedAt) continue
    const items = checklist.items ?? []
    if (items.length === 0) continue
    const incompleteItems = items
      .filter((item) => !isChecklistItemDone(item))
      .map((item) => item.label)
    if (incompleteItems.length === 0) continue

    const clientId = checklist.clientId ?? ''
    const group = byClient.get(clientId) ?? {
      clientId,
      clientName: clientNameById.get(clientId) ?? 'Unassigned',
      totalIncomplete: 0,
      checklists: [],
    }
    group.checklists.push({
      checklistId: checklist.id,
      title: checklist.title,
      dueDate: checklist.dueDate,
      incompleteItems,
      incompleteCount: incompleteItems.length,
      totalCount: items.length,
    })
    group.totalIncomplete += incompleteItems.length
    byClient.set(clientId, group)
  }

  const groups = [...byClient.values()]
  for (const group of groups) {
    group.checklists.sort(
      (a, b) =>
        (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.title.localeCompare(b.title),
    )
  }
  return groups.sort(
    (a, b) =>
      b.totalIncomplete - a.totalIncomplete || a.clientName.localeCompare(b.clientName),
  )
}
