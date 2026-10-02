import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Pending notes for future recurring checklists (featreq-b688e73c) — the
 * ROUTE wiring. `server.js` calls `listen()` at module scope and exports
 * nothing, so (same reasoning as period-label-restamp-route.test.ts and
 * preview-scoped-routes.test.ts) this reads route source rather than driving
 * an HTTP harness. The store-level decisions — who may attach, the matching
 * logic, both backends — are tested properly in
 * lib/checklist-write-permission.test.mjs and db/store-staleness.test.mjs.
 * A failure here means "the route moved, go look".
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')

function routeBlock(startPattern: RegExp, length = 1600): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

describe('the attach pass hook is wired once, near the store', () => {
  it('broadcasts through onPendingNotesAttached, set right after the store is constructed', () => {
    const at = serverSource.indexOf('const appDataStore = new AppDataStore()')
    expect(at).toBeGreaterThan(-1)
    const nearby = serverSource.slice(at, at + 600)
    expect(nearby).toContain('appDataStore.onPendingNotesAttached = () => broadcastDataChanged()')
  })
})

describe('POST /api/clients/:id/pending-notes', () => {
  const block = () => routeBlock(/const clientPendingNotesMatch = normalizedPath\.match/, 5600)

  it('gates on isJsonContentType and isCrossSiteOrigin before touching the store', () => {
    const text = block()
    const postAt = text.indexOf("request.method === 'POST'")
    expect(postAt).toBeGreaterThan(-1)
    const postBlock = text.slice(postAt, postAt + 1800)
    expect(postBlock).toContain('isJsonContentType(request)')
    expect(postBlock).toContain('isCrossSiteOrigin(request)')
  })

  it('looks up the template scoped to this client before checking the write gate', () => {
    const text = block()
    expect(text).toContain(
      "(entry) => entry.id === templateId && entry.clientId === clientId",
    )
  })

  it('checks the write boundary with pendingNoteWriteDenial, not the ordinary checklist gate', () => {
    const text = block()
    const denialAt = text.indexOf('pendingNoteWriteDenial({')
    expect(denialAt).toBeGreaterThan(-1)
    const denialBlock = text.slice(denialAt, denialAt + 300)
    expect(denialBlock).toContain('user: session.user')
    expect(denialBlock).toContain('clientVisible: true')
    expect(denialBlock).toContain('template,')
    expect(denialBlock).toContain('checklists: templateChecklists')
    // Not the ordinary per-checklist gate — a pending note may be flagged
    // before any checklist of the template exists.
    expect(text).not.toContain('checklistWriteDenial({')
  })

  it('refuses a template that is standard or inactive - it could never spawn a checklist', () => {
    const text = block()
    // `active !== true`, not `=== false`: the materializer skips any recipe
    // whose `active` is not truthy, so a missing flag could never spawn either.
    const refuseAt = text.indexOf('template.isStandard || template.active !== true')
    expect(refuseAt).toBeGreaterThan(-1)
    expect(text.slice(refuseAt, refuseAt + 250)).toContain("error: 'template_not_recurring'")
    expect(text.slice(refuseAt, refuseAt + 250)).toContain('sendJson(response, 409')
    // Before the write gate and before anything is stored.
    expect(refuseAt).toBeLessThan(text.indexOf('pendingNoteWriteDenial({'))
    expect(refuseAt).toBeLessThan(text.indexOf('createClientPendingNote('))
  })

  it('answers 409 too_many_pending_notes when the client already holds the most notes allowed', () => {
    const text = block()
    expect(serverSource).toMatch(/import \{[^}]*\bTooManyPendingNotesError\b[^}]*\} from '\.\/db\/store\.js'/)
    const catchAt = text.indexOf('error instanceof TooManyPendingNotesError')
    expect(catchAt).toBeGreaterThan(text.indexOf('createClientPendingNote('))
    const reply = text.slice(catchAt, catchAt + 220)
    expect(reply).toContain("sendJson(response, 409, { error: 'too_many_pending_notes', message: error.message })")
    // Nothing is recorded or broadcast for a refused note.
    expect(catchAt).toBeLessThan(text.indexOf("'pending_note_added'"))
  })

  it('records activity and broadcasts after a successful create', () => {
    const text = block()
    expect(text).toContain("recordActivity(session.user.id, 'pending_note_added', template.title)")
    const recordAt = text.indexOf("'pending_note_added'")
    const broadcastAt = text.indexOf('broadcastDataChanged()', recordAt)
    const sendAt = text.indexOf('sendJson(response, 201, { note })')
    expect(broadcastAt).toBeGreaterThan(recordAt)
    expect(sendAt).toBeGreaterThan(broadcastAt)
  })
})

