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

beforeEach(() => {
  contextValue = {
    ownerMode: true,
    data: { clients: [{ id: 'client-1', name: 'Existing Co' }] },
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
