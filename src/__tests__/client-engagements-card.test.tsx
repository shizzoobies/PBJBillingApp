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
  restoreEngagementRequest: (...args: unknown[]) => api.restoreEngagementRequest(...args),
  esignStatusRequest: (...args: unknown[]) => api.esignStatusRequest(...args),
  listEngagementEsignRequests: (...args: unknown[]) => api.listEngagementEsignRequests(...args),
  listClientEsignRequests: (...args: unknown[]) => api.listClientEsignRequests(...args),
  sendEngagementEsignRequest: (...args: unknown[]) => api.sendEngagementEsignRequest(...args),
  engagementRecipientsRequest: (...args: unknown[]) => api.engagementRecipientsRequest(...args),
  remindEngagementEsignRequest: (...args: unknown[]) => api.remindEngagementEsignRequest(...args),
  engagementEsignPdfUrl: (id: string, requestId: string) => `/api/engagements/${id}/esign/${requestId}/pdf`,
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
  api.esignStatusRequest = vi.fn(async () => ({ configured: false, testMode: true }))
  api.listEngagementEsignRequests = vi.fn(async () => [])
  api.listClientEsignRequests = vi.fn(async () => [])
  api.sendEngagementEsignRequest = vi.fn()
  api.remindEngagementEsignRequest = vi.fn()
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

  // Alex 2026-10-27: the dialog's e-signature status names who the request went to; sending stays on the letter's page.
  it("the dialog's e-signature status says who it was sent to, and offers no send of its own", async () => {
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, provider: 'esignatures', testMode: false }))
    api.listEngagementEsignRequests = vi.fn(async () => [
      {
        id: 'sigreq-1',
        engagementId: 'eng-amend',
        clientId: 'c-acme',
        provider: 'esignatures',
        status: 'sent',
        recipients: [{ id: 'signer-1', name: 'Jo Owner', email: 'owner@elsewhere.test' }],
        testMode: false,
        signedDocumentId: null,
        sentAt: '2026-10-21T15:00:00.000Z',
        completedAt: null,
        lastEventAt: null,
        lastError: null,
        lastRemindedAt: null,
        createdAt: '2026-10-21T15:00:00.000Z',
        updatedAt: '2026-10-21T15:00:00.000Z',
      },
    ])
    renderCard()
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/Sent to owner@elsewhere\.test/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /^Send for signature/ })).toBeNull()
  })

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

  // Engagements leftovers 10 [34]: the outcome of a signing still running must not be hidden.
  it('ignores every way of closing the dialog while a signing is in flight, and closes again once it answers', async () => {
    renderCard()
    let finish: (value: ReturnType<typeof signResult>) => void = () => {}
    api.signEngagementRequest = vi.fn(
      () =>
        new Promise<ReturnType<typeof signResult>>((resolve) => {
          finish = resolve
        }),
    )
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    await waitFor(() => expect(api.signEngagementRequest).toHaveBeenCalled())

    // The X, a click outside the panel, Escape and Cancel: all ignored while it runs.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeNull()
    const overlay = dialog.parentElement as HTMLElement
    fireEvent.click(overlay)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()

    finish(signResult())
    const summary = await within(dialog).findByRole('status', { name: 'What signing did' })
    expect(summary).toBeTruthy()
    // Answered: the dialog closes as usual.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
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

  it('a refusal is its plain sentence; changed since sent reads the letter again, and the next try warns first', async () => {
    renderCard()
    let reads = 0
    api.getEngagementRequest = vi.fn(async () => viewOf(ROWS[0], reads++ > 0))
    api.signEngagementRequest = vi.fn(async () => {
      throw new ApiError(
        409,
        'The letter changed since it was sent - send it again, or mark it signed anyway',
        'engagement_refused',
        'changed_since_sent',
      )
    })
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalledTimes(1))
    expect(within(dialog).queryByRole('button', { name: 'Mark signed anyway' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/The letter changed since it was sent - send it again/)
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalledTimes(2))
    api.signEngagementRequest = vi.fn(async () => signResult())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    // A warning first, not a refusal: nothing is sent until she chooses.
    expect(await within(dialog).findByText(/The client signed the earlier version/)).toBeTruthy()
    expect(api.signEngagementRequest).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark signed anyway' }))
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

// featreq-e5ae8279: a superseding letter replaces the client's open amendments unless she
// keeps one in force; a replaced amendment can be restored from the card.
describe('ClientEngagementsCard: Restore', () => {
  const replaced = (over: Partial<Engagement> = {}) =>
    engagementFixture({
      id: 'eng-replaced',
      kind: 'amendment',
      status: 'superseded',
      proposalId: null,
      letterId: 'letter-1099',
      subject: 'Your 2027 1099s',
      sentAt: '2026-10-11T15:00:00.000Z',
      signedAt: null,
      signedBy: null,
      ...over,
    })
  let confirm: Mock

  beforeEach(() => {
    confirm = vi.fn(() => true)
    window.confirm = confirm as unknown as typeof window.confirm
    api.restoreEngagementRequest = vi.fn(async () => replaced({ status: 'sent' }))
  })

  const rowsOf = async () => within(await screen.findByRole('table')).getAllByRole('row').slice(1)

  it('only a superseded AMENDMENT has Restore; a superseded original and a live amendment do not', async () => {
    api.listEngagementsRequest = vi.fn(async () => [
      replaced(),
      engagementFixture({ id: 'eng-orig', status: 'superseded' }),
      engagementFixture({ id: 'eng-live', kind: 'amendment', status: 'sent' }),
    ])
    renderCard()
    const [amendment, original, live] = await rowsOf()
    expect(within(amendment).getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(within(original).queryByRole('button', { name: 'Restore' })).toBeNull()
    expect(within(live).queryByRole('button', { name: 'Restore' })).toBeNull()
  })

  it('asks first, says the status it goes back to, then restores and reads the list again', async () => {
    api.listEngagementsRequest = vi.fn(async () => [replaced()])
    renderCard()
    const [row] = await rowsOf()
    confirm.mockReturnValueOnce(false)
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    expect(confirm.mock.calls[0][0]).toContain('Restore the amendment "Your 2027 1099s"? It goes back to Sent.')
    expect(confirm.mock.calls[0][0]).toContain(
      'a restored draft or sent amendment applies its own fee and plans if it is signed later.',
    )
    expect(api.restoreEngagementRequest).not.toHaveBeenCalled()

    const reads = api.listEngagementsRequest.mock.calls.length
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(api.restoreEngagementRequest).toHaveBeenCalledWith('eng-replaced'))
    await waitFor(() => expect(api.listEngagementsRequest.mock.calls.length).toBeGreaterThan(reads))
  })

  it('reads the status it goes back to from the amendment\'s own dates: Signed, else Sent, else Draft', async () => {
    api.listEngagementsRequest = vi.fn(async () => [
      replaced({ id: 'a-signed', signedAt: '2026-10-12T15:00:00.000Z' }),
      replaced({ id: 'a-draft', sentAt: null }),
    ])
    renderCard()
    const [signed, draft] = await rowsOf()
    confirm.mockReturnValue(false)
    fireEvent.click(within(signed).getByRole('button', { name: 'Restore' }))
    fireEvent.click(within(draft).getByRole('button', { name: 'Restore' }))
    expect(confirm.mock.calls[0][0]).toContain('It goes back to Signed.')
    expect(confirm.mock.calls[1][0]).toContain('It goes back to Draft.')
  })

  it('shows the server sentence when the restore is refused', async () => {
    api.listEngagementsRequest = vi.fn(async () => [replaced()])
    api.restoreEngagementRequest = vi.fn(async () => {
      throw new ApiError(409, 'This amendment is sent, not superseded, so there is nothing to restore.', 'engagement_refused', 'status')
    })
    renderCard()
    const [row] = await rowsOf()
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This amendment is sent, not superseded, so there is nothing to restore.')
  })
})

describe('ClientEngagementsCard: a superseding letter replaces the open amendments', () => {
  const superseding = engagementFixture({
    id: 'eng-super',
    kind: 'superseding',
    status: 'sent',
    supersedesId: 'eng-1',
    subject: 'Updated engagement letter',
    signedAt: null,
    signedBy: null,
    feeMode: 'replace',
  })
  // A pure record (a Letters send): nothing to lose by keeping it in force.
  const pureSent = engagementFixture({
    id: 'am-pure',
    kind: 'amendment',
    status: 'sent',
    proposalId: null,
    letterId: 'letter-1099',
    subject: 'Your 2027 1099s',
    signedAt: null,
    signedBy: null,
    feeMode: 'keep',
  })
  // One that carried a fee and plans: keeping it does not bring them back.
  const withFee = engagementFixture({
    id: 'am-fee',
    kind: 'amendment',
    status: 'draft',
    proposalId: 'prop-2',
    subject: 'Payroll added',
    sentAt: null,
    signedAt: null,
    signedBy: null,
    feeMode: 'add',
    planIds: ['plan-payroll'],
    figures: { totals: { monthly: 150, annual: 0, oneTime: 0, cleanup: 0, software: 0 } },
  })
  const voided = engagementFixture({ id: 'am-void', kind: 'amendment', status: 'void', subject: 'Voided one', feeMode: 'keep' })
  const signedAmendment = engagementFixture({
    id: 'am-signed',
    kind: 'amendment',
    status: 'signed',
    proposalId: null,
    subject: 'Signed notice',
    feeMode: 'keep',
  })
  const signResult = (): EngagementSignResult => ({
    engagement: { ...superseding, status: 'signed' },
    clientId: 'c-acme',
    createdClient: false,
    clonedTemplateIds: [],
    retainerInvoiceId: null,
    retainerPeriod: null,
    monthlyRate: null,
    addedPlanIds: [],
    supersededId: 'eng-1',
    supersededAmendmentIds: ['am-pure', 'am-fee'],
    softwareAdded: [],
    skipped: [],
  })
  const viewOf = (row: Engagement) => ({
    engagement: row,
    placeholders: [],
    warnings: { unknown: [], retired: [] },
    hash: 'hash-1',
    sender: { from: '', replyTo: '' },
    changedSinceSent: false,
  })
  let confirm: Mock

  beforeEach(() => {
    confirm = vi.fn(() => true)
    window.confirm = confirm as unknown as typeof window.confirm
    api.listEngagementsRequest = vi.fn(async () => [superseding, pureSent, withFee, voided, signedAmendment, engagementFixture()])
    api.getEngagementRequest = vi.fn(async () => viewOf(superseding))
    api.signEngagementRequest = vi.fn(async () => signResult())
  })

  const openDialog = async () => {
    renderCard()
    const table = await screen.findByRole('table')
    const row = within(table).getAllByRole('row').slice(1)[0]
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('group', { name: 'Open amendments this letter replaces' })
    return dialog
  }

  it('lists the live amendments (not void, not the original) each with Keep in force OFF, and warns only on one that is not a pure record', async () => {
    const dialog = await openDialog()
    const boxes = within(dialog).getAllByRole('checkbox', { name: /^Keep in force:/ })
    expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
      'Keep in force: Your 2027 1099s',
      'Keep in force: Payroll added',
      'Keep in force: Signed notice',
    ])
    for (const box of boxes) expect(box).not.toBeChecked()
    const notes = within(dialog).getAllByRole('note')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toHaveTextContent(
      "Keeping or replacing it does not change the client's fee or plans; signing this letter does, as set in Signing details.",
    )
    // The warning sits under the row that carried the fee and plans.
    expect(notes[0].parentElement).toContainElement(within(dialog).getByRole('checkbox', { name: 'Keep in force: Payroll added' }))
  })

  it('sends the ids it SHOWED minus the ones kept, and the confirm counts what is replaced', async () => {
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Keep in force: Signed notice' }))
    // An amendment made after the list was read is not shown, so it is never sent.
    api.listEngagementsRequest = vi.fn(async () => [superseding, pureSent, withFee, signedAmendment, { ...pureSent, id: 'am-late' }])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls[0][0]).toContain('2 open amendments are replaced too (marked Superseded; each can be restored')
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-super', {
        signedOn: firmToday(),
        replaceAmendmentIds: ['am-pure', 'am-fee'],
      }),
    )
    const summary = await within(dialog).findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText(/2 open amendments were replaced too\. Restore one from the client's Engagements list/)).toBeTruthy()
  })

  it('keeping every one in force sends no list at all', async () => {
    const dialog = await openDialog()
    for (const box of within(dialog).getAllByRole('checkbox', { name: /^Keep in force:/ })) fireEvent.click(box)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls[0][0]).not.toContain('replaced too')
    await waitFor(() => expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-super', { signedOn: firmToday() }))
  })

  it('shows nothing and sends nothing for a letter that is not superseding, or for a client with no open amendment', async () => {
    api.listEngagementsRequest = vi.fn(async () => [superseding, voided, engagementFixture()])
    renderCard()
    const row = within(await screen.findByRole('table')).getAllByRole('row').slice(1)[0]
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalled())
    expect(within(dialog).queryByRole('group', { name: 'Open amendments this letter replaces' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    await waitFor(() => expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-super', { signedOn: firmToday() }))
  })

  // Replacing too few has no undo (replacing too many is one Restore): a failed read is not "ready".
  it('an unreadable amendment list keeps Mark as signed disabled, says so with a Retry, and only a good read enables it', async () => {
    api.listEngagementsRequest = vi
      .fn()
      .mockResolvedValueOnce([superseding])
      .mockRejectedValueOnce(new ApiError(500, 'nope', 'x'))
      .mockResolvedValue([superseding, pureSent])
    renderCard()
    const row = within(await screen.findByRole('table')).getAllByRole('row').slice(1)[0]
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Could not read this client's amendments.")
    const sign = within(dialog).getByRole('button', { name: 'Mark as signed' })
    expect(sign).toBeDisabled()
    fireEvent.click(sign)
    expect(api.signEngagementRequest).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
    await within(dialog).findByRole('group', { name: 'Open amendments this letter replaces' })
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Mark as signed' })).toBeEnabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as signed' }))
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-super', { signedOn: firmToday(), replaceAmendmentIds: ['am-pure'] }),
    )
  })

  it('keeps Mark as signed disabled, saying the amendments are being read, until the list has loaded', async () => {
    let release: (rows: Engagement[]) => void = () => {}
    api.listEngagementsRequest = vi
      .fn()
      .mockResolvedValueOnce([superseding])
      .mockImplementationOnce(() => new Promise<Engagement[]>((resolve) => (release = resolve)))
    renderCard()
    const row = within(await screen.findByRole('table')).getAllByRole('row').slice(1)[0]
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as signed' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalled())
    expect(within(dialog).getByText("Reading the client's amendments...")).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Mark as signed' })).toBeDisabled()
    release([superseding, pureSent])
    await within(dialog).findByRole('group', { name: 'Open amendments this letter replaces' })
    expect(within(dialog).queryByText("Reading the client's amendments...")).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Mark as signed' })).toBeEnabled()
  })
})

