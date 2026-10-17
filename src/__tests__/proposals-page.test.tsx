import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import { ProposalEditorPage } from '../pages/ProposalEditorPage'
import { ProposalsPage } from '../pages/ProposalsPage'
import { proposalDeliveryBadge, staleLetterFigureCount } from '../lib/proposals'
import { ApiError, type Client, type Proposal, type SubscriptionPlan } from '../lib/types'

/** A promise plus its own `resolve`, for pinning a mock's response in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Proposals in the UI (featreq-311473e2 / featreq-ef18a38e). The server
 * prices everything; these pin what the pages ask it for and what they show.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listProposalsRequest: (...args: unknown[]) => api.listProposalsRequest(...args),
  createProposalRequest: (...args: unknown[]) => api.createProposalRequest(...args),
  getProposalRequest: (...args: unknown[]) => api.getProposalRequest(...args),
  listEngagementsRequest: (...args: unknown[]) => api.listEngagementsRequest(...args),
  draftProposalEngagementRequest: (...args: unknown[]) => api.draftProposalEngagementRequest(...args),
  fetchFirmSettings: (...args: unknown[]) => api.fetchFirmSettings(...args),
  updateProposalRequest: (...args: unknown[]) => api.updateProposalRequest(...args),
  repriceProposalRequest: (...args: unknown[]) => api.repriceProposalRequest(...args),
  copyProposalRequest: (...args: unknown[]) => api.copyProposalRequest(...args),
  deleteProposalRequest: (...args: unknown[]) => api.deleteProposalRequest(...args),
  draftProposalLetterRequest: (...args: unknown[]) => api.draftProposalLetterRequest(...args),
  sendProposalRequest: (...args: unknown[]) => api.sendProposalRequest(...args),
  listPackagesRequest: (...args: unknown[]) => api.listPackagesRequest(...args),
  acceptProposalRequest: (...args: unknown[]) => api.acceptProposalRequest(...args),
  declineProposalRequest: (...args: unknown[]) => api.declineProposalRequest(...args),
  proposalChatRequest: (...args: unknown[]) => api.proposalChatRequest(...args),
  listQuestionnairesRequest: (...args: unknown[]) => api.listQuestionnairesRequest(...args),
  createQuestionnaireRequest: (...args: unknown[]) => api.createQuestionnaireRequest(...args),
  saveQuestionnaireAnswersRequest: (...args: unknown[]) =>
    api.saveQuestionnaireAnswersRequest(...args),
  submitQuestionnaireRequest: (...args: unknown[]) => api.submitQuestionnaireRequest(...args),
  startQuestionnaireDraftRequest: (...args: unknown[]) => api.startQuestionnaireDraftRequest(...args),
  withdrawQuestionnaireRequest: (...args: unknown[]) => api.withdrawQuestionnaireRequest(...args),
  sendQuestionnaireRequest: (...args: unknown[]) => api.sendQuestionnaireRequest(...args),
  renewQuestionnaireLinkRequest: (...args: unknown[]) => api.renewQuestionnaireLinkRequest(...args),
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const PROPOSAL: Proposal = {
  id: 'prop-1',
  status: 'draft',
  prospect: {
    company: 'Acme Books',
    contactName: 'Pat Doe',
    title: '',
    email: 'pat@acme.test',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    notes: '',
  },
  clientId: null,
  inputs: { transactions: 120 },
  selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
  pricingSnapshot: {
    rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    lines: [
      {
        serviceId: 'monthly-weekly-transactions-basic',
        group: 'Monthly',
        name: 'Weekly transactions',
        tier: 'Basic',
        cadence: null,
        amount: 630,
        computedAmount: 630,
        formula: '120 transactions x 0.07 x $75/hr = $630.00',
        flag: null,
      },
    ],
    totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0 },
    catalogAt: '2026-09-23T12:00:00.000Z',
  },
  letter: null,
  letterAt: null,
  messages: [],
  emailLog: [],
  sentAt: null,
  acceptedAt: null,
  declinedAt: null,
  declineNote: null,
  copiedFromId: null,
  createdBy: 'emp-patrice',
  createdAt: '2026-09-23T12:00:00.000Z',
  updatedAt: '2026-09-23T12:00:00.000Z',
}

const DECLINED: Proposal = {
  ...PROPOSAL,
  id: 'prop-2',
  status: 'declined',
  prospect: { ...PROPOSAL.prospect, company: 'Beta Farms', contactName: 'Lee' },
}

/** What the server answers once Reconciliations is picked: re-priced, not computed here. */
const WITH_RECONCILIATIONS: Proposal = {
  ...PROPOSAL,
  selections: [...PROPOSAL.selections, { serviceId: 'reconciliations' }],
  pricingSnapshot: {
    ...PROPOSAL.pricingSnapshot!,
    lines: [
      ...PROPOSAL.pricingSnapshot!.lines,
      {
        serviceId: 'reconciliations',
        group: 'Reconciliations',
        name: 'Reconciliations',
        tier: null,
        cadence: null,
        amount: 375,
        computedAmount: 375,
        formula: '20 balance sheet accounts x 0.25 x $75/hr = $375.00',
        flag: null,
      },
    ],
    totals: { monthly: 1005, annual: 0, oneTime: 0, cleanup: 0 },
  },
}

/** A second line whose count is only asked on a call: $0, no flag - not yet priced. */
const PARTLY_PRICED: Proposal = {
  ...WITH_RECONCILIATIONS,
  pricingSnapshot: {
    ...WITH_RECONCILIATIONS.pricingSnapshot!,
    lines: [
      WITH_RECONCILIATIONS.pricingSnapshot!.lines[0],
      {
        ...WITH_RECONCILIATIONS.pricingSnapshot!.lines[1],
        amount: 0,
        computedAmount: 0,
        formula: '0 balance sheet accounts x 0.25 x $75/hr = $0.00',
      },
    ],
    totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0 },
  },
}

/** The Basic tier retired out from under a proposal that already selected it (review I2). */
const RETIRED_TIER_PRICING = {
  ...defaultProposalPricing(),
  rates: { bookkeeper: 75, accountant: 115, controller: 125 },
  services: defaultProposalPricing().services.map((service) =>
    service.id === 'monthly-weekly-transactions-basic' ? { ...service, active: false } : service,
  ),
}

const RETIRED_TIER_PROPOSAL: Proposal = {
  ...PROPOSAL,
  id: 'prop-3',
  pricingSnapshot: {
    ...PROPOSAL.pricingSnapshot!,
    lines: [
      {
        ...PROPOSAL.pricingSnapshot!.lines[0],
        amount: 0,
        computedAmount: 0,
        formula: 'This service is retired - priced at $0.00',
        flag: 'retired',
      },
    ],
    totals: { monthly: 0, annual: 0, oneTime: 0, cleanup: 0 },
  },
}

/** A selected per-count service, to prove a negative count is dropped (review M2). */
const PROPOSAL_WITH_COUNT: Proposal = {
  ...PROPOSAL,
  selections: [...PROPOSAL.selections, { serviceId: 'reports-needed-basic', quantity: 5 }],
  pricingSnapshot: {
    ...PROPOSAL.pricingSnapshot!,
    lines: [
      ...PROPOSAL.pricingSnapshot!.lines,
      {
        serviceId: 'reports-needed-basic',
        group: 'Reports',
        name: 'Reports needed',
        tier: 'Basic',
        cadence: null,
        amount: 100.8,
        computedAmount: 100.8,
        formula: '48 total accounts x 0.03 x 5 reports x $75/hr = $100.80',
        flag: null,
      },
    ],
  },
}

/** A line the catalog no longer has at all (review I3) — Remove is its only control. */
const RETIRED_LINE_PROPOSAL: Proposal = {
  ...PROPOSAL,
  id: 'prop-4',
  selections: [...PROPOSAL.selections, { serviceId: 'old-add-on' }],
  pricingSnapshot: {
    ...PROPOSAL.pricingSnapshot!,
    lines: [
      ...PROPOSAL.pricingSnapshot!.lines,
      {
        serviceId: 'old-add-on',
        group: 'Monthly',
        name: 'Old add-on',
        tier: null,
        cadence: null,
        amount: 0,
        computedAmount: 0,
        formula: 'This service is retired - priced at $0.00',
        flag: 'retired',
      },
    ],
  },
}

/** A single-checkbox (non-tiered) service the catalog retired while it was already chosen (fix batch 2, E-d). */
const RETIRED_SINGLE_PRICING = {
  ...defaultProposalPricing(),
  rates: { bookkeeper: 75, accountant: 115, controller: 125 },
  services: defaultProposalPricing().services.map((service) =>
    service.id === 'reconciliations' ? { ...service, active: false } : service,
  ),
}

const RETIRED_SINGLE_PROPOSAL: Proposal = {
  ...PROPOSAL,
  id: 'prop-5',
  selections: [...PROPOSAL.selections, { serviceId: 'reconciliations' }],
  pricingSnapshot: {
    ...PROPOSAL.pricingSnapshot!,
    lines: [
      ...PROPOSAL.pricingSnapshot!.lines,
      {
        serviceId: 'reconciliations',
        group: 'Reconciliations',
        name: 'Reconciliations',
        tier: null,
        cadence: null,
        amount: 0,
        computedAmount: 0,
        formula: 'This service is retired - priced at $0.00',
        flag: 'retired',
      },
    ],
  },
}

/** A selected flat-priced service, to prove a negative flat amount is dropped (fix batch 2, E-e). */
const PROPOSAL_WITH_FLAT_AMOUNT: Proposal = {
  ...PROPOSAL,
  selections: [...PROPOSAL.selections, { serviceId: 'payroll-setup', flatAmount: 500 }],
  pricingSnapshot: {
    ...PROPOSAL.pricingSnapshot!,
    lines: [
      ...PROPOSAL.pricingSnapshot!.lines,
      {
        serviceId: 'payroll-setup',
        group: 'Annual and one-time',
        name: 'Payroll setup',
        tier: null,
        cadence: 'one-time',
        amount: 500,
        computedAmount: 500,
        formula: 'Flat $500.00',
        flag: null,
      },
    ],
  },
}

