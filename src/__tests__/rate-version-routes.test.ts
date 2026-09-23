import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteBillRateVersion,
  deleteCostRateVersion,
  fetchRateVersions,
  setClientHourlyRatePeriod,
  upsertBillRateVersion,
  upsertCostRateVersion,
} from '../lib/api'
import { ApiError } from '../lib/types'

/**
 * The browser's door onto rate history.
 *
 * What is pinned here is the CONTRACT with the Task 6 endpoints: the URL each
 * call builds, the verb it uses, the exact body it sends, and — the part that
 * matters to a person — that a refused write carries the server's SENTENCE
 * through instead of the machine-readable code beside it.
 *
 * The read's 403 is the odd one out and is pinned deliberately: rates are
 * owner-only, so a staff session that reaches one of these surfaces should get
 * a redacted page, not a broken one. Two empty lists are exactly what the
 * resolver already falls back to for that session.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

/** The URL of the nth request, as a string. */
const requestedUrl = (call = 0) => {
  const input = fetchMock.mock.calls[call][0] as RequestInfo | URL
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}
const requestInit = (call = 0) => fetchMock.mock.calls[call][1] as RequestInit
const sentBody = (call = 0) => JSON.parse(String(requestInit(call).body))

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchRateVersions', () => {
  it('unwraps both lists', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        billRateVersions: [{ userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 }],
        costRateVersions: [{ userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 }],
      }),
    )
    const result = await fetchRateVersions()
    expect(requestedUrl()).toContain('/api/rate-versions')
    expect(result.billRateVersions).toHaveLength(1)
    expect(result.costRateVersions).toHaveLength(1)
  })

  it('answers two empty lists rather than throwing when a staff session is refused', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Only owners can see rate history' }, 403))
    await expect(fetchRateVersions()).resolves.toEqual({
      billRateVersions: [],
      costRateVersions: [],
    })
  })
})

describe('the four version writes', () => {
  it('PUTs a bill-rate version', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'emp-lisa', versions: [] }))
    await upsertBillRateVersion('emp-lisa', '2026-10', 60)
    expect(requestedUrl()).toContain('/api/team/bill-rate-version')
    expect(requestInit().method).toBe('PUT')
    expect(sentBody()).toEqual({ userId: 'emp-lisa', effectivePeriod: '2026-10', rate: 60 })
  })

  it('DELETEs a bill-rate version and surfaces the 409 sentence', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'rate_version_locked',
          message:
            'A client is pinned at or after this month, so it is still billing at this rate. Move that client first.',
        },
        409,
      ),
    )
    await expect(deleteBillRateVersion('emp-lisa', '2026-10')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Move that client first'),
    })
    expect(requestInit().method).toBe('DELETE')
  })

  it('PUTs a cost-rate version keyed by date', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'emp-lisa', versions: [] }))
    await upsertCostRateVersion('emp-lisa', '2026-10-01', 26)
    expect(requestedUrl()).toContain('/api/team/cost-rate-version')
    expect(sentBody()).toEqual({ userId: 'emp-lisa', effectiveDate: '2026-10-01', rate: 26 })
  })

  it('DELETEs a cost-rate version', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'emp-lisa', versions: [] }))
    await deleteCostRateVersion('emp-lisa', '2026-10-01')
    expect(requestInit().method).toBe('DELETE')
    expect(sentBody()).toEqual({ userId: 'emp-lisa', effectiveDate: '2026-10-01' })
  })
})

describe('setClientHourlyRatePeriod', () => {
  it('PUTs to the targeted route with the id encoded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'client a', hourlyRatePeriod: '2026-10' }))
    const updated = await setClientHourlyRatePeriod('client a', '2026-10')
    expect(requestedUrl()).toContain('/api/clients/client%20a/hourly-rate-period')
    expect(requestInit().method).toBe('PUT')
    expect(sentBody()).toEqual({ period: '2026-10' })
    expect(updated.hourlyRatePeriod).toBe('2026-10')
  })

  it('throws an ApiError carrying the server’s sentence', async () => {
    // A fresh Response per call, not one shared instance: this test calls the
    // function twice and a Response body can only be read once, so a single
    // mocked instance would leave the second call reading an empty body and
    // falling back to the generic sentence.
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        {
          error: 'not_hourly',
          message: 'Only Hourly clients bill at a person’s rate, so only they have a rate month.',
        },
        400,
      ),
    )
    await expect(setClientHourlyRatePeriod('c1', '2026-10')).rejects.toBeInstanceOf(ApiError)
    await expect(setClientHourlyRatePeriod('c1', '2026-10')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Only Hourly clients'),
    })
  })
})
