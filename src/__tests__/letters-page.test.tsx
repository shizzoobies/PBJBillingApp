import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { LetterPreviewModal } from '../components/LetterPreviewModal'
import { PREVIEW_FRAME_PREFIX } from '../components/InvoicePreviewModal'
import { LettersPage } from '../pages/LettersPage'
import {
  ApiError,
  type LetterListState,
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
  listLettersRequest: (...args: unknown[]) => api.listLettersRequest(...args),
  createLetterRequest: (...args: unknown[]) => api.createLetterRequest(...args),
  renameLetterRequest: (...args: unknown[]) => api.renameLetterRequest(...args),
  deleteLetterRequest: (...args: unknown[]) => api.deleteLetterRequest(...args),
  fetchLetterTemplate: (...args: unknown[]) => api.fetchLetterTemplate(...args),
  saveLetterTemplate: (...args: unknown[]) => api.saveLetterTemplate(...args),
  listLetterSendsRequest: (...args: unknown[]) => api.listLetterSendsRequest(...args),
  sendLettersRequest: (...args: unknown[]) => api.sendLettersRequest(...args),
  previewLetterRequest: (...args: unknown[]) => api.previewLetterRequest(...args),
  letterPreviewPdfUrl: (letterId: string, clientId: string) => `/api/letters/${letterId}/preview.pdf?clientId=${clientId}`,
}))

const api: Record<string, Mock> = {}
let contextValue: AppContextValue

const PLACEHOLDERS = [
  { key: 'client_name', label: 'Client name', description: "The client's name.", required: true },
  { key: 'fee', label: 'Fee', description: 'The fee.', required: true },
  { key: 'next_year', label: 'Next year', description: 'The coming year.', required: false },
]

function templateState(
  over: Partial<LetterTemplateState['template']> = {},
  hash = 'hash-1',
  teamAddresses: string[] = [],
): LetterTemplateState {
  return {
    template: {
      id: 'default',
      name: '1099 Filing',
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
    warnings: { unknown: [], retired: [] },
    sender: { from: 'PB&J Strategic Accounting <billing@pbjsa.com>', replyTo: 'brittany@pbjsa.com' },
    teamAddresses,
  }
}

function listState(letters: LetterListState['letters'] = [LETTER_1099]): LetterListState {
  const base = templateState()
  return { letters, placeholders: base.placeholders, sender: base.sender, teamAddresses: base.teamAddresses }
}

const LETTER_1099 = { id: 'default', name: '1099 Filing', subject: 'Your {{next_year}} 1099s', updatedAt: '2026-10-08T15:00:00.000Z', sendCount: 0 }

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
  api.listLettersRequest = vi.fn(async () => listState())
  api.createLetterRequest = vi.fn()
  api.renameLetterRequest = vi.fn()
  api.deleteLetterRequest = vi.fn(async () => {})
  api.fetchLetterTemplate = vi.fn(async () => templateState())
  api.saveLetterTemplate = vi.fn(async (_id: string, input: { subject: string; emailBody: string; letterBody: string }) =>
    templateState(input, 'hash-2'),
  )
  api.listLetterSendsRequest = vi.fn(async () => [])
  api.sendLettersRequest = vi.fn(async (_id: string, input: { clientIds: string[] }) => ({
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
      expect(api.saveLetterTemplate).toHaveBeenCalledWith('default', {
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

  it('offers a chip for every placeholder the server lists, and none for the retired hourly_rate', async () => {
    await renderPage()
    const group = screen.getByRole('group', { name: 'Insert a placeholder into the email' })
    expect(within(group).getByRole('button', { name: '{{fee}}' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '{{hourly_rate}}' })).not.toBeInTheDocument()
  })

  // Engagements stage 2C: the engagement-only keys (retainer, services lists...) belong
  // to engagement letters; a Letters template that named one would be refused as unknown.
  it('never offers an engagement-only placeholder, even if the server listed one', async () => {
    api.fetchLetterTemplate = vi.fn(async () => ({
      ...templateState(),
      placeholders: [
        ...PLACEHOLDERS,
        { key: 'retainer_sentence', label: 'Retainer', description: 'The retainer.', required: false, scope: 'engagement' as const },
      ],
    }))
    await renderPage()
    const group = screen.getByRole('group', { name: 'Insert a placeholder into the email' })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '{{client_name}}',
      '{{fee}}',
      '{{next_year}}',
    ])
  })

  it('warns that {{hourly_rate}} is no longer filled in, with the retired wording, and clears it when taken out', async () => {
    await renderPage()
    const letter = screen.getByLabelText('Letter body')
    fireEvent.change(letter, { target: { value: 'At {{hourly_rate}} an hour.' } })
    expect(
      screen.getByText('{{hourly_rate}} is no longer filled in - hourly clients have no single rate; take it out.'),
    ).toBeInTheDocument()
    // It is not reported as a typo as well.
    expect(screen.queryByText(/is not a placeholder the app fills in/)).not.toBeInTheDocument()
    fireEvent.change(letter, { target: { value: 'At our rates.' } })
    expect(screen.queryByText(/is no longer filled in/)).not.toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: 'Preview' })[0]).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Letter body'), { target: { value: 'changed' } })
    expect(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' })).toBeDisabled()
    for (const preview of screen.getAllByRole('button', { name: 'Preview' })) expect(preview).toBeDisabled()
    expect(screen.getByText('Save the letter to preview or send it.')).toBeInTheDocument()
  })
})

