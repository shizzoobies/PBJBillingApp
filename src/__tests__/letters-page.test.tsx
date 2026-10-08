import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { LetterPreviewModal } from '../components/LetterPreviewModal'
import { PREVIEW_FRAME_PREFIX } from '../components/InvoicePreviewModal'
import { LettersPage } from '../pages/LettersPage'
import {
  ApiError,
  type LetterPreview,
  type LetterSendRecord,
  type LetterTemplateState,
} from '../lib/types'

/**
 * Letters in the UI (featreq-5e195707). The server fills the letter in; these pin
 * what the page asks it for and what it shows: the editor and its guards, the
 * picker's rules, the confirm, the chunks of ten, the results and Last sent.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchLetterTemplate: (...args: unknown[]) => api.fetchLetterTemplate(...args),
  saveLetterTemplate: (...args: unknown[]) => api.saveLetterTemplate(...args),
  listLetterSendsRequest: (...args: unknown[]) => api.listLetterSendsRequest(...args),
  sendLettersRequest: (...args: unknown[]) => api.sendLettersRequest(...args),
  previewLetterRequest: (...args: unknown[]) => api.previewLetterRequest(...args),
  letterPreviewPdfUrl: (id: string) => `/api/letters/preview.pdf?clientId=${id}`,
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const PLACEHOLDERS = [
  { key: 'client_name', label: 'Client name', description: "The client's name.", required: true },
  { key: 'fee', label: 'Fee', description: 'The fee.', required: true },
  { key: 'next_year', label: 'Next year', description: 'The coming year.', required: false },
]

function templateState(over: Partial<LetterTemplateState['template']> = {}, hash = 'hash-1'): LetterTemplateState {
  return {
    template: {
      subject: 'Your {{next_year}} 1099s',
      emailBody: 'Hi {{client_name}},\n\nThe letter is attached.',
      letterBody: 'Dear {{client_name}},\n\nOur fee is {{fee}}.',
      updatedAt: '2026-10-08T15:00:00.000Z',
      updatedBy: 'user-1',
      updatedByName: 'Brittany',
      ...over,
    },
    hash,
    placeholders: PLACEHOLDERS,
    warnings: { unknown: [] },
    sender: { from: 'PB&J Strategic Accounting <billing@pbjsa.com>', replyTo: 'brittany@pbjsa.com' },
  }
}

const CLIENTS = [
  { id: 'c-acme', name: 'Acme Books', contact: 'Pat Doe', email: 'pat@acme.test', contactIds: [], lifecycleStage: 'active' },
  { id: 'c-noemail', name: 'No Email Co', contact: '', email: '', contactIds: [], lifecycleStage: 'active' },
  { id: 'c-old', name: 'Old Co', contact: '', email: 'old@old.test', contactIds: [], lifecycleStage: 'inactive' },
  {
    id: 'c-master',
    name: 'KLC Holdings',
    contact: '',
    email: 'master@klc.test',
    contactIds: [],
    lifecycleStage: 'active',
    isBillingMaster: true,
    invoiceRecipientClientId: '',
  },
  { id: 'c-onb', name: 'Onboarding Co', contact: '', email: 'new@onb.test', contactIds: [], lifecycleStage: 'onboarding' },
  { id: 'c-prop', name: 'Prospect Co', contact: '', email: 'p@prospect.test', contactIds: [], lifecycleStage: 'proposal' },
  {
    id: 'c-sub',
    name: 'KLC North',
    contact: '',
    email: 'north@klc.test',
    contactIds: [],
    lifecycleStage: 'active',
    billToClientId: 'c-master',
    invoiceNoEmail: true,
    platformInvoicingOptOut: true,
  },
]

const sendRecord = (over: Partial<LetterSendRecord>): LetterSendRecord => ({
  id: 'els-1',
  letterId: 'default',
  clientId: 'c-acme',
  templateHash: 'hash-1',
  firmDay: '2026-10-08',
  attempt: 1,
  status: 'sent',
  recipients: ['pat@acme.test'],
  subject: 's',
  providerId: 're_1',
  error: null,
  delivery: null,
  createdBy: 'user-1',
  createdAt: '2026-10-08T15:00:00.000Z',
  completedAt: '2026-10-08T15:00:01.000Z',
  ...over,
})

/** happy-dom has no window.confirm: install one that answers `answer`. */
function mockConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer)
  window.confirm = confirm
  return confirm
}

