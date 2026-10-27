import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { EngagementEditorPage } from '../pages/EngagementEditorPage'
import { firmToday } from '../../lib/firm-time.js'
import { ApiError, type Engagement, type EngagementSignResult, type EngagementView, type SignatureRequest } from '../lib/types'

/**
 * The engagement editor (docs/plans/engagements-2026-10.md, stage 2C): what it loads,
 * what Save sends and the hash Send carries back, the confirms on Re-assemble, Send,
 * Mark as signed and Void, and a plain sentence for every refusal Send can answer.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  getEngagementRequest: (...args: unknown[]) => api.getEngagementRequest(...args),
  updateEngagementRequest: (...args: unknown[]) => api.updateEngagementRequest(...args),
  reassembleEngagementRequest: (...args: unknown[]) => api.reassembleEngagementRequest(...args),
  previewEngagementRequest: (...args: unknown[]) => api.previewEngagementRequest(...args),
  engagementRecipientsRequest: (...args: unknown[]) => api.engagementRecipientsRequest(...args),
  engagementPreviewPdfUrl: (id: string) => `/api/engagements/${id}/preview.pdf`,
  sendEngagementRequest: (...args: unknown[]) => api.sendEngagementRequest(...args),
  signEngagementRequest: (...args: unknown[]) => api.signEngagementRequest(...args),
  voidEngagementRequest: (...args: unknown[]) => api.voidEngagementRequest(...args),
  listPackagesRequest: (...args: unknown[]) => api.listPackagesRequest(...args),
  listEngagementSectionsRequest: (...args: unknown[]) => api.listEngagementSectionsRequest(...args),
  listEngagementsRequest: (...args: unknown[]) => api.listEngagementsRequest(...args),
  esignStatusRequest: (...args: unknown[]) => api.esignStatusRequest(...args),
  listEngagementEsignRequests: (...args: unknown[]) => api.listEngagementEsignRequests(...args),
  sendEngagementEsignRequest: (...args: unknown[]) => api.sendEngagementEsignRequest(...args),
  remindEngagementEsignRequest: (...args: unknown[]) => api.remindEngagementEsignRequest(...args),
  finishEngagementEsignRequest: (...args: unknown[]) => api.finishEngagementEsignRequest(...args),
  engagementEsignPdfUrl: (id: string, requestId: string) => `/api/engagements/${id}/esign/${requestId}/pdf`,
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const PLACEHOLDERS = [
  { key: 'client_name', label: 'Client name', description: "The client's name.", required: true, scope: 'both' as const },
  { key: 'monthly_fee', label: 'Monthly fee', description: 'The monthly fee.', required: false, scope: 'both' as const },
  { key: 'retainer_sentence', label: 'Retainer sentence', description: 'The retainer.', required: false, scope: 'engagement' as const },
]

function engagement(over: Partial<Engagement> = {}): Engagement {
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
    emailBody: 'Hi Pat,\n\nAttached is our engagement letter.',
    letterBody: '**Fees**\n\nOur fee is {{monthly_fee}}. {{retainer_sentence}}',
    sectionKeys: ['intro', 'fees'],
    figures: {
      totals: { monthly: 630, annual: 1200, oneTime: 0, cleanup: 500, software: 0 },
      lines: [
        { serviceId: 'monthly-weekly-transactions-basic', group: 'Monthly', name: 'Transactions', amount: 630, cadence: null, role: 'bookkeeper', hours: 6 },
      ],
      hoursByRole: { bookkeeper: 6, accountant: 1.5, controller: 0 },
    },
    retainerAmount: 630,
    packageId: null,
    planIds: [],
    templateHash: 'h',
    emailLog: [],
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

function view(over: Partial<Engagement> = {}, hash = 'hash-1'): EngagementView {
  return {
    engagement: engagement(over),
    placeholders: PLACEHOLDERS,
    warnings: { unknown: [], retired: [] },
    hash,
    sender: { from: 'PB&J <billing@pbjsa.com>', replyTo: 'brittany@pbjsa.com' },
  }
}

/** What Mark as signed answers (engagements stage 3): a client created, nothing else by default. */
function signResult(over: Partial<EngagementSignResult> = {}): EngagementSignResult {
  return {
    engagement: engagement({ status: 'signed', clientId: 'client-new', signedAt: '2026-10-09T16:00:00.000Z' }),
    clientId: 'client-new',
    createdClient: true,
    clonedTemplateIds: [],
    retainerInvoiceId: null,
    retainerPeriod: null,
    monthlyRate: null,
    addedPlanIds: [],
    softwareAdded: [],
    skipped: [],
    ...over,
  }
}

function mockConfirm(answer: boolean) {
  const confirm = vi.fn((message?: string) => (void message, answer))
  window.confirm = confirm
  return confirm
}

