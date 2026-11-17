import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * My Week routes (featreq-f0e8046b). The routes are not booted by the tests,
 * so the glue that decides WHOSE plan is read and written is pinned by reading
 * the source, the way the other route tests here do. The rules themselves
 * (what a save may carry, what the page shows) are in lib/week-plan.test.mjs,
 * and what is stored is in db/store-staleness.test.mjs.
 *
 * The risk these guard: "The plan is a person's own notes about their own
 * week. Staff must not read another person's; the owner may read all.
 * Enforced on the server, never by hiding a control."
 */

const server = readFileSync(resolve('server.js'), 'utf8').split('\r\n').join('\n')

const slice = (startMark: string, endMark: string) => {
  const start = server.indexOf(startMark)
  const end = server.indexOf(endMark, start + startMark.length)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return server.slice(start, end)
}

describe('GET /api/week-plan', () => {
  const route = slice(
    "if (normalizedPath === '/api/week-plan' && request.method === 'GET') {",
    'const weekPlanOldSaveMatch = normalizedPath.match(',
  )

  it('needs a session, and answers as the previewed person while previewing', () => {
    expect(route).toContain('const session = await requireSession(request, response)')
    expect(route).toContain('const scoped = await previewScopedSession(request, session, response)')
    expect(route).toContain('if (!scoped) return')
    // Preview reads must be on the allowlist or the page 403s in preview.
    expect(server).toMatch(/const PREVIEW_AWARE_API_PATHS = new Set\(\[[\s\S]*?'\/api\/week-plan',[\s\S]*?\]\)/)
  })

  it('reads the asker’s own week unless an OWNER names someone else', () => {
    expect(route).toContain('let userId = scoped.user.id')
    const guard = route.slice(route.indexOf('if (asked && asked !== scoped.user.id) {'))
    expect(guard.indexOf("if (scoped.user.role !== 'owner') {")).toBeGreaterThan(0)
    expect(guard).toContain("sendJson(response, 403, { error: 'You can only see your own week.' })")
    // The role check comes before the id is ever used.
    expect(guard.indexOf("scoped.user.role !== 'owner'")).toBeLessThan(guard.indexOf('userId = asked'))
    // And the role is the SCOPED one, so an owner previewing a team member is
    // held to what that team member may see.
    expect(route).not.toContain("session.user.role !== 'owner'")
  })

  it('refuses a week that is not a Monday before reading anything', () => {
    expect(route).toContain('if (!isMonday(weekStart)) {')
    expect(route.indexOf('if (!isMonday(weekStart)) {')).toBeLessThan(
      route.indexOf('appDataStore.listWeekPlanEntries('),
    )
  })

  it('reads only through the store method, scoped to one person and one week', () => {
    expect(route).toContain('await appDataStore.listWeekPlanEntries({ userId, weekStart })')
    // It says it keeps days on each task; the page will not use a week answered without that.
    expect(route).toContain('sendJson(response, 200, { weekStart, userId, entries, daysPerTask: true })')
    expect(route.split('appDataStore.').length - 1).toBe(2) // getTeamMember (owner asking) + the list
  })
})

/**
 * Where the first version of the page saved (days on the client). A page left
 * open from before the days moved onto each task misreads the new rows and
 * would write the client's days back over her per-task ones.
 */
describe('PUT /api/week-plan/:clientId (the first version’s address)', () => {
  const route = slice(
    'const weekPlanOldSaveMatch = normalizedPath.match(',
    'const weekPlanSaveMatch = normalizedPath.match(',
  )

  it('matches only the address without /tasks', () => {
    expect(route).toContain('normalizedPath.match(/^\\/api\\/week-plan\\/([^/]+)$/)')
  })

  it('tells the page to reload (409) and neither reads nor writes anything', () => {
    expect(route).toContain('const session = await requireSession(request, response)')
    expect(route).toContain('sendJson(response, 409, { error: WEEK_PLAN_RELOAD_MESSAGE })')
    expect(route).not.toContain('appDataStore.')
    expect(route).not.toContain('readJsonBody')
  })

  it('the words say what to do', async () => {
    const { WEEK_PLAN_RELOAD_MESSAGE } = await import('../../lib/week-plan.js')
    expect(WEEK_PLAN_RELOAD_MESSAGE).toBe('My Week has changed. Reload the page, then make the change again.')
  })
})

describe('PUT /api/week-plan/:clientId/tasks', () => {
  const route = slice(
    'const weekPlanSaveMatch = normalizedPath.match(',
    "if (normalizedPath === '/api/waiting-on-me' && request.method === 'GET') {",
  )

  // Its own address: the first version of the server has no such route, so a
  // save from this page cannot be half-understood there during a hand-over.
  it('has its own address, checked after the first version’s', () => {
    expect(route).toContain('normalizedPath.match(/^\\/api\\/week-plan\\/([^/]+)\\/tasks$/)')
    expect(server.indexOf('const weekPlanOldSaveMatch')).toBeLessThan(server.indexOf('const weekPlanSaveMatch'))
    // The first version's pattern cannot swallow it: it allows no further slash.
    expect('/api/week-plan/client-1/tasks').not.toMatch(/^\/api\/week-plan\/([^/]+)$/)
    expect('/api/week-plan/client-1/tasks').toMatch(/^\/api\/week-plan\/([^/]+)\/tasks$/)
  })

  it('always writes the signed-in person’s own plan: no user can be named', () => {
    expect(route).toContain('userId: session.user.id,')
    expect(route).not.toContain("searchParams.get('user')")
    expect(route).not.toContain('payload.user')
    expect(route).not.toContain('payload?.user')
  })

  it('is a PUT from this site only', () => {
    expect(route).toContain("if (request.method !== 'PUT') {")
    expect(route).toContain('if (isCrossSiteOrigin(request)) {')
    expect(route.indexOf('isCrossSiteOrigin(request)')).toBeLessThan(route.indexOf('saveWeekPlanEntry('))
  })

  it('a client she cannot see is "not found", checked before anything is saved', () => {
    expect(route).toContain('if (!visibleClientIdSet(session, data).has(clientId)) {')
    expect(route).toContain("sendJson(response, 404, { error: 'Client not found' })")
    expect(route.indexOf('visibleClientIdSet(session, data)')).toBeLessThan(route.indexOf('saveWeekPlanEntry('))
  })

  it('checks the row with the shared rule, against THIS client’s checklists only', () => {
    expect(route).toContain('const checked = normalizeWeekPlanInput(payload, {')
    expect(route).toContain('.filter((checklist) => checklist.clientId === clientId)')
    expect(route).toContain('if (!checked.ok) {')
    expect(route).toContain('sendJson(response, 400, { error: checked.error })')
    // What is saved is what the rule handed back, never the raw body.
    expect(route).toContain('...checked.value,')
    expect(route).not.toContain('...payload')
  })

  it('writes are refused while previewing, before any route runs', () => {
    const guard = server.indexOf("sendJson(response, 403, { error: 'Preview mode is read-only' })")
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(server.indexOf('const weekPlanOldSaveMatch = normalizedPath.match('))
  })
})
