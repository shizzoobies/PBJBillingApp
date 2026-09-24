import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import { ProposalEditorPage } from '../pages/ProposalEditorPage'
import { ProposalsPage } from '../pages/ProposalsPage'
import { ApiError, type Proposal } from '../lib/types'

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
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const PROPOSAL: Proposal = {
  id: 'prop-1',
  status: 'draft',
  prospect: {
    company: 'Acme Books',
    contactName: 'Pat Doe',
    email: 'pat@acme.test',
    phone: '',
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
  api.acceptProposalRequest = vi.fn(async () => ({
    proposal: { ...PROPOSAL, status: 'accepted', clientId: 'client-new' },
    clientId: 'client-new',
    createdClient: true,
    packageApplied: false,
  }))
  api.declineProposalRequest = vi.fn(async () => ({ ...PROPOSAL, status: 'declined' }))
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

  it('searches company, contact and email', async () => {
    renderList()
    await screen.findByText('Acme Books')
    fireEvent.change(screen.getByLabelText('Search proposals'), { target: { value: 'lee' } })
    expect(screen.queryByText('Acme Books')).toBeNull()
    expect(screen.getByText('Beta Farms')).toBeTruthy()
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

describe('Send to prospect', () => {
  it('asks for the address, prefilled from the prospect, and sends to what she confirms', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    const prompt = vi.fn(() => 'pat@acme.test')
    vi.stubGlobal('prompt', prompt)
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Send to prospect' }))
    expect(prompt).toHaveBeenCalledWith('Send the proposal to which email address?', 'pat@acme.test')
    await waitFor(() => expect(api.sendProposalRequest).toHaveBeenCalledWith('prop-1', 'pat@acme.test'))
  })

  it('sends nothing when she cancels the address prompt', async () => {
    api.getProposalRequest = vi.fn(async () => WITH_LETTER)
    vi.stubGlobal('prompt', vi.fn(() => null))
    renderEditor('/proposals/prop-1?tab=letter')
    fireEvent.click(await screen.findByRole('button', { name: 'Send to prospect' }))
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
})

describe('Accept and Decline', () => {
  it('Accept on a prospect says what it will create, then accepts', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenCalledWith(
      'Accept this proposal? This adds Acme Books as a client in Onboarding, billed monthly at $630.00. Nothing about any invoice changes.',
    )
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: null }),
    )
    expect(await screen.findByText('Accepted', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the client' }).getAttribute('href')).toBe(
      '/clients/client-new',
    )
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
    fireEvent.change(await screen.findByLabelText('Package to apply on accept'), {
      target: { value: 'pkg-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', { packageId: 'pkg-1' }),
    )
  })

  it('an upsell asks separately before it changes the client’s monthly fee', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...PROPOSAL, clientId: 'client-1' }))
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    vi.stubGlobal('confirm', confirm)
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(confirm).toHaveBeenNthCalledWith(1, 'Accept this proposal for Existing Co?')
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Also change Existing Co’s monthly fee to $630.00? Cancel keeps their current fee.',
    )
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', {
        packageId: null,
        updateMonthlyRate: false,
      }),
    )
  })

  it('skips the second question and sends updateMonthlyRate: false when the snapshot is $0', async () => {
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
    await waitFor(() =>
      expect(api.acceptProposalRequest).toHaveBeenCalledWith('prop-1', {
        packageId: null,
        updateMonthlyRate: false,
      }),
    )
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('shows a notice when a chosen package could not be applied', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderEditor()
    await waitFor(() => expect(api.listPackagesRequest).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText('Package to apply on accept'), {
      target: { value: 'pkg-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(
      await screen.findByText(
        "Accepted, but the package could not be applied — add it from the client's page.",
      ),
    ).toBeTruthy()
  })

  it('Decline asks for a note and saves it', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'Went with a friend'))
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    await waitFor(() =>
      expect(api.declineProposalRequest).toHaveBeenCalledWith('prop-1', 'Went with a friend'),
    )
  })
})
