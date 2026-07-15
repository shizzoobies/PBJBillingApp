import { describe, expect, it } from 'vitest'
import {
  computeIncompleteChecklists,
  computeSetupIssues,
  groupSetupIssues,
  type CompletenessInput,
} from '../lib/completeness'
import type {
  Checklist,
  ChecklistItem,
  Client,
  Contact,
  Employee,
  SubscriptionPlan,
  ChecklistTemplate,
} from '../lib/types'

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

  it('attaches quick-fix descriptors to the field-based issues', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ monthlyRate: 0, email: '', assignedEmployeeIds: [] })],
    }
    const byId = new Map(computeSetupIssues(input).map((i) => [i.id, i]))
    expect(byId.get('billing:monthly:client-1')?.fix).toEqual({
      kind: 'clientNumber',
      clientId: 'client-1',
      field: 'monthlyRate',
      label: 'Monthly rate',
    })
    expect(byId.get('client:email:client-1')?.fix).toEqual({
      kind: 'clientText',
      clientId: 'client-1',
      field: 'email',
      label: 'Billing email',
    })
    expect(byId.get('client:team:client-1')?.fix).toEqual({
      kind: 'clientTeam',
      clientId: 'client-1',
    })
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

const item = (label: string, done: boolean, subItems?: ChecklistItem['subItems']): ChecklistItem => ({
  id: `item-${label}`,
  label,
  done,
  ...(subItems ? { subItems } : {}),
})

const makeChecklist = (overrides: Partial<Checklist>): Checklist => ({
  id: 'cl-1',
  title: 'Monthly Bookkeeping',
  clientId: 'client-1',
  assigneeId: 'emp-1',
  dueDate: '2026-07-20',
  viewerIds: [],
  editorIds: [],
  items: [],
  ...overrides,
})

describe('computeIncompleteChecklists', () => {
  const clients = [makeClient({ id: 'client-1', name: 'Acme' })]

  it('returns nothing when every step is done', () => {
    const checklists = [makeChecklist({ items: [item('Reconcile', true), item('Review', true)] })]
    expect(computeIncompleteChecklists(checklists, clients)).toEqual([])
  })

  it('lists each incomplete step by name and excludes completed ones', () => {
    const checklists = [
      makeChecklist({
        items: [item('Reconcile', false), item('Categorize', true), item('Review', false)],
      }),
    ]
    const groups = computeIncompleteChecklists(checklists, clients)
    expect(groups).toHaveLength(1)
    const cl = groups[0].checklists[0]
    expect(cl.incompleteItems).toEqual(['Reconcile', 'Review'])
    expect(cl.incompleteCount).toBe(2)
    expect(cl.totalCount).toBe(3)
    expect(groups[0].totalIncomplete).toBe(2)
  })

  it('treats an item with any unfinished sub-step as incomplete', () => {
    const checklists = [
      makeChecklist({
        items: [item('Payroll', false, [{ id: 's1', title: 'Import', done: true }, { id: 's2', title: 'Approve', done: false }])],
      }),
    ]
    const groups = computeIncompleteChecklists(checklists, clients)
    expect(groups[0].checklists[0].incompleteItems).toEqual(['Payroll'])
  })

  it('drops soft-deleted checklists', () => {
    const checklists = [makeChecklist({ deletedAt: '2026-07-01', items: [item('Reconcile', false)] })]
    expect(computeIncompleteChecklists(checklists, clients)).toEqual([])
  })

  it('groups by client, resolves client names, and orders most-incomplete first', () => {
    const twoClients = [
      makeClient({ id: 'client-1', name: 'Acme' }),
      makeClient({ id: 'client-2', name: 'Beta' }),
    ]
    const checklists = [
      makeChecklist({ id: 'cl-a', clientId: 'client-1', items: [item('A', false)] }),
      makeChecklist({ id: 'cl-b', clientId: 'client-2', items: [item('B', false), item('C', false)] }),
    ]
    const groups = computeIncompleteChecklists(checklists, twoClients)
    expect(groups.map((g) => g.clientName)).toEqual(['Beta', 'Acme'])
  })

  it('labels an unknown client id as Unassigned', () => {
    const checklists = [makeChecklist({ clientId: 'ghost', items: [item('A', false)] })]
    expect(computeIncompleteChecklists(checklists, clients)[0].clientName).toBe('Unassigned')
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
