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

export type SetupCategory = 'Billing' | 'Clients' | 'Team' | 'Contacts' | 'Plans'
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

const CATEGORY_ORDER: SetupCategory[] = ['Billing', 'Clients', 'Team', 'Plans', 'Contacts']

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