async function renderEditor() {
  render(
    <MemoryRouter initialEntries={['/engagements/eng-1']}>
      <Routes>
        <Route path="/engagements/:engagementId" element={<EngagementEditorPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByDisplayValue('Engagement letter - {{client_name}}')
}

beforeEach(() => {
  contextValue = {
    ownerMode: true,
    dataRefreshCount: 0,
    data: {
      clients: [],
      plans: [
        { id: 'plan-1', name: 'Monthly Bookkeeping', notes: '' },
        { id: 'plan-2', name: 'Payroll', notes: '' },
      ],
    },
  } as unknown as AppContextValue
  api.getEngagementRequest = vi.fn(async () => view())
  api.updateEngagementRequest = vi.fn(async (_id: string, patch: Partial<Engagement>) => view(patch, 'hash-2'))
  api.reassembleEngagementRequest = vi.fn(async () =>
    view({ subject: 'Rebuilt subject', emailBody: 'Rebuilt email', letterBody: 'Rebuilt letter' }, 'hash-3'),
  )
  api.previewEngagementRequest = vi.fn(async () => previewAnswer())
  // The Send picker's list, from its own route (no letter built): the party alone here.
  api.engagementRecipientsRequest = vi.fn(async () => ({
    details: [{ email: 'pat@acme.test', source: 'Pat Doe' }],
    defaultTo: ['pat@acme.test'],
  }))
  api.sendEngagementRequest = vi.fn(async () => ({
    engagement: engagement({ status: 'sent' }),
    ok: true,
    error: null,
  }))
  api.signEngagementRequest = vi.fn(async () => signResult())
  api.voidEngagementRequest = vi.fn(async () => engagement({ status: 'void' }))
  api.listEngagementsRequest = vi.fn(async () => [])
  // E-signature (featreq-56d39567): not set up unless a test says so, so the panel stays out of the way.
  api.esignStatusRequest = vi.fn(async () => ({ configured: false, testMode: true }))
  api.listEngagementEsignRequests = vi.fn(async () => [])
  api.sendEngagementEsignRequest = vi.fn(async () => ({ request: signatureRequest(), engagement: engagement({ status: 'sent' }) }))
  api.remindEngagementEsignRequest = vi.fn(async () => ({ request: signatureRequest() }))
  api.finishEngagementEsignRequest = vi.fn(async () => ({
    request: signatureRequest({ status: 'completed', signedDocumentId: 'sigdoc-1' }),
    signed: true,
    issues: [],
    engagement: engagement({ status: 'signed' }),
  }))
  api.listPackagesRequest = vi.fn(async () => [
    { id: 'pkg-1', name: 'Full service', description: '', planIds: [], templateIds: [], createdAt: '', updatedAt: null },
  ])
  api.listEngagementSectionsRequest = vi.fn(async () => [
    { id: 'esec-1', key: 'intro', title: 'Introduction', body: '', trigger: { always: true }, sortOrder: 1, active: true, role: 'letter', createdAt: null, updatedAt: null },
    { id: 'esec-2', key: 'fees', title: 'Fees', body: '', trigger: { always: true }, sortOrder: 2, active: true, role: 'letter', createdAt: null, updatedAt: null },
  ])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** One e-signature request as the server lists it. */
function signatureRequest(over: Partial<SignatureRequest> = {}): SignatureRequest {
  return {
    id: 'sigreq-1',
    engagementId: 'eng-1',
    clientId: null,
    status: 'sent',
    recipients: [{ id: '1', name: 'Pat Doe', email: 'pat@acme.test' }],
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
  }
}

/** What the preview call answers: the letter, and the recipient picker's lists (featreq-34627da1). */
function previewAnswer() {
  return {
    subject: 'Engagement letter - Acme Books',
    html: '<p>Hi Pat</p>',
    text: 'Hi Pat',
    to: ['pat@acme.test'],
    details: [{ email: 'pat@acme.test', source: 'Pat Doe' }],
    defaultTo: ['pat@acme.test'],
    recipientNote: null,
    missing: [],
    missingNote: null,
    unknown: [],
    retired: [],
    pdfAvailable: true,
    pdfFilename: 'Engagement-Letter-acme-books-2026.pdf',
    refusal: null,
  }
}

describe('loading', () => {
  it('shows the party, the kind and status, the proposal link, the three boxes and the figures', async () => {
    await renderEditor()
    expect(screen.getByRole('heading', { level: 1, name: 'Acme Books' })).toBeTruthy()
    expect(screen.getByText('Original', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getByText('Draft', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'From proposal Acme Books' }).getAttribute('href')).toBe('/proposals/prop-1')
    expect(screen.queryByRole('link', { name: 'Client' })).toBeNull()
    expect(screen.getByLabelText('Email body')).toHaveValue('Hi Pat,\n\nAttached is our engagement letter.')
    expect(screen.getByLabelText('Letter body')).toHaveValue('**Fees**\n\nOur fee is {{monthly_fee}}. {{retainer_sentence}}')
    expect(screen.getByLabelText('Retainer amount')).toHaveValue('630')
    expect(screen.getByText(/The default is one month's fee, \$630.00/)).toBeTruthy()
    expect(screen.getByText('$1,200.00')).toBeTruthy()
    const hours = screen.getByLabelText('Estimated monthly hours')
    expect(within(hours).getByText('Bookkeeper 6.0')).toBeTruthy()
    expect(within(hours).getByText('Accountant 1.5')).toBeTruthy()
    expect(within(hours).queryByText(/Controller/)).toBeNull()
    // The sections the letter was assembled from, by their library titles.
    const used = await screen.findByRole('list', { name: 'Sections used' })
    await waitFor(() => expect(within(used).getByText('Introduction')).toBeTruthy())
  })

  it('offers a chip for every placeholder the engagement GET lists, engagement-only ones included, behind a toggle', async () => {
    await renderEditor()
    expect(screen.queryByRole('group', { name: 'Insert a placeholder into the letter' })).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Placeholders for the letter (3)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    const group = screen.getByRole('group', { name: 'Insert a placeholder into the letter' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '{{client_name}}',
      '{{monthly_fee}}',
      '{{retainer_sentence}}',
    ])
  })

  it('links the client once there is one', async () => {
    api.getEngagementRequest = vi.fn(async () => view({ clientId: 'client-9' }))
    await renderEditor()
    expect(screen.getByRole('link', { name: 'Client' }).getAttribute('href')).toBe('/clients/client-9')
  })

  // Engagements stage 4: an amendment that came from a saved letter has no proposal behind it.
  it('an amendment from a saved letter: no proposal figures, sections or re-assemble, and its origin in the activity', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'amendment', proposalId: null, clientId: 'client-9', letterId: 'letter-1099', sectionKeys: [], figures: {}, retainerAmount: null }),
    )
    await renderEditor()
    expect(screen.getByText('Amendment', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'From a saved letter' }).getAttribute('href')).toBe('/letters')
    expect(screen.queryByRole('link', { name: /From proposal/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'From the proposal' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Sections' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Re-assemble from the proposal' })).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Activity' })).getByText('Drafted from a saved letter')).toBeTruthy()
    cleanup()

    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'amendment', status: 'sent', proposalId: null, clientId: 'client-9', letterId: 'letter-1099', letterSendId: 'els-1', sectionKeys: [], figures: {} }),
    )
    await renderEditor()
    expect(within(screen.getByRole('list', { name: 'Activity' })).getByText('Recorded from a Letters send')).toBeTruthy()
  })

  // Engagements stage 4: superseding.
  it('a superseding letter says which engagement it supersedes, linked, and its confirm says what it replaces', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'superseding', status: 'sent', clientId: 'client-9', supersedesId: 'eng-old', feeMode: 'replace' }),
    )
    api.listEngagementsRequest = vi.fn(async () => [
      engagement({ id: 'eng-old', kind: 'original', status: 'signed', clientId: 'client-9', signedAt: '2026-09-15T16:00:00.000Z' }),
    ])
    const confirm = mockConfirm(false)
    await renderEditor()
    const link = await screen.findByRole('link', { name: 'Supersedes the engagement signed Sep 15, 2026' })
    expect(link.getAttribute('href')).toBe('/engagements/eng-old')
    expect(api.listEngagementsRequest).toHaveBeenCalledWith({ clientId: 'client-9' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls[0][0]).toContain(
      "It replaces the client's current engagement: that one is marked Superseded, and the client's plans become this letter's plans (a letter naming none leaves them).",
    )
  })

  it('a superseded letter says what superseded it, read-only', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({ status: 'superseded', clientId: 'client-9', signedAt: '2026-09-15T16:00:00.000Z' }),
    )
    api.listEngagementsRequest = vi.fn(async () => [
      engagement({ id: 'eng-new', kind: 'superseding', status: 'signed', clientId: 'client-9', supersedesId: 'eng-1', signedAt: '2026-10-09T16:00:00.000Z' }),
      engagement({ id: 'eng-1', status: 'superseded', clientId: 'client-9' }),
    ])
    await renderEditor()
    const note = await screen.findByRole('note', { name: 'Superseded' })
    await waitFor(() =>
      expect(within(note).getByRole('link', { name: 'the engagement signed Oct 9, 2026' }).getAttribute('href')).toBe(
        '/engagements/eng-new',
      ),
    )
    expect(note.textContent).toContain('can no longer be changed')
    expect(screen.getByText('Superseded', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark as signed' })).toBeNull()
  })

  // featreq-e5ae8279: nothing points at a replaced amendment, so it names no successor.
  it('a superseded AMENDMENT says it was replaced when a newer engagement was signed, in words that fit how far it got', async () => {
    api.listEngagementsRequest = vi.fn(async () => [
      engagement({ id: 'eng-new', kind: 'superseding', status: 'signed', clientId: 'client-9', supersedesId: 'eng-0', signedAt: '2026-10-09T16:00:00.000Z' }),
    ])
    const states: [Partial<Engagement>, string][] = [
      [{ sentAt: '2026-10-01T15:00:00.000Z', signedAt: '2026-10-02T15:00:00.000Z' }, 'kept as it was signed'],
      [{ sentAt: '2026-10-01T15:00:00.000Z', signedAt: null }, 'kept as it was sent'],
      [{ sentAt: null, signedAt: null }, 'kept as it was drafted'],
    ]
    for (const [dates, words] of states) {
      api.getEngagementRequest = vi.fn(async () =>
        view({ kind: 'amendment', status: 'superseded', proposalId: null, clientId: 'client-9', ...dates }),
      )
      await renderEditor()
      const note = await screen.findByRole('note', { name: 'Superseded' })
      expect(note.textContent).toContain('Replaced when a newer engagement was signed.')
      expect(note.textContent).toContain(words)
      expect(note.textContent).toContain('Restore')
      // No successor link and no "a newer engagement" stand-in: nothing points at an amendment.
      expect(within(note).queryByRole('link')).toBeNull()
      expect(note.textContent).not.toContain('Superseded by')
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      cleanup()
    }
  })

  it('the sign form of a superseding letter lists the live amendments, each Keep in force OFF', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'superseding', status: 'sent', clientId: 'client-9', supersedesId: 'eng-old', feeMode: 'replace' }),
    )
    api.listEngagementsRequest = vi.fn(async () => [
      engagement({ id: 'eng-old', kind: 'original', status: 'signed', clientId: 'client-9', signedAt: '2026-09-15T16:00:00.000Z' }),
      engagement({ id: 'am-1', kind: 'amendment', status: 'sent', clientId: 'client-9', proposalId: null, subject: 'Fee notice', figures: {}, retainerAmount: null, feeMode: 'keep', sentAt: '2026-10-01T15:00:00.000Z' }),
      engagement({ id: 'am-2', kind: 'amendment', status: 'void', clientId: 'client-9', subject: 'Old voided' }),
    ])
    mockConfirm(true)
    await renderEditor()
    const group = await screen.findByRole('group', { name: 'Open amendments this letter replaces' })
    const boxes = within(group).getAllByRole('checkbox')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).not.toBeChecked()
    expect(boxes[0].getAttribute('aria-label')).toBe('Keep in force: Fee notice')
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-1', { signedOn: firmToday(), replaceAmendmentIds: ['am-1'] }),
    )
  })

  it('after signing a superseding letter, says the plans taken off and links the engagement it superseded', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'superseding', status: 'sent', clientId: 'client-9', supersedesId: 'eng-old', feeMode: 'replace' }),
    )
    api.signEngagementRequest = vi.fn(async () =>
      signResult({
        engagement: engagement({ kind: 'superseding', status: 'signed', clientId: 'client-9', supersedesId: 'eng-old' }),
        clientId: 'client-9',
        createdClient: false,
        addedPlanIds: ['plan-2'],
        removedPlanIds: ['plan-1'],
        supersededId: 'eng-old',
      }),
    )
    // The amendment list read is slow on purpose: Mark as signed stays disabled until it
    // resolves, so the click must wait for the button (clicking a disabled button does
    // nothing, and under full-suite load the read used to lose that race).
    api.listEngagementsRequest = vi.fn(() => new Promise<Engagement[]>((resolve) => setTimeout(() => resolve([]), 50)))
    mockConfirm(true)
    await renderEditor()
    const signButton = screen.getByRole('button', { name: 'Mark as signed' })
    expect(signButton).toBeDisabled()
    await waitFor(() => expect(signButton).toBeEnabled())
    fireEvent.click(signButton)
    const summary = await screen.findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText('Plans added: Payroll.')).toBeTruthy()
    expect(within(summary).getByText('Plans taken off: Monthly Bookkeeping.')).toBeTruthy()
    expect(within(summary).getByRole('link', { name: 'open it' }).getAttribute('href')).toBe('/engagements/eng-old')
  })

  it('reads no other engagements for a letter outside a superseding chain', async () => {
    await renderEditor()
    expect(api.listEngagementsRequest).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: /Supersedes/ })).toBeNull()
  })

  it('warns on a placeholder the app does not fill in', async () => {
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hello {{nope}}' } })
    expect(screen.getByText(/\{\{nope\}\} is not a placeholder the app fills in/)).toBeTruthy()
  })

  // Task 17: initials and extra signature fields for SignWell, typed into the letter body.
  it('counts the e-sign field tags in the letter body quietly and never calls them typos', async () => {
    await renderEditor()
    expect(screen.queryByText(/E-sign fields in the body/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Letter body'), {
      target: { value: 'Initial here {{initial:1:y}}.\n\nAn extra signature line {{signature:1:y}}' },
    })
    expect(screen.getByText('E-sign fields in the body: 2')).toBeTruthy()
    expect(screen.queryByText(/is not a placeholder the app fills in/)).toBeNull()
  })

  it('warns on an e-sign field tag in the subject or the email body: it belongs in the letter', async () => {
    await renderEditor()
    const sentence = 'E-sign fields belong in the letter, not the email. Send will refuse until it is changed.'
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Sign {{initial:1:y}}' } })
    expect(screen.getByText(sentence)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Engagement letter' } })
    fireEvent.change(screen.getByLabelText('Email body'), { target: { value: 'Please sign {{signature:1:y}}' } })
    expect(screen.getByText(sentence)).toBeTruthy()
    expect(screen.queryByText(/E-sign fields in the body/)).toBeNull()
  })

  it('names a retired placeholder as retired, not as a typo', async () => {
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Letter body'), { target: { value: 'At {{hourly_rate}} an hour.' } })
    expect(screen.getByText(/\{\{hourly_rate\}\} is no longer filled in/)).toBeTruthy()
    expect(screen.queryByText(/is not a placeholder the app fills in/)).toBeNull()
  })

  it('names the proposal lines the letter leaves out', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({
        figures: {
          totals: { monthly: 0 },
          lines: [{ serviceId: 'reports-budget', group: 'Reports', name: 'Budget', amount: 0, cadence: null, role: null, hours: null, flag: 'no-count' } as never],
        },
      }),
    )
    await renderEditor()
    expect(screen.getByText(/^Not in the letter: Budget/)).toBeTruthy()
  })
})

