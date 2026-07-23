import { describe, expect, it } from 'vitest'
import {
  computeSetupIssues,
  groupSetupIssues,
  type CompletenessInput,
} from '../lib/completeness'
import type {
  Checklist,
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
    expect(computeSetupIssues(input).some((i) => i.category === 'Invoices')).toBe(false)
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

describe('computeSetupIssues — recurring checklists that will never generate', () => {
  // The real ask: a recipe missing a mandatory field silently produces nothing.
  // These mirror the materializer's gate conditions.
  const makeTemplate = (overrides: Record<string, unknown>): ChecklistTemplate =>
    ({
      id: 'tmpl-1',
      title: 'Annual Reports',
      clientId: 'client-1',
      assigneeId: 'emp-1',
      frequency: 'monthly',
      active: true,
      isStandard: false,
      nextDueDate: '2026-08-01',
      stages: [{ id: 'stage-1', name: 'Stage 1', assigneeId: 'emp-1', items: [{ id: 'i1', label: 'Do it' }] }],
      ...overrides,
    }) as unknown as ChecklistTemplate

  const run = (template: ChecklistTemplate) =>
    computeSetupIssues({ ...emptyInput, clients: [makeClient({})], checklistTemplates: [template] })
      .filter((issue) => issue.category === 'Checklists')

  it('flags a recipe whose first stage has no steps (the real production case)', () => {
    const issues = run(makeTemplate({ stages: [{ id: 'stage-1', name: 'S', assigneeId: 'emp-1', items: [] }] }))
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('checklist-template:no-steps:tmpl-1')
    expect(issues[0].severity).toBe('high')
    expect(issues[0].detail).toContain('never generated')
  })

  it('flags a recipe with no stages at all', () => {
    expect(run(makeTemplate({ stages: [] }))[0].id).toBe('checklist-template:no-stages:tmpl-1')
  })

  it('flags a specific-months recipe with no months chosen', () => {
    const issues = run(makeTemplate({ frequency: 'specific-months', scheduledMonths: [] }))
    expect(issues[0].id).toBe('checklist-template:no-months:tmpl-1')
  })

  it('flags a non-specific-months recipe with no next due date', () => {
    expect(run(makeTemplate({ nextDueDate: '' }))[0].id).toBe('checklist-template:no-due-date:tmpl-1')
  })

  it('flags a recipe that is switched off, but only as medium', () => {
    const issues = run(makeTemplate({ active: false }))
    expect(issues[0].id).toBe('checklist-template:inactive:tmpl-1')
    expect(issues[0].severity).toBe('medium')
  })

  it('flags a stage with no assignee — nobody could complete it', () => {
    const issues = run(
      makeTemplate({
        stages: [{ id: 'stage-1', name: 'S', assigneeId: '', items: [{ id: 'i1', label: 'Do it' }] }],
      }),
    )
    expect(issues[0].id).toBe('checklist-template:no-assignee:tmpl-1')
  })

  it('says nothing about a correctly-configured recipe', () => {
    expect(run(makeTemplate({}))).toEqual([])
  })

  it('ignores STANDARD blueprints — they are never meant to generate', () => {
    expect(run(makeTemplate({ isStandard: true, stages: [] }))).toEqual([])
  })

  it('softens the wording once a recipe has generated before', () => {
    const template = makeTemplate({ stages: [{ id: 'stage-1', name: 'S', assigneeId: 'emp-1', items: [] }] })
    const issues = computeSetupIssues({
      ...emptyInput,
      clients: [makeClient({})],
      checklistTemplates: [template],
      checklists: [{ id: 'c1', templateId: 'tmpl-1' } as unknown as Checklist],
    }).filter((issue) => issue.category === 'Checklists')
    expect(issues[0].detail).toContain('stopped generating')
  })
})

// `computeIncompleteChecklists` was removed with the To-100% rework (owner
// feedback round 4): active checklist work is operations, not a broken part of
// the site, and must never appear on that page. This block pins the guarantee
// at the engine level — in-flight checklists produce NO issues.
describe('computeSetupIssues — never reports in-flight checklist work', () => {
  it('an active checklist with unchecked steps produces no issue anywhere', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({})],
      employees: [{ id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: 100 }],
      contacts: [{ id: 'contact-1', name: 'Pat' }],
      checklists: [
        {
          id: 'cl-1',
          title: 'Monthly Bookkeeping',
          clientId: 'client-1',
          items: [{ id: 'i1', label: 'Reconcile', done: false }],
        } as unknown as Checklist,
      ],
    }
    expect(computeSetupIssues(input)).toEqual([])
  })

})

describe('computeSetupIssues — Board column check', () => {
  const template = (overrides: Record<string, unknown>): ChecklistTemplate =>
    ({
      id: 'tmpl-1',
      title: 'Monthly Close',
      clientId: 'client-1',
      assigneeId: 'emp-1',
      frequency: 'monthly',
      active: true,
      isStandard: false,
      nextDueDate: '2026-08-01',
      stages: [
        { id: 's1', name: 'Stage 1', assigneeId: 'emp-1', items: [{ id: 'i1', label: 'Do it' }] },
      ],
      ...overrides,
    }) as unknown as ChecklistTemplate
  const boardIssues = (tmpl: ChecklistTemplate) =>
    computeSetupIssues({ ...emptyInput, clients: [makeClient({})], checklistTemplates: [tmpl] })
      .filter((issue) => issue.category === 'Board')

  it('flags a healthy recipe with no Board column (lands in Uncategorized)', () => {
    const issues = boardIssues(template({}))
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('board:no-column:tmpl-1')
    expect(issues[0].severity).toBe('low')
  })

  it('says nothing when a column is set, and skips standard blueprints', () => {
    expect(boardIssues(template({ categoryId: 'cat-1' }))).toEqual([])
    expect(boardIssues(template({ isStandard: true }))).toEqual([])
  })
})

describe('groupSetupIssues', () => {
  it('groups by tab in sidebar order, KEEPING empty tabs so they can render green', () => {
    const input: CompletenessInput = {
      ...emptyInput,
      clients: [makeClient({ monthlyRate: 0, email: '' })],
      employees: [{ id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: null }],
    }
    const groups = groupSetupIssues(computeSetupIssues(input))
    expect(groups.map((g) => g.category)).toEqual([
      'Checklists',
      'Board',
      'Clients',
      'Invoices',
      'Plans',
      'Team',
      'Contacts',
    ])
    const counts = Object.fromEntries(groups.map((g) => [g.category, g.issues.length]))
    // Empty tabs are present with zero issues — the page shows them as green.
    expect(counts).toEqual({
      Checklists: 0,
      Board: 0,
      Clients: 1,
      Invoices: 1,
      Plans: 0,
      Team: 1,
      Contacts: 0,
    })
  })
})
