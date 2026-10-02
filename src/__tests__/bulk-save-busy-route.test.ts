import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientHasHistoryApiError, StaleWorkspaceApiError, saveAppData } from '../lib/api'
import { ApiError, type AppData } from '../lib/types'

/**
 * The glue for "a change saved during a whole-workspace save is never lost"
 * (tracker featreq-6a5c6162). The save now waits for its table locks and gives
 * up (WorkspaceBusyError) after three tries; the decisions live in
 * db/store-staleness.test.mjs. `server.js` listens at module scope, so these
 * read the route source - they prove wiring, and a failure means "the routing
 * moved, go look" - and the tab's half runs for real against a stubbed fetch.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(path.resolve(here, '../../server.js'), 'utf8')
const appSource = readFileSync(path.resolve(here, '../App.tsx'), 'utf8')

const BUSY_MESSAGE =
  'The workspace is busy saving another change. Your changes are kept and will be saved again in a moment.'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PUT /api/app-data answers a busy workspace with a 503', () => {
  const at = serverSource.indexOf('if (error instanceof WorkspaceBusyError) {')
  const branch = serverSource.slice(at, serverSource.indexOf('return', at) + 10)

  it('maps WorkspaceBusyError to 503 workspace_busy with the keep-your-edits sentence', () => {
    expect(at).toBeGreaterThan(-1)
    expect(branch).toContain("sendJson(response, 503, {")
    expect(branch).toContain("error: 'workspace_busy'")
    expect(branch).toContain(BUSY_MESSAGE)
  })

  it('is not the stale-tab refusal and not the generic 500, and sits before the generic 500', () => {
    expect(branch).not.toContain('stale_workspace')
    const generic = serverSource.indexOf("error: 'bulk_save_failed'", at)
    expect(generic).toBeGreaterThan(at)
    const history = serverSource.indexOf('if (error instanceof ClientHasHistoryError) {')
    expect(at).toBeGreaterThan(history)
  })

  it('is mapped in the outer catch too, for the store callers that have no catch of their own', () => {
    const outer = serverSource.lastIndexOf('if (error instanceof WorkspaceBusyError) {')
    expect(outer).toBeGreaterThan(at)
    const tail = serverSource.slice(outer, outer + 400)
    expect(tail).toContain("sendJson(response, 503, { error: 'workspace_busy', message: error.message })")
    expect(outer).toBeLessThan(serverSource.indexOf("sendJson(response, 500, { error: 'Server error' })", outer))
  })
})

describe('the tab keeps its edits on a 503 from the save', () => {
  it('saveAppData throws a plain ApiError(503), not the stale-tab or client-history refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'workspace_busy', message: BUSY_MESSAGE }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    const error = await saveAppData({} as AppData).catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(503)
    expect(error).not.toBeInstanceOf(StaleWorkspaceApiError)
    expect(error).not.toBeInstanceOf(ClientHasHistoryApiError)
  })

  it('saveNow leaves the workspace dirty and retries on a timer for any other error (no latch)', () => {
    const saveNowAt = appSource.indexOf('const saveNow = useCallback')
    const generic = appSource.indexOf('// Leave dirtyRef set so the retry effect', saveNowAt)
    const tail = appSource.slice(generic, generic + 300)
    expect(generic).toBeGreaterThan(saveNowAt)
    expect(tail).toContain("setDataSyncState('error')")
    // The sticky-error effect retries a failed save every few seconds.
    const retryAt = appSource.indexOf("if (dataSyncState !== 'error' || !serverPersistenceEnabled) {")
    expect(retryAt).toBeGreaterThan(-1)
    expect(appSource.slice(retryAt, retryAt + 400)).toContain('void saveNow()')
    // A 5xx is not a "clean rejection": the 4xx list does not include 503.
    const rejection = appSource.indexOf('function isCleanRejection')
    expect(appSource.slice(rejection, rejection + 200)).not.toContain('503')
  })
})
