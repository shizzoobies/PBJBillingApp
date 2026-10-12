import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { EngagementsPage } from '../pages/EngagementsPage'
import type { Engagement } from '../lib/types'

/**
 * The Engagements list (docs/plans/engagements-2026-10.md, stage 2C): the rows,
 * the status filter, the search by party, and the empty state that says where an
 * engagement comes from.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  listEngagementsRequest: (...args: unknown[]) => api.listEngagementsRequest(...args),
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

function engagementFixture(over: Partial<Engagement> = {}): Engagement {
  return {
    id: 'eng-1',
    kind: 'original',
    status: 'draft',
    proposalId: 'prop-1',
    clientId: null,
    letterId: null,
    supersedesId: null,
    party: {
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
    },
    subject: 'Engagement letter - {{client_name}}',
    sectionKeys: ['intro', 'fees'],
    figures: { totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0, software: 0 }, lines: [] },
    retainerAmount: 630,
    packageId: null,
    planIds: [],
    templateHash: 'h',
    sentAt: null,
    signedAt: null,
    signedBy: null,
    signedNote: null,
    voidedAt: null,
    createdBy: 'user-1',
    createdAt: '2026-10-11T15:00:00.000Z',
    updatedAt: '2026-10-11T15:00:00.000Z',
    ...over,
  }
}

const ROWS: Engagement[] = [
  engagementFixture(),
  engagementFixture({
    id: 'eng-2',
    status: 'signed',
    party: { ...engagementFixture().party, company: 'Blue Fern LLC', contactName: 'Kim Lee', email: 'kim@fern.test' },
    figures: { totals: { monthly: 0, annual: 1200 }, lines: [] },
    sentAt: '2026-10-02T15:00:00.000Z',
    signedAt: '2026-10-05T16:00:00.000Z',
  }),
]

function renderPage() {
  render(
    <MemoryRouter>
      <EngagementsPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  contextValue = { ownerMode: true, dataRefreshCount: 0, data: { clients: [] } } as unknown as AppContextValue
  api.listEngagementsRequest = vi.fn(async () => ROWS)
})

afterEach(() => {
  cleanup()
})

describe('the Engagements list', () => {
  it('lists party, kind, status, monthly fee, sent and signed, each row opening the editor', async () => {
    renderPage()
    const link = await screen.findByRole('link', { name: 'Acme Books' })
    expect(link.getAttribute('href')).toBe('/engagements/eng-1')
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual(['Party', 'Kind', 'Status', 'Monthly fee', 'Sent', 'Signed'])
    const acme = link.closest('tr') as HTMLElement
    expect(within(acme).getByText('Original')).toBeTruthy()
    expect(within(acme).getByText('Draft')).toBeTruthy()
    expect(within(acme).getByText('$630.00')).toBeTruthy()
    const fern = screen.getByRole('link', { name: 'Blue Fern LLC' }).closest('tr') as HTMLElement
    expect(within(fern).getByText('Signed')).toBeTruthy()
    expect(within(fern).getByText('Oct 2, 2026')).toBeTruthy()
    expect(within(fern).getByText('Oct 5, 2026')).toBeTruthy()
  })

  it('filters by status', async () => {
    renderPage()
    await screen.findByRole('link', { name: 'Acme Books' })
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'signed' } })
    expect(screen.queryByRole('link', { name: 'Acme Books' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Blue Fern LLC' })).toBeTruthy()
    const options = within(screen.getByLabelText('Status filter'))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['All', 'Draft', 'Sent', 'Signed', 'Superseded', 'Void'])
  })

  // Engagements stage 4: originals, amendments and superseding letters.
  it('filters by kind', async () => {
    api.listEngagementsRequest = vi.fn(async () => [
      ...ROWS,
      engagementFixture({
        id: 'eng-3',
        kind: 'amendment',
        status: 'sent',
        party: { ...engagementFixture().party, company: 'Gold Leaf Co' },
      }),
    ])
    renderPage()
    await screen.findByRole('link', { name: 'Gold Leaf Co' })
    fireEvent.change(screen.getByLabelText('Kind filter'), { target: { value: 'amendment' } })
    expect(screen.getByRole('link', { name: 'Gold Leaf Co' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Acme Books' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Blue Fern LLC' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Kind filter'), { target: { value: 'original' } })
    expect(screen.queryByRole('link', { name: 'Gold Leaf Co' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Acme Books' })).toBeTruthy()
    // Both filters apply together.
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'signed' } })
    expect(screen.queryByRole('link', { name: 'Acme Books' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Blue Fern LLC' })).toBeTruthy()
    const options = within(screen.getByLabelText('Kind filter'))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['All', 'Original', 'Amendment', 'Superseding'])
  })

  it('searches by the party: company, contact or email', async () => {
    renderPage()
    await screen.findByRole('link', { name: 'Acme Books' })
    fireEvent.change(screen.getByLabelText('Search engagements'), { target: { value: 'kim@' } })
    expect(screen.queryByRole('link', { name: 'Acme Books' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Blue Fern LLC' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search engagements'), { target: { value: 'nobody' } })
    expect(screen.getByText('No engagements match.')).toBeTruthy()
  })

  it('says where engagements come from when there are none', async () => {
    api.listEngagementsRequest = vi.fn(async () => [])
    renderPage()
    expect(await screen.findByText(/An engagement letter is drafted for you when you Accept a proposal/)).toBeTruthy()
  })

  it('shows nothing to staff', () => {
    contextValue = { ...contextValue, ownerMode: false } as AppContextValue
    renderPage()
    expect(api.listEngagementsRequest).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Engagements' })).toBeNull()
  })
})
