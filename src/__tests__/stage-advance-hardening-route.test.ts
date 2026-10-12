import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Stage advance hardening (Bright Tower 2026-10-01, XAct 2026-10-05): the last
 * step of a staged checklist was ticked, the next stage was never created, and
 * nothing said so. The store now answers `spawnError` / `spawnReason` instead of
 * throwing after the tick committed (pinned on both backends in
 * db/store-staleness.test.mjs). This file pins the glue: the route records the
 * tick first, then the failed / skipped advance, and answers 200 with
 * `stageAdvanceFailed`; the page keeps the tick and says so.
 *
 * `server.js` exports nothing and is not booted by tests, so the route is read
 * as source, like waiting-blocks-checkoff-route.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n')
const serverSource = read('server.js')
const storeSource = read('db/store.js')

/** The toggle route from its store call through its 200 answer. */
function toggleRouteTail(): string {
  const start = serverSource.indexOf('toggleResult = await appDataStore.toggleChecklistItem(')
  expect(start).toBeGreaterThan(-1)
  const send = serverSource.indexOf('sendJson(response, 200,', start)
  expect(send).toBeGreaterThan(start)
  return serverSource.slice(start, serverSource.indexOf('\n', send) + 1)
}

describe('POST /api/checklists/:id/items/:itemId/toggle when the next stage cannot be created', () => {
  it('records the tick first, then case_advance_failed', () => {
    const tail = toggleRouteTail()
    const tick = tail.indexOf("const action = toggledItem?.done ? 'checklist_item_checked' : 'checklist_item_unchecked'")
    const tickRecorded = tail.indexOf('await appDataStore.recordActivity(\n        session.user.id,\n        action,', tick)
    const failed = tail.indexOf("'case_advance_failed'")
    expect(tick).toBeGreaterThan(-1)
    expect(tickRecorded).toBeGreaterThan(tick)
    expect(failed).toBeGreaterThan(tickRecorded)
    expect(tail).toContain('const stageAdvanceFailed = toggleResult.spawnError || null')
  })

  it('names the checklist, the case and the two stages, then the message', () => {
    const tail = toggleRouteTail()
    const at = tail.indexOf("'case_advance_failed'")
    expect(tail.slice(at - 600, at + 300)).toContain(
      '`${updatedChecklist.title} · case ${caseId} · stage ${fromIdx} -> stage ${fromIdx + 1}`',
    )
    expect(tail.slice(at, at + 300)).toContain('`${where}: ${stageAdvanceFailed}`')
  })

  it('records case_advance_skipped only for the reasons that should have advanced', () => {
    const tail = toggleRouteTail()
    expect(tail).toContain(
      "const SHOULD_HAVE_ADVANCED = ['no_template', 'template_not_found', 'no_stages', 'next_stage_empty']",
    )
    const at = tail.indexOf("'case_advance_skipped'")
    expect(at).toBeGreaterThan(tail.indexOf("'case_advance_failed'"))
    expect(tail.slice(at, at + 300)).toContain('`${where}: ${toggleResult.spawnReason}`')
  })

  it('answers 200 with the checklist and stageAdvanceFailed - never a 500 for a saved tick', () => {
    const tail = toggleRouteTail()
    expect(tail).toContain(
      'sendJson(response, 200, stageAdvanceFailed ? { ...updatedChecklist, stageAdvanceFailed } : updatedChecklist)',
    )
  })

  it('still logs case_advanced and notifies only when a stage was actually spawned', () => {
    const tail = toggleRouteTail()
    const gate = tail.indexOf('if (toggleResult.spawned) {')
    expect(gate).toBeGreaterThan(-1)
    expect(tail.indexOf("'case_advanced'", gate)).toBeGreaterThan(gate)
  })

  it('the store catches a spawn that throws AFTER the Postgres tick committed', () => {
    const start = storeSource.indexOf('async toggleChecklistItem(')
    const end = storeSource.indexOf('async maybeSpawnNextStage(', start)
    const method = storeSource.slice(start, end)
    const commit = method.indexOf("await client.query('commit')")
    const pgSpawn = method.indexOf('await this.maybeSpawnNextStage(data, updated)')
    expect(commit).toBeGreaterThan(-1)
    expect(pgSpawn).toBeGreaterThan(commit)
    const pgCatch = method.indexOf('spawnError = stageAdvanceFailure(updated, error)', pgSpawn)
    expect(pgCatch).toBeGreaterThan(pgSpawn)
    // File backend: same answer, inside the queue slot, before the one write.
    const fileSpawn = method.indexOf('await this.maybeSpawnNextStage(data, updatedChecklist, { fileMode: true })')
    const fileCatch = method.indexOf('spawnError = stageAdvanceFailure(updatedChecklist, error)', fileSpawn)
    const fileWrite = method.indexOf('await fsWriteFile(localDataPath', fileSpawn)
    expect(fileSpawn).toBeGreaterThan(pgCatch)
    expect(fileCatch).toBeGreaterThan(fileSpawn)
    expect(fileWrite).toBeGreaterThan(fileCatch)
  })
})

