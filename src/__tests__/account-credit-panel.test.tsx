import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountCreditPanel } from '../components/AccountCreditPanel'
import { accountCreditReversalText, accountCreditSourceText } from '../lib/accountCreditText'
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

  it('says where a credit is applied from', async () => {
    serve([])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toBeInTheDocument())
    expect(screen.getByText(/press apply credit on account/i)).toBeInTheDocument()
  })

  it('lists what each credit was drawn on, and what is left', async () => {
    serve([
      credit({
        id: 'credit-drawn',
        amount: 500,
        remaining: 150,
        draws: [
          { invoiceId: 'inv-1', invoiceNumber: 'INV-2026-10-004', period: '2026-10', amount: 200 },
          { invoiceId: 'inv-2', invoiceNumber: null, period: '2026-11', amount: 150 },
        ],
      }),
      credit({ id: 'credit-untouched', amount: 80, remaining: 80 }),
    ])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getByText('$200.00 on INV-2026-10-004 (October 2026)')).toBeInTheDocument()
    expect(screen.getByText('$150.00 on a draft invoice (November 2026)')).toBeInTheDocument()
    const rows = screen.getAllByRole('row')
    // header, then one row per credit: the drawn one shows $150.00 remaining.
    expect(within(rows[1]).getByText('$150.00')).toBeInTheDocument()
    expect(within(rows[2]).getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$230.00')
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

  it('on a retired client the form is off with the server’s sentence, and the ledger still shows', async () => {
    serve([credit({ amount: 90, remaining: 90, note: 'Left on account' })])
    render(<AccountCreditPanel clientId="c1" retired clientName="Old Co" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$90.00'))
    expect(screen.getByTestId('account-credit-retired-note')).toHaveTextContent(
      'Old Co is retired, so credit cannot be added to them. Reactivate them first.',
    )
    expect(screen.getByLabelText('Amount')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } })
    expect(screen.getByRole('button', { name: 'Add credit' })).toBeDisabled()
    expect(screen.getByRole('table')).toHaveTextContent('Left on account')
    // Voiding what is on file stays possible.
    expect(screen.getByRole('button', { name: 'Void' })).toBeEnabled()
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
    expect(props).toContain('retired={isInactiveClient(client)}')
  })
})

/**
 * A refund or a dispute on the payment a credit came from (featreq-cadfcb44): the
 * ledger says so on the credit's row, and an UNSPENT credit's Void is the one
 * click. The webhook only notices; nothing here voids by itself.
 */
