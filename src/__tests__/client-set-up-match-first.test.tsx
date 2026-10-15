import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplyPackageField, PlanChecklistsBody, PlanServicesField } from '../pages/ClientDetailPage'
import { applyPackageConfirmText, chooseReasonText, setUpConfirmText, setUpResultText } from '../lib/packages'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistTemplate, Client, Package, SubscriptionPlan } from '../lib/types'

/**
 * SET UP MATCHES WHAT THE CLIENT ALREADY HAS (featreq-8bdc5ec5, part 2).
 *
 * "If checklist already exist match to that do not create new checklist or let me
 * link first and then if not setup." A Not set up row that one of the client's own
 * checklists stands for is LINKED; several that match leave it for her; only a
 * row nothing stands for is copied.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listPackagesRequest: (...args: unknown[]) => listPackagesRequest(...args),
  applyPackageRequest: (...args: unknown[]) => applyPackageRequest(...args),
}))

let listPackagesRequest = vi.fn()
let applyPackageRequest = vi.fn()
let contextValue: AppContextValue
let addChecklistTemplate = vi.fn()
let updateChecklistTemplate = vi.fn()

const plan = (id: string, name: string, templateIds: string[] = []): SubscriptionPlan => ({
  id,
  name,
  notes: '',
  templateIds,
})
const blueprint = (id: string, title: string): ChecklistTemplate =>
  ({ id, title, clientId: '', frequency: 'monthly', isStandard: true, stages: [] }) as unknown as ChecklistTemplate
const hers = (id: string, title: string, extra: Partial<ChecklistTemplate> = {}): ChecklistTemplate =>
  ({
    id,
    title,
    clientId: 'c1',
    frequency: 'specific-months',
    scheduledMonths: [1, 4, 7, 10],
    isStandard: false,
    active: true,
    stages: [],
    ...extra,
  }) as unknown as ChecklistTemplate

const PLANS = [plan('tx', 'Transactions - Monthly', ['T1']), plan('rec', 'Reconciliations - Quarterly', ['T2'])]
const BLUEPRINTS = [
  blueprint('T1', 'Transactions'),
  blueprint('T2', 'Reconciliations with Review'),
  blueprint('T3', 'Reports'),
]
const QA: Package = {
  id: 'qa',
  name: 'Quarterly Accounting',
  description: '',
  planIds: ['tx', 'rec'],
  templateIds: ['T1', 'T2', 'T3'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: null,
}
const ACME = { id: 'c1', name: 'Acme', planIds: ['tx', 'rec'], packageIds: ['qa'] } as Client
const HER_RECS = hers('h1', 'Quarterly Reconciliations with Review - Quarterly')

function setContext(templates: ChecklistTemplate[]) {
  const data = { plans: PLANS, clients: [ACME], checklistTemplates: templates } as unknown as AppData
  contextValue = { ownerMode: true, data, addChecklistTemplate, updateChecklistTemplate } as unknown as AppContextValue
  return data
}

const flush = () =>
  act(async () => {
    await vi.mocked(listPackagesRequest).mock.results[0].value.catch(() => undefined)
  })

beforeEach(() => {
  listPackagesRequest = vi.fn(async () => [QA])
  applyPackageRequest = vi.fn()
  addChecklistTemplate = vi.fn()
  updateChecklistTemplate = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Plan checklists panel: Set up package checklists', () => {
  it('names each row (link or create) before it acts, links hers, creates the rest, and says what it did', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const data = setContext([...BLUEPRINTS, HER_RECS])
    render(<PlanChecklistsBody client={ACME} data={data} />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(3\)/ }))

    const sentence = String((confirm.mock.calls[0] as unknown[])[0])
    expect(sentence).toContain(
      'Reconciliations with Review -> link "Quarterly Reconciliations with Review - Quarterly"',
    )
    expect(sentence).toContain('Transactions -> create')
    expect(sentence).toContain('Reports -> create')
    // Her checklist is stamped with the blueprint: the same link "Link existing" makes.
    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
    const [linkedId, updater] = updateChecklistTemplate.mock.calls[0] as [
      string,
      (template: ChecklistTemplate) => ChecklistTemplate,
    ]
    expect(linkedId).toBe('h1')
    expect(updater(HER_RECS).sourceTemplateId).toBe('T2')
    // Only the two nothing stands for are copied.
    expect(addChecklistTemplate.mock.calls.map((call) => (call[0] as ChecklistTemplate).sourceTemplateId)).toEqual([
      'T1',
      'T3',
    ])
    expect(screen.getByText('1 linked, 2 created.')).toBeTruthy()
  })

  it('does nothing when the confirm is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const data = setContext([...BLUEPRINTS, HER_RECS])
    render(<PlanChecklistsBody client={ACME} data={data} />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(3\)/ }))

    expect(updateChecklistTemplate).not.toHaveBeenCalled()
    expect(addChecklistTemplate).not.toHaveBeenCalled()
  })

  it('asks nothing and copies as before when nothing the client has stands for any row', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const data = setContext(BLUEPRINTS)
    render(<PlanChecklistsBody client={ACME} data={data} />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(3\)/ }))

    expect(confirm).not.toHaveBeenCalled()
    expect(updateChecklistTemplate).not.toHaveBeenCalled()
    expect(addChecklistTemplate).toHaveBeenCalledTimes(3)
    expect(screen.getByText('3 created.')).toBeTruthy()
  })

  it('links none and copies none for a row several of her checklists match - it stays Not set up', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const data = setContext([
      ...BLUEPRINTS,
      HER_RECS,
      hers('h2', 'Quarterly Reconciliations with Review'),
    ])
    render(<PlanChecklistsBody client={ACME} data={data} />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(3\)/ }))

    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain(
      'Reconciliations with Review -> left for you to choose (2 checklists match)',
    )
    expect(updateChecklistTemplate).not.toHaveBeenCalled()
    // The other two are still copied.
    expect(addChecklistTemplate.mock.calls.map((call) => (call[0] as ChecklistTemplate).sourceTemplateId)).toEqual([
      'T1',
      'T3',
    ])
    expect(screen.getByText('2 created, 1 left for you to choose.')).toBeTruthy()
    // Still Not set up, with the choices to link beside it.
    expect(screen.getAllByText('Not set up').length).toBeGreaterThan(0)
  })
})

describe('the plan\u2019s "How often" decides whether a lone checklist links', () => {
  it('leaves a quarterly checklist for her when the plan runs monthly, and links it when the plan is quarterly', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const monthlyPlans = [PLANS[0], plan('rec', 'Reconciliations - Monthly', ['T2'])]
    const data = {
      plans: monthlyPlans,
      clients: [ACME],
      checklistTemplates: [...BLUEPRINTS, HER_RECS],
    } as unknown as AppData
    contextValue = { ownerMode: true, data, addChecklistTemplate, updateChecklistTemplate } as unknown as AppContextValue
    const view = render(<PlanChecklistsBody client={ACME} data={data} />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(3\)/ }))

    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain(
      `Reconciliations with Review -> left for you to choose (its schedule differs from the plan's "How often")`,
    )
    expect(updateChecklistTemplate).not.toHaveBeenCalled()
    view.unmount()

    // The quarterly plan (setContext's PLANS) links the same checklist.
    confirm.mockClear()
    listPackagesRequest = vi.fn(async () => [QA])
    const quarterlyData = setContext([...BLUEPRINTS, HER_RECS])
    render(<PlanChecklistsBody client={ACME} data={quarterlyData} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(3\)/ }))
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain(
      'Reconciliations with Review -> link "Quarterly Reconciliations with Review - Quarterly"',
    )
    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
  })
})

describe('the Set up result belongs to one client', () => {
  it('does not show on the next client after it is navigated to', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const data = setContext(BLUEPRINTS)
    const view = render(<PlanChecklistsBody client={ACME} data={data} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(3\)/ }))
    expect(screen.getByText('3 created.')).toBeTruthy()

    const beta = { ...ACME, id: 'c2', name: 'Beta' } as Client
    view.rerender(<PlanChecklistsBody client={beta} data={data} />)
    expect(screen.queryByText('3 created.')).toBeNull()
  })
})

type ChooseStep = Parameters<typeof chooseReasonText>[0]

describe('the sentences for a row left for her to choose', () => {
  it('count the matches and name a differing schedule', () => {
    const several = { kind: 'choose', blueprint: BLUEPRINTS[1], candidates: [HER_RECS, HER_RECS], reason: 'several' } as unknown as ChooseStep
    const shared = { kind: 'choose', blueprint: BLUEPRINTS[1], candidates: [HER_RECS], reason: 'several' } as unknown as ChooseStep
    const schedule = { kind: 'choose', blueprint: BLUEPRINTS[1], candidates: [HER_RECS], reason: 'schedule' } as unknown as ChooseStep
    expect(chooseReasonText(several)).toBe('2 checklists match')
    expect(chooseReasonText(shared)).toBe('1 checklist matches, but it also fits another row')
    expect(chooseReasonText(schedule)).toBe(`its schedule differs from the plan's "How often"`)
    expect(
      applyPackageConfirmText({
        packageName: 'P',
        clientName: 'Acme',
        addedPlanNames: [],
        newChecklistTitles: [],
        skippedCount: 0,
        chooseLines: ['Reports (2 checklists match)', 'Close (its schedule differs)'],
      }),
    ).toContain('Leaves 2 for you to choose: Reports (2 checklists match); Close (its schedule differs).')
  })
})

describe('adding a plan chip', () => {
  it('links the checklist the client already has for the new plan instead of copying beside it', () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    setContext([...BLUEPRINTS, hers('h1', 'Quarterly Reconciliations with Review')])
    const client = { id: 'c1', name: 'Acme', planIds: ['tx'], packageIds: [] } as unknown as Client
    const onCommit = vi.fn()
    render(<PlanServicesField client={client} plans={PLANS} onCommit={onCommit} />)

    fireEvent.click(screen.getByRole('button', { name: '+ Add plan / service' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reconciliations - Quarterly' }))

    expect(onCommit).toHaveBeenCalledWith({ planIds: ['tx', 'rec'] })
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain(
      'Reconciliations with Review -> link "Quarterly Reconciliations with Review"',
    )
    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
    expect(addChecklistTemplate).not.toHaveBeenCalled()
    expect(screen.getByText('1 linked.')).toBeTruthy()
  })
})

describe('Apply package', () => {
  it('says which existing checklists it will link and which it leaves, and reports what the server did', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    setContext([...BLUEPRINTS, HER_RECS])
    applyPackageRequest = vi.fn(async () => ({
      client: ACME,
      addedPlanIds: [],
      clonedTemplateIds: ['T1', 'T3'],
      skippedTemplateIds: [],
      linkedTemplateIds: ['T2'],
      ambiguousTemplateIds: [],
    }))
    render(<ApplyPackageField client={{ ...ACME, packageIds: [] }} />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: '+ Add package' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Quarterly Accounting' }))

    const sentence = String((confirm.mock.calls[0] as unknown[])[0])
    expect(sentence).toContain('Creates 2 checklists for this client: Transactions, Reports')
    expect(sentence).toContain(
      'Links 1 checklist this client already has instead of copying: Reconciliations with Review -> Quarterly Reconciliations with Review - Quarterly.',
    )
    expect(await screen.findByText(/2 checklists created, 1 linked to checklists already here/)).toBeTruthy()
  })
})

describe('the sentences', () => {
  it('count what happened, leaving out what did not', () => {
    const steps = [
      { kind: 'link', blueprint: BLUEPRINTS[1], copy: HER_RECS },
      { kind: 'create', blueprint: BLUEPRINTS[0] },
      { kind: 'create', blueprint: BLUEPRINTS[2] },
    ] as const
    expect(setUpResultText(steps)).toBe('1 linked, 2 created.')
    expect(setUpResultText([steps[1]])).toBe('1 created.')
    expect(setUpResultText([])).toBe('Nothing to set up.')
    expect(setUpConfirmText('Set up package checklists for Acme?', steps)).toBe(
      [
        'Set up package checklists for Acme?',
        '',
        'Reconciliations with Review -> link "Quarterly Reconciliations with Review - Quarterly"',
        'Transactions -> create',
        'Reports -> create',
        '',
        'A checklist the client already has is linked, not copied.',
      ].join('\n'),
    )
  })

  it('keeps the apply sentence as it was when nothing is linked', () => {
    const text = applyPackageConfirmText({
      packageName: 'Full service',
      clientName: 'Acme',
      addedPlanNames: [],
      newChecklistTitles: [],
      skippedCount: 0,
    })
    expect(text).toContain('This package has no checklists attached yet, so none are created.')
    expect(text).not.toContain('Links')
  })
})
