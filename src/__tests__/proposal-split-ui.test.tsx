import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import { SPLIT_LEAVE_ONE } from '../../lib/proposal-split.js'
import { ProposalEditorPage } from '../pages/ProposalEditorPage'
import { ProposalsPage } from '../pages/ProposalsPage'
import { proposalActivity } from '../lib/proposals'
import { ApiError, type PricedLine, type Proposal } from '../lib/types'

/**
 * Splitting a proposal into parts (featreq-23b26bb1), in the UI. The server
 * moves the lines and prices both parts (db/store-staleness.test.mjs, both
 * backends); these pin what the pages ask it for and what they show.
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
  splitProposalRequest: (...args: unknown[]) => api.splitProposalRequest(...args),
  deleteProposalRequest: (...args: unknown[]) => api.deleteProposalRequest(...args),
  draftProposalLetterRequest: (...args: unknown[]) => api.draftProposalLetterRequest(...args),
  sendProposalRequest: (...args: unknown[]) => api.sendProposalRequest(...args),
  listPackagesRequest: (...args: unknown[]) => api.listPackagesRequest(...args),
  acceptProposalRequest: (...args: unknown[]) => api.acceptProposalRequest(...args),
  declineProposalRequest: (...args: unknown[]) => api.declineProposalRequest(...args),
  proposalChatRequest: (...args: unknown[]) => api.proposalChatRequest(...args),
  listQuestionnairesRequest: (...args: unknown[]) => api.listQuestionnairesRequest(...args),
  createQuestionnaireRequest: (...args: unknown[]) => api.createQuestionnaireRequest(...args),
  saveQuestionnaireAnswersRequest: (...args: unknown[]) => api.saveQuestionnaireAnswersRequest(...args),
  submitQuestionnaireRequest: (...args: unknown[]) => api.submitQuestionnaireRequest(...args),
  startQuestionnaireDraftRequest: (...args: unknown[]) => api.startQuestionnaireDraftRequest(...args),
  withdrawQuestionnaireRequest: (...args: unknown[]) => api.withdrawQuestionnaireRequest(...args),
  sendQuestionnaireRequest: (...args: unknown[]) => api.sendQuestionnaireRequest(...args),
  renewQuestionnaireLinkRequest: (...args: unknown[]) => api.renewQuestionnaireLinkRequest(...args),
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const line = (
  serviceId: string,
  group: PricedLine['group'],
  name: string,
  amount: number,
  tier: PricedLine['tier'] = null,
): PricedLine =>
  ({
    serviceId,
    group,
    name,
    tier,
    cadence: null,
    amount,
    computedAmount: amount,
    formula: `${name} = ${amount}`,
    flag: null,
  }) as PricedLine

const MONTHLY_LINE = line('monthly-monthly-transactions-basic', 'Monthly', 'Monthly transactions', 67.5, 'Basic')
const RECON_LINE = line('reconciliations', 'Reconciliations', 'Reconciliations', 37.5)
const CLEANUP_LINE = line('cleanup-transactions-basic', 'Clean-up', 'Monthly transactions', 202.5, 'Basic')

const WHOLE: Proposal = {
  id: 'prop-1',
  status: 'draft',
  prospect: {
    company: 'Lantern Foundation',
    contactName: 'Brandon Doe',
    title: '',
    email: 'brandon@lantern.test',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    notes: '',
  },
  clientId: null,
  inputs: { transactions: 30, balanceSheetAccounts: 2, cleanupMonths: 3 },
  selections: [
    { serviceId: 'monthly-monthly-transactions-basic' },
    { serviceId: 'reconciliations' },
    { serviceId: 'cleanup-transactions-basic' },
  ],
  pricingSnapshot: {
    rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    lines: [MONTHLY_LINE, RECON_LINE, CLEANUP_LINE],
    totals: { monthly: 105, annual: 0, oneTime: 0, cleanup: 202.5 },
    catalogAt: '2026-11-10T12:00:00.000Z',
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
  splitFromId: null,
  createdBy: 'emp-patrice',
  createdAt: '2026-11-10T12:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z',
} as Proposal

/** What the server answers after the clean-up line is split off. */
const KEPT: Proposal = {
  ...WHOLE,
  selections: WHOLE.selections.slice(0, 2),
  pricingSnapshot: {
    ...WHOLE.pricingSnapshot!,
    lines: [MONTHLY_LINE, RECON_LINE],
    totals: { monthly: 105, annual: 0, oneTime: 0, cleanup: 0 },
  },
} as Proposal
const PART: Proposal = {
  ...WHOLE,
  id: 'prop-part',
  splitFromId: 'prop-1',
  selections: [{ serviceId: 'cleanup-transactions-basic' }],
  pricingSnapshot: {
    ...WHOLE.pricingSnapshot!,
    lines: [CLEANUP_LINE],
    totals: { monthly: 0, annual: 0, oneTime: 0, cleanup: 202.5 },
  },
  createdAt: '2026-11-12T12:00:00.000Z',
} as Proposal