beforeEach(() => {
  contextValue = {
    ownerMode: true,
    data: { clients: [{ id: 'client-1', name: 'Existing Co', billingMode: 'subscription' }] },
  } as unknown as AppContextValue
  api.listProposalsRequest = vi.fn(async () => [PROPOSAL, DECLINED])
  api.createProposalRequest = vi.fn(async () => ({ ...PROPOSAL, id: 'prop-new' }))
  api.getProposalRequest = vi.fn(async () => PROPOSAL)
  api.fetchFirmSettings = vi.fn(async () => ({
    name: 'PB&J',
    proposalPricing: {
      ...defaultProposalPricing(),
      rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    },
  }))
  api.updateProposalRequest = vi.fn(async () => WITH_RECONCILIATIONS)
  api.repriceProposalRequest = vi.fn(async () => PROPOSAL)
  api.copyProposalRequest = vi.fn(async () => ({ ...PROPOSAL, id: 'prop-copy' }))
  api.deleteProposalRequest = vi.fn(async () => undefined)
  api.draftProposalLetterRequest = vi.fn(async () => WITH_LETTER)
  api.sendProposalRequest = vi.fn(async () => ({ ...WITH_LETTER, status: 'sent' }))
  api.listPackagesRequest = vi.fn(async () => [
    { id: 'pkg-1', name: 'Full service', description: '', planIds: [], templateIds: [], createdAt: '', updatedAt: null },
  ])
  // Engagements stage 3: Accept creates no client - the prospect stays unlinked until signing.
  api.acceptProposalRequest = vi.fn(async () => ({
    proposal: { ...PROPOSAL, status: 'accepted', clientId: null },
    clientId: null,
    packageApplied: false,
  }))
  api.declineProposalRequest = vi.fn(async () => ({ ...PROPOSAL, status: 'declined' }))
  api.listQuestionnairesRequest = vi.fn(async () => [])
  api.listEngagementsRequest = vi.fn(async () => [])
  api.draftProposalEngagementRequest = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderList() {
  render(
    <MemoryRouter initialEntries={['/proposals']}>
      <Routes>
        <Route path="/proposals" element={<ProposalsPage />} />
        <Route path="/proposals/:proposalId" element={<p>Editor for the new draft</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderEditor(entry = '/proposals/prop-1') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/proposals" element={<p>The proposals list</p>} />
        <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('proposalDeliveryBadge (item 2 test, final fix wave round 2)', () => {
  it('picks the delivery event by its own `at`, not by append order — a late email.sent landing after a bounced still shows Bounced', () => {
    const proposal: Proposal = {
      ...PROPOSAL,
      status: 'sent',
      emailLog: [
        { kind: 'send', at: '2026-09-23T14:00:00.000Z', providerId: 're_1', to: ['pat@acme.test'], ok: true },
        {
          kind: 'delivery',
          at: '2026-09-23T14:02:00.000Z',
          providerId: 're_1',
          to: ['pat@acme.test'],
          event: 'bounced',
        },
        // Appended AFTER the bounce above, but with an EARLIER `at` — a
        // delayed `email.sent` webhook landing out of order must not
        // silently revert the badge back off Bounced.
        {
          kind: 'delivery',
          at: '2026-09-23T14:01:00.000Z',
          providerId: 're_1',
          to: ['pat@acme.test'],
          event: 'sent',
        },
      ],
    }
    expect(proposalDeliveryBadge(proposal)).toBe('Bounced')
  })
})

describe('the Proposals list', () => {
  it('shows company, contact, status and the monthly total', async () => {
    renderList()
    expect(await screen.findByText('Acme Books')).toBeTruthy()
    expect(screen.getByText('Pat Doe')).toBeTruthy()
    expect(screen.getByText('Draft', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getAllByText('$630.00').length).toBeGreaterThan(0)
  })

  it('keeps declined proposals, and filters by status', async () => {
    renderList()
    expect(await screen.findByText('Beta Farms')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'declined' } })
    expect(screen.queryByText('Acme Books')).toBeNull()
    expect(screen.getByText('Beta Farms')).toBeTruthy()
  })

  it('reads the outcomes as Won and Closed/Lost in the filter and the status pill', async () => {
    renderList()
    expect(await screen.findByText('Beta Farms')).toBeTruthy()
    const filter = screen.getByLabelText('Status filter') as HTMLSelectElement
    const options = Array.from(filter.options).map((option) => option.textContent)
    expect(options).toEqual(expect.arrayContaining(['Draft', 'Sent', 'Won', 'Closed/Lost']))
    expect(options).not.toContain('Accepted')
    expect(options).not.toContain('Declined')
    expect(screen.getByText('Closed/Lost', { selector: '.status-pill' })).toBeTruthy()
  })

  it('searches company, contact and email', async () => {
    renderList()
    await screen.findByText('Acme Books')
    fireEvent.change(screen.getByLabelText('Search proposals'), { target: { value: 'lee' } })
    expect(screen.queryByText('Acme Books')).toBeNull()
    expect(screen.getByText('Beta Farms')).toBeTruthy()
  })

  it('warns, with a link to Settings, while a catalog rate is $0', async () => {
    api.fetchFirmSettings = vi.fn(async () => ({
      name: 'PB&J',
      proposalPricing: { ...defaultProposalPricing(), rates: { bookkeeper: 75, accountant: 0, controller: 125 } },
    }))
    renderList()
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Proposal rates are not set')
    expect(within(banner).getByRole('link', { name: 'Settings > Proposal pricing' })).toBeTruthy()
  })

  it('shows no rates warning when every rate is set', async () => {
    renderList()
    await screen.findByText('Acme Books')
    await waitFor(() => expect(api.fetchFirmSettings).toHaveBeenCalled())
    expect(screen.queryByText(/Proposal rates are not set/)).toBeNull()
  })

  it('New proposal creates a draft and opens it', async () => {
    renderList()
    await screen.findByText('Acme Books')
    fireEvent.click(screen.getByRole('button', { name: 'New proposal' }))
    await waitFor(() => expect(api.createProposalRequest).toHaveBeenCalledWith({}))
    expect(await screen.findByText('Editor for the new draft')).toBeTruthy()
  })
})

describe('the proposal editor', () => {
  it('opens on the Estimate tab and moves between tabs through the URL', async () => {
    renderEditor()
    const estimate = await screen.findByRole('tab', { name: 'Estimate' })
    expect(estimate.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Letter' }))
    expect(screen.getByRole('tab', { name: 'Letter' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/No letter yet/)).toBeTruthy()
  })

  it('opens straight to a tab named in ?tab=', async () => {
    renderEditor('/proposals/prop-1?tab=activity')
    expect(await screen.findByText('What happened')).toBeTruthy()
    expect(screen.getByText('Created')).toBeTruthy()
  })

  it('shows each priced line with its formula, and the four totals', async () => {
    renderEditor()
    expect(await screen.findByText('120 transactions x 0.07 x $75/hr = $630.00')).toBeTruthy()
    expect(document.querySelector('.proposal-line-amount')?.textContent).toBe('$630.00')
    for (const label of ['Monthly fee', 'Annual fees', 'One-time fees', 'Clean-up']) {
      expect(screen.getByText(label, { selector: 'dt' })).toBeTruthy()
    }
  })

  it('trusts the server total even when it is not the sum of the lines (review M9)', async () => {
    const mismatched: Proposal = {
      ...PROPOSAL,
      pricingSnapshot: {
        ...PROPOSAL.pricingSnapshot!,
        totals: { monthly: 1234.56, annual: 0, oneTime: 0, cleanup: 0 },
      },
    }
    api.getProposalRequest = vi.fn(async () => mismatched)
    renderEditor()
    expect(await screen.findByText('$1,234.56')).toBeTruthy()
    expect(document.querySelector('.proposal-line-amount')?.textContent).toBe('$630.00')
  })

  it('picking a service saves the selection and shows the line the server priced', async () => {
    renderEditor()
    fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [
          { serviceId: 'monthly-weekly-transactions-basic' },
          { serviceId: 'reconciliations' },
        ],
      }),
    )
    expect(await screen.findByText('20 balance sheet accounts x 0.25 x $75/hr = $375.00')).toBeTruthy()
    expect(screen.getByText('$1,005.00')).toBeTruthy()
  })

  it('picking a flat service with a standard amount seeds it as the flatAmount (featreq-311473e2 pt 2)', async () => {
    api.fetchFirmSettings = vi.fn(async () => ({
      name: 'PB&J',
      proposalPricing: {
        ...defaultProposalPricing(),
        rates: { bookkeeper: 75, accountant: 115, controller: 125 },
        services: defaultProposalPricing().services.map((service) =>
          service.id === 'payroll-setup' ? { ...service, defaultAmount: 450 } : service,
        ),
      },
    }))
    renderEditor()
    fireEvent.click(await screen.findByLabelText('Annual and one-time: Payroll setup'))
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [
          { serviceId: 'monthly-weekly-transactions-basic' },
          { serviceId: 'payroll-setup', flatAmount: 450 },
        ],
      }),
    )
  })

  it('choosing another tier replaces the one that was picked', async () => {
    renderEditor()
    const row = await screen.findByRole('radiogroup', { name: 'Monthly: Weekly transactions' })
    fireEvent.click(within(row).getByLabelText('Advance'))
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [{ serviceId: 'monthly-weekly-transactions-advance' }],
      }),
    )
  })

  it('an override saves beside the computed price', async () => {
    renderEditor()
    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '600' } })
    fireEvent.blur(override)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [{ serviceId: 'monthly-weekly-transactions-basic', override: 600 }],
      }),
    )
  })

  it('clearing an override sends the selection without the override key (review M9)', async () => {
    const withOverride: Proposal = {
      ...PROPOSAL,
      selections: [{ serviceId: 'monthly-weekly-transactions-basic', override: 600 }],
    }
    api.getProposalRequest = vi.fn(async () => withOverride)
    renderEditor()
    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '' } })
    fireEvent.blur(override)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
      }),
    )
    const [, patch] = (api.updateProposalRequest as Mock).mock.calls[0]
    expect(Object.keys(patch.selections[0])).toEqual(['serviceId'])
  })

  it('a negative override is dropped rather than saved (review M2)', async () => {
    renderEditor()
    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '-50' } })
    fireEvent.blur(override)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
      }),
    )
  })

  it('a rejected negative override resets the field display, not just the save (fix batch 2, E-e)', async () => {
    renderEditor()
    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '-50' } })
    fireEvent.blur(override)
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalled())
    const refreshed = screen.getByLabelText(
      'Override Monthly: Weekly transactions Basic',
    ) as HTMLInputElement
    expect(refreshed.value).toBe('')
  })

  it('a negative flat amount is dropped rather than saved (fix batch 2, E-e)', async () => {
    api.getProposalRequest = vi.fn(async () => PROPOSAL_WITH_FLAT_AMOUNT)
    renderEditor()
    const amount = await screen.findByLabelText('Amount for Annual and one-time: Payroll setup')
    fireEvent.change(amount, { target: { value: '-200' } })
    fireEvent.blur(amount)
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalled())
    const [, patch] = (api.updateProposalRequest as Mock).mock.calls[0]
    const selection = patch.selections.find(
      (entry: { serviceId: string }) => entry.serviceId === 'payroll-setup',
    )
    expect(selection).toEqual({ serviceId: 'payroll-setup' })
  })

  it('a save queued behind a pending one still carries what the pending one produced (review C1)', async () => {
    const firstResponse = deferred<Proposal>()
    const secondResponse = deferred<Proposal>()
    api.updateProposalRequest = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
    renderEditor()

    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '600' } })
    fireEvent.blur(override)
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalledTimes(1))

    // The checkbox click is queued while the override's save is still pending.
    fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
    expect(api.updateProposalRequest).toHaveBeenCalledTimes(1)

    firstResponse.resolve({
      ...PROPOSAL,
      selections: [{ serviceId: 'monthly-weekly-transactions-basic', override: 600 }],
    })

    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalledTimes(2))
    expect(api.updateProposalRequest).toHaveBeenNthCalledWith(2, 'prop-1', {
      selections: [
        { serviceId: 'monthly-weekly-transactions-basic', override: 600 },
        { serviceId: 'reconciliations' },
      ],
    })
    secondResponse.resolve(WITH_RECONCILIATIONS)
  })

  it('a rejected save does not block the next queued save (fix batch 2, E-g)', async () => {
    api.updateProposalRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(WITH_RECONCILIATIONS)
    renderEditor()

    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '600' } })
    fireEvent.blur(override)
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('That did not save — try again.')).toBeTruthy()

    fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalledTimes(2))
    expect(api.updateProposalRequest).toHaveBeenNthCalledWith(2, 'prop-1', {
      selections: [
        { serviceId: 'monthly-weekly-transactions-basic' },
        { serviceId: 'reconciliations' },
      ],
    })
  })

  it('a reprice request goes through the same save queue, preserving order (fix batch 2, E-g)', async () => {
    const repriceResponse = deferred<Proposal>()
    api.repriceProposalRequest = vi.fn().mockReturnValueOnce(repriceResponse.promise)
    renderEditor()

    fireEvent.click(await screen.findByRole('button', { name: 'Reprice at today’s catalog' }))
    await waitFor(() => expect(api.repriceProposalRequest).toHaveBeenCalledTimes(1))

    // The checkbox click is queued while the reprice above is still pending.
    fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
    expect(api.updateProposalRequest).not.toHaveBeenCalled()

    repriceResponse.resolve(PROPOSAL)

    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        selections: [
          { serviceId: 'monthly-weekly-transactions-basic' },
          { serviceId: 'reconciliations' },
        ],
      }),
    )
  })

  it('a retired single-option service stays checked and clickable; an unchosen retired option is disabled (fix batch 2, E-d)', async () => {
    api.getProposalRequest = vi.fn(async () => RETIRED_SINGLE_PROPOSAL)
    api.fetchFirmSettings = vi.fn(async () => ({ name: 'PB&J', proposalPricing: RETIRED_SINGLE_PRICING }))
    renderEditor('/proposals/prop-5')

    const checkbox = (await screen.findByLabelText(
      'Reconciliations: Reconciliations',
    )) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(false)

    fireEvent.click(checkbox)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-5', {
        selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
      }),
    )
  })

  it('a negative count is dropped rather than saved (review M2)', async () => {
    api.getProposalRequest = vi.fn(async () => PROPOSAL_WITH_COUNT)
    renderEditor()
    const count = await screen.findByLabelText('Count for Reports: Reports needed Basic')
    fireEvent.change(count, { target: { value: '-3' } })
    fireEvent.blur(count)
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalled())
    const [, patch] = (api.updateProposalRequest as Mock).mock.calls[0]
    const selection = patch.selections.find(
      (entry: { serviceId: string }) => entry.serviceId === 'reports-needed-basic',
    )
    expect(selection).toEqual({ serviceId: 'reports-needed-basic' })
  })

  it('a count saves as a number beside the others', async () => {
    renderEditor()
    const input = await screen.findByLabelText('Balance sheet accounts')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        inputs: { transactions: 120, balanceSheetAccounts: 20 },
      }),
    )
  })

  it('reprices a draft at today’s catalog', async () => {
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Reprice at today’s catalog' }))
    await waitFor(() => expect(api.repriceProposalRequest).toHaveBeenCalledWith('prop-1'))
  })

  describe('rates that are not set (2026-10-02 incident)', () => {
    const ZERO_RATES = { bookkeeper: 0, accountant: 0, controller: 0 }
    const ZERO_PRICING = { ...defaultProposalPricing(), rates: ZERO_RATES }
    const NO_RATE_PROPOSAL: Proposal = {
      ...PROPOSAL,
      id: 'prop-drilling',
      selections: [{ serviceId: 'payroll', payrollRun: 'biweekly' }],
      pricingSnapshot: {
        rates: ZERO_RATES,
        lines: [
          {
            serviceId: 'payroll',
            group: 'Payroll',
            name: 'Payroll',
            tier: null,
            cadence: null,
            amount: 0,
            computedAmount: 0,
            formula: 'No accountant rate set - not yet priced',
            flag: 'no-rate',
          },
        ],
        totals: { monthly: 0, annual: 0, oneTime: 0, cleanup: 0 },
        catalogAt: '2026-10-02T12:00:00.000Z',
      },
    }

    it('a no-rate line reads Not yet priced with its reason, and the banner links to Settings', async () => {
      api.getProposalRequest = vi.fn(async () => NO_RATE_PROPOSAL)
      api.fetchFirmSettings = vi.fn(async () => ({ name: 'PB&J', proposalPricing: ZERO_PRICING }))
      renderEditor('/proposals/prop-drilling')
      expect(await screen.findByText('No accountant rate set - not yet priced')).toBeTruthy()
      expect(document.querySelector('.proposal-line-amount')?.textContent).toBe('Not yet priced')
      expect(screen.queryByText('$0.00', { selector: '.proposal-line-amount' })).toBeNull()
      const banner = screen.getByRole('alert')
      expect(banner.textContent).toContain('Proposal rates are not set')
      expect(within(banner).getByRole('link', { name: 'Settings > Proposal pricing' }).getAttribute('href')).toBe(
        '/settings',
      )
    })

    it('shows no banner when every catalog rate is set', async () => {
      renderEditor()
      await screen.findByText('120 transactions x 0.07 x $75/hr = $630.00')
      expect(screen.queryByText(/Proposal rates are not set/)).toBeNull()
    })

    it('a hand-set override on a no-rate line shows as a price, not Not yet priced', async () => {
      const overridden: Proposal = {
        ...NO_RATE_PROPOSAL,
        pricingSnapshot: {
          ...NO_RATE_PROPOSAL.pricingSnapshot!,
          lines: [{ ...NO_RATE_PROPOSAL.pricingSnapshot!.lines[0], amount: 300 }],
        },
      }
      api.getProposalRequest = vi.fn(async () => overridden)
      api.fetchFirmSettings = vi.fn(async () => ({ name: 'PB&J', proposalPricing: ZERO_PRICING }))
      renderEditor('/proposals/prop-drilling')
      await screen.findByText('No accountant rate set - not yet priced')
      expect(document.querySelector('.proposal-line-amount')?.textContent).toBe('$300.00')
    })

    it('opening a draft whose snapshot rates differ from the catalog reprices it once and says so', async () => {
      const repriced: Proposal = { ...PROPOSAL, id: 'prop-drilling' }
      api.getProposalRequest = vi.fn(async () => NO_RATE_PROPOSAL)
      api.repriceProposalRequest = vi.fn(async () => repriced)
      renderEditor('/proposals/prop-drilling')
      await waitFor(() => expect(api.repriceProposalRequest).toHaveBeenCalledWith('prop-drilling'))
      expect(await screen.findByText('Repriced at today’s rates')).toBeTruthy()
      expect(await screen.findByText('120 transactions x 0.07 x $75/hr = $630.00')).toBeTruthy()
      expect(api.repriceProposalRequest).toHaveBeenCalledTimes(1)
    })

    it('the on-open notice is cleared by her next save, and not shown for an answer about another proposal', async () => {
      const repriced: Proposal = { ...PROPOSAL, id: 'prop-drilling' }
      api.getProposalRequest = vi.fn(async () => NO_RATE_PROPOSAL)
      api.repriceProposalRequest = vi.fn(async () => repriced)
      renderEditor('/proposals/prop-drilling')
      expect(await screen.findByText('Repriced at today’s rates')).toBeTruthy()
      fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
      await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalled())
      expect(screen.queryByText('Repriced at today’s rates')).toBeNull()
    })

    it('a line that is $0 without a flag also reads Not yet priced, as in the PDF and the letter', async () => {
      const unflagged: Proposal = {
        ...PROPOSAL,
        pricingSnapshot: {
          ...PROPOSAL.pricingSnapshot!,
          lines: [{ ...PROPOSAL.pricingSnapshot!.lines[0], amount: 0, computedAmount: 0, flag: null }],
        },
      }
      api.getProposalRequest = vi.fn(async () => unflagged)
      renderEditor()
      await screen.findByText(/120 transactions/)
      expect(document.querySelector('.proposal-line-amount')?.textContent).toBe('Not yet priced')
    })

    it('does not reprice a draft whose snapshot already carries the catalog rates', async () => {
      renderEditor()
      await screen.findByText('120 transactions x 0.07 x $75/hr = $630.00')
      expect(api.repriceProposalRequest).not.toHaveBeenCalled()
      expect(screen.queryByText('Repriced at today’s rates')).toBeNull()
    })

    for (const status of ['sent', 'accepted', 'declined'] as const) {
      it(`never reprices a ${status} proposal on open - it keeps its snapshot`, async () => {
        api.getProposalRequest = vi.fn(async () => ({ ...NO_RATE_PROPOSAL, status }))
        renderEditor('/proposals/prop-drilling')
        await screen.findByText('No accountant rate set - not yet priced')
        expect(api.repriceProposalRequest).not.toHaveBeenCalled()
        expect(screen.queryByText('Repriced at today’s rates')).toBeNull()
      })
    }
  })

  it('a retired tier stays checked and disabled in the picker; picking another tier replaces it (review I2)', async () => {
    api.getProposalRequest = vi.fn(async () => RETIRED_TIER_PROPOSAL)
    api.fetchFirmSettings = vi.fn(async () => ({ name: 'PB&J', proposalPricing: RETIRED_TIER_PRICING }))
    renderEditor('/proposals/prop-3')

    const row = await screen.findByRole('radiogroup', { name: 'Monthly: Weekly transactions' })
    const basic = within(row).getByLabelText('Basic') as HTMLInputElement
    expect(basic.checked).toBe(true)
    expect(basic.disabled).toBe(true)
    expect(within(row).getByText('Retired')).toBeTruthy()

    fireEvent.click(within(row).getByLabelText('Advance'))
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-3', {
        selections: [{ serviceId: 'monthly-weekly-transactions-advance' }],
      }),
    )
  })

  it('a retired line offers Remove instead of an override, and Remove drops its selection (review I3)', async () => {
    api.getProposalRequest = vi.fn(async () => RETIRED_LINE_PROPOSAL)
    renderEditor('/proposals/prop-4')
    await screen.findByText('Old add-on')
    expect(screen.queryByLabelText('Override Monthly: Old add-on')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-4', {
        selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
      }),
    )
  })

  it('copies to a new draft and opens it', async () => {
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to new proposal' }))
    await waitFor(() => expect(api.copyProposalRequest).toHaveBeenCalledWith('prop-1'))
    await waitFor(() => expect(api.getProposalRequest).toHaveBeenCalledWith('prop-copy'))
  })

  it('deletes a draft only after a confirm', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalled()
    expect(api.deleteProposalRequest).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('The proposals list')).toBeTruthy()
    expect(api.deleteProposalRequest).toHaveBeenCalledWith('prop-1')
  })

  it('locks the estimate of a declined proposal and offers no Delete', async () => {
    api.getProposalRequest = vi.fn(async () => DECLINED)
    renderEditor('/proposals/prop-2')
    const company = await screen.findByLabelText('Company')
    expect(company.closest('fieldset')?.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reprice at today’s catalog' })).toBeNull()

    // The override field lives outside the prospect/services fieldset — it needs its
    // own lock (review I1).
    const override = screen.getByLabelText('Override Monthly: Weekly transactions Basic')
    expect(override.closest('fieldset')?.disabled).toBe(true)
  })

  it('shows an error and a way back when the proposal fails to load (review M7/M9)', async () => {
    api.getProposalRequest = vi.fn(async () => {
      throw new ApiError(404, 'That proposal was not found.')
    })
    renderEditor()
    expect(await screen.findByText('That proposal was not found.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to proposals' })).toBeTruthy()
  })
})

