import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { InvoiceAdvanceSection } from '../components/InvoiceAdvanceSection'
import type { PersistedInvoice } from '../lib/types'

const api = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ advancePaymentRequest: api }))
afterEach(() => { cleanup(); api.mockReset() })
const invoice = { id: 'i1', clientId: 'c1', period: '2026-10', status: 'draft', kind: 'monthly', total: 300, lineItems: [], sentAt: null } as unknown as PersistedInvoice
describe('invoice advance section choices', () => {
  it('requires an explicit agreement, keeps failed choices for retry, and resets unsaved choices on cancel', async () => {
    api.mockResolvedValueOnce({ requests: [{ id: 'r1', number: 'ADV-TEST', requestedCents: 150000, canceledAt: null, collectionMethod: 'manual' }] })
    const changed = vi.fn()
    render(<InvoiceAdvanceSection invoice={invoice} disabled={false} onChanged={changed} />)
    fireEvent.click(screen.getByText('Pay in advance section'))
    await screen.findByText('ADV-TEST — $1,500.00')
    fireEvent.change(screen.getByLabelText('Advance request to include'), { target: { value: 'r1' } })
    expect(screen.getByText('Save advance section')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Advance agreement'), { target: { value: 'optional' } })
    api.mockRejectedValueOnce(new Error('Synthetic interrupted save'))
    fireEvent.click(screen.getByText('Save advance section'))
    await screen.findByText('Synthetic interrupted save')
    expect(screen.getByLabelText('Advance agreement')).toHaveValue('optional')
    api.mockResolvedValueOnce({ invoice })
    fireEvent.click(screen.getByText('Save advance section'))
    await waitFor(() => expect(changed).toHaveBeenCalledWith(invoice))
    expect(api).toHaveBeenLastCalledWith('/r1/attach', { invoiceId: 'i1', optional: true })
    fireEvent.change(screen.getByLabelText('Advance agreement'), { target: { value: 'agreed' } })
    fireEvent.click(screen.getByText('Cancel section edits'))
    expect(screen.queryByLabelText('Advance agreement')).toBeNull()
  })
  it('does not offer mutation for issued invoices or unsaved service edits', () => {
    const { rerender } = render(<InvoiceAdvanceSection invoice={{ ...invoice, status: 'sent', sentAt: '2026-10-28' }} disabled={false} onChanged={vi.fn()} />)
    expect(screen.queryByText('Pay in advance section')).toBeNull()
    rerender(<InvoiceAdvanceSection invoice={invoice} disabled onChanged={vi.fn()} />)
    expect(screen.queryByText('Pay in advance section')).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })
})
