import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
let updateChecklistTemplate = vi.fn()

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
  plan('F', 'Plan F', ['T1', 'T3']),
]
const TEMPLATES = [
  blueprint('T1', 'Monthly close'),
  blueprint('T2', 'Quarterly review'),
  blueprint('T3', 'Sales tax filing'),
  blueprint('T9', 'Extra duties'),
]
const P = pkg('P', 'Quarterly Accounting', ['A', 'B', 'C', 'D'], ['T1', 'T2'])

function renderPanel(planIds: string[], templates: ChecklistTemplate[] = TEMPLATES) {
  const element = (ids: string[], checklistTemplates: ChecklistTemplate[] = templates) => {
    const client = { id: 'c1', name: 'Acme', planIds: ids } as Client
    const data = {
      plans: PLANS,
      clients: [client],
      checklistTemplates,
    } as unknown as AppData
    contextValue = {
      ownerMode: true,
      data,
      addChecklistTemplate,
      updateChecklistTemplate,
    } as unknown as AppContextValue
    return <PlanChecklistsBody client={client} data={data} />
  }
  const view = render(element(planIds))
  // The same mounted panel, handed a different plan list - what "+ Add package"
  // does to the client page.
  const rerenderWith = (ids: string[]) => view.rerender(element(ids))
  // The same panel after a workspace edit (a link) changed the templates.
  const rerenderTemplates = (next: ChecklistTemplate[]) => view.rerender(element(planIds, next))
  return { container: view.container, rerenderWith, rerenderTemplates }
}

/** Let the panel's one packages fetch settle and React apply the result. */
const flushPackages = () =>
  act(async () => {
    await vi.mocked(listPackagesRequest).mock.results[0].value.catch(() => undefined)
  })

const groupHeadings = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.plan-checklists-head > strong')).map(
    (node) => node.textContent,
  )