describe('Save', () => {
  it('sends the boxes and the signing details, then Send carries the NEW hash', async () => {
    mockConfirm(true)
    await renderEditor()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'New subject' } })
    fireEvent.change(screen.getByLabelText('Retainer amount'), { target: { value: '$1,000' } })
    await waitFor(() => expect(screen.getByRole('option', { name: 'Full service' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: 'pkg-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plans' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payroll' }))
    // Preview and Send wait for the save.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText('Save the engagement to preview, send or sign it.')).toBeTruthy()
    fireEvent.click(save)
    await waitFor(() =>
      expect(api.updateEngagementRequest).toHaveBeenCalledWith('eng-1', {
        subject: 'New subject',
        emailBody: 'Hi Pat,\n\nAttached is our engagement letter.',
        letterBody: '**Fees**\n\nOur fee is {{monthly_fee}}. {{retainer_sentence}}',
        retainerAmount: 1000,
        packageId: 'pkg-1',
        planIds: ['plan-2'],
        // The stamp the page loaded: a letter saved from another tab since is refused.
        expectedUpdatedAt: '2026-10-11T15:00:00.000Z',
      }),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    await confirmSend()
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-2', to: ['pat@acme.test'] }),
    )
  })

  it('a save refused because the letter changed elsewhere says so, writes nothing, and Reload brings the stored one', async () => {
    api.updateEngagementRequest = vi.fn(async () => {
      throw new ApiError(409, 'changed', 'engagement_changed')
    })
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'My subject' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await screen.findByText(
        'Someone saved this engagement after you opened it - reload and redo your change. Nothing was saved.',
      ),
    ).toBeTruthy()
    api.getEngagementRequest = vi.fn(async () => view({ subject: 'Their subject', updatedAt: '2026-10-11T16:00:00.000Z' }, 'hash-9'))
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Their subject'))
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    // The next save carries the stamp of the version just loaded.
    api.updateEngagementRequest = vi.fn(async (_id: string, patch: Partial<Engagement>) => view(patch, 'hash-10'))
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Mine again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateEngagementRequest).toHaveBeenCalledWith(
        'eng-1',
        expect.objectContaining({ expectedUpdatedAt: '2026-10-11T16:00:00.000Z' }),
      ),
    )
  })

  it('saves a blank retainer as none, and refuses one that is not an amount', async () => {
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Retainer amount'), { target: { value: 'abc' } })
    expect(screen.getByText(/Type the retainer as an amount/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Retainer amount'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateEngagementRequest).toHaveBeenCalled())
    expect(api.updateEngagementRequest.mock.calls[0][1]).toMatchObject({ retainerAmount: null })
  })

  it('wraps the selection in ** with the B button', async () => {
    await renderEditor()
    const box = screen.getByLabelText('Email body') as HTMLTextAreaElement
    box.setSelectionRange(0, 2)
    fireEvent.click(screen.getByRole('button', { name: 'Bold in the email' }))
    expect(box).toHaveValue('**Hi** Pat,\n\nAttached is our engagement letter.')
  })
})

describe('Re-assemble from the proposal', () => {
  it('asks first; a no changes nothing', async () => {
    const confirm = mockConfirm(false)
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Re-assemble from the proposal' }))
    expect(confirm.mock.calls[0][0]).toMatch(/Your edits to them, saved or not, are replaced/)
    expect(api.reassembleEngagementRequest).not.toHaveBeenCalled()
  })

  it('on a yes replaces the boxes with the rebuilt letter, unsaved edits included', async () => {
    mockConfirm(true)
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Unsaved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-assemble from the proposal' }))
    await screen.findByDisplayValue('Rebuilt subject')
    expect(screen.getByLabelText('Letter body')).toHaveValue('Rebuilt letter')
  })

  it('is only offered on a draft', async () => {
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }))
    await renderEditor()
    expect(screen.queryByRole('button', { name: 'Re-assemble from the proposal' })).toBeNull()
  })
})

// featreq-34627da1: Send opens the shared recipient picker - the party's address ticked,
// the linked client's contacts listed, one added for this send only - and the picker is
// the confirm.
const openPicker = async (name: RegExp = /^Send$/) => {
  fireEvent.click(screen.getByRole('button', { name }))
  return within(await screen.findByRole('dialog', { name: 'Choose who this goes to' }))
}
const confirmSend = async (name?: RegExp) => {
  const dialog = await openPicker(name)
  fireEvent.click(dialog.getByRole('button', { name: /^Send to \d+ (person|people)$/ }))
}

describe('Send', () => {
  const linked = {
    details: [
      { email: 'pat@acme.test', source: 'Pat Doe' },
      { email: 'lee@acme.test', source: 'Lee Roe' },
    ],
    defaultTo: ['pat@acme.test'],
  }

  it('opens the picker with the party ticked and the client\'s contacts listed, then posts what she leaves ticked', async () => {
    api.engagementRecipientsRequest = vi.fn(async () => linked)
    api.sendEngagementRequest = vi.fn(async () => ({
      engagement: engagement({ status: 'sent' }),
      ok: true,
      error: null,
      to: ['lee@acme.test'],
    }))
    await renderEditor()
    const dialog = await openPicker()
    expect(api.engagementRecipientsRequest).toHaveBeenCalledWith('eng-1')
    // The list comes from its own route: no preview (no letter or PDF) is built for it.
    expect(api.previewEngagementRequest).not.toHaveBeenCalled()
    expect(dialog.getByRole('checkbox', { name: /pat@acme.test/ })).toBeChecked()
    expect(dialog.getByRole('checkbox', { name: /lee@acme.test/ })).not.toBeChecked()
    expect(dialog.getByText(/Replies go to brittany@pbjsa.com/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('checkbox', { name: /lee@acme.test/ }))
    fireEvent.click(dialog.getByRole('checkbox', { name: /pat@acme.test/ }))
    expect(dialog.getByText('Goes to: lee@acme.test')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Send to 1 person' }))
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-1', to: ['lee@acme.test'] }),
    )
    expect(await screen.findByText('Sent to lee@acme.test.')).toBeTruthy()
  })

  it('sends to an address added for this send only, as `extra`, and names the list the server says it went to', async () => {
    api.sendEngagementRequest = vi.fn(async () => ({
      engagement: engagement({ status: 'sent' }),
      ok: true,
      error: null,
      to: ['pat@acme.test', 'owner@acme.test'],
    }))
    await renderEditor()
    const dialog = await openPicker()
    fireEvent.change(dialog.getByLabelText('Add another address for this send only'), { target: { value: 'owner@acme.test' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Send to 2 people' }))
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', {
        templateHash: 'hash-1',
        to: ['pat@acme.test'],
        extra: ['owner@acme.test'],
      }),
    )
    expect(await screen.findByText('Sent to pat@acme.test, owner@acme.test.')).toBeTruthy()
  })

  it('needs one address on file: everyone unticked disables Send and says why', async () => {
    await renderEditor()
    const dialog = await openPicker()
    fireEvent.click(dialog.getByRole('checkbox', { name: /pat@acme.test/ }))
    expect(dialog.getByRole('button', { name: 'Send to 0 people' })).toBeDisabled()
    expect(dialog.getByRole('alert')).toHaveTextContent(/Pick at least one address on file/)
  })

  it('does nothing on Cancel', async () => {
    await renderEditor()
    const dialog = await openPicker()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Choose who this goes to' })).toBeNull()
    expect(api.sendEngagementRequest).not.toHaveBeenCalled()
  })

  it('is off while the request is in flight', async () => {
    let finish: (value: unknown) => void = () => {}
    api.sendEngagementRequest = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    await renderEditor()
    await confirmSend()
    const sending = await screen.findByRole('button', { name: 'Sending...' })
    expect(sending).toBeDisabled()
    fireEvent.click(sending)
    expect(api.sendEngagementRequest).toHaveBeenCalledTimes(1)
    finish({ engagement: engagement({ status: 'sent' }), ok: true, error: null })
    await screen.findByText('Sent to pat@acme.test.')
  })

  it('says when the provider refused it', async () => {
    api.sendEngagementRequest = vi.fn(async () => ({ engagement: engagement(), ok: false, error: 'Mailbox full' }))
    await renderEditor()
    await confirmSend()
    expect(await screen.findByText('Not sent: Mailbox full')).toBeTruthy()
  })

  const refusals: Array<[string, ApiError, RegExp]> = [
    ['engagement_invalid', new ApiError(400, 'x', 'engagement_invalid'), /The chosen addresses could not be read/],
    ['unknown_placeholder', new ApiError(409, '{{nope}} is not a placeholder the app fills in. Nothing was sent.', 'unknown_placeholder'), /\{\{nope\}\} is not a placeholder/],
    ['missing_placeholder', new ApiError(409, '{{fee}} has no value for Acme Books - fill it in on the engagement.', 'missing_placeholder'), /\{\{fee\}\} has no value for Acme Books/],
    ['engagement_empty', new ApiError(409, 'x', 'engagement_empty'), /Write the subject, the email and the letter before sending/],
    ['engagement_refused', new ApiError(409, 'This engagement is signed, so it cannot be sent.', 'engagement_refused', 'signed'), /This engagement is signed, so it cannot be sent. Nothing was sent./],
    ['just_sent', new ApiError(409, 'x', 'engagement_refused', 'just_sent'), /This letter went out a moment ago - check the Activity list before sending again./],
    ['sending', new ApiError(409, 'x', 'engagement_refused', 'sending'), /A send of this letter is already under way - wait a minute, then check Activity./],
    ['team_address', new ApiError(409, 'x', 'team_address'), /belongs to someone on your team/],
    ['no_recipient', new ApiError(409, 'x', 'no_recipient'), /There is no email address to send to/],
    ['invoice_no_chosen_recipient', new ApiError(400, 'None of the chosen addresses belong to this client, so nothing was sent.', 'invoice_no_chosen_recipient'), /None of the chosen addresses belong to this client/],
    ['pdf_failed', new ApiError(502, 'x', 'pdf_failed'), /The PDF could not be built, so nothing was sent/],
    ['engagement_send_failed', new ApiError(502, 'x', 'engagement_send_failed'), /Email is not set up yet/],
    ['not found', new ApiError(404, 'Engagement not found'), /This engagement no longer exists/],
  ]
  for (const [name, error, sentence] of refusals) {
    it(`answers ${name} with a plain sentence`, async () => {
      api.sendEngagementRequest = vi.fn(async () => {
        throw error
      })
      await renderEditor()
      await confirmSend()
      expect(await screen.findByText(sentence)).toBeTruthy()
    })
  }

  it('re-reads the engagement when it changed since the page loaded', async () => {
    api.sendEngagementRequest = vi.fn(async () => {
      throw new ApiError(409, 'changed', 'engagement_changed')
    })
    await renderEditor()
    api.getEngagementRequest = vi.fn(async () => view({ subject: 'Saved elsewhere' }, 'hash-9'))
    await confirmSend()
    expect(await screen.findByText(/The engagement changed since this page loaded/)).toBeTruthy()
    await screen.findByDisplayValue('Saved elsewhere')
    api.sendEngagementRequest = vi.fn(async () => ({ engagement: engagement(), ok: true, error: null }))
    await confirmSend()
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-9', to: ['pat@acme.test'] }),
    )
  })

  // Review round 1: a ticked address no longer on file is refused (409), not dropped; the
  // picker reopens on the list as it is now.
  it('on recipients_changed says so and reopens the picker on the fresh list', async () => {
    api.sendEngagementRequest = vi.fn(async () => {
      throw new ApiError(409, 'The addresses on file for this client have changed. Reload and choose again.', 'recipients_changed')
    })
    api.engagementRecipientsRequest = vi
      .fn()
      .mockResolvedValueOnce({ details: [{ email: 'pat@acme.test', source: 'Pat Doe' }], defaultTo: ['pat@acme.test'] })
      .mockResolvedValueOnce({ details: [{ email: 'new@acme.test', source: 'Pat Doe' }], defaultTo: ['new@acme.test'] })
    await renderEditor()
    await confirmSend()
    expect(await screen.findByText(/The addresses on file for this client have changed/)).toBeTruthy()
    api.sendEngagementRequest = vi.fn(async () => ({
      engagement: engagement({ status: 'sent' }),
      ok: true,
      error: null,
      to: ['new@acme.test'],
    }))
    // The picker reopened by itself, on what the server has now.
    const reopened = within(await screen.findByRole('dialog', { name: 'Choose who this goes to' }))
    expect(reopened.getByRole('checkbox', { name: /new@acme.test/ })).toBeChecked()
    fireEvent.click(reopened.getByRole('button', { name: 'Send to 1 person' }))
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-1', to: ['new@acme.test'] }),
    )
  })

  // Review round 2: reading the list is not sending.
  it('reads "Loading..." (not "Sending...") while the list loads', async () => {
    let finish: (value: unknown) => void = () => {}
    api.engagementRecipientsRequest = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('button', { name: 'Loading...' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Sending...' })).toBeNull()
    finish({ details: [{ email: 'pat@acme.test', source: 'Pat Doe' }], defaultTo: ['pat@acme.test'] })
    expect(await screen.findByRole('dialog', { name: 'Choose who this goes to' })).toBeTruthy()
  })

  it('says why when the addresses could not be read, and opens nothing', async () => {
    api.engagementRecipientsRequest = vi.fn(async () => {
      throw new ApiError(500, 'Could not build the preview')
    })
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/Could not build the preview/)).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Choose who this goes to' })).toBeNull()
    expect(api.sendEngagementRequest).not.toHaveBeenCalled()
  })
})

