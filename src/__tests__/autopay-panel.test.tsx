import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AutopayPanel } from '../components/AutopayPanel'
import { autopayStatusText } from '../lib/autopayText'
import type { AutopaySummary } from '../lib/types'

const listAutopayRequest = vi.fn()
const inviteToAutopayRequest = vi.fn()
const turnOffAutopayRequest = vi.fn()
vi.mock('../lib/api', () => ({
  listAutopayRequest: () => listAutopayRequest(),
  inviteToAutopayRequest: (...args: unknown[]) => inviteToAutopayRequest(...args),
  turnOffAutopayRequest: (id: string) => turnOffAutopayRequest(id),
}))

const summary = (over: Partial<AutopaySummary> = {}): AutopaySummary => ({
  clientId: 'c1',
  status: 'enrolled',
  methodType: 'us_bank_account',
  last4: '6789',
  bankOrBrand: 'TEST BANK',
  invitedAt: '2026-10-04T15:00:00.000Z',
  consentedAt: '2026-10-05T15:00:00.000Z',
  withdrawnAt: null,
  ...over,
})

describe('the autopay panel’s words', () => {
  it('says not enrolled when there is no row', () => {
    expect(autopayStatusText(null)).toBe('Not enrolled.')
    expect(autopayStatusText(summary({ status: 'off' }))).toBe('Not enrolled.')
  })

  it('says an enrolled bank account with its last four and the date', () => {
    expect(autopayStatusText(summary())).toBe(
      'Enrolled: bank account ending 6789 (TEST BANK), since Oct 5, 2026.',
    )
  })

  it('says a card as a card', () => {
    expect(
      autopayStatusText(summary({ methodType: 'card', last4: '4242', bankOrBrand: 'Visa' })),
    ).toBe('Enrolled: card ending 4242 (Visa), since Oct 5, 2026.')
  })

  it('reads the date on the firm’s day, not the UTC one', () => {
    // 01:00Z on Oct 6 is 9 pm Eastern on Oct 5.
    expect(autopayStatusText(summary({ consentedAt: '2026-10-06T01:00:00.000Z' }))).toContain(
      'since Oct 5, 2026',
    )
  })

  it('says invited, verifying, withdrawn and revoked', () => {
    expect(autopayStatusText(summary({ status: 'invited' }))).toContain('Invited on Oct 4, 2026')
    expect(autopayStatusText(summary({ status: 'pending_verification' }))).toContain('verifying')
    expect(
      autopayStatusText(summary({ status: 'withdrawn', withdrawnAt: '2026-10-09T15:00:00.000Z' })),
    ).toBe('The client turned autopay off on Oct 9, 2026.')
    expect(autopayStatusText(summary({ status: 'revoked' }))).toContain('bank refused')
  })
})

describe('<AutopayPanel>', () => {
  beforeEach(() => {
    listAutopayRequest.mockReset()
    inviteToAutopayRequest.mockReset()
    turnOffAutopayRequest.mockReset()
    vi.restoreAllMocks()
  })

  it('shows this client’s status, not another client’s', async () => {
    listAutopayRequest.mockResolvedValue([
      summary({ clientId: 'other', last4: '1111' }),
      summary({ clientId: 'c1', last4: '6789' }),
    ])
    render(<AutopayPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toBeInTheDocument())
    expect(screen.getByTestId('autopay-status')).toHaveTextContent('ending 6789')
    expect(screen.getByTestId('autopay-status')).not.toHaveTextContent('1111')
  })

  it('says not enrolled for a client with no row', async () => {
    listAutopayRequest.mockResolvedValue([])
    render(<AutopayPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toHaveTextContent('Not enrolled.'))
  })

  it('says nothing at all when the load fails, rather than guessing', async () => {
    listAutopayRequest.mockImplementation(async () => {
      throw new Error('down')
    })
    const { container } = render(<AutopayPanel clientId="c1" />)
    await waitFor(() => expect(listAutopayRequest).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container.querySelector('.autopay-panel')).toBeNull()
  })
})

describe('<AutopayPanel> for a never-email client', () => {
  beforeEach(() => {
    listAutopayRequest.mockReset()
    inviteToAutopayRequest.mockReset()
    turnOffAutopayRequest.mockReset()
  })

  it('stays visible but disables Invite, with the reason', async () => {
    listAutopayRequest.mockResolvedValue([])
    render(<AutopayPanel clientId="c1" neverEmailed />)
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toBeInTheDocument())
    const invite = screen.getByRole('button', { name: 'Invite to autopay' })
    expect(invite).toBeDisabled()
    expect(invite).toHaveAttribute('title', expect.stringContaining('never emailed'))
    expect(screen.getByText(/invoices are never emailed, so automatic payments are not offered/i)).toBeVisible()
    fireEvent.click(invite)
    expect(inviteToAutopayRequest).not.toHaveBeenCalled()
  })

  it('still shows an existing enrollment and lets it be turned off', async () => {
    listAutopayRequest.mockResolvedValue([summary()])
    render(<AutopayPanel clientId="c1" neverEmailed />)
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toHaveTextContent('ending 6789'))
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled()
  })

  it('an ordinary client’s Invite is enabled', async () => {
    listAutopayRequest.mockResolvedValue([])
    render(<AutopayPanel clientId="c1" />)
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Invite to autopay' })).toBeEnabled()
  })
})

