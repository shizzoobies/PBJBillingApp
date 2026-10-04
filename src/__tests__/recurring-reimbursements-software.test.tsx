import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RecurringReimbursementsCard } from '../components/RecurringReimbursementsCard'
import type { RecurringReimbursement } from '../lib/types'

/**
 * featreq-a69a3cc0 - the Software checkbox on a recurring expense: it moves the
 * line under its own heading on the invoice. Existing lines stay expenses until
 * she ticks it.
 */

const addRecurringReimbursement = vi.fn(async () => undefined)
const updateRecurringReimbursement = vi.fn(async () => undefined)
const deleteRecurringReimbursement = vi.fn(async () => undefined)
let rows: RecurringReimbursement[] = []

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: { recurringReimbursements: rows },
    ownerMode: true,
    addRecurringReimbursement,
    updateRecurringReimbursement,
    deleteRecurringReimbursement,
  }),
}))

const qbo: RecurringReimbursement = {
  id: 'recur-qbo',
  clientId: 'c1',
  description: 'QuickBooks Online',
  amount: 98,
  frequency: 'monthly',
  startDate: '2026-07-01',
}

beforeEach(() => {
  addRecurringReimbursement.mockClear()
  updateRecurringReimbursement.mockClear()
  rows = [qbo]
})

describe('RecurringReimbursementsCard - Software', () => {
  it('moves an existing expense into Software when she ticks the box and saves', async () => {
    render(<RecurringReimbursementsCard clientId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit QuickBooks Online' }))
    const box = screen.getAllByRole('checkbox', { name: /Software/ })[0] as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateRecurringReimbursement).toHaveBeenCalled())
    expect(updateRecurringReimbursement).toHaveBeenCalledWith(
      'recur-qbo',
      expect.objectContaining({ category: 'software' }),
    )
  })

  it('opens ticked for a line that is already Software, and moves it back when unticked', async () => {
    rows = [{ ...qbo, category: 'software' }]
    render(<RecurringReimbursementsCard clientId="c1" />)
    expect(screen.getByText(/· Software/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit QuickBooks Online' }))
    const box = screen.getAllByRole('checkbox', { name: /Software/ })[0] as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateRecurringReimbursement).toHaveBeenCalled())
    expect(updateRecurringReimbursement).toHaveBeenCalledWith(
      'recur-qbo',
      expect.objectContaining({ category: 'expense' }),
    )
  })

  it('a new line is an expense unless the box is ticked', async () => {
    rows = []
    render(<RecurringReimbursementsCard clientId="c1" />)
    fireEvent.change(screen.getByPlaceholderText('e.g. QuickBooks subscription'), {
      target: { value: 'QBO Plus' },
    })
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '98' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Software/ }))
    fireEvent.submit(screen.getByRole('button', { name: 'Add' }).closest('form')!)
    await waitFor(() => expect(addRecurringReimbursement).toHaveBeenCalled())
    expect(addRecurringReimbursement).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'QBO Plus', amount: 98, category: 'software' }),
    )
  })
})