describe('Save after a Send', () => {
  it('takes the stamp the send left even while she typed during "Sending...", so the next Save is not refused as stale', async () => {
    mockConfirm(true)
    let finish: (value: { engagement: Engagement; ok: boolean; error: null }) => void = () => {}
    api.sendEngagementRequest = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve as typeof finish
        }),
    )
    await renderEditor()
    await confirmSend()
    await waitFor(() => expect(api.sendEngagementRequest).toHaveBeenCalled())
    // Typing while it sends makes the page dirty.
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Typed while sending' } })
    // The send moved the stamp; the page reads the stored letter once it answers.
    api.getEngagementRequest = vi.fn(async () =>
      view({ status: 'sent', sentAt: '2026-10-11T17:00:00.000Z', updatedAt: '2026-10-11T17:00:00.000Z' }, 'hash-9'),
    )
    finish({ engagement: engagement({ status: 'sent' }), ok: true, error: null })
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalled())
    // Her unsaved text stays...
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    expect(screen.getByLabelText('Subject')).toHaveValue('Typed while sending')
    // ...and its Save carries the post-send stamp.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateEngagementRequest).toHaveBeenCalledWith(
        'eng-1',
        expect.objectContaining({ subject: 'Typed while sending', expectedUpdatedAt: '2026-10-11T17:00:00.000Z' }),
      ),
    )
  })
})

describe('Preview', () => {
  it('opens the shared preview window on the engagement endpoints', async () => {
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: 'Preview of the engagement letter for Acme Books' })
    expect(await within(dialog).findByText('To: pat@acme.test')).toBeTruthy()
    expect(api.previewEngagementRequest).toHaveBeenCalledWith('eng-1')
    expect(within(dialog).getByRole('tab', { name: 'PDF attachment' })).toBeTruthy()
  })

  it('has no Send to box any more: who it goes to is chosen in the picker at Send', async () => {
    await renderEditor()
    expect(screen.queryByLabelText('Send to')).toBeNull()
  })
})

