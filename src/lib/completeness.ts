/**
 * "To 100%" setup-completeness engine — a pure, derived view over the workspace
 * that surfaces what the owner still needs to fill in for the app to be fully
 * set up (clients missing rates, team without bill rates, contacts not linked,
 * plans without checklists, etc.). No data-model change: it reads the data the
 * client already holds and returns a flat list of actionable issues, each with
 * a deep-link to where it's fixed. Tested in src/__tests__/completeness.test.ts.
 */
import type {
  ChecklistTemplate,
  Client,
  Contact,
  Employee,
  SubscriptionPlan,
} from './types'
import { missingPlanTemplatesForClient, unlinkedContacts } from './utils'

export type SetupCategory = 'Billing' | 'Clients' | 'Team' | 'Contacts' | 'Plans'
export type SetupSeverity = 'high' | 'medium' | 'low'

export interface SetupIssue {
  /** Stable id so React keys + tests are deterministic. */
  id: string
  category: SetupCategory
  /** Short imperative description of what's missing. */
  title: string
  /** Optional extra context. */
  detail?: string
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