const WITH_LETTER: Proposal = {
  ...PROPOSAL,
  letter: {
    subject: 'Your bookkeeping proposal',
    sections: [{ heading: 'Opening', body: 'Thank you for meeting with us.' }],
    text: 'Opening\n\nThank you for meeting with us.',
  },
  letterAt: '2026-09-23T13:00:00.000Z',
}

describe('the Letter tab', () => {
  it('drafts the letter and shows the text to edit', async () => {
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Draft the proposal' }))
    await waitFor(() => expect(api.draftProposalLetterRequest).toHaveBeenCalledWith('prop-1'))
    expect(((await screen.findByLabelText('Letter text')) as HTMLTextAreaElement).value).toBe(
      'Opening\n\nThank you for meeting with us.',
    )
    expect(screen.getByText('Subject: Your bookkeeping proposal')).toBeTruthy()
  })

  it('regenerates only after a confirm', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }))
    expect(confirm).toHaveBeenCalled()
    expect(api.draftProposalLetterRequest).not.toHaveBeenCalled()
  })

  it('saves an edit to the letter text', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    renderEditor('/proposals/prop-1?tab=letter')
    const text = await screen.findByLabelText('Letter text')
    fireEvent.change(text, { target: { value: 'Opening\n\nThanks, Pat.' } })
    fireEvent.blur(text)
    await waitFor(() =>
      expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
        letterText: 'Opening\n\nThanks, Pat.',
      }),
    )
  })

  it('copies the text', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Copy text' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Opening\n\nThank you for meeting with us.'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })
})

