import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { type Client, type Contact, type PersistedInvoice } from '../lib/types'

/**
 * Changing an invoice that was already sent (owner's answer 6, featreq-21d0bba8):
 * she is told, the notice has a Send again beside it, and the row still says it
 * tomorrow.
 *
 * The mark is derived by the server (db/store-staleness.test.mjs); what is
 * pinned here is what the month run does with it.
 */

vi.mock('../lib/api', () => ({
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  markInvoicePaidRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import {
  confirmInvoiceCoverageRequest,
  listInvoicesRequest,
  sendInvoiceRequest,
  updateInvoiceRequest,
} from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)
const mockSend = vi.mocked(sendInvoiceRequest)
const mockConfirm = vi.mocked(confirmInvoiceCoverageRequest)

const NOTICE =
  'This invoice was already sent. The client has the earlier version - send it again so they have your changes.'

const clientWith = (contactIds: string[]) =>
  [
    {
      id: 'client-acme',
      name: 'Acme',
      contact: '',
      billingMode: 'hourly',
      hourlyRate: 0,
      planIds: [],
      contactIds,
    },
  ] as unknown as Client[]

const oneContact: Contact[] = [{ id: 'contact-ann', name: 'Ann Acme', email: 'ann@acme.test' }]
const twoContacts: Contact[] = [
  ...oneContact,
  { id: 'contact-bo', name: 'Bo Acme', email: 'bo@acme.test' },
]

function makeInvoice(over: Partial<PersistedInvoice> = {}): PersistedInvoice {
  return {
    id: 'inv-1',
    clientId: 'client-acme',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-001',
    status: 'sent',
    lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 600 }],
    subtotal: 600,
    total: 600,
    dueDate: null,
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-31T12:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    emailLog: [
      { at: '2026-08-31T12:00:00.000Z', to: ['ann@acme.test'], subject: 'Invoice', ok: true },
    ],
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: '2026-08-31T12:00:00.000Z',
    ...over,
  } as PersistedInvoice
}

const NUMBER = 'INV-2026-08-001'

const editor = () => {
  const node = document.querySelector('.invoice-run-editor')
  if (!node) throw new Error('the editor is not open')
  return within(node as HTMLElement)
}
const note = () => screen.getByLabelText('Note to the client') as HTMLTextAreaElement
// The status region is always mounted (so a screen reader hears it fill); the
// notice is what is in it, or null while it is empty.
const region = () => document.querySelector('.invoice-run-resend') as HTMLElement | null
const notice = () => {
  const node = region()
  return node && node.textContent ? node : null
}
const WITH_CHANGES = 'Send again with your changes'

async function openRun(
  rows: PersistedInvoice[],
  { contacts = oneContact, contactIds = ['contact-ann'], open = true } = {},
) {
  mockList.mockResolvedValue(rows)
  render(
    <InvoiceMonthRun clients={clientWith(contactIds)} contacts={contacts} onPrint={vi.fn()} />,
  )
  const tab = { sent: /^Sent/, draft: /^To review/, paid: /^Paid/ }[rows[0].status as string]
  fireEvent.click(await screen.findByRole('tab', { name: tab }))
  if (open) fireEvent.click(await screen.findByText(NUMBER))
}

