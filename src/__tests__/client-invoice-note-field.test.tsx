import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceSettingsSectionBody } from '../pages/ClientDetailPage'
import type { Client } from '../lib/types'

/**
 * "Note on every invoice" in a client's invoice customization card
 * (featreq-459bdfc2 item 7): the saved text that starts the note on every new
 * invoice for this client, editable and clearable.
 *
 * It saves through its own endpoint (`setClientInvoiceNote`), never the bulk
 * save, and only then updates the page's copy of the client.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => ({ dataSyncState: 'idle' }) }))

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  setClientInvoiceNote: vi.fn(),
}))

import { setClientInvoiceNote } from '../lib/api'

const mockKeep = vi.mocked(setClientInvoiceNote)

const client = (over: Partial<Client> = {}): Client =>
  ({ id: 'client-acme', name: 'Acme', ...over }) as Client

const field = () => screen.getByLabelText(/note on every invoice/i) as HTMLTextAreaElement

beforeEach(() => {
  mockKeep.mockReset()
})

describe('the "Note on every invoice" field', () => {
  it('shows the saved text, and is empty for a client with none', () => {
    const { unmount } = render(
      <InvoiceSettingsSectionBody
        client={client({ invoiceNote: 'Thanks for your business.' })}
        onCommit={vi.fn()}
      />,
    )
    expect(field().value).toBe('Thanks for your business.')
    unmount()

    render(<InvoiceSettingsSectionBody client={client()} onCommit={vi.fn()} />)
    expect(field().value).toBe('')
  })

  it('limits the note to 2000 characters, the most the server will keep', () => {
    render(<InvoiceSettingsSectionBody client={client()} onCommit={vi.fn()} />)
    expect(field().maxLength).toBe(2000)
  })

  it('says what it does, and that existing invoices keep their own note', () => {
    render(<InvoiceSettingsSectionBody client={client()} onCommit={vi.fn()} />)
    expect(screen.getByText(/starts the note to the client on every new invoice/i)).toBeVisible()
    expect(screen.getByText(/already created keep their own note/i)).toBeVisible()
  })

  it('saves an edit through the targeted endpoint, then updates the page copy', async () => {
    const onCommit = vi.fn()
    mockKeep.mockResolvedValue(client({ invoiceNote: 'Net 15, thank you.' }))
    render(<InvoiceSettingsSectionBody client={client()} onCommit={onCommit} />)

    fireEvent.change(field(), { target: { value: 'Net 15, thank you.' } })
    fireEvent.blur(field())

    await waitFor(() => expect(mockKeep).toHaveBeenCalledWith('client-acme', 'Net 15, thank you.'))
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith({ invoiceNote: 'Net 15, thank you.' }))
  })

  it('clears the kept note when the box is emptied', async () => {
    const onCommit = vi.fn()
    mockKeep.mockResolvedValue(client({ invoiceNote: null }))
    render(
      <InvoiceSettingsSectionBody
        client={client({ invoiceNote: 'Old note' })}
        onCommit={onCommit}
      />,
    )

    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.blur(field())

    await waitFor(() => expect(mockKeep).toHaveBeenCalledWith('client-acme', ''))
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith({ invoiceNote: null }))
  })

  it('says so and leaves the page copy alone when the save is refused', async () => {
    const onCommit = vi.fn()
    mockKeep.mockRejectedValue(new Error('Only owners can keep a note for future invoices'))
    render(<InvoiceSettingsSectionBody client={client()} onCommit={onCommit} />)

    fireEvent.change(field(), { target: { value: 'Nope' } })
    fireEvent.blur(field())

    expect(await screen.findByRole('alert')).toHaveTextContent(/Only owners can keep a note/)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
