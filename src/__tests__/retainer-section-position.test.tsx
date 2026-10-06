import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetainerSectionBody } from '../pages/ClientDetailPage'
import { retainerPosition } from '../lib/retainerPosition'
import type { Client } from '../lib/types'
import type { ClientRetainer } from '../lib/api'

/**
 * The Retainer invoice section shows the retainer's POSITION once one exists
 * (featreq-9d3721d4, Brittany's send-back): "once an initial retainer is
 * recorded or sent that the amount shows in this area and then the only thing
 * to do is increase retainer or apply."
 *
 * Pinned here: a recorded / sent / applied retainer shows its amount, applied
 * credit, remaining balance and how it came to be, with exactly two actions;
 * the blank form is not the view then (it opens from Increase retainer only);
 * with no retainer the form is the view, as before; and the position is read
 * from the server, so it is there again after a reload.
 */

vi.mock('../lib/api', () => ({
  issueRetainerInvoiceRequest: (...args: unknown[]) => issueRetainerInvoiceRequest(...args),
  listClientRetainersRequest: (...args: unknown[]) => listClientRetainersRequest(...args),
  // ClientDetailPage imports these from the same module; the component under
  // test never reaches them.
  applyPackageRequest: vi.fn(),
  fetchClientInvoiceCount: vi.fn(),
  listPackagesRequest: vi.fn(async () => []),
  recordClientProfileActivity: vi.fn(),
  setClientAssignedTeamRequest: vi.fn(),
  fetchRateVersions: vi.fn(),
  setClientHourlyRatePeriod: vi.fn(),
}))

let issueRetainerInvoiceRequest = vi.fn()
let listClientRetainersRequest = vi.fn()
let listClientRetainers: ClientRetainer[] = []

const client = { id: 'c1', name: 'Acme' } as unknown as Client

const row = (overrides: Partial<ClientRetainer> = {}): ClientRetainer => ({
  id: 'inv-ret',
  number: 'INV-RET-2026-001',
  status: 'paid',
  period: '2026-06',
  total: 2500,
  sentAt: '2026-06-10T12:00:00.000Z',
  paidAt: '2026-06-10T12:00:00.000Z',
  paymentMethod: 'manual',
  recordedOutsideApp: true,
  appliedToInvoiceId: null,
  credit: null,
  ...overrides,
})

const sent = row({
  id: 'inv-sent',
  number: 'INV-RET-2026-002',
  status: 'sent',
  total: 1000,
  sentAt: '2026-07-01T15:00:00.000Z',
  paidAt: null,
  paymentMethod: null,
  recordedOutsideApp: false,
})

async function renderSection(who: Client = client) {
  render(
    <MemoryRouter>
      <RetainerSectionBody client={who} />
    </MemoryRouter>,
  )
  // The position is read from the server before anything is drawn.
  await waitFor(() => expect(listClientRetainersRequest).toHaveBeenCalledWith('c1'))
}

