import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BillingPeriodSectionBody } from '../pages/ClientDetailPage'
import type { Client } from '../lib/types'

/**
 * Billing period (stage 2): the "Billing period" card on the client's Billing tab.
 * "Bill every [N] month(s)", "starting [month]", and a sentence that works out the
 * next prepayment month. Saved through the page's `onCommit` (updateClient) like any
 * other client field. N is a whole number 1..24; the first month is required when N
 * is above 1. Subscription clients only: hourly and the old annual mode show no card.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => ({ dataSyncState: 'idle' }) }))

const client = (over: Partial<Client> = {}): Client =>
  ({ id: 'c1', name: 'Acme', billingMode: 'subscription', monthlyRate: 500, ...over }) as Client

const render_ = (c: Client, onCommit = vi.fn(), today = '2026-10-07') => {
  render(<BillingPeriodSectionBody client={c} onCommit={onCommit} today={today} />)
  return onCommit
}

const everyInput = () => screen.getByLabelText(/bill every/i) as HTMLInputElement
const startingInput = () => screen.getByLabelText(/starting/i) as HTMLInputElement

const setMonths = (value: string) => {
  fireEvent.change(everyInput(), { target: { value } })
  fireEvent.blur(everyInput())
}

describe('the Billing period card', () => {
  it('reads monthly (1) with no start for a client that never had a period', () => {
    render_(client())
    expect(everyInput().value).toBe('1')
    expect(startingInput().value).toBe('')
    expect(screen.getByText(/billed every month, as always/i)).toBeVisible()
  })

  it('shows a client\'s stored period and works out the next prepayment', () => {
    render_(client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' }))
    expect(everyInput().value).toBe('3')
    expect(startingInput().value).toBe('2026-10')
    expect(
      screen.getByText(
        'The next prepayment is on the October 2026 invoice. It covers October through December 2026 and carries the estimated fee for November and December.',
      ),
    ).toBeVisible()
  })

  it('commits the period and the start together once both are valid', () => {
    const onCommit = render_(client())
    fireEvent.change(startingInput(), { target: { value: '2026-10' } })
    // Still monthly: nothing to save yet, and no complaint either.
    expect(onCommit).not.toHaveBeenCalled()
    setMonths('3')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' })
    expect(screen.getByText(/the next prepayment is on the October 2026 invoice/i)).toBeVisible()
  })

  it('refuses a period above 1 with no first month, says so, and saves nothing', () => {
    const onCommit = render_(client())
    setMonths('3')
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/pick the first month/i)
  })

  it('commits a first month picked after the period, and clears the complaint', () => {
    const onCommit = render_(client())
    setMonths('3')
    fireEvent.change(startingInput(), { target: { value: '2026-11' } })
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 3, periodAnchorMonth: '2026-11' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['0', '25', '2.5', '-1', ''])('refuses %j as the number of months', (value) => {
    const onCommit = render_(client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' }))
    setMonths(value)
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number of months from 1 to 24/i)
  })

  it('accepts any whole number from 1 to 24, not a fixed menu', () => {
    const onCommit = render_(client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' }))
    setMonths('5')
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 5, periodAnchorMonth: '2026-10' })
    setMonths('24')
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 24, periodAnchorMonth: '2026-10' })
  })

  it('going back to 1 saves monthly and clears the start', () => {
    const onCommit = render_(client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' }))
    setMonths('1')
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 1, periodAnchorMonth: null })
    expect(screen.getByText(/billed every month, as always/i)).toBeVisible()
  })

  it('names the following period once the first month has passed', () => {
    render_(client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' }), vi.fn(), '2026-11-15')
    expect(screen.getByText(/the next prepayment is on the January 2027 invoice/i)).toBeVisible()
  })

  it('tells her the period does nothing until the client has a monthly rate', () => {
    render_(client({ monthlyRate: undefined }))
    expect(screen.getByText(/needs a monthly rate above \$0/i)).toBeVisible()
  })

  it('shows no card for an hourly client or the old annual mode', () => {
    const { container, rerender } = render(
      <BillingPeriodSectionBody client={client({ billingMode: 'hourly' })} onCommit={vi.fn()} today="2026-10-07" />,
    )
    expect(container).toBeEmptyDOMElement()
    rerender(
      <BillingPeriodSectionBody client={client({ billingMode: 'annual' })} onCommit={vi.fn()} today="2026-10-07" />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('billing masters and their subs (M-3)', () => {
  it('shows no card on a billing master or on a sub, whatever period is stored on them', () => {
    for (const over of [
      { isBillingMaster: true },
      { billToClientId: 'master-1' },
    ] as Partial<Client>[]) {
      const { container } = render(
        <BillingPeriodSectionBody
          client={client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10', ...over })}
          onCommit={vi.fn()}
          today="2026-10-07"
        />,
      )
      expect(container).toBeEmptyDOMElement()
    }
  })
})

describe('the card warns when a change bills a month twice (M-7)', () => {
  const WARNING =
    'Changing this now will bill November 2026 twice; the extra prepayment becomes credit on account.'
  const running = () => client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-09' })

  it('after moving the start inside a running period, once the saved period shows it', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<BillingPeriodSectionBody client={running()} onCommit={onCommit} today="2026-10-07" />)
    expect(screen.queryByText(WARNING)).toBeNull()
    fireEvent.change(startingInput(), { target: { value: '2026-10' } })
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' })
    // The page hands the card the saved client back.
    rerender(
      <BillingPeriodSectionBody
        client={client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' })}
        onCommit={onCommit}
        today="2026-10-07"
      />,
    )
    expect(screen.getByText(WARNING)).toBeVisible()
  })

  it('goes away when the period is changed again to something that bills nothing twice', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<BillingPeriodSectionBody client={running()} onCommit={onCommit} today="2026-10-07" />)
    fireEvent.change(startingInput(), { target: { value: '2026-10' } })
    rerender(
      <BillingPeriodSectionBody
        client={client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' })}
        onCommit={onCommit}
        today="2026-10-07"
      />,
    )
    expect(screen.getByText(WARNING)).toBeVisible()
    setMonths('1')
    rerender(<BillingPeriodSectionBody client={client({ billingPeriodMonths: 1 })} onCommit={onCommit} today="2026-10-07" />)
    expect(screen.queryByText(WARNING)).toBeNull()
  })

  it('says nothing for a first period, a monthly client or a change that bills nothing twice', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<BillingPeriodSectionBody client={client()} onCommit={onCommit} today="2026-10-07" />)
    fireEvent.change(startingInput(), { target: { value: '2026-10' } })
    setMonths('3')
    rerender(
      <BillingPeriodSectionBody
        client={client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-10' })}
        onCommit={onCommit}
        today="2026-10-07"
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('the warning compares with the period as the card opened (N-6)', () => {
  const WARNING =
    'Changing this now will bill November 2026 twice; the extra prepayment becomes credit on account.'

  it('catches a double bill built in two saved steps: every 2 months, then start October', () => {
    const onCommit = vi.fn()
    const at = (c: Partial<Client>) => (
      <BillingPeriodSectionBody client={client(c)} onCommit={onCommit} today="2026-10-07" />
    )
    const { rerender } = render(at({ billingPeriodMonths: 3, periodAnchorMonth: '2026-09' }))
    setMonths('2')
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 2, periodAnchorMonth: '2026-09' })
    // Step one on its own bills nothing twice.
    rerender(at({ billingPeriodMonths: 2, periodAnchorMonth: '2026-09' }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.change(startingInput(), { target: { value: '2026-10' } })
    expect(onCommit).toHaveBeenLastCalledWith({ billingPeriodMonths: 2, periodAnchorMonth: '2026-10' })
    rerender(at({ billingPeriodMonths: 2, periodAnchorMonth: '2026-10' }))
    expect(screen.getByText(WARNING)).toBeVisible()
  })
})