describe('Mark as signed', () => {
  it('stays off on a draft until "signed in person" is ticked, then posts allowUnsent', async () => {
    const confirm = mockConfirm(true)
    await renderEditor()
    const sign = screen.getByRole('button', { name: 'Mark as signed' })
    expect(sign).toBeDisabled()
    expect(screen.getByLabelText('Signed on')).toHaveValue(firmToday())
    fireEvent.click(screen.getByRole('checkbox', { name: /signed in person/ }))
    expect(sign).toBeEnabled()
    fireEvent.click(sign)
    expect(confirm.mock.calls[0][0]).toMatch(/^Mark the engagement letter for Acme Books as signed on /)
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-1', { signedOn: firmToday(), allowUnsent: true }),
    )
  })

  it('on a sent letter posts the day and the note', async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }))
    await renderEditor()
    expect(screen.queryByRole('checkbox', { name: /signed in person/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Signed on'), { target: { value: '2026-10-09' } })
    fireEvent.change(screen.getByLabelText('Signing note'), { target: { value: 'Came back by email' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-1', { signedOn: '2026-10-09', note: 'Came back by email' }),
    )
  })

  // Engagements stage 3: the confirm says what signing will do, by whether there is a client yet.
  it('the confirm says a letter with no client creates one, with what it brings', async () => {
    const confirm = mockConfirm(false)
    api.getEngagementRequest = vi.fn(async () =>
      view({
        status: 'sent',
        sentAt: '2026-10-11T16:00:00.000Z',
        planIds: ['plan-1'],
        figures: {
          ...engagement().figures,
          lines: [
            ...(engagement().figures.lines ?? []),
            { serviceId: 'software-qbo-plus', group: 'Software', name: 'QBO Plus', amount: 98, cadence: null, role: null, hours: null },
          ],
        },
      }),
    )
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Signed on'), { target: { value: '2026-10-09' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls[0][0]).toBe(
      'Mark the engagement letter for Acme Books as signed on Oct 9, 2026? This creates Acme Books as a client in Onboarding, with its contact, the plans and package, with their checklists, the software as monthly expenses and a draft retainer invoice of $630.00 to review, and opens its onboarding checklist at the Onboarding stage. A signed letter can no longer be edited, sent or voided.',
    )
    expect(api.signEngagementRequest).not.toHaveBeenCalled()
  })

  it('the confirm for a letter to an existing client names the fee it brings', async () => {
    const confirm = mockConfirm(false)
    api.getEngagementRequest = vi.fn(async () =>
      view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', retainerAmount: null }),
    )
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Signed on'), { target: { value: '2026-10-09' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls[0][0]).toBe(
      'Mark the engagement letter for Acme Books as signed on Oct 9, 2026? This brings the monthly fee to the client. A signed letter can no longer be edited, sent or voided.',
    )
  })

  it('says how many existing checklists signing linked, and how many it left for her to choose', async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }))
    api.signEngagementRequest = vi.fn(async () =>
      signResult({
        linkedTemplateIds: ['tpl-close'],
        ambiguousTemplateIds: ['tpl-a', 'tpl-b'],
        scheduleDiffersTemplateIds: ['tpl-b'],
      }),
    )
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    const summary = await screen.findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText('1 checklist the client already had was linked instead of copied.')).toBeTruthy()
    expect(
      within(summary).getByText('1 left for you to choose on the client page: more than one existing checklist matches.'),
    ).toBeTruthy()
    expect(
      within(summary).getByText(
        `1 left for you to choose on the client page: the existing checklist runs on a different schedule than the plan's "How often".`,
      ),
    ).toBeTruthy()
  })

  it('shows what signing did, with links to the client and the retainer', async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }))
    api.signEngagementRequest = vi.fn(async () =>
      signResult({
        clonedTemplateIds: ['tpl-close', 'tpl-payroll'],
        addedPlanIds: ['plan-1', 'plan-2'],
        softwareAdded: ['QBO Plus'],
        retainerInvoiceId: 'inv-ret1',
        retainerPeriod: '2026-10',
        skipped: [{ what: 'Software: QB Time Elite', why: 'Acme Books already has a recurring expense named "QB Time Elite", so it was not added again.' }],
      }),
    )
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    const summary = await screen.findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText('Acme Books is now a client, in Onboarding, with its contact.')).toBeTruthy()
    expect(within(summary).getByText('Plans added: Monthly Bookkeeping, Payroll.')).toBeTruthy()
    expect(within(summary).getByText('2 recurring checklists copied from the plans and package.')).toBeTruthy()
    expect(within(summary).getByText('Software added as monthly expenses: QBO Plus.')).toBeTruthy()
    expect(
      within(summary).getByText('Retainer invoice of $630.00 drafted - it is in To review in the month run.'),
    ).toBeTruthy()
    expect(within(summary).getByText(/^Skipped - Software: QB Time Elite: /)).toBeTruthy()
    expect(within(summary).getByRole('link', { name: 'Open the client' }).getAttribute('href')).toBe('/clients/client-new')
    expect(within(summary).getByRole('link', { name: 'Open the retainer' }).getAttribute('href')).toBe(
      '/invoices?period=2026-10',
    )
  })

  // featreq-b2142264: a prospect's signing opens the new client's onboarding checklist.
  it("links the new client's onboarding checklist, opened at the Onboarding stage", async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }))
    api.signEngagementRequest = vi.fn(async () =>
      signResult({ onboardingCaseId: 'case-1', onboardingChecklistId: 'check-onb' }),
    )
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    const summary = await screen.findByRole('status', { name: 'What signing did' })
    expect(
      within(summary).getByText('Onboarding checklist opened at the Onboarding stage - the Proposal stage is marked done.'),
    ).toBeTruthy()
    expect(within(summary).getByRole('link', { name: 'Open the onboarding checklist' }).getAttribute('href')).toBe(
      '/checklists?focus=check-onb',
    )
  })

  it('a case that could not be opened says so, with no checklist link', async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }))
    api.signEngagementRequest = vi.fn(async () =>
      signResult({
        skipped: [
          {
            what: 'Onboarding checklist',
            why: 'The letter is signed and Acme Books is in Onboarding, but the onboarding checklist could not be opened. Add the onboarding steps on the Checklists page.',
          },
        ],
      }),
    )
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    const summary = await screen.findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText(/^Skipped - Onboarding checklist: The letter is signed/)).toBeTruthy()
    expect(within(summary).queryByText(/Onboarding checklist opened/)).toBeNull()
    expect(within(summary).queryByRole('link', { name: 'Open the onboarding checklist' })).toBeNull()
  })

  it('a signing with no retainer offers no retainer link, and says an opted-out skip', async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1' }))
    api.signEngagementRequest = vi.fn(async () =>
      signResult({
        createdClient: false,
        clientId: 'c1',
        monthlyRate: 630,
        skipped: [{ what: 'Retainer', why: 'Acme is invoiced outside the app, so no retainer invoice was drafted.' }],
      }),
    )
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    const summary = await screen.findByRole('status', { name: 'What signing did' })
    expect(within(summary).getByText('Finished signing for Acme Books.')).toBeTruthy()
    expect(within(summary).getByText('Monthly fee set to $630.00.')).toBeTruthy()
    expect(
      within(summary).getByText('Skipped - Retainer: Acme is invoiced outside the app, so no retainer invoice was drafted.'),
    ).toBeTruthy()
    expect(within(summary).queryByRole('link', { name: 'Open the retainer' })).toBeNull()
    expect(within(summary).getByRole('link', { name: 'Open the client' }).getAttribute('href')).toBe('/clients/c1')
  })

  it('shows the notice Accept handed over, and says the client comes at signing', async () => {
    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/engagements/eng-1', state: { notice: 'Marked Won. Acme Books becomes a client when this letter is marked signed.' } }]}
      >
        <Routes>
          <Route path="/engagements/:engagementId" element={<EngagementEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByDisplayValue('Engagement letter - {{client_name}}')
    expect(screen.getByText('Marked Won. Acme Books becomes a client when this letter is marked signed.')).toBeTruthy()
    expect(
      screen.getByText('Kept on the engagement for when it is signed. Acme Books becomes a client only then.'),
    ).toBeTruthy()
  })

  // The sent-hash guard: a sent letter edited since it went out warns first (not a refusal).
  it('a letter changed since it was sent warns with the day it was last sent, and signs only on "Mark signed anyway"', async () => {
    const confirm = mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => ({
      ...view({
        status: 'sent',
        sentAt: '2026-10-11T16:00:00.000Z',
        emailLog: [{ kind: 'send', ok: true, at: '2026-10-11T16:00:00.000Z', to: ['pat@acme.test'], providerId: 're_1', error: null }],
      }),
      changedSinceSent: true,
    }))
    await renderEditor()
    // Nothing is said until she asks to sign.
    expect(screen.queryByRole('button', { name: 'Mark signed anyway' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(
      screen.getByText(
        'This letter changed after it was last sent on Oct 11, 2026. The client signed the earlier version. Send it again first, or mark it signed anyway.',
      ),
    ).toBeTruthy()
    expect(api.signEngagementRequest).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()

    // Cancel drops the warning and signs nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Mark signed anyway' })).toBeNull()
    expect(api.signEngagementRequest).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark signed anyway' }))
    await waitFor(() =>
      expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-1', { signedOn: firmToday(), confirmChanged: true }),
    )
  })

  it('an unchanged sent letter shows no warning and sends no confirmChanged', async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => ({
      ...view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }),
      changedSinceSent: false,
    }))
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(screen.queryByRole('button', { name: 'Mark signed anyway' })).toBeNull()
    await waitFor(() => expect(api.signEngagementRequest).toHaveBeenCalledWith('eng-1', { signedOn: firmToday() }))
  })

  it('a changed_since_sent refusal shows the sentence and reloads, so the warning appears on the next try', async () => {
    mockConfirm(true)
    let reads = 0
    api.getEngagementRequest = vi.fn(async () => ({
      ...view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }),
      changedSinceSent: reads++ > 0,
    }))
    api.signEngagementRequest = vi.fn(async () => {
      throw new ApiError(
        409,
        "The letter changed since it was sent - send it again, or tick 'signed as edited' to sign this version",
        'engagement_refused',
        'changed_since_sent',
      )
    })
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(await screen.findByText(/The letter changed since it was sent - send it again/)).toBeTruthy()
    await waitFor(() => expect(api.getEngagementRequest).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as signed' }))
    expect(await screen.findByRole('button', { name: 'Mark signed anyway' })).toBeTruthy()
  })

  // Review round 1: an existing monthly client's fee is replaced, added to or kept.
  it('offers replace / add / keep with amounts for an existing monthly client, saves the choice, and the confirm repeats it', async () => {
    const confirm = mockConfirm(true)
    contextValue.data.clients = [{ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 1200 }] as never
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'amendment', status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', feeMode: 'add', retainerAmount: null }),
    )
    api.updateEngagementRequest = vi.fn(async (_id: string, patch: Partial<Engagement>) =>
      view({ kind: 'amendment', status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', retainerAmount: null, ...patch }, 'hash-2'),
    )
    await renderEditor()
    const replace = screen.getByRole('radio', { name: 'Replace the current fee ($1,200.00 -> $630.00)' })
    const add = screen.getByRole('radio', { name: 'Add to it ($1,200.00 + $630.00 = $1,830.00)' })
    const keep = screen.getByRole('radio', { name: 'Keep $1,200.00' })
    expect(add).toBeChecked()
    expect(replace).not.toBeChecked()
    fireEvent.click(keep)
    // An unsaved choice is not what signing would use: sign waits for Save.
    expect(screen.getByRole('button', { name: 'Mark as signed' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateEngagementRequest).toHaveBeenCalledWith('eng-1', expect.objectContaining({ feeMode: 'keep' })),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark as signed' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(confirm.mock.calls.at(-1)?.[0]).toContain('Monthly fee: Keep $1,200.00. A signed letter can no longer be edited')
  })

  // Engagements leftovers 8 [17]: "Add to it" would double a fee that is already the letter's.
  it('does not offer "Add to it" for a client this letter made (an original), unless the letter is already saved as add - which is shown, checked and warned about, never rewritten', async () => {
    contextValue.data.clients = [{ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 630 }] as never
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'original', status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', feeMode: 'replace', retainerAmount: null }),
    )
    await renderEditor()
    expect(screen.queryByRole('radio', { name: /^Add to it/ })).toBeNull()
    expect(screen.getByRole('radio', { name: 'Keep $630.00' })).toBeTruthy()
    cleanup()
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'original', status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', feeMode: 'add', retainerAmount: null }),
    )
    await renderEditor()
    expect(screen.getByRole('radio', { name: /^Add to it/ })).toBeChecked()
    expect(screen.getByText(/An original letter replaces or keeps the fee; it cannot add\./)).toBeTruthy()
    // Nothing was rewritten on read: the page is not asking to be saved.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  // A $300 upsell on a $300 client really does make $600; the stored choice must stand.
  it('keeps "Add to it" for an upsell whose fee equals the current fee, and never rewrites a stored add to replace', async () => {
    contextValue.data.clients = [{ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 630 }] as never
    api.getEngagementRequest = vi.fn(async () =>
      view({ kind: 'amendment', status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', feeMode: 'add', retainerAmount: null }),
    )
    await renderEditor()
    const add = screen.getByRole('radio', { name: 'Add to it ($630.00 + $630.00 = $1,260.00)' })
    expect(add).toBeChecked()
    expect(screen.queryByText(/it cannot add\./)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Edited subject' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateEngagementRequest).toHaveBeenCalled())
    expect(api.updateEngagementRequest.mock.calls[0][1]).not.toHaveProperty('feeMode')
  })

  it('offers no fee choice for a prospect, or for a client not billed monthly', async () => {
    await renderEditor()
    expect(screen.queryByRole('radio', { name: /Keep/ })).toBeNull()
    cleanup()
    contextValue.data.clients = [{ id: 'c1', name: 'Acme', billingMode: 'hourly', monthlyRate: 0 }] as never
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', clientId: 'c1' }))
    await renderEditor()
    expect(screen.queryByRole('radio', { name: /Keep/ })).toBeNull()
  })

  it('reloads the engagement after ANY signing error, so a retry finishes what the first try started', async () => {
    mockConfirm(true)
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z' }))
    api.signEngagementRequest = vi.fn(async () => {
      throw new ApiError(500, 'Something went wrong.')
    })
    await renderEditor()
    const reads = api.getEngagementRequest.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Mark as signed' }))
    expect(await screen.findByText('Something went wrong.')).toBeTruthy()
    await waitFor(() => expect(api.getEngagementRequest.mock.calls.length).toBeGreaterThan(reads))
  })

  it('a signed letter is read-only: no Save, Send, Sign or Void', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({ status: 'signed', sentAt: '2026-10-08T16:00:00.000Z', signedAt: '2026-10-09T16:00:00.000Z' }),
    )
    await renderEditor()
    expect(screen.getByLabelText('Subject')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark as signed' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull()
  })
})

describe('Void', () => {
  it('confirms, then voids', async () => {
    const confirm = mockConfirm(true)
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    expect(confirm.mock.calls[0][0]).toMatch(/^Void the engagement letter for Acme Books\?/)
    await waitFor(() => expect(api.voidEngagementRequest).toHaveBeenCalledWith('eng-1'))
  })

  it('does nothing on a no', async () => {
    mockConfirm(false)
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    expect(api.voidEngagementRequest).not.toHaveBeenCalled()
  })
})

describe('Activity', () => {
  it('lists the drafted stamp, the sends and the delivery events, oldest first', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({
        status: 'sent',
        sentAt: '2026-10-11T16:00:00.000Z',
        emailLog: [
          { kind: 'send', at: '2026-10-11T16:00:00.000Z', providerId: 're_1', to: ['pat@acme.test'], ok: true, error: null },
          { kind: 'delivery', at: '2026-10-11T16:01:00.000Z', providerId: 're_1', to: ['pat@acme.test'], event: 'delivered' },
        ],
      }),
    )
    await renderEditor()
    const items = within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem')
    expect(items.map((item) => item.lastElementChild?.textContent)).toEqual([
      'Drafted from the proposal',
      'Sent to pat@acme.test',
      'Delivered (pat@acme.test)',
    ])
  })

  // A "sending" claim is the send's mark; one that never got a send entry after it and is older
  // than the in-flight window means the send died: say so, so nobody guesses whether it went.
  it('shows a claim that never finished as "did not finish", and nothing for one still running or one a send followed', async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString()
    const send = (at: string) => ({ kind: 'send' as const, at, providerId: 're_1', to: ['pat@acme.test'], ok: true, error: null })
    api.getEngagementRequest = vi.fn(async () =>
      view({
        status: 'sent',
        sentAt: minutesAgo(30),
        emailLog: [
          { kind: 'sending', at: minutesAgo(40) },
          send(minutesAgo(39)),
          { kind: 'sending', at: minutesAgo(10) },
          { kind: 'sending', at: minutesAgo(0.2) },
        ],
      }),
    )
    await renderEditor()
    const texts = within(screen.getByRole('list', { name: 'Activity' }))
      .getAllByRole('listitem')
      .map((item) => item.lastElementChild?.textContent ?? '')
    const unfinished = texts.filter((text) => /did not finish/.test(text))
    // Only the 10-minute-old claim after the send: the first was followed by a send, the last is still running.
    expect(unfinished).toHaveLength(1)
    expect(unfinished[0]).toMatch(/^A send started at .+ did not finish - check with the client before sending again\.$/)
  })
})

