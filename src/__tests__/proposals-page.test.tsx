import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { ProposalsPage } from '../pages/ProposalsPage'
import type { Proposal } from '../lib/types'

/**
 * Proposals in the UI (featreq-311473e2 / featreq-ef18a38e). The server
 * prices everything; these pin what the pages ask it for and what they show.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listProposalsRequest: (...args: unknown[]) => api.listProposalsRequest(...args),
  createProposalRequest: (...args: unknown[]) => api.createProposalRequest(...args),
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

beforeEach(() => {
  contextValue = { ownerMode: true, data: { clients: [] } } as unknown as AppContextValue
  api.listProposalsRequest = vi.fn(async () => [PROPOSAL, DECLINED])
  api.createProposalRequest = vi.fn(async () => ({ ...PROPOSAL, id: 'prop-new' }))
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
