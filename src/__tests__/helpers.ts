import { vi } from 'vitest'
import { createSeedData } from '../lib/seed'
import { DEFAULT_FIRM_SETTINGS, type AppData, type SessionUser } from '../lib/types'

/**
 * Test-only network mocking. `<App>` boots by hitting four GET endpoints:
 *   GET /api/session              -> { user: SessionUser | null }
 *   GET /api/firm-settings/public -> PublicFirmSettings
 *   GET /api/firm-settings        -> FirmSettings        (only once signed in)
 *   GET /api/app-data             -> AppData             (only once signed in)
 *
 * `installFetchMock` stubs the global `fetch` so the app can boot in the test
 * DOM with no real server. Each endpoint resolves to a canned response keyed
 * off the request URL; anything unrecognized resolves to 404 so a stray
 * request surfaces loudly instead of hanging.
 */

type JsonBody = unknown

function jsonResponse(body: JsonBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export type FetchMockOptions = {
  /** Session payload — `null` user means logged out. */
  sessionUser: SessionUser | null
  /** App data returned from /api/app-data once signed in. Defaults to the seed. */
  appData?: AppData
}

/**
 * The owner SessionUser used by the logged-in test case. `id` matches the
 * Owner employee in the seed (`emp-patrice`) so preview/scoping stays coherent.
 */
export const OWNER_SESSION: SessionUser = {
  id: 'emp-patrice',
  name: 'Brittany Ferguson',
  email: 'owner@example.com',
  role: 'owner',
  staffRole: 'Owner',
  totpEnabled: true,
}

export function installFetchMock(options: FetchMockOptions): void {
  const appData = options.appData ?? createSeedData()

  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const path = url.split('?')[0]

    if (path.endsWith('/api/session')) {
      return jsonResponse({ user: options.sessionUser })
    }
    if (path.endsWith('/api/firm-settings/public')) {
      return jsonResponse({
        name: DEFAULT_FIRM_SETTINGS.name,
        tagline: DEFAULT_FIRM_SETTINGS.tagline ?? '',
        logoUrl: DEFAULT_FIRM_SETTINGS.logoUrl ?? '',
        brandColor: DEFAULT_FIRM_SETTINGS.brandColor ?? '#3c2044',
      })
    }
    if (path.endsWith('/api/firm-settings')) {
      return jsonResponse(DEFAULT_FIRM_SETTINGS)
    }
    if (path.endsWith('/api/app-data')) {
      return jsonResponse(appData)
    }
    if (path.endsWith('/api/notifications/unread-count')) {
      return jsonResponse({ count: 0 })
    }
    // Secondary endpoints the authenticated dashboard polls. Returning empty
    // payloads keeps the boot path quiet; the components also tolerate 404s.
    if (path.endsWith('/api/team')) {
      return jsonResponse({ users: [] })
    }
    if (path.includes('/api/activity')) {
      return jsonResponse({ entries: [] })
    }
    // Unknown endpoint — fail loud rather than hang.
    return jsonResponse({ error: `unmocked endpoint: ${path}` }, 404)
  })

  vi.stubGlobal('fetch', handler)
}
