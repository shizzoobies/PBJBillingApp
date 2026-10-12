import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ClientEngagementsCard } from '../components/ClientEngagementsCard'
import { firmToday } from '../../lib/firm-time.js'
import { ApiError, type Engagement, type EngagementSignResult } from '../lib/types'

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
  getEngagementRequest: (...args: unknown[]) => api.getEngagementRequest(...args),
  signEngagementRequest: (...args: unknown[]) => api.signEngagementRequest(...args),
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

function renderCard(ownerMode = true, props: Partial<Parameters<typeof ClientEngagementsCard>[0]> = {}) {
  render(
    <MemoryRouter initialEntries={['/clients/c-acme']}>
      <Routes>
        <Route path="/clients/:id" element={<ClientEngagementsCard clientId="c-acme" ownerMode={ownerMode} {...props} />} />
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

// featreq-b2142264: Mark as signed from the client card - the editor's own form, call and
// summary (src/components/engagements/SignEngagement.tsx), in a dialog.
describe('ClientEngagementsCard: Mark as signed', () => {
  const signResult = (over: Partial<EngagementSignResult> = {}): EngagementSignResult => ({
    engagement: engagementFixture({ id: 'eng-amend', kind: 'amendment', status: 'signed' }),
    clientId: 'c-acme',
    createdClient: false,
    clonedTemplateIds: [],
    retainerInvoiceId: null,
    retainerPeriod: null,
    monthlyRate: null,
    addedPlanIds: [],
    softwareAdded: [],
    onboardingCaseId: null,
    onboardingChecklistId: null,
    skipped: [],
    ...over,
  })
  const viewOf = (row: Engagement, changedSinceSent = false) => ({
    engagement: row,
    placeholders: [],
    warnings: { unknown: [], retired: [] },
    hash: 'hash-1',
    sender: { from: '', replyTo: '' },
    changedSinceSent,
  })
  let confirm: Mock

  beforeEach(() => {
    confirm = vi.fn(() => true)
    window.confirm = confirm as unknown as typeof window.confirm
    api.getEngagementRequest = vi.fn(async (id: string) => viewOf(ROWS.find((row) => row.id === id) ?? ROWS[0]))
    api.signEngagementRequest = vi.fn(async () => signResult())
  })

  const rowsOf = async () => within(await screen.findByRole('table')).getAllByRole('row').slice(1)

  it('a sent row has Mark as signed (a signed one does not); it opens the dialog, posts the day and shows what signing did', async () => {
    renderCard(true, { client: { name: 'Acme', billingMode: 'hourly', monthlyRate: 0 } })
    const [sentRow, signedRow] = await rowsOf()
    expect(within(signedRow).queryByRole('button', { name: 'Mark as signed' })).toBeNull()
    fireEvent.click(within(sentRow).getByRole('button', { name: 'Mark as signed' }))

    const dialog = await screen.findByRole('dialog', { name: 'Mark as signed: Acme Books' })
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalledWith('eng-amend'))
    expect(within(dialog).getByLabelText('Signed on')).toHaveValue(firmToday())
    expect(within(dialog).queryByRole('checkbox', { name: /signed in person/ })).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Signing note'), { target: { value: 'Signed at the office' } })
    const reads = api.listEngagementsRequest.mock.calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls[0][0]).toMatch(/^Mark the engagement letter for Acme Books as signed on /)
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-amend', { signedOn: firmToday(), note: 'Signed at the office' }),
    )
    const summary = await within(dialog).findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText('Finished signing for Acme.')).toBeTruthy()
    // She is on the client's page already: no "Open the client" here (the editor keeps it).
    expect(within(summary).queryByRole('link', { name: 'Open the client' })).toBeNull()
    // The card reads its list again.
    await waitFor(() => expect(api.listEngagementsRequest.mock.calls.length).toBeGreaterThan(reads))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a draft row signs only once "signed in person" is ticked, and posts allowUnsent', async () => {
    const draft = engagementFixture({ id: 'eng-draft', status: 'draft', sentAt: null, signedAt: null, signedBy: null })
    api.listEngagementsRequest = vi.fn(async () => [draft])
    api.getEngagementRequest = vi.fn(async () => viewOf(draft))
    renderCard()
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    const sign = within(dialog).getByRole('button', { name: 'Mark as signed' })
    expect(sign).toBeDisabled()
    expect(within(dialog).getByText('Send the letter first, or tick "signed in person".')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /signed in person/ }))
    expect(sign).toBeEnabled()
    fireEvent.click(sign)
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-draft', { signedOn: firmToday(), allowUnsent: true }),
    )
  })

  it("a prospect's signing links the new client's onboarding checklist", async () => {
    renderCard()
    api.signEngagementRequest = vi.fn(async () =>
      signResult({ createdClient: true, clientId: 'client-new', onboardingCaseId: 'case-1', onboardingChecklistId: 'check-onb' }),
    )
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    const summary = await within(dialog).findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText('Acme Books is now a client, in Onboarding, with its contact.')).toBeTruthy()
    expect(
      within(summary).getByText('Onboarding checklist opened at the Onboarding stage - the Proposal stage is marked done.'),
    ).toBeTruthy()
    expect(within(summary).getByRole('link', { name: 'Open the onboarding checklist' })).toHaveAttribute(
      'href',
      '/checklists?focus=check-onb',
    )
  })

  it('a refusal is its plain sentence; changed since sent reads the letter again and offers "Signed as edited"', async () => {
    renderCard()
    let reads = 0
    api.getEngagementRequest = vi.fn(async () => viewOf(ROWS[0], reads++ > 0))
    api.signEngagementRequest = vi.fn(async () => {
      throw new ApiError(
        409,
        "The letter changed since it was sent - send it again, or tick 'signed as edited' to sign this version",
        'engagement_refused',
        'changed_since_sent',
      )
    })
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalledTimes(1))
    expect(within(dialog).queryByRole('checkbox', { name: /Signed as edited/ })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/The letter changed since it was sent - send it again/)
    const asEdited = await within(dialog).findByRole('checkbox', { name: /Signed as edited/ })
    expect(within(dialog).getByRole('button', { name: 'Mark as signed' })).toBeDisabled()
    fireEvent.click(asEdited)
    api.signEngagementRequest = vi.fn(async () => signResult())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-amend', { signedOn: firmToday(), confirmChanged: true }),
    )
  })

  it('any other refusal shows the server sentence and stays open', async () => {
    renderCard()
    api.signEngagementRequest = vi.fn(async () => {
      throw new ApiError(409, 'This letter was voided while you were marking it signed.', 'engagement_refused', 'status')
    })
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This letter was voided while you were marking it signed.')
    expect(within(dialog).queryByRole('status', { name: 'What signing did' })).toBeNull()
  })

  it("an existing monthly client's fee choice is shown read-only, with the letter to change it, and the confirm repeats it", async () => {
    const upsell = engagementFixture({
      id: 'eng-upsell',
      status: 'sent',
      signedAt: null,
      signedBy: null,
      feeMode: 'add',
      figures: { totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0, software: 0 } },
    })
    api.listEngagementsRequest = vi.fn(async () => [upsell])
    api.getEngagementRequest = vi.fn(async () => viewOf(upsell))
    renderCard(true, { client: { name: 'Acme', billingMode: 'subscription', monthlyRate: 1200 } })
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    const fee = within(dialog).getByLabelText('Monthly fee when signed')
    expect(fee).toHaveTextContent("Acme's monthly fee, when signed: Add to it ($1,200.00 + $630.00 = $1,830.00).")
    expect(within(fee).getByRole('link', { name: 'Open the letter to change' })).toHaveAttribute('href', '/engagements/eng-upsell')
    expect(within(dialog).queryByRole('radio')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls[0][0]).toContain('Monthly fee: Add to it ($1,200.00 + $630.00 = $1,830.00). A signed letter')
  })
})
