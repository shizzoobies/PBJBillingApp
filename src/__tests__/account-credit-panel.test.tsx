import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountCreditPanel } from '../components/AccountCreditPanel'
import { accountCreditSourceText } from '../lib/accountCreditText'
import type { AccountCredit } from '../lib/types'

/**
 * Credit on account, stage 1a (featreq-110efd15): the owner's panel on a
 * client's Billing tab. A balance, a form to record a credit by hand, and the
 * ledger. Reference only: nothing here touches an invoice. A billing sub has no
 * credit of its own - it lives on the master - so the panel there is one line.
 */

const listAccountCreditsRequest = vi.fn()
const addAccountCreditRequest = vi.fn()
const voidAccountCreditRequest = vi.fn()
vi.mock('../lib/api', () => ({
  listAccountCreditsRequest: (...args: unknown[]) => listAccountCreditsRequest(...args),
  addAccountCreditRequest: (...args: unknown[]) => addAccountCreditRequest(...args),
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

function serve(credits: AccountCredit[]) {
  const balance = credits.reduce((sum, row) => (row.voidedAt ? sum : sum + row.remaining), 0)
  listAccountCreditsRequest.mockResolvedValue({ balance, credits })
}

beforeEach(() => {
  listAccountCreditsRequest.mockReset()
  addAccountCreditRequest.mockReset()
  voidAccountCreditRequest.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the words for where a credit came from', () => {
  it('names each source', () => {
    expect(accountCreditSourceText(credit())).toBe('Manual credit')
    expect(accountCreditSourceText(credit({ sourceKind: 'overpayment' }))).toBe('Overpayment')
    expect(accountCreditSourceText(credit({ sourceKind: 'prepayment', forPeriod: '2026-12' }))).toBe(
      'Prepayment for December 2026',
    )
    expect(accountCreditSourceText(credit({ sourceKind: 'prepayment', sourceRef: 'prepay:inv-9:2027-01' }))).toBe(
      'Prepayment for January 2027',
    )
    expect(accountCreditSourceText(credit({ sourceKind: 'prepayment' }))).toBe('Prepayment')
  })
})

describe('<AccountCreditPanel>', () => {
  it('shows the balance big and a ledger row per credit', async () => {
    serve([
      credit({ id: 'a', amount: 250, remaining: 250, note: 'Double payment, check 1042', forPeriod: '2026-11' }),
      credit({
        id: 'b',
        amount: 80.5,
        remaining: 80.5,
        sourceKind: 'overpayment',
        createdAt: '2026-10-06T15:00:00.000Z',
      }),
    ])
    render(<AccountCreditPanel clientId="c1" />)

    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$330.50'))
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Oct 5, 2026')
    expect(rows[0]).toHaveTextContent('$250.00')
    expect(rows[0]).toHaveTextContent('Manual credit')
    expect(rows[0]).toHaveTextContent('November 2026')
    expect(rows[0]).toHaveTextContent('Double payment, check 1042')
    expect(rows[1]).toHaveTextContent('Overpayment')
    expect(rows[1]).toHaveTextContent('$80.50')
    expect(listAccountCreditsRequest).toHaveBeenCalledWith('c1')
  })

  it('says so when there is nothing on account, with a zero balance', async () => {
    serve([])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$0.00'))
    expect(screen.getByText(/nothing on account/i)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says plainly that it is a record for now', async () => {
    serve([])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toBeInTheDocument())
    expect(screen.getByText(/nothing applies it to an invoice yet/i)).toBeInTheDocument()
  })

  it('adds a credit: amount, reason and the month it is meant for', async () => {
    serve([])
    addAccountCreditRequest.mockResolvedValue(credit({ amount: 125.5, remaining: 125.5 }))
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toBeInTheDocument())

    const add = screen.getByRole('button', { name: 'Add credit' })
    expect(add).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Paid November early' } })
    fireEvent.change(screen.getByLabelText(/month it is meant for/i), { target: { value: '2026-11' } })
    expect(add).toBeEnabled()

    // The ledger the server answers after the add.
    serve([credit({ amount: 125.5, remaining: 125.5, note: 'Paid November early', forPeriod: '2026-11' })])
    fireEvent.click(add)

    await waitFor(() =>
      expect(addAccountCreditRequest).toHaveBeenCalledWith('c1', {
        amount: 125.5,
        note: 'Paid November early',
        forPeriod: '2026-11',
      }),
    )
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$125.50'))
    // The form is empty again.
    expect(screen.getByLabelText('Amount')).toHaveValue(null)
    expect(screen.getByLabelText('Reason')).toHaveValue('')
  })

  it('sends no month when none is picked, and keeps the form when the server refuses', async () => {
    serve([])
    addAccountCreditRequest.mockRejectedValue(new Error('Sub Co is billed on a master’s combined invoice.'))
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add credit' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('billed on a master'))
    expect(addAccountCreditRequest).toHaveBeenCalledWith('c1', { amount: 40, note: '', forPeriod: null })
    expect(screen.getByLabelText('Amount')).toHaveValue(40)
  })

  it.each([['0'], ['-5'], ['abc'], ['1000000.01']])('does not let %j be added', async (typed) => {
    serve([])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: typed } })
    expect(screen.getByRole('button', { name: 'Add credit' })).toBeDisabled()
  })

  it('voids after a confirm, and not when the confirm is declined', async () => {
    serve([credit({ id: 'a', amount: 250, remaining: 250 })])
    voidAccountCreditRequest.mockResolvedValue(credit({ id: 'a', voidedAt: '2026-10-08T15:00:00.000Z', remaining: 0 }))
    const confirm = vi.fn<(message?: string) => boolean>(() => false)
    vi.stubGlobal('confirm', confirm)
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$250.00'))

    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toContain('$250.00')
    expect(voidAccountCreditRequest).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    serve([credit({ id: 'a', amount: 250, remaining: 0, voidedAt: '2026-10-08T15:00:00.000Z', voidedBy: 'user-owner' })])
    fireEvent.click(screen.getByRole('button', { name: 'Void' }))
    await waitFor(() => expect(voidAccountCreditRequest).toHaveBeenCalledWith('a'))
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$0.00'))
  })

  it('shows a void credit struck through, with no Void button and nothing remaining', async () => {
    serve([
      credit({ id: 'a', amount: 250, remaining: 0, voidedAt: '2026-10-08T15:00:00.000Z', voidedBy: 'user-owner' }),
      credit({ id: 'b', amount: 40, remaining: 40, createdAt: '2026-10-06T15:00:00.000Z' }),
    ])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$40.00'))
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveClass('is-void')
    expect(rows[0]).toHaveTextContent('Void')
    expect(within(rows[0]).queryByRole('button')).toBeNull()
    expect(rows[1]).not.toHaveClass('is-void')
    expect(within(rows[1]).getByRole('button', { name: 'Void' })).toBeInTheDocument()
  })

  it('says it could not load, rather than showing a balance it does not know', async () => {
    listAccountCreditsRequest.mockRejectedValue(new Error('down'))
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i))
    expect(screen.queryByTestId('account-credit-balance')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add credit' })).toBeNull()
  })

  it('is hidden for a billing sub: one line pointing at the master, and nothing fetched', () => {
    render(<AccountCreditPanel clientId="sub" billedOnMaster masterName="KLC Holdings" />)
    expect(screen.getByTestId('account-credit-sub-note')).toHaveTextContent(
      'This company is billed on KLC Holdings’s combined invoice, so credit on account lives on that master.',
    )
    expect(screen.queryByTestId('account-credit-balance')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add credit' })).toBeNull()
    expect(listAccountCreditsRequest).not.toHaveBeenCalled()
  })

  it('names the master generically when it is not known', () => {
    render(<AccountCreditPanel clientId="sub" billedOnMaster masterName={null} />)
    expect(screen.getByTestId('account-credit-sub-note')).toHaveTextContent(
      'billed on its master’s combined invoice',
    )
  })

  it('a different client is a fresh load, never the last client’s balance', async () => {
    serve([credit({ amount: 250, remaining: 250 })])
    const { rerender } = render(<AccountCreditPanel key="c1" clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$250.00'))
    listAccountCreditsRequest.mockResolvedValue({ balance: 0, credits: [] })
    rerender(<AccountCreditPanel key="c2" clientId="c2" />)
    await waitFor(() => expect(listAccountCreditsRequest).toHaveBeenLastCalledWith('c2'))
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$0.00'))
  })
})

describe('where the panel is mounted', () => {
  const page = readFileSync(path.resolve(__dirname, '../pages/ClientDetailPage.tsx'), 'utf8')

  it('sits on the owner-only Billing tab, after the Retainer invoice card, and is told when the client is a sub', () => {
    const billing = page.indexOf("activeSection === 'billing' && ownerMode")
    const retainer = page.indexOf('<RetainerSectionBody key={client.id} client={client} />')
    const mount = page.indexOf('<AccountCreditPanel')
    const nextTab = page.indexOf("activeSection === 'checklists'")
    expect(billing).toBeGreaterThan(-1)
    expect(retainer).toBeGreaterThan(billing)
    expect(mount).toBeGreaterThan(retainer)
    expect(mount).toBeLessThan(nextTab)
    const props = page.slice(mount, mount + 400)
    expect(props).toContain('billedOnMaster={Boolean(client.billToClientId)}')
    expect(props).toContain('clientId={client.id}')
  })
})