describe('Preview PDF', () => {
  it('links to the server-rendered PDF in a new tab', async () => {
    renderEditor('/proposals/prop-1?tab=letter')
    const link = await screen.findByRole('link', { name: 'Preview PDF' })
    expect(link.getAttribute('href')).toBe('/api/proposals/prop-1/pdf')
    expect(link.getAttribute('target')).toBe('_blank')
  })
})

// featreq-34627da1: Send opens the shared recipient picker instead of a prompt.
const openSendPicker = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Send to prospect' }))
  return within(await screen.findByRole('dialog', { name: 'Choose who this goes to' }))
}
const pickAndSend = async () => {
  const dialog = await openSendPicker()
  fireEvent.click(dialog.getByRole('button', { name: /^Send to \d+ (person|people)$/ }))
}

describe('Send to prospect', () => {
  it('opens the picker with the prospect ticked, and sends to what she leaves ticked', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    renderEditor('/proposals/prop-1?tab=letter')
    const dialog = await openSendPicker()
    expect(dialog.getByRole('checkbox', { name: /pat@acme.test/ })).toBeChecked()
    expect(dialog.getByText('Goes to: pat@acme.test')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Send to 1 person' }))
    await waitFor(() => expect(api.sendProposalRequest).toHaveBeenCalledWith('prop-1', { to: ['pat@acme.test'] }))
  })

  it("lists the client's contacts when the proposal is for a client, and posts an address added for this send", async () => {
    contextValue = {
      ...contextValue,
      data: {
        clients: [{ id: 'client-1', name: 'Existing Co', billingMode: 'subscription', contactIds: ['ct-1'] }],
        contacts: [{ id: 'ct-1', name: 'Bea Books', email: 'bea@existing.test' }],
      },
    } as typeof contextValue
    api.getProposalRequest = vi.fn(async () => ({ ...WITH_LETTER, clientId: 'client-1' }))
    renderEditor('/proposals/prop-1?tab=letter')
    const dialog = await openSendPicker()
    expect(dialog.getByRole('checkbox', { name: /bea@existing.test/ })).not.toBeChecked()
    fireEvent.click(dialog.getByRole('checkbox', { name: /bea@existing.test/ }))
    fireEvent.change(dialog.getByLabelText('Add another address for this send only'), { target: { value: 'cfo@acme.test' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Send to 3 people' }))
    await waitFor(() =>
      expect(api.sendProposalRequest).toHaveBeenCalledWith('prop-1', {
        to: ['pat@acme.test', 'bea@existing.test'],
        extra: ['cfo@acme.test'],
      }),
    )
  })

  it('needs one address on file: everyone unticked disables Send and says why', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    renderEditor('/proposals/prop-1?tab=letter')
    const dialog = await openSendPicker()
    fireEvent.click(dialog.getByRole('checkbox', { name: /pat@acme.test/ }))
    expect(dialog.getByRole('button', { name: 'Send to 0 people' })).toBeDisabled()
    expect(dialog.getByRole('alert')).toHaveTextContent(/Pick at least one address on file/)
  })

  // Review round 1: a ticked address no longer on file is refused (409), not dropped.
  it('on recipients_changed says so and reopens the picker on the list the server answered with', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const changed = new ApiError(409, 'The addresses on file for this client have changed. Reload and choose again.', 'recipients_changed')
    changed.recipients = [{ email: 'new@acme.test', source: 'Pat Doe' }]
    api.sendProposalRequest = vi
      .fn()
      .mockRejectedValueOnce(changed)
      .mockResolvedValueOnce({ ...WITH_LETTER, status: 'sent' })
    renderEditor('/proposals/prop-1?tab=letter')
    await pickAndSend()
    expect(await screen.findByText(/The addresses on file for this client have changed/)).toBeTruthy()
    const reopened = within(await screen.findByRole('dialog', { name: 'Choose who this goes to' }))
    expect(reopened.getByRole('checkbox', { name: /new@acme.test/ })).toBeChecked()
    expect(reopened.queryByRole('checkbox', { name: /pat@acme.test/ })).toBeNull()
    fireEvent.click(reopened.getByRole('button', { name: 'Send to 1 person' }))
    await waitFor(() => expect(api.sendProposalRequest).toHaveBeenLastCalledWith('prop-1', { to: ['new@acme.test'] }))
  })

  it('sends nothing when she cancels the picker', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    renderEditor('/proposals/prop-1?tab=letter')
    const dialog = await openSendPicker()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(api.sendProposalRequest).not.toHaveBeenCalled()
  })

  it('cannot send before there is a letter', async () => {
    renderEditor('/proposals/prop-1?tab=letter')
    const send = (await screen.findByRole('button', { name: 'Send to prospect' })) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('shows what the mail provider said about the last send', async () => {
    api.getProposalRequest = vi.fn(async () => ({
      ...WITH_LETTER,
      status: 'sent' as const,
      emailLog: [
        { kind: 'send' as const, at: '2026-09-23T14:00:00.000Z', providerId: 're_1', to: ['pat@acme.test'], ok: true },
        { kind: 'delivery' as const, at: '2026-09-23T14:01:00.000Z', providerId: 're_1', to: ['pat@acme.test'], event: 'delivered' },
      ],
    }))
    renderEditor('/proposals/prop-1?tab=letter')
    expect(await screen.findByText('Delivered', { selector: '.status-pill' })).toBeTruthy()
  })

  it('shows a quiet warning when the estimate changed since the letter was drafted (Important 1, final fix wave)', async () => {
    api.getProposalRequest = vi.fn(async () => ({
      ...WITH_LETTER,
      letter: {
        ...WITH_LETTER.letter!,
        text: 'Opening\n\nThank you. The monthly fee is $9,999.00.',
      },
    }))
    renderEditor('/proposals/prop-1?tab=letter')
    expect(
      await screen.findByText(
        'The estimate changed since this letter was drafted; 1 figure(s) no longer match.',
      ),
    ).toBeTruthy()
  })

  it('shows no warning when every figure in the letter is still in the estimate', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    renderEditor('/proposals/prop-1?tab=letter')
    await screen.findByLabelText('Letter text')
    expect(screen.queryByText(/no longer match/)).toBeNull()
  })

  it('on a stale-letter 409, confirms with the server sentence and resends with confirmStaleFigures: true', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const staleError = new ApiError(
      409,
      'The letter quotes figures the estimate no longer has: $500.00. Regenerate the letter, or send anyway.',
      'stale_letter_figures',
    )
    api.sendProposalRequest = vi
      .fn()
      .mockRejectedValueOnce(staleError)
      .mockResolvedValueOnce({ ...WITH_LETTER, status: 'sent' })
    renderEditor('/proposals/prop-1?tab=letter')
    await pickAndSend()
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(staleError.message))
    await waitFor(() =>
      expect(api.sendProposalRequest).toHaveBeenNthCalledWith(2, 'prop-1', { to: ['pat@acme.test'] }, {
        confirmStaleFigures: true,
      }),
    )
    expect(await screen.findByText('Sent', { selector: '.status-pill' })).toBeTruthy()
  })

  // 2026-10-11: a quote with a line not yet priced (a count only asked on a call)
  // is confirmed before it goes - and both questions can come on one send.
  it('on an unpriced-lines 409, confirms with the server sentence and resends with confirmUnpriced: true', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const staleError = new ApiError(
      409,
      'The letter quotes figures the estimate no longer has: $500.00. Regenerate the letter, or send anyway.',
      'stale_letter_figures',
    )
    const unpricedError = new ApiError(
      409,
      '1 line is not yet priced and will be left out of the quote - send anyway?',
      'unpriced_lines',
    )
    api.sendProposalRequest = vi
      .fn()
      .mockRejectedValueOnce(staleError)
      .mockRejectedValueOnce(unpricedError)
      .mockResolvedValueOnce({ ...WITH_LETTER, status: 'sent' })
    renderEditor('/proposals/prop-1?tab=letter')
    await pickAndSend()
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(unpricedError.message))
    await waitFor(() =>
      expect(api.sendProposalRequest).toHaveBeenNthCalledWith(3, 'prop-1', { to: ['pat@acme.test'] }, {
        confirmStaleFigures: true,
        confirmUnpriced: true,
      }),
    )
    expect(api.sendProposalRequest).toHaveBeenNthCalledWith(1, 'prop-1', { to: ['pat@acme.test'] })
    expect(api.sendProposalRequest).toHaveBeenNthCalledWith(2, 'prop-1', { to: ['pat@acme.test'] }, {
      confirmStaleFigures: true,
    })
    expect(await screen.findByText('Sent', { selector: '.status-pill' })).toBeTruthy()
  })

  it('does not send when she cancels the unpriced-lines confirm, and shows the sentence', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    vi.stubGlobal('confirm', vi.fn(() => false))
    const unpricedError = new ApiError(
      409,
      '2 lines are not yet priced and will be left out of the quote - send anyway?',
      'unpriced_lines',
    )
    api.sendProposalRequest = vi.fn().mockRejectedValueOnce(unpricedError)
    renderEditor('/proposals/prop-1?tab=letter')
    await pickAndSend()
    expect(await screen.findByText(unpricedError.message)).toBeTruthy()
    expect(api.sendProposalRequest).toHaveBeenCalledTimes(1)
  })

  it('does not resend, and shows the sentence, when she cancels the stale-figures confirm', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    vi.stubGlobal('confirm', vi.fn(() => false))
    const staleError = new ApiError(
      409,
      'The letter quotes figures the estimate no longer has: $500.00. Regenerate the letter, or send anyway.',
      'stale_letter_figures',
    )
    api.sendProposalRequest = vi.fn().mockRejectedValueOnce(staleError)
    renderEditor('/proposals/prop-1?tab=letter')
    await pickAndSend()
    await waitFor(() => expect(api.sendProposalRequest).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(staleError.message, { selector: '.form-error' })).toBeTruthy()
  })
})

