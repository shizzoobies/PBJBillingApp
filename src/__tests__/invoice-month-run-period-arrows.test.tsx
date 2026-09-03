import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { shiftReviewPeriod } from '../lib/utils'
import type { Client } from '../lib/types'

/**
 * Month navigation arrows on the invoice run (featreq-1947e574): a back and a
 * forward arrow flanking the month picker, one month per press, list reloading
 * to match. Both go through the same guarded changePeriod the picker uses, so
 * stepping months with unsaved edits open asks before discarding — that guard
 * is exercised by the dirty-guard suite; here we pin the stepping itself.
 *
 * NOTE the clock: the run opens on the REAL current month (no fake timers
 * here), so expectations are computed with shiftReviewPeriod rather than
 * hard-coded months — a test that assumed which month "today" is would fail at
 * every month turn (see HANDOFF §5's Aug 31 trap).
 */

vi.mock('../lib/api', () => ({
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoicesRequest: vi.fn(),
  listUnappliedRetainersRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

import { listInvoicesRequest, listUnappliedRetainersRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)
const mockRetainers = vi.mocked(listUnappliedRetainersRequest)

const clients = [] as unknown as Client[]

/** What the run itself considers "this month" — mirrors its currentPeriod(). */
function thisMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([])
  mockRetainers.mockReset()
  mockRetainers.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the month arrows', () => {
  it('step back one month and reload the list for it', async () => {
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(thisMonth()))

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    const previous = shiftReviewPeriod('month', thisMonth(), -1)
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(previous))
    expect(screen.getByLabelText('Billing month')).toHaveValue(previous)
  })

  it('step forward one month and reload the list for it', async () => {
    render(<InvoiceMonthRun clients={clients} onPrint={vi.fn()} />)
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(thisMonth()))

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    const next = shiftReviewPeriod('month', thisMonth(), 1)
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(next))
    expect(screen.getByLabelText('Billing month')).toHaveValue(next)
  })

  it('cross a year boundary correctly, one press at a time', () => {
    // The stepping math itself, at the seam the arrows lean on.
    expect(shiftReviewPeriod('month', '2026-01', -1)).toBe('2025-12')
    expect(shiftReviewPeriod('month', '2025-12', 1)).toBe('2026-01')
  })
})
