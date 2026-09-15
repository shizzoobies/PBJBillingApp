import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPreviewUnsupportedError, previewScopedSession } from '../../lib/preview-scope.js'
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')
const scopeSource = readFileSync(path.join(repoRoot, 'lib/preview-scope.js'), 'utf8')

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
    expect(block).toContain('await previewScopedSession(request, session, response')
    expect(block).toContain('listWaitingOnMe(scoped.user.id)')
  })

  it('the notification list is the previewed person’s mail', () => {
    const block = routeBlock(/normalizedPath === '\/api\/notifications' &&/)
    expect(block).toContain('await previewScopedSession(request, session, response')
    expect(block).toContain('listNotifications(scoped.user.id')
  })

  it('the unread badge counts the previewed person’s mail', () => {
    const block = routeBlock(/normalizedPath === '\/api\/notifications\/unread-count'/)
    expect(block).toContain('await previewScopedSession(request, session, response')
    expect(block).toContain('unreadNotificationCount(scoped.user.id)')
  })

  it('item-deletion requests narrow the firm-wide owner branch', () => {
    const block = routeBlock(/normalizedPath === '\/api\/checklists\/item-deletions' &&/)
    expect(block).toContain('await previewScopedSession(request, session, response')
    // Both the owner short-circuit AND the fallback filter read the scoped
    // session; leaving either on `session` re-opens the hole.
    expect(block).toContain("scoped.user.role === 'owner'")
    expect(block).toContain('visibleClientIdSet(scoped, data)')
  })

  it('the pending-edit queue is asked as the previewed person', () => {
    const block = routeBlock(/normalizedPath === '\/api\/checklists\/pending-edits' &&/)
    expect(block).toContain('await previewScopedSession(request, session, response')
    expect(block).toContain('listPendingTaskEdits(scoped)')
  })

  // The five routes above resolved the identity from `getTeamMember` alone.
  // On the JSON-file backend that store and the workspace's `employees` are
  // separate, so an id `/api/app-data` resolves could be refused on the very
  // next request. Every call site hands over the workspace now.
  it('one roster answers every route, and the fallback that guarantees it is lazy', () => {
    const marker = 'previewScopedSession(request, session, response'
    let sites = 0
    for (let at = serverSource.indexOf(marker); at > -1; at = serverSource.indexOf(marker, at + 1)) {
      sites += 1
    }
    // Ten call sites plus the wrapper's own signature.
    expect(sites).toBeGreaterThanOrEqual(11)

    // The wrapper falls back to the workspace roster itself, so a route that
    // does not hold the workspace still resolves the ids `/api/app-data` does
    // — the file backend keeps users and workspace employees apart. The read
    // sits INSIDE the miss branch: the notification badge polls every sixty
    // seconds and must not materialize the workspace to answer a count.
    const wrapper = routeBlock(
      /async function previewScopedSession\(request, session, response/,
      1000,
    )
    expect(wrapper).toMatch(/if \(member\) return member/)
    expect(wrapper).toMatch(/const workspace = data \?\? \(await appDataStore\.read\(\)\)/)
  })

  it('a case and a client’s notes answer by what the PREVIEWED person may see', () => {
    const caseBlock = routeBlock(/const caseDetailMatch = normalizedPath\.match/, 2000)
    expect(caseBlock).toContain('await previewScopedSession(request, session, response')
    expect(caseBlock).toContain('visibleClientIdSet(scoped, allData)')
    expect(caseBlock).toMatch(/scopeActivityEntriesForSession\(\s*scoped,/)
    expect(caseBlock).not.toContain('visibleClientIdSet(session,')

    const notesBlock = routeBlock(/const clientNotesMatch = normalizedPath\.match/, 1200)
    expect(notesBlock).toContain('await previewScopedSession(request, session, response')
    expect(notesBlock).toContain('visibleClientIdSet(scoped, data)')
  })

  it('the team activity log is gated on the PREVIEWED role, so a staffer preview 403s', () => {
    const block = routeBlock(/const teamActivityMatch = normalizedPath\.match/, 1200)
    expect(block).toContain('await previewScopedSession(request, session, response')
    expect(block).toContain("scoped.user.role !== 'owner'")
    expect(block).not.toContain("session.user.role !== 'owner'")
  })

  it('entering a preview is written to the activity log once, against the real owner', () => {
    const block = routeBlock(/normalizedPath === '\/api\/app-data'/, 2400)
    expect(block).toContain("'preview_started'")
    // The REAL owner is who the entry names — preview never rewrites authorship.
    expect(block).toMatch(/recordActivity\(\s*session\.user\.id,\s*'preview_started'/)
  })
})

describe('one resolution rule', () => {
  it('/api/app-data resolves through the shared helper, not its own copy', () => {
    const block = routeBlock(/normalizedPath === '\/api\/app-data'/, 2400)
    expect(block).toContain('await previewScopedSession(request, session, response, {')
    expect(block).toContain("previewAs: requestUrl.searchParams.get('previewAs')")
    // The old inline lookup — the thing that made preview a one-route feature.
    expect(block).not.toContain('(data.employees ?? []).find(')
  })

  it('the owner/employee mapping lives in lib/preview-scope.js, once, and not in the server', () => {
    expect(serverSource).not.toContain('String(target.role).toLowerCase()')
    expect(scopeSource.split('String(target.role).toLowerCase()').length - 1).toBe(1)
  })

  it('the server half only turns the refusal into a 403 and returns null', () => {
    const helper = routeBlock(/async function previewScopedSession\(request, session, response/, 1200)
    expect(helper).toContain('isPreviewUnsupportedError(error)')
    expect(helper).toContain("sendJson(response, 403, { error: 'preview_unsupported' })")
    expect(helper).toContain('return null')
  })
})

/**
 * The BEHAVIOR half. Everything above reads route source because `server.js`
 * listens at module scope and exports nothing; the resolution rule itself is
 * in `lib/preview-scope.js` precisely so it can be run.
 */
describe('previewScopedSession resolves — or refuses', () => {
  const owner = { user: { id: 'emp-patrice', role: 'owner', name: 'Brittany' } }
  const staffer = { id: 'emp-a41095f0', role: 'employee', name: 'Lisa' }
  const roster = [staffer, { id: 'emp-alex-anderson', role: 'Owner', name: 'Alex' }]
  const lookups = {
    getTeamMember: async (id: string) => roster.find((member) => member.id === id) ?? null,
  }
  const withHeader = (value: string) => ({ headers: { 'x-preview-as': value } })

  it('leaves a NON-owner alone, header or not — it can only ever narrow', async () => {
    const lisa = { user: { id: 'emp-a41095f0', role: 'employee' } }
    const scoped = await previewScopedSession(withHeader('emp-patrice'), lisa, lookups)
    expect(scoped).toBe(lisa)
  })

  it('scopes an owner to a known staffer: their id, and the employee role', async () => {
    const scoped = await previewScopedSession(withHeader(staffer.id), owner, lookups)
    expect(scoped.user.id).toBe(staffer.id)
    expect(scoped.user.role).toBe('employee')
  })

  it('an owner previewing another OWNER stays an owner (display-cased roles map too)', async () => {
    const scoped = await previewScopedSession(withHeader('emp-alex-anderson'), owner, lookups)
    expect(scoped.user.role).toBe('owner')
  })

  it('REFUSES an id this workspace cannot resolve instead of answering as the owner', async () => {
    // The whole point of the fail-closed change: falling back returned the
    // OWNER's session, and every scoped route then served the owner's data
    // under the previewed person's name.
    await expect(previewScopedSession(withHeader('emp-nobody'), owner, lookups)).rejects.toThrow(
      /preview_unsupported/,
    )
    const error = await previewScopedSession(withHeader('emp-nobody'), owner, lookups).catch(
      (err: unknown) => err,
    )
    expect(isPreviewUnsupportedError(error)).toBe(true)
  })

  it('falls back to the workspace roster when the user store has not got them', async () => {
    const scoped = await previewScopedSession(withHeader(staffer.id), owner, {
      getTeamMember: async () => null,
      employees: [staffer],
    })
    expect(scoped.user.id).toBe(staffer.id)
  })

  it('an EMPTY header does not suppress the ?previewAs= query', async () => {
    // `??` treated '' as "an identity was sent", so `/api/app-data`'s query was
    // ignored and the owner was scoped as themselves.
    const scoped = await previewScopedSession(withHeader(''), owner, {
      ...lookups,
      previewAs: staffer.id,
    })
    expect(scoped.user.id).toBe(staffer.id)
  })

  it('no identity at all leaves the owner as the owner', async () => {
    const scoped = await previewScopedSession({ headers: {} }, owner, lookups)
    expect(scoped).toBe(owner)
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

  it('checks the session BEFORE the allowlist, so it is not an allowlist oracle', () => {
    const block = guard()
    const sessionCheck = block.indexOf('getUserSession(previewCookies[sessionCookieName])')
    const allowlistCheck = block.indexOf('!isPreviewAwareApiPath(normalizedPath)')
    expect(sessionCheck).toBeGreaterThan(-1)
    expect(allowlistCheck).toBeGreaterThan(sessionCheck)
    expect(block).toContain("sendJson(response, 401, { error: 'Authentication required' })")
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
      // Owner-only for a real staffer (403), so preview must 403 too rather
      // than hand the firm's address and EIN back inside a staffer's view.
      '/api/firm-settings',
    ]) {
      expect(allowlist).not.toContain(`'${refused}'`)
    }
    // ...but the branding half, which is the same answer for everyone, stays.
    expect(allowlist).toContain("'/api/firm-settings/public'")
  })

  it('the prefix patterns match ONE segment, so nothing deeper rides in on a parent', () => {
    const patterns = routeBlock(/const PREVIEW_AWARE_API_PATTERNS = \[/, 700)
    expect(patterns).not.toContain('[^?]*')
    expect(patterns).toContain('/^\\/api\\/auth\\/[^/?]*$/')
    expect(patterns).toContain('/^\\/api\\/me\\/[^/?]*$/')
    // The one deeper path that is allowlisted is named, not swept in.
    expect(patterns).toContain('/^\\/api\\/auth\\/totp\\/[^/?]*$/')
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
