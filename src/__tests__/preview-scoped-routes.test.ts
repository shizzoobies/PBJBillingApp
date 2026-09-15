import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWaitingOnMe, setPreviewUser } from '../lib/api'

/**
 * "Preview as <staffer>" has to reach every page, not just one route.
 *
 * THE BUG. The previewed identity travelled on exactly one request —
 * `GET /api/app-data?previewAs=<id>`. The SPA's fetch wrapper sent only
 * `X-Preview-Mode: 1`, a boolean saying THAT an owner was previewing and never
 * WHO, so every surface that fetches its own endpoint answered with the
 * OWNER's scope while the banner named the staffer. Brittany reported it as
 * "Allison can still see clients that are not hers on the Invoice Recap":
 * all 37 of August's invoices, under Allison's name.
 *
 * WHAT THESE TESTS ARE. `server.js` calls `server.listen()` at module scope and
 * exports nothing, so there is no HTTP harness here (see
 * invoice-coverage-routes.test.ts for the same reasoning). The server half
 * below reads the route source and pins the WIRING: each route resolves the
 * previewed session and scopes by it, the guard refuses anything that has not
 * been taught to, and the old inline resolution in `/api/app-data` is gone.
 * They prove wiring, not behavior — a failure here means "the route changed,
 * go look". The client half is a real unit test of the fetch wrapper.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard to roughly the next one. */
function routeBlock(startPattern: RegExp, length = 1600): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

describe('every leaking route now scopes by the previewed person', () => {
  it('the Invoice Recap hands the PREVIEWED session to teamClientIdSet', () => {
    const block = routeBlock(/normalizedPath === '\/api\/invoice-recap'/)
    expect(block).toContain('await previewScopedSession(request, session')
    expect(block).toContain('teamClientIdSet(scoped, data.clients ?? [])')
    // The whole point: the real session must NOT be what gates the money.
    expect(block).not.toContain('teamClientIdSet(session,')
  })

  it('"Waiting on you" asks for the previewed person’s blockers', () => {
    const block = routeBlock(/normalizedPath === '\/api\/waiting-on-me'/)
    expect(block).toContain('await previewScopedSession(request, session)')
    expect(block).toContain('listWaitingOnMe(scoped.user.id)')
  })

  it('the notification list is the previewed person’s mail', () => {
    const block = routeBlock(/normalizedPath === '\/api\/notifications' &&/)
    expect(block).toContain('await previewScopedSession(request, session)')
    expect(block).toContain('listNotifications(scoped.user.id')
  })

  it('the unread badge counts the previewed person’s mail', () => {
    const block = routeBlock(/normalizedPath === '\/api\/notifications\/unread-count'/)
    expect(block).toContain('await previewScopedSession(request, session)')
    expect(block).toContain('unreadNotificationCount(scoped.user.id)')
  })

  it('item-deletion requests narrow the firm-wide owner branch', () => {
    const block = routeBlock(/normalizedPath === '\/api\/checklists\/item-deletions' &&/)
    expect(block).toContain('await previewScopedSession(request, session)')
    // Both the owner short-circuit AND the fallback filter read the scoped
    // session; leaving either on `session` re-opens the hole.
    expect(block).toContain("scoped.user.role === 'owner'")
    expect(block).toContain('visibleClientIdSet(scoped, data)')
  })

  it('the pending-edit queue is asked as the previewed person', () => {
    const block = routeBlock(/normalizedPath === '\/api\/checklists\/pending-edits' &&/)
    expect(block).toContain('await previewScopedSession(request, session)')
    expect(block).toContain('listPendingTaskEdits(scoped)')
  })
})

describe('one resolution rule', () => {
  it('/api/app-data resolves through the shared helper, not its own copy', () => {
    const block = routeBlock(/normalizedPath === '\/api\/app-data'/, 2400)
    expect(block).toContain('await previewScopedSession(request, session, {')
    expect(block).toContain("previewAs: requestUrl.searchParams.get('previewAs')")
    // The old inline lookup — the thing that made preview a one-route feature.
    expect(block).not.toContain('(data.employees ?? []).find(')
  })

  it('the owner/employee mapping exists exactly once in the server', () => {
    const occurrences = serverSource.split('String(target.role).toLowerCase()').length - 1
    expect(occurrences).toBe(1)
  })

  it('the helper only ever narrows: non-owners and unknown ids fall through', () => {
    const helper = routeBlock(/async function previewScopedSession\(/, 1600)
    expect(helper).toContain("if (session?.user?.role !== 'owner')")
    expect(helper).toContain('if (!target) {')
  })
})

describe('the guard fails closed', () => {
  const guard = () => routeBlock(/const method = request\.method \|\| 'GET'/, 1800)

  it('refuses an /api/ read carrying X-Preview-As that no route honors', () => {
    const block = guard()
    expect(block).toContain("request.headers['x-preview-as']")
    expect(block).toContain("normalizedPath.startsWith('/api/')")
    expect(block).toContain('!isPreviewAwareApiPath(normalizedPath)')
    expect(block).toMatch(/sendJson\(response, 403, \{ error: 'preview_unsupported' \}\)/)
  })

  it('keeps preview read-only even if only the identity header is sent', () => {
    expect(guard()).toContain(
      "(request.headers['x-preview-mode'] === '1' || request.headers['x-preview-as'])",
    )
  })

  it('allows the preview-aware routes and nothing else that answers firm-wide', () => {
    const allowlist = routeBlock(/const PREVIEW_AWARE_API_PATHS = new Set\(\[/, 900)
    for (const allowed of [
      '/api/app-data',
      '/api/invoice-recap',
      '/api/waiting-on-me',
      '/api/notifications',
      '/api/notifications/unread-count',
      '/api/checklists/item-deletions',
      '/api/checklists/pending-edits',
    ]) {
      expect(allowlist).toContain(`'${allowed}'`)
    }
    for (const refused of [
      '/api/invoices',
      '/api/client-recap',
      '/api/checklists/skips',
      '/api/feature-requests',
    ]) {
      expect(allowlist).not.toContain(`'${refused}'`)
    }
  })
})

describe('the client sends WHO, not just THAT', () => {
  afterEach(() => {
    setPreviewUser(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubFetch() {
    const handler = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', handler)
    return handler
  }

  /** The (input, init) pair `apiFetch` actually handed to `fetch`. */
  const initOf = (handler: { mock: { calls: unknown[][] } }) =>
    handler.mock.calls[0]?.[1] as RequestInit | undefined

  it('sends both preview headers while a preview user is set', async () => {
    const handler = stubFetch()
    setPreviewUser('emp-41def8a0')

    await fetchWaitingOnMe()

    const headers = new Headers(initOf(handler)?.headers)
    expect(headers.get('X-Preview-Mode')).toBe('1')
    expect(headers.get('X-Preview-As')).toBe('emp-41def8a0')
  })

  it('sends neither once preview is exited', async () => {
    const handler = stubFetch()
    setPreviewUser('emp-41def8a0')
    setPreviewUser(null)

    await fetchWaitingOnMe()

    const headers = new Headers(initOf(handler)?.headers)
    expect(headers.get('X-Preview-Mode')).toBeNull()
    expect(headers.get('X-Preview-As')).toBeNull()
  })
})