beforeEach(() => {
  listClientRetainersRequest = vi.fn(async () => [])
  issueRetainerInvoiceRequest = vi.fn(async () => ({ id: 'inv-2', number: 'INV-RET-2026-002' }))
  vi.stubGlobal('confirm', vi.fn(() => true))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('retainerPosition', () => {
  it('sums what is held, what was applied, and what remains to apply', () => {
    const applied = row({
      id: 'inv-a',
      total: 500,
      appliedToInvoiceId: 'inv-final',
      credit: { invoiceId: 'inv-final', number: 'INV-2026-08-001', period: '2026-08', status: 'sent', amount: 300 },
    })
    expect(retainerPosition([row(), applied, sent])).toEqual({
      total: 4000,
      applied: 300,
      remaining: 2500,
      awaiting: 1000,
    })
    expect(retainerPosition([])).toEqual({ total: 0, applied: 0, remaining: 0, awaiting: 0 })
  })
})

describe('RetainerSectionBody with a retainer on file', () => {
  it('shows the recorded amount, the position and the two actions, not the form', async () => {
    listClientRetainersRequest = vi.fn(async () => [row()])
    await renderSection()

    await screen.findByText('Recorded as paid outside the app on June 10, 2026')
    const position = screen.getByRole('group', { name: 'Retainer position' })
    expect(within(position).getByText('Retainer').nextSibling?.textContent).toBe('$2,500.00')
    expect(within(position).getByText('Applied as credit').nextSibling?.textContent).toBe('$0.00')
    expect(within(position).getByText('Remaining balance').nextSibling?.textContent).toBe(
      '$2,500.00',
    )
    expect(screen.getByRole('button', { name: 'Increase retainer' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Apply' })).toBeTruthy()
    // What each retainer still has to give, and that each goes on its own invoice.
    expect(screen.getByText('Remaining $2,500.00, not applied yet')).toBeTruthy()
    expect(screen.getByText(/Each retainer is applied on its own invoice/)).toBeTruthy()

    // The blank form is gone.
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Issue retainer invoice…' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Record retainer…' })).toBeNull()
  })

  it('shows it again after a reload: a fresh mount reads the same position', async () => {
    listClientRetainersRequest = vi.fn(async () => [row()])
    await renderSection()
    await screen.findByText('Recorded as paid outside the app on June 10, 2026')
    // A fresh mount, as a page reload gives.
    cleanup()
    await renderSection()
    expect(await screen.findByText('Recorded as paid outside the app on June 10, 2026')).toBeTruthy()
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
  })

  it('says a sent retainer was sent and is not paid yet, and holds Apply back', async () => {
    listClientRetainersRequest = vi.fn(async () => [sent])
    await renderSection()

    await screen.findByText(/Sent July 1, 2026, not paid yet/)
    const position = screen.getByRole('group', { name: 'Retainer position' })
    expect(within(position).getByText('Retainer').nextSibling?.textContent).toBe('$1,000.00')
    expect(within(position).getByText('Remaining balance').nextSibling?.textContent).toBe('$0.00')
    expect(within(position).getByText('Awaiting payment').nextSibling?.textContent).toBe(
      '$1,000.00',
    )
    // Only a PAID retainer can be credited, so Apply is there but not usable.
    expect(screen.queryByRole('link', { name: 'Apply' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Increase retainer' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
  })

  it('says a draft retainer is not sent yet', async () => {
    listClientRetainersRequest = vi.fn(async () => [
      row({ id: 'inv-d', status: 'draft', sentAt: null, paidAt: null, recordedOutsideApp: false }),
    ])
    await renderSection()
    expect(await screen.findByText(/Draft, not sent yet/)).toBeTruthy()
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
  })

  it('names the invoice an applied retainer was credited on and has nothing left to apply', async () => {
    listClientRetainersRequest = vi.fn(async () => [
      row({
        appliedToInvoiceId: 'inv-final',
        credit: { invoiceId: 'inv-final', number: 'INV-2026-08-001', period: '2026-08', status: 'sent', amount: 2000 },
      }),
    ])
    await renderSection()

    await screen.findByText(/Applied \$2,000\.00 on INV-2026-08-001 \(August 2026\)/)
    const position = screen.getByRole('group', { name: 'Retainer position' })
    expect(within(position).getByText('Applied as credit').nextSibling?.textContent).toBe(
      '$2,000.00',
    )
    expect(within(position).getByText('Remaining balance').nextSibling?.textContent).toBe('$0.00')
    // The part the credit did not use is hers to return, and the page says so.
    expect(screen.getByText(/the other \$500\.00 is yours to return outside the app/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  // The credit is re-sized on each save and a void puts the retainer back, so
  // while the invoice is still a draft it is pending, not final.
  it('calls a credit on a draft or reviewed invoice pending, and does not say the rest is hers to return', async () => {
    listClientRetainers = [
      row({
        appliedToInvoiceId: 'inv-final',
        credit: { invoiceId: 'inv-final', number: 'INV-2026-08-001', period: '2026-08', status: 'draft', amount: 300 },
      }),
    ]
    listClientRetainersRequest = vi.fn(async () => listClientRetainers)
    await renderSection()
    expect(
      await screen.findByText(
        'Credit pending on draft INV-2026-08-001 (August 2026), re-sized if the invoice changes',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/yours to return/i)).toBeNull()
    expect(screen.queryByText(/^Applied \$/)).toBeNull()
  })

  it('hides Apply on a company billed on its master, with the reason', async () => {
    listClientRetainersRequest = vi.fn(async () => [row()])
    await renderSection({ id: 'c1', name: 'Acme', billToClientId: 'master' } as unknown as Client)
    await screen.findByRole('group', { name: 'Retainer position' })
    expect(screen.queryByRole('link', { name: 'Apply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.getByText(/billed on its master's combined invoice/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Increase retainer' })).toBeTruthy()
  })

  it('Apply goes to the Invoices page, where the credit is applied to an invoice', async () => {
    listClientRetainersRequest = vi.fn(async () => [row()])
    await renderSection()
    const link = (await screen.findByRole('link', { name: 'Apply' })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/invoices')
    expect(screen.getByText(/press Apply retainer credit/i)).toBeTruthy()
  })

  it('Increase retainer opens the form, and Cancel puts the position back', async () => {
    listClientRetainersRequest = vi.fn(async () => [row()])
    await renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Increase retainer' }))

    expect(screen.getByPlaceholderText('0.00')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Issue retainer invoice…' })).toBeTruthy()
    // The same record-only choice as the first one.
    expect(
      screen.getByLabelText('Already invoiced and paid outside the app - record it only'),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
    expect(screen.getByRole('button', { name: 'Increase retainer' })).toBeTruthy()
  })

  it('an increase goes through the same request, then the position is read again', async () => {
    let held = [row()]
    listClientRetainersRequest = vi.fn(async () => held)
    await renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Increase retainer' }))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1000' } })
    fireEvent.click(
      screen.getByLabelText('Already invoiced and paid outside the app - record it only'),
    )
    held = [row(), row({ id: 'inv-2', number: 'INV-RET-2026-002', total: 1000 })]
    fireEvent.click(screen.getByRole('button', { name: 'Record retainer…' }))

    await waitFor(() => expect(issueRetainerInvoiceRequest).toHaveBeenCalledTimes(1))
    expect(issueRetainerInvoiceRequest).toHaveBeenCalledWith('c1', 1000, undefined, {
      recordOnly: true,
    })
    expect(await screen.findByText('Recorded INV-RET-2026-002 as paid.')).toBeTruthy()
    // Back on the position, now showing both.
    await waitFor(() => expect(screen.queryByPlaceholderText('0.00')).toBeNull())
    const position = screen.getByRole('group', { name: 'Retainer position' })
    expect(within(position).getByText('Retainer').nextSibling?.textContent).toBe('$3,500.00')
  })
})

describe('RetainerSectionBody with no retainer', () => {
  it('shows the form, as before, and no Increase or Apply', async () => {
    await renderSection()
    expect(await screen.findByPlaceholderText('0.00')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Issue retainer invoice…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Increase retainer' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Retainer position' })).toBeNull()
  })

  it('a first retainer then shows its position instead of a blank form', async () => {
    let held: ClientRetainer[] = []
    listClientRetainersRequest = vi.fn(async () => held)
    await renderSection()
    fireEvent.change(await screen.findByPlaceholderText('0.00'), { target: { value: '2500' } })
    held = [row({ recordedOutsideApp: false, status: 'draft', sentAt: null, paidAt: null })]
    fireEvent.click(screen.getByRole('button', { name: 'Issue retainer invoice…' }))
    expect(await screen.findByText(/Issued INV-RET-2026-002 as a draft/)).toBeTruthy()
    await screen.findByRole('group', { name: 'Retainer position' })
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
  })

  it('a void retainer does not count as one on file', async () => {
    // The server never lists a void one; the section must not need it to.
    listClientRetainersRequest = vi.fn(async () => [])
    await renderSection()
    expect(await screen.findByPlaceholderText('0.00')).toBeTruthy()
  })
})

describe('RetainerSectionBody when the position cannot be read', () => {
  // She cannot see what is on file, so a blank form could record a duplicate.
  it('shows only the alert and Try again, not the form', async () => {
    listClientRetainersRequest = vi.fn(async () => {
      throw new Error('boom')
    })
    await renderSection()
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not load/i)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Issue retainer invoice…' })).toBeNull()
  })

  it('opens the form from Issue anyway only after a confirm that says the retainers could not be checked', async () => {
    listClientRetainersRequest = vi.fn(async () => {
      throw new Error('boom')
    })
    const confirmMock = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmMock)
    await renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Issue anyway' }))
    expect(confirmMock).toHaveBeenCalledWith(expect.stringMatching(/could not be checked/))
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()

    confirmMock.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Issue anyway' }))
    expect(await screen.findByPlaceholderText('0.00')).toBeTruthy()
  })

  it('Try again shows the position when the read then works', async () => {
    listClientRetainersRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([row()])
    await renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('group', { name: 'Retainer position' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
  })
})
