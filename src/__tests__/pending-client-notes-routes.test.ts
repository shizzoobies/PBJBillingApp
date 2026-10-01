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
  const block = () => routeBlock(/const clientPendingNotesMatch = normalizedPath\.match/, 4800)

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
  const block = () => routeBlock(/const clientPendingNoteDeleteMatch = normalizedPath\.match/, 2200)

  it('checks the cross-site origin', () => {
    expect(block()).toContain('isCrossSiteOrigin(request)')
  })

  it('404s a note that belongs to a different client than the path names', () => {
    const text = block()
    expect(text).toContain('const clientId = decodeURIComponent(clientPendingNoteDeleteMatch[1])')
    expect(text).toContain('if (!note || note.clientId !== clientId) {')
  })

  it('records the deletion in the activity log', () => {
    const text = block()
    const deleteAt = text.indexOf('appDataStore.deleteClientPendingNote(noteId)')
    const recordAt = text.indexOf(
      "recordActivity(session.user.id, 'client_pending_note_deleted', clientId)",
    )
    expect(deleteAt).toBeGreaterThan(-1)
    expect(recordAt).toBeGreaterThan(deleteAt)
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