function setClients(clients: unknown[]) {
  contextValue = {
    ownerMode: true,
    dataRefreshCount: 0,
    data: { clients, contacts: [] },
  } as unknown as AppContextValue
}

async function renderPage() {
  render(<LettersPage />)
  await screen.findByDisplayValue('Your {{next_year}} 1099s')
}

beforeEach(() => {
  setClients(CLIENTS)
  api.fetchLetterTemplate = vi.fn(async () => templateState())
  api.saveLetterTemplate = vi.fn(async (input: { subject: string; emailBody: string; letterBody: string }) =>
    templateState(input, 'hash-2'),
  )
  api.listLetterSendsRequest = vi.fn(async () => [])
  api.sendLettersRequest = vi.fn(async (input: { clientIds: string[] }) => ({
    results: input.clientIds.map((clientId) => ({
      clientId,
      clientName: clientId,
      status: 'sent' as const,
      to: [`${clientId}@x.test`],
    })),
    sent: input.clientIds.length,
    failed: 0,
    skipped: 0,
  }))
  api.previewLetterRequest = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the editor', () => {
  it('shows the saved letter, who it is from, who replies reach and who saved it', async () => {
    await renderPage()
    expect(screen.getByLabelText('Subject')).toHaveValue('Your {{next_year}} 1099s')
    expect(screen.getByLabelText('Email body')).toHaveValue('Hi {{client_name}},\n\nThe letter is attached.')
    expect(screen.getByLabelText('Letter body')).toHaveValue('Dear {{client_name}},\n\nOur fee is {{fee}}.')
    expect(screen.getByText('This is the email. The letter rides along as a PDF.')).toBeInTheDocument()
    expect(screen.getByText(/Blank lines start a new paragraph/)).toBeInTheDocument()
    expect(screen.getByText(/replies go to brittany@pbjsa.com/)).toBeInTheDocument()
    expect(screen.getByText(/Last saved Oct 8, 2026 by Brittany/)).toBeInTheDocument()
  })

  it('saves the three boxes and shows the badge; Save is off until something changed', async () => {
    await renderPage()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'New subject' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() =>
      expect(api.saveLetterTemplate).toHaveBeenCalledWith({
        subject: 'New subject',
        emailBody: 'Hi {{client_name}},\n\nThe letter is attached.',
        letterBody: 'Dear {{client_name}},\n\nOur fee is {{fee}}.',
      }),
    )
    await screen.findByText('Saved')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('says the server\'s sentence when a save is refused', async () => {
    api.saveLetterTemplate = vi.fn(async () => {
      throw new ApiError(400, 'The subject can be at most 200 characters.')
    })
    await renderPage()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The subject can be at most 200 characters.')).toBeInTheDocument()
    expect(screen.getByText('Couldn’t save')).toBeInTheDocument()
  })

  it('warns about a placeholder the app does not fill in, and clears the warning when it is fixed', async () => {
    await renderPage()
    const letter = screen.getByLabelText('Letter body')
    fireEvent.change(letter, { target: { value: 'Dear {{clientname}}' } })
    expect(
      screen.getByText('{{clientname}} is not a placeholder the app fills in. Send will refuse until it is changed.'),
    ).toBeInTheDocument()
    fireEvent.change(letter, { target: { value: 'Dear {{client_name}}' } })
    expect(screen.queryByText(/is not a placeholder/)).not.toBeInTheDocument()
  })

  it('inserts a placeholder at the caret in the box it sits under', async () => {
    await renderPage()
    const email = screen.getByLabelText('Email body') as HTMLTextAreaElement
    email.focus()
    email.setSelectionRange(3, 3)
    const group = screen.getByRole('group', { name: 'Insert a placeholder into the email' })
    fireEvent.click(within(group).getByRole('button', { name: '{{fee}}' }))
    expect(email).toHaveValue('Hi {{fee}}{{client_name}},\n\nThe letter is attached.')
    // The other boxes are untouched.
    expect(screen.getByLabelText('Subject')).toHaveValue('Your {{next_year}} 1099s')
  })

  it('replaces a selected range with the placeholder', async () => {
    await renderPage()
    const subject = screen.getByLabelText('Subject') as HTMLInputElement
    subject.focus()
    subject.setSelectionRange(5, 7)
    const group = screen.getByRole('group', { name: 'Insert a placeholder into the subject' })
    fireEvent.click(within(group).getByRole('button', { name: '{{client_name}}' }))
    expect(subject).toHaveValue('Your {{client_name}}next_year}} 1099s')
  })

  it('turns Preview and Send off while the editor holds unsaved text, and says why', async () => {
    api.listLetterSendsRequest = vi.fn(async () => [])
    await renderPage()
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    expect(screen.getByRole('button', { name: 'Send to 1 client' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: 'Preview' })[0]).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Letter body'), { target: { value: 'changed' } })
    expect(screen.getByRole('button', { name: 'Send to 1 client' })).toBeDisabled()
    for (const preview of screen.getAllByRole('button', { name: 'Preview' })) expect(preview).toBeDisabled()
    expect(screen.getByText('Save the letter to preview or send it.')).toBeInTheDocument()
  })
})

describe('the client picker', () => {
  it('lists active AND onboarding clients by default, with inactive and proposal-stage ones behind the checkbox', async () => {
    await renderPage()
    expect(screen.getByText('Acme Books')).toBeInTheDocument()
    expect(screen.getByText('Onboarding Co')).toBeInTheDocument()
    expect(screen.queryByText('Old Co')).not.toBeInTheDocument()
    expect(screen.queryByText('Prospect Co')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Include inactive and proposal-stage clients'))
    expect(screen.getByText('Old Co')).toBeInTheDocument()
    expect(screen.getByText('Prospect Co')).toBeInTheDocument()
    expect(screen.getByText('Inactive')).toBeInTheDocument()
    expect(screen.getByText('Proposal stage')).toBeInTheDocument()
  })

  it('does not flag an onboarding client with a pill: it is an ordinary client for a letter', async () => {
    await renderPage()
    expect(screen.queryByText('Onboarding')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Select Onboarding Co')).toBeEnabled()
  })

  it('shows the primary contact under the name and the addresses a send would use', async () => {
    await renderPage()
    expect(screen.getByText('Pat Doe')).toBeInTheDocument()
    expect(screen.getByText('pat@acme.test')).toBeInTheDocument()
  })

  it('disables a client with no email, and a master with no receiving company', async () => {
    await renderPage()
    expect(screen.getByLabelText('Select No Email Co')).toBeDisabled()
    expect(screen.getAllByText('No email on file').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Select KLC Holdings')).toBeDisabled()
    expect(screen.getByText('No receiving company set')).toBeInTheDocument()
    expect(screen.getByLabelText('Select Acme Books')).toBeEnabled()
  })

  it('shows the invoice switches and the master as pills, and still lets that client be picked', async () => {
    await renderPage()
    expect(screen.getByText('Invoices never emailed')).toBeInTheDocument()
    expect(screen.getByText('Billed outside the app')).toBeInTheDocument()
    expect(screen.getByText('Billed through KLC Holdings')).toBeInTheDocument()
    expect(screen.getByLabelText('Select KLC North')).toBeEnabled()
  })

  it('Select all shown takes only the pickable shown rows; Clear empties; the count follows', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    expect(screen.getByText('3 selected')).toBeInTheDocument() // Acme, Onboarding Co and KLC North
    expect(screen.getByLabelText('Select Acme Books')).toBeChecked()
    expect(screen.getByLabelText('Select KLC North')).toBeChecked()
    expect(screen.getByLabelText('Select No Email Co')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Send to 3 clients' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to 0 clients' })).toBeDisabled()
  })

  it('Select all shown respects the search', async () => {
    await renderPage()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'acme' } })
    expect(screen.queryByText('KLC North')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })
})

