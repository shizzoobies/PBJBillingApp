import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import type { Client, PersistedInvoice } from '../lib/types'

/**
 * Preview: exactly what the client receives (featreq-459bdfc2 item 3). The
 * editor's Preview button opens a dialog with the email as the client will
 * read it and the PDF that rides along, both fetched from the server, which
 * builds them with the same code as Send.
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  invoicePreviewPdfUrl: (invoiceId: string) => `/api/invoices/${invoiceId}/preview.pdf`,
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  previewInvoiceRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, previewInvoiceRequest, updateInvoiceRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockPreview = vi.mocked(previewInvoiceRequest)
const mockUpdate = vi.mocked(updateInvoiceRequest)

const clients = [
  {
    id: 'client-acme',
    name: 'Acme',
    contact: '',
    billingMode: 'hourly',
    hourlyRate: 0,
    planIds: [],
    contactIds: [],
  },
] as unknown as Client[]

const invoice: PersistedInvoice = {
  id: 'inv-1',
  clientId: 'client-acme',
  period: '2026-08',
  kind: 'monthly',
  number: 'INV-2026-08-001',
  status: 'draft',
  lineItems: [{ kind: 'hourly', label: 'Billable hours - Lisa', detail: '', amount: 200 }],
  subtotal: 200,
  total: 200,
  dueDate: null,
  blurb: '',
  scopeFlags: [],
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  appliedToInvoiceId: null,
  createdAt: null,
  updatedAt: null,
}

const preview = {
  subject: 'Invoice INV-2026-08-001 from PB&J Strategic Accounting',
  html: '<p>Hello Acme, here is your invoice.</p>',
  text: 'Hello Acme, here is your invoice.',
  to: ['books@acme.com', 'owner@acme.com'],
  recipientNote: null,
  pdfAvailable: true,
  pdfFilename: 'INV-2026-08-001.pdf',
  payLink: 'placeholder' as const,
  datesAsIfSentToday: true,
  coverageUnconfirmed: false,
  prepaymentHold: null,
  delivery: 'email' as const,
}

async function openEditor() {
  render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
  fireEvent.click(await screen.findByText('INV-2026-08-001'))
}

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([invoice])
  mockUpdate.mockReset()
  mockUpdate.mockResolvedValue(invoice)
  mockPreview.mockReset()
  mockPreview.mockResolvedValue(preview)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Preview: what the client receives', () => {
  it('opens on a draft and shows the email the server built, with who it goes to', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    const dialog = await screen.findByRole('dialog', { name: /Preview of Invoice INV-2026-08-001/ })
    expect(mockPreview).toHaveBeenCalledWith('inv-1')
    expect(await screen.findByText(preview.subject)).toBeInTheDocument()
    const frame = (await screen.findByTitle('Email preview')) as HTMLIFrameElement
    expect(frame.getAttribute('srcdoc')).toContain('Hello Acme, here is your invoice.')
    // No scripts, and every link aimed at a window the sandbox will not open:
    // a sent invoice's Pay button is its LIVE payment page, which must not be
    // reachable from a preview.
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')?.startsWith('<base target="_blank">')).toBe(true)
    expect(dialog).toHaveTextContent('books@acme.com, owner@acme.com')
    // A draft has no send stamp and no pay token yet: both are said plainly.
    expect(dialog).toHaveTextContent(/as if it were sent today/)
    expect(dialog).toHaveTextContent(/created when you send/)
  })

  it('switches to the PDF the server streams', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByTitle('Email preview')

    fireEvent.click(screen.getByRole('tab', { name: 'PDF attachment' }))

    const frame = (await screen.findByTitle('PDF preview')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('/api/invoices/inv-1/preview.pdf')
  })

  it('waits behind unsaved edits, like Print', async () => {
    await openEditor()
    fireEvent.change(screen.getAllByLabelText('Amount')[0], { target: { value: '250' } })
    const button = screen.getByRole('button', { name: 'Preview' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Save your changes first')
  })

  it('says when Send would refuse for unconfirmed covered dates, and drops the pay-link note once a real link exists', async () => {
    mockPreview.mockResolvedValue({
      ...preview,
      payLink: 'durable',
      datesAsIfSentToday: false,
      coverageUnconfirmed: true,
    })
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: /Preview of/ })
    await waitFor(() => expect(dialog).toHaveTextContent(/until its covered dates are confirmed/))
    expect(dialog).not.toHaveTextContent(/created when you send/)
    expect(dialog).not.toHaveTextContent(/as if it were sent today/)
  })

  it('says Send will ask first, with the server sentence, when the prepayment is unpaid (M-11)', async () => {
    const message =
      'INV-2026-07-001 carries the prepayment for August 2026 and has not been paid yet (it is Sent), so sending this invoice would bill that month again.'
    mockPreview.mockResolvedValue({ ...preview, prepaymentHold: { reason: 'unpaid', message } })
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: /Preview of/ })
    await waitFor(() => expect(dialog).toHaveTextContent(`Send will ask first: ${message}`))
  })

  it('says Send will stop, not ask, for a hold with no override', async () => {
    const message =
      "This month was prepaid on July 2026's invoice and that payment is still clearing. Once it settles, Apply credit on account (or Void & regenerate) and send then."
    mockPreview.mockResolvedValue({ ...preview, prepaymentHold: { reason: 'processing', message } })
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: /Preview of/ })
    await waitFor(() => expect(dialog).toHaveTextContent(`Send will stop here: ${message}`))
    expect(dialog).not.toHaveTextContent('Send will ask first')
  })

  it('says nothing of the kind when there is no hold', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: /Preview of/ })
    await waitFor(() => expect(dialog).toHaveTextContent('books@acme.com'))
    expect(dialog).not.toHaveTextContent('Send will ask first')
    expect(dialog).not.toHaveTextContent('Send will stop here')
  })

  it('says when a client is never emailed, and closes', async () => {
    mockPreview.mockResolvedValue({ ...preview, to: [], delivery: 'never-emailed' })
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: /Preview of/ })
    await waitFor(() => expect(dialog).toHaveTextContent(/never emailed/))

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
