import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoicesPage } from '../pages/InvoicesPage'
import type { Client, Contact, PersistedInvoice } from '../lib/types'

/**
 * The lower "Email invoice" button, with the one-time extra address (owner's
 * answer 3, featreq-21d0bba8). "Send to other addresses..." sits beside it and
 * opens the same picker even for a client with one address, or none; Email
 * invoice itself is unchanged.
 */

vi.mock('../lib/api', () => ({
  answerInvoiceAiReviewQuestionRequest: vi.fn(),
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
  generateInvoicesRequest: vi.fn(),
  listInvoiceAiReviewsRequest: vi.fn(async () => []),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  rateInvoiceRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

// Not what is under test, and it reaches for its own data.
vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

const client = {
  id: 'client-hourly',
  name: 'Hourly Co',
  contact: '',
  billingMode: 'hourly',
  hourlyRate: 100,
  planIds: [],
  contactIds: ['contact-1'],
  invoiceTimeBreakdownMode: 'day',
  invoiceHideInternalHours: true,
  invoiceGroupByCategory: false,
} as unknown as Client

// The contact list and the clients are the test's to change: one address, or none,
// or a billing master that names the company its invoice goes to.
const state = vi.hoisted(() => ({
  contacts: [] as Contact[],
  clients: [] as Client[],
  selectedClientId: 'client-hourly',
}))

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: state.clients,
      contacts: state.contacts,
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: state.selectedClientId,
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-09',
    printInvoice: vi.fn(),
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

import { listInvoicesRequest, sendInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)

const hana: Contact = { id: 'contact-1', name: 'Hana Hourly', email: 'hana@hourly.test' }

const monthly = {
  id: 'inv-monthly',
  clientId: 'client-hourly',
  period: '2026-09',
  kind: 'monthly',
  number: 'INV-2026-09-001',
  status: 'reviewed',
  lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: 'September', amount: 300 }],
  subtotal: 300,
  total: 300,
  dueDate: '2026-10-31',
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: '2026-10-01T14:00:00.000Z',
  updatedAt: null,
} as unknown as PersistedInvoice

function renderPage() {
  return render(
    <div id="root">
      <InvoicesPage />
    </div>,
  )
}

const pressOthers = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'Send to other addresses...' }))
const typeAndAdd = (dialog: ReturnType<typeof within>, value: string) => {
  fireEvent.change(dialog.getByLabelText('Add another address for this send only'), {
    target: { value },
  })
  fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
}

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
  mockList.mockResolvedValue([monthly])
  state.contacts = [hana]
  state.clients = [client]
  state.selectedClientId = 'client-hourly'
  mockSend.mockResolvedValue({
    invoice: {
      ...monthly,
      status: 'sent',
      emailLog: [
        {
          at: '2026-10-01T14:30:00.000Z',
          to: ['hana@hourly.test', 'ap@other.test'],
          subject: 'Invoice',
          ok: true,
          oneTime: ['ap@other.test'],
        },
      ],
    },
  } as never)
})

describe('Send to other addresses... beside Email invoice', () => {
  it('opens the picker for a client with ONE address, and sends the addition as `extra`', async () => {
    renderPage()

    await pressOthers()
    const dialog = within(await screen.findByRole('dialog'))
    expect(mockSend).not.toHaveBeenCalled()
    expect(dialog.getByRole('checkbox', { name: /hana@hourly.test/ })).toBeChecked()
    typeAndAdd(dialog, 'ap@other.test')
    fireEvent.click(dialog.getByRole('button', { name: /^Send to 2 people/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-monthly', ['hana@hourly.test'], ['ap@other.test'])
    // The note she reads lists every address, and says which was this send only.
    expect(
      await screen.findByText(
        /Sent to 2 recipients .* hana@hourly\.test, ap@other\.test \(this send only\)/,
      ),
    ).toBeInTheDocument()
  })

  it('leaves Email invoice itself exactly as it was: one address goes straight out', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Email invoice' }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-monthly', undefined)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reaches a client with no address on file, where Email invoice only says there is none', async () => {
    state.contacts = []
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Email invoice' }))
    expect(await screen.findByText(/No email address on file/)).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()

    await pressOthers()
    const dialog = within(await screen.findByRole('dialog'))
    typeAndAdd(dialog, 'ap@other.test')
    fireEvent.click(dialog.getByRole('button', { name: /^Send to 1 person/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-monthly', [], ['ap@other.test'])
  })

  it('still stops at a draft: review comes before send, link or not', async () => {
    mockList.mockResolvedValue([{ ...monthly, status: 'draft' } as PersistedInvoice])
    renderPage()

    await pressOthers()

    expect(
      await screen.findByText('Mark this invoice reviewed first, in the month run above.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe("a billing master's invoice, from the lower button", () => {
  const master = {
    ...client,
    id: 'client-master',
    name: 'KLC Holdings',
    isBillingMaster: true,
    invoiceRecipientClientId: 'client-sub-a',
    contactIds: [],
  } as unknown as Client
  const subA = {
    ...client,
    id: 'client-sub-a',
    name: 'KLC Alpha',
    billToClientId: 'client-master',
    contactIds: ['contact-a'],
  } as unknown as Client
  const subB = {
    ...client,
    id: 'client-sub-b',
    name: 'KLC Beta',
    billToClientId: 'client-master',
    contactIds: ['contact-b'],
  } as unknown as Client

  beforeEach(() => {
    state.clients = [master, subA, subB]
    state.selectedClientId = 'client-master'
    state.contacts = [
      { id: 'contact-a', name: 'Alpha Contact', email: 'ap@alpha.test' },
      { id: 'contact-b', name: 'Beta Contact', email: 'ap@beta.test' },
    ]
    mockList.mockResolvedValue([{ ...monthly, clientId: 'client-master' } as PersistedInvoice])
  })

  it("shows the addressed company's addresses in the picker, not the master's empty list", async () => {
    renderPage()

    await pressOthers()
    const dialog = within(await screen.findByRole('dialog'))

    expect(dialog.getByRole('checkbox', { name: /ap@alpha.test/ })).toBeChecked()
    expect(dialog.getAllByRole('checkbox')).toHaveLength(1)
  })

  it('Email invoice sends straight out to the one address the master names', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Email invoice' }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-monthly', undefined)
    expect(screen.queryByText(/No email address on file/)).not.toBeInTheDocument()
  })
})
