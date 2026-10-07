import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountCreditPanel } from '../components/AccountCreditPanel'
import { accountCreditSourceText } from '../lib/accountCreditText'
import type { AccountCredit } from '../lib/types'

/**
 * Billing period (stage 2, commit B): the panel shows the credit a PAID prepayment
 * invoice yields. It is derived from the invoice, never stored, so it reads "Prepayment
 * on INV-..." as its source and has no Void button (void the invoice instead).
 */

const listAccountCreditsRequest = vi.fn()
const voidAccountCreditRequest = vi.fn()
vi.mock('../lib/api', () => ({
  listAccountCreditsRequest: (...args: unknown[]) => listAccountCreditsRequest(...args),
  addAccountCreditRequest: vi.fn(),
  voidAccountCreditRequest: (...args: unknown[]) => voidAccountCreditRequest(...args),
}))

const credit = (over: Partial<AccountCredit> = {}): AccountCredit => ({
  id: 'credit-1',
  clientId: 'c1',
  amount: 250,
  sourceKind: 'manual',
  sourceRef: 'ref-1',
  forPeriod: null,
  note: '',
  createdBy: 'user-owner',
  createdAt: '2026-10-05T15:00:00.000Z',
  voidedAt: null,
  voidedBy: null,
  draws: [],
  remaining: 250,
  ...over,
})

const prepayment = (over: Partial<AccountCredit> = {}): AccountCredit =>
  credit({
    id: 'prepay:inv-oct:2026-11',
    amount: 500,
    remaining: 500,
    sourceKind: 'prepayment',
    sourceRef: 'inv-oct',
    forPeriod: '2026-11',
    note: 'Prepayment on INV-2026-10-001',
    createdBy: null,
    createdAt: '2026-10-20T15:00:00.000Z',
    derived: true,
    ...over,
  })

beforeEach(() => {
  listAccountCreditsRequest.mockReset()
  voidAccountCreditRequest.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a prepayment credit on the ledger', () => {
  it('names its source as the invoice that was paid', () => {
    expect(accountCreditSourceText(prepayment())).toBe('Prepayment on INV-2026-10-001')
  })

  it('shows the derived credit with its month and what it was used on, and no Void button', async () => {
    listAccountCreditsRequest.mockResolvedValue({
      balance: 750,
      credits: [
        credit({ id: 'manual', amount: 250, remaining: 250 }),
        prepayment({
          remaining: 0,
          draws: [{ invoiceId: 'inv-nov', invoiceNumber: 'INV-2026-11-001', period: '2026-11', amount: 500 }],
        }),
        prepayment({ id: 'prepay:inv-oct:2026-12', forPeriod: '2026-12' }),
      ],
    })
    render(<AccountCreditPanel clientId="c1" />)

    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$750.00'))
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)

    // The manual credit keeps its Void button.
    expect(within(rows[0]).getByRole('button', { name: 'Void' })).toBeInTheDocument()

    for (const row of [rows[1], rows[2]]) {
      expect(row).toHaveTextContent('Prepayment on INV-2026-10-001')
      expect(row).toHaveTextContent('$500.00')
      expect(within(row).queryByRole('button', { name: 'Void' })).toBeNull()
      expect(row).toHaveTextContent('From a paid invoice')
    }
    expect(rows[1]).toHaveTextContent('November 2026')
    expect(rows[1]).toHaveTextContent('$500.00 on INV-2026-11-001 (November 2026)')
    expect(rows[2]).toHaveTextContent('December 2026')
    expect(voidAccountCreditRequest).not.toHaveBeenCalled()
  })
})