beforeEach(() => {
  listPackagesRequest = vi.fn(async () => [P])
  addChecklistTemplate = vi.fn()
  updateChecklistTemplate = vi.fn()
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

  it('keeps per-plan groups while a package needs a plan the client lacks, and regroups once it has it', async () => {
    const { container, rerenderWith } = renderPanel(['A', 'B', 'C'])
    await flushPackages()

    expect(groupHeadings(container)).toEqual(['Plan A', 'Plan B', 'Plan C'])
    expect(screen.queryByText('Quarterly Accounting')).toBeNull()
    expect(screen.queryByText('Package')).toBeNull()

    // "+ Add package" unions Plan D into the client; the same panel regroups.
    rerenderWith(['A', 'B', 'C', 'D'])
    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting'])
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

  it("brings exactly the package's own checklists, nothing a covered plan bundles beyond them", async () => {
    // 1969 Beach: the package's set is two checklists; Plan E (covered) bundles
    // a third (T3) the package leaves out. Only the package's two come over: no
    // group for Plan E, no Sales tax row, no extra Set up button
    // (featreq-8bdc5ec5 send-back).
    listPackagesRequest = vi.fn(async () => [pkg('P2', 'Quarterly Accounting', ['A', 'B', 'E'], ['T1', 'T2'])])
    const { container } = renderPanel(['A', 'B', 'E'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting'])
    const [packageGroup] = Array.from(container.querySelectorAll('.plan-checklists-group'))
    expect(within(packageGroup as HTMLElement).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('Sales tax filing')).toBeNull()
    expect(screen.queryByRole('button', { name: /Set up plan checklists/ })).toBeNull()
    expect(screen.getAllByText('Monthly close')).toHaveLength(1)
    expect(screen.getAllByText('Quarterly review')).toHaveLength(1)
  })

  it("brings an additional plan outside the package with its own checklist and a Set up button", async () => {
    // Plan E is NOT in the package (A-D): it is an additional plan, so its own
    // checklist (T3) is offered in a group of its own.
    const { container } = renderPanel(['A', 'B', 'C', 'D', 'E'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting', 'Plan E'])
    const [, planGroup] = Array.from(container.querySelectorAll('.plan-checklists-group'))
    expect(within(planGroup as HTMLElement).getByText('Sales tax filing')).toBeTruthy()
    expect(within(planGroup as HTMLElement).getByText('Not set up')).toBeTruthy()

    fireEvent.click(within(planGroup as HTMLElement).getByRole('button', { name: /Set up plan checklists \(1\)/ }))
    expect(addChecklistTemplate).toHaveBeenCalledTimes(1)
    expect(addChecklistTemplate.mock.calls[0][0]).toMatchObject({
      clientId: 'c1',
      sourceTemplateId: 'T3',
      title: 'Sales tax filing',
    })
  })

  it('gives a covered plan with nothing left over no group at all', async () => {
    // Plans A-D are covered by the package and every checklist they bundle is in
    // the package's set (Plan D bundles none): one group, no "listed above" lines.
    const { container } = renderPanel(['A', 'B', 'C', 'D'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting'])
    expect(screen.queryByText('Its checklists are listed above.')).toBeNull()
    expect(screen.queryByText(/No checklists are bundled/)).toBeNull()
  })

  it('shows a checklist once when a package and an uncovered plan both carry it', async () => {
    const { container } = renderPanel(['A', 'B', 'C', 'D', 'F'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting', 'Plan F'])
    expect(screen.getAllByText('Monthly close')).toHaveLength(1)
    expect(screen.getAllByText('Sales tax filing')).toHaveLength(1)
  })

  it('does not render a package whose plans are a strict subset of another covering package', async () => {
    listPackagesRequest = vi.fn(async () => [
      pkg('P2', 'Aardvark pair', ['A', 'B'], ['T1']),
      P,
    ])
    const { container } = renderPanel(['A', 'B', 'C', 'D'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting'])
    expect(screen.queryByText('Aardvark pair')).toBeNull()
  })

  it("keeps a checklist that lives only in a dropped subset package's own set", async () => {
    // T9 is in no plan; only the smaller package lists it.
    listPackagesRequest = vi.fn(async () => [
      pkg('P2', 'Aardvark pair', ['A', 'B'], ['T9']),
      P,
    ])
    const { container } = renderPanel(['A', 'B', 'C', 'D'])

    await screen.findByText('Quarterly Accounting')
    expect(groupHeadings(container)).toEqual(['Quarterly Accounting'])
    expect(screen.getAllByText('Extra duties')).toHaveLength(1)
    expect(screen.getAllByText('Monthly close')).toHaveLength(1)
  })

  it('says the checklists are listed above when overlapping packages leave a later group nothing new', async () => {
    listPackagesRequest = vi.fn(async () => [
      pkg('Pa', 'Alpha', ['A', 'B'], ['T1']),
      pkg('Pb', 'Beta', ['B', 'C'], ['T1']),
    ])
    const { container } = renderPanel(['A', 'B', 'C'])

    await screen.findByText('Alpha')
    // Plan B (covered) bundles Quarterly review, which neither package lists:
    // it brings nothing beyond the packages' sets (featreq-8bdc5ec5).
    expect(groupHeadings(container)).toEqual(['Alpha', 'Beta'])
    expect(screen.getAllByText('Monthly close')).toHaveLength(1)
    expect(screen.queryByText('Quarterly review')).toBeNull()
    expect(screen.getByText('Its checklists are listed above.')).toBeTruthy()
    expect(screen.queryByText(/No checklists are bundled/)).toBeNull()
  })

  it('collapses packages with identical plans into one group, first by name, keeping every checklist', async () => {
    listPackagesRequest = vi.fn(async () => [
      P,
      pkg('P2', 'Aardvark copy', ['D', 'C', 'B', 'A'], ['T9']),
    ])
    const { container } = renderPanel(['A', 'B', 'C', 'D'])

    await screen.findByText('Aardvark copy')
    expect(groupHeadings(container)).toEqual(['Aardvark copy'])
    expect(screen.getAllByText('Extra duties')).toHaveLength(1)
    expect(screen.getAllByText('Monthly close')).toHaveLength(1)
    expect(screen.getAllByText('Quarterly review')).toHaveLength(1)
  })

  it('paints nothing until the packages fetch settles, then falls back to plans if it fails', async () => {
    let reject: (reason: Error) => void = () => undefined
    listPackagesRequest = vi.fn(
      () =>
        new Promise<Package[]>((_resolve, rej) => {
          reject = rej
        }),
    )
    const { container } = renderPanel(['A', 'B', 'C', 'D'])

    expect(container.querySelector('.plan-checklists-group')).toBeNull()
    expect(screen.queryByText('Plan A')).toBeNull()

    await act(async () => {
      reject(new Error('offline'))
      await Promise.resolve()
    })
    expect(groupHeadings(container)).toEqual(['Plan A', 'Plan B', 'Plan C', 'Plan D'])
  })
})

/**
 * "Link existing" (featreq-2b067744): her hand-made "Quarterly Reconciliations
 * with Review" IS the blueprint "Reconciliations with Review". Linking stamps
 * her checklist with the blueprint, the row flips to Set up, and Set up/Apply
 * skip it from then on.
 */
describe('Link existing on a Not set up row', () => {
  const REC = blueprint('T7', 'Reconciliations with Review')
  const PLAIN = blueprint('T8', 'Monthly Reconciliations')
  const hers = (id: string, title: string, over: Partial<ChecklistTemplate> = {}): ChecklistTemplate =>
    ({
      id,
      title,
      clientId: 'c1',
      frequency: 'quarterly',
      isStandard: false,
      stages: [],
      ...over,
    }) as unknown as ChecklistTemplate

  const linkTemplates = () => [
    ...TEMPLATES,
    REC,
    PLAIN,
    hers('h1', 'Quarterly Reconciliations with Review'),
    hers('h2', 'Payroll odds and ends'),
    // Never offered: another client's, and one already linked to a blueprint.
    hers('x1', 'Quarterly Reconciliations with Review', { clientId: 'c2' }),
    hers('x2', 'Annual Reconciliations with Review', { sourceTemplateId: 'T1' }),
  ]

  beforeEach(() => {
    listPackagesRequest = vi.fn(async () => [pkg('P7', 'Quarterly Accounting', ['D'], ['T7', 'T8'])])
  })

  it('offers her same-name checklist, links it on a press, and the row flips to Set up', async () => {
    const templates = linkTemplates()
    const { container, rerenderTemplates } = renderPanel(['D'], templates)
    await screen.findByText('Quarterly Accounting')

    expect(screen.getAllByRole('button', { name: /^Link (?!the chosen).* as Reconciliations with Review$/ })).toHaveLength(1)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Link Quarterly Reconciliations with Review as Reconciliations with Review',
      }),
    )
    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
    const [linkedId, updater] = updateChecklistTemplate.mock.calls[0]
    expect(linkedId).toBe('h1')
    const linked = updater(templates.find((t) => t.id === 'h1'))
    expect(linked).toMatchObject({ id: 'h1', title: 'Quarterly Reconciliations with Review', sourceTemplateId: 'T7' })

    // The workspace now holds the stamped checklist: Set up, and nothing to clone for it.
    rerenderTemplates(templates.map((t) => (t.id === 'h1' ? linked : t)))
    const rows = Array.from(container.querySelectorAll('.plan-checklists-row'))
    expect(within(rows[0] as HTMLElement).getByText('Set up')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Set up package checklists \(1\)/ }))
    expect(addChecklistTemplate).toHaveBeenCalledTimes(1)
    expect(addChecklistTemplate.mock.calls[0][0]).toMatchObject({ sourceTemplateId: 'T8' })
  })

  it("lists only this client's unstamped checklists to choose from, and links the chosen one", async () => {
    renderPanel(['D'], linkTemplates())
    await screen.findByText('Quarterly Accounting')

    const select = screen.getByRole('combobox', { name: 'Choose a checklist to link as Reconciliations with Review' })
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    // The suggested one has its own button; the others are in the list.
    expect(options).toEqual(['Choose another…', 'Payroll odds and ends · Quarterly'])

    fireEvent.change(select, { target: { value: 'h2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link the chosen checklist as Reconciliations with Review' }))
    expect(updateChecklistTemplate).toHaveBeenCalledTimes(1)
    expect(updateChecklistTemplate.mock.calls[0][0]).toBe('h2')
  })

  it('does not suggest "Monthly Reconciliations with Review" for "Monthly Reconciliations"', async () => {
    renderPanel(['D'], [...linkTemplates(), hers('h3', 'Monthly Reconciliations with Review')])
    await screen.findByText('Quarterly Accounting')

    expect(screen.queryAllByRole('button', { name: /^Link (?!the chosen).* as Monthly Reconciliations$/ })).toEqual([])
    const select = screen.getByRole('combobox', { name: 'Choose a checklist to link as Monthly Reconciliations' })
    expect(within(select).getByRole('option', { name: 'Monthly Reconciliations with Review · Quarterly' })).toBeTruthy()
  })
  it('labels every choice with how often it repeats, and a switched-off one "(off)" - never a one-press suggestion', async () => {
    renderPanel(['D'], [...linkTemplates(), hers('h4', 'Annual Reconciliations with Review', { frequency: 'annually', active: false })])
    await screen.findByText('Quarterly Accounting')

    expect(screen.queryByRole('button', { name: 'Link Annual Reconciliations with Review as Reconciliations with Review' })).toBeNull()
    const select = screen.getByRole('combobox', { name: 'Choose a checklist to link as Reconciliations with Review' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose another…',
      'Annual Reconciliations with Review · Annually (off)',
      'Payroll odds and ends · Quarterly',
    ])
  })

  it('does not link a pick that has left the list since it was chosen', async () => {
    const templates = [...linkTemplates(), hers('h5', 'Bank feeds')]
    const { rerenderTemplates } = renderPanel(['D'], templates)
    await screen.findByText('Quarterly Accounting')

    const select = screen.getByRole('combobox', { name: 'Choose a checklist to link as Reconciliations with Review' })
    fireEvent.change(select, { target: { value: 'h2' } })
    // Meanwhile h2 was linked to another blueprint (a stamp on a live blueprint).
    rerenderTemplates(templates.map((t) => (t.id === 'h2' ? { ...t, sourceTemplateId: 'T1' } : t)))
    const link = screen.getByRole('button', { name: 'Link the chosen checklist as Reconciliations with Review' })
    expect((link as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(link)
    expect(updateChecklistTemplate).not.toHaveBeenCalled()
  })
})
