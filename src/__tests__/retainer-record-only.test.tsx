import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetainerSectionBody } from '../pages/ClientDetailPage'
import type { Client } from '../lib/types'

/**
 * RECORD-ONLY retainers on the Client page (featreq-9d3721d4).
 *
 * A retainer whose invoice was already sent and paid OUTSIDE the app must be
 * savable without the app issuing another one. Pinned here: ticking the box
 * changes what the confirm says (so nobody believes an email is about to go
 * out), changes the button, sends `recordOnly: true`, and leaves the default
 * path exactly as it was - no such key at all.
 */

vi.mock('../lib/api', () => ({
  issueRetainerInvoiceRequest: (...args: unknown[]) => issueRetainerInvoiceRequest(...args),
  // ClientDetailPage imports these from the same module; the component under
  // test never reaches them.
  applyPackageRequest: vi.fn(),
  listPackagesRequest: vi.fn(async () => []),
  recordClientProfileActivity: vi.fn(),
  setClientAssignedTeamRequest: vi.fn(),
  fetchRateVersions: vi.fn(),
  setClientHourlyRatePeriod: vi.fn(),
}))

let issueRetainerInvoiceRequest = vi.fn()
let confirmMock = vi.fn()

const client = { id: 'c1', name: 'Acme' } as unknown as Client

const RECORD_LABEL = 'Already invoiced and paid outside the app - record it only'

function fillAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } })
}

beforeEach(() => {
  issueRetainerInvoiceRequest = vi.fn(async () => ({ id: 'inv-1', number: 'INV-RET-2026-001' }))
  confirmMock = vi.fn(() => true)
  vi.stubGlobal('confirm', confirmMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RetainerSectionBody record-only option', () => {
  it('issues as before when the box is not ticked: draft wording, no recordOnly key', async () => {
    render(<RetainerSectionBody client={client} />)
    fillAmount('2500')
    fireEvent.click(screen.getByRole('button', { name: 'Issue retainer invoice…' }))

    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('Issue a $2,500.00 retainer invoice for Acme?'),
    )
    await waitFor(() => expect(issueRetainerInvoiceRequest).toHaveBeenCalledTimes(1))
    // No fourth argument at all, so the request body is unchanged.
    expect(issueRetainerInvoiceRequest.mock.calls[0]).toEqual(['c1', 2500, undefined])
    expect(await screen.findByText(/Issued INV-RET-2026-001 as a draft/)).toBeTruthy()
  })

  it('ticking the box changes the confirm and the button, and sends recordOnly: true', async () => {
    render(<RetainerSectionBody client={client} />)
    fillAmount('2500')
    fireEvent.click(screen.getByLabelText(RECORD_LABEL))
    fireEvent.click(screen.getByRole('button', { name: 'Record retainer…' }))

    expect(confirmMock).toHaveBeenCalledWith(
      'Record a $2,500.00 retainer for Acme as already paid? Nothing is emailed. ' +
        'It appears on the Invoices page as a paid retainer and can be credited on a later invoice.',
    )
    await waitFor(() => expect(issueRetainerInvoiceRequest).toHaveBeenCalledTimes(1))
    expect(issueRetainerInvoiceRequest).toHaveBeenCalledWith('c1', 2500, undefined, {
      recordOnly: true,
    })
    expect(await screen.findByText('Recorded INV-RET-2026-001 as paid.')).toBeTruthy()
  })

  it('resets the box after a successful record, so the next one is a normal issue', async () => {
    render(<RetainerSectionBody client={client} />)
    fillAmount('100')
    const box = screen.getByLabelText(RECORD_LABEL) as HTMLInputElement
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Record retainer…' }))
    await screen.findByText('Recorded INV-RET-2026-001 as paid.')
    expect(box.checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Issue retainer invoice…' })).toBeTruthy()
  })

  it('does not call the API when the owner cancels the record confirm', () => {
    confirmMock = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmMock)
    render(<RetainerSectionBody client={client} />)
    fillAmount('2500')
    fireEvent.click(screen.getByLabelText(RECORD_LABEL))
    fireEvent.click(screen.getByRole('button', { name: 'Record retainer…' }))
    expect(issueRetainerInvoiceRequest).not.toHaveBeenCalled()
  })
})
