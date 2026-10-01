import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `DELETE /api/checklists/:id/items/:itemId?scope=series` (featreq-01464e64) and
 * the owner's approval of a team member's "This + all future" request
 * (featreq-01464e64 rework).
 *
 * Same shape as waiting-lock-routes.test.ts: `server.js` exports nothing, so
 * the DECISIONS (label match, later-only, open-only, one transaction; the
 * denial, the shared delete, the duplicate rule) are tested against the real
 * store in db/store-staleness.test.mjs, and this reads the route source to pin
 * the glue that could rot unnoticed: who may file or delete, the origin check,
 * the order of the checks, the stops that leave a request pending, and the
 * activity + broadcast that every other tab depends on.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8')
const appSource = readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
const seriesLibSource = readFileSync(path.join(root, 'lib/series-step-delete.js'), 'utf8')

function seriesBlock(): string {
  const at = serverSource.indexOf("requestUrl.searchParams.get('scope') === 'series'")
  expect(at, 'series branch not found').toBeGreaterThan(-1)
  return serverSource.slice(at, at + 2600)
}

/** The approve branch for a "This + all future" request, up to the waiting-step guard. */
function approveSeriesBlock(): string {
  const at = serverSource.indexOf("if (req.scope === 'series') {")
  expect(at, 'approve branch not found').toBeGreaterThan(-1)
  const end = serverSource.indexOf('A removal that would roll a WAITING step', at)
  expect(end, 'waiting-step guard not found').toBeGreaterThan(at)
  return serverSource.slice(at, end)
}

function fileRequestBlock(): string {
  const at = serverSource.indexOf('async function fileItemDeletionRequest(')
  expect(at, 'fileItemDeletionRequest not found').toBeGreaterThan(-1)
  return serverSource.slice(at, at + 2600)
}

describe('the series delete route', () => {
  it('runs after the shared write gate, so only someone who may edit this step gets as far as filing', () => {
    const at = serverSource.indexOf("requestUrl.searchParams.get('scope') === 'series'")
    const denial = serverSource.lastIndexOf("error: 'You do not have permission to delete this item'", at)
    expect(denial).toBeGreaterThan(-1)
    expect(denial).toBeLessThan(at)
  })

  it('no longer refuses a non-owner with a 403: it files a series-scoped request instead', () => {
    const block = seriesBlock()
    expect(block).not.toContain('Only owners can remove a step from the recurring checklist')
    const gate = block.indexOf("session.user.role !== 'owner'")
    expect(gate).toBeGreaterThan(-1)
    const filing = block.indexOf('fileItemDeletionRequest(request, session, data, checklist', gate)
    expect(filing).toBeGreaterThan(gate)
    expect(block.slice(filing, filing + 300)).toContain("scope: 'series'")
    // Answers exactly like the existing staff branch.
    expect(block.slice(filing, filing + 400)).toContain('sendJson(response, 200, { request: filed, checklist })')
  })

  it('checks the origin and the denial (recurring, own template) before it files OR deletes', () => {
    const block = seriesBlock()
    const origin = block.indexOf('isCrossSiteOrigin(request)')
    const denial = block.indexOf('seriesDeleteDenial(checklist, data.checklistTemplates)')
    const filing = block.indexOf('fileItemDeletionRequest(')
    const owner = block.indexOf('runSeriesStepDelete(')
    expect(origin).toBeGreaterThan(-1)
    expect(origin).toBeLessThan(denial)
    expect(denial).toBeLessThan(filing)
    expect(filing).toBeLessThan(owner)
    expect(block.slice(denial, denial + 260)).toContain('sendJson(response, seriesDenial.status, { error: seriesDenial.error })')
  })

  it('has ONE series delete, shared by the owner route and the approval', () => {
    expect(serverSource).toContain("from './lib/series-step-delete.js'")
    expect(serverSource).not.toContain('appDataStore.deleteChecklistItemFromSeries(')
    expect(serverSource.split('runSeriesStepDelete({').length - 1).toBe(2)
    expect(serverSource.split('seriesDeleteDenial(').length - 1).toBe(2)
    const block = seriesBlock()
    expect(block).toContain('store: appDataStore')
    expect(block).toContain('actorId: session.user.id')
    expect(block).toContain('broadcast: broadcastDataChanged')
    expect(block).toContain('sendJson(response, removal.status, removal.body)')
  })
})