// QA round, 2026-10-11.
describe('after QA', () => {
  it('a signed letter shows one signed line with its day and who signed it off, and no chips', async () => {
    contextValue = {
      ...contextValue,
      data: { ...(contextValue.data as object), employees: [{ id: 'emp-patrice', name: 'Brittany', role: 'Owner' }] },
    } as unknown as AppContextValue
    api.getEngagementRequest = vi.fn(async () =>
      view({
        status: 'signed',
        createdAt: '2026-10-07T15:00:00.000Z',
        sentAt: '2026-10-08T16:00:00.000Z',
        signedAt: '2026-10-09T16:00:00.000Z',
        signedBy: 'emp-patrice',
        signedNote: 'Came back by email',
        emailLog: [{ kind: 'send', at: '2026-10-08T16:00:00.000Z', providerId: 're_1', to: ['pat@acme.test'], ok: true, error: null }],
      }),
    )
    await renderEditor()
    const items = within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem')
    expect(items.map((item) => item.lastElementChild?.textContent)).toEqual([
      'Drafted from the proposal',
      'Sent to pat@acme.test',
      'Marked signed for Oct 9, 2026 by Brittany: Came back by email',
    ])
    // The signing line shows its day, never a time.
    expect(items[2].firstElementChild?.textContent).toBe('Oct 9, 2026')
    expect(screen.queryByText(/^Signed on /)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Placeholders for/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Bold in the letter' })).toBeNull()
  })

  it('says why Mark as signed is off on a draft', async () => {
    await renderEditor()
    expect(screen.getByText('Send the letter first, or tick "signed in person".')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /signed in person/ }))
    expect(screen.queryByText('Send the letter first, or tick "signed in person".')).toBeNull()
  })

  it('saves text without the package when the package did not change (a deleted one never blocks)', async () => {
    api.getEngagementRequest = vi.fn(async () => view({ packageId: 'pkg-gone' }))
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'New subject' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateEngagementRequest).toHaveBeenCalled())
    expect(api.updateEngagementRequest.mock.calls[0][1]).not.toHaveProperty('packageId')
  })

  it('keeps Save in the header beside the status pills', async () => {
    await renderEditor()
    const header = screen.getByRole('heading', { level: 1, name: 'Acme Books' }).closest('header') as HTMLElement
    expect(within(header).getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1)
  })
})

