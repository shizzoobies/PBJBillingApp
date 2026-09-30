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
  const block = () => routeBlock(/const clientPendingNotesMatch = normalizedPath\.match/, 3800)

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
  const block = () => routeBlock(/const clientPendingNoteDeleteMatch = normalizedPath\.match/, 1400)

  it('checks the cross-site origin', () => {
    expect(block()).toContain('isCrossSiteOrigin(request)')
  })

  it('allows the owner, or the author while still unattached — never the author of an attached note', () => {
    const text = block()
    expect(text).toContain(
      'const isOwnUnattached = note.authorId === session.user.id && !note.attachedChecklistId',
    )
    expect(text).toContain("session.user.role !== 'owner' && !isOwnUnattached")
  })
})

describe('GET /api/checklists/:id/pending-notes', () => {
  const block = () => routeBlock(/const checklistPendingNotesMatch = normalizedPath\.match/, 1200)

  it('resolves the checklist, then gates on the PREVIEWED session’s visible clients', () => {
    const text = block()
    expect(text).toContain('await previewScopedSession(request, session, response')
    expect(text).toContain(
      "(data.checklists ?? []).find((entry) => entry.id === checklistId)",
    )
    expect(text).toContain('visibleClientIdSet(scoped, data)')
  })
})

describe('the bulk PUT runs the attach pass after a successful save', () => {
  it('calls attachPendingClientNotes AFTER the period-label restamp and BEFORE the fingerprint is computed', () => {
    const restampAt = serverSource.indexOf(
      "console.log(`[bulk-save] re-stamped ${restampedLabels} period label(s)`)",
    )
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    const versionAt = serverSource.indexOf(
      'const nextVersion = await appDataStore.computeWorkspaceVersion()',
    )
    expect(restampAt).toBeGreaterThan(-1)
    expect(attachAt).toBeGreaterThan(restampAt)
    expect(versionAt).toBeGreaterThan(attachAt)
  })

  it('never lets an attach-pass failure fail an accepted save', () => {
    const attachAt = serverSource.indexOf('appDataStore.attachPendingClientNotes({})')
    expect(serverSource.slice(attachAt - 100, attachAt)).toContain('try {')
    expect(serverSource.slice(attachAt, attachAt + 200)).toContain('} catch (error) {')
  })
})
