import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { invoiceAddressee } from '../lib/completeness'
import type { Client, Contact, PersistedInvoice } from '../lib/types'

/**
 * WHOSE addresses the picker shows (reviewer follow-up on the one-time extra
 * address). A billing master has no contacts of its own: the server addresses its
 * invoice to the ONE company it names (`invoiceRecipientClientId`), so the month
 * run's recipient list - and the picker built from it - has to show that
 * company's addresses, not the master's empty list. An ordinary client is
 * unaffected.
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

const make = (over: Record<string, unknown>) =>
  ({ contact: '', planIds: [], contactIds: [], ...over }) as unknown as Client

const master = make({
  id: 'client-master',
  name: 'KLC Holdings',
  isBillingMaster: true,
  invoiceRecipientClientId: 'client-sub-a',
})
const subA = make({
  id: 'client-sub-a',
  name: 'KLC Alpha',
  billToClientId: 'client-master',
  contactIds: ['contact-a'],
})
const subB = make({
  id: 'client-sub-b',
  name: 'KLC Beta',
  billToClientId: 'client-master',
  contactIds: ['contact-b'],
})
const ordinary = make({ id: 'client-solo', name: 'Solo LLC', contactIds: ['contact-solo'] })

const contacts: Contact[] = [
  { id: 'contact-a', name: 'Alpha Contact', email: 'ap@alpha.test' },
  { id: 'contact-b', name: 'Beta Contact', email: 'ap@beta.test' },
  { id: 'contact-solo', name: 'Sol O', email: 'sol@solo.test' },
]

const invoice = (clientId: string): PersistedInvoice =>
  ({
    id: 'inv-1',
    clientId,
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
  }) as PersistedInvoice

async function openEditor(clients: Client[], clientId: string) {
  mockList.mockResolvedValue([invoice(clientId)])
  render(<InvoiceMonthRun clients={clients} contacts={contacts} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: /^Reviewed/ }))
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

beforeEach(() => {
  mockList.mockReset()
  mockSend.mockReset()
})

describe('invoiceAddressee', () => {
  const all = [master, subA, subB, ordinary]

  it('is the client itself for an ordinary client', () => {
    expect(invoiceAddressee(ordinary, all)).toBe(ordinary)
  })

  it('is the ONE company a billing master names', () => {
    expect(invoiceAddressee(master, all)).toBe(subA)
  })

  it('is nobody for a master that names nobody, or a company that is no longer its sub', () => {
    expect(invoiceAddressee({ ...master, invoiceRecipientClientId: null } as Client, all)).toBeNull()
    expect(invoiceAddressee({ ...master, invoiceRecipientClientId: 'client-gone' } as Client, all)).toBeNull()
    // Named, but moved to another master since: the server refuses it, so does this.
    expect(
      invoiceAddressee(master, [master, { ...subA, billToClientId: 'client-other' } as Client]),
    ).toBeNull()
  })

  it('is nobody for a client that is not there', () => {
    expect(invoiceAddressee(null, all)).toBeNull()
    expect(invoiceAddressee(undefined, all)).toBeNull()
  })
})

describe('the month run lists the addressed company\'s addresses for a billing master', () => {
  it('names the company\'s address, not the master\'s empty list and not another sub\'s', async () => {
    await openEditor([master, subA, subB], 'client-master')

    // The row and the editor both say who it goes to.
    expect(screen.getAllByText(/1 recipient/).length).toBeGreaterThan(0)
    expect(screen.getByText('Alpha Contact <ap@alpha.test>')).toBeInTheDocument()
    expect(screen.queryByText(/beta\.test/)).not.toBeInTheDocument()
    expect(screen.queryByText('No email on file')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeEnabled()
  })

  it('the picker opened from "Send to other addresses..." shows that company\'s addresses', async () => {
    await openEditor([master, subA, subB], 'client-master')

    fireEvent.click(screen.getByRole('button', { name: 'Send to other addresses...' }))
    const dialog = within(await screen.findByRole('dialog'))

    expect(dialog.getByRole('checkbox', { name: /ap@alpha\.test/ })).toBeChecked()
    expect(dialog.getAllByRole('checkbox')).toHaveLength(1)
  })

  it('says there is nobody to send to when the master names no company', async () => {
    await openEditor([{ ...master, invoiceRecipientClientId: null } as Client, subA, subB], 'client-master')

    expect(screen.getAllByText('No email on file').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeDisabled()
  })

  it('leaves an ordinary client with its own addresses, as before', async () => {
    await openEditor([master, subA, subB, ordinary], 'client-solo')

    expect(screen.getByText('Sol O <sol@solo.test>')).toBeInTheDocument()
    expect(screen.queryByText(/alpha\.test/)).not.toBeInTheDocument()
  })
})
