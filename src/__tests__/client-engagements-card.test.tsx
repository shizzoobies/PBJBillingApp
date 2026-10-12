import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ClientEngagementsCard } from '../components/ClientEngagementsCard'
import { ApiError, type Engagement } from '../lib/types'

/**
 * The Engagements card on a client's Billing tab (engagements stage 4): this client's
 * engagement letters newest first with kind, status and dates and an Open link, and
 * "New amendment" from a saved letter, which opens the new draft in the editor.
 * Owner only: staff see nothing.
 */

vi.mock('../lib/api', () => ({
  listEngagementsRequest: (...args: unknown[]) => api.listEngagementsRequest(...args),
  listLettersRequest: (...args: unknown[]) => api.listLettersRequest(...args),
  createAmendmentRequest: (...args: unknown[]) => api.createAmendmentRequest(...args),
}))

const api: Record<string, Mock> = {}

function engagementFixture(over: Partial<Engagement> = {}): Engagement {
  return {
    id: 'eng-1',
    kind: 'original',
    status: 'signed',
    proposalId: 'prop-1',
    clientId: 'c-acme',
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
    sectionKeys: [],
    figures: {},
    retainerAmount: null,
    packageId: null,
    planIds: [],
    templateHash: 'h',
    sentAt: '2026-10-02T15:00:00.000Z',
    signedAt: '2026-10-05T16:00:00.000Z',
    signedBy: 'user-1',
    signedNote: null,
    voidedAt: null,
    createdBy: 'user-1',
    createdAt: '2026-10-01T15:00:00.000Z',
    updatedAt: '2026-10-05T16:00:00.000Z',
    ...over,
  }
}

const ROWS: Engagement[] = [
  engagementFixture({
    id: 'eng-amend',
    kind: 'amendment',
    status: 'sent',
    proposalId: null,
    letterId: 'letter-1099',
    subject: 'Your 2027 1099s',
    sentAt: '2026-10-11T15:00:00.000Z',
    signedAt: null,
    signedBy: null,
  }),
  engagementFixture(),
]

function EditorStub() {
  const { id } = useParams()
  return <p>Editor for {id}</p>
}

function renderCard(ownerMode = true) {
  render(
    <MemoryRouter initialEntries={['/clients/c-acme']}>
      <Routes>
        <Route path="/clients/:id" element={<ClientEngagementsCard clientId="c-acme" ownerMode={ownerMode} />} />
        <Route path="/engagements/:id" element={<EditorStub />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  api.listEngagementsRequest = vi.fn(async () => ROWS)
  api.listLettersRequest = vi.fn(async () => ({
    letters: [
      { id: 'letter-1099', name: '1099 Filing', subject: 'Your 1099s', updatedAt: null, sendCount: 2 },
      { id: 'letter-fee', name: 'Fee change', subject: 'Your new fee', updatedAt: null, sendCount: 0 },
    ],
    placeholders: [],
    sender: { from: '', replyTo: '' },
    teamAddresses: [],
  }))
  api.createAmendmentRequest = vi.fn(async (_clientId: string, letterId: string) =>
    engagementFixture({ id: 'eng-new', kind: 'amendment', status: 'draft', letterId }),
  )
})

afterEach(() => {
  cleanup()
})

describe('ClientEngagementsCard', () => {
  it("lists this client's engagements newest first with kind, status, dates and an Open link", async () => {
    renderCard()
    expect(api.listEngagementsRequest).toHaveBeenCalledWith({ clientId: 'c-acme' })
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Amendment')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Sent')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Your 2027 1099s')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Original')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Signed')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('link', { name: /Open/ })).toHaveAttribute('href', '/engagements/eng-amend')
    expect(within(rows[1]).getByRole('link', { name: /Open/ })).toHaveAttribute('href', '/engagements/eng-1')
  })

  it('says where engagements come from when the client has none', async () => {
    api.listEngagementsRequest = vi.fn(async () => [])
    renderCard()
    expect(await screen.findByText(/No engagement letters for this client yet/)).toBeInTheDocument()
  })

  it('New amendment picks a saved letter, starts the draft and opens it in the editor', async () => {
    renderCard()
    await screen.findByRole('table')
    expect(api.listLettersRequest).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New amendment' }))
    const select = await screen.findByRole('combobox', { name: 'Letter for the amendment' })
    await waitFor(() => expect(select).toHaveValue('letter-1099'))
    fireEvent.change(select, { target: { value: 'letter-fee' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start the amendment' }))
    expect(await screen.findByText('Editor for eng-new')).toBeInTheDocument()
    expect(api.createAmendmentRequest).toHaveBeenCalledWith('c-acme', 'letter-fee')
  })

  it('shows a refusal and stays put', async () => {
    api.createAmendmentRequest = vi.fn(async () => {
      throw new ApiError(409, '"Fee change" has no email or no letter written yet. Write it in Letters first.')
    })
    renderCard()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'New amendment' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Letter for the amendment' })).toHaveValue('letter-1099'))
    fireEvent.click(screen.getByRole('button', { name: 'Start the amendment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Write it in Letters first.')
    expect(screen.queryByText(/Editor for/)).not.toBeInTheDocument()
  })

  it('with no saved letters, says to write one first and cannot start', async () => {
    api.listLettersRequest = vi.fn(async () => ({ letters: [], placeholders: [], sender: { from: '', replyTo: '' }, teamAddresses: [] }))
    renderCard()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'New amendment' }))
    expect(await screen.findByText(/Write a letter on the Letters page first/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start the amendment' })).toBeDisabled()
  })

  it('renders nothing and reads nothing for staff', () => {
    renderCard(false)
    expect(screen.queryByLabelText('Client engagements')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New amendment' })).not.toBeInTheDocument()
    expect(api.listEngagementsRequest).not.toHaveBeenCalled()
  })
})