// Brittany's send-back of 2026-10-10: bold text, and more than one saved letter.
describe('bold (the B button and Ctrl+B)', () => {
  it('wraps the selected words in the letter in ** and keeps the other boxes as they were', async () => {
    await renderPage()
    const letter = screen.getByLabelText('Letter body') as HTMLTextAreaElement
    const at = letter.value.indexOf('{{fee}}')
    letter.focus()
    letter.setSelectionRange(at, at + '{{fee}}'.length)
    fireEvent.click(screen.getByRole('button', { name: 'Bold in the letter' }))
    expect(letter).toHaveValue('Dear {{client_name}},\n\nOur fee is **{{fee}}**.')
    expect(screen.getByLabelText('Email body')).toHaveValue('Hi {{client_name}},\n\nThe letter is attached.')
    // An edit like any other: Save turns on.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('Ctrl+B in the email does the same, and again takes it off', async () => {
    await renderPage()
    const email = screen.getByLabelText('Email body') as HTMLTextAreaElement
    email.focus()
    email.setSelectionRange(0, 2)
    fireEvent.keyDown(email, { key: 'b', ctrlKey: true })
    expect(email).toHaveValue('**Hi** {{client_name}},\n\nThe letter is attached.')
    email.setSelectionRange(2, 4)
    fireEvent.keyDown(email, { key: 'B', metaKey: true })
    expect(email).toHaveValue('Hi {{client_name}},\n\nThe letter is attached.')
  })

  it('offers no bold for the subject, and says how bold works', async () => {
    await renderPage()
    expect(screen.getByRole('toolbar', { name: 'Format the email' })).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Format the letter' })).toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: 'Format the subject' })).not.toBeInTheDocument()
    expect(screen.getByText(/wrapped in \*\*double asterisks\*\* and come out bold in the email and the PDF/)).toBeInTheDocument()
  })
})