beforeEach(() => {
  contextValue = {
    ownerMode: true,
    dataRefreshCount: 0,
    data: { clients: [], plans: [], contacts: [] },
  } as unknown as AppContextValue
  api.listProposalsRequest = vi.fn(async () => [WHOLE])
  api.getProposalRequest = vi.fn(async () => WHOLE)
  api.fetchFirmSettings = vi.fn(async () => ({
    name: 'PB&J',
    proposalPricing: { ...defaultProposalPricing(), rates: { bookkeeper: 75, accountant: 115, controller: 125 } },
  }))
  api.splitProposalRequest = vi.fn(async () => ({ proposal: KEPT, part: PART }))
  api.updateProposalRequest = vi.fn(async () => WHOLE)
  api.repriceProposalRequest = vi.fn(async () => WHOLE)
  api.listPackagesRequest = vi.fn(async () => [])
  api.listQuestionnairesRequest = vi.fn(async () => [])
  api.listEngagementsRequest = vi.fn(async () => [])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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

const openDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Split' }))
  return screen.getByRole('dialog', { name: 'Split this proposal' })
}

describe('the Split button', () => {
  it('is offered on a draft with two or more lines', async () => {
    renderEditor()
    expect(await screen.findByRole('button', { name: 'Split' })).toBeTruthy()
  })

  it('is offered on a Sent proposal too', async () => {
    api.getProposalRequest = vi.fn(async () => ({ ...WHOLE, status: 'sent' }))
    renderEditor()
    expect(await screen.findByRole('button', { name: 'Split' })).toBeTruthy()
  })

  it('is not offered with one line, with lines that were never priced, or once the proposal is Won or Closed/Lost', async () => {
    for (const proposal of [
      { ...PART, id: 'prop-1' },
      // Three selections but an old snapshot holding one line: nothing to divide yet.
      { ...WHOLE, pricingSnapshot: { ...WHOLE.pricingSnapshot!, lines: [MONTHLY_LINE] } },
      { ...WHOLE, pricingSnapshot: null },
      { ...WHOLE, status: 'accepted' },
      { ...WHOLE, status: 'declined' },
    ]) {
      api.getProposalRequest = vi.fn(async () => proposal)
      const { unmount } = render(
        <MemoryRouter initialEntries={['/proposals/prop-1']}>
          <Routes>
            <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
          </Routes>
        </MemoryRouter>,
      )
      await screen.findByRole('button', { name: 'Copy to new proposal' })
      expect(screen.queryByRole('button', { name: 'Split' })).toBeNull()
      unmount()
    }
  })
})

describe('the Split dialog', () => {
  it('lists every line with its amount, and nothing can be split until a line is ticked', async () => {
    renderEditor()
    const dialog = await openDialog()
    expect(within(dialog).getByLabelText('Move Monthly: Monthly transactions (Basic)')).toBeTruthy()
    expect(within(dialog).getByLabelText('Move Reconciliations: Reconciliations')).toBeTruthy()
    expect(within(dialog).getByLabelText('Move Clean-up: Monthly transactions (Basic)')).toBeTruthy()
    expect(within(dialog).getByText('$202.50')).toBeTruthy()
    expect(within(dialog).getByTestId('split-stays').textContent).toBe(
      'Stays on this proposal: 3 lines · Monthly $105.00 · Clean-up $202.50',
    )
    expect(within(dialog).getByTestId('split-moves').textContent).toBe('Moves to the new proposal: nothing yet')
    expect((within(dialog).getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true)
    // No letter on this proposal: no note about one.
    expect(within(dialog).queryByTestId('split-letter-note')).toBeNull()
  })

  it('shows what each part comes to as lines are ticked, then asks the server to move exactly those lines', async () => {
    renderEditor()
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByLabelText('Move Clean-up: Monthly transactions (Basic)'))
    expect(within(dialog).getByTestId('split-stays').textContent).toBe(
      'Stays on this proposal: 2 lines · Monthly $105.00',
    )
    expect(within(dialog).getByTestId('split-moves').textContent).toBe(
      'Moves to the new proposal: 1 line · Clean-up $202.50',
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Split off 1 line' }))
    await waitFor(() =>
      expect(api.splitProposalRequest).toHaveBeenCalledWith('prop-1', ['cleanup-transactions-basic']),
    )
    // The dialog closes; the page shows the proposal as the server left it and links the new part.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(
      await screen.findByText(
        /Split\. 1 line moved to a new draft proposal \(Clean-up \$202\.50\)\. This proposal keeps the rest\./,
      ),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the new part' }).getAttribute('href')).toBe('/proposals/prop-part')
    expect(screen.queryByText('Monthly transactions = 202.5')).toBeNull()
    expect(screen.getByText('Reconciliations = 37.5')).toBeTruthy()
  })

  it('refuses to move every line, and says how to move a whole proposal', async () => {
    renderEditor()
    const dialog = await openDialog()
    for (const box of within(dialog).getAllByRole('checkbox')) fireEvent.click(box)
    expect(within(dialog).getByRole('alert').textContent).toBe(SPLIT_LEAVE_ONE)
    expect(within(dialog).getByTestId('split-stays').textContent).toBe('Stays on this proposal: nothing')
    expect((within(dialog).getByRole('button', { name: 'Split off 3 lines' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.splitProposalRequest).not.toHaveBeenCalled()
  })

  it('Escape closes it and moves nothing, and focus starts inside it', async () => {
    renderEditor()
    const dialog = await openDialog()
    expect(document.activeElement).toBe(dialog)
    fireEvent.click(within(dialog).getByLabelText('Move Reconciliations: Reconciliations'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.splitProposalRequest).not.toHaveBeenCalled()
  })

  it('Cancel closes it and moves nothing', async () => {
    renderEditor()
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByLabelText('Move Reconciliations: Reconciliations'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.splitProposalRequest).not.toHaveBeenCalled()
  })

  it("a refusal from the server is shown in its own words and the proposal stays as it was", async () => {
    api.splitProposalRequest = vi.fn(async () => {
      throw new ApiError(409, 'This proposal is Won - only a Draft or Sent proposal can be split.', 'proposal_refused')
    })
    renderEditor()
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByLabelText('Move Reconciliations: Reconciliations'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Split off 1 line' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This proposal is Won - only a Draft or Sent proposal can be split.',
    )
    expect(screen.getByText('Monthly transactions = 202.5')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open the new part' })).toBeNull()
  })

  it('says the letter was written for every line: a sent one, and a draft one', async () => {
    const letter = { subject: 'Your proposal', sections: [], text: 'Dear Brandon' }
    api.getProposalRequest = vi.fn(async () => ({ ...WHOLE, status: 'sent', letter }))
    renderEditor()
    const dialog = await openDialog()
    expect(within(dialog).getByTestId('split-letter-note').textContent).toContain('The letter already sent lists every line')
  })

  it('waits for an edit still being saved, so the server splits what is really there', async () => {
    let finishSave!: (value: Proposal) => void
    api.updateProposalRequest = vi.fn(
      () =>
        new Promise<Proposal>((resolve) => {
          finishSave = resolve
        }),
    )
    renderEditor()
    // An edit goes out and has not come back yet.
    fireEvent.change(await screen.findByLabelText('Company'), { target: { value: 'Lantern Foundation Inc.' } })
    fireEvent.blur(screen.getByLabelText('Company'))
    await waitFor(() => expect(api.updateProposalRequest).toHaveBeenCalled())
    expect((screen.getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true)
    finishSave(WHOLE)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('the parts of a split', () => {
  it('each part names the others, with status and what they hold', async () => {
    api.getProposalRequest = vi.fn(async () => KEPT)
    api.listProposalsRequest = vi.fn(async () => [KEPT, PART])
    renderEditor()
    const strip = await screen.findByTestId('proposal-parts')
    expect(strip.textContent).toContain('One of 2 parts of a split proposal. Other part: ')
    expect(strip.textContent).toContain(
      "Once one part's engagement letter is signed, the other open parts are added to that client.",
    )
    const link = within(strip).getByRole('link', { name: 'Draft · Clean-up $202.50' })
    expect(link.getAttribute('href')).toBe('/proposals/prop-part')
  })

  it('a proposal that was never split shows no parts line', async () => {
    renderEditor()
    await screen.findByRole('button', { name: 'Split' })
    await waitFor(() => expect(api.listProposalsRequest).toHaveBeenCalled())
    expect(screen.queryByTestId('proposal-parts')).toBeNull()
  })

  it('reads the parts again after a split', async () => {
    renderEditor()
    const dialog = await openDialog()
    api.listProposalsRequest = vi.fn(async () => [KEPT, PART])
    fireEvent.click(within(dialog).getByLabelText('Move Clean-up: Monthly transactions (Basic)'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Split off 1 line' }))
    expect((await screen.findByTestId('proposal-parts')).textContent).toContain('One of 2 parts')
  })

  it('the Proposals list tells two rows for one prospect apart', async () => {
    const other: Proposal = { ...WHOLE, id: 'prop-9', prospect: { ...WHOLE.prospect, company: 'Beta Farms' } } as Proposal
    api.listProposalsRequest = vi.fn(async () => [KEPT, PART, other])
    render(
      <MemoryRouter initialEntries={['/proposals']}>
        <Routes>
          <Route path="/proposals" element={<ProposalsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Part of a split · Monthly $105.00')).toBeTruthy()
    expect(screen.getByText('Part of a split · Clean-up $202.50')).toBeTruthy()
    expect(screen.getAllByText(/Part of a split/)).toHaveLength(2)
  })

  it('the Activity tab says where a part came from', () => {
    const [first] = proposalActivity(PART)
    expect(first).toMatchObject({ text: 'Split off from prop-1', href: '/proposals/prop-1' })
    expect(proposalActivity(WHOLE)[0].text).toBe('Created')
    expect(proposalActivity({ ...WHOLE, copiedFromId: 'prop-0' } as Proposal)[0].text).toBe('Created as a copy of prop-0')
    // A copy says it is a copy even if it ever carried both.
    expect(proposalActivity({ ...PART, copiedFromId: 'prop-0' } as Proposal)[0].text).toBe('Created as a copy of prop-0')
  })
})
