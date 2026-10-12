import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { EngagementEditorPage } from '../pages/EngagementEditorPage'
import { firmToday } from '../../lib/firm-time.js'
import { ApiError, type Engagement, type EngagementView } from '../lib/types'

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
  api.signEngagementRequest = vi.fn(async () => engagement({ status: 'signed' }))
  api.voidEngagementRequest = vi.fn(async () => engagement({ status: 'void' }))
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
    expect(screen.getByText(/Estimated monthly hours: Bookkeeper \(B\) 6.0, Accountant \(A\) 1.5/)).toBeTruthy()
    // The sections the letter was assembled from, by their library titles.
    const used = await screen.findByRole('list', { name: 'Sections used' })
    await waitFor(() => expect(within(used).getByText('Introduction')).toBeTruthy())
  })

  it('offers a chip for every placeholder the engagement GET lists, engagement-only ones included', async () => {
    await renderEditor()
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

  it('warns on a placeholder the app does not fill in', async () => {
    await renderEditor()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hello {{nope}}' } })
    expect(screen.getByText(/\{\{nope\}\} is not a placeholder the app fills in/)).toBeTruthy()
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
    expect(screen.getByText('Save the engagement to preview or send it.')).toBeTruthy()
    fireEvent.click(save)
    await waitFor(() =>
      expect(api.updateEngagementRequest).toHaveBeenCalledWith('eng-1', {
        subject: 'New subject',
        emailBody: 'Hi Pat,\n\nAttached is our engagement letter.',
        letterBody: '**Fees**\n\nOur fee is {{monthly_fee}}. {{retainer_sentence}}',
        retainerAmount: 1000,
        packageId: 'pkg-1',
        planIds: ['plan-2'],
      }),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(api.sendEngagementRequest).toHaveBeenCalledWith('eng-1', { templateHash: 'hash-2', to: 'pat@acme.test' }),
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
  it('lists the sends, the delivery events and the stamps, newest first', async () => {
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
    expect(items.map((item) => item.textContent?.replace(/^.*?(AM|PM) /, ''))).toEqual([
      'Delivered (pat@acme.test)',
      'Sent to pat@acme.test',
      'Drafted from the proposal',
    ])
  })
})
