import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, Contact, PersistedInvoice } from '../lib/types'

/**
 * A one-time extra address on a send (owner's answer 3, featreq-21d0bba8): "yes
 * sometimes one client has multiple emails".
 *
 * The picker gains "Add another address for this send only" under its list; a
 * quiet "Send to other addresses..." beside Send opens it even when the client
 * has one address (or none) on file, where Send would go straight out. The
 * ordinary one-click Send is unchanged. The server's half is in
 * lib/invoice-recipient-extra.test.mjs and invoice-send-extra-routes.test.ts.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, sendInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockSend = vi.mocked(sendInvoiceRequest)

const clients = [
  { id: 'client-solo', name: 'Solo LLC', contactIds: ['contact-solo'], planIds: [] },
  { id: 'client-nobody', name: 'Nobody Inc', contactIds: [], planIds: [] },
] as unknown as Client[]

const contacts: Contact[] = [{ id: 'contact-solo', name: 'Sol O', email: 'sol@solo.com' }]

const invoice = (over: Partial<PersistedInvoice> = {}): PersistedInvoice => ({
  id: 'inv-1',
  clientId: 'client-solo',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-2026-08-001',
  status: 'reviewed',
  lineItems: [{ kind: 'hourly', label: 'Billable hours', detail: '', amount: 400 }],
  subtotal: 400,
  total: 400,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: null,
  ...over,
})

async function openEditor(rows: PersistedInvoice[], tab = 'Reviewed') {
  mockList.mockResolvedValue(rows)
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${tab}`) }))
  fireEvent.click(await screen.findByText(rows[0].number as string))
}

const othersLink = () => screen.getByRole('button', { name: 'Send to other addresses...' })
const openPicker = async () => {
  fireEvent.click(othersLink())
  return within(await screen.findByRole('dialog'))
}
const typeAddress = (dialog: ReturnType<typeof within>, value: string) =>
  fireEvent.change(dialog.getByLabelText('Add another address for this send only'), {
    target: { value },
  })
const add = (dialog: ReturnType<typeof within>, value: string) => {
  typeAddress(dialog, value)
  fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
}

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
  mockSend.mockResolvedValue({ invoice: invoice({ status: 'sent' }) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Send to other addresses... opens the picker', () => {
  it('for a client with ONE address, where Send goes straight out', async () => {
    await openEditor([invoice()])

    const dialog = await openPicker()

    expect(mockSend).not.toHaveBeenCalled()
    expect(dialog.getByRole('checkbox', { name: /sol@solo.com/ })).toBeChecked()
    expect(dialog.getByLabelText('Add another address for this send only')).toBeInTheDocument()
  })

  it('leaves the ordinary one-click Send exactly as it was', async () => {
    await openEditor([invoice()])

    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    // Nothing extra on the wire: the request is the one it always was.
    expect(mockSend).toHaveBeenCalledWith('inv-1', undefined)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('for a client with NO address, where Send is dead', async () => {
    await openEditor([invoice({ clientId: 'client-nobody' })])
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeDisabled()

    const dialog = await openPicker()

    expect(dialog.queryAllByRole('checkbox')).toHaveLength(0)
    expect(dialog.getByText(/No address is on file for this client/)).toBeInTheDocument()
    // Nothing to send to until one is added.
    expect(dialog.getByRole('button', { name: /^Send to 0 people/ })).toBeDisabled()
  })

  it('is dead on a draft: review comes before send', async () => {
    await openEditor([invoice({ status: 'draft' })], 'To review')
    expect(othersLink()).toBeDisabled()
  })

  it('is not offered on a voided invoice', async () => {
    mockList.mockResolvedValue([invoice({ status: 'void' })])
    render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Voided/ }))
    fireEvent.click(await screen.findByText('INV-2026-08-001'))

    expect(screen.queryByRole('button', { name: 'Send to other addresses...' })).toBeNull()
  })
})

describe('adding an address for this send only', () => {
  it('lists it ticked, marked "this send only", and sends it as `extra`', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()

    add(dialog, 'ap@other.com')

    const box = dialog.getByRole('checkbox', { name: /ap@other.com/ })
    expect(box).toBeChecked()
    expect(dialog.getByText('this send only')).toBeInTheDocument()
    expect(dialog.getByLabelText('Add another address for this send only')).toHaveValue('')

    fireEvent.click(dialog.getByRole('button', { name: /^Send to 2 people/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-1', ['sol@solo.com'], ['ap@other.com'])
  })

  it('takes the address on Enter as well, trimmed', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()

    typeAddress(dialog, '  ap@other.com ')
    fireEvent.keyDown(dialog.getByLabelText('Add another address for this send only'), {
      key: 'Enter',
    })

    expect(dialog.getByRole('checkbox', { name: /ap@other.com/ })).toBeChecked()
  })

  it('refuses an address already in the list, however it is capitalized', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()

    add(dialog, 'SOL@solo.com')
    expect(dialog.getByRole('alert')).toHaveTextContent('That address is already in the list.')
    expect(dialog.getAllByRole('checkbox')).toHaveLength(1)

    // ...and one already added.
    add(dialog, 'ap@other.com')
    add(dialog, 'AP@Other.com')
    expect(dialog.getByRole('alert')).toHaveTextContent('That address is already in the list.')
    expect(dialog.getAllByRole('checkbox')).toHaveLength(2)
  })

  it('refuses what is not one valid address, and clears the message when she types again', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()

    for (const bad of ['', 'plain', 'a@b', 'two@x.com three@y.com', 'a@b.com, c@d.com']) {
      add(dialog, bad)
      expect(dialog.getByRole('alert')).toHaveTextContent(
        'Type one valid email address, like name@company.com.',
      )
    }
    expect(dialog.getAllByRole('checkbox')).toHaveLength(1)

    typeAddress(dialog, 'ap@oth')
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('allows three and refuses a fourth', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()

    add(dialog, 'a@x.com')
    add(dialog, 'b@x.com')
    add(dialog, 'c@x.com')
    add(dialog, 'd@x.com')

    expect(dialog.getByRole('alert')).toHaveTextContent(
      'You can add up to 3 extra addresses for one send.',
    )
    expect(dialog.queryByRole('checkbox', { name: /d@x.com/ })).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: /^Send to 4 people/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    expect(mockSend).toHaveBeenCalledWith(
      'inv-1',
      ['sol@solo.com'],
      ['a@x.com', 'b@x.com', 'c@x.com'],
    )
  })

  it('removes an added address, and frees its slot', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()
    add(dialog, 'a@x.com')
    add(dialog, 'b@x.com')
    add(dialog, 'c@x.com')

    fireEvent.click(dialog.getByRole('button', { name: 'Remove b@x.com' }))

    expect(dialog.queryByRole('checkbox', { name: /b@x.com/ })).toBeNull()
    add(dialog, 'd@x.com')
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: /^Send to 4 people/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    expect(mockSend).toHaveBeenCalledWith(
      'inv-1',
      ['sol@solo.com'],
      ['a@x.com', 'c@x.com', 'd@x.com'],
    )
  })

  it('an unticked extra is left off, like any other address', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()
    add(dialog, 'a@x.com')
    add(dialog, 'b@x.com')

    fireEvent.click(dialog.getByRole('checkbox', { name: /a@x.com/ }))
    fireEvent.click(dialog.getByRole('button', { name: /^Send to 2 people/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    expect(mockSend).toHaveBeenCalledWith('inv-1', ['sol@solo.com'], ['b@x.com'])
  })

  it('will not send with every on-file address unticked: the client has to be on it', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()
    add(dialog, 'ap@other.com')

    fireEvent.click(dialog.getByRole('checkbox', { name: /sol@solo.com/ }))

    expect(dialog.getByRole('button', { name: /^Send to 1 person/ })).toBeDisabled()
    expect(dialog.getByText(/Pick at least one address/)).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a client with no address on file can be sent to the extras alone', async () => {
    await openEditor([invoice({ clientId: 'client-nobody' })])
    const dialog = await openPicker()

    add(dialog, 'ap@other.com')
    fireEvent.click(dialog.getByRole('button', { name: /^Send to 1 person/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-1', [], ['ap@other.com'])
  })

  it('sends no `extra` at all when none were added', async () => {
    await openEditor([invoice()])
    const dialog = await openPicker()

    fireEvent.click(dialog.getByRole('button', { name: /^Send to 1 person/ }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('inv-1', ['sol@solo.com'])
  })
})

describe('the receipt names the one-time addresses', () => {
  it('marks them in the list of who a past send reached', async () => {
    await openEditor(
      [
        invoice({
          status: 'sent',
          emailLog: [
            {
              at: '2026-08-13T15:00:00.000Z',
              to: ['sol@solo.com', 'ap@other.com'],
              subject: 'Invoice INV-2026-08-001',
              ok: true,
              oneTime: ['ap@other.com'],
            },
          ],
        }),
      ],
      'Sent',
    )

    fireEvent.click(screen.getByText(/^Sent .* to 2 recipients/))

    expect(screen.getByText('sol@solo.com')).toBeInTheDocument()
    expect(screen.getByText('ap@other.com (this send only)')).toBeInTheDocument()
  })
})
