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
    expect(route).toContain('sendJson(response, 200, { weekStart, userId, entries, daysPerTask: true, weekMoves: true })')
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

describe('PUT /api/week-plan/:clientId/week (and /row, /tasks)', () => {
  const route = slice(
    'const weekPlanSaveMatch = normalizedPath.match(',
    "if (normalizedPath === '/api/waiting-on-me' && request.method === 'GET') {",
  )

  // Two addresses, one handler. `/row` is where the page saves now: no earlier
  // server has it, so a save from this page cannot be half-understood there
  // during a hand-over. `/tasks` is kept for a page left open from before
  // "work with no task", which hands back every mark it was given.
  it('has all three addresses, checked after the first version’s', () => {
    expect(route).toContain('normalizedPath.match(/^\\/api\\/week-plan\\/([^/]+)\\/(row|tasks|week)$/)')
    expect(server.indexOf('const weekPlanOldSaveMatch')).toBeLessThan(server.indexOf('const weekPlanSaveMatch'))
    const now = /^\/api\/week-plan\/([^/]+)\/(row|tasks|week)$/
    for (const path of ['/api/week-plan/client-1/row', '/api/week-plan/client-1/tasks', '/api/week-plan/client-1/week']) {
      // The first version's pattern cannot swallow it: it allows no further slash.
      expect(path).not.toMatch(/^\/api\/week-plan\/([^/]+)$/)
      expect(path.match(now)?.[1]).toBe('client-1')
    }
    expect('/api/week-plan/client-1/rows').not.toMatch(now)
    expect('/api/week-plan/client-1/row/x').not.toMatch(now)
    expect('/api/week-plan/client-1/weeks').not.toMatch(now)
  })

  // The server that is live while this one is being handed over to (the one
  // with `/row` and `/tasks`) must have NO route for the new address: that is
  // the whole protection. It would answer 200 on `/row` and drop the flags.
  it('the address the page saves to now is one the previous server’s patterns do not match', () => {
    const previous = [
      /^\/api\/week-plan\/([^/]+)$/,
      /^\/api\/week-plan\/([^/]+)\/tasks$/,
      /^\/api\/week-plan\/([^/]+)\/(?:row|tasks)$/,
    ]
    for (const pattern of previous) expect('/api/week-plan/client-1/week').not.toMatch(pattern)
    // And what an /api/ path with no route gets here (the same on that server)
    // is the 404 the request helper turns into "being updated".
    expect(server).toContain("sendJson(response, 404, { error: 'Not found' })")
  })

  // Work with no task: any client she can see, with or without a checklist.
  // The rule lives in lib/week-plan.js; the route hands it this client's
  // checklist ids and nothing that could widen the key.
  it('lets the rules decide which marks are kept, and keeps other work for a client with no checklist', async () => {
    expect(route).toContain('const checked = normalizeWeekPlanInput(payload, {')
    expect(route).toContain('.filter((checklist) => checklist.clientId === clientId)')
    const { normalizeWeekPlanInput, WEEK_PLAN_OTHER_KEY } = await import('../../lib/week-plan.js')
    const checked = normalizeWeekPlanInput(
      { weekStart: '2026-11-16', taskMarks: { [WEEK_PLAN_OTHER_KEY]: { days: ['2026-11-18'] }, 'chk-else': { days: ['2026-11-18'] } } },
      { checklistIds: [] },
    )
    expect(checked.ok && checked.value.taskMarks).toEqual({
      [WEEK_PLAN_OTHER_KEY]: { status: null, note: '', days: ['2026-11-18'] },
    })
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
    expect(route).toContain('let row = checked.value')
    expect(route).toContain('...row,')
    expect(route).not.toContain('...payload')
  })

  // A page that does not know "brought" / "pushed" saves on `/row` or `/tasks`
  // and drops the flags when it reads a row: the server keeps the stored ones.
  it('on /row and /tasks keeps the stored week flags; only /week can change them', () => {
    const keep = route.slice(route.indexOf("if (weekPlanSaveMatch[2] !== 'week') {"))
    expect(route.indexOf("if (weekPlanSaveMatch[2] !== 'week') {")).toBeGreaterThan(0)
    expect(keep).toContain('await appDataStore.listWeekPlanEntries({')
    expect(keep).toContain('userId: session.user.id,')
    expect(keep).toContain('weekStart: checked.value.weekStart,')
    expect(keep).toContain('const stored = storedEntries.find((entry) => entry.clientId === clientId) ?? null')
    expect(keep).toContain('row = withStoredWeekFlags(checked.value, stored, { checklistIds: clientChecklistIds })')
    // Read before the write, and the write takes the merged row.
    expect(keep.indexOf('withStoredWeekFlags(')).toBeLessThan(keep.indexOf('saveWeekPlanEntry('))
    expect(server).toMatch(/import \{[^}]*withStoredWeekFlags[^}]*\} from '\.\/lib\/week-plan\.js'/)
  })

  it('writes are refused while previewing, before any route runs', () => {
    const guard = server.indexOf("sendJson(response, 403, { error: 'Preview mode is read-only' })")
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(server.indexOf('const weekPlanOldSaveMatch = normalizedPath.match('))
  })
})