describe('Last sent', () => {
  it('shows the day of the newest sent row, with the delivery word when there is one', async () => {
    api.listLetterSendsRequest = vi.fn(async () => [
      sendRecord({ id: 'els-2', delivery: 'delivered' }),
      sendRecord({ id: 'els-1', firmDay: '2026-09-01' }),
    ])
    await renderPage()
    expect(await screen.findByText('Oct 8, 2026 - delivered')).toBeInTheDocument()
  })

  it('shows a failure when nothing was ever sent, and a dash for a client never written to', async () => {
    api.listLetterSendsRequest = vi.fn(async () => [
      sendRecord({ clientId: 'c-sub', status: 'failed', error: 'Email provider refused the message (422).' }),
    ])
    await renderPage()
    expect(await screen.findByText('Failed: Email provider refused the message (422).')).toBeInTheDocument()
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)
  })
})

describe('a send that never finished', () => {
  it('reads "Sending..." while recent and "Did not finish" once it is over ten minutes old', async () => {
    api.listLetterSendsRequest = vi.fn(async () => [
      sendRecord({ id: 'els-old', clientId: 'c-acme', status: 'sending', completedAt: null, createdAt: '2026-10-08T12:00:00.000Z' }),
      sendRecord({ id: 'els-new', clientId: 'c-onb', status: 'sending', completedAt: null, createdAt: new Date().toISOString() }),
    ])
    await renderPage()
    expect(await screen.findByText('Did not finish - check before sending again')).toBeInTheDocument()
    expect(screen.getByText('Sending...')).toBeInTheDocument()
  })

  it('shows the unfinished sentence and offers Send again anyway, with its own confirm', async () => {
    api.sendLettersRequest = vi.fn(async (input: { clientIds: string[]; resendToday?: boolean }) => ({
      results: input.resendToday
        ? [{ clientId: 'c-acme', clientName: 'Acme Books', status: 'sent' as const, to: ['pat@acme.test'] }]
        : [
            {
              clientId: 'c-acme',
              clientName: 'Acme Books',
              status: 'skipped' as const,
              code: 'unfinished' as const,
              message:
                'A send to Acme Books started at Oct 8, 2:05 PM and never finished - check with them, then use Send again anyway.',
            },
          ],
      sent: 0,
      failed: 0,
      skipped: 1,
    }))
    const confirm = mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 client' }))
    expect(await screen.findByText(/started at Oct 8, 2:05 PM and never finished/)).toBeInTheDocument()
    expect(screen.queryByText(/Already sent today/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send again anyway' }))
    expect(confirm).toHaveBeenLastCalledWith(
      'Send the letter to Acme Books again? An earlier send to them never finished, so check that it did not go out first.',
    )
    await waitFor(() =>
      expect(api.sendLettersRequest).toHaveBeenLastCalledWith({ clientIds: ['c-acme'], templateHash: 'hash-1', resendToday: true }),
    )
  })
})

describe('sending', () => {
  const ids = (call: unknown[]) => (call[0] as { clientIds: string[] }).clientIds

  it('confirms with the count and the reply address, and sends nothing if she cancels', async () => {
    const confirm = mockConfirm(false)
    await renderPage()
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 client' }))
    expect(confirm).toHaveBeenCalledWith(
      'Send the engagement letter to 1 client? Each gets your email with the letter attached as a PDF. Replies go to brittany@pbjsa.com.',
    )
    expect(api.sendLettersRequest).not.toHaveBeenCalled()
  })

  it('sends the page\'s template hash and shows a result per client', async () => {
    mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 3 clients' }))
    await screen.findByText('3 sent, 0 skipped, 0 failed.')
    expect(api.sendLettersRequest).toHaveBeenCalledTimes(1)
    expect(api.sendLettersRequest).toHaveBeenCalledWith({
      clientIds: expect.arrayContaining(['c-acme', 'c-sub']),
      templateHash: 'hash-1',
    })
    expect(screen.getByText(/Sent to c-acme@x.test/)).toBeInTheDocument()
  })

  it('sends in chunks of ten, one request after the other', async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({
      id: `c-${n}`,
      name: `Client ${String(n).padStart(2, '0')}`,
      contact: '',
      email: `c${n}@x.test`,
      contactIds: [],
      lifecycleStage: 'active',
    }))
    setClients(many)
    mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 12 clients' }))
    await screen.findByText('12 sent, 0 skipped, 0 failed.')
    const calls = (api.sendLettersRequest as Mock).mock.calls
    expect(calls.map(ids).map((chunk) => chunk.length)).toEqual([10, 2])
  })

  it('offers "Send again anyway" for an already-sent client and then claims a second send', async () => {
    api.sendLettersRequest = vi.fn(async (input: { clientIds: string[]; resendToday?: boolean }) => ({
      results: input.resendToday
        ? [{ clientId: 'c-acme', clientName: 'Acme Books', status: 'sent' as const, to: ['pat@acme.test'] }]
        : [
            {
              clientId: 'c-acme',
              clientName: 'Acme Books',
              status: 'skipped' as const,
              code: 'already_sent' as const,
              message: 'Acme Books was already sent this letter today. Use Send again to send it a second time.',
            },
          ],
      sent: 0,
      failed: 0,
      skipped: 1,
    }))
    const confirm = mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 client' }))
    await screen.findByText(/Already sent today\./)
    fireEvent.click(screen.getByRole('button', { name: 'Send again anyway' }))
    expect(confirm).toHaveBeenLastCalledWith('Send the letter to Acme Books again? It was already sent today.')
    await waitFor(() =>
      expect(api.sendLettersRequest).toHaveBeenLastCalledWith({
        clientIds: ['c-acme'],
        templateHash: 'hash-1',
        resendToday: true,
      }),
    )
    await screen.findByText(/Sent to pat@acme.test/)
  })

  it('shows the server\'s sentence for a failure and offers to send again to the ones that failed', async () => {
    let first = true
    api.sendLettersRequest = vi.fn(async (input: { clientIds: string[] }) => {
      const failing = first
      first = false
      return {
        results: input.clientIds.map((clientId) =>
          failing && clientId === 'c-sub'
            ? {
                clientId,
                clientName: 'KLC North',
                status: 'failed' as const,
                code: 'provider' as const,
                message: 'Email provider refused the message (422).',
              }
            : { clientId, clientName: clientId, status: 'sent' as const, to: ['x@x.test'] },
        ),
        sent: 0,
        failed: 0,
        skipped: 0,
      }
    })
    mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 3 clients' }))
    await screen.findByText(/Failed: Email provider refused the message \(422\)\./)
    fireEvent.click(screen.getByRole('button', { name: 'Send again to the 1 that failed' }))
    await waitFor(() => expect(api.sendLettersRequest).toHaveBeenCalledTimes(2))
    expect((api.sendLettersRequest as Mock).mock.calls[1][0]).toEqual({
      clientIds: ['c-sub'],
      templateHash: 'hash-1',
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /that failed/ })).not.toBeInTheDocument())
  })

  it('on a changed letter reloads it, says so and stops', async () => {
    api.sendLettersRequest = vi.fn(async () => {
      throw new ApiError(
        409,
        'The letter changed since this page loaded. Nothing was sent. Reload and send again.',
        'letter_changed',
      )
    })
    mockConfirm(true)
    await renderPage()
    expect(api.fetchLetterTemplate).toHaveBeenCalledTimes(1)
    api.fetchLetterTemplate = vi.fn(async () => templateState({ subject: 'Someone else saved this' }, 'hash-9'))
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 client' }))
    expect(
      await screen.findByText('The letter changed since this page loaded. Nothing was sent. Reload and send again.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Someone else saved this'))
    expect(api.sendLettersRequest).toHaveBeenCalledTimes(1)
  })

  it('refreshes the log after a send so Last sent follows', async () => {
    mockConfirm(true)
    await renderPage()
    api.listLetterSendsRequest = vi.fn(async () => [sendRecord({})])
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 client' }))
    expect(await screen.findByText('Oct 8, 2026')).toBeInTheDocument()
  })
})