/** E-signature (featreq-56d39567): where a sent letter stands at SignWell, beside its status. */
describe('e-signature status on the card', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    id: 'sigreq-1',
    engagementId: 'eng-amend',
    clientId: 'c-acme',
    status: 'sent',
    recipients: [],
    testMode: true,
    signedDocumentId: null,
    sentAt: '2026-10-21T15:00:00.000Z',
    completedAt: null,
    lastEventAt: null,
    lastError: null,
    lastRemindedAt: null,
    createdAt: '2026-10-21T15:00:00.000Z',
    updatedAt: '2026-10-21T15:00:00.000Z',
    ...over,
  })

  it('shows "E-sign: sent Oct 21" and the Test mode tag on a sent letter that went out for signature', async () => {
    api.listClientEsignRequests = vi.fn(async () => [request()])
    renderCard()
    const row = (await screen.findByText('Your 2027 1099s')).closest('tr') as HTMLElement
    expect(await within(row).findByText('E-sign: sent Oct 21')).toBeTruthy()
    expect(within(row).getByText('Test mode')).toBeTruthy()
    // ONE call for the whole client (featreq-60118b28 item 4), never one per letter.
    expect(api.listClientEsignRequests).toHaveBeenCalledTimes(1)
    expect(api.listClientEsignRequests).toHaveBeenCalledWith('c-acme')
    expect(api.listEngagementEsignRequests).not.toHaveBeenCalled()
  })

  it('shows signed for a letter signed electronically, and nothing for a letter with no request', async () => {
    api.listClientEsignRequests = vi.fn(async () => [
      request({ id: 'sigreq-2', engagementId: 'eng-1', status: 'completed', testMode: false, completedAt: '2026-10-05T15:00:00.000Z' }),
    ])
    renderCard()
    const signed = (await screen.findByText('Engagement letter - {{client_name}}')).closest('tr') as HTMLElement
    expect(await within(signed).findByText('E-sign: signed Oct 5')).toBeTruthy()
    expect(within(signed).queryByText('Test mode')).toBeNull()
    const other = screen.getByText('Your 2027 1099s').closest('tr') as HTMLElement
    expect(within(other).queryByText(/E-sign/)).toBeNull()
  })

  // Alex 2026-10-27: the signer is confirmed (or changed) at Send for signature, so the row says who it went to.
  it('names the address the request went to, a contact or a one-time address rather than the party', async () => {
    api.listClientEsignRequests = vi.fn(async () => [request({ recipients: [{ id: 'signer-1', name: 'Casey Fox', email: 'cfo@acme.test' }] })])
    renderCard()
    const row = (await screen.findByText('Your 2027 1099s')).closest('tr') as HTMLElement
    expect(await within(row).findByText('E-sign: sent Oct 21')).toBeTruthy()
    expect(within(row).getByText(/Sent to cfo@acme\.test/)).toBeTruthy()
    expect(within(row).queryByText(/pat@acme\.test/)).toBeNull()
  })

  it('a failed read of the requests leaves the card as it was', async () => {
    api.listClientEsignRequests = vi.fn(async () => {
      throw new ApiError(500, 'boom')
    })
    renderCard()
    expect(await screen.findByText('Your 2027 1099s')).toBeTruthy()
    expect(screen.queryByText(/E-sign/)).toBeNull()
  })
})