// Engagements leftovers 5: a letter with no client yet can change who it is addressed to.
describe('Addressed to', () => {
  it('shows the name, email and company of a letter with no client, and hides the card once it has one', async () => {
    await renderEditor()
    const card = screen.getByRole('group', { name: 'Addressed to' })
    expect(within(card).getByLabelText('Addressed to name')).toHaveValue('Pat Doe')
    expect(within(card).getByLabelText('Addressed to email')).toHaveValue('pat@acme.test')
    expect(within(card).getByLabelText('Addressed to company')).toHaveValue('Acme Books')
    expect(within(card).getByRole('button', { name: 'Save address' })).toBeDisabled()
    cleanup()
    api.getEngagementRequest = vi.fn(async () => view({ clientId: 'c1' }))
    await renderEditor()
    expect(screen.queryByRole('group', { name: 'Addressed to' })).toBeNull()
  })

  it('is hidden on a letter that can no longer be edited', async () => {
    api.getEngagementRequest = vi.fn(async () => view({ status: 'void' }))
    await renderEditor()
    expect(screen.queryByRole('group', { name: 'Addressed to' })).toBeNull()
  })

  it('saves an edited email as a party patch carrying the loaded stamp, and leaves the letter text alone', async () => {
    await renderEditor()
    const card = screen.getByRole('group', { name: 'Addressed to' })
    fireEvent.change(within(card).getByLabelText('Addressed to email'), { target: { value: ' owner@acme.test ' } })
    api.updateEngagementRequest = vi.fn(async (_id: string, patch: { party?: Partial<Engagement['party']> }) =>
      view({ party: { ...engagement().party, ...patch.party }, updatedAt: '2026-10-11T17:00:00.000Z' }, 'hash-5'),
    )
    fireEvent.click(within(card).getByRole('button', { name: 'Save address' }))
    await waitFor(() =>
      expect(api.updateEngagementRequest).toHaveBeenCalledWith('eng-1', {
        party: { contactName: 'Pat Doe', email: 'owner@acme.test', company: 'Acme Books' },
        expectedUpdatedAt: '2026-10-11T15:00:00.000Z',
      }),
    )
    // The card starts clean on the stored values (Send's picker reads the stored party from the server).
    await waitFor(() => expect(screen.getByLabelText('Addressed to email')).toHaveValue('owner@acme.test'))
    expect(screen.getByRole('button', { name: 'Save address' })).toBeDisabled()
    // The next text save carries the stamp that save returned.
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Later subject' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateEngagementRequest).toHaveBeenLastCalledWith(
        'eng-1',
        expect.objectContaining({ expectedUpdatedAt: '2026-10-11T17:00:00.000Z' }),
      ),
    )
  })

  it('refuses an email that is not one address, and Send waits for an unsaved address', async () => {
    await renderEditor()
    const card = screen.getByRole('group', { name: 'Addressed to' })
    fireEvent.change(within(card).getByLabelText('Addressed to email'), { target: { value: 'not an email' } })
    expect(within(card).getByText('Type one email address, like name@company.com.')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Save address' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText('Save the engagement to preview, send or sign it.')).toBeTruthy()
    fireEvent.change(within(card).getByLabelText('Addressed to email'), { target: { value: 'pat@acme.test' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    expect(api.updateEngagementRequest).not.toHaveBeenCalled()
  })

  it("shows the server's sentence when the address could not be saved", async () => {
    await renderEditor()
    const card = screen.getByRole('group', { name: 'Addressed to' })
    fireEvent.change(within(card).getByLabelText('Addressed to company'), { target: { value: 'Acme Inc' } })
    api.updateEngagementRequest = vi.fn(async () => {
      throw new ApiError(409, 'Someone saved this engagement after you opened it. Nothing was saved: reload and redo your change.', 'engagement_changed')
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save address' }))
    expect(await within(card).findByText(/Someone saved this engagement after you opened it/)).toBeTruthy()
    // The page offers Reload, as for a refused text save.
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    // Reload re-reads the letter, and the card's old failure goes with it.
    api.getEngagementRequest = vi.fn(async () => view({ updatedAt: '2026-10-11T18:00:00.000Z' }, 'hash-7'))
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull())
    expect(within(screen.getByRole('group', { name: 'Addressed to' })).queryByText(/Someone saved this engagement/)).toBeNull()
  })

  it('requires an email: a blank one says so and cannot be saved', async () => {
    await renderEditor()
    const card = screen.getByRole('group', { name: 'Addressed to' })
    fireEvent.change(within(card).getByLabelText('Addressed to email'), { target: { value: '   ' } })
    expect(within(card).getByText('The letter needs an email address to go to.')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Save address' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(within(card).getByRole('button', { name: 'Save address' }))
    expect(api.updateEngagementRequest).not.toHaveBeenCalled()
  })
})

/**
 * E-signature through SignWell (featreq-56d39567): Send for signature beside Send, the status
 * badge, Send reminder, Download signed PDF. Mark as signed stays as the manual path.
 */
describe('e-signature', () => {
  const configured = (testMode = true) => {
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, testMode }))
  }
  const withRequests = (...requests: SignatureRequest[]) => {
    api.listEngagementEsignRequests = vi.fn(async () => requests)
  }

  it('is hidden when SignWell is not set up and the letter has no request', async () => {
    await renderEditor()
    await waitFor(() => expect(api.esignStatusRequest).toHaveBeenCalled())
    await waitFor(() => expect(api.listEngagementEsignRequests).toHaveBeenCalledWith('eng-1'))
    expect(screen.queryByRole('heading', { name: 'E-signature' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send for signature' })).toBeNull()
  })

  it('offers Send for signature beside Send once SignWell is set up, and Mark as signed stays', async () => {
    configured()
    await renderEditor()
    const send = await screen.findByRole('button', { name: 'Send for signature' })
    expect(send).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Mark as signed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark as signed' })).toBeTruthy()
  })

  it('waits for the page to be saved, like Send', async () => {
    configured()
    await renderEditor()
    const send = await screen.findByRole('button', { name: 'Send for signature' })
    fireEvent.change(screen.getByLabelText('Email body'), { target: { value: 'Edited and not saved' } })
    expect(send).toBeDisabled()
  })

  it('confirms with the recipient and the test-mode warning, sends with the page hash, and reads the letter again', async () => {
    configured(true)
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Send for signature' }))
    const confirm = screen.getByRole('group', { name: 'Confirm send for signature' })
    expect(within(confirm).getByText(/Send the engagement letter for Acme Books to pat@acme\.test for signature\?/)).toBeTruthy()
    expect(
      within(confirm).getByText(
        'Test mode - no legally binding document, the client may not receive an email, and it will not mark the letter signed unless this is the Test client.',
      ),
    ).toBeTruthy()
    // Nothing is sent until she confirms.
    expect(api.sendEngagementEsignRequest).not.toHaveBeenCalled()
    const loads = api.getEngagementRequest.mock.calls.length

    withRequests(signatureRequest())
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(api.sendEngagementEsignRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-1' }))
    expect(await screen.findByText(/Sent for signature to pat@acme\.test\. Test mode - no legally binding document/)).toBeTruthy()
    await waitFor(() => expect(api.getEngagementRequest.mock.calls.length).toBeGreaterThan(loads))
    // The badge shows the new request.
    expect(await screen.findByText('E-sign: sent Oct 21')).toBeTruthy()
  })

  it('through eSignatures.io: the intro and the confirm name it, mention its automatic reminders, and say test mode', async () => {
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, provider: 'esignatures', testMode: true }))
    await renderEditor()
    expect(await screen.findByText(/^eSignatures\.io emails pat@acme\.test a link to read and sign the letter/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Send for signature' }))
    const confirm = screen.getByRole('group', { name: 'Confirm send for signature' })
    expect(within(confirm).getByText(/for signature\? eSignatures\.io emails them a link to sign it\.$/)).toBeTruthy()
    expect(within(confirm).getByText('eSignatures.io also reminds them automatically on days 2, 4, 8 and 16.')).toBeTruthy()
    expect(within(confirm).getByText(/^Test mode - no legally binding document/)).toBeTruthy()
  })

  it('a SignWell send says nothing about automatic reminders', async () => {
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, provider: 'signwell', testMode: false }))
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Send for signature' }))
    const confirm = screen.getByRole('group', { name: 'Confirm send for signature' })
    expect(within(confirm).getByText(/SignWell emails them a link to sign it\./)).toBeTruthy()
    expect(within(confirm).queryByText(/reminds them automatically/)).toBeNull()
  })

  it('an eSignatures.io request keeps Send reminder (it resends), and is checked and named by its own provider', async () => {
    // The server now uses SignWell, but this request went to eSignatures.io: it is named for eSignatures.io.
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, provider: 'signwell', testMode: false }))
    withRequests(signatureRequest({ provider: 'esignatures', status: 'viewed' }))
    await renderEditor()
    expect(await screen.findByRole('button', { name: 'Send reminder' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Check eSignatures.io' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Check SignWell' })).toBeNull()
    expect(screen.getByText(/Marking it signed by hand or voiding it withdraws the request at eSignatures\.io\./)).toBeTruthy()
    api.finishEngagementEsignRequest = vi.fn(async () => ({ request: signatureRequest({ provider: 'esignatures', status: 'viewed' }), signed: false, issues: [], engagement: engagement() }))
    fireEvent.click(screen.getByRole('button', { name: 'Check eSignatures.io' }))
    expect(await screen.findByText('Checked eSignatures.io: still viewed.')).toBeTruthy()
  })

  it('Cancel closes the confirm without sending', async () => {
    configured()
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Send for signature' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Confirm send for signature' })).toBeNull()
    expect(api.sendEngagementEsignRequest).not.toHaveBeenCalled()
  })

  it('says nothing about test mode in live mode', async () => {
    configured(false)
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Send for signature' }))
    const confirm = screen.getByRole('group', { name: 'Confirm send for signature' })
    expect(within(confirm).queryByText(/Test mode/)).toBeNull()
    withRequests(signatureRequest({ testMode: false }))
    api.sendEngagementEsignRequest = vi.fn(async () => ({ request: signatureRequest({ testMode: false }), engagement: engagement({ status: 'sent' }) }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send now' }))
    expect(await screen.findByText('Sent for signature to pat@acme.test.')).toBeTruthy()
    expect(screen.queryByText('Test mode', { selector: '.status-pill' })).toBeNull()
  })

  it('says a refusal in plain words and sends nothing', async () => {
    configured()
    api.sendEngagementEsignRequest = vi.fn(async () => {
      throw new ApiError(409, "pat@acme.test belongs to a team member. An engagement letter goes to the client only.", 'team_address')
    })
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Send for signature' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(await screen.findByText(/belongs to someone on your team\. An engagement letter goes to the client only\. Nothing was sent\./)).toBeTruthy()
  })

  it('shows the status badge and the Test mode tag; Send for signature gives way to Send reminder while the request is out', async () => {
    configured()
    withRequests(signatureRequest({ status: 'viewed', testMode: true }))
    await renderEditor()
    expect(await screen.findByText('E-sign: viewed')).toBeTruthy()
    expect(screen.getByText('Test mode', { selector: '.status-pill' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send for signature' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send reminder' })).toBeEnabled()
    expect(screen.getByText(/When the client signs, the letter is marked signed here for you/)).toBeTruthy()
  })

  it('Send reminder calls the server and reads the requests again', async () => {
    configured()
    withRequests(signatureRequest())
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Send reminder' }))
    await waitFor(() => expect(api.remindEngagementEsignRequest).toHaveBeenCalledWith('eng-1'))
    expect(await screen.findByText('Reminder sent to pat@acme.test.')).toBeTruthy()
  })

  it('Send reminder is disabled, with the reason, when one already went out today', async () => {
    configured()
    withRequests(signatureRequest({ lastRemindedAt: new Date().toISOString() }))
    await renderEditor()
    const remind = await screen.findByRole('button', { name: 'Send reminder' })
    expect(remind).toBeDisabled()
    expect(remind).toHaveAttribute('title', 'A reminder already went out today.')
    expect(screen.getByText('A reminder already went out today.')).toBeTruthy()
  })

  it('a reminder the server refuses says why', async () => {
    configured()
    withRequests(signatureRequest())
    api.remindEngagementEsignRequest = vi.fn(async () => {
      throw new ApiError(409, 'A reminder already went out today.', 'reminded_today')
    })
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Send reminder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A reminder already went out today.')
  })

  it('a signed letter shows signed, with a download link for the kept PDF', async () => {
    configured(false)
    api.getEngagementRequest = vi.fn(async () =>
      view({ status: 'signed', signedAt: '2026-10-22T16:00:00.000Z', signedBy: 'user-1', clientId: 'client-9' }),
    )
    withRequests(signatureRequest({ status: 'completed', testMode: false, completedAt: '2026-10-22T15:30:00.000Z', signedDocumentId: 'sigdoc-1' }))
    await renderEditor()
    expect(await screen.findByText('E-sign: signed Oct 22')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Download signed PDF' })
    expect(link.getAttribute('href')).toBe('/api/engagements/eng-1/esign/sigreq-1/pdf')
    expect(screen.queryByRole('button', { name: 'Send for signature' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send reminder' })).toBeNull()
  })

  it('a completed request whose PDF was not kept shows what needs attention, and no download', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent', clientId: 'client-9' }))
    withRequests(signatureRequest({ status: 'completed', completedAt: '2026-10-22T15:30:00.000Z', lastError: 'The signed PDF could not be saved - download it from SignWell' }))
    await renderEditor()
    expect(await screen.findByText('Needs attention: The signed PDF could not be saved - download it from SignWell.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Download signed PDF' })).toBeNull()
  })

  it('hides the needs-attention note once the letter is marked signed', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'signed', signedAt: '2026-10-22T16:00:00.000Z', clientId: 'client-9' }))
    withRequests(signatureRequest({ status: 'completed', signedDocumentId: 'sigdoc-1', lastError: 'Choose which amendments to keep - finish by hand' }))
    await renderEditor()
    expect(await screen.findByText('E-sign: signed')).toBeTruthy()
    expect(screen.queryByText(/Needs attention/)).toBeNull()
  })

  it.each([
    ['declined', 'E-sign: declined'],
    ['expired', 'E-sign: expired'],
    ['canceled', 'E-sign: canceled'],
    ['withdrawn', 'E-sign: withdrawn'],
    ['bounced', 'E-sign: email bounced'],
    ['signed_partial', 'E-sign: partly signed'],
  ] as const)('a %s request reads "%s"', async (status, text) => {
    configured()
    withRequests(signatureRequest({ status }))
    await renderEditor()
    expect(await screen.findByText(text)).toBeTruthy()
  })

  it('a declined or expired request can be sent again', async () => {
    configured()
    withRequests(signatureRequest({ status: 'declined' }))
    await renderEditor()
    expect(await screen.findByRole('button', { name: 'Send for signature' })).toBeEnabled()
  })

  it('puts the e-signature send in the Activity list, with test mode', async () => {
    api.getEngagementRequest = vi.fn(async () =>
      view({
        status: 'sent',
        sentAt: '2026-10-21T15:00:00.000Z',
        emailLog: [{ kind: 'esign', at: '2026-10-21T15:00:00.000Z', to: ['pat@acme.test'], signatureRequestId: 'sigreq-1', testMode: true, ok: true, hash: null }],
      }),
    )
    await renderEditor()
    const activity = screen.getByRole('list', { name: 'Activity' })
    expect(within(activity).getByText('Sent for e-signature to pat@acme.test (test mode)')).toBeTruthy()
    // The sent stamp does not add a second, plain "Sent" line.
    expect(within(activity).queryByText('Sent')).toBeNull()
  })
})

/**
 * Finishing a signature by hand, and the warning while a request is out (fix round 1): the server
 * died part-way or the PDF could not be fetched -> "Finish e-signature"; a letter sent again or
 * edited while a request is open warns that the client will sign the earlier version.
 */