describe('the shared series delete', () => {
  it('answers the last recurring step with a 409 and writes nothing after it', () => {
    const store = seriesLibSource.indexOf('store.deleteChecklistItemFromSeries(')
    const refusal = seriesLibSource.indexOf("'refusal' in removal")
    expect(store).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(store)
    expect(seriesLibSource.slice(refusal, refusal + 260)).toContain(
      'status: 409, body: { error: removal.refusal, message: LAST_RECURRING_STEP_MESSAGE }',
    )
    // The refusal returns before the activity is logged and the other tabs are told.
    expect(refusal).toBeLessThan(seriesLibSource.indexOf("'checklist_item_removed_series'"))
    expect(refusal).toBeLessThan(seriesLibSource.indexOf('broadcast()'))
  })

  it('writes through the store, logs the activity and tells the other tabs, in that order', () => {
    const store = seriesLibSource.indexOf('store.deleteChecklistItemFromSeries(')
    const activity = seriesLibSource.indexOf("'checklist_item_removed_series'")
    const broadcast = seriesLibSource.indexOf('broadcast()')
    expect(activity).toBeGreaterThan(store)
    expect(broadcast).toBeGreaterThan(activity)
  })

  it('hands back the changed checklists and the template so the tab can merge them', () => {
    expect(seriesLibSource).toContain('...removal')
    expect(seriesLibSource).toContain('checklists: fresh.checklists.filter')
    expect(seriesLibSource).toContain('template: fresh.checklistTemplates.find')
  })
})

describe('a team member\'s request (fileItemDeletionRequest)', () => {
  it('reuses a pending request for the same step before creating one, and passes the scope', () => {
    const block = fileRequestBlock()
    expect(block).toContain("scope === 'series' ? 'series' : 'checklist'")
    const reuse = block.indexOf('reuseDuplicateDeletionRequest(')
    const create = block.indexOf('appDataStore.createItemDeletionRequest({')
    expect(reuse).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(reuse)
    expect(block.slice(create, create + 400)).toContain('scope: requestScope')
  })

  it('tells the owner which one it is, in the activity and in the notification', () => {
    const block = fileRequestBlock()
    expect(block).toContain("' (this checklist and all future ones)'")
    expect(block).toContain(
      '`${requesterName} requested deletion of "${label}" in "${checklist.title}" - this checklist and all future ones.`',
    )
    // The one-checklist wording is unchanged.
    expect(block).toContain('`${requesterName} requested deletion of "${label}" in "${checklist.title}".`')
  })

  it('files sub-steps and sub-sub-steps without a scope, so they stay "this checklist only"', () => {
    const calls = serverSource.split('fileItemDeletionRequest(request, session, data, checklist, {')
    // [0] is before the first call; each later piece starts at one call's argument object.
    const withScope = calls.slice(1).filter((piece) => piece.slice(0, 400).includes("scope: 'series'"))
    expect(withScope).toHaveLength(1)
  })
})