/**
 * Send for signature from the client's Billing tab (Alex, 2026-10-27): the editor's own confirm (who signs, the
 * party's address chosen) on each draft or sent letter that could be sent, posted with the stored letter's hash.
 */
describe('Send for signature from the card', () => {
  const signatureRequest = (over: Record<string, unknown> = {}) => ({
    id: 'sigreq-1',
    engagementId: 'eng-amend',
    clientId: 'c-acme',
    provider: 'esignatures',
    status: 'sent',
    recipients: [{ id: 'signer-1', name: 'Casey Fox', email: 'cfo@acme.test' }],
    testMode: false,
    signedDocumentId: null,
    sentAt: '2026-10-21T15:00:00.000Z',
    completedAt: null,
    lastEventAt: null,
    lastError: null,
    lastRemindedAt: null,
    createdAt: '2026-10-21T15:00:00.000Z',
    updatedAt: '2026-10-21T15:00:00.000Z',
    ...over,
  })
  const viewOf = (row: Engagement) => ({
    engagement: row,
    placeholders: [],
    warnings: { unknown: [], retired: [] },
    hash: `hash-${row.id}`,
    sender: { from: '', replyTo: '' },
    changedSinceSent: false,
  })
  const configured = () => {
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, provider: 'esignatures', testMode: false }))
  }
  const rowOf = async (subject: string) => (await screen.findByText(subject)).closest('tr') as HTMLElement

  beforeEach(() => {
    api.getEngagementRequest = vi.fn(async (id: string) => viewOf(ROWS.find((row) => row.id === id) ?? ROWS[0]))
    api.engagementRecipientsRequest = vi.fn(async () => ({
      details: [
        { email: 'pat@acme.test', source: 'Pat Doe' },
        { email: 'cfo@acme.test', source: 'Casey Fox' },
      ],
      defaultTo: ['pat@acme.test'],
    }))
    api.sendEngagementEsignRequest = vi.fn(async () => ({
      request: signatureRequest(),
      engagement: { ...ROWS[0], status: 'sent' },
    }))
  })

  it('shows only on a draft or sent letter, once e-signature is set up, with no request out, outside preview', async () => {
    // Not set up: no button anywhere.
    renderCard()
    await rowOf('Your 2027 1099s')
    await waitFor(() => expect(api.esignStatusRequest).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Send for signature' })).toBeNull()
    cleanup()

    // Set up: the sent letter has it, the signed one does not; draft yes, void and superseded no.
    configured()
    const draft = engagementFixture({ id: 'eng-draft', status: 'draft', subject: 'Draft letter', sentAt: null, signedAt: null, signedBy: null })
    const voided = engagementFixture({ id: 'eng-void', status: 'void', subject: 'Void letter', signedAt: null, signedBy: null })
    const replaced = engagementFixture({ id: 'eng-sup', kind: 'amendment', status: 'superseded', subject: 'Replaced letter', signedAt: null, signedBy: null })
    api.listEngagementsRequest = vi.fn(async () => [...ROWS, draft, voided, replaced])
    renderCard()
    expect(await within(await rowOf('Your 2027 1099s')).findByRole('button', { name: 'Send for signature' })).toBeTruthy()
    expect(within(await rowOf('Draft letter')).getByRole('button', { name: 'Send for signature' })).toBeTruthy()
    for (const subject of ['Engagement letter - {{client_name}}', 'Void letter', 'Replaced letter']) {
      expect(within(await rowOf(subject)).queryByRole('button', { name: 'Send for signature' }), subject).toBeNull()
    }
    cleanup()

    // A request still out: Send reminder lives on the letter's page, so no new send here.
    api.listEngagementsRequest = vi.fn(async () => ROWS)
    api.listClientEsignRequests = vi.fn(async () => [signatureRequest({ status: 'viewed' })])
    renderCard()
    const out = await rowOf('Your 2027 1099s')
    await within(out).findByText('E-sign: viewed')
    expect(within(out).queryByRole('button', { name: 'Send for signature' })).toBeNull()
    cleanup()

    // A declined one can be sent again; preview never sends.
    api.listClientEsignRequests = vi.fn(async () => [signatureRequest({ status: 'declined' })])
    renderCard()
    expect(await within(await rowOf('Your 2027 1099s')).findByRole('button', { name: 'Send for signature' })).toBeTruthy()
    cleanup()
    renderCard(true, { previewMode: true })
    await rowOf('Your 2027 1099s')
    await waitFor(() => expect(api.esignStatusRequest).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Send for signature' })).toBeNull()
  })

  it('reads the stored letter, asks who signs (party chosen), sends a contact with the hash, and badges the row', async () => {
    configured()
    renderCard()
    const row = await rowOf('Your 2027 1099s')
    fireEvent.click(await within(row).findByRole('button', { name: 'Send for signature' }))
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalledWith('eng-amend'))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('group', { name: 'Confirm send for signature' })
    expect(await within(confirm).findByRole('radio', { name: /Pat Doe\s*pat@acme\.test/ })).toBeChecked()
    expect(within(confirm).getByText('eSignatures.io also reminds them automatically on days 2, 4, 8 and 16.')).toBeTruthy()
    expect(api.engagementRecipientsRequest).toHaveBeenCalledWith('eng-amend')

    fireEvent.click(within(confirm).getByRole('radio', { name: /Casey Fox/ }))
    expect(within(confirm).getByText('Signer: Casey Fox (cfo@acme.test)')).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send for signature to cfo@acme.test' }))
    await waitFor(() =>
      expect(api.sendEngagementEsignRequest).toHaveBeenCalledWith('eng-amend', { templateHash: 'hash-eng-amend', signer: { email: 'cfo@acme.test' } }),
    )
    expect(await screen.findByText('Sent for signature to cfo@acme.test.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    const badged = await rowOf('Your 2027 1099s')
    expect(within(badged).getByText('E-sign: sent Oct 21')).toBeTruthy()
    expect(within(badged).getByText(/Sent to cfo@acme\.test/)).toBeTruthy()
    // Out for signature now: no second send from the row.
    expect(within(badged).queryByRole('button', { name: 'Send for signature' })).toBeNull()
    // Still the card's single list call for the badges.
    expect(api.listClientEsignRequests).toHaveBeenCalledTimes(1)
  })

  it('a one-time address is posted as oneTime with the typed name', async () => {
    configured()
    renderCard()
    fireEvent.click(await within(await rowOf('Your 2027 1099s')).findByRole('button', { name: 'Send for signature' }))
    const confirm = within(await screen.findByRole('dialog')).getByRole('group', { name: 'Confirm send for signature' })
    fireEvent.click(await within(confirm).findByRole('radio', { name: 'Another address for this send only' }))
    fireEvent.change(within(confirm).getByLabelText("Signer's email for this send only"), { target: { value: 'owner@elsewhere.test' } })
    fireEvent.change(within(confirm).getByLabelText("Signer's name"), { target: { value: 'Jo Owner' } })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send for signature to owner@elsewhere.test' }))
    await waitFor(() =>
      expect(api.sendEngagementEsignRequest).toHaveBeenCalledWith('eng-amend', {
        templateHash: 'hash-eng-amend',
        signer: { email: 'owner@elsewhere.test', oneTime: true, name: 'Jo Owner' },
      }),
    )
  })

  it('an address no longer on file reopens the choice on the fresh list; another refusal says why and closes', async () => {
    configured()
    api.sendEngagementEsignRequest = vi.fn(async () => {
      const error = new ApiError(409, 'cfo@acme.test is no longer on file for this letter. Choose who signs again. Nothing was sent.', 'recipients_changed')
      error.recipients = [{ email: 'pat@acme.test', source: 'Pat Doe' }]
      throw error
    })
    renderCard()
    fireEvent.click(await within(await rowOf('Your 2027 1099s')).findByRole('button', { name: 'Send for signature' }))
    let confirm = within(await screen.findByRole('dialog')).getByRole('group', { name: 'Confirm send for signature' })
    fireEvent.click(await within(confirm).findByRole('radio', { name: /Casey Fox/ }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send for signature to cfo@acme.test' }))
    expect(await screen.findByText(/no longer on file for this letter/)).toBeTruthy()
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).queryByRole('radio', { name: /Casey Fox/ })).toBeNull(),
    )
    confirm = within(screen.getByRole('dialog')).getByRole('group', { name: 'Confirm send for signature' })
    expect(within(confirm).getByRole('radio', { name: /Pat Doe/ })).toBeChecked()

    api.sendEngagementEsignRequest = vi.fn(async () => {
      throw new ApiError(409, 'pat@acme.test belongs to a team member. An engagement letter goes to the client only.', 'team_address')
    })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send for signature to pat@acme.test' }))
    expect(await screen.findByText(/belongs to someone on your team\. An engagement letter goes to the client only\. Nothing was sent\./)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a letter that is no longer draft or sent when read says so and sends nothing', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => viewOf({ ...ROWS[0], status: 'void' }))
    renderCard()
    fireEvent.click(await within(await rowOf('Your 2027 1099s')).findByRole('button', { name: 'Send for signature' }))
    expect(await screen.findByText('This letter is void now, so it cannot be sent for signature.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.sendEngagementEsignRequest).not.toHaveBeenCalled()
  })
})
