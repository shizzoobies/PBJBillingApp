import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientSignedDocuments } from '../components/ClientSignedDocuments'
import { ApiError, type ClientSignedDocument } from '../lib/types'

/**
 * Signed documents on a client's page (featreq-d4548b2c). Brittany: "Each
 * client's folder should have a Documents area that lists all documents that
 * client has signed, including engagement letters ... Only signed, saved PDFs
 * should appear here ... Brittany can open a listed PDF from the client's
 * folder."
 */

vi.mock('../lib/api', () => ({
  listClientSignedDocuments: vi.fn(),
  engagementEsignPdfUrl: (id: string, requestId: string) => `/api/engagements/${id}/esign/${requestId}/pdf`,
}))

import { listClientSignedDocuments } from '../lib/api'

const mockList = vi.mocked(listClientSignedDocuments)

const doc = (over: Partial<ClientSignedDocument> = {}): ClientSignedDocument => ({
  requestId: 'sigreq-1',
  engagementId: 'eng-1',
  kind: 'original',
  engagementStatus: 'signed',
  subject: 'Bookkeeping services',
  fileName: 'Acme signed letter.pdf',
  byteSize: 20480,
  // Midday, so the day is the same in the firm's zone and in UTC.
  signedAt: '2026-10-22T16:00:00.000Z',
  signers: ['Pat Example'],
  testMode: false,
  ...over,
})

const view = (clientId = 'c-acme', refreshKey = 0) => (
  <MemoryRouter>
    <ClientSignedDocuments clientId={clientId} refreshKey={refreshKey} />
  </MemoryRouter>
)

beforeEach(() => {
  mockList.mockReset()
})
afterEach(cleanup)

