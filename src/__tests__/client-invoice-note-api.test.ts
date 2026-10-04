import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setClientInvoiceNote } from '../lib/api'
import { ApiError } from '../lib/types'

/** The browser's door onto the kept invoice note: URL, verb, body, refusal text. */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setClientInvoiceNote', () => {
  it('PUTs the note to the targeted route with the id encoded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'client a', invoiceNote: 'Thanks' }))
    const updated = await setClientInvoiceNote('client a', 'Thanks')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/api/clients/client%20a/invoice-note')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ note: 'Thanks' })
    expect(updated.invoiceNote).toBe('Thanks')
  })

  it('throws an ApiError carrying the server sentence', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: 'Only owners can keep a note for future invoices' }, 403),
    )
    await expect(setClientInvoiceNote('c1', 'x')).rejects.toBeInstanceOf(ApiError)
    await expect(setClientInvoiceNote('c1', 'x')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Only owners'),
    })
  })
})
