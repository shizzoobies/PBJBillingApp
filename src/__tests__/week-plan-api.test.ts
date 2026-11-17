import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWeekPlanRequest, saveWeekPlanEntryRequest } from '../lib/api'
import { ApiError } from '../lib/types'

/**
 * The browser's door onto My Week (featreq-f0e8046b): which address each
 * request goes to and what an answer must carry before the page may use it.
 *
 * Two things here are about data safety, not style:
 *  - a save goes to `/api/week-plan/:clientId/tasks`. The first version of the
 *    page saved to the address without `/tasks`, which now only answers
 *    "reload"; and the first version of the SERVER has no `/tasks` route, so
 *    during a deploy hand-over it cannot half-understand a row whose days are
 *    on each task and write it back flattened;
 *  - a week is only used when the answer says `daysPerTask: true`. The first
 *    version of the server reads a per-task row as "the client is on these
 *    days"; shown and then changed, that would be saved as her plan.
 */

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

const row = {
  weekStart: '2026-11-16',
  plannedDays: ['2026-11-16'],
  note: 'bank feed first',
  taskMarks: { 'chk-1': { status: null, note: '', days: ['2026-11-16'] } },
}

describe('saveWeekPlanEntryRequest', () => {
  it('PUTs the whole row to the per-task address, with the client id encoded', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ weekStart: row.weekStart, entry: { clientId: 'client a', ...row, updatedAt: null } }),
    )
    const saved = await saveWeekPlanEntryRequest('client a', row)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('/api/week-plan/client%20a/tasks')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual(row)
    expect(saved.entry.plannedDays).toEqual(['2026-11-16'])
  })

  it('never saves to the first version’s address', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ weekStart: row.weekStart, entry: null }))
    await saveWeekPlanEntryRequest('client-1', row)
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/\/api\/week-plan\/client-1$/)
  })

  it('throws an ApiError carrying the server’s sentence', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: 'A day must be Monday to Friday of that week.' }, 400),
    )
    await expect(saveWeekPlanEntryRequest('client-1', row)).rejects.toBeInstanceOf(ApiError)
    await expect(saveWeekPlanEntryRequest('client-1', row)).rejects.toMatchObject({
      status: 400,
      message: 'A day must be Monday to Friday of that week.',
    })
  })

  it('a server without the route (the previous version, mid-update) is an error, never a silent success', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Not found' }, 404))
    await expect(saveWeekPlanEntryRequest('client-1', row)).rejects.toMatchObject({ status: 404 })
  })
})

describe('fetchWeekPlanRequest', () => {
  const answer = (extra: Record<string, unknown> = {}) =>
    jsonResponse({ weekStart: '2026-11-16', userId: 'emp-1', entries: [{ clientId: 'c1', ...row, updatedAt: null }], ...extra })

  it('asks for her own week by naming nobody', async () => {
    fetchMock.mockResolvedValue(answer({ daysPerTask: true }))
    const result = await fetchWeekPlanRequest('2026-11-16')
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/week-plan?week=2026-11-16')
    expect(result).toEqual({
      weekStart: '2026-11-16',
      userId: 'emp-1',
      entries: [{ clientId: 'c1', ...row, updatedAt: null }],
    })
  })

  it('names a person when an owner looks at their week', async () => {
    fetchMock.mockResolvedValue(answer({ daysPerTask: true }))
    await fetchWeekPlanRequest('2026-11-16', 'emp lisa')
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/week-plan?week=2026-11-16&user=emp+lisa')
  })

  it('does not use an answer from a server that does not keep days on each task', async () => {
    fetchMock.mockImplementation(async () => answer())
    await expect(fetchWeekPlanRequest('2026-11-16')).rejects.toBeInstanceOf(ApiError)
    await expect(fetchWeekPlanRequest('2026-11-16')).rejects.toMatchObject({
      message: 'My Week is being updated. Reload the page in a moment.',
    })
    // Anything but exactly true is "does not".
    for (const marker of [false, 'true', 1, null]) {
      fetchMock.mockImplementation(async () => answer({ daysPerTask: marker }))
      await expect(fetchWeekPlanRequest('2026-11-16')).rejects.toBeInstanceOf(ApiError)
    }
  })

  it('throws an ApiError carrying the server’s sentence', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'You can only see your own week.' }, 403))
    await expect(fetchWeekPlanRequest('2026-11-16', 'emp-2')).rejects.toMatchObject({
      status: 403,
      message: 'You can only see your own week.',
    })
  })
})