describe('ClientSignedDocuments', () => {
  it('lists each signed PDF with what it is, when and by whom, and a link that downloads it', async () => {
    mockList.mockResolvedValue({
      documents: [
        doc({ requestId: 'sigreq-2', engagementId: 'eng-2', kind: 'amendment', subject: 'Payroll added', fileName: 'Amendment.pdf', signedAt: '2026-11-03T16:00:00.000Z' }),
        doc(),
      ],
      signedWithoutPdf: 0,
    })
    render(view())
    expect(screen.getByText('Loading the signed documents…')).toBeInTheDocument()
    const rows = await screen.findAllByRole('row')
    // The heading row, then newest first as the server sent them.
    expect(rows).toHaveLength(3)
    expect(mockList).toHaveBeenCalledWith('c-acme')

    const amendment = within(rows[1])
    expect(amendment.getByText('Amendment.pdf')).toBeInTheDocument()
    expect(amendment.getByText('Amendment letter: Payroll added')).toBeInTheDocument()
    expect(amendment.getByText('Nov 3, 2026')).toBeInTheDocument()
    expect(amendment.getByText('Pat Example')).toBeInTheDocument()
    const download = amendment.getByRole('link', { name: 'Download Amendment.pdf' })
    expect(download).toHaveAttribute('href', '/api/engagements/eng-2/esign/sigreq-2/pdf')
    expect(download).toHaveAttribute('download')
    expect(amendment.getByRole('link', { name: 'Open the letter: Amendment letter: Payroll added' })).toHaveAttribute(
      'href',
      '/engagements/eng-2',
    )

    const original = within(rows[2])
    expect(original.getByText('Acme signed letter.pdf')).toBeInTheDocument()
    expect(original.getByText('Original letter: Bookkeeping services')).toBeInTheDocument()
    expect(original.getByText('Oct 22, 2026')).toBeInTheDocument()
    expect(screen.queryByText(/marked as signed by hand/)).not.toBeInTheDocument()
  })

  it('says so when there is none yet', async () => {
    mockList.mockResolvedValue({ documents: [], signedWithoutPdf: 0 })
    render(view())
    expect(await screen.findByText(/No signed PDFs for this client yet\./)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('a signed letter with no PDF kept is counted under the list, not listed', async () => {
    mockList.mockResolvedValue({ documents: [doc()], signedWithoutPdf: 2 })
    render(view())
    expect(
      await screen.findByText(
        /2 signed letters for this client have no signed PDF here \(they were marked as signed by hand, or their signed PDF could not be kept\)\./,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/Find them on this client's Billing tab, under Engagements\./)).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    cleanup()
    mockList.mockResolvedValue({ documents: [], signedWithoutPdf: 1 })
    render(view())
    expect(
      await screen.findByText(
        /1 signed letter for this client has no signed PDF here \(it was marked as signed by hand, or its signed PDF could not be kept\)\./,
      ),
    ).toBeInTheDocument()
    // Still says there is nothing to download, in words that do not contradict the line under it.
    expect(screen.getByText(/No signed PDFs for this client yet\./)).toBeInTheDocument()
  })

  it('says so when the letter itself is not marked Signed (replaced, voided, or waiting to be finished)', async () => {
    mockList.mockResolvedValue({
      documents: [
        doc({ engagementStatus: 'superseded' }),
        doc({ requestId: 'sigreq-2', engagementId: 'eng-2', fileName: 'Second.pdf', engagementStatus: 'sent' }),
        doc({ requestId: 'sigreq-3', engagementId: 'eng-3', fileName: 'Third.pdf' }),
      ],
      signedWithoutPdf: 0,
    })
    render(view())
    const rows = await screen.findAllByRole('row')
    expect(within(rows[1]).getByText('The letter is Superseded')).toBeInTheDocument()
    expect(within(rows[2]).getByText('The letter is Sent')).toBeInTheDocument()
    expect(within(rows[3]).queryByText(/^The letter is/)).not.toBeInTheDocument()
  })

  it('every line has its PDF: a signer with no name on file shows as a dash', async () => {
    mockList.mockResolvedValue({ documents: [doc({ signers: [], signedAt: null })], signedWithoutPdf: 0 })
    render(view())
    const row = within((await screen.findAllByRole('row'))[1])
    expect(row.getByRole('link', { name: 'Download Acme signed letter.pdf' })).toBeInTheDocument()
    expect(row.getAllByText('-')).toHaveLength(2)
  })

  it('marks a test signing', async () => {
    mockList.mockResolvedValue({ documents: [doc({ testMode: true })], signedWithoutPdf: 0 })
    render(view())
    expect(await screen.findByText('Test signing (not legally binding)')).toBeInTheDocument()
  })

  it('shows the server’s sentence when the list cannot be read', async () => {
    mockList.mockRejectedValue(new ApiError(403, 'Only owners can see signed documents'))
    render(view())
    expect(await screen.findByRole('alert')).toHaveTextContent('Only owners can see signed documents')
    expect(screen.queryByText('Loading the signed documents…')).not.toBeInTheDocument()
  })

  it('reads again when the app says data changed, so a newly signed letter appears by itself', async () => {
    mockList.mockResolvedValueOnce({ documents: [], signedWithoutPdf: 0 })
    const { rerender } = render(view('c-acme', 0))
    await screen.findByText(/No signed PDFs for this client yet\./)
    mockList.mockResolvedValueOnce({ documents: [doc()], signedWithoutPdf: 0 })
    rerender(view('c-acme', 1))
    expect(await screen.findByText('Acme signed letter.pdf')).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it('never shows one client’s documents under another', async () => {
    mockList.mockResolvedValueOnce({ documents: [doc()], signedWithoutPdf: 0 })
    const { rerender } = render(view('c-acme'))
    await screen.findByText('Acme signed letter.pdf')
    let release: (value: { documents: ClientSignedDocument[]; signedWithoutPdf: number }) => void = () => {}
    mockList.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    rerender(view('c-bright'))
    // While the other client's list is being read, the first client's is not on screen.
    expect(screen.queryByText('Acme signed letter.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('Loading the signed documents…')).toBeInTheDocument()
    release({ documents: [doc({ requestId: 'sigreq-9', fileName: 'Bright.pdf' })], signedWithoutPdf: 0 })
    await waitFor(() => expect(screen.getByText('Bright.pdf')).toBeInTheDocument())
    expect(mockList).toHaveBeenLastCalledWith('c-bright')
  })
})
