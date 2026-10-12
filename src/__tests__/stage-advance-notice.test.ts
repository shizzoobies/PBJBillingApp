import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toggleChecklistItemRequest } from '../lib/api'
import { describeActivityAction, stageAdvanceFailedNotice } from '../lib/utils'

/**
 * Stage advance hardening, the page half: when a tick saved but the next stage
 * of its case could not be created, the toggle route answers 200 with
 * `stageAdvanceFailed` (pinned in stage-advance-hardening-route.test.ts). The
 * page keeps the tick, applies the saved checklist, and says so with the same
 * window.alert the waiting-step refusal uses in these handlers.
 */

const appSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
  'utf8',
).replaceAll('\r\n', '\n')

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('the page keeps the tick and says the next stage failed', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the request splits stageAdvanceFailed off the checklist it hands back', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 'cl-1', title: 'Close', items: [], stageAdvanceFailed: 'Connection reset' }),
    )
    const result = await toggleChecklistItemRequest('cl-1', 'it-1')
    expect(result.stageAdvanceFailed).toBe('Connection reset')
    expect(result.checklist).toEqual({ id: 'cl-1', title: 'Close', items: [] })
    expect('stageAdvanceFailed' in result.checklist).toBe(false)
  })

  it('an ordinary tick carries no failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'cl-1', title: 'Close', items: [] }))
    const result = await toggleChecklistItemRequest('cl-1', 'it-1')
    expect(result.stageAdvanceFailed).toBeNull()
    expect(result.checklist.id).toBe('cl-1')
  })

  it('the notice says it saved, why the next stage is missing, and how to retry', () => {
    const expected =
      'Saved. The next stage could not be created: Connection reset. Untick and tick this step again, or tell Alex.'
    expect(stageAdvanceFailedNotice('Connection reset.')).toBe(expected)
    expect(stageAdvanceFailedNotice('Connection reset')).toBe(expected)
  })

  it('every tick handler applies the saved checklist, then shows the notice', () => {
    const handlers = [
      'const toggleChecklistItem = async',
      'const toggleSubItem = async',
      'const toggleSubSubItem = async',
    ]
    for (const handler of handlers) {
      const start = appSource.indexOf(handler)
      expect(start, handler).toBeGreaterThan(-1)
      const body = appSource.slice(start, appSource.indexOf('} catch (error) {', start))
      const applied = body.indexOf('applyServerDataUpdate(')
      const notice = body.indexOf(
        'if (stageAdvanceFailed) window.alert(stageAdvanceFailedNotice(stageAdvanceFailed))',
      )
      expect(applied, handler).toBeGreaterThan(-1)
      expect(notice, handler).toBeGreaterThan(applied)
      expect(body, handler).toContain("setDataSyncState('synced')")
    }
  })

  it('the Activity feed has words for both new entries', () => {
    expect(describeActivityAction('case_advance_failed')).toBe('could not advance case')
    expect(describeActivityAction('case_advance_skipped')).toBe('did not advance case')
  })
})