describe('the "Existing client" picker (item 6, final fix wave)', () => {
  it('excludes a billing master and a retired client, keeping active ones', async () => {
    contextValue.data.clients = [
      { id: 'client-1', name: 'Existing Co', billingMode: 'subscription' },
      { id: 'client-master', name: 'KLC Master', billingMode: 'subscription', isBillingMaster: true },
      { id: 'client-retired', name: 'Old Co', billingMode: 'subscription', lifecycleStage: 'inactive' },
    ] as unknown as Client[]
    renderEditor()
    const select = await screen.findByLabelText('Existing client')
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toContain('Existing Co')
    expect(options).not.toContain('KLC Master')
    expect(options).not.toContain('Old Co')
  })
})

describe('refetching on the app-wide data broadcast (item 5, final fix wave)', () => {
  function renderEditorTree() {
    return render(
      <MemoryRouter initialEntries={['/proposals/prop-1']}>
        <Routes>
          <Route path="/proposals" element={<p>The proposals list</p>} />
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('refetches once when data changes while the save queue is idle, and shows the updated badge', async () => {
    const { rerender } = renderEditorTree()
    await screen.findByText('Acme Books')
    expect(api.getProposalRequest).toHaveBeenCalledTimes(1)

    api.getProposalRequest = vi.fn(async () => ({
      ...WITH_LETTER,
      status: 'sent' as const,
      emailLog: [
        {
          kind: 'send' as const,
          at: '2026-09-23T14:00:00.000Z',
          providerId: 're_1',
          to: ['pat@acme.test'],
          ok: true,
        },
        {
          kind: 'delivery' as const,
          at: '2026-09-23T14:01:00.000Z',
          providerId: 're_1',
          to: ['pat@acme.test'],
          event: 'delivered',
        },
      ],
    }))
    // A NEW `data` reference is what a `data-changed` broadcast produces
    // app-wide (App.tsx's `setData(remote)`) — the signal this page reacts to.
    contextValue = { ...contextValue, data: { clients: [...contextValue.data.clients] } } as typeof contextValue
    rerender(
      <MemoryRouter initialEntries={['/proposals/prop-1']}>
        <Routes>
          <Route path="/proposals" element={<p>The proposals list</p>} />
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(api.getProposalRequest).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'Letter' }))
    expect(await screen.findByText('Delivered', { selector: '.status-pill' })).toBeTruthy()
    // N5 (final fix wave round 2): exactly one GET, checked AFTER the
    // broadcast has fully settled — not inside `waitFor`, which would pass
    // the moment the count first reaches 1 even if a stray second GET were
    // about to follow.
    expect(api.getProposalRequest).toHaveBeenCalledTimes(1)
  })

  it('a save that lands while a slow broadcast refetch is still in flight is not undone when that stale refetch lands late (N1, final fix wave round 2)', async () => {
    const slowGet = deferred<Proposal>()
    api.getProposalRequest = vi
      .fn()
      .mockResolvedValueOnce(PROPOSAL) // initial mount load
      .mockReturnValueOnce(slowGet.promise) // the broadcast's own refetch — stays in flight
    const saved: Proposal = {
      ...PROPOSAL,
      selections: [{ serviceId: 'monthly-weekly-transactions-basic', override: 600 }],
    }
    api.updateProposalRequest = vi.fn(async () => saved)

    const { rerender } = renderEditorTree()
    await screen.findByText('Acme Books')
    expect(api.getProposalRequest).toHaveBeenCalledTimes(1)

    // A `data-changed` broadcast: the effect's own refetch GET is sent now,
    // while the save queue is idle, and stays unresolved.
    contextValue = { ...contextValue, data: { clients: [...contextValue.data.clients] } } as typeof contextValue
    rerender(
      <MemoryRouter initialEntries={['/proposals/prop-1']}>
        <Routes>
          <Route path="/proposals" element={<p>The proposals list</p>} />
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(api.getProposalRequest).toHaveBeenCalledTimes(2))

    // A save starts, and finishes, entirely while that GET is still in flight.
    const override = await screen.findByLabelText('Override Monthly: Weekly transactions Basic')
    fireEvent.change(override, { target: { value: '600' } })
    fireEvent.blur(override)
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const field = screen.getByLabelText('Override Monthly: Weekly transactions Basic') as HTMLInputElement
      expect(field.value).toBe('600')
    })

    // Only now does the stale broadcast GET land, with the OLD value — it
    // must be dropped rather than put back over what the save just wrote.
    slowGet.resolve(PROPOSAL)
    await waitFor(() => {
      const field = screen.getByLabelText('Override Monthly: Weekly transactions Basic') as HTMLInputElement
      expect(field.value).toBe('600')
    })

    // Proven definitively by what the NEXT save carries: built from `saved`
    // (via `latestRef`), not from the stale `PROPOSAL` the late GET tried to
    // put back.
    fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalledTimes(2))
    expect(api.updateProposalRequest).toHaveBeenNthCalledWith(2, 'prop-1', {
      selections: [
        { serviceId: 'monthly-weekly-transactions-basic', override: 600 },
        { serviceId: 'reconciliations' },
      ],
    })
  })
})

// Engagements stage 3: Accept writes nothing to a client; the confirm says the client
// side happens when the engagement letter is marked signed.
const WON_DRAFTED =
  'This proposal is marked Won. An engagement letter will be drafted for you to edit and send.'
const PROSPECT_CONFIRM = (middle: string) =>
  `Accept this proposal? ${WON_DRAFTED} Acme Books becomes a client in Onboarding, billed monthly at $630.00${middle}, when the letter is marked signed - not before. Nothing about any invoice changes now.`

