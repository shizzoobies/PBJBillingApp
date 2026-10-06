import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanChecklistsBody } from '../pages/ClientDetailPage'
import type { AppContextValue } from '../AppContext'
import type {
  AppData,
  ChecklistTemplate,
  Client,
  Package,
  SubscriptionPlan,
} from '../lib/types'

/**
 * THE "PLAN CHECKLISTS" PANEL, GROUPED BY PACKAGE (featreq-3ce2d75d).
 *
 * Brittany moved 1969 Beach from four individual plans to the "Quarterly
 * Accounting" package and still saw one group per plan - with the same
 * checklist twice, because two of the plans point at one template. A package is
 * not stored on the client; it COVERS a client when every one of its plans is
 * on the client, and a covered plan folds into the package's own group.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listPackagesRequest: (...args: unknown[]) => listPackagesRequest(...args),
}))

let listPackagesRequest = vi.fn()
let contextValue: AppContextValue
let addChecklistTemplate = vi.fn()

const plan = (id: string, name: string, templateIds: string[]): SubscriptionPlan => ({
  id,
  name,
  notes: '',
  templateIds,
})

const blueprint = (id: string, title: string): ChecklistTemplate =>
  ({ id, title, clientId: '', frequency: 'monthly', isStandard: true, stages: [] }) as
    unknown as ChecklistTemplate

const clientCopy = (id: string, sourceTemplateId: string, title: string): ChecklistTemplate =>
  ({
    id,
    title,
    clientId: 'c1',
    frequency: 'monthly',
    isStandard: false,
    sourceTemplateId,
    stages: [],
  }) as unknown as ChecklistTemplate

const pkg = (id: string, name: string, planIds: string[], templateIds: string[]): Package => ({
  id,
  name,
  description: '',
  planIds,
  templateIds,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: null,
})

const PLANS = [
  plan('A', 'Plan A', ['T1']),
  plan('B', 'Plan B', ['T1', 'T2']),
  plan('C', 'Plan C', ['T2']),
  plan('D', 'Plan D', []),
  plan('E', 'Plan E', ['T3']),
]
const TEMPLATES = [
  blueprint('T1', 'Monthly close'),
  blueprint('T2', 'Quarterly review'),
  blueprint('T3', 'Sales tax filing'),
]
const P = pkg('P', 'Quarterly Accounting', ['A', 'B', 'C', 'D'], ['T1', 'T2'])

function renderPanel(planIds: string[], templates: ChecklistTemplate[] = TEMPLATES) {
  const client = { id: 'c1', name: 'Acme', planIds } as Client
  const data = { plans: PLANS, clients: [client], checklistTemplates: templates } as unknown as AppData
  contextValue = { ownerMode: true, data, addChecklistTemplate } as unknown as AppContextValue
  return render(<PlanChecklistsBody client={client} data={data} />)
}

const groupHeadings = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.plan-checklists-head > strong')).map(
    (node) => node.textContent,
  )

beforeEach(() => {
  listPackagesRequest = vi.fn(async () => [P])
  addChecklistTemplate = vi.fn()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Plan checklists grouped by package', () => {
  it('shows one package group, with its checklists once, when the package covers every plan', async () => {
    const { container } = renderPanel(['A', 'B', 'C', 'D'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting'])
    expect(screen.getByText('Package')).toBeTruthy()
    expect(screen.getAllByText('Monthly close')).toHaveLength(1)
    expect(screen.getAllByText('Quarterly review')).toHaveLength(1)
    expect(screen.queryByText('Plan A')).toBeNull()
    expect(screen.queryByText('Plan B')).toBeNull()
  })

  it('keeps today\'s per-plan groups when the package needs a plan the client lacks', async () => {
    const { container } = renderPanel(['A', 'B', 'C'])

    await waitFor(() => expect(listPackagesRequest).toHaveBeenCalled())
    await screen.findByText('Plan A')
    expect(groupHeadings(container)).toEqual(['Plan A', 'Plan B', 'Plan C'])
    expect(screen.queryByText('Quarterly Accounting')).toBeNull()
    expect(screen.queryByText('Package')).toBeNull()
  })

  it('renders the package group, then the group of a plan no package covers', async () => {
    const { container } = renderPanel(['E', 'A', 'B', 'C', 'D'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting', 'Plan E'])
  })

  it('sets up only the missing package checklists', async () => {
    const templates = [...TEMPLATES, clientCopy('c1-t1', 'T1', 'Monthly close')]
    renderPanel(['A', 'B', 'C', 'D'], templates)

    const button = await screen.findByRole('button', { name: /Set up package checklists \(1\)/ })
    fireEvent.click(button)

    expect(addChecklistTemplate).toHaveBeenCalledTimes(1)
    expect(addChecklistTemplate.mock.calls[0][0]).toMatchObject({
      clientId: 'c1',
      sourceTemplateId: 'T2',
      title: 'Quarterly review',
    })
  })

  it('marks each package checklist Set up or Not set up', async () => {
    const templates = [...TEMPLATES, clientCopy('c1-t1', 'T1', 'Monthly close')]
    const { container } = renderPanel(['A', 'B', 'C', 'D'], templates)

    await screen.findByText('Quarterly Accounting')
    const rows = Array.from(container.querySelectorAll('.plan-checklists-row'))
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Set up')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText('Not set up')).toBeTruthy()
  })
})
