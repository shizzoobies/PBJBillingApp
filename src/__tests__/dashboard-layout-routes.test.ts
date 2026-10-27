import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDashboardLayout, saveDashboardLayoutRequest, setPreviewUser } from '../lib/api'
import { defaultDashboardLayout } from '../../lib/dashboard-layout.js'

/**
 * GET/PUT /api/me/dashboard-layout, pinned at the level this repo can reach.
 *
 * `server.js` calls `server.listen()` at module scope and exports nothing, so
 * the routes are pinned by reading their source (see preview-scoped-routes.test.ts
 * for the same reasoning). The DECISIONS are tested for behavior elsewhere: the
 * cleaner in lib/dashboard-layout.test.mjs, the store on both backends in
 * db/store-staleness.test.mjs, the page in dashboard-layout.test.tsx. A failure
 * here means "the route changed, go look".
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')

function routeBlock(startPattern: RegExp, length = 1700): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const getRoute = () =>
  routeBlock(/normalizedPath === '\/api\/me\/dashboard-layout' && request\.method === 'GET'/, 700)
const putRoute = () =>
  routeBlock(/normalizedPath === '\/api\/me\/dashboard-layout' && request\.method === 'PUT'/, 1500)

describe('GET /api/me/dashboard-layout', () => {
  it('needs a session and answers the cleaned layout for the scoped person’s view (the default when none is saved)', () => {
    const block = getRoute()
    expect(block).toContain('await requireSession(request, response)')
    expect(block).toContain('await previewScopedSession(request, session, response)')
    expect(block).toContain('appDataStore.getTeamMember(scoped.user.id)')
    // sanitizeDashboardLayout(null, view) is the default layout.
    expect(block).toContain(
      'layout: sanitizeDashboardLayout(member?.dashboardLayout, dashboardViewForRole(scoped.user.role))',
    )
  })

  it('is reachable in preview (the /api/me/ pattern) and the PUT is not (the write guard)', () => {
    const patterns = routeBlock(/const PREVIEW_AWARE_API_PATTERNS = \[/, 700)
    expect(patterns).toContain('/^\\/api\\/me\\/[^/?]*$/')
    expect(serverSource).toContain(
      "(request.headers['x-preview-mode'] === '1' || request.headers['x-preview-as']) &&",
    )
  })
})

describe('PUT /api/me/dashboard-layout', () => {
  it('refuses a non-JSON body with 415 and a cross-site origin with 403, before reading the body', () => {
    const block = putRoute()
    const session = block.indexOf('await requireSession(request, response)')
    const json = block.indexOf("sendJson(response, 415, { error: 'application/json required' })")
    const origin = block.indexOf("sendJson(response, 403, { error: 'Origin not allowed' })")
    const read = block.indexOf('await readJsonBody(request)')
    expect(session).toBeGreaterThan(-1)
    expect(json).toBeGreaterThan(session)
    expect(origin).toBeGreaterThan(json)
    expect(read).toBeGreaterThan(origin)
    expect(block).toContain("contentType.toLowerCase().includes('application/json')")
  })

  it('cleans for the SIGNED-IN person’s own view and saves their row only, NULL for the default', () => {
    const block = putRoute()
    expect(block).toContain('const view = dashboardViewForRole(session.user.role)')
    expect(block).toContain('const clean = sanitizeDashboardLayout(payload?.layout, view)')
    expect(block).toContain('appDataStore.setDashboardLayout(')
    expect(block).toContain('session.user.id,')
    expect(block).toContain('isDefaultDashboardLayout(clean, view) ? null : clean')
    expect(block).toContain("sendJson(response, 404, { error: 'User not found' })")
    expect(block).toContain('sendJson(response, 200, { layout: clean })')
  })

  it('imports the shared cleaner rather than re-deciding the rules', () => {
    expect(serverSource).toMatch(
      /import \{\s+dashboardViewForRole,\s+isDefaultDashboardLayout,\s+sanitizeDashboardLayout,\s+\} from '\.\/lib\/dashboard-layout\.js'/,
    )
  })
})

describe('the client calls', () => {
  afterEach(() => {
    setPreviewUser(null)
    vi.unstubAllGlobals()
  })

  function stubFetch(response: Response) {
    const handler = vi.fn<typeof fetch>(async () => response.clone())
    vi.stubGlobal('fetch', handler)
    return handler
  }

  it('reads the layout, carrying the previewed person in preview', async () => {
    const layout = defaultDashboardLayout('staff')
    const handler = stubFetch(new Response(JSON.stringify({ layout }), { status: 200 }))
    setPreviewUser('emp-jordan')
    await expect(fetchDashboardLayout()).resolves.toEqual({ layout })
    const [url, init] = handler.mock.calls[0]
    expect(url).toBe('/api/me/dashboard-layout')
    expect(new Headers(init?.headers).get('X-Preview-As')).toBe('emp-jordan')
  })

  it('saves with one JSON PUT of { layout }', async () => {
    const layout = defaultDashboardLayout('owner')
    const handler = stubFetch(new Response(JSON.stringify({ layout }), { status: 200 }))
    await expect(saveDashboardLayoutRequest(layout)).resolves.toEqual({ layout })
    const [url, init] = handler.mock.calls[0]
    expect(url).toBe('/api/me/dashboard-layout')
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ layout })
  })

  it('throws on a refusal so the page can say the save failed', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'application/json required' }), { status: 415 }))
    await expect(saveDashboardLayoutRequest(defaultDashboardLayout('owner'))).rejects.toThrow()
    stubFetch(new Response('nope', { status: 500 }))
    await expect(fetchDashboardLayout()).rejects.toThrow()
  })
})
