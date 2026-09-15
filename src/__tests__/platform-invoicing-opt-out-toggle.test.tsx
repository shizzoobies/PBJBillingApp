import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceSettingsSectionBody } from '../pages/ClientDetailPage'
import type { Client } from '../lib/types'

/**
 * The "Opt out of platform invoicing" toggle on a client's Billing tab — the
 * ONE place `platformInvoicingOptOut` is written from the UI (featreq-006f12f6).
 *
 * Worth its own test for the same reason the card toggle beside it is: what it
 * commits decides whether this client is billed from here AT ALL. A toggle that
 * committed the wrong key, or sat on the wrong default, would read as "opted
 * out" on screen while the month run kept generating invoices — or the reverse,
 * which is a client who quietly stops being billed by anyone.
 */

// `SaveToggleField`'s save badge reads `dataSyncState` through the context;
// nothing else here touches it.
vi.mock('../AppContext', () => ({ useAppContext: () => ({ dataSyncState: 'idle' }) }))

const client = (over: Partial<Client> = {}): Client =>
  ({ id: 'client-rivercity', name: 'Rivercity Appraisal Services, Inc.', ...over }) as Client

const toggle = () => screen.getByLabelText(/opt out of platform invoicing/i)

describe('the platform-invoicing opt-out toggle', () => {
  it('is off for a client that never had the field', () => {
    render(<InvoiceSettingsSectionBody client={client()} onCommit={vi.fn()} />)
    expect(toggle()).not.toBeChecked()
  })

  it('is on for a client that is billed outside the app', () => {
    render(
      <InvoiceSettingsSectionBody
        client={client({ platformInvoicingOptOut: true })}
        onCommit={vi.fn()}
      />,
    )
    expect(toggle()).toBeChecked()
  })

  it('commits the opt-out, and nothing else, when switched on', () => {
    const onCommit = vi.fn()
    render(<InvoiceSettingsSectionBody client={client()} onCommit={onCommit} />)

    fireEvent.click(toggle())

    expect(onCommit).toHaveBeenCalledWith({ platformInvoicingOptOut: true })
  })

  it('commits false when switched back off', () => {
    const onCommit = vi.fn()
    render(
      <InvoiceSettingsSectionBody
        client={client({ platformInvoicingOptOut: true })}
        onCommit={onCommit}
      />,
    )

    fireEvent.click(toggle())

    expect(onCommit).toHaveBeenCalledWith({ platformInvoicingOptOut: false })
  })

  // It sits BESIDE the card toggle, and the two are independent: opting out of
  // platform invoicing must not disturb a card setting somebody agreed with the
  // client, in case the opt-out is ever switched back off.
  it('leaves the card toggle alone', () => {
    const onCommit = vi.fn()
    render(
      <InvoiceSettingsSectionBody
        client={client({ cardPaymentsEnabled: true })}
        onCommit={onCommit}
      />,
    )
    expect(screen.getByLabelText(/pay by card/i)).toBeChecked()

    fireEvent.click(toggle())

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ platformInvoicingOptOut: true })
  })
})