describe('Accept and Decline', () => {
  it('Accept on a prospect says the client is created at signing, then accepts', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(PROSPECT_CONFIRM(''))
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
    )
    expect(await screen.findByText('Won', { selector: '.status-pill' })).toBeTruthy()
    // No engagement came back, so the page stays and says when the client arrives.
    expect(
      await screen.findByText(/Acme Books becomes a client when this letter is marked signed\./),
    ).toBeTruthy()
    // Not signed yet: no client to open.
    expect(screen.queryByRole('link', { name: 'Open the client' })).toBeNull()
  })

  it('a prospect with only annual fees is named as billed annually', async () => {
    api.getProposalRequest = vi.fn(async () => ({
      ...PROPOSAL,
      pricingSnapshot: {
        ...PROPOSAL.pricingSnapshot!,
        totals: { ...PROPOSAL.pricingSnapshot!.totals, monthly: 0, annual: 1200 },
      },
    }))
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(
      `Accept this proposal? ${WON_DRAFTED} Acme Books becomes a client in Onboarding, billed annually at $1,200.00, when the letter is marked signed - not before. Nothing about any invoice changes now.`,
    )
  })

  // A questionnaire draft's starter line can need a count only asked on a call: it
  // prices at $0, and the client's fee would be a partial total.
  it('refuses Accept while a line is not yet priced, and says why on the Estimate tab', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    api.getProposalRequest = vi.fn(async () => PARTLY_PRICED)
    renderEditor()
    expect(
      await screen.findByText('Partly priced: 1 line is not yet priced and left out of these totals.'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(
      await screen.findByText('Some lines are not yet priced - price them on the Estimate tab first.'),
    ).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    expect(api.acceptProposalRequest).not.toHaveBeenCalled()
  })

  it('a fully priced proposal shows no partly-priced note', async () => {
    renderEditor()
    await screen.findByRole('button', { name: 'Accept' })
    expect(screen.queryByText(/Partly priced|Not yet priced: no line/)).toBeNull()
  })

  it('does nothing when the Accept confirm is canceled', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(api.acceptProposalRequest).not.toHaveBeenCalled()
  })

  it('sends the chosen package with the accept', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditor()
    await waitFor(() => expect(api.listPackagesRequest).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText('Package to apply when signed'), {
      target: { value: 'pkg-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: 'pkg-1' }),
    )
  })

  it('sends the ticked plans with the accept and names them in the confirm', async () => {
    contextValue.data.plans = [
      { id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' },
      { id: 'plan-2', name: 'Payroll', notes: '' },
      { id: 'plan-3', name: 'Tax Prep', notes: '' },
    ] as unknown as SubscriptionPlan[]
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Plans' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payroll' }))
    expect(screen.getByRole('button', { name: 'Plans · 2' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(PROSPECT_CONFIRM(', with the plans Monthly Bookkeeping and Payroll'))
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', {
        packageId: null,
        planIds: ['plan-1', 'plan-2'],
      }),
    )
  })

  it('sends no planIds key when no plan is ticked', async () => {
    contextValue.data.plans = [
      { id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' },
    ] as unknown as SubscriptionPlan[]
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Plans' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
    )
    expect(api.acceptProposalRequest.mock.calls[0][1]).not.toHaveProperty('planIds')
  })

  it('names the ticked plans in the existing-client confirm too', async () => {
    contextValue.data.plans = [
      { id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' },
    ] as unknown as SubscriptionPlan[]
    api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Plans' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(
      `Accept this proposal for Existing Co, with the plan Monthly Bookkeeping? ${WON_DRAFTED} Nothing changes for Existing Co until the letter is marked signed: then the letter's $630.00 is added to their monthly fee (you can choose replace or keep on the letter) and the plan is added.`,
    )
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', {
        packageId: null,
        planIds: ['plan-1'],
      }),
    )
  })

  it('closes the Plans picker on a click elsewhere and on Escape', async () => {
    contextValue.data.plans = [
      { id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' },
    ] as unknown as SubscriptionPlan[]
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Plans' }))
    expect(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' })).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('checkbox', { name: 'Monthly Bookkeeping' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Plans' }))
    expect(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' }))
    expect(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('checkbox', { name: 'Monthly Bookkeeping' })).toBeNull()
  })

  it('does not mangle a plan name that contains a comma in the confirm', async () => {
    contextValue.data.plans = [
      { id: 'plan-1', name: 'Payroll, Tax', notes: '' },
    ] as unknown as SubscriptionPlan[]
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Plans' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payroll, Tax' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(PROSPECT_CONFIRM(', with the plan Payroll, Tax'))
  })

  it('sends no planIds key for an existing client when no plan is ticked', async () => {
    contextValue.data.plans = [
      { id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' },
    ] as unknown as SubscriptionPlan[]
    api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      `Accept this proposal for Existing Co? ${WON_DRAFTED} Nothing changes for Existing Co until the letter is marked signed: then the letter's $630.00 is added to their monthly fee (you can choose replace or keep on the letter).`,
    )
    await waitFor(() => expect(api.acceptProposalRequest).toHaveBeenCalled())
    expect(api.acceptProposalRequest.mock.calls[0][1]).not.toHaveProperty('planIds')
  })

  it('an upsell asks once: the fee change is named, and nothing is sent about it', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
    )
    expect(
      await screen.findByText(/Nothing changes for Existing Co until this letter is marked signed\./),
    ).toBeTruthy()
  })

  // Engagements stage 4: an upsell amends or supersedes the client's current signed engagement.
  describe('amend or supersede the current engagement', () => {
    const signedOriginal = {
      id: 'eng-orig',
      kind: 'original',
      status: 'signed',
      clientId: 'client-1',
      signedAt: '2026-09-15T16:00:00.000Z',
    }

    it('offers no choice when the client has no signed original or superseding letter', async () => {
      api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
      api.listEngagementsRequest = vi.fn(async () => [{ ...signedOriginal, kind: 'amendment' }])
      renderEditor()
      await screen.findByRole('button', { name: 'Accept' })
      await waitFor(() =>
        expect(api.listEngagementsRequest).toHaveBeenCalledWith({ clientId: 'client-1', status: 'signed' }),
      )
      expect(screen.queryByRole('combobox', { name: 'What the letter does to the current engagement' })).toBeNull()
    })

    it('amends by default: the same question, no mode sent', async () => {
      api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
      api.listEngagementsRequest = vi.fn(async () => [signedOriginal])
      const confirm = vi.fn((message?: string) => (void message, true))
      vi.stubGlobal('confirm', confirm)
      renderEditor()
      const choice = await screen.findByRole('combobox', { name: 'What the letter does to the current engagement' })
      expect(choice).toHaveValue('amend')
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      expect(confirm.mock.calls[0][0]).toMatch(/is added to their monthly fee/)
      await waitFor(() => expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }))
    })

    it('supersede says what signing replaces and sends mode supersede', async () => {
      contextValue.data.plans = [{ id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' }] as unknown as SubscriptionPlan[]
      api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
      api.listEngagementsRequest = vi.fn(async () => [signedOriginal])
      const confirm = vi.fn((message?: string) => (void message, true))
      vi.stubGlobal('confirm', confirm)
      renderEditor()
      const choice = await screen.findByRole('combobox', { name: 'What the letter does to the current engagement' })
      fireEvent.change(choice, { target: { value: 'supersede' } })
      fireEvent.click(screen.getByRole('button', { name: 'Plans' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' }))
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(confirm.mock.calls[0][0]).toBe(
        "Accept this proposal for Existing Co, with the plan Monthly Bookkeeping? This proposal is marked Won. A superseding engagement letter will be drafted to replace the one signed Sep 15, 2026, for you to edit and send. Nothing changes for Existing Co until the letter is marked signed: then the letter's $630.00 replaces their monthly fee, their plans become exactly the letter's plans and the engagement signed Sep 15, 2026 is marked Superseded.",
      )
      await waitFor(() =>
        expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', {
          packageId: null,
          planIds: ['plan-1'],
          mode: 'supersede',
        }),
      )
    })

    // Review round 2: plans are SET only when the letter names some; a letter with no
    // monthly fee leaves theirs, and the question says so.
    it('a package with no plans and no monthly fee: plans and fee both stay, and the question says so', async () => {
      contextValue.data.clients = [
        { id: 'client-1', name: 'Existing Co', billingMode: 'subscription', monthlyRate: 400 },
      ] as unknown as Client[]
      api.getProposalRequest = vi.fn(async () => ({
        ...PROPOSAL,
        clientId: 'client-1',
        pricingSnapshot: {
          ...PROPOSAL.pricingSnapshot,
          totals: { monthly: 0, annual: 1200, oneTime: 0, cleanup: 0 },
        },
      }))
      api.listEngagementsRequest = vi.fn(async () => [signedOriginal])
      const confirm = vi.fn((message?: string) => (void message, true))
      vi.stubGlobal('confirm', confirm)
      renderEditor()
      fireEvent.change(
        await screen.findByRole('combobox', { name: 'What the letter does to the current engagement' }),
        { target: { value: 'supersede' } },
      )
      await waitFor(() => expect(screen.getByRole('option', { name: 'Full service' })).toBeTruthy())
      fireEvent.change(screen.getByRole('combobox', { name: 'Package to apply when signed' }), {
        target: { value: 'pkg-1' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      const question = String(confirm.mock.calls[0][0])
      expect(question).toContain('their monthly fee stays at $400.00 (the letter has none)')
      expect(question).toContain('their plans stay as they are (the letter names none)')
      expect(question).not.toContain('replaces their monthly fee')
      expect(question).not.toContain("become exactly the letter's plans")
    })

    it('a no on the supersede question sends nothing', async () => {
      api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
      api.listEngagementsRequest = vi.fn(async () => [signedOriginal])
      vi.stubGlobal('confirm', vi.fn(() => false))
      renderEditor()
      fireEvent.change(
        await screen.findByRole('combobox', { name: 'What the letter does to the current engagement' }),
        { target: { value: 'supersede' } },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      expect(api.acceptProposalRequest).not.toHaveBeenCalled()
    })
  })

  it('names no fee change for a non-subscription client even with a fee above $0', async () => {
    contextValue.data.clients = [
      { id: 'client-1', name: 'Existing Co', billingMode: 'hourly' },
    ] as unknown as Client[]
    api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(
      `Accept this proposal for Existing Co? ${WON_DRAFTED} Nothing changes for Existing Co until the letter is marked signed.`,
    )
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
    )
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('names no fee change when the snapshot is $0', async () => {
    api.getProposalRequest = vi.fn(async () => ({
      ...PROPOSAL,
      clientId: 'client-1',
      pricingSnapshot: {
        ...PROPOSAL.pricingSnapshot!,
        totals: { ...PROPOSAL.pricingSnapshot!.totals, monthly: 0 },
      },
    }))
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(
      `Accept this proposal for Existing Co? ${WON_DRAFTED} Nothing changes for Existing Co until the letter is marked signed.`,
    )
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
    )
  })

  it('a chosen package rides with the Accept and raises no "could not be applied" notice', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditor()
    await waitFor(() => expect(api.listPackagesRequest).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText('Package to apply when signed'), {
      target: { value: 'pkg-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: 'pkg-1' }),
    )
    expect(await screen.findByText('Won', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.queryByText(/could not be applied/)).toBeNull()
  })

  it('Close as lost asks for an optional note and saves it', async () => {
    const prompt = vi.fn(() => 'Went with a friend')
    vi.stubGlobal('prompt', prompt)
    renderEditor()
    expect(await screen.findByRole('button', { name: 'Close as lost' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close as lost' }))
    expect(prompt).toHaveBeenCalledWith(
      'Close this proposal as lost? Add a note if you like (optional — saved on the proposal).',
      '',
    )
    await waitFor(() =>
      expect(api.declineProposalRequest).toHaveBeenCalledWith('prop-1', 'Went with a friend'),
    )
    expect(await screen.findByText('Closed/Lost', { selector: '.status-pill' })).toBeTruthy()
  })

  it('Close as lost with the note left blank closes it with an empty note', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '   '))
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Close as lost' }))
    await waitFor(() => expect(api.declineProposalRequest).toHaveBeenCalledWith('prop-1', ''))
  })

  it('canceling the Close as lost prompt closes nothing', async () => {
    vi.stubGlobal('prompt', vi.fn(() => null))
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Close as lost' }))
    expect(api.declineProposalRequest).not.toHaveBeenCalled()
  })
})

describe('the intake chat', () => {
  const AFTER_CHAT: Proposal = {
    ...PROPOSAL,
    inputs: { transactions: 120, employees: 10 },
    messages: [
      { role: 'user', text: 'They have 10 employees.', at: '2026-09-23T15:00:00.000Z' },
      {
        role: 'assistant',
        text: 'Ten on payroll — noted. How often do they run it?',
        at: '2026-09-23T15:00:01.000Z',
        patch: { inputs: { employees: 10 } },
      },
    ],
  }

  it('sends her message, shows the reply, and marks what the chat changed', async () => {
    api.proposalChatRequest = vi.fn(async () => ({
      reply: 'Ten on payroll — noted. How often do they run it?',
      applied: { inputs: { employees: 10 } },
      snapshot: AFTER_CHAT.pricingSnapshot,
      proposal: AFTER_CHAT,
    }))
    renderEditor()
    const box = await screen.findByLabelText('Message to the intake assistant')
    fireEvent.change(box, { target: { value: 'They have 10 employees.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(api.proposalChatRequest).toHaveBeenCalledWith('prop-1', 'They have 10 employees.'),
    )
    expect(await screen.findByText('Ten on payroll — noted. How often do they run it?')).toBeTruthy()
    expect(screen.getByLabelText('Employees').closest('label')?.className).toContain('proposal-changed')
    expect(screen.getByLabelText('Transactions').closest('label')?.className).not.toContain(
      'proposal-changed',
    )
    // The textarea only clears on success (fix batch 3, item 2).
    expect((await screen.findByLabelText('Message to the intake assistant') as HTMLTextAreaElement).value).toBe(
      '',
    )
  })

  it('shows the error sentence — once, not also as the page-level banner — and keeps her draft text (fix batch 3, item 2)', async () => {
    api.proposalChatRequest = vi.fn(async () => {
      throw new ApiError(503, 'The AI is at capacity right now — give it a minute and try again.')
    })
    renderEditor()
    const box = (await screen.findByLabelText(
      'Message to the intake assistant',
    )) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/at capacity/)).toBeTruthy()
    expect(screen.getAllByText(/at capacity/)).toHaveLength(1)
    expect(box.value).toBe('Hello')
  })

  it('does not clear an unrelated page-level error (item 8, final fix wave)', async () => {
    api.updateProposalRequest = vi.fn(async () => {
      throw new ApiError(500, 'That did not save — try again.')
    })
    api.proposalChatRequest = vi.fn(async () => {
      throw new ApiError(503, 'The AI is at capacity right now — give it a minute and try again.')
    })
    renderEditor()
    // A manual save fails first, setting the page-level banner.
    const company = await screen.findByLabelText('Company')
    fireEvent.change(company, { target: { value: 'New name' } })
    fireEvent.blur(company)
    await screen.findByText('That did not save — try again.', { selector: '.form-error' })

    // A chat turn that ALSO fails must not wipe that banner — `sendChat`
    // swallows its own rejection and hands `enqueue` back the unchanged
    // proposal, which used to unconditionally clear `error`.
    const box = (await screen.findByLabelText('Message to the intake assistant')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(api.proposalChatRequest).toHaveBeenCalled())
    await screen.findByText(/at capacity/)
    expect(screen.getByText('That did not save — try again.', { selector: '.form-error' })).toBeTruthy()
  })

  it('a chat turn and a field edit queued together apply in order — the field edit is built from the chat’s result (fix batch 3, item 2)', async () => {
    const chatResult = {
      reply: 'Ten on payroll — noted. How often do they run it?',
      applied: { inputs: { employees: 10 } },
      snapshot: AFTER_CHAT.pricingSnapshot,
      proposal: {
        ...AFTER_CHAT,
        selections: [{ serviceId: 'monthly-weekly-transactions-basic', override: 900 }],
      },
    }
    const chatResponse = deferred<typeof chatResult>()
    api.proposalChatRequest = vi.fn().mockReturnValueOnce(chatResponse.promise)
    api.updateProposalRequest = vi.fn().mockResolvedValueOnce(WITH_RECONCILIATIONS)
    renderEditor()

    fireEvent.change(await screen.findByLabelText('Message to the intake assistant'), {
      target: { value: 'They have 10 employees.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(api.proposalChatRequest).toHaveBeenCalledTimes(1))

    // Queued while the chat turn above is still pending — it must not fire yet.
    fireEvent.click(await screen.findByLabelText('Reconciliations: Reconciliations'))
    expect(api.updateProposalRequest).not.toHaveBeenCalled()

    chatResponse.resolve(chatResult)

    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalledTimes(1))
    // The override the chat applied is still there — the queued save was built
    // from the chat's result, not from the proposal as it stood before it.
    expect(api.updateProposalRequest).toHaveBeenCalledWith('prop-1', {
      selections: [
        { serviceId: 'monthly-weekly-transactions-basic', override: 900 },
        { serviceId: 'reconciliations' },
      ],
    })
  })
})

/**
 * featreq-a69a3cc0 - Software on the proposal: its own picker group, its own
 * totals row ("at cost", never in the monthly fee), a "No charge" line, and
 * Accept adding the lines to the client as monthly Software expenses.
 */
describe('Software on the proposal editor', () => {
  const SOFTWARE_LINES = [
    {
      serviceId: 'software-qbo-plus',
      group: 'Software',
      name: 'QBO Plus',
      tier: null,
      cadence: null,
      amount: 98,
      computedAmount: 98,
      formula: '$98.00 per month, at cost',
      flag: null,
      basePrice: 98,
      unitPrice: 0,
      unitsIncluded: 0,
      unit: 'none',
    },
    {
      serviceId: 'software-bill-pay-basic',
      group: 'Software',
      name: 'QB Bill Pay Basic',
      tier: null,
      cadence: null,
      amount: 0,
      computedAmount: 0,
      formula: '$0.00 per month, at cost',
      flag: null,
      basePrice: 0,
      unitPrice: 0,
      unitsIncluded: 0,
      unit: 'none',
    },
  ] as NonNullable<Proposal['pricingSnapshot']>['lines']
  const WITH_SOFTWARE: Proposal = {
    ...PROPOSAL,
    selections: [...PROPOSAL.selections, { serviceId: 'software-qbo-plus' }, { serviceId: 'software-bill-pay-basic' }],
    pricingSnapshot: {
      ...PROPOSAL.pricingSnapshot!,
      lines: [...PROPOSAL.pricingSnapshot!.lines, ...SOFTWARE_LINES],
      totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0, software: 98 },
    },
  }
  const pricingWithRaisedQboPlus = {
    name: 'PB&J',
    proposalPricing: {
      ...defaultProposalPricing(),
      rates: { bookkeeper: 75, accountant: 115, controller: 125 },
      services: defaultProposalPricing().services.map((service) =>
        service.id === 'software-qbo-plus' ? { ...service, basePrice: 104 } : service,
      ),
    },
  }

  it('shows a Software group in the picker with a checkbox per plan', async () => {
    renderEditor()
    expect(await screen.findByLabelText('Software: QBO Plus')).toBeTruthy()
    expect(screen.getByLabelText('Software: QB Bill Pay Basic')).toBeTruthy()
  })

  it('asks for a count only on a per-employee or per-contractor plan', async () => {
    api.getProposalRequest = vi.fn(async () => ({
      ...PROPOSAL,
      selections: [
        ...PROPOSAL.selections,
        { serviceId: 'software-qb-time-elite' },
        { serviceId: 'software-contractor-payments' },
        { serviceId: 'software-qbo-plus' },
      ],
    }))
    renderEditor()
    expect(await screen.findByLabelText('Count for Software: QB Time Elite')).toBeTruthy()
    expect(screen.getByLabelText('Count for Software: Contractor Payments & 1099 filing')).toBeTruthy()
    expect(screen.queryByLabelText('Count for Software: QBO Plus')).toBeNull()
  })

  it('prints a software line at its price, a $0 plan as "No charge", and the at-cost total apart from the monthly fee', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_SOFTWARE)
    renderEditor()
    await screen.findByText('QBO Plus', { selector: 'strong' })
    const amounts = [...document.querySelectorAll('.proposal-line-amount')].map((cell) => cell.textContent)
    expect(amounts).toEqual(['$630.00', '$98.00', 'No charge'])
    const totals = document.querySelector('.proposal-totals')!.textContent ?? ''
    expect(totals).toContain('Monthly fee$630.00')
    expect(totals).toContain('Software, at cost (monthly)$98.00')
  })

  it('an unpriced plan and a per-employee plan with no count read "Not yet priced", never "No charge"', async () => {
    // Sent, so the page shows the snapshot as it is rather than repricing it on open.
    api.getProposalRequest = vi.fn(async () => ({
      ...WITH_SOFTWARE,
      status: 'sent' as const,
      pricingSnapshot: {
        ...WITH_SOFTWARE.pricingSnapshot!,
        lines: [
          ...PROPOSAL.pricingSnapshot!.lines,
          { ...SOFTWARE_LINES[1], serviceId: 'software-new', name: 'New plan', basePrice: null, flag: 'no-rate', formula: 'No price set for this plan - not yet priced' },
          { ...SOFTWARE_LINES[0], serviceId: 'software-qb-time-elite', name: 'QB Time Elite', amount: 0, flag: 'needs-count', formula: 'Needs an employee count - not yet priced', unit: 'employee' },
        ],
        totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0, software: 0 },
      },
    }))
    renderEditor()
    await screen.findByText('New plan', { selector: 'strong' })
    const amounts = [...document.querySelectorAll('.proposal-line-amount')].map((cell) => cell.textContent)
    expect(amounts).toEqual(['$630.00', 'Not yet priced', 'Not yet priced'])
    expect(screen.queryByText('No charge')).toBeNull()
    expect(screen.getByText('needs a count')).toBeTruthy()
  })

  it('a plan that went from unpriced (null) to an explicit $0 reprices a draft on open; a $0 that stayed $0 does not', async () => {
    const draftWith = (basePrice: number | null, flag: 'no-rate' | null) => ({
      ...WITH_SOFTWARE,
      id: 'prop-sw',
      pricingSnapshot: {
        ...WITH_SOFTWARE.pricingSnapshot!,
        lines: [...PROPOSAL.pricingSnapshot!.lines, { ...SOFTWARE_LINES[1], basePrice, flag }],
      },
    })
    // The catalog's Bill Pay Basic is an explicit $0.
    api.getProposalRequest = vi.fn(async () => draftWith(null, 'no-rate'))
    api.repriceProposalRequest = vi.fn(async () => draftWith(0, null))
    renderEditor('/proposals/prop-sw')
    await waitFor(() => expect(api.repriceProposalRequest).toHaveBeenCalledWith('prop-sw'))
    cleanup()

    api.getProposalRequest = vi.fn(async () => draftWith(0, null))
    api.repriceProposalRequest = vi.fn(async () => draftWith(0, null))
    renderEditor('/proposals/prop-sw')
    await screen.findByText('QB Bill Pay Basic', { selector: 'strong' })
    expect(api.repriceProposalRequest).not.toHaveBeenCalled()
  })

  it('opening a draft whose software unit changed in the catalog reprices it once', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...WITH_SOFTWARE, id: 'prop-sw' }))
    api.repriceProposalRequest = vi.fn(async () => ({ ...WITH_SOFTWARE, id: 'prop-sw' }))
    api.fetchFirmSettings = vi.fn(async () => ({
      name: 'PB&J',
      proposalPricing: {
        ...defaultProposalPricing(),
        rates: { bookkeeper: 75, accountant: 115, controller: 125 },
        services: defaultProposalPricing().services.map((service) =>
          service.id === 'software-qbo-plus' ? { ...service, unit: 'employee' as const } : service,
        ),
      },
    }))
    renderEditor('/proposals/prop-sw')
    await waitFor(() => expect(api.repriceProposalRequest).toHaveBeenCalledWith('prop-sw'))
  })

  it('has no Software total row on a proposal with no software', async () => {
    renderEditor()
    await screen.findByText(/120 transactions/)
    expect(document.querySelector('.proposal-totals')!.textContent).not.toContain('Software')
  })

  it('opening a draft whose software price differs from the catalog reprices it once', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...WITH_SOFTWARE, id: 'prop-sw' }))
    api.repriceProposalRequest = vi.fn(async () => ({ ...WITH_SOFTWARE, id: 'prop-sw' }))
    api.fetchFirmSettings = vi.fn(async () => pricingWithRaisedQboPlus)
    renderEditor('/proposals/prop-sw')
    await waitFor(() => expect(api.repriceProposalRequest).toHaveBeenCalledWith('prop-sw'))
    expect(api.repriceProposalRequest).toHaveBeenCalledTimes(1)
  })

  it('does not reprice a SENT proposal on open, whatever QuickBooks charges now', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...WITH_SOFTWARE, id: 'prop-sw', status: 'sent' as const }))
    api.fetchFirmSettings = vi.fn(async () => pricingWithRaisedQboPlus)
    renderEditor('/proposals/prop-sw')
    await screen.findByText('QBO Plus', { selector: 'strong' })
    expect(api.repriceProposalRequest).not.toHaveBeenCalled()
  })

  describe('Accept', () => {
    it('on a prospect names the software it will add, and sends no extra flag', async () => {
      api.getProposalRequest = vi.fn(async () => WITH_SOFTWARE)
      const confirm = vi.fn(() => true)
      vi.stubGlobal('confirm', confirm)
      renderEditor()
      fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
      expect(confirm).toHaveBeenCalledWith(
        PROSPECT_CONFIRM(', with QBO Plus as monthly Software expenses billed at cost'),
      )
      await waitFor(() =>
        expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
      )
    })

    it('puts the ticked plans before the software clause in the new-client confirm', async () => {
      contextValue.data.plans = [
        { id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' },
        { id: 'plan-2', name: 'Payroll', notes: '' },
      ] as unknown as SubscriptionPlan[]
      api.getProposalRequest = vi.fn(async () => WITH_SOFTWARE)
      const confirm = vi.fn(() => true)
      vi.stubGlobal('confirm', confirm)
      renderEditor()
      fireEvent.click(await screen.findByRole('button', { name: 'Plans' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Monthly Bookkeeping' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Payroll' }))
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      expect(confirm).toHaveBeenCalledWith(
        PROSPECT_CONFIRM(
          ', with the plans Monthly Bookkeeping and Payroll, and with QBO Plus as monthly Software expenses billed at cost',
        ),
      )
    })

    it('an upsell names the software signing will add, in the one question, and sends no flag', async () => {
      api.getProposalRequest = vi.fn(async () => ({ ...WITH_SOFTWARE, clientId: 'client-1' }))
      const confirm = vi.fn(() => true)
      vi.stubGlobal('confirm', confirm)
      renderEditor()
      fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(confirm).toHaveBeenCalledWith(
        `Accept this proposal for Existing Co? ${WON_DRAFTED} Nothing changes for Existing Co until the letter is marked signed: then the letter's $630.00 is added to their monthly fee (you can choose replace or keep on the letter) and QBO Plus is added as monthly Software expenses billed at cost.`,
      )
      await waitFor(() =>
        expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
      )
    })

    it('an upsell whose only software is $0 names no software', async () => {
      api.getProposalRequest = vi.fn(async () => ({
        ...WITH_SOFTWARE,
        clientId: 'client-1',
        pricingSnapshot: {
          ...WITH_SOFTWARE.pricingSnapshot!,
          lines: [...PROPOSAL.pricingSnapshot!.lines, SOFTWARE_LINES[1]],
          totals: { ...WITH_SOFTWARE.pricingSnapshot!.totals, software: 0 },
        },
      }))
      const confirm = vi.fn(() => true)
      vi.stubGlobal('confirm', confirm)
      renderEditor()
      fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
      expect(confirm).toHaveBeenCalledWith(
        `Accept this proposal for Existing Co? ${WON_DRAFTED} Nothing changes for Existing Co until the letter is marked signed: then the letter's $630.00 is added to their monthly fee (you can choose replace or keep on the letter).`,
      )
      await waitFor(() =>
        expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
      )
      expect(confirm).toHaveBeenCalledTimes(1)
    })
  })
})

