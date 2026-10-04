import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { buildQuestionnaire } from '../../lib/proposal-questionnaire.js'
import { defaultProposalPricing } from '../../lib/proposal-pricing.js'
import { ProposalEditorPage } from '../pages/ProposalEditorPage'
import { ProposalsPage } from '../pages/ProposalsPage'
import { ApiError, type Proposal, type ProposalQuestionnaire } from '../lib/types'

/**
 * The questionnaire in the UI (featreq-8f139178): the call sheet, the inbox on
 * the Proposals page, and the read-only panel on a draft's Estimate tab. The
 * server decides everything that matters (what is valid, whether a draft got
 * made); these pin what the pages ask it for and what they show.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listProposalsRequest: (...args: unknown[]) => api.listProposalsRequest(...args),
  createProposalRequest: (...args: unknown[]) => api.createProposalRequest(...args),
  getProposalRequest: (...args: unknown[]) => api.getProposalRequest(...args),
  fetchFirmSettings: (...args: unknown[]) => api.fetchFirmSettings(...args),
  listPackagesRequest: (...args: unknown[]) => api.listPackagesRequest(...args),
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

const pricing = defaultProposalPricing()

const DRAFT: Proposal = {
  id: 'prop-draft',
  status: 'draft',
  prospect: {
    company: 'Acme Books',
    contactName: 'Pat Doe',
    title: 'Owner',
    email: 'pat@acme.test',
    phone: '',
    addressLine1: '1 Main St',
    addressLine2: '',
    city: 'Nashville',
    state: 'TN',
    postalCode: '37201',
    notes: '',
  },
  clientId: null,
  inputs: { transactions: 120 },
  selections: [],
  pricingSnapshot: {
    rates: { bookkeeper: 75, accountant: 115, controller: 125 },
    lines: [],
    totals: { monthly: 0, annual: 0, oneTime: 0, cleanup: 0 },
    catalogAt: '2026-10-04T12:00:00.000Z',
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
  createdBy: null,
  createdAt: '2026-10-04T12:00:00.000Z',
  updatedAt: '2026-10-04T12:00:00.000Z',
}

const PRICED: Proposal = {
  ...DRAFT,
  id: 'prop-priced',
  prospect: { ...DRAFT.prospect, company: 'Priced Co' },
  selections: [{ serviceId: 'monthly-weekly-transactions-basic' }],
  pricingSnapshot: { ...DRAFT.pricingSnapshot!, totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0 } },
}

function questionnaire(overrides: Partial<ProposalQuestionnaire> = {}): ProposalQuestionnaire {
  return {
    id: 'pq-1',
    mode: 'call',
    status: 'open',
    expired: false,
    questions: buildQuestionnaire(pricing) as ProposalQuestionnaire['questions'],
    answers: {},
    emailLog: [],
    proposalId: null,
    sentTo: null,
    expiresAt: null,
    submittedAt: null,
    createdBy: 'emp-patrice',
    createdAt: '2026-10-04T12:00:00.000Z',
    updatedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  contextValue = {
    ownerMode: true,
    data: { clients: [] },
  } as unknown as AppContextValue
  api.listProposalsRequest = vi.fn(async () => [DRAFT, PRICED])
  api.createProposalRequest = vi.fn()
  api.getProposalRequest = vi.fn(async () => DRAFT)
  api.fetchFirmSettings = vi.fn(async () => ({ name: 'PB&J', proposalPricing: pricing }))
  api.listPackagesRequest = vi.fn(async () => [])
  api.listQuestionnairesRequest = vi.fn(async () => [])
  api.createQuestionnaireRequest = vi.fn(async () => questionnaire())
  api.saveQuestionnaireAnswersRequest = vi.fn(async () => questionnaire())
  api.submitQuestionnaireRequest = vi.fn(async () => ({
    questionnaire: questionnaire({ status: 'submitted', proposalId: 'prop-draft' }),
    proposal: DRAFT,
  }))
  api.startQuestionnaireDraftRequest = vi.fn(async () => ({
    questionnaire: questionnaire({ status: 'submitted', proposalId: 'prop-draft' }),
    proposal: DRAFT,
  }))
  api.withdrawQuestionnaireRequest = vi.fn(async () => questionnaire({ status: 'withdrawn' }))
})

function renderList() {
  render(
    <MemoryRouter initialEntries={['/proposals']}>
      <Routes>
        <Route path="/proposals" element={<ProposalsPage />} />
        <Route path="/proposals/:proposalId" element={<p>Editor for the draft</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the Proposals list', () => {
  it('says "Not priced yet" for a draft with nothing selected, never $0.00', async () => {
    renderList()
    const row = (await screen.findByRole('link', { name: 'Acme Books' })).closest('tr')!
    expect(within(row).getByText('Not priced yet')).toBeInTheDocument()
    expect(within(row).queryByText('$0.00')).not.toBeInTheDocument()
    const priced = screen.getByRole('link', { name: 'Priced Co' }).closest('tr')!
    expect(within(priced).getByText('$630.00')).toBeInTheDocument()
  })
})

describe('Fill in on the call', () => {
  it('opens a call sheet with her welcome text, every section, and the call-only questions marked', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in on the call' }))
    const sheet = await screen.findByRole('region', { name: 'Call sheet' })
    expect(api.createQuestionnaireRequest).toHaveBeenCalledWith({ mode: 'call' })
    expect(within(sheet).getByText(/keep the perfect books/)).toBeInTheDocument()
    expect(within(sheet).getByText('About you')).toBeInTheDocument()
    expect(within(sheet).getByText('Anything else')).toBeInTheDocument()
    // The account count a prospect could not know is here, flagged for the call.
    const balanceSheet = within(sheet).getByLabelText('Balance sheet accounts')
    expect(balanceSheet).toBeInTheDocument()
    expect(within(sheet).getAllByText('(ask on the call)').length).toBeGreaterThan(0)
  })

  it('saves what she typed when she leaves a field', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in on the call' }))
    const company = await screen.findByLabelText('Business name')
    fireEvent.change(company, { target: { value: 'Acme Books' } })
    fireEvent.blur(company)
    await waitFor(() =>
      expect(api.saveQuestionnaireAnswersRequest).toHaveBeenCalledWith('pq-1', {
        company: 'Acme Books',
      }),
    )
  })

  it('submits the answers and lands on the draft that was started', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in on the call' }))
    fireEvent.change(await screen.findByLabelText('Business name'), { target: { value: 'Acme Books' } })
    fireEvent.change(screen.getByLabelText(/About how many bank and credit card transactions/), {
      target: { value: '120' },
    })
    fireEvent.click(screen.getByLabelText(/Monthly bookkeeping/))
    fireEvent.click(screen.getByRole('button', { name: 'Submit and start the draft' }))
    await waitFor(() => expect(screen.getByText('Editor for the draft')).toBeInTheDocument())
    const [id, answers] = api.submitQuestionnaireRequest.mock.calls[0]
    expect(id).toBe('pq-1')
    expect(answers).toMatchObject({
      company: 'Acme Books',
      'count:transactions': '120',
      services: ['Monthly'],
    })
  })

  it('shows the server’s sentence when it refuses, and keeps the sheet', async () => {
    api.submitQuestionnaireRequest = vi.fn(async () => {
      throw new ApiError(400, 'Enter a business name or a contact name.')
    })
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in on the call' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit and start the draft' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a business name or a contact name.')
    expect(screen.getByRole('region', { name: 'Call sheet' })).toBeInTheDocument()
  })

  it('discarding a sheet withdraws it', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Fill in on the call' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard this sheet' }))
    await waitFor(() => expect(api.withdrawQuestionnaireRequest).toHaveBeenCalledWith('pq-1'))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Call sheet' })).not.toBeInTheDocument(),
    )
  })
})

describe('the questionnaire inbox', () => {
  const waiting = questionnaire({ id: 'pq-wait', answers: { company: 'Waiting Co' } })
  const answered = questionnaire({
    id: 'pq-done',
    status: 'submitted',
    proposalId: 'prop-draft',
    answers: { company: 'Answered Co' },
    submittedAt: '2026-10-04T15:00:00.000Z',
  })
  const noDraft = questionnaire({
    id: 'pq-nodraft',
    status: 'submitted',
    proposalId: null,
    answers: { contactName: 'Pat Doe' },
  })
  const expired = questionnaire({
    id: 'pq-old',
    mode: 'link',
    expired: true,
    answers: { company: 'Old Co' },
  })
  const withdrawn = questionnaire({ id: 'pq-gone', status: 'withdrawn', answers: { company: 'Gone Co' } })

  it('sorts them into Waiting, Answered and Expired', async () => {
    api.listQuestionnairesRequest = vi.fn(async () => [waiting, answered, noDraft, expired, withdrawn])
    renderList()
    const inbox = await screen.findByRole('region', { name: 'Questionnaires' })
    const group = (title: string) => within(inbox).getByRole('heading', { name: new RegExp(`^${title}`) }).parentElement!
    expect(within(group('Waiting')).getByText('Waiting Co')).toBeInTheDocument()
    expect(within(group('Answered')).getByText('Answered Co')).toBeInTheDocument()
    expect(within(group('Answered')).getByText('Pat Doe')).toBeInTheDocument()
    expect(within(group('Expired')).getByText('Old Co')).toBeInTheDocument()
    expect(within(group('Expired')).getByText('Gone Co')).toBeInTheDocument()
    expect(within(group('Expired')).getByText('Withdrawn')).toBeInTheDocument()
  })

  it('shows nothing at all when there are none', async () => {
    renderList()
    await screen.findByRole('link', { name: 'Acme Books' })
    expect(screen.queryByRole('region', { name: 'Questionnaires' })).not.toBeInTheDocument()
  })

  it('links an answered one to its draft, and offers Start draft when there is none', async () => {
    api.listQuestionnairesRequest = vi.fn(async () => [answered, noDraft])
    renderList()
    const inbox = await screen.findByRole('region', { name: 'Questionnaires' })
    expect(within(inbox).getAllByRole('link', { name: 'Open the draft' })).toHaveLength(1)
    expect(within(inbox).getByText('The draft was not started.')).toBeInTheDocument()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Start draft' }))
    await waitFor(() => expect(api.startQuestionnaireDraftRequest).toHaveBeenCalledWith('pq-nodraft'))
    await waitFor(() => expect(screen.getByText('Editor for the draft')).toBeInTheDocument())
  })

  it('resumes a waiting call sheet with its saved answers', async () => {
    api.listQuestionnairesRequest = vi.fn(async () => [waiting])
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    const sheet = await screen.findByRole('region', { name: 'Call sheet' })
    expect(within(sheet).getByLabelText('Business name')).toHaveValue('Waiting Co')
  })

  it('withdraws a waiting one', async () => {
    api.listQuestionnairesRequest = vi.fn(async () => [waiting])
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }))
    await waitFor(() => expect(api.withdrawQuestionnaireRequest).toHaveBeenCalledWith('pq-wait'))
  })
})

describe('the Estimate tab', () => {
  function renderEditor() {
    render(
      <MemoryRouter initialEntries={['/proposals/prop-draft']}>
        <Routes>
          <Route path="/proposals/:proposalId" element={<ProposalEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('shows what the prospect said, read-only, under From the questionnaire', async () => {
    api.listQuestionnairesRequest = vi.fn(async () => [
      questionnaire({
        status: 'submitted',
        proposalId: 'prop-draft',
        answers: {
          company: 'Acme Books',
          whatTheyDo: 'We sell pastries',
          services: ['Monthly', 'Payroll'],
        },
        submittedAt: '2026-10-04T15:00:00.000Z',
      }),
    ])
    renderEditor()
    const panel = await screen.findByRole('region', { name: 'From the questionnaire' })
    expect(api.listQuestionnairesRequest).toHaveBeenCalledWith('prop-draft')
    expect(within(panel).getByText('We sell pastries')).toBeInTheDocument()
    expect(within(panel).getByText(/Monthly bookkeeping.*Payroll/)).toBeInTheDocument()
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('has no such panel for a proposal that did not come from one', async () => {
    renderEditor()
    await screen.findByDisplayValue('Acme Books')
    expect(screen.queryByRole('region', { name: 'From the questionnaire' })).not.toBeInTheDocument()
  })

  it('edits the title and address the questionnaire filled in', async () => {
    renderEditor()
    expect(await screen.findByLabelText('Title')).toHaveValue('Owner')
    expect(screen.getByLabelText('Address')).toHaveValue('1 Main St')
    expect(screen.getByLabelText('ZIP code')).toHaveValue('37201')
  })
})

describe('Send questionnaire', () => {
  const link = 'https://app.pbjsa.com/questionnaire/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
  const waitingLink = questionnaire({
    id: 'pq-link',
    mode: 'link',
    answers: {},
    sentTo: 'pat@acme.test',
    expiresAt: '2026-11-03T15:00:00.000Z',
    link,
  })

  it('asks for the address, and only Send with one filled in goes out', async () => {
    api.sendQuestionnaireRequest = vi.fn(async () => ({
      questionnaire: waitingLink,
      emailed: { ok: true, to: 'pat@acme.test', error: null },
    }))
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Send questionnaire' }))
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Prospect email'), { target: { value: 'pat@acme.test' } })
    expect(send).toBeEnabled()
    fireEvent.click(send)
    await waitFor(() => expect(api.sendQuestionnaireRequest).toHaveBeenCalledWith('pat@acme.test'))
    expect(await screen.findByText('The questionnaire was emailed to pat@acme.test.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Prospect email')).not.toBeInTheDocument()
  })

  it('says when the email did not go, and that the link is made anyway', async () => {
    api.sendQuestionnaireRequest = vi.fn(async () => ({
      questionnaire: waitingLink,
      emailed: { ok: false, to: 'pat@acme.test', error: 'Email is not configured yet.' },
    }))
    api.listQuestionnairesRequest = vi.fn(async () => [waitingLink])
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Send questionnaire' }))
    fireEvent.change(screen.getByLabelText('Prospect email'), { target: { value: 'pat@acme.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The link is made, but the email to pat@acme.test did not go')
    expect(alert).toHaveTextContent('Email is not configured yet.')
  })

  it('shows the server’s sentence when it refuses the address', async () => {
    api.sendQuestionnaireRequest = vi.fn(async () => {
      throw new ApiError(400, 'A valid email address is required.')
    })
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Send questionnaire' }))
    fireEvent.change(screen.getByLabelText('Prospect email'), { target: { value: 'pat@acme.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A valid email address is required.')
  })

  it('a waiting link can be copied, sent again to the same address, or withdrawn', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    api.listQuestionnairesRequest = vi.fn(async () => [waitingLink])
    api.renewQuestionnaireLinkRequest = vi.fn(async () => ({
      questionnaire: waitingLink,
      emailed: { ok: true, to: 'pat@acme.test', error: null },
    }))
    renderList()
    const inbox = await screen.findByRole('region', { name: 'Questionnaires' })
    expect(within(inbox).getByText(/sent to pat@acme.test/)).toBeInTheDocument()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link))
    fireEvent.click(within(inbox).getByRole('button', { name: 'Send again' }))
    await waitFor(() =>
      expect(api.renewQuestionnaireLinkRequest).toHaveBeenCalledWith('pq-link', 'pat@acme.test'),
    )
    // A link is not a call sheet: there is nothing to resume.
    expect(within(inbox).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it('an expired or withdrawn link gets a New link, without emailing anyone', async () => {
    api.listQuestionnairesRequest = vi.fn(async () => [
      questionnaire({ id: 'pq-old', mode: 'link', expired: true, sentTo: 'pat@acme.test' }),
    ])
    api.renewQuestionnaireLinkRequest = vi.fn(async () => ({
      questionnaire: waitingLink,
      emailed: null,
    }))
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'New link' }))
    await waitFor(() =>
      expect(api.renewQuestionnaireLinkRequest).toHaveBeenCalledWith('pq-old', undefined),
    )
    expect(await screen.findByText('The link is ready - use Copy link below.')).toBeInTheDocument()
  })
})
