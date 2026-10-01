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
    const refuseAt = text.indexOf('template.isStandard || template.active === false')
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
  it("computes the fingerprint BEFORE the attach pass, so the tab's next save 409s instead of erasing the attached item", () => {
    // The attach pass inserts an item row the saving tab's payload does not
    // have. A version taken AFTER it would let that tab's very next autosave
    // pass the staleness guard and delete the item (the note would stay
    // stamped attached). Taken BEFORE, the next save is refused and the tab
    // refetches. The period-label restamp is the one write that must still
    // come first: it is this server's own change to the same tab's data.
    const restampAt = serverSource.indexOf(
      "console.log(`[bulk-save] re-stamped ${restampedLabels} period label(s)`)",
    )
    const versionAt = serverSource.indexOf(
      'const nextVersion = await appDataStore.computeWorkspaceVersion()',
    )
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    expect(restampAt).toBeGreaterThan(-1)
    expect(versionAt).toBeGreaterThan(restampAt)
    expect(attachAt).toBeGreaterThan(versionAt)
  })

  it('hands the tab the version it computed before the attach pass', () => {
    const versionAt = serverSource.indexOf(
      'const nextVersion = await appDataStore.computeWorkspaceVersion()',
    )
    const sendAt = serverSource.indexOf(
      'sendJson(response, 200, { ok: true }, { [WORKSPACE_VERSION_HEADER]: nextVersion })',
    )
    expect(sendAt).toBeGreaterThan(versionAt)
    // Exactly one version is computed in the PUT after the write: no second
    // computation sneaks in after the attach pass.
    expect(
      serverSource.slice(versionAt, sendAt).match(/computeWorkspaceVersion\(\)/g),
    ).toHaveLength(1)
  })

  it('never lets an attach-pass failure fail an accepted save', () => {
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    expect(serverSource.slice(attachAt - 100, attachAt)).toContain('try {')
    expect(serverSource.slice(attachAt, attachAt + 200)).toContain('} catch (error) {')
  })
})
