import { describe, expect, it } from 'vitest'
import { computeSetupIssues, groupSetupIssues, type CompletenessInput } from '../lib/completeness'
import type { Client, Contact, Employee, SubscriptionPlan, ChecklistTemplate } from '../lib/types'

const makeClient = (overrides: Partial<Client>): Client => ({
  id: 'client-1',
  name: 'Acme',
  contact: 'Pat',
  billingMode: 'subscription',
  hourlyRate: 0,
  planIds: [],
  contactIds: ['contact-1'],
  monthlyRate: 1000,
  email: 'pay@acme.test',
  assignedEmployeeIds: ['emp-1'],
  ...overrides,
})

const emptyInput: CompletenessInput = {
  clients: [],
  contacts: [],
  plans: [],
  employees: [],
  checklistTemplates: [],
}

describe('computeSetupIssues', () => {
  it('returns no issues for a fully set-up workspace', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({})],
      employees: [{ id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: 100 }],
      contacts: [{ id: 'contact-1', name: 'Pat' }],
    }
    expect(computeSetupIssues(input)).toEqual([])
  })

  it('flags a subscription client with no monthly rate', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ monthlyRate: 0 })],
    }
    const issues = computeSetupIssues(input)
    expect(issues.some((i) => i.id === 'billing:monthly:client-1' && i.severity === 'high')).toBe(
      true,
    )
  })

  it('flags an annual client with no annual rate', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ billingMode: 'annual', monthlyRate: undefined, annualRate: 0 })],
    }
    expect(computeSetupIssues(input).some((i) => i.id === 'billing:annual:client-1')).toBe(true)
  })

  it('does not flag billing rate for hourly clients (they bill per employee)', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ billingMode: 'hourly', monthlyRate: undefined })],
    }
    expect(computeSetupIssues(input).some((i) => i.category === 'Billing')).toBe(false)
  })

  it('flags missing email, team, and contacts on a client', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ email: '', assignedEmployeeIds: [], contactIds: [] })],
    }
    const ids = computeSetupIssues(input).map((i) => i.id)
    expect(ids).toContain('client:email:client-1')
    expect(ids).toContain('client:team:client-1')
    expect(ids).toContain('client:contacts:client-1')
  })

  it('flags a team member with no bill rate', () => {
    const employees: Employee[] = [{ id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: null }]
    const input: CompletenessInput = { ...emptyInput, employees }
    expect(computeSetupIssues(input).some((i) => i.id === 'team:bill-rate:emp-1')).toBe(true)
  })

  it('flags a plan with no checklist templates', () => {
    const plans: SubscriptionPlan[] = [{ id: 'plan-1', name: 'Essentials', notes: '', templateIds: [] }]
    const input: CompletenessInput = { ...emptyInput, plans }
    expect(computeSetupIssues(input).some((i) => i.id === 'plan:templates:plan-1')).toBe(true)
  })

  it('flags a contact not linked to any client', () => {
    const contacts: Contact[] = [{ id: 'contact-9', name: 'Orphan' }]
    const input: CompletenessInput = { ...emptyInput, contacts }
    expect(computeSetupIssues(input).some((i) => i.id === 'contact:unlinked:contact-9')).toBe(true)
  })

  it('flags a client on a plan whose checklists are not set up', () => {
    const plans: SubscriptionPlan[] = [
      { id: 'plan-1', name: 'Essentials', notes: '', templateIds: ['tmpl-1'] },
    ]
    const checklistTemplates: ChecklistTemplate[] = [
      {
        id: 'tmpl-1',
        title: 'Monthly Close',
        clientId: '',
        assigneeId: '',
        frequency: 'monthly',
        active: true,
        isStandard: true,
        stages: [],
      } as unknown as ChecklistTemplate,
    ]
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ planIds: ['plan-1'] })],
      plans,
      checklistTemplates,
    }
    const issue = computeSetupIssues(input).find(
      (i) => i.id === 'client:plan-checklists:client-1:plan-1',
    )
    expect(issue).toBeDefined()
    // Names each missing checklist, not just a count — and the count matches.
    expect(issue?.items).toEqual(['Monthly Close'])
    expect(issue?.detail).toContain('1 plan checklist')
  })

  it('lists each specific missing checklist by name, excluding ones already added', () => {
    const plans: SubscriptionPlan[] = [
      { id: 'plan-1', name: 'Essentials', notes: '', templateIds: ['tmpl-1', 'tmpl-2', 'tmpl-3'] },
    ]
    const makeTmpl = (id: string, title: string, clientId: string): ChecklistTemplate =>
      ({
        id,
        title,
        clientId,
        assigneeId: '',
        frequency: 'monthly',
        active: true,
        isStandard: clientId === '',
        stages: [],
      }) as unknown as ChecklistTemplate
    const checklistTemplates: ChecklistTemplate[] = [
      makeTmpl('tmpl-1', 'Monthly Close', ''),
      makeTmpl('tmpl-2', 'Payroll', ''),
      makeTmpl('tmpl-3', 'Sales Tax', ''),
      // Client already has "Payroll" set up (a client-scoped copy of tmpl-2).
      makeTmpl('client-tmpl-2', 'Payroll', 'client-1'),
    ]
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ planIds: ['plan-1'] })],
      plans,
      checklistTemplates,
    }
    const issue = computeSetupIssues(input).find(
      (i) => i.id === 'client:plan-checklists:client-1:plan-1',
    )
    // Payroll is already added, so only the two truly-missing ones are listed,
    // and the count in the detail matches the listed items.
    expect(issue?.items).toEqual(['Monthly Close', 'Sales Tax'])
    expect(issue?.items?.length).toBe(2)
    expect(issue?.detail).toContain('2 plan checklists')
  })
})

describe('groupSetupIssues', () => {
  it('groups issues by category in display order and drops empty groups', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ monthlyRate: 0, email: '' })],
      employees: [{ id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: null }],
    }
    const groups = groupSetupIssues(computeSetupIssues(input))
    const categories = groups.map((g) => g.category)
    expect(categories).toEqual(['Billing', 'Clients', 'Team'])
    expect(groups.every((g) => g.issues.length > 0)).toBe(true)
  })
})