describe('a credit whose payment was refunded or disputed in Stripe', () => {
  const refunded = (over: Partial<AccountCredit> = {}) =>
    credit({
      id: 'r',
      amount: 412.5,
      remaining: 412.5,
      sourceKind: 'overpayment',
      sourceRef: 'pi_2',
      note: 'Second payment on INV-2026-09-001',
      reversal: { kind: 'refund', at: '2026-10-08T15:00:00.000Z', amount: 412.5, reason: 'requested_by_customer', holds: true },
      ...over,
    })

  it('says it was refunded, with the date and amount, and offers Void as the one click', async () => {
    serve([refunded()])
    voidAccountCreditRequest.mockResolvedValue(refunded({ voidedAt: '2026-10-08T16:00:00.000Z', remaining: 0 }))
    vi.stubGlobal('confirm', vi.fn(() => true))
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$412.50'))

    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent('Refunded in Stripe on Oct 8, 2026 ($412.50)')
    expect(screen.getByTestId('account-credit-reversal')).not.toHaveTextContent('partly used')
    const button = screen.getByRole('button', { name: 'Void' })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('title', 'Void this credit - its payment was refunded')

    serve([refunded({ voidedAt: '2026-10-08T16:00:00.000Z', remaining: 0 })])
    fireEvent.click(button)
    await waitFor(() => expect(voidAccountCreditRequest).toHaveBeenCalledWith('r'))
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$0.00'))
  })

  it('says it was disputed, with the amount and Stripe\'s reason', async () => {
    serve([
      refunded({
        reversal: { kind: 'dispute', at: '2026-10-09T15:00:00.000Z', amount: 412.5, reason: 'product_not_received', holds: true },
      }),
    ])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())

    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent(
      'Disputed in Stripe on Oct 9, 2026 ($412.50, reason product not received)',
    )
    expect(screen.getByRole('button', { name: 'Void' })).toHaveAttribute(
      'title',
      'Void this credit - its payment was disputed',
    )
  })

  it('a partly used credit says to sort it out by hand, and its Void stays disabled', async () => {
    serve([
      refunded({
        remaining: 312.5,
        draws: [{ invoiceId: 'inv-9', invoiceNumber: 'INV-2026-10-004', period: '2026-10', amount: 100 }],
      }),
    ])
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())

    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent(
      'Refunded in Stripe on Oct 8, 2026 ($412.50) - partly used - sort out by hand',
    )
    const button = screen.getByRole('button', { name: 'Void' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Partly used - sort it out by hand')
    fireEvent.click(button)
    expect(confirm).not.toHaveBeenCalled()
    expect(voidAccountCreditRequest).not.toHaveBeenCalled()
  })

  it('a credit already voided keeps the line, with no Void button and no hand-sorting prompt', async () => {
    serve([
      refunded({
        voidedAt: '2026-10-08T16:00:00.000Z',
        voidedBy: 'user-owner',
        remaining: 0,
        draws: [{ invoiceId: 'inv-9', invoiceNumber: 'INV-2026-10-004', period: '2026-10', amount: 100 }],
      }),
    ])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())
    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent('Refunded in Stripe on Oct 8, 2026 ($412.50)')
    expect(screen.getByTestId('account-credit-reversal')).not.toHaveTextContent('sort out by hand')
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull()
  })

  it('a credit with no notice looks exactly as before: no line, a plain Void', async () => {
    serve([credit({ id: 'a', amount: 250, remaining: 250, sourceKind: 'overpayment' })])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$250.00'))
    expect(screen.queryByTestId('account-credit-reversal')).toBeNull()
    const button = screen.getByRole('button', { name: 'Void' })
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('title')
  })

  it('accountCreditReversalText words a refund, a dispute and a missing amount', () => {
    const base = refunded()
    expect(accountCreditReversalText(base, 'Oct 8, 2026')).toBe('Refunded in Stripe on Oct 8, 2026 ($412.50)')
    expect(
      accountCreditReversalText(refunded({ reversal: { kind: 'refund', at: null, amount: null, reason: '', holds: true } }), 'Oct 8, 2026'),
    ).toBe('Refunded in Stripe on Oct 8, 2026')
    expect(
      accountCreditReversalText(
        refunded({ reversal: { kind: 'dispute', at: null, amount: 100, reason: 'fraudulent', holds: true } }),
        'Oct 9, 2026',
      ),
    ).toBe('Disputed in Stripe on Oct 9, 2026 ($100.00, reason fraudulent)')
    expect(accountCreditReversalText(credit(), 'Oct 8, 2026')).toBe('')
  })
})

/**
 * Fix round 1: a part-refund, a closed dispute, "fully used", and the hold on
 * automatic draw while a notice stands.
 */