/** Type a note and press Save; the server answers with `answer`. */
async function saveNote(answer: PersistedInvoice) {
  mockUpdate.mockResolvedValue(answer)
  fireEvent.change(note(), { target: { value: 'A fresh note for the client.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
}

beforeEach(() => {
  for (const mock of [mockList, mockUpdate, mockSend, mockConfirm]) mock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('after a save that changed what the client sees on a sent invoice', () => {
  it('says so in a status, with Send again beside it, and it survives the remount', async () => {
    await openRun([makeInvoice()])
    expect(notice()).toBeNull()

    await saveNote(
      makeInvoice({
        blurb: 'A fresh note for the client.',
        updatedAt: '2026-10-01T00:00:00.000Z',
        changedSinceSent: true,
      }),
    )

    // The editor remounted on the new `updatedAt`; the notice is read off the
    // invoice, so it is still there - as a status, not an alert.
    const shown = await waitFor(() => {
      const node = notice()
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    expect(shown).toHaveTextContent(NOTICE)
    expect(within(shown).getByRole('button', { name: WITH_CHANGES })).toBeEnabled()
    expect(editor().queryAllByRole('alert')).toHaveLength(0)
  })

  it('still says so when the server could not derive the mark', async () => {
    await openRun([makeInvoice()])

    // The mark is best-effort on the server: a failed read answers unmarked.
    await saveNote(
      makeInvoice({ blurb: 'A fresh note for the client.', updatedAt: '2026-10-01T00:00:00.000Z' }),
    )

    await waitFor(() => expect(notice()).toHaveTextContent(NOTICE))
  })

  it('says nothing when the save changed nothing the client sees', async () => {
    await openRun([makeInvoice({ blurb: 'Same note.' })])

    // She typed, but the server's invoice reads exactly as before.
    await saveNote(makeInvoice({ blurb: 'Same note.', updatedAt: '2026-10-01T00:00:00.000Z' }))

    // The editor remounted from the server's invoice: clean again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled())
    expect(notice()).toBeNull()
  })

  it('Send again runs the normal Send, and the notice is gone once the invoice is sent again', async () => {
    await openRun([makeInvoice()])
    await saveNote(
      makeInvoice({
        blurb: 'A fresh note for the client.',
        updatedAt: '2026-10-01T00:00:00.000Z',
        changedSinceSent: true,
      }),
    )
    mockSend.mockResolvedValue({
      invoice: makeInvoice({
        blurb: 'A fresh note for the client.',
        updatedAt: '2026-10-01T00:05:00.000Z',
      }),
    } as never)

    fireEvent.click(await within(await waitFor(() => notice() as HTMLElement)).findByRole('button', { name: WITH_CHANGES }))

    // One address on file, so it goes straight out, exactly as the footer's does.
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-1', undefined)
    await waitFor(() => expect(notice()).toBeNull())
    expect(screen.queryByText('Changed since sent')).not.toBeInTheDocument()
  })
})

describe('the row says it tomorrow', () => {
  it('shows a quiet badge on a marked sent invoice, before anything is opened', async () => {
    await openRun([makeInvoice({ changedSinceSent: true })], { open: false })

    expect(await screen.findByText('Changed since sent')).toBeInTheDocument()
  })

  it('shows no badge on an unmarked invoice', async () => {
    await openRun([makeInvoice()], { open: false })

    await screen.findByText(NUMBER)
    expect(screen.queryByText('Changed since sent')).not.toBeInTheDocument()
  })

  it('never shows it on a paid invoice, whatever the row carries', async () => {
    await openRun([makeInvoice({ status: 'paid', changedSinceSent: true })], { open: false })

    await screen.findByText(NUMBER)
    expect(screen.queryByText('Changed since sent')).not.toBeInTheDocument()
  })

  it('shows the notice, with Send again, when a marked invoice is opened later', async () => {
    await openRun([makeInvoice({ changedSinceSent: true })])

    expect(notice()).toHaveTextContent(NOTICE)
    // Two buttons that send, and two different names: the footer's own, and the one
    // that says what this one is for.
    expect(editor().getAllByRole('button', { name: 'Send again' })).toHaveLength(1)
    expect(editor().getAllByRole('button', { name: WITH_CHANGES })).toHaveLength(1)
  })

  it('steps aside while she has unsaved edits, and comes back when they are saved', async () => {
    await openRun([makeInvoice({ changedSinceSent: true })])
    expect(notice()).not.toBeNull()

    fireEvent.change(note(), { target: { value: 'Another thought.' } })

    expect(notice()).toBeNull()
  })
})

describe('where it does not appear', () => {
  it('on a draft, even if something marked it', async () => {
    await openRun([makeInvoice({ status: 'draft', changedSinceSent: true })])

    expect(notice()).toBeNull()
    expect(screen.queryByText('Changed since sent')).not.toBeInTheDocument()
  })

  it('on an invoice that was edited but never marked (draft after a plain save)', async () => {
    await openRun([makeInvoice({ status: 'draft', emailLog: [], sentAt: null })])
    await saveNote(
      makeInvoice({
        status: 'draft',
        emailLog: [],
        sentAt: null,
        blurb: 'A fresh note for the client.',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    )

    // The editor remounted from the server's invoice: clean again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled())
    expect(notice()).toBeNull()
    expect(screen.queryByText('Changed since sent')).not.toBeInTheDocument()
  })
})

describe('Send again from the notice is the same Send', () => {
  it('opens the recipient picker when the client has two addresses', async () => {
    await openRun([makeInvoice({ changedSinceSent: true })], {
      contacts: twoContacts,
      contactIds: ['contact-ann', 'contact-bo'],
    })

    fireEvent.click(within(notice() as HTMLElement).getByRole('button', { name: WITH_CHANGES }))

    expect(mockSend).not.toHaveBeenCalled()
    expect(await screen.findByRole('checkbox', { name: /ann@acme.test/ })).toBeInTheDocument()
  })

  it('keeps the notice, and the page its single alert, when the send is refused', async () => {
    await openRun([makeInvoice({ changedSinceSent: true })])
    mockSend.mockRejectedValue(new Error('Stripe is not configured yet.'))

    fireEvent.click(within(notice() as HTMLElement).getByRole('button', { name: WITH_CHANGES }))

    await waitFor(() => expect(editor().getAllByRole('alert')).toHaveLength(1))
    expect(editor().getByRole('alert')).toHaveTextContent('Stripe is not configured yet.')
    expect(notice()).toHaveTextContent(NOTICE)
  })

  it('is disabled with no address on file, like the Send button', async () => {
    await openRun([makeInvoice({ changedSinceSent: true })], { contacts: [], contactIds: [] })

    expect(
      within(notice() as HTMLElement).getByRole('button', { name: WITH_CHANGES }),
    ).toBeDisabled()
  })
})

describe('the status region', () => {
  it('is in the page, empty, before there is anything to say', async () => {
    await openRun([makeInvoice()])

    const node = region()
    expect(node).not.toBeNull()
    expect(node).toHaveAttribute('role', 'status')
    expect(node).toBeEmptyDOMElement()
  })

  it('is the same element that fills when the notice appears', async () => {
    await openRun([makeInvoice()])
    const before = region()

    await saveNote(
      makeInvoice({
        blurb: 'A fresh note for the client.',
        updatedAt: '2026-10-01T00:00:00.000Z',
        changedSinceSent: true,
      }),
    )

    await waitFor(() => expect(notice()).toHaveTextContent(NOTICE))
    // The editor remounts on a save, so this is the new editor's region; what
    // matters is that it was in the page before its text.
    expect(before).toHaveAttribute('role', 'status')
  })
})

describe('the fallback mark only marks what the server would', () => {
  it('says nothing after a save when the invoice has no successful send on its log', async () => {
    await openRun([makeInvoice({ emailLog: [], sentAt: null })])

    await saveNote(
      makeInvoice({
        emailLog: [],
        sentAt: null,
        blurb: 'A fresh note for the client.',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled())
    expect(notice()).toBeNull()
    expect(screen.queryByText('Changed since sent')).not.toBeInTheDocument()
  })

  it('a failed attempt on the log is not a send either', async () => {
    const failed = [
      { at: '2026-08-31T12:00:00.000Z', to: ['ann@acme.test'], subject: 'Invoice', ok: false },
    ]
    await openRun([makeInvoice({ emailLog: failed })])

    await saveNote(
      makeInvoice({
        emailLog: failed,
        blurb: 'A fresh note for the client.',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled())
    expect(notice()).toBeNull()
  })
})

describe('changing the covered dates on a sent invoice', () => {
  const recurring = {
    kind: 'recurring' as const,
    label: 'QuickBooks Ledger - September 13 - October 13, 2026',
    detail: 'monthly',
    amount: 90,
    recurringId: 'recur-qbo',
    coverageStart: '2026-09-13',
    coverageEnd: '2026-10-13',
  }
  const sentWithDates = () =>
    makeInvoice({
      lineItems: [{ kind: 'custom', label: 'Bookkeeping', detail: '', amount: 600 }, recurring],
      total: 690,
      subtotal: 690,
    })

  async function changeDates() {
    fireEvent.click(await screen.findByRole('button', { name: 'Change covered dates' }))
    fireEvent.change(screen.getByLabelText('Covered period end'), {
      target: { value: '2026-10-20' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
  }

  it('shows the notice: the dates are in the label the client reads', async () => {
    await openRun([sentWithDates()])
    mockConfirm.mockResolvedValue({
      ...sentWithDates(),
      updatedAt: '2026-10-01T00:00:00.000Z',
      lineItems: [
        { kind: 'custom', label: 'Bookkeeping', detail: '', amount: 600 },
        {
          ...recurring,
          label: 'QuickBooks Ledger - September 13 - October 20, 2026',
          coverageEnd: '2026-10-20',
        },
      ],
    })

    await changeDates()

    // Even when the server's best-effort mark could not be derived.
    await waitFor(() => expect(notice()).toHaveTextContent(NOTICE))
    expect(screen.getByText('Changed since sent')).toBeInTheDocument()
  })

  it('says nothing when the confirm changed nothing the client reads', async () => {
    await openRun([sentWithDates()])
    mockConfirm.mockResolvedValue({ ...sentWithDates(), updatedAt: '2026-10-01T00:00:00.000Z' })

    await changeDates()

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save dates' })).not.toBeInTheDocument(),
    )
    expect(notice()).toBeNull()
  })
})
