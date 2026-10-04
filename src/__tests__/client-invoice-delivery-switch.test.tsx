import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceDeliverySectionBody, InvoiceSettingsSectionBody } from '../pages/ClientDetailPage'
import type { Client } from '../lib/types'

/**
 * "Generate the invoice but never email it" (featreq-21d0bba8 answer 8,
 * Rivercity): its OWN card on the Billing tab, "Invoice delivery". It is not the
 * "Opt out of platform invoicing" switch beside the invoice settings, which
 * stops the invoice being generated at all and stays exactly as it was.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => ({ dataSyncState: 'idle' }) }))

const client = (over: Partial<Client> = {}): Client =>
  ({ id: 'client-rivercity', name: 'Rivercity Appraisal Services, Inc.', ...over }) as Client

const toggle = () => screen.getByLabelText(/generate the invoice but never email it/i)

describe('the never-email switch', () => {
  it('is off for a client that never had the field', () => {
    render(<InvoiceDeliverySectionBody client={client()} onCommit={vi.fn()} />)
    expect(toggle()).not.toBeChecked()
  })

  it('is on for a client whose invoices are delivered outside the app', () => {
    render(
      <InvoiceDeliverySectionBody client={client({ invoiceNoEmail: true })} onCommit={vi.fn()} />,
    )
    expect(toggle()).toBeChecked()
  })

  it('commits the switch, and nothing else, when turned on and off', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<InvoiceDeliverySectionBody client={client()} onCommit={onCommit} />)
    fireEvent.click(toggle())
    expect(onCommit).toHaveBeenLastCalledWith({ invoiceNoEmail: true })

    rerender(<InvoiceDeliverySectionBody client={client({ invoiceNoEmail: true })} onCommit={onCommit} />)
    fireEvent.click(toggle())
    expect(onCommit).toHaveBeenLastCalledWith({ invoiceNoEmail: false })
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('says the invoice is still made and reviewed here, and is marked sent without an email', () => {
    render(<InvoiceDeliverySectionBody client={client()} onCommit={vi.fn()} />)
    expect(screen.getByText(/still generated here/i)).toBeVisible()
    expect(screen.getByText(/marks it sent without an email/i)).toBeVisible()
  })

  // The two switches are different decisions; one must never stand in for the other.
  it('is not the platform-invoicing opt-out, which stays in the invoice settings', () => {
    const onCommit = vi.fn()
    const { unmount } = render(<InvoiceSettingsSectionBody client={client()} onCommit={onCommit} />)
    expect(screen.queryByLabelText(/generate the invoice but never email it/i)).toBeNull()
    expect(screen.getByLabelText(/opt out of platform invoicing/i)).toBeInTheDocument()
    unmount()

    render(<InvoiceDeliverySectionBody client={client()} onCommit={onCommit} />)
    expect(screen.queryByLabelText(/opt out of platform invoicing/i)).toBeNull()
  })
})
