import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchClientRecap, listBilledOnInvoicesRequest, type BilledOnInvoice } from '../lib/api'
import { ApiError } from '../lib/types'

/**
 * The two client calls consolidated billing adds or changes.
 *
 * `listBilledOnInvoicesRequest` is new; what is pinned is the URL it builds
 * (including the encoded client id and the optional period) and that it unwraps
 * `{ invoices }` the way every other list call does.
 *
 * `fetchClientRecap` CHANGED: it used to show whichever half of an error body
 * came first, which put the machine-readable code in front of a person. The
 * recap route now answers 409 { error: 'master_without_subs', message: '…' }
 * for a billing master with nothing pointed at it, and the page needs both — the
 * sentence to print, and the code to tell a misconfiguration apart from a
 * failure. Both halves are asserted here.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>

/** The URL of the nth request, as a string. */
const requestedUrl = (call = 0) => {
  const input = fetchMock.mock.calls[call][0] as RequestInfo | URL
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

const row: BilledOnInvoice = {
  invoiceId: 'inv-master-sep',
  number: 'INV-2026-09-004',
  period: '2026-09',
  status: 'paid',
  masterClientId: 'client-klc-master',
  masterClientName: 'KLC Master',
  subtotal: 425,
  paidAt: '2026-09-03T14:00:00.000Z',
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ invoices: [row] }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listBilledOnInvoicesRequest', () => {
  it('asks the client-scoped endpoint and unwraps the rows', async () => {
    const invoices = await listBilledOnInvoicesRequest('client-chemtrex')

    expect(requestedUrl()).toContain('/api/clients/client-chemtrex/billed-on-invoices')
    expect(requestedUrl()).not.toContain('?')
    expect(invoices).toEqual([row])
  })

  it('narrows to one month when asked', async () => {
    await listBilledOnInvoicesRequest('client-chemtrex', '2026-09')

    expect(requestedUrl()).toContain('/billed-on-invoices?period=2026-09')
  })

  // An id is user data in the path. Encoded, not interpolated raw.
  it('encodes the client id', async () => {
    await listBilledOnInvoicesRequest('client/../secrets')

    expect(requestedUrl()).toContain('/api/clients/client%2F..%2Fsecrets/billed-on-invoices')
  })

  it('throws the server’s sentence when it refuses', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'forbidden', message: 'Only owners can see billing.' }, 403),
    )

    await expect(listBilledOnInvoicesRequest('client-chemtrex')).rejects.toMatchObject({
      status: 403,
      message: 'Only owners can see billing.',
    })
  })
})

describe('fetchClientRecap — the master-without-subs refusal', () => {
  it('carries the sentence AND the code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'master_without_subs',
          message:
            'This billing master has no active sub clients yet, so there is nothing to roll up.',
        },
        409,
      ),
    )

    const failure = await fetchClientRecap('client-klc-master', 'month', '2026-09').catch(
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({
      status: 409,
      code: 'master_without_subs',
      message:
        'This billing master has no active sub clients yet, so there is nothing to roll up.',
    })
  })

  // The old bug, pinned: never the raw code in front of a person when a
  // sentence was sent alongside it.
  it('never shows the machine-readable half when a sentence exists', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'recap_failed', message: 'The recap could not be built.' }, 500),
    )

    await expect(fetchClientRecap('client-acme', 'month', '2026-09')).rejects.toThrow(
      'The recap could not be built.',
    )
  })
})