describe('approving a "This + all future" request', () => {
  it('is owner-only, like every decision, and checked before it runs anything', () => {
    const gate = serverSource.indexOf("'Only owners can resolve deletion requests'")
    const at = serverSource.indexOf("if (req.scope === 'series') {")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(at)
    // Reject returns before the approve branch: reject is unchanged.
    const reject = serverSource.indexOf("if (decision === 'reject') {")
    expect(reject).toBeGreaterThan(-1)
    expect(reject).toBeLessThan(at)
  })

  it('answers 404 and drops the request when the checklist or step is already gone', () => {
    const block = approveSeriesBlock()
    const gone = block.indexOf('!seriesChecklist || !seriesStep')
    expect(gone).toBeGreaterThan(-1)
    expect(block.slice(gone, gone + 280)).toMatch(
      /deleteItemDeletionRequest\(requestId\)[\s\S]*sendJson\(response, 404, \{ error: 'Target item no longer exists' \}\)/,
    )
  })

  it('refuses with a 409 and KEEPS the request when it is no longer recurring or the template is shared', () => {
    const block = approveSeriesBlock()
    const denial = block.indexOf('seriesDeleteDenial(seriesChecklist, seriesData.checklistTemplates)')
    expect(denial).toBeGreaterThan(-1)
    const refused = block.slice(denial, block.indexOf('runSeriesStepDelete('))
    expect(refused).toContain('sendJson(response, 409, { error: seriesDenial.error })')
    expect(refused).not.toContain('deleteItemDeletionRequest')
  })

  it('refuses the last recurring step with the 409 body and KEEPS the request; success and a gone step drop it', () => {
    const block = approveSeriesBlock()
    const run = block.indexOf('runSeriesStepDelete(')
    const refusal = block.indexOf('removal.status === 409')
    const drop = block.indexOf('appDataStore.deleteItemDeletionRequest(requestId)', refusal)
    expect(refusal).toBeGreaterThan(run)
    expect(block.slice(refusal, refusal + 120)).toContain('sendJson(response, 409, removal.body)')
    expect(drop).toBeGreaterThan(refusal)
    expect(block.slice(refusal, drop)).toContain('return')
    // A step that vanished mid-flight answers 404 as today; success answers the owner's own body.
    expect(block.slice(drop)).toContain("removal.status === 404")
    expect(block.slice(drop)).toContain('sendJson(response, removal.status, removal.body)')
  })

  it('runs the same shared delete (store, actor, broadcast) as the owner\'s own route', () => {
    const block = approveSeriesBlock()
    expect(block).toContain('store: appDataStore')
    expect(block).toContain('actorId: session.user.id')
    expect(block).toContain('broadcast: broadcastDataChanged')
    expect(block).toContain('itemId: req.itemId')
  })

  it('leaves a one-checklist request on today\'s path, waiting-step guard included', () => {
    const at = serverSource.indexOf("if (req.scope === 'series') {")
    const after = serverSource.slice(at)
    const guard = after.indexOf('removalWouldCompleteWaitingStep(approvalItem')
    const removeItem = after.indexOf('appDataStore.deleteChecklistItem(req.checklistId, req.itemId)')
    expect(guard).toBeGreaterThan(-1)
    expect(removeItem).toBeGreaterThan(guard)
    expect(after.slice(removeItem, removeItem + 700)).toContain("'checklist_item_removed'")
  })
})

describe('the tab merges the series delete as a server update', () => {
  it('uses applyServerDataUpdate for both the checklists and the template, never the dirty-marking path', () => {
    const at = appSource.indexOf('const deleteChecklistItemFromSeries = async')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, at + 2400)
    expect(block).toContain('applyServerDataUpdate(withSeriesDeleteResult(result))')
    // The refusal reaches the prompt as a thrown ApiError instead of being swallowed.
    // Every clean refusal (400 / 403 / 409 / 422 / 423) and a 404 (the step is
    // already gone, e.g. a double click) leaves the tab in sync and is rethrown.
    expect(block).toContain('isCleanRejection(error) || (error instanceof ApiError && error.status === 404)')
    expect(block).toContain('throw error')
    expect(block).not.toContain('updateWorkspaceData(')
    const merge = appSource.indexOf('function withSeriesDeleteResult(')
    expect(merge).toBeGreaterThan(-1)
    expect(appSource.slice(merge, merge + 700)).toContain('checklistTemplates: current.checklistTemplates.map')
  })

  it('merges an approved series request the same way, and a team member\'s request only refreshes the list', () => {
    const approve = appSource.indexOf('const approveItemDeletion = useCallback(')
    expect(approve).toBeGreaterThan(-1)
    const block = appSource.slice(approve, approve + 2200)
    expect(block).toContain('isSeriesDeleteResult(updated)')
    expect(block).toContain('applyServerDataUpdate(withSeriesDeleteResult(updated))')
    const series = appSource.indexOf('const deleteChecklistItemFromSeries = async')
    const filed = appSource.indexOf('isItemDeletionFiled(result)', series)
    expect(filed).toBeGreaterThan(series)
    expect(appSource.slice(filed, filed + 200)).toContain('refreshItemDeletionRequests()')
  })
})