describe('DELETE /api/clients/:id/pending-notes/:noteId', () => {
  const block = () => routeBlock(/const clientPendingNoteDeleteMatch = normalizedPath\.match/, 3400)

  it('checks the cross-site origin', () => {
    expect(block()).toContain('isCrossSiteOrigin(request)')
  })

  it('404s a note that belongs to a different client than the path names', () => {
    const text = block()
    expect(text).toContain('const clientId = decodeURIComponent(clientPendingNoteDeleteMatch[1])')
    expect(text).toContain('if (!note || note.clientId !== clientId) {')
  })

  it('404s a person who cannot see the client, before looking the note up', () => {
    const text = block()
    const gateAt = text.indexOf('if (!visibleClientIdSet(session, data).has(clientId)) {')
    expect(gateAt).toBeGreaterThan(-1)
    expect(text.slice(gateAt, gateAt + 160)).toContain("sendJson(response, 404, { error: 'Note not found' })")
    expect(gateAt).toBeLessThan(text.indexOf('appDataStore.getClientPendingNote(noteId)'))
  })

  it('records the deletion under the client NAME, and only when a note was actually removed', () => {
    const text = block()
    const deleteAt = text.indexOf('appDataStore.deleteClientPendingNote(noteId)')
    const refuseAt = text.indexOf('if (!removed) {', deleteAt)
    const recordAt = text.indexOf("'client_pending_note_deleted',")
    const broadcastAt = text.indexOf('broadcastDataChanged()')
    expect(deleteAt).toBeGreaterThan(-1)
    expect(refuseAt).toBeGreaterThan(deleteAt)
    // Nothing removed: a 404 and neither a log entry nor a broadcast.
    expect(text.slice(refuseAt, refuseAt + 120)).toContain("sendJson(response, 404, { error: 'Note not found' })")
    expect(recordAt).toBeGreaterThan(refuseAt)
    expect(text.slice(recordAt, recordAt + 120)).toContain('client?.name ?? clientId')
    expect(broadcastAt).toBeGreaterThan(recordAt)
  })

  it('allows the owner, or the author while still unattached — never the author of an attached note', () => {
    const text = block()
    expect(text).toContain(
      'const isOwnUnattached = note.authorId === session.user.id && !note.attachedChecklistId',
    )
    expect(text).toContain("session.user.role !== 'owner' && !isOwnUnattached")
  })
})

