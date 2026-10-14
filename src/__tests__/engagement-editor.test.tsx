import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { EngagementEditorPage } from '../pages/EngagementEditorPage'
import { firmToday } from '../../lib/firm-time.js'
import { ApiError, type Engagement, type EngagementSignResult, type EngagementView } from '../lib/types'

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
  engagementPreviewPdfUrl: (id: string) => `/api/engagements/${id}/preview.pdf`,
  sendEngagementRequest: (...args: unknown[]) => api.sendEngagementRequest(...args),
  signEngagementRequest: (...args: unknown[]) => api.signEngagementRequest(...args),
  voidEngagementRequest: (...args: unknown[]) => api.voidEngagementRequest(...args),
  listPackagesRequest: (...args: unknown[]) => api.listPackagesRequest(...args),
  listEngagementSectionsRequest: (...args: unknown[]) => api.listEngagementSectionsRequest(...args),
  listEngagementsRequest: (...args: unknown[]) => api.listEngagementsRequest(...args),
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
  api.previewEngagementRequest = vi.fn(async () => ({
    subject: 'Engagement letter - Acme Books',
    html: '<p>Hi Pat</p>',
    text: 'Hi Pat',
    to: ['pat@acme.test'],
    recipientNote: null,
    missing: [],
    missingNote: null,
    unknown: [],
    retired: [],
    pdfAvailable: true,
    pdfFilename: 'Engagement-Letter-acme-books-2026.pdf',
    refusal: null,
  }))
  api.sendEngagementRequest = vi.fn(async () => ({
    engagement: engagement({ status: 'sent' }),
    ok: true,
    error: null,
  }))
  api.signEngagementRequest = vi.fn(async () => signResult())
  api.voidEngagementRequest = vi.fn(async () => engagement({ status: 'void' }))
  api.listEngagementsRequest = vi.fn(async () => [])
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
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-2', to: 'pat@acme.test' }),
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

describe('Send', () => {
  it('confirms naming the party, the address and the reply-to, then posts the confirmed address', async () => {
    const confirm = mockConfirm(true)
    await renderEditor()
    expect(screen.getByLabelText('Send to')).toHaveValue('pat@acme.test')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(confirm).toHaveBeenCalledWith(
      'Send the engagement letter to Acme Books at pat@acme.test? They get your email with the letter attached as a PDF. Replies go to brittany@pbjsa.com.',
    )
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-1', to: 'pat@acme.test' }),
    )
    expect(await screen.findByText('Sent to pat@acme.test.')).toBeTruthy()
  })

  it('sends to an address typed for this send', async () => {
    const confirm = mockConfirm(true)
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: 'owner@acme.test' } })
    expect(screen.getByText(/For this send only/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(confirm.mock.calls[0][0]).toContain('at owner@acme.test?')
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-1', to: 'owner@acme.test' }),
    )
  })

  it('does nothing on a no', async () => {
    mockConfirm(false)
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(api.sendEngagementRequest).not.toHaveBeenCalled()
  })

  it('is off while the request is in flight', async () => {
    mockConfirm(true)
    let finish: (value: unknown) => void = () => {}
    api.sendEngagementRequest = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const sending = await screen.findByRole('button', { name: 'Sending...' })
    expect(sending).toBeDisabled()
    fireEvent.click(sending)
    expect(api.sendEngagementRequest).toHaveBeenCalledTimes(1)
    finish({ engagement: engagement({ status: 'sent' }), ok: true, error: null })
    await screen.findByText('Sent to pat@acme.test.')
  })

  it('says when the provider refused it', async () => {
    mockConfirm(true)
    api.sendEngagementRequest = vi.fn(async () => ({ engagement: engagement(), ok: false, error: 'Mailbox full' }))
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Not sent: Mailbox full')).toBeTruthy()
  })

  const refusals: Array<[string, ApiError, RegExp]> = [
    ['engagement_invalid', new ApiError(400, 'x', 'engagement_invalid'), /Type one email address to send to/],
    ['unknown_placeholder', new ApiError(409, '{{nope}} is not a placeholder the app fills in. Nothing was sent.', 'unknown_placeholder'), /\{\{nope\}\} is not a placeholder/],
    ['missing_placeholder', new ApiError(409, '{{fee}} has no value for Acme Books - fill it in on the engagement.', 'missing_placeholder'), /\{\{fee\}\} has no value for Acme Books/],
    ['engagement_empty', new ApiError(409, 'x', 'engagement_empty'), /Write the subject, the email and the letter before sending/],
    ['engagement_refused', new ApiError(409, 'This engagement is signed, so it cannot be sent.', 'engagement_refused', 'signed'), /This engagement is signed, so it cannot be sent. Nothing was sent./],
    ['just_sent', new ApiError(409, 'x', 'engagement_refused', 'just_sent'), /This letter went out a moment ago - check the Activity list before sending again./],
    ['team_address', new ApiError(409, 'x', 'team_address'), /belongs to someone on your team/],
    ['no_recipient', new ApiError(409, 'x', 'no_recipient'), /There is no email address to send to/],
    ['pdf_failed', new ApiError(502, 'x', 'pdf_failed'), /The PDF could not be built, so nothing was sent/],
    ['engagement_send_failed', new ApiError(502, 'x', 'engagement_send_failed'), /Email is not set up yet/],
    ['not found', new ApiError(404, 'Engagement not found'), /This engagement no longer exists/],
  ]
  for (const [name, error, sentence] of refusals) {
    it(`answers ${name} with a plain sentence`, async () => {
      mockConfirm(true)
      api.sendEngagementRequest = vi.fn(async () => {
        throw error
      })
      await renderEditor()
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      expect(await screen.findByText(sentence)).toBeTruthy()
    })
  }

  it('re-reads the engagement when it changed since the page loaded', async () => {
    mockConfirm(true)
    api.sendEngagementRequest = vi.fn(async () => {
      throw new ApiError(409, 'changed', 'engagement_changed')
    })
    await renderEditor()
    api.getEngagementRequest = vi.fn(async () => view({ subject: 'Saved elsewhere' }, 'hash-9'))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/The engagement changed since this page loaded/)).toBeTruthy()
    await screen.findByDisplayValue('Saved elsewhere')
    mockConfirm(true)
    api.sendEngagementRequest = vi.fn(async () => ({ engagement: engagement(), ok: true, error: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-9', to: 'pat@acme.test' }),
    )
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
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
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
    expect(api.previewEngagementRequest).toHaveBeenCalledWith('eng-1', undefined)
    expect(within(dialog).getByRole('tab', { name: 'PDF attachment' })).toBeTruthy()
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
      view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', feeMode: 'add', retainerAmount: null }),
    )
    api.updateEngagementRequest = vi.fn(async (_id: string, patch: Partial<Engagement>) =>
      view({ status: 'sent', sentAt: '2026-10-11T16:00:00.000Z', clientId: 'c1', retainerAmount: null, ...patch }, 'hash-2'),
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