describe('e-signature: finish and the open-request warning', () => {
  const configured = () => {
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, testMode: true }))
  }
  const withRequests = (...requests: SignatureRequest[]) => {
    api.listEngagementEsignRequests = vi.fn(async () => requests)
  }
  const WARNING = 'An e-signature request is open; the client will sign the earlier version.'

  it('offers Finish e-signature for a completed request with no signed PDF, and shows the outcome', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent' }))
    withRequests(signatureRequest({ status: 'completed', finishingAt: '2026-10-22T15:30:00.000Z' }))
    await renderEditor()
    expect(await screen.findByText(/Finishing this signature/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Finish e-signature' }))
    await waitFor(() => expect(api.finishEngagementEsignRequest).toHaveBeenCalledWith('eng-1', 'sigreq-1'))
    expect(await screen.findByText('Finished: the signed PDF is kept and the letter is marked signed.')).toBeTruthy()
  })

  it('says what is still left when finishing could not do it all', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent' }))
    withRequests(signatureRequest({ status: 'completed' }))
    api.finishEngagementEsignRequest = vi.fn(async () => ({
      request: signatureRequest({ status: 'completed' }),
      signed: false,
      issues: ['The letter changed after it went to SignWell - the client signed the earlier version; finish by hand'],
      engagement: engagement({ status: 'sent' }),
    }))
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Finish e-signature' }))
    expect(await screen.findByText(/Finished what could be: The letter changed after it went to SignWell/)).toBeTruthy()
  })

  it('a refusal from the server (SignWell does not read Completed) is shown in its own words', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent' }))
    withRequests(signatureRequest({ status: 'completed' }))
    api.finishEngagementEsignRequest = vi.fn(async () => {
      throw new ApiError(409, 'SignWell shows this document as Viewed, not completed.', 'not_completed')
    })
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Finish e-signature' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('SignWell shows this document as Viewed, not completed.')
  })

  it('offers Finish for a signed letter whose signed PDF is missing, but not for a finished one or a manually completed one', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'signed', signedAt: '2026-10-22T16:00:00.000Z', clientId: 'client-9' }))
    withRequests(signatureRequest({ status: 'completed' }))
    await renderEditor()
    expect(await screen.findByRole('button', { name: 'Finish e-signature' })).toBeTruthy()
    cleanup()

    // Finished: PDF kept and the letter signed.
    withRequests(signatureRequest({ status: 'completed', signedDocumentId: 'sigdoc-1' }))
    await renderEditor()
    await screen.findByRole('link', { name: 'Download signed PDF' })
    expect(screen.queryByRole('button', { name: 'Finish e-signature' })).toBeNull()
    cleanup()

    // Marked complete by a person at SignWell: nothing for the app to finish.
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent' }))
    withRequests(signatureRequest({ status: 'completed', lastError: 'Marked complete in SignWell, not signed by the client - mark it signed by hand if that is right' }))
    await renderEditor()
    await screen.findByText(/Needs attention: Marked complete in SignWell/)
    expect(screen.queryByRole('button', { name: 'Finish e-signature' })).toBeNull()
  })

  it('a request that is still out offers Check SignWell (not Finish e-signature); one that ended offers neither', async () => {
    configured()
    withRequests(signatureRequest({ status: 'viewed' }))
    await renderEditor()
    await screen.findByText('E-sign: viewed')
    expect(screen.queryByRole('button', { name: 'Finish e-signature' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check SignWell' })).toBeEnabled()
    // SignWell has no cancel call in the app: the withdrawal is local only, and the page says so.
    expect(screen.getByText(/Voiding it withdraws the request here only - cancel it at SignWell yourself; marking it signed by hand leaves it as it is\./)).toBeTruthy()
    cleanup()
    for (const status of ['declined', 'expired', 'canceled', 'withdrawn'] as const) {
      withRequests(signatureRequest({ status }))
      await renderEditor()
      await screen.findByText(/^E-sign: /)
      expect(screen.queryByRole('button', { name: 'Check SignWell' }), status).toBeNull()
      expect(screen.queryByRole('button', { name: 'Finish e-signature' }), status).toBeNull()
      cleanup()
    }
  })

  it('Check SignWell says what SignWell shows, and reads the requests again', async () => {
    configured()
    withRequests(signatureRequest({ status: 'sent' }))
    api.finishEngagementEsignRequest = vi.fn(async () => ({
      request: signatureRequest({ status: 'viewed' }),
      signed: false,
      issues: [],
      engagement: engagement({ status: 'sent' }),
    }))
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Check SignWell' }))
    await waitFor(() => expect(api.finishEngagementEsignRequest).toHaveBeenCalledWith('eng-1', 'sigreq-1'))
    expect(await screen.findByText('Checked SignWell: still viewed.')).toBeTruthy()
  })

  it('the sentence follows what the press did, not the request status: a completed request that signed nothing does not say it finished', async () => {
    configured()
    withRequests(signatureRequest({ status: 'viewed' }))
    api.finishEngagementEsignRequest = vi.fn(async () => ({
      request: signatureRequest({ status: 'completed', signedDocumentId: 'sigdoc-1' }),
      signed: false,
      issues: [],
      engagement: engagement({ status: 'sent' }),
    }))
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Check SignWell' }))
    expect(await screen.findByText(/^Checked SignWell: still signed/)).toBeTruthy()
    expect(screen.queryByText(/^Finished/)).toBeNull()
  })

  it('a Check SignWell that completes the request says it finished the signing', async () => {
    configured()
    withRequests(signatureRequest({ status: 'viewed' }))
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Check SignWell' }))
    expect(await screen.findByText('Finished: the signed PDF is kept and the letter is marked signed.')).toBeTruthy()
  })

  it('a failed check says so in its own words, never "Nothing was sent."', async () => {
    configured()
    withRequests(signatureRequest({ status: 'viewed' }))
    api.finishEngagementEsignRequest = vi.fn(async () => {
      throw new ApiError(502, 'SignWell could not be reached, so nothing was checked. Try again in a minute.', 'esign_failed')
    })
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Check SignWell' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('SignWell could not be reached, so nothing was checked. Try again in a minute.')
    expect(alert.textContent).not.toMatch(/Nothing was sent/)
    cleanup()
    // An error with no message of its own still has words.
    api.finishEngagementEsignRequest = vi.fn(async () => {
      throw new Error('boom')
    })
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Check SignWell' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check SignWell. Try again in a minute.')
  })

  it('Save of an edit to the SIGNING DETAILS (retainer, package, plans, fee choice) warns while a request is out, like a text edit', async () => {
    configured()
    withRequests(signatureRequest({ status: 'sent' }))
    await renderEditor()
    await screen.findByText('E-sign: sent Oct 21')
    fireEvent.change(screen.getByLabelText('Retainer amount'), { target: { value: '999' } })
    const confirm = mockConfirm(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.updateEngagementRequest).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Retainer amount'), { target: { value: '630' } })
    await waitFor(() => expect(screen.getByRole('option', { name: 'Full service' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: 'pkg-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(api.updateEngagementRequest).not.toHaveBeenCalled()
  })

  it('Save address warns while a request is out, saves on yes and does nothing on no', async () => {
    configured()
    withRequests(signatureRequest({ status: 'sent' }))
    await renderEditor()
    await screen.findByText('E-sign: sent Oct 21')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@acme.test' } })
    const confirm = mockConfirm(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toBe('An e-signature request is open; the client will sign the earlier version. Save the address anyway?')
    expect(api.updateEngagementRequest).not.toHaveBeenCalled()
    // The first press is still finishing (the button is busy): wait for it before pressing again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save address' })).toBeEnabled())
    mockConfirm(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }))
    await waitFor(() => expect(api.updateEngagementRequest).toHaveBeenCalledTimes(1))
  })

  it('Save address asks nothing when no request is out', async () => {
    configured()
    withRequests(signatureRequest({ status: 'declined' }))
    await renderEditor()
    await screen.findByText('E-sign: declined')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@acme.test' } })
    const confirm = mockConfirm(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }))
    await waitFor(() => expect(api.updateEngagementRequest).toHaveBeenCalledTimes(1))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('warns in the Send picker while a request is out - and does not block it', async () => {
    configured()
    withRequests(signatureRequest({ status: 'sent' }))
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent' }))
    await renderEditor()
    await screen.findByText('E-sign: sent Oct 21')
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    const warning = await screen.findByText(WARNING)
    expect(warning).toBeTruthy()
    // The picker itself is still usable.
    expect(within(screen.getByRole('dialog')).getAllByRole('button').length).toBeGreaterThan(0)
  })

  it.each(['bounced', 'error'] as const)('warns in the Send picker for a %s request too (it can recover to out)', async (status) => {
    configured()
    withRequests(signatureRequest({ status }))
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent' }))
    await renderEditor()
    await screen.findByText(/^E-sign: /)
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    expect(await screen.findByText(WARNING)).toBeTruthy()
  })

  it('Save of an edit warns for a bounced request too', async () => {
    configured()
    withRequests(signatureRequest({ status: 'bounced' }))
    await renderEditor()
    await screen.findByText('E-sign: email bounced')
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Changed subject' } })
    const confirm = mockConfirm(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.updateEngagementRequest).not.toHaveBeenCalled()
  })

  it('does not warn in the Send picker when no request is out', async () => {
    configured()
    withRequests(signatureRequest({ status: 'declined' }))
    await renderEditor()
    await screen.findByText('E-sign: declined')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('dialog')
    expect(screen.queryByText(WARNING)).toBeNull()
  })

  it('Save of an edit asks first while a request is out; cancelling saves nothing, confirming saves', async () => {
    configured()
    withRequests(signatureRequest({ status: 'viewed' }))
    await renderEditor()
    await screen.findByText('E-sign: viewed')
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Changed subject' } })
    const confirm = mockConfirm(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toBe(`${WARNING} Save your edits anyway?`)
    expect(api.updateEngagementRequest).not.toHaveBeenCalled()
    mockConfirm(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateEngagementRequest).toHaveBeenCalledTimes(1))
  })

  it('Save asks nothing when no request is out', async () => {
    configured()
    withRequests(signatureRequest({ status: 'declined' }))
    await renderEditor()
    await screen.findByText('E-sign: declined')
    const confirm = mockConfirm(false)
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Changed subject' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateEngagementRequest).toHaveBeenCalledTimes(1))
    expect(confirm).not.toHaveBeenCalled()
  })
})

/**
 * featreq-60118b28 round 2: a request the withdrawal LEFT OPEN (eSignatures.io refused, the contract may be
 * signed) keeps its note in view even on a signed letter; a letter that no longer stands offers no reminder and
 * no "when the client signs" sentence, and a void or superseded one no Finish.
 */
describe('e-signature on a letter that no longer stands', () => {
  const configured = () => {
    api.esignStatusRequest = vi.fn(async () => ({ configured: true, provider: 'esignatures', testMode: false }))
  }
  const withRequests = (...requests: SignatureRequest[]) => {
    api.listEngagementEsignRequests = vi.fn(async () => requests)
  }
  const NOTE = 'eSignatures.io did not withdraw it when the letter is marked signed (eSignatures.io answered 422) - press Check eSignatures.io'

  it('a signed letter whose request was left open shows the note and Check, but no reminder and no "when the client signs"', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'signed', signedAt: '2026-10-22T16:00:00.000Z', clientId: 'client-9' }))
    withRequests(signatureRequest({ provider: 'esignatures', status: 'viewed', lastError: NOTE }))
    await renderEditor()
    expect(await screen.findByText(`Needs attention: ${NOTE}.`)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check eSignatures.io' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Send reminder' })).toBeNull()
    expect(screen.queryByText(/When the client signs, the letter is marked signed here/)).toBeNull()
  })

  it('a void letter offers no reminder, and no Finish for a request signed after the void (its PDF is kept)', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'void' }))
    withRequests(signatureRequest({ provider: 'esignatures', status: 'viewed' }))
    await renderEditor()
    await screen.findByText('E-sign: viewed')
    expect(screen.queryByRole('button', { name: 'Send reminder' })).toBeNull()
    cleanup()

    withRequests(
      signatureRequest({
        provider: 'esignatures',
        status: 'completed',
        signedDocumentId: 'sigdoc-1',
        lastError: 'Signed after the letter was voided; the signed PDF is kept, nothing was changed here',
      }),
    )
    await renderEditor()
    await screen.findByRole('link', { name: 'Download signed PDF' })
    expect(screen.queryByRole('button', { name: 'Finish e-signature' })).toBeNull()
    expect(screen.getByText(/Needs attention: Signed after the letter was voided/)).toBeTruthy()
  })

  it('a sent letter still offers the reminder and the sentence, per provider', async () => {
    configured()
    api.getEngagementRequest = vi.fn(async () => view({ status: 'sent' }))
    withRequests(signatureRequest({ provider: 'esignatures', status: 'viewed' }))
    await renderEditor()
    expect(await screen.findByRole('button', { name: 'Send reminder' })).toBeTruthy()
    expect(screen.getByText(/Marking it signed by hand or voiding it withdraws the request at eSignatures\.io\./)).toBeTruthy()
  })
})