describe('a credit with a part-refund, a closed dispute or a hold', () => {
  const noticed = (reversal: Partial<NonNullable<AccountCredit['reversal']>>, over: Partial<AccountCredit> = {}) =>
    credit({
      id: 'n',
      amount: 500,
      remaining: 500,
      sourceKind: 'overpayment',
      sourceRef: 'pi_2',
      reversal: { kind: 'refund', at: '2026-10-08T15:00:00.000Z', amount: 200, reason: '', holds: true, ...reversal },
      ...over,
    })
  const draw = { invoiceId: 'inv-9', invoiceNumber: 'INV-2026-10-004', period: '2026-10', amount: 100 }

  it('a part-refund says "Partly refunded ... ($x of $y)" and its Void does not claim the payment was refunded', async () => {
    serve([noticed({ partial: true, chargeAmount: 500 })])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())

    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent(
      'Partly refunded in Stripe on Oct 8, 2026 ($200.00 of $500.00)',
    )
    const button = screen.getByRole('button', { name: 'Void' })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('title', 'Void this credit - only part of its payment was refunded')
    expect(button.getAttribute('title')).not.toBe('Void this credit - its payment was refunded')
  })

  it('a whole refund keeps today\'s wording', async () => {
    serve([noticed({ amount: 500 })])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())
    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent('Refunded in Stripe on Oct 8, 2026 ($500.00)')
    expect(screen.getByRole('button', { name: 'Void' })).toHaveAttribute('title', 'Void this credit - its payment was refunded')
  })

  it('a noticed credit says it is not applied automatically; a credit with no notice does not', async () => {
    serve([noticed({}), credit({ id: 'b', amount: 40, remaining: 40, createdAt: '2026-10-06T15:00:00.000Z' })])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(screen.getAllByTestId('account-credit-hold')).toHaveLength(1)
    expect(screen.getByTestId('account-credit-hold')).toHaveTextContent('Not applied automatically while this stands.')
  })

  it('a fully used credit says "fully used", and its Void is disabled', async () => {
    serve([noticed({}, { remaining: 0, draws: [{ ...draw, amount: 500 }] })])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())
    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent('- fully used - sort out by hand')
    expect(screen.getByTestId('account-credit-reversal')).not.toHaveTextContent('partly used')
    const button = screen.getByRole('button', { name: 'Void' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Fully used - sort it out by hand')
  })

  it('a lost dispute reads "Dispute closed (lost)", still holds, and Void names the loss', async () => {
    serve([noticed({ kind: 'dispute-closed', status: 'lost', reason: 'fraudulent', amount: 500 })])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())
    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent('Dispute closed (lost) on Oct 8, 2026')
    expect(screen.getByTestId('account-credit-hold')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Void' })).toHaveAttribute('title', 'Void this credit - the dispute was lost')
  })

  it('a won dispute reads "Dispute closed (won)", no longer holds, and Void is a plain Void (even on a used credit)', async () => {
    serve([
      noticed({ kind: 'dispute-closed', status: 'won', holds: false, amount: 500 }, { remaining: 400, draws: [draw] }),
    ])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())
    expect(screen.getByTestId('account-credit-reversal')).toHaveTextContent('Dispute closed (won) on Oct 8, 2026')
    expect(screen.getByTestId('account-credit-reversal')).not.toHaveTextContent('sort out by hand')
    expect(screen.queryByTestId('account-credit-hold')).toBeNull()
    const button = screen.getByRole('button', { name: 'Void' })
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('title')
  })

  it('a voided noticed credit shows no hold note', async () => {
    serve([noticed({}, { voidedAt: '2026-10-09T10:00:00.000Z', voidedBy: 'user-owner', remaining: 0 })])
    render(<AccountCreditPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('account-credit-reversal')).toBeInTheDocument())
    expect(screen.queryByTestId('account-credit-hold')).toBeNull()
  })

  it('accountCreditReversalText words each kind', () => {
    const base = noticed({})
    expect(accountCreditReversalText(noticed({ partial: true, chargeAmount: 500 }), 'Oct 8, 2026')).toBe(
      'Partly refunded in Stripe on Oct 8, 2026 ($200.00 of $500.00)',
    )
    expect(accountCreditReversalText(noticed({ partial: true, chargeAmount: null }), 'Oct 8, 2026')).toBe(
      'Partly refunded in Stripe on Oct 8, 2026 ($200.00)',
    )
    expect(accountCreditReversalText(noticed({ kind: 'dispute-closed', status: 'warning_closed' }), 'Oct 9, 2026')).toBe(
      'Dispute closed (warning closed) on Oct 9, 2026',
    )
    expect(accountCreditReversalText(base, 'Oct 8, 2026')).toBe('Refunded in Stripe on Oct 8, 2026 ($200.00)')
  })
})
