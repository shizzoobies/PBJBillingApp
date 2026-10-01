import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveAppData } from '../lib/api'
import type { AppData } from '../lib/types'

/**
 * `PUT /api/app-data` answers `{ ok: true, refetch: true }` when its attach pass
 * changed the workspace beyond what the tab sent (a pending note attached to a
 * checklist). The save resolves that so the tab can ask for its ordinary
 * live-sync refetch the moment it is clean - no new refetch machinery.
 */

const jsonResponse = (body: unknown, version = 'v2') =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Version': version },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saveAppData', () => {
  it('reports refetch when the server says its attach pass changed the workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, refetch: true })))
    await expect(saveAppData({} as AppData)).resolves.toEqual({ refetch: true })
  })

  it('reports no refetch for an ordinary save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    await expect(saveAppData({} as AppData)).resolves.toEqual({ refetch: false })
  })

  it('treats an empty or non-JSON body as nothing to refetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(saveAppData({} as AppData)).resolves.toEqual({ refetch: false })
  })
})

describe('App wiring', () => {
  const appSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
    'utf8',
  )

  it('hands the live-sync scheduler to the save loop, so a refetch rides the deferred-refetch machinery', () => {
    // The SSE effect's own `schedule` (-> attempt -> shouldDeferRefetch -> refetch).
    expect(appSource).toContain('requestLiveRefetchRef.current = schedule')
    const saveAt = appSource.indexOf('saveResult = await saveAppData(dataRef.current)')
    const requestAt = appSource.indexOf('if (saveResult?.refetch) requestLiveRefetchRef.current?.()')
    expect(saveAt).toBeGreaterThan(-1)
    // After the clean/synced bookkeeping, so `attempt` sees the tab as clean.
    const cleanAt = appSource.indexOf("setDataSyncState('synced')", saveAt)
    expect(requestAt).toBeGreaterThan(cleanAt)
  })
})
