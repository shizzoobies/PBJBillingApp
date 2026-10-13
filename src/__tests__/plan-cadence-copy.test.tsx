import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanChecklistsBody, PlanServicesField } from '../pages/ClientDetailPage'
import { cloneChecklistTemplate, planCadenceFor } from '../lib/cloneChecklistTemplate'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistTemplate, Client, SubscriptionPlan } from '../lib/types'

/**
 * Plan cadence part 2 in the browser (featreq-acdd0c84, stages B2 + B3).
 *
 * B2: a client copy the browser makes from a plan ("Set up plan checklists", the
 * plan picker's "Also set up these checklists", the To 100% Fix) follows the
 * plan's "How often". B3: an owner sees "Match plan: <cadence>" on a copy whose
 * schedule differs, and pressing it asks the server to re-sync that copy.
 *
 * Today is pinned to 2026-10-13 (local noon) so the floors are exact.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listPackagesRequest: (...args: unknown[]) => listPackagesRequest(...args),
}))

let listPackagesRequest = vi.fn()
let contextValue: AppContextValue
let addChecklistTemplate = vi.fn()
let matchTemplateToPlanCadence = vi.fn()

const blueprint = (id: string, title: string, over: Partial<ChecklistTemplate> = {}): ChecklistTemplate => ({
  id,
  title,
  clientId: '',
  assigneeId: '',
  frequency: 'monthly',
  nextDueDate: '2026-01-15',
  active: false,
  isStandard: true,
  viewerIds: [],
  editorIds: [],
  stages: [],
  ...over,
})

const clientCopy = (id: string, sourceTemplateId: string, over: Partial<ChecklistTemplate> = {}) =>
  blueprint(id, `${sourceTemplateId} copy`, {
    clientId: 'c1',
    isStandard: false,
    active: true,
    sourceTemplateId,
    nextDueDate: '2026-11-15',
    ...over,
  })

const plan = (id: string, name: string, templateIds: string[], cadence?: SubscriptionPlan['cadence']) =>
  ({ id, name, notes: '', templateIds, ...(cadence ? { cadence } : {}) }) as SubscriptionPlan

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 13, 12, 0, 0))
  listPackagesRequest = vi.fn(async () => [])
  addChecklistTemplate = vi.fn()
  matchTemplateToPlanCadence = vi.fn(async () => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('cloneChecklistTemplate with a plan cadence', () => {
  const source = blueprint('bp', 'Monthly books')

  it('quarterly: specific-months Jan/Apr/Jul/Oct, first due on or after today in one of them', () => {
    expect(cloneChecklistTemplate(source, { clientId: 'c1', active: true, cadence: 'quarterly' })).toMatchObject({
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      dueDayOfMonth: 15,
      nextDueDate: '2026-10-15',
      sourceTemplateId: 'bp',
    })
  })

  it("annual: a specific-months blueprint's first month, else January (never a stale next due date)", () => {
    expect(
      cloneChecklistTemplate(blueprint('bp', 'Tax', { frequency: 'specific-months', scheduledMonths: [9, 4], dueDayOfMonth: 15 }), {
        clientId: 'c1',
        active: true,
        cadence: 'annual',
      }),
    ).toMatchObject({ frequency: 'specific-months', scheduledMonths: [4], nextDueDate: '2027-04-15', repeatAnnually: true })
    expect(
      cloneChecklistTemplate(blueprint('bp', 'Tax', { nextDueDate: '2026-04-30' }), { clientId: 'c1', active: true, cadence: 'annual' }),
    ).toMatchObject({ frequency: 'specific-months', scheduledMonths: [1], nextDueDate: '2027-01-30' })
  })

  it('quarterly and yearly copies repeat every year even from a one-year blueprint', () => {
    const once = blueprint('bp', 'Once', { frequency: 'specific-months', scheduledMonths: [10], repeatAnnually: false, scheduleYear: 2025 })
    expect(cloneChecklistTemplate(once, { clientId: 'c1', active: true, cadence: 'quarterly' }).repeatAnnually).toBe(true)
    expect(cloneChecklistTemplate(once, { clientId: 'c1', active: true }).repeatAnnually).toBe(false)
  })

  it('weekly and monthly set the frequency and floor the date by it', () => {
    const weekly = cloneChecklistTemplate(blueprint('bp', 'Payroll', { nextDueDate: '2026-06-30' }), {
      clientId: 'c1',
      active: true,
      cadence: 'weekly',
    })
    expect(weekly).toMatchObject({ frequency: 'weekly', nextDueDate: '2026-10-13' })
    expect(cloneChecklistTemplate(source, { clientId: 'c1', active: true, cadence: 'monthly' })).toMatchObject({
      frequency: 'monthly',
      nextDueDate: '2026-10-15',
    })
  })

  it("'blueprint', null and no cadence copy exactly as before", () => {
    const before = cloneChecklistTemplate(source, { clientId: 'c1', active: true })
    for (const cadence of ['blueprint', null] as const) {
      const copy = cloneChecklistTemplate(source, { clientId: 'c1', active: true, cadence })
      expect({ ...copy, stages: [] }).toEqual({ ...before, stages: [] })
    }
    expect(before).toMatchObject({ frequency: 'monthly', nextDueDate: '2026-10-15' })
    expect(before.scheduledMonths).toBeUndefined()
  })

  it('planCadenceFor: the first given plan that bundles it, its name suffix counting', () => {
    const plans = [plan('p1', 'Books - Weekly', ['bp']), plan('p2', 'Other', ['bp'], 'quarterly')]
    expect(planCadenceFor('bp', plans)).toBe('weekly')
    expect(planCadenceFor('bp', [...plans].reverse())).toBe('quarterly')
    expect(planCadenceFor('nope', plans)).toBeNull()
    expect(planCadenceFor('bp', [undefined])).toBeNull()
  })
})

function renderPanel({
  plans,
  templates,
  ownerMode = true,
}: {
  plans: SubscriptionPlan[]
  templates: ChecklistTemplate[]
  ownerMode?: boolean
}) {
  const client = { id: 'c1', name: 'Acme', planIds: plans.map((p) => p.id) } as Client
  const data = { plans, clients: [client], checklistTemplates: templates } as unknown as AppData
  contextValue = {
    ownerMode,
    data,
    addChecklistTemplate,
    updateChecklistTemplate: vi.fn(),
    matchTemplateToPlanCadence,
  } as unknown as AppContextValue
  return render(<PlanChecklistsBody client={client} data={data} />)
}

const flush = () => act(async () => {})

describe('Plan checklists: Set up follows the plan', () => {
  it("clones a missing checklist on the plan's quarterly schedule", async () => {
    renderPanel({ plans: [plan('Q', 'Accounting', ['bp'], 'quarterly')], templates: [blueprint('bp', 'Monthly books')] })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Set up plan checklists \(1\)/ }))
    expect(addChecklistTemplate).toHaveBeenCalledTimes(1)
    expect(addChecklistTemplate.mock.calls[0][0]).toMatchObject({
      sourceTemplateId: 'bp',
      frequency: 'specific-months',
      scheduledMonths: [1, 4, 7, 10],
      nextDueDate: '2026-10-15',
    })
  })
})

describe('Plan checklists: Match plan', () => {
  const quarterly = plan('Q', 'Accounting', ['bp'], 'quarterly')

  it('shows "Match plan: Quarterly" on a copy whose schedule differs, and pressing it asks the server', async () => {
    renderPanel({ plans: [quarterly], templates: [blueprint('bp', 'Monthly books'), clientCopy('copy-1', 'bp')] })
    await flush()
    const button = screen.getByRole('button', { name: 'Match plan: Quarterly' })
    expect(button.getAttribute('title')).toBe(
      'Change this checklist to run quarterly like its plan. The schedule restarts from today (past months are not generated); nothing already generated changes.',
    )
    await act(async () => {
      fireEvent.click(button)
    })
    expect(matchTemplateToPlanCadence).toHaveBeenCalledWith('copy-1', 'Q')
  })

  it('is not offered once the copy already runs on the plan schedule (months compared as sets)', async () => {
    renderPanel({
      plans: [quarterly],
      templates: [
        blueprint('bp', 'Monthly books'),
        clientCopy('copy-1', 'bp', { frequency: 'specific-months', scheduledMonths: [10, 7, 4, 1] }),
      ],
    })
    await flush()
    expect(screen.queryByRole('button', { name: /Match plan/ })).toBeNull()
  })

  it("is not offered for a plan that uses each checklist's own schedule", async () => {
    renderPanel({
      plans: [plan('B', 'Bookkeeping', ['bp'])],
      templates: [blueprint('bp', 'Monthly books'), clientCopy('copy-1', 'bp', { frequency: 'weekly' })],
    })
    await flush()
    expect(screen.queryByRole('button', { name: /Match plan/ })).toBeNull()
  })

  it('names the plan cadence: weekly and yearly', async () => {
    renderPanel({
      plans: [plan('W', 'Payroll - Weekly', ['bp']), plan('Y', 'Taxes - Yearly', ['bp2'])],
      templates: [
        blueprint('bp', 'Payroll'),
        blueprint('bp2', 'Tax return', { frequency: 'specific-months', scheduledMonths: [4] }),
        clientCopy('copy-1', 'bp'),
        clientCopy('copy-2', 'bp2', { frequency: 'specific-months', scheduledMonths: [3] }),
      ],
    })
    await flush()
    expect(screen.getByRole('button', { name: 'Match plan: Weekly' }).getAttribute('title')).toBe(
      'Change this checklist to run weekly like its plan. Future due dates move; nothing already generated changes.',
    )
    // Yearly runs in the blueprint's April, so a March copy differs.
    expect(screen.getByRole('button', { name: 'Match plan: Yearly' })).toBeTruthy()
  })

  it('is never shown to a non-owner', async () => {
    renderPanel({
      plans: [quarterly],
      templates: [blueprint('bp', 'Monthly books'), clientCopy('copy-1', 'bp')],
      ownerMode: false,
    })
    await flush()
    expect(screen.queryByRole('button', { name: /Match plan/ })).toBeNull()
  })
})

describe('the plan picker sets up the new plan checklists on its How often', () => {
  it("adding a weekly plan clones its checklist weekly", async () => {
    const plans = [plan('W', 'Payroll - Weekly', ['bp'])]
    const client = { id: 'c1', name: 'Acme', planIds: [] } as unknown as Client
    contextValue = {
      ownerMode: true,
      data: { plans, clients: [client], checklistTemplates: [blueprint('bp', 'Payroll', { nextDueDate: '2026-06-30' })] },
      addChecklistTemplate,
    } as unknown as AppContextValue
    vi.stubGlobal('confirm', vi.fn(() => true))
    render(<PlanServicesField client={client} plans={plans} onCommit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add plan / service' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Payroll - Weekly' }))
    expect(addChecklistTemplate).toHaveBeenCalledTimes(1)
    expect(addChecklistTemplate.mock.calls[0][0]).toMatchObject({
      sourceTemplateId: 'bp',
      frequency: 'weekly',
      nextDueDate: '2026-10-13',
    })
  })
})