describe('Preview', () => {
  it('opens the per-client preview, built for that client', async () => {
    const preview: LetterPreview = {
      subject: 'Your 2027 1099s',
      html: '<p>Hi Acme</p>',
      text: 'Hi Acme',
      to: ['pat@acme.test'],
      recipientDetails: [{ email: 'pat@acme.test', source: 'client record' }],
      recipientNote: null,
      pdfAvailable: true,
      pdfFilename: 'Engagement-Letter-Acme-Books-2026.pdf',
      missing: [],
      missingNote: null,
      unknown: [],
      flags: { neverEmailed: false, billedOutside: false, inactive: false, billingMasterSub: null },
      refusal: null,
    }
    api.previewLetterRequest = vi.fn(async () => preview)
    await renderPage()
    const row = screen.getByText('Acme Books').closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('dialog', { name: 'Preview of the letter for Acme Books' })).toBeInTheDocument()
    expect(api.previewLetterRequest).toHaveBeenCalledWith('c-acme')
  })
})

describe('LetterPreviewModal', () => {
  const base: LetterPreview = {
    subject: 'Your 2027 1099s',
    html: '<p>Hi <a href="https://x.test">Acme</a></p>',
    text: 'Hi Acme',
    to: ['pat@acme.test', 'lee@acme.test'],
    recipientDetails: [],
    recipientNote: null,
    pdfAvailable: true,
    pdfFilename: 'Engagement-Letter-Acme-2026.pdf',
    missing: [],
    missingNote: null,
    unknown: [],
    flags: { neverEmailed: false, billedOutside: false, inactive: false, billingMasterSub: null },
    refusal: null,
  }

  it('renders the email in a sandboxed frame with links retargeted, and the PDF in its own tab', async () => {
    api.previewLetterRequest = vi.fn(async () => base)
    render(<LetterPreviewModal clientId="c-acme" clientName="Acme Books" onClose={() => {}} />)
    expect(await screen.findByText('What Acme Books receives')).toBeInTheDocument()
    expect(screen.getByText('Built by the same code as Send. Nothing is sent or saved from here.')).toBeInTheDocument()
    expect(screen.getByText('To: pat@acme.test, lee@acme.test')).toBeInTheDocument()
    expect(screen.getByText('Your 2027 1099s')).toBeInTheDocument()
    const frame = screen.getByTitle('Email preview')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toBe(PREVIEW_FRAME_PREFIX + base.html)
    expect(frame.getAttribute('srcdoc')?.startsWith('<base target="_blank">')).toBe(true)

    fireEvent.click(screen.getByRole('tab', { name: 'PDF attachment' }))
    expect(screen.getByTitle('PDF preview').getAttribute('src')).toBe('/api/letters/preview.pdf?clientId=c-acme')
  })

  it('says what would stop Send: missing values, a missing PDF, a refusal', async () => {
    api.previewLetterRequest = vi.fn(async () => ({
      ...base,
      to: [],
      refusal: 'No email address on file for this client — add one to the client or one of its contacts.',
      missing: ['fee'],
      missingNote:
        'Acme Books is billed hourly, so there is no single fee to fill in - take {{fee}} out of the letter, or write their rates by hand.',
      pdfAvailable: false,
      flags: { neverEmailed: true, billedOutside: true, inactive: false, billingMasterSub: 'KLC Holdings' },
    }))
    render(<LetterPreviewModal clientId="c-acme" clientName="Acme Books" onClose={() => {}} />)
    expect(await screen.findByText(/No email address on file for this client/)).toBeInTheDocument()
    expect(screen.getByText('Missing for this client: {{fee}}. Send skips this client.')).toBeInTheDocument()
    expect(screen.getByText(/is billed hourly, so there is no single fee to fill in - take \{\{fee\}\} out of the letter/)).toBeInTheDocument()
    expect(screen.getByText('The PDF could not be built, so Send would skip this client.')).toBeInTheDocument()
    expect(screen.getByText(/never have invoices emailed\. A letter is not an invoice/)).toBeInTheDocument()
    expect(screen.getByText('This client is billed through KLC Holdings.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'PDF attachment' }))
    expect(screen.getByText('There is no PDF to show.')).toBeInTheDocument()
  })

  it('shows the error when the preview cannot be built, and closes on Escape and on Close', async () => {
    api.previewLetterRequest = vi.fn(async () => {
      throw new ApiError(404, 'Client not found')
    })
    const onClose = vi.fn()
    render(<LetterPreviewModal clientId="gone" clientName="Gone Co" onClose={onClose} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Client not found')
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