describe('the software total in a letter (featreq-a69a3cc0)', () => {
  const snapshot = {
    rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    lines: [],
    totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0, software: 98 },
    catalogAt: '2026-10-01T12:00:00.000Z',
  }
  const letter = (text: string) => ({ subject: 's', sections: [], text })

  it('a letter that quotes the software total is not stale; one that quotes another figure is', () => {
    expect(
      staleLetterFigureCount({ letter: letter('Software is $98.00 a month at cost.'), pricingSnapshot: snapshot }),
    ).toBe(0)
    expect(
      staleLetterFigureCount({ letter: letter('Software is $104.00 a month at cost.'), pricingSnapshot: snapshot }),
    ).toBe(1)
  })
})

// Engagements stage 2C (docs/plans/engagements-2026-10.md): Accept drafts the
// engagement letter and the page goes straight to it; a Won proposal links its
// engagement, or offers to draft one when it has none.
describe('the engagement a Won proposal drafts', () => {
  /** The engagement route shows the notice Accept handed over, as the editor does. */
  function EngagementStub() {
    const state = useLocation().state as { notice?: string } | null
    return (
      <>
        <p>Engagement editor</p>
        {state?.notice ? <p>{state.notice}</p> : null}
      </>
    )
  }

  function renderEditorWithEngagements() {
    render(
      <MemoryRouter initialEntries={['/proposals/prop-1']}>
        <Routes>
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
          <Route path="/engagements/:engagementId" element={<EngagementStub />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  const WON = { ...PROPOSAL, status: 'accepted' as const, clientId: null }
  // A proposal Won before engagements: it was linked to the client its Accept created.
  const WON_LEGACY = { ...PROPOSAL, status: 'accepted' as const, clientId: 'client-new' }

  it('after Accept opens the engagement Accept drafted, saying the client comes at signing', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    api.acceptProposalRequest = vi.fn(async () => ({
      proposal: WON,
      clientId: null,
      packageApplied: false,
      engagementId: 'eng-7',
    }))
    renderEditorWithEngagements()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('Engagement editor')).toBeTruthy()
    expect(
      screen.getByText('Marked Won. Acme Books becomes a client when this letter is marked signed.'),
    ).toBeTruthy()
  })

  it('a chosen package no longer holds the page back: it rides on the engagement Accept opens', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    api.acceptProposalRequest = vi.fn(async () => ({
      proposal: WON,
      clientId: null,
      packageApplied: false,
      engagementId: 'eng-7',
    }))
    renderEditorWithEngagements()
    await waitFor(() => expect(api.listPackagesRequest).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText('Package to apply when signed'), { target: { value: 'pkg-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('Engagement editor')).toBeTruthy()
    expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: 'pkg-1' })
  })

  it('"Open the client" waits for the engagement to be signed', async () => {
    api.getProposalRequest = vi.fn(async () => WON)
    api.listEngagementsRequest = vi.fn(async () => [{ id: 'eng-3', status: 'sent', clientId: null }])
    const { unmount } = render(
      <MemoryRouter initialEntries={['/proposals/prop-1']}>
        <Routes>
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: 'Open the engagement' })
    expect(screen.queryByRole('link', { name: 'Open the client' })).toBeNull()
    unmount()

    api.listEngagementsRequest = vi.fn(async () => [{ id: 'eng-3', status: 'signed', clientId: 'client-signed' }])
    renderEditorWithEngagements()
    const link = await screen.findByRole('link', { name: 'Open the client' })
    expect(link.getAttribute('href')).toBe('/clients/client-signed')
  })

  it('an upsell Won proposal opens its client even before the letter is signed', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...WON, clientId: 'client-1' }))
    api.listEngagementsRequest = vi.fn(async () => [{ id: 'eng-3', status: 'sent', clientId: 'client-1' }])
    renderEditorWithEngagements()
    const link = await screen.findByRole('link', { name: 'Open the client' })
    expect(link.getAttribute('href')).toBe('/clients/client-1')
  })

  it('when no letter could be drafted, the proposal says so with the reason, and the package and plans were kept', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    api.acceptProposalRequest = vi.fn(async () => ({
      proposal: WON,
      clientId: null,
      packageApplied: false,
      engagementId: null,
      engagementError: 'The library has no email section. Nothing was drafted.',
    }))
    renderEditorWithEngagements()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(
      await screen.findByText(
        /^Accepted - the engagement could not be drafted: The library has no email section\. Nothing was drafted\. Use Draft the engagement at the top of the page\. The package and plans you picked are kept\./,
      ),
    ).toBeTruthy()
    // The way to draft it by hand stays on the page.
    expect(await screen.findByRole('button', { name: 'Draft the engagement' })).toBeTruthy()
  })

  it('when Accept gave no reason, the line still says why in plain words', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditorWithEngagements()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(
      await screen.findByText(/^Accepted - the engagement could not be drafted: it could not be saved\. Use Draft the engagement at the top of the page\./),
    ).toBeTruthy()
  })

  it('looks the engagement up again when another tab or session changes data', async () => {
    api.getProposalRequest = vi.fn(async () => WON)
    api.listEngagementsRequest = vi.fn(async () => [])
    // A new element each time: the same one would let React skip the re-render.
    const tree = () => (
      <MemoryRouter initialEntries={['/proposals/prop-1']}>
        <Routes>
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
        </Routes>
      </MemoryRouter>
    )
    const { rerender } = render(tree())
    expect(await screen.findByRole('button', { name: 'Draft the engagement' })).toBeTruthy()
    expect(api.listEngagementsRequest).toHaveBeenCalledTimes(1)
    // The letter is drafted from another tab; the broadcast bumps dataRefreshCount.
    api.listEngagementsRequest = vi.fn(async () => [{ id: 'eng-5', status: 'draft' }])
    contextValue = { ...contextValue, dataRefreshCount: 1 } as typeof contextValue
    rerender(tree())
    const link = await screen.findByRole('link', { name: 'Open the engagement' })
    expect(link.getAttribute('href')).toBe('/engagements/eng-5')
    expect(screen.queryByRole('button', { name: 'Draft the engagement' })).toBeNull()
  })

  it('a proposal Won before engagements, with none drafted, still opens the client it created', async () => {
    api.getProposalRequest = vi.fn(async () => WON_LEGACY)
    renderEditorWithEngagements()
    const link = await screen.findByRole('link', { name: 'Open the client' })
    expect(link.getAttribute('href')).toBe('/clients/client-new')
    expect(await screen.findByRole('button', { name: 'Draft the engagement' })).toBeTruthy()
  })

  it('stays on the proposal when Accept drafted none', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditorWithEngagements()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('Won', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.queryByText('Engagement editor')).toBeNull()
  })

  it('a Won proposal links its engagement', async () => {
    api.getProposalRequest = vi.fn(async () => WON)
    api.listEngagementsRequest = vi.fn(async () => [
      { id: 'eng-old', status: 'void' },
      { id: 'eng-3', status: 'sent' },
    ])
    renderEditorWithEngagements()
    const link = await screen.findByRole('link', { name: 'Open the engagement' })
    expect(link.getAttribute('href')).toBe('/engagements/eng-3')
    expect(api.listEngagementsRequest).toHaveBeenCalledWith({ proposalId: 'prop-1' })
    expect(screen.queryByRole('button', { name: 'Draft the engagement' })).toBeNull()
  })

  it('a Won proposal with none offers to draft one, then opens it', async () => {
    api.getProposalRequest = vi.fn(async () => WON)
    api.draftProposalEngagementRequest = vi.fn(async () => ({ id: 'eng-new' }))
    renderEditorWithEngagements()
    fireEvent.click(await screen.findByRole('button', { name: 'Draft the engagement' }))
    expect(await screen.findByText('Engagement editor')).toBeTruthy()
    expect(api.draftProposalEngagementRequest).toHaveBeenCalledWith('prop-1')
  })

  it('opens the one that exists when the draft is refused as a duplicate', async () => {
    api.getProposalRequest = vi.fn(async () => WON)
    api.draftProposalEngagementRequest = vi.fn(async () => {
      throw Object.assign(new ApiError(409, 'It has one.', 'engagement_refused', 'exists'), { engagementId: 'eng-9' })
    })
    renderEditorWithEngagements()
    fireEvent.click(await screen.findByRole('button', { name: 'Draft the engagement' }))
    expect(await screen.findByText('Engagement editor')).toBeTruthy()
  })

  it('a draft proposal never looks for an engagement', async () => {
    renderEditorWithEngagements()
    await screen.findByRole('button', { name: 'Accept' })
    expect(api.listEngagementsRequest).not.toHaveBeenCalled()
  })
})