describe('GET /api/pending-notes/attached (one request per page of cards)', () => {
  const block = () => routeBlock(/normalizedPath === '\/api\/pending-notes\/attached'/, 2800)

  it('is a GET - a POST would be broadcast as a data mutation and make every tab ask again', () => {
    expect(block()).toContain("request.method === 'GET'")
  })

  it('takes a comma-separated id list and refuses more than the batch limit', () => {
    const text = block()
    expect(text).toContain("requestUrl.searchParams.get('checklistIds')")
    expect(text).toContain('requested.length > PENDING_NOTES_BATCH_LIMIT')
    expect(serverSource).toContain('const PENDING_NOTES_BATCH_LIMIT = 500')
  })

  it('reads the workspace ONCE, then gates on the PREVIEWED session’s visible clients', () => {
    const text = block()
    const routeEnd = text.indexOf('listPendingNotesForChecklists(visibleIds)')
    expect(routeEnd).toBeGreaterThan(-1)
    expect(text.slice(0, routeEnd).match(/appDataStore\.read\(\)/g)).toHaveLength(1)
    expect(text).toContain('await previewScopedSession(request, session, response')
    expect(text).toContain('visibleClientIdSet(scoped, data)')
    expect(text).toContain('wanted.has(checklist.id) && allowed.has(checklist.clientId)')
  })

  it('also drops a note whose OWN client the caller cannot see', () => {
    const text = block()
    const callAt = text.indexOf('listPendingNotesForChecklists(visibleIds)')
    expect(text.slice(callAt, callAt + 200)).toContain('.filter((note) =>')
    expect(text.slice(callAt, callAt + 200)).toContain('allowed.has(note.clientId)')
  })

  it('answers from the pending-notes table for only the visible ids, in one store call', () => {
    expect(serverSource.match(/appDataStore\.listPendingNotesForChecklists\(/g)).toHaveLength(1)
    expect(block()).toContain('listPendingNotesForChecklists(visibleIds)')
  })

  it('replaced the per-checklist route - there is no per-card fetch left to make', () => {
    expect(serverSource).not.toContain('checklistPendingNotesMatch')
    expect(serverSource).not.toContain('listPendingNotesForChecklist(')
  })
})

describe('the bulk PUT runs the attach pass after a successful save', () => {
  it("hands the tab a version taken right after write(), BEFORE the attach pass, so the tab's next save 409s instead of erasing the attached item", () => {
    // The attach pass inserts an item row the saving tab's payload does not
    // have. A version taken AFTER it would let that tab's very next autosave
    // pass the staleness guard and delete the item (the note would stay
    // stamped attached). Taken BEFORE, the next save is refused and the tab
    // refetches.
    const writeAt = serverSource.indexOf('await appDataStore.write(data, { expectedVersion })')
    const writeFailedAt = serverSource.indexOf("error: 'bulk_save_failed'")
    const declAt = serverSource.indexOf('let postWriteVersion = null')
    const postWriteAt = serverSource.indexOf(
      'postWriteVersion = await appDataStore.computeWorkspaceVersion()',
    )
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    expect(writeAt).toBeGreaterThan(-1)
    expect(writeFailedAt).toBeGreaterThan(writeAt)
    // The version is taken AFTER the write's try/catch closed (its failure
    // branches all return), with nothing but its own try between: any other
    // request's write landing there would be folded into the version.
    expect(declAt).toBeGreaterThan(writeFailedAt)
    expect(postWriteAt).toBeGreaterThan(declAt)
    expect(serverSource.slice(declAt, postWriteAt).match(/await /g)).toBeNull()
    expect(attachAt).toBeGreaterThan(postWriteAt)
  })

  it('a failure computing the version never tells the tab its COMMITTED save failed - it fails closed instead', () => {
    const declAt = serverSource.indexOf('let postWriteVersion = null')
    const postWriteAt = serverSource.indexOf(
      'postWriteVersion = await appDataStore.computeWorkspaceVersion()',
    )
    // Its own try/catch, outside the write's: the catch only logs and flags.
    expect(serverSource.slice(declAt, postWriteAt)).toContain('try {')
    const catchBlock = serverSource.slice(postWriteAt, postWriteAt + 300)
    expect(catchBlock).toContain('} catch (error) {')
    expect(catchBlock).toContain('versionFailed = true')
    expect(catchBlock).not.toContain('sendJson')
    // No version header on failure (the tab keeps its old one, so its next
    // save 409s) plus a refetch hint, still a 200.
    const sendAt = serverSource.indexOf('nextVersion ? { [WORKSPACE_VERSION_HEADER]: nextVersion } : {}')
    expect(sendAt).toBeGreaterThan(-1)
    const reply = serverSource.slice(sendAt - 300, sendAt)
    expect(reply).toContain('sendJson(')
    expect(reply).toContain('200')
    expect(reply).toContain('attachedNotes > 0 || versionFailed ? { ok: true, refetch: true } : { ok: true }')
    // The known, documented gap.
    expect(serverSource).toContain('KNOWN, NOT CLOSED HERE')
    expect(serverSource).toContain('REPEATABLE READ')
  })

  it('re-takes the version only when the label restamp actually changed rows', () => {
    const restampAt = serverSource.indexOf(
      "[bulk-save] re-stamped",
    )
    const nextAt = serverSource.indexOf('let nextVersion = postWriteVersion')
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    expect(nextAt).toBeGreaterThan(restampAt)
    expect(attachAt).toBeGreaterThan(nextAt)
    const decl = serverSource.slice(nextAt, nextAt + 200)
    expect(decl).toContain('restampedLabels > 0')
    // The only computation after the restamp sits in that guarded re-take.
    expect(
      serverSource.slice(nextAt, attachAt).match(/computeWorkspaceVersion\(\)/g),
    ).toHaveLength(1)
  })

  it('answers with that version, and tells the tab to refetch when notes attached', () => {
    const nextAt = serverSource.indexOf('let nextVersion = postWriteVersion')
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    const sendAt = serverSource.indexOf('{ [WORKSPACE_VERSION_HEADER]: nextVersion }')
    expect(sendAt).toBeGreaterThan(attachAt)
    expect(attachAt).toBeGreaterThan(nextAt)
    const reply = serverSource.slice(sendAt - 250, sendAt)
    expect(reply).toContain('attachedNotes > 0 || versionFailed ? { ok: true, refetch: true } : { ok: true }')
    expect(serverSource.slice(attachAt - 40, attachAt)).toContain('attachedNotes = await')
  })

  it('never lets an attach-pass failure fail an accepted save', () => {
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    expect(serverSource.slice(attachAt - 100, attachAt)).toContain('try {')
    expect(serverSource.slice(attachAt, attachAt + 200)).toContain('} catch (error) {')
  })
})

describe('GET /api/app-data hands out the version that came WITH its data', () => {
  const block = () =>
    routeBlock(/if \(normalizedPath === '\/api\/app-data'\) \{/, 2600)

  it('reads data and version together and never computes a version after the read', () => {
    const text = block()
    const getEnd = text.indexOf("if (request.method === 'PUT')")
    expect(getEnd).toBeGreaterThan(-1)
    const getBlock = text.slice(0, getEnd)
    expect(getBlock).toContain(
      'const { data, version: workspaceVersion } = await appDataStore.readWithVersion()',
    )
    expect(getBlock).not.toContain('computeWorkspaceVersion')
    expect(getBlock).toContain('[WORKSPACE_VERSION_HEADER]: workspaceVersion')
  })
})

describe('skipping a checklist puts its notes back on the client page right away', () => {
  it('re-runs the attach pass for that checklist client, after the skip and its trail entry, never failing the skip', () => {
    const skipAt = serverSource.indexOf('await appDataStore.skipChecklistInstance(checklistId, session.user.id)')
    const attachAt = serverSource.indexOf('attachPendingClientNotes({ clientId: checklist.clientId })', skipAt)
    expect(skipAt).toBeGreaterThan(-1)
    expect(attachAt).toBeGreaterThan(skipAt)
    expect(attachAt).toBeGreaterThan(serverSource.indexOf("'checklist_skipped'", skipAt))
    // Its own try/catch: a failed pass is logged, and the skip still answers 200.
    expect(serverSource.slice(attachAt - 60, attachAt)).toContain('await appDataStore.')
    expect(serverSource.slice(attachAt - 120, attachAt)).toContain('try {')
    expect(serverSource.slice(attachAt, attachAt + 200)).toContain("[checklist-skip] pending-notes attach pass failed:")
    expect(serverSource.indexOf('sendJson(response, 200, { checklist: skipped, skip: record })')).toBeGreaterThan(attachAt)
  })
})

describe('deleting a checklist puts its notes back on the client page right away', () => {
  it('both delete callers re-run the attach pass for that checklist client', () => {
    const calls = [...serverSource.matchAll(/await appDataStore\.deleteChecklist\(checklistId\)/g)]
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const after = serverSource.slice(call.index, call.index + 1100)
      expect(after).toContain('appDataStore.attachPendingClientNotes({ clientId: target.clientId })')
      expect(after.indexOf('attachPendingClientNotes')).toBeLessThan(
        after.indexOf("'checklist_deleted'"),
      )
    }
  })
})

/**
 * A note that repeats on every checklist (featreq-1f352c4f): the create route
 * takes `repeats`, strictly boolean, and stopping one is the EXISTING delete
 * route - the repeating row itself is never attached, so the rule "the author, or
 * an owner, while it is unattached" already covers it. The attach pass, both
 * backends and the cap are pinned in db/store-staleness.test.mjs.
 */
describe('a note that repeats on every checklist', () => {
  it('POST passes repeats to the store only when the body says exactly true', () => {
    const text = routeBlock(/const clientPendingNotesMatch = normalizedPath\.match/, 6200)
    const at = text.indexOf('note = await appDataStore.createClientPendingNote(clientId, {')
    expect(at).toBeGreaterThan(-1)
    expect(text.slice(at, at + 500)).toContain('repeats: payload?.repeats === true,')
  })

  it('stopping one uses the existing delete route, which has no special case for the repeating note itself', () => {
    const text = routeBlock(/const clientPendingNoteDeleteMatch = normalizedPath\.match/, 3200)
    expect(text).not.toContain('repeats')
    // The repeating row is never attached, so its author passes the unattached rule.
    expect(text).toContain('const isOwnUnattached = note.authorId === session.user.id && !note.attachedChecklistId')
    expect(text).toContain('await appDataStore.deleteClientPendingNote(noteId)')
  })

  it('refuses to delete a COPY a repeating note left on a checklist, for everyone, before anything is written', () => {
    const text = routeBlock(/const clientPendingNoteDeleteMatch = normalizedPath.match/, 3200)
    const refusalAt = text.indexOf('if (note.repeatOf) {')
    expect(refusalAt).toBeGreaterThan(-1)
    const refusal = text.slice(refusalAt, refusalAt + 620)
    expect(refusal).toContain('sendJson(response, 409, {')
    expect(refusal).toContain("error: 'REPEAT_COPY_NOT_DELETABLE',")
    // Worded by kind: a note is dismissed, a task's step is removed.
    expect(refusal).toContain(
      "message: note.kind === 'note' ? REPEAT_NOTE_COPY_NOT_DELETABLE : REPEAT_TASK_COPY_NOT_DELETABLE,",
    )
    const flat = serverSource.replaceAll('\r\n', '\n')
    expect(flat).toContain(
      "const REPEAT_NOTE_COPY_NOT_DELETABLE =\n  'This note was added by a repeating note. Use Dismiss on the checklist to take it off this month, or stop the repeating note.'",
    )
    expect(flat).toContain(
      "const REPEAT_TASK_COPY_NOT_DELETABLE =\n  'This note was added by a repeating note. Remove the step on the checklist instead, or stop the repeating note.'",
    )
    expect(refusal).toContain('return')
    // Decided from the row the route already loads, after the 404s and the client
    // check, and before the owner / author rule (so everyone gets it) and the store delete.
    expect(refusalAt).toBeGreaterThan(text.indexOf('const note = await appDataStore.getClientPendingNote(noteId)'))
    expect(refusalAt).toBeGreaterThan(text.indexOf('note.clientId !== clientId'))
    expect(refusalAt).toBeLessThan(text.indexOf('const isOwnUnattached'))
    expect(refusalAt).toBeLessThan(text.indexOf('await appDataStore.deleteClientPendingNote(noteId)'))
  })

  it('the list route hands back what the store lists (the repeats fields ride on the note)', () => {
    const text = routeBlock(/const clientPendingNotesMatch = normalizedPath\.match/, 1400)
    expect(text).toContain('const notes = await appDataStore.listClientPendingNotes(clientId)')
    expect(text).toContain('sendJson(response, 200, { notes })')
  })
})

/**
 * Dismiss ONE month's copy of a repeating note (featreq-e8aa2abe): a POST under the
 * same client path, with the DELETE route's gates and the create route's write
 * boundary. The decisions (what may be dismissed, both backends) are pinned in
 * db/store-staleness.test.mjs; this is the glue.
 */
describe('POST /api/clients/:id/pending-notes/:noteId/dismiss', () => {
  const block = () => routeBlock(/const clientPendingNoteDismissMatch = normalizedPath\.match/, 4200)

  it("is a POST on its own path, which the DELETE route's pattern cannot match", () => {
    const text = block()
    expect(text).toContain(String.raw`/^\/api\/clients\/([^/]+)\/pending-notes\/([^/]+)\/dismiss$/`)
    expect(text).toContain("clientPendingNoteDismissMatch && request.method === 'POST'")
    const deleteMatch = /^\/api\/clients\/([^/]+)\/pending-notes\/([^/]+)$/
    expect(deleteMatch.test('/api/clients/c1/pending-notes/n1/dismiss')).toBe(false)
  })

  it('checks the session and the cross-site origin before touching the store', () => {
    const text = block()
    expect(text).toContain('const session = await requireSession(request, response)')
    const originAt = text.indexOf('isCrossSiteOrigin(request)')
    expect(originAt).toBeGreaterThan(-1)
    expect(originAt).toBeLessThan(text.indexOf('appDataStore.read()'))
  })

  it('404s a person who cannot see the client, and a note of another client, before the write gate', () => {
    const text = block()
    const gateAt = text.indexOf('if (!visibleClientIdSet(session, data).has(clientId)) {')
    expect(gateAt).toBeGreaterThan(-1)
    expect(text.slice(gateAt, gateAt + 160)).toContain("sendJson(response, 404, { error: 'Note not found' })")
    expect(gateAt).toBeLessThan(text.indexOf('appDataStore.getClientPendingNote(noteId)'))
    expect(text).toContain('if (!note || note.clientId !== clientId) {')
    expect(text.indexOf('if (!note || note.clientId !== clientId) {')).toBeLessThan(
      text.indexOf('pendingNoteWriteDenial({'),
    )
  })

  it("uses the same write boundary as adding a note, with the note's own template and live checklists", () => {
    const text = block()
    const at = text.indexOf('pendingNoteWriteDenial({')
    expect(at).toBeGreaterThan(-1)
    const denial = text.slice(at, at + 700)
    expect(denial).toContain('user: session.user')
    expect(denial).toContain('clientVisible: true')
    expect(denial).toContain('(entry) => entry.id === note.templateId && entry.clientId === clientId')
    expect(denial).toContain('checklist.templateId === note.templateId')
    expect(denial).toContain('!checklist.deletedAt')
    expect(at).toBeLessThan(text.indexOf('appDataStore.dismissPendingNoteCopy(noteId)'))
    expect(text).not.toContain('checklistWriteDenial({')
  })

  it("answers the store's refusals with the right sentence and writes nothing", () => {
    const text = block()
    expect(text).toContain("outcome.reason === 'not_found'")
    expect(text).toContain(
      "sendJson(response, 409, { error: 'NOT_A_REPEAT_COPY', message: NOT_A_REPEAT_COPY_MESSAGE })",
    )
    expect(text).toContain(
      "sendJson(response, 409, { error: 'REPEAT_TASK_COPY', message: REPEAT_TASK_COPY_NOT_DELETABLE })",
    )
    // The task-kind sentence says to remove the step on the checklist.
    expect(serverSource).toContain("Remove the step on the checklist instead, or stop the repeating note.'")
  })

  it('records the activity and broadcasts only when this call dismissed it; a repeat answers the same 200', () => {
    const text = block()
    const dismissedAt = text.indexOf('if (outcome.dismissed) {')
    expect(dismissedAt).toBeGreaterThan(-1)
    const recordAt = text.indexOf("'client_pending_note_dismissed',")
    const broadcastAt = text.indexOf('broadcastDataChanged()')
    expect(recordAt).toBeGreaterThan(dismissedAt)
    expect(text.slice(recordAt, recordAt + 120)).toContain('client?.name ?? clientId')
    expect(broadcastAt).toBeGreaterThan(recordAt)
    const sendAt = text.indexOf('sendJson(response, 200, { ok: true, dismissed: true })')
    expect(sendAt).toBeGreaterThan(broadcastAt)
  })

  it('is not preview-aware: a preview write is refused before any route, and the read allow-list is unchanged', () => {
    // Writes under X-Preview-As / X-Preview-Mode are refused by the central guard.
    expect(serverSource).toContain("sendJson(response, 403, { error: 'Preview mode is read-only' })")
    const listAt = serverSource.indexOf('const PREVIEW_AWARE_API_PATTERNS = [')
    const list = serverSource.slice(listAt, serverSource.indexOf('function isPreviewAwareApiPath', listAt))
    expect(list).toContain('pending-notes$/')
    expect(list).not.toContain('dismiss')
  })

  it('is a data mutation to the central hook like its neighbors (any non-GET /api path), and also broadcasts itself', () => {
    const at = serverSource.indexOf('const isDataMutation =')
    expect(serverSource.slice(at, at + 400)).toContain("method !== 'GET'")
    expect(block()).toContain('broadcastDataChanged()')
  })
})