describe('the letters list', () => {
  const OTHER = { id: 'letter-2', name: 'Engagement 2027', subject: 'Engagement for {{next_year}}', updatedAt: null, sendCount: 0 }

  /** Two letters, each loaded by its own id with its own text and hash. */
  function twoLetters() {
    api.listLettersRequest = vi.fn(async () => listState([LETTER_1099, OTHER]))
    api.fetchLetterTemplate = vi.fn(async (id: string) =>
      id === 'letter-2'
        ? templateState({ id: 'letter-2', name: 'Engagement 2027', subject: 'Engagement for {{next_year}}' }, 'hash-L2')
        : templateState(),
    )
  }

  it('lists the saved letters and opens the first, with its own send log', async () => {
    twoLetters()
    await renderPage()
    const list = screen.getByRole('group', { name: 'Saved letters' })
    expect(within(list).getByRole('button', { name: '1099 Filing' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(list).getByRole('button', { name: 'Engagement 2027' })).toHaveAttribute('aria-pressed', 'false')
    expect(api.fetchLetterTemplate).toHaveBeenCalledWith('default')
    expect(api.listLetterSendsRequest).toHaveBeenCalledWith('default')
    expect(screen.getByRole('heading', { name: '1099 Filing' })).toBeInTheDocument()
  })

  it('opens another letter, and Last sent, Preview and Send then work on that letter', async () => {
    twoLetters()
    api.listLetterSendsRequest = vi.fn(async (id: string) =>
      id === 'default' ? [sendRecord({ firmDay: '2026-09-01' })] : [],
    )
    api.previewLetterRequest = vi.fn(async () => {
      throw new ApiError(404, 'stop here')
    })
    mockConfirm(true)
    await renderPage()
    expect(await screen.findByText('Sep 1, 2026')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Engagement 2027' }))
    await screen.findByDisplayValue('Engagement for {{next_year}}')
    expect(api.listLetterSendsRequest).toHaveBeenLastCalledWith('letter-2')
    // The 1099 letter's Last sent is not this letter's.
    await waitFor(() => expect(screen.queryByText('Sep 1, 2026')).not.toBeInTheDocument())

    const row = screen.getByText('Acme Books').closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(api.previewLetterRequest).toHaveBeenCalledWith('letter-2', 'c-acme'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send "Engagement 2027" to 1 client' }))
    await waitFor(() =>
      expect(api.sendLettersRequest).toHaveBeenCalledWith('letter-2', { clientIds: ['c-acme'], templateHash: 'hash-L2' }),
    )
  })

  it('asks before leaving unsaved text for another letter, and stays when she says no', async () => {
    twoLetters()
    const confirm = mockConfirm(false)
    await renderPage()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Half-written' } })
    fireEvent.click(screen.getByRole('button', { name: 'Engagement 2027' }))
    expect(confirm).toHaveBeenCalledWith('"1099 Filing" has changes that are not saved. Leave them and go on?')
    expect(screen.getByLabelText('Subject')).toHaveValue('Half-written')
    expect(api.fetchLetterTemplate).not.toHaveBeenCalledWith('letter-2')
  })

  it('adds a new letter by name and opens it, empty', async () => {
    const created = templateState({ id: 'letter-new', name: 'Engagement 2027', subject: '', emailBody: '', letterBody: '', updatedAt: null }, 'hash-new')
    api.createLetterRequest = vi.fn(async () => created)
    await renderPage()
    api.listLettersRequest = vi.fn(async () =>
      listState([LETTER_1099, { id: 'letter-new', name: 'Engagement 2027', subject: '', updatedAt: null, sendCount: 0 }]),
    )
    api.fetchLetterTemplate = vi.fn(async () => created)
    fireEvent.click(screen.getByRole('button', { name: 'New letter' }))
    fireEvent.change(screen.getByLabelText('Name of the new letter'), { target: { value: '  Engagement 2027 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add letter' }))
    await waitFor(() => expect(api.createLetterRequest).toHaveBeenCalledWith('Engagement 2027'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Engagement 2027' })).toHaveAttribute('aria-pressed', 'true'),
    )
    expect(screen.getByLabelText('Subject')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Send "Engagement 2027" to 0 clients' })).toBeDisabled()
  })

  it('renames the chosen letter and shows the server sentence when the name is taken', async () => {
    api.renameLetterRequest = vi.fn(async () => {
      throw new ApiError(409, 'There is already a letter named "Engagement 2027".', 'letter_name_taken')
    })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByLabelText('New name')
    expect(input).toHaveValue('1099 Filing')
    fireEvent.change(input, { target: { value: 'Engagement 2027' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('There is already a letter named "Engagement 2027".')).toBeInTheDocument()
    expect(api.renameLetterRequest).toHaveBeenCalledWith('default', 'Engagement 2027')

    api.renameLetterRequest = vi.fn(async () => templateState({ name: '1099 letter' }))
    api.listLettersRequest = vi.fn(async () => listState([{ ...LETTER_1099, name: '1099 letter' }]))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: '1099 letter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByRole('button', { name: '1099 letter' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByLabelText('New name')).not.toBeInTheDocument()
  })

  it('will not delete a letter that has been sent, and says why', async () => {
    api.listLettersRequest = vi.fn(async () => listState([{ ...LETTER_1099, sendCount: 3 }]))
    await renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled())
    expect(
      screen.getByText(
        '"1099 Filing" has been sent, so it cannot be deleted - its send history points at it. Rename it instead if it is no longer used.',
      ),
    ).toBeInTheDocument()
  })

  it('deletes a letter never sent after a confirm, and opens the one left', async () => {
    twoLetters()
    const confirm = mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Engagement 2027' }))
    await screen.findByDisplayValue('Engagement for {{next_year}}')
    api.listLettersRequest = vi.fn(async () => listState([LETTER_1099]))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalledWith('Delete the letter "Engagement 2027"? This cannot be undone.')
    await waitFor(() => expect(api.deleteLetterRequest).toHaveBeenCalledWith('letter-2'))
    await screen.findByDisplayValue('Your {{next_year}} 1099s')
    expect(screen.queryByRole('button', { name: 'Engagement 2027' })).not.toBeInTheDocument()
  })

  it('says so when there are no letters yet', async () => {
    api.listLettersRequest = vi.fn(async () => listState([]))
    render(<LettersPage />)
    expect(await screen.findByText('No letters yet. Add one with New letter.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument()
    expect(api.fetchLetterTemplate).not.toHaveBeenCalled()
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

  // Send never mails an app user's address, so the list must not show one as if it would.
  it('shows only the addresses Send will use, and says how many team addresses are hidden', async () => {
    api.fetchLetterTemplate = vi.fn(async () => templateState({}, 'hash-1', ['alex@ka-performancefl.com']))
    setClients([
      { id: 'c-mix', name: 'Mixed Co', contact: '', email: 'pat@mix.test', contactIds: ['ct-a'], lifecycleStage: 'active' },
      { id: 'c-only', name: 'Only Team Co', contact: '', email: 'Alex Anderson <Alex@KA-Performancefl.com>', contactIds: [], lifecycleStage: 'active' },
      { id: 'c-reply', name: 'Reply Co', contact: '', email: 'brittany@pbjsa.com', contactIds: [], lifecycleStage: 'active' },
    ])
    contextValue = {
      ...contextValue,
      data: { ...contextValue.data, contacts: [{ id: 'ct-a', name: 'Al', email: 'pat2@mix.test, Alex@ka-performancefl.com' }] },
    } as unknown as AppContextValue
    await renderPage()
    const mixed = screen.getByText('Mixed Co').closest('tr') as HTMLElement
    expect(within(mixed).getByText('pat@mix.test')).toBeInTheDocument()
    expect(within(mixed).queryByText(/alex@/i)).not.toBeInTheDocument()
    expect(within(mixed).getByText('1 team address hidden')).toBeInTheDocument()
    expect(within(mixed).getByLabelText('Select Mixed Co')).toBeEnabled()

    const only = screen.getByText('Only Team Co').closest('tr') as HTMLElement
    expect(within(only).getByText('Only a team address on file')).toBeInTheDocument()
    expect(within(only).getByText('1 team address hidden')).toBeInTheDocument()
    expect(within(only).getByLabelText('Select Only Team Co')).toBeDisabled()

    // The reply-to mailbox is the one user address that may stay.
    const reply = screen.getByText('Reply Co').closest('tr') as HTMLElement
    expect(within(reply).getByText('brittany@pbjsa.com')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Send "1099 Filing" to 3 clients' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send "1099 Filing" to 0 clients' })).toBeDisabled()
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
    api.sendLettersRequest = vi.fn(async (_id: string, input: { clientIds: string[]; resendToday?: boolean }) => ({
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
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' }))
    expect(await screen.findByText(/started at Oct 8, 2:05 PM and never finished/)).toBeInTheDocument()
    expect(screen.queryByText(/Already sent today/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send again anyway' }))
    expect(confirm).toHaveBeenLastCalledWith(
      'Send "1099 Filing" to Acme Books again? An earlier send to them never finished, so check that it did not go out first.',
    )
    await waitFor(() =>
      expect(api.sendLettersRequest).toHaveBeenLastCalledWith('default', { clientIds: ['c-acme'], templateHash: 'hash-1', resendToday: true }),
    )
  })
})

describe('sending', () => {
  const ids = (call: unknown[]) => (call[1] as { clientIds: string[] }).clientIds

  it('confirms with the count and the reply address, and sends nothing if she cancels', async () => {
    const confirm = mockConfirm(false)
    await renderPage()
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' }))
    expect(confirm).toHaveBeenCalledWith(
      'Send "1099 Filing" to 1 client? Each gets your email with the letter attached as a PDF. Replies go to brittany@pbjsa.com.',
    )
    expect(api.sendLettersRequest).not.toHaveBeenCalled()
  })

  it('sends the page\'s template hash and shows a result per client', async () => {
    mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 3 clients' }))
    await screen.findByText('3 sent, 0 skipped, 0 failed.')
    expect(api.sendLettersRequest).toHaveBeenCalledTimes(1)
    expect(api.sendLettersRequest).toHaveBeenCalledWith('default', {
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
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 12 clients' }))
    await screen.findByText('12 sent, 0 skipped, 0 failed.')
    const calls = (api.sendLettersRequest as Mock).mock.calls
    expect(calls.map(ids).map((chunk) => chunk.length)).toEqual([10, 2])
  })

  it('offers "Send again anyway" for an already-sent client and then claims a second send', async () => {
    api.sendLettersRequest = vi.fn(async (_id: string, input: { clientIds: string[]; resendToday?: boolean }) => ({
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
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' }))
    await screen.findByText(/Already sent today\./)
    fireEvent.click(screen.getByRole('button', { name: 'Send again anyway' }))
    expect(confirm).toHaveBeenLastCalledWith('Send "1099 Filing" to Acme Books again? It was already sent today.')
    await waitFor(() =>
      expect(api.sendLettersRequest).toHaveBeenLastCalledWith('default', {
        clientIds: ['c-acme'],
        templateHash: 'hash-1',
        resendToday: true,
      }),
    )
    await screen.findByText(/Sent to pat@acme.test/)
  })

  // A resend uses the SAVED letter, so unsaved text in the boxes must not look like what goes out.
  it('turns "Send again anyway" off while the editor holds unsaved text', async () => {
    api.sendLettersRequest = vi.fn(async () => ({
      results: [
        {
          clientId: 'c-acme',
          clientName: 'Acme Books',
          status: 'skipped' as const,
          code: 'already_sent' as const,
          message: 'Acme Books was already sent this letter today. Use Send again to send it a second time.',
        },
        {
          clientId: 'c-sub',
          clientName: 'KLC North',
          status: 'skipped' as const,
          code: 'unfinished' as const,
          message: 'A send to KLC North started at Oct 8, 2:05 PM and never finished - check with them, then use Send again anyway.',
        },
      ],
      sent: 0,
      failed: 0,
      skipped: 2,
    }))
    mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByLabelText('Select KLC North'))
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 2 clients' }))
    await screen.findByText(/Already sent today\./)
    const again = () => screen.getAllByRole('button', { name: 'Send again anyway' })
    expect(again()).toHaveLength(2)
    for (const button of again()) expect(button).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Letter body'), { target: { value: 'changed' } })
    for (const button of again()) expect(button).toBeDisabled()
  })

  it('shows the server\'s sentence for a failure and offers to send again to the ones that failed', async () => {
    let first = true
    api.sendLettersRequest = vi.fn(async (_id: string, input: { clientIds: string[] }) => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 3 clients' }))
    await screen.findByText(/Failed: Email provider refused the message \(422\)\./)
    fireEvent.click(screen.getByRole('button', { name: 'Send again to the 1 that failed' }))
    await waitFor(() => expect(api.sendLettersRequest).toHaveBeenCalledTimes(2))
    expect((api.sendLettersRequest as Mock).mock.calls[1][1]).toEqual({
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
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' }))
    expect(
      await screen.findByText('The letter changed since this page loaded. Nothing was sent. Reload and send again.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Someone else saved this'))
    expect(api.sendLettersRequest).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh results list for a new Send', async () => {
    mockConfirm(true)
    await renderPage()
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' }))
    await screen.findByText('1 sent, 0 skipped, 0 failed.')
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByLabelText('Select KLC North'))
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' }))
    await screen.findByText(/Sent to c-sub@x.test/)
    expect(screen.queryByText(/Sent to c-acme@x.test/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem').filter((item) => item.textContent?.includes('Sent to'))).toHaveLength(1)
  })

  it('refreshes the log after a send so Last sent follows', async () => {
    mockConfirm(true)
    await renderPage()
    api.listLetterSendsRequest = vi.fn(async () => [sendRecord({})])
    fireEvent.click(screen.getByLabelText('Select Acme Books'))
    fireEvent.click(screen.getByRole('button', { name: 'Send "1099 Filing" to 1 client' }))
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
      retired: [],
      flags: { neverEmailed: false, billedOutside: false, inactive: false, billingMasterSub: null },
      refusal: null,
    }
    api.previewLetterRequest = vi.fn(async () => preview)
    await renderPage()
    const row = screen.getByText('Acme Books').closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('dialog', { name: 'Preview of the letter for Acme Books' })).toBeInTheDocument()
    expect(api.previewLetterRequest).toHaveBeenCalledWith('default', 'c-acme')
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
    retired: [],
    flags: { neverEmailed: false, billedOutside: false, inactive: false, billingMasterSub: null },
    refusal: null,
  }

  it('renders the email in a sandboxed frame with links retargeted, and the PDF in its own tab', async () => {
    api.previewLetterRequest = vi.fn(async () => base)
    render(<LetterPreviewModal letterId="default" clientId="c-acme" clientName="Acme Books" onClose={() => {}} />)
    expect(await screen.findByText('What Acme Books receives')).toBeInTheDocument()
    expect(screen.getByText('Built by the same code as Send. Nothing is sent or saved from here.')).toBeInTheDocument()
    expect(screen.getByText('To: pat@acme.test, lee@acme.test')).toBeInTheDocument()
    expect(screen.getByText('Your 2027 1099s')).toBeInTheDocument()
    const frame = screen.getByTitle('Email preview')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toBe(PREVIEW_FRAME_PREFIX + base.html)
    expect(frame.getAttribute('srcdoc')?.startsWith('<base target="_blank">')).toBe(true)

    fireEvent.click(screen.getByRole('tab', { name: 'PDF attachment' }))
    expect(screen.getByTitle('PDF preview').getAttribute('src')).toBe('/api/letters/default/preview.pdf?clientId=c-acme')
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
    render(<LetterPreviewModal letterId="default" clientId="c-acme" clientName="Acme Books" onClose={() => {}} />)
    expect(await screen.findByText(/No email address on file for this client/)).toBeInTheDocument()
    expect(screen.getByText('Missing for this client: {{fee}}. Send skips this client.')).toBeInTheDocument()
    expect(screen.getByText(/is billed hourly, so there is no single fee to fill in - take \{\{fee\}\} out of the letter/)).toBeInTheDocument()
    expect(screen.getByText('The PDF could not be built, so Send would skip this client.')).toBeInTheDocument()
    expect(screen.getByText(/never have invoices emailed\. A letter is not an invoice/)).toBeInTheDocument()
    expect(screen.getByText('This client is billed through KLC Holdings.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'PDF attachment' }))
    expect(screen.getByText('There is no PDF to show.')).toBeInTheDocument()
  })

  it('lists a retired placeholder in the notes, with why and that Send refuses', async () => {
    api.previewLetterRequest = vi.fn(async () => ({ ...base, retired: ['hourly_rate'] }))
    render(<LetterPreviewModal letterId="default" clientId="c-acme" clientName="Acme Books" onClose={() => {}} />)
    expect(
      await screen.findByText(
        '{{hourly_rate}} is no longer filled in - hourly clients have no single rate; take it out. Send refuses until it is taken out.',
      ),
    ).toBeInTheDocument()
  })

  it('shows the error when the preview cannot be built, and closes on Escape and on Close', async () => {
    api.previewLetterRequest = vi.fn(async () => {
      throw new ApiError(404, 'Client not found')
    })
    const onClose = vi.fn()
    render(<LetterPreviewModal letterId="default" clientId="gone" clientName="Gone Co" onClose={onClose} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Client not found')
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