describe('<AutopayPanel> actions', () => {
  beforeEach(() => {
    listAutopayRequest.mockReset()
    inviteToAutopayRequest.mockReset()
    turnOffAutopayRequest.mockReset()
  })

  const onFile = [
    { email: 'ann@acme.test', source: 'Ann' },
    { email: 'bo@acme.test', source: 'Bo' },
  ]
  const load = async (rows: AutopaySummary[]) => {
    listAutopayRequest.mockResolvedValue(rows)
    render(<AutopayPanel clientId="c1" clientName="Acme" recipients={onFile} />)
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toBeInTheDocument())
  }
  // featreq-34627da1: Invite opens the shared recipient picker, everyone on file ticked.
  const openPicker = () => {
    fireEvent.click(screen.getByRole('button', { name: /^(Invite to autopay|Send the invitation again)$/ }))
    return within(screen.getByRole('dialog', { name: 'Choose who this goes to' }))
  }

  it('offers Invite to a client who is not enrolled, and shows the new status after it', async () => {
    await load([])
    inviteToAutopayRequest.mockResolvedValue(summary({ status: 'invited' }))
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull()

    const dialog = openPicker()
    expect(inviteToAutopayRequest).not.toHaveBeenCalled()
    expect(dialog.getByRole('checkbox', { name: /ann@acme.test/ })).toBeChecked()
    expect(dialog.getByRole('checkbox', { name: /bo@acme.test/ })).toBeChecked()
    fireEvent.click(dialog.getByRole('button', { name: 'Send to 2 people' }))

    await waitFor(() => expect(screen.getByTestId('autopay-status')).toHaveTextContent('Invited on'))
    expect(inviteToAutopayRequest).toHaveBeenCalledWith('c1', { to: ['ann@acme.test', 'bo@acme.test'] })
    expect(screen.getByRole('button', { name: 'Send the invitation again' })).toBeInTheDocument()
  })

  it('posts what she leaves ticked and an address added for this send', async () => {
    await load([])
    inviteToAutopayRequest.mockResolvedValue(summary({ status: 'invited' }))
    const dialog = openPicker()
    fireEvent.click(dialog.getByRole('checkbox', { name: /ann@acme.test/ }))
    fireEvent.change(dialog.getByLabelText('Add another address for this send only'), { target: { value: 'ap@acme.test' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Send to 2 people' }))
    await waitFor(() =>
      expect(inviteToAutopayRequest).toHaveBeenCalledWith('c1', { to: ['bo@acme.test'], extra: ['ap@acme.test'] }),
    )
  })

  it('needs one address on file: everyone unticked disables Send and says why', async () => {
    await load([])
    const dialog = openPicker()
    for (const box of dialog.getAllByRole('checkbox')) fireEvent.click(box)
    expect(dialog.getByRole('button', { name: 'Send to 0 people' })).toBeDisabled()
    expect(dialog.getByRole('alert')).toHaveTextContent(/Pick at least one address on file/)
    expect(inviteToAutopayRequest).not.toHaveBeenCalled()
  })

  it('an enrolled client can only be turned off, not invited again', async () => {
    await load([summary()])
    expect(screen.queryByRole('button', { name: /invit/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument()
  })

  it('turning off asks first, and does nothing if she says no', async () => {
    await load([summary()])
    window.confirm = vi.fn(() => false)
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(turnOffAutopayRequest).not.toHaveBeenCalled()
    expect(screen.getByTestId('autopay-status')).toHaveTextContent('Enrolled')
  })

  it('turning off, once confirmed, shows the new status', async () => {
    await load([summary()])
    window.confirm = vi.fn(() => true)
    turnOffAutopayRequest.mockResolvedValue(summary({ status: 'off', last4: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toHaveTextContent('Not enrolled.'))
    expect(turnOffAutopayRequest).toHaveBeenCalledWith('c1')
  })

  it('shows the server’s sentence when the invitation is refused', async () => {
    await load([])
    inviteToAutopayRequest.mockRejectedValue(new Error('Acme is invoiced outside the app.'))
    fireEvent.click(openPicker().getByRole('button', { name: 'Send to 2 people' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('invoiced outside the app'))
    expect(screen.getByTestId('autopay-status')).toHaveTextContent('Not enrolled.')
  })
})
