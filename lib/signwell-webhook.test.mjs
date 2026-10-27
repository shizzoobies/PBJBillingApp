import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { engagementEsignHash } from './engagement-hash.js'
import {
  SIGNWELL_EVENT_STATUS,
  SIGNWELL_ISSUES,
  documentStatus,
  eventKey,
  eventTimeIso,
  finishSignatureRequest,
  handleSignwellWebhook,
  signedTripleKey,
  withoutNotCompletedNote,
} from './signwell-webhook.js'

const WEBHOOK_ID = 'hook-id-for-tests'
const DOC = 'doc-abc'
const TIME = 1760990000
/** "Now" for the handler: an hour after the events, so they are fresh. */
const NOW = new Date((TIME + 3600) * 1000)
const hashOf = (type, time) => createHmac('sha256', WEBHOOK_ID).update(`${type}@${time}`).digest('hex')

/** A signed payload the way SignWell sends it. */
function delivery({ type = 'document_viewed', time = TIME, doc = DOC, signer = 'pat@example.invalid', hash } = {}) {
  return JSON.stringify({
    event: { type, time, hash: hash ?? hashOf(type, time), ...(signer ? { related_signer: { name: 'Pat Example', email: signer } } : {}) },
    data: { object: { id: doc, status: 'Sent', metadata: { engagement_id: 'eng-1' } }, account_id: 'acct' },
  })
}

const FINISHED = ['completed', 'declined', 'expired', 'canceled', 'withdrawn']
const PROGRESS = ['draft', 'sent', 'viewed', 'signed_partial']
const RECOVERABLE = ['bounced', 'error']

/** An in-memory stand-in for the store methods the handler uses (the real ones are tested in db/). */
function fakeStore({
  request = {},
  engagement = {},
  signRefusal = null,
  owners,
  amendments = [],
  updateFails = null,
  others = [],
  clientName = 'Acme Books',
} = {}) {
  const eng = {
    id: 'eng-1',
    kind: 'original',
    status: 'sent',
    clientId: null,
    subject: 'Engagement letter',
    emailBody: 'Hi Pat',
    letterBody: 'The letter',
    retainerAmount: null,
    packageId: null,
    planIds: [],
    feeMode: 'replace',
    figures: { totals: { monthly: 100 } },
    party: { company: 'Acme Books', contactName: 'Pat Example', email: 'pat@example.invalid' },
    ...engagement,
  }
  const state = {
    request: {
      id: 'sigreq-1',
      engagementId: 'eng-1',
      clientId: null,
      signwellDocumentId: DOC,
      status: 'sent',
      recipients: [{ id: '1', name: 'Pat Example', email: 'pat@example.invalid' }],
      testMode: false,
      esignHash: engagementEsignHash(eng),
      signedDocumentId: null,
      completedAt: null,
      finishingAt: null,
      lastEventAt: null,
      lastError: null,
      createdBy: 'emp-patrice',
      ...request,
    },
    engagement: eng,
    others,
    events: new Set(),
    updates: [],
    stored: [],
    signCalls: [],
  }
  const store = {
    state,
    getSignatureRequest: vi.fn(async (id) => {
      const row = id === state.request.id ? state.request : state.others.find((entry) => entry.id === id)
      return row ? { ...row } : null
    }),
    getSignatureRequestByDocumentId: vi.fn(async (id) => {
      if (id === state.request.signwellDocumentId) return { ...state.request }
      const other = state.others.find((entry) => entry.signwellDocumentId === id)
      return other ? { ...other } : null
    }),
    recordSignwellEventOnce: vi.fn(async (key) => {
      if (state.events.has(key)) return false
      state.events.add(key)
      return true
    }),
    forgetSignwellEvent: vi.fn(async (key) => state.events.delete(key)),
    updateSignatureRequest: vi.fn(async (id, patch) => {
      if (updateFails) throw updateFails
      state.updates.push(patch)
      const row = id === state.request.id ? state.request : state.others.find((entry) => entry.id === id)
      if (patch.status) {
        // The store's rules: a stale event never moves a status (a finished status read from the document is
        // not late news); a finished request never changes; in-progress only forward; bounced/error recoverable.
        const stale = patch.lastEventAt && row.lastEventAt && patch.lastEventAt < row.lastEventAt && !FINISHED.includes(patch.status)
        const movable =
          !FINISHED.includes(row.status) &&
          (!PROGRESS.includes(patch.status) || RECOVERABLE.includes(row.status) || PROGRESS.indexOf(patch.status) >= PROGRESS.indexOf(row.status))
        if (!stale && movable) row.status = patch.status
      }
      for (const key of ['recipients', 'signedDocumentId', 'completedAt']) if (patch[key]) row[key] = patch[key]
      if (patch.lastEventAt && (!row.lastEventAt || patch.lastEventAt > row.lastEventAt)) row.lastEventAt = patch.lastEventAt
      if (patch.lastError !== undefined) row.lastError = patch.lastError
      if (patch.finishingAt !== undefined) row.finishingAt = patch.finishingAt
      return { ...row }
    }),
    getEngagement: vi.fn(async () => ({ ...state.engagement })),
    getClientById: vi.fn(async (id) => ({ id, name: clientName })),
    listEngagements: vi.fn(async () => amendments),
    getTeamMembers: vi.fn(async () => owners ?? [{ id: 'emp-patrice', role: 'owner' }, { id: 'emp-two', role: 'owner' }, { id: 'emp-staff', role: 'employee' }]),
    // One signed PDF per request: a second store reads the first back (the unique index).
    storeSignedDocument: vi.fn(async ({ signatureRequestId, fileName, bytes }) => {
      const held = state.stored.find((entry) => entry.signatureRequestId === signatureRequestId)
      if (held) return { id: held.id, byteSize: held.bytes.length, fileName: held.fileName }
      const entry = { id: `sigdoc-${state.stored.length + 1}`, signatureRequestId, fileName, bytes }
      state.stored.push(entry)
      return { id: entry.id, byteSize: bytes.length, fileName }
    }),
    signEngagement: vi.fn(async (id, options) => {
      state.signCalls.push({ id, options })
      if (signRefusal) throw signRefusal
      state.engagement.status = 'signed'
      return { engagement: { ...state.engagement, status: 'signed' }, clientId: 'client-1', createdClient: true }
    }),
  }
  return store
}

function setup({ document, store = fakeStore(), pdf, getDocument, now = NOW } = {}) {
  const signwell = {
    getDocument:
      getDocument ??
      vi.fn(async () => ({
        id: DOC,
        status: 'Sent',
        metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' },
        recipients: [{ id: '1', status: 'sent-ish' }],
        ...document,
      })),
    getCompletedPdf: vi.fn(async () => pdf ?? Buffer.from('%PDF-1.4 signed')),
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const notifyOwners = vi.fn(async () => {})
  const afterSigned = vi.fn(async () => {})
  const state = { warnedUnconfigured: false, completing: new Set() }
  const deps = { store, signwell, log, notifyOwners, afterSigned, state, now, today: () => '2026-10-21' }
  const run = (rawBody, webhookId = WEBHOOK_ID) => handleSignwellWebhook({ rawBody, webhookId, deps })
  return { store, signwell, log, notifyOwners, afterSigned, state, deps, run }
}

const DONE = { status: 'Completed' }
const logged = (log) => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
const messages = (notifyOwners) => notifyOwners.mock.calls.map((call) => call[0].message)

describe('the SignWell webhook: authenticity', () => {
  it('answers 503 without a webhook id, and says so once per boot', async () => {
    const { run, log, store } = setup()
    const first = await run(delivery(), '')
    expect(first.status).toBe(503)
    await run(delivery(), null)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(store.getSignatureRequestByDocumentId).not.toHaveBeenCalled()
  })

  it('answers 400 for a body that is not JSON or has no event', async () => {
    const { run } = setup()
    expect((await run('not json')).status).toBe(400)
    expect((await run('{}')).status).toBe(400)
    expect((await run(JSON.stringify({ event: { time: 1 } }))).status).toBe(400)
  })

  it('answers 401 to a forged, wrong-length, malformed or missing hash, and touches nothing', async () => {
    const { run, store, signwell } = setup()
    for (const hash of ['0'.repeat(64), 'abc', '', undefined, `${hashOf('document_viewed', TIME)}0`, 'g'.repeat(64), 12345]) {
      const payload = JSON.parse(delivery())
      if (hash === undefined) delete payload.event.hash
      else payload.event.hash = hash
      expect((await run(JSON.stringify(payload))).status).toBe(401)
    }
    // A valid hash for a different type is a forgery too (the hash covers type and time).
    const swapped = JSON.parse(delivery({ type: 'document_viewed' }))
    swapped.event.type = 'document_completed'
    expect((await run(JSON.stringify(swapped))).status).toBe(401)
    expect(store.getSignatureRequestByDocumentId).not.toHaveBeenCalled()
    expect(store.recordSignwellEventOnce).not.toHaveBeenCalled()
    expect(store.updateSignatureRequest).not.toHaveBeenCalled()
    expect(signwell.getDocument).not.toHaveBeenCalled()
  })

  it('accepts a webhook id that carries stray whitespace (a pasted variable), the same as the id itself', async () => {
    const { run } = setup()
    expect((await run(delivery(), ` ${WEBHOOK_ID}\n`)).status).toBe(200)
  })

  it('refuses an event older than 45 days with a 400 and records nothing', async () => {
    const later = new Date((TIME + 46 * 24 * 3600) * 1000)
    const { run, store, signwell } = setup({ now: later })
    const answer = await run(delivery())
    expect(answer).toEqual({ status: 400, body: { error: 'Event too old' } })
    expect(store.recordSignwellEventOnce).not.toHaveBeenCalled()
    expect(signwell.getDocument).not.toHaveBeenCalled()
    // Just inside the window is processed.
    const inside = setup({ now: new Date((TIME + 44 * 24 * 3600) * 1000) })
    expect((await inside.run(delivery())).status).toBe(200)
  })

  it('answers a signed event for a document that is not ours with 200 ignored, and writes nothing', async () => {
    const { run, store, signwell } = setup()
    const answer = await run(delivery({ doc: 'doc-someone-else' }))
    expect(answer).toEqual({ status: 200, body: { received: true, ignored: true } })
    expect(store.recordSignwellEventOnce).not.toHaveBeenCalled()
    expect(signwell.getDocument).not.toHaveBeenCalled()
    const noId = JSON.parse(delivery())
    delete noId.data.object.id
    expect((await run(JSON.stringify(noId))).body.ignored).toBe(true)
  })
})

describe('the SignWell webhook: the status comes from the re-fetched document', () => {
  it('a viewed event re-fetches the document and moves the request to viewed', async () => {
    const { run, store, signwell } = setup()
    const answer = await run(delivery({ type: 'document_viewed' }))
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ received: true })
    expect(answer.after).toBeUndefined()
    expect(signwell.getDocument).toHaveBeenCalledWith(DOC)
    expect(store.state.request.status).toBe('viewed')
    expect(store.state.request.lastEventAt).toBe(new Date(TIME * 1000).toISOString())
    // SignWell's own per-recipient string is stored as given.
    expect(store.state.request.recipients[0].status).toBe('sent-ish')
  })

  it.each([
    ['Created', 'sent'],
    ['Sending', 'sent'],
    ['Sent', 'sent'],
    ['Viewed', 'viewed'],
    ['Pending', 'signed_partial'],
    ['Declined', 'declined'],
    ['Expired', 'expired'],
    ['Canceled', 'canceled'],
    ['Bounced', 'bounced'],
    ['Blocked', 'error'],
    ['Error', 'error'],
  ])('a document reading %s is recorded as %s', async (reads, expected) => {
    const { run, store } = setup({ document: { status: reads } })
    await run(delivery({ type: 'document_sent' }))
    expect(store.state.request.status).toBe(expected)
  })

  it('the event type only tells viewed from sent: documentStatus', () => {
    expect(documentStatus({ status: 'Sent' }, 'document_viewed')).toBe('viewed')
    expect(documentStatus({ status: 'Sent' }, 'document_sent')).toBe('sent')
    expect(documentStatus({ status: 'Sent' }, null)).toBe('sent')
    expect(documentStatus({ status: 'Completed' }, 'document_viewed')).toBe('completed')
    expect(documentStatus({ status: 'Declined' }, 'document_viewed')).toBe('declined')
    expect(documentStatus({ status: 'Draft' }, 'document_sent')).toBeNull()
    expect(documentStatus({ status: 'Something new' }, 'document_viewed')).toBeNull()
    expect(documentStatus(null, 'document_viewed')).toBeNull()
    expect(SIGNWELL_EVENT_STATUS.document_viewed).toBe('viewed')
  })

  it('a replayed declined event with a document that still reads Sent changes nothing', async () => {
    const { run, store } = setup({ document: { status: 'Sent' } })
    const answer = await run(delivery({ type: 'document_declined' }))
    expect(answer.status).toBe(200)
    expect(store.state.request.status).toBe('sent')
    for (const type of ['document_created', 'document_recipients_updated', 'document_something_new']) {
      const fresh = setup({ document: { status: 'Sent' } })
      await fresh.run(delivery({ type }))
      expect(fresh.store.state.request.status).toBe('sent')
      expect(fresh.store.state.request.lastEventAt).toBe(new Date(TIME * 1000).toISOString())
    }
  })

  it('a terminal document status wins over an older event type', async () => {
    const { run, store } = setup({ document: { status: 'Declined' } })
    await run(delivery({ type: 'document_viewed' }))
    expect(store.state.request.status).toBe('declined')
  })

  it('bounced is recoverable: a later re-fetch that reads Viewed replaces it', async () => {
    const bounced = setup({ document: { status: 'Bounced' } })
    await bounced.run(delivery({ type: 'document_bounced', time: TIME }))
    expect(bounced.store.state.request.status).toBe('bounced')
    bounced.signwell.getDocument.mockResolvedValue({ id: DOC, status: 'Viewed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    await bounced.run(delivery({ type: 'document_viewed', time: TIME + 10 }))
    expect(bounced.store.state.request.status).toBe('viewed')
    const errored = setup({ store: fakeStore({ request: { status: 'error' } }), document: { status: 'Sent' } })
    await errored.run(delivery({ type: 'document_sent' }))
    expect(errored.store.state.request.status).toBe('sent')
    const declined = setup({ store: fakeStore({ request: { status: 'declined' } }), document: { status: 'Viewed' } })
    await declined.run(delivery({ type: 'document_viewed' }))
    expect(declined.store.state.request.status).toBe('declined')
  })

  it('a document whose metadata is not this engagement\'s is ignored', async () => {
    for (const metadata of [{ app: 'other', engagement_id: 'eng-1' }, { app: 'pbjbillingapp', engagement_id: 'eng-2' }, undefined]) {
      const { run, store } = setup({ document: { metadata } })
      const answer = await run(delivery())
      expect(answer.body).toEqual({ received: true, ignored: true })
      expect(store.state.request.status).toBe('sent')
    }
  })

  it('a completion still applies after a LATER event stamped the clock (a finished status read from the document is not late news)', async () => {
    const { run, store } = setup({
      document: DONE,
      store: fakeStore({ request: { status: 'viewed', lastEventAt: new Date((TIME + 500) * 1000).toISOString() } }),
    })
    const answer = await run(delivery({ type: 'document_completed', time: TIME }))
    expect(store.state.request.status).toBe('completed')
    expect(typeof answer.after).toBe('function')
  })

  it('a delayed in-progress event after a completion changes nothing and starts no second job', async () => {
    const { run, store, signwell } = setup({ document: DONE })
    await (await run(delivery({ type: 'document_completed', time: TIME + 100 }))).after()
    const writes = store.state.signCalls.length
    const late = await run(delivery({ type: 'document_signed', time: TIME }))
    expect(late.body).toEqual({ received: true })
    expect(late.after).toBeUndefined()
    expect(store.state.request.status).toBe('completed')
    expect(store.state.signCalls).toHaveLength(writes)
    expect(signwell.getCompletedPdf).toHaveBeenCalledTimes(1)
  })
})

describe('the SignWell webhook: failures release the ledger so a retry is processed', () => {
  it('a failed re-fetch records last_error (redacted), forgets the event and answers 500', async () => {
    const getDocument = vi.fn(async () => {
      throw new Error('SignWell answered 500: pat@example.invalid is broken')
    })
    const { run, store, notifyOwners } = setup({ getDocument })
    const answer = await run(delivery({ type: 'document_viewed' }))
    expect(answer).toEqual({ status: 500, body: { error: 'Could not process the event' } })
    expect(store.state.request.status).toBe('sent')
    expect(store.state.request.lastError).toContain('document_viewed')
    expect(store.state.request.lastError).not.toContain('pat@example.invalid')
    expect(store.state.events.size).toBe(0)
    expect(notifyOwners).not.toHaveBeenCalled()
    getDocument.mockResolvedValue({ id: DOC, status: 'Viewed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    const retry = await run(delivery({ type: 'document_viewed' }))
    expect(retry.body).toEqual({ received: true })
    expect(store.state.request.status).toBe('viewed')
  })

  it('a failed re-fetch of the COMPLETED event tells the owners once, by name, and says what to press', async () => {
    const getDocument = vi.fn(async () => {
      throw new Error('boom')
    })
    const { run, notifyOwners, store } = setup({ getDocument })
    expect((await run(delivery({ type: 'document_completed' }))).status).toBe(500)
    expect(messages(notifyOwners)).toEqual([
      'Acme Books: SignWell reports a signed engagement letter, but the app could not read it - press Check SignWell to retry, or mark it signed by hand',
    ])
    expect(JSON.stringify(notifyOwners.mock.calls)).not.toContain('pat@example.invalid')
    await run(delivery({ type: 'document_completed' }))
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    expect(store.signEngagement).not.toHaveBeenCalled()
  })

  it('a store write that throws releases the key and the triple, and answers 500', async () => {
    const errors = []
    const { run, store, log } = setup({ store: fakeStore({ updateFails: new Error('db down for pat@example.invalid') }) })
    log.error.mockImplementation((...args) => errors.push(args))
    const answer = await run(delivery({ type: 'document_viewed' }))
    expect(answer).toEqual({ status: 500, body: { error: 'Could not process the event' } })
    expect(store.forgetSignwellEvent).toHaveBeenCalledTimes(2)
    expect(store.state.events.size).toBe(0)
    expect(JSON.stringify(errors)).not.toContain('pat@example.invalid')
  })

  it('a throw while recording the signed triple releases the event key too', async () => {
    const { run, store } = setup()
    const real = store.recordSignwellEventOnce.getMockImplementation()
    store.recordSignwellEventOnce.mockImplementation(async (key, type) => {
      if (store.recordSignwellEventOnce.mock.calls.length === 2) throw new Error('ledger down')
      return real(key, type)
    })
    const answer = await run(delivery())
    expect(answer.status).toBe(500)
    // The event key it took is gone, so SignWell's retry is processed.
    expect(store.state.events.size).toBe(0)
    store.recordSignwellEventOnce.mockImplementation(real)
    expect((await run(delivery())).body).toEqual({ received: true })
  })

  it('a completed event whose document does not read Completed: last_error, one named owner notice, key released, no clock stamp, 500', async () => {
    const { run, store, notifyOwners, signwell } = setup({ document: { status: 'Viewed' } })
    const answer = await run(delivery({ type: 'document_completed' }))
    expect(answer.status).toBe(500)
    expect(answer.after).toBeUndefined()
    expect(store.state.request.status).toBe('viewed')
    // Nothing was learned from the event's time, so the clock is not stamped.
    expect(store.state.request.lastEventAt).toBeNull()
    expect(store.state.request.lastError).toBe('SignWell reported it signed but the document reads Viewed - press Check SignWell to retry')
    expect(messages(notifyOwners)).toEqual([
      'Acme Books: SignWell reported it signed but the document reads Viewed - press Check SignWell to retry',
    ])
    expect(store.state.events.size).toBe(0)
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    await run(delivery({ type: 'document_completed' }))
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    signwell.getDocument.mockResolvedValue({ id: DOC, status: 'Completed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    const done = await run(delivery({ type: 'document_completed' }))
    expect(done.status).toBe(200)
    expect(typeof done.after).toBe('function')
  })

  it('a completed event that collides on the signed triple but whose document reads Viewed records the not-completed note, without a notice', async () => {
    const other = { id: 'sigreq-2', engagementId: 'eng-1', signwellDocumentId: 'doc-other', status: 'sent', recipients: [], completedAt: null, signedDocumentId: null, lastError: null }
    const { run, store, notifyOwners, signwell } = setup({ document: DONE, store: fakeStore({ others: [other] }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    const replayed = JSON.parse(delivery({ type: 'document_completed' }))
    replayed.data.object.id = 'doc-other'
    signwell.getDocument.mockResolvedValue({ id: 'doc-other', status: 'Viewed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    notifyOwners.mockClear()
    const answer = await run(JSON.stringify(replayed))
    expect(answer.body).toEqual({ received: true })
    expect(store.state.others[0].status).toBe('viewed')
    expect(store.state.others[0].lastError).toBe('SignWell reported it signed but the document reads Viewed - press Check SignWell to retry')
    expect(notifyOwners).not.toHaveBeenCalled()
  })

  it('a re-sync that completes a request stamps the completion when it was learned, not with the replayed event\'s time', async () => {
    const other = { id: 'sigreq-2', engagementId: 'eng-1', signwellDocumentId: 'doc-other', status: 'sent', recipients: [], completedAt: null, signedDocumentId: null, lastError: null, esignHash: null, testMode: false }
    const { run, store, signwell } = setup({ document: DONE, store: fakeStore({ others: [other] }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    const replayed = JSON.parse(delivery({ type: 'document_completed' }))
    replayed.data.object.id = 'doc-other'
    signwell.getDocument.mockResolvedValue({ id: 'doc-other', status: 'Completed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    const answer = await run(JSON.stringify(replayed))
    expect(store.state.others[0].completedAt).toBe(NOW.toISOString())
    await answer.after?.()
  })

  it('Manually completed: status completed, nothing signed, no PDF, the owners told what it means (by name, once)', async () => {
    const { run, store, notifyOwners, signwell } = setup({ document: { status: 'Manually completed' } })
    const answer = await run(delivery({ type: 'document_completed' }))
    expect(answer.status).toBe(200)
    expect(store.state.request.status).toBe('completed')
    expect(store.state.request.lastError).toBe(SIGNWELL_ISSUES.manual)
    // The note rides in the SAME update as the completed status: no moment shows a completed request without it.
    expect(store.state.updates.find((patch) => patch.status === 'completed')).toMatchObject({ lastError: SIGNWELL_ISSUES.manual })
    await answer.after()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    expect(store.state.stored).toHaveLength(0)
    expect(messages(notifyOwners)).toEqual([
      'Acme Books: Marked complete in SignWell, not signed by the client - mark it signed by hand if that is right',
    ])
  })
})

describe('the SignWell webhook: replays', () => {
  it('a replay of the same event is 200 duplicate with no second read and no second write', async () => {
    const { run, store, signwell } = setup()
    const body = delivery({ type: 'document_viewed' })
    expect((await run(body)).body).toEqual({ received: true })
    const writes = store.updateSignatureRequest.mock.calls.length
    const answer = await run(body)
    expect(answer).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(store.updateSignatureRequest.mock.calls.length).toBe(writes)
    expect(signwell.getDocument).toHaveBeenCalledTimes(1)
  })

  it('a replay with the hash in UPPER case or padded is the same event: duplicate, no second getDocument', async () => {
    const { run, store, signwell } = setup()
    expect((await run(delivery({ type: 'document_viewed' }))).body).toEqual({ received: true })
    const writes = store.updateSignatureRequest.mock.calls.length
    const upper = await run(delivery({ type: 'document_viewed', hash: hashOf('document_viewed', TIME).toUpperCase() }))
    expect(upper).toEqual({ status: 200, body: { received: true, duplicate: true } })
    const padded = await run(delivery({ type: 'document_viewed', hash: ` ${hashOf('document_viewed', TIME)} ` }))
    expect(padded.body).toEqual({ received: true, duplicate: true })
    expect(signwell.getDocument).toHaveBeenCalledTimes(1)
    expect(store.updateSignatureRequest.mock.calls.length).toBe(writes)
    expect(store.state.events.size).toBe(2)
  })

  it('a different time or type is a different event; the signer is not part of the key', async () => {
    const { run } = setup()
    expect((await run(delivery({ type: 'document_viewed' }))).body.duplicate).toBeUndefined()
    expect((await run(delivery({ type: 'document_viewed', time: TIME + 5 }))).body.duplicate).toBeUndefined()
    expect((await run(delivery({ type: 'document_signed' }))).body.duplicate).toBeUndefined()
    expect((await run(delivery({ type: 'document_viewed', signer: 'other@example.invalid' }))).body.duplicate).toBe(true)
    expect((await run(delivery({ type: 'document_viewed', signer: null }))).body.duplicate).toBe(true)
  })

  it('keys the ledger on what the HMAC covers plus the document - canonical hashes only, never an address', async () => {
    const { run, store } = setup()
    await run(delivery())
    const hash = hashOf('document_viewed', TIME)
    const expected = [
      eventKey({ documentId: DOC, type: 'document_viewed', time: TIME, hash }),
      signedTripleKey({ type: 'document_viewed', time: TIME, hash }),
    ]
    expect([...store.state.events].sort()).toEqual([...expected].sort())
    for (const key of store.state.events) expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify([...store.state.events])).not.toContain('example.invalid')
    expect(expected[0]).not.toBe(expected[1])
    expect(eventKey({ documentId: 'other', type: 'document_viewed', time: TIME, hash })).not.toBe(expected[0])
    // The spelling of the hash does not matter to either key.
    expect(eventKey({ documentId: DOC, type: 'document_viewed', time: TIME, hash: hash.toUpperCase() })).toBe(expected[0])
    expect(signedTripleKey({ type: 'document_viewed', time: TIME, hash: ` ${hash.toUpperCase()}` })).toBe(expected[1])
  })

  const other = () => ({ id: 'sigreq-2', engagementId: 'eng-1', signwellDocumentId: 'doc-other', status: 'sent', recipients: [], completedAt: null, signedDocumentId: null, lastError: null })

  it('the same signed event for ANOTHER of our documents is a plain re-sync: the document alone decides, the event type does nothing', async () => {
    // The other document's request shares the engagement id here only so its metadata check passes in this fake.
    const { run, store, signwell } = setup({ store: fakeStore({ others: [other()] }) })
    const body = delivery({ type: 'document_viewed' })
    expect((await run(body)).body).toEqual({ received: true })
    expect(store.state.request.status).toBe('viewed')
    const replayed = JSON.parse(body)
    replayed.data.object.id = 'doc-other'
    signwell.getDocument.mockResolvedValue({ id: 'doc-other', status: 'Sent', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    store.updateSignatureRequest.mockClear()
    const answer = await run(JSON.stringify(replayed))
    expect(answer.body).toEqual({ received: true })
    // "viewed" came from the event type, which a re-sync ignores: the document reads Sent, so the status stays sent,
    // and the clock is not stamped from the replayed event.
    const patch = store.updateSignatureRequest.mock.calls[0][1]
    expect(patch.status).toBe('sent')
    expect(patch).not.toHaveProperty('lastEventAt')
    // Its own key is kept: delivering it again is a duplicate; the first document's key is untouched.
    expect((await run(JSON.stringify(replayed))).body).toEqual({ received: true, duplicate: true })
    expect((await run(body)).body).toEqual({ received: true, duplicate: true })
  })

  it('a replayed declined/completed capture against another document does nothing its own state does not: it reads Sent, so nothing changes', async () => {
    const { run, store, signwell, notifyOwners } = setup({ document: DONE, store: fakeStore({ others: [other()] }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    const replayed = JSON.parse(delivery({ type: 'document_completed' }))
    replayed.data.object.id = 'doc-other'
    signwell.getDocument.mockResolvedValue({ id: 'doc-other', status: 'Sent', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    const answer = await run(JSON.stringify(replayed))
    expect(answer.body).toEqual({ received: true })
    expect(answer.after).toBeUndefined()
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
    expect(signwell.getCompletedPdf).toHaveBeenCalledTimes(1)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('a genuine event for a second document in the same second still lands: the collision with a Completed document completes it', async () => {
    const second = { ...other(), createdBy: 'emp-patrice', esignHash: null, testMode: false }
    const { run, store, signwell } = setup({ document: { status: 'Viewed' }, store: fakeStore({ others: [second] }) })
    // Two documents really do complete in the same second: first DOC, then the other one with the same signed triple.
    signwell.getDocument.mockImplementation(async (id) => ({ id, status: 'Completed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } }))
    const first = await run(delivery({ type: 'document_completed', time: TIME, doc: DOC }))
    expect(first.status).toBe(200)
    await first.after()
    expect(store.state.request.status).toBe('completed')
    const collided = await run(delivery({ type: 'document_completed', time: TIME, doc: 'doc-other' }))
    expect(collided.status).toBe(200)
    expect(typeof collided.after).toBe('function')
    await collided.after()
    expect(signwell.getCompletedPdf).toHaveBeenCalledWith('doc-other')
  })

  it('after a failure the same event for the same document is processed again (the keys it took were released)', async () => {
    const getDocument = vi.fn()
    getDocument.mockRejectedValueOnce(new Error('down'))
    getDocument.mockResolvedValue({ id: DOC, status: 'Viewed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' } })
    const { run, store } = setup({ getDocument })
    expect((await run(delivery())).status).toBe(500)
    expect(store.state.events.size).toBe(0)
    expect((await run(delivery())).body).toEqual({ received: true })
    expect(store.state.request.status).toBe('viewed')
  })

  it('a failure on a collided delivery releases only its own key, never the other document\'s triple', async () => {
    const { run, store, signwell } = setup({ store: fakeStore({ others: [other()] }) })
    await run(delivery({ type: 'document_viewed' }))
    const triple = signedTripleKey({ type: 'document_viewed', time: TIME, hash: hashOf('document_viewed', TIME) })
    const replayed = JSON.parse(delivery({ type: 'document_viewed' }))
    replayed.data.object.id = 'doc-other'
    signwell.getDocument.mockRejectedValue(new Error('down'))
    expect((await run(JSON.stringify(replayed))).status).toBe(500)
    expect(store.state.events.has(triple)).toBe(true)
  })
})

describe('the SignWell webhook: completion', () => {
  it('answers 200 FIRST, marks it as finishing, then stores the PDF, signs and notifies with names only', async () => {
    const { run, store, signwell, notifyOwners, afterSigned, state } = setup({ document: DONE })
    const answer = await run(delivery({ type: 'document_completed' }))
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ received: true })
    expect(typeof answer.after).toBe('function')
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(store.state.request.status).toBe('completed')
    expect(store.state.request.finishingAt).toBe(NOW.toISOString())
    expect(state.completing.has('sigreq-1')).toBe(true)

    await answer.after()

    expect(signwell.getCompletedPdf).toHaveBeenCalledWith(DOC)
    expect(store.state.stored).toHaveLength(1)
    expect(store.state.stored[0].signatureRequestId).toBe('sigreq-1')
    expect(store.state.stored[0].fileName).toBe('Signed-Engagement-Letter-Acme-Books.pdf')
    expect(store.state.stored[0].bytes.subarray(0, 4).toString()).toBe('%PDF')
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
    expect(store.state.request.completedAt).toBe(new Date(TIME * 1000).toISOString())
    expect(store.state.signCalls).toEqual([
      {
        id: 'eng-1',
        options: {
          signedOn: '2025-10-20',
          note: 'Signed electronically through SignWell',
          userId: 'emp-patrice',
          confirmChanged: false,
        },
      },
    ])
    expect(afterSigned).toHaveBeenCalledTimes(1)
    expect(afterSigned.mock.calls[0][2]).toBe('emp-patrice')
    expect(store.state.request.lastError).toBeNull()
    expect(store.state.request.finishingAt).toBeNull()
    expect(messages(notifyOwners)).toEqual(['Acme Books signed their engagement letter electronically'])
    expect(notifyOwners.mock.calls[0][0]).toMatchObject({ link: '/engagements/eng-1' })
    const notice = JSON.stringify(notifyOwners.mock.calls)
    expect(notice).not.toContain('example.invalid')
    expect(notice).not.toMatch(/attachment|pdf|bytes/i)
    expect(state.completing.has('sigreq-1')).toBe(false)
  })

  it('TEST MODE never signs a real client: everything but signEngagement runs, and the owners are told how to proceed', async () => {
    const { run, store, notifyOwners, afterSigned } = setup({
      document: DONE,
      store: fakeStore({ request: { testMode: true } }),
    })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.state.request.status).toBe('completed')
    expect(store.state.stored).toHaveLength(1)
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(afterSigned).not.toHaveBeenCalled()
    expect(store.state.request.lastError).toBe('Test mode - not marked signed; use Mark as signed if this was a real signature')
    expect(messages(notifyOwners)).toEqual([
      'Acme Books signed their engagement letter electronically (test mode). Test mode - not marked signed; use Mark as signed if this was a real signature',
    ])
  })

  it('test mode on a letter linked to a real client is refused too, by the CLIENT name', async () => {
    const real = setup({ document: DONE, store: fakeStore({ request: { testMode: true }, engagement: { clientId: 'client-9', party: { company: 'Test', contactName: 'Pat' } }, clientName: 'Acme Books' }) })
    await (await real.run(delivery({ type: 'document_completed' }))).after()
    expect(real.store.signEngagement).not.toHaveBeenCalled()
    // Exactly "Test" (not "Test Co" or "test").
    for (const name of ['Test Co', 'test', 'Testing']) {
      const wrong = setup({ document: DONE, store: fakeStore({ request: { testMode: true }, engagement: { clientId: 'c' }, clientName: name }) })
      await (await wrong.run(delivery({ type: 'document_completed' }))).after()
      expect(wrong.store.signEngagement, name).not.toHaveBeenCalled()
    }
  })

  it('test mode signs the existing Test client\'s letter', async () => {
    const byClient = setup({ document: DONE, store: fakeStore({ request: { testMode: true }, engagement: { clientId: 'client-test' }, clientName: ' Test ' }) })
    await (await byClient.run(delivery({ type: 'document_completed' }))).after()
    expect(byClient.store.signEngagement).toHaveBeenCalledTimes(1)
    expect(messages(byClient.notifyOwners)[0]).toContain('(test mode)')
  })

  it('test mode does NOT sign a prospect whose party is named Test: signing would create a second Test client', async () => {
    const { run, store, notifyOwners } = setup({
      document: DONE,
      store: fakeStore({ request: { testMode: true }, engagement: { clientId: null, party: { company: 'Test', contactName: 'Test', email: 'pat@example.invalid' } } }),
    })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(store.getClientById).not.toHaveBeenCalled()
    expect(store.state.request.lastError).toBe('Test mode - not marked signed; use Mark as signed if this was a real signature')
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('test mode does not sign when the client cannot be read', async () => {
    const store = fakeStore({ request: { testMode: true }, engagement: { clientId: 'client-test' } })
    store.getClientById.mockRejectedValue(new Error('db down'))
    const { run } = setup({ document: DONE, store })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).not.toHaveBeenCalled()
  })

  it('live mode signs a real client as always', async () => {
    const { run, store } = setup({ document: DONE, store: fakeStore({ request: { testMode: false }, engagement: { clientId: 'c' }, clientName: 'Acme Books' }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
  })

  it('signs only what the client was sent: a letter changed after it went to SignWell is left for a person', async () => {
    const { run, store, notifyOwners, afterSigned } = setup({
      document: DONE,
      store: fakeStore({ request: { esignHash: 'f'.repeat(64) } }),
    })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.state.request.status).toBe('completed')
    expect(store.state.stored).toHaveLength(1)
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(afterSigned).not.toHaveBeenCalled()
    expect(store.state.request.lastError).toBe(SIGNWELL_ISSUES.changed)
    expect(store.state.request.lastError).toBe(
      'The letter or its signing details changed after it went to SignWell - the client signed the earlier version; finish by hand',
    )
    expect(store.state.request.finishingAt).toBeNull()
    expect(messages(notifyOwners)).toEqual([
      'Acme Books signed their engagement letter electronically. The letter or its signing details changed after it went to SignWell - the client signed the earlier version; finish by hand',
    ])
    expect(JSON.stringify(notifyOwners.mock.calls)).not.toContain('example.invalid')
  })

  it('a change to the signing details (package, plans, fee choice, figures, retainer) is a change too; plan order is not', async () => {
    const edits = [
      (eng) => { eng.packageId = 'pkg-1' },
      (eng) => { eng.planIds = ['plan-1'] },
      (eng) => { eng.feeMode = 'add' },
      (eng) => { eng.figures = { totals: { monthly: 200 } } },
      (eng) => { eng.retainerAmount = 500 },
      (eng) => { eng.subject = 'A different subject' },
      (eng) => { eng.party = { ...eng.party, email: 'else@example.invalid' } },
    ]
    for (const edit of edits) {
      const { run, store } = setup({ document: DONE })
      edit(store.state.engagement)
      await (await run(delivery({ type: 'document_completed' }))).after()
      expect(store.signEngagement, String(edit)).not.toHaveBeenCalled()
      expect(store.state.request.lastError).toBe(SIGNWELL_ISSUES.changed)
    }
    // The order plans were listed in is not a change.
    const withPlans = fakeStore({ engagement: { planIds: ['b', 'a'] } })
    const { run, store } = setup({ document: DONE, store: withPlans })
    store.state.engagement.planIds = ['a', 'b']
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
  })

  it('refuses to sign when the row carries no hash (a request from before hashes)', async () => {
    const { run, store } = setup({ document: DONE, store: fakeStore({ request: { esignHash: null } }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(store.state.request.lastError).toBe(SIGNWELL_ISSUES.changed)
  })

  it('a superseding letter with an open amendment is NOT auto-signed: PDF kept, reason recorded, owners told', async () => {
    for (const status of ['draft', 'sent', 'signed']) {
      const { run, store, notifyOwners, signwell } = setup({
        document: DONE,
        store: fakeStore({
          engagement: { kind: 'superseding', clientId: 'client-9' },
          amendments: [{ id: 'eng-9', kind: 'amendment', status }],
        }),
      })
      await (await run(delivery({ type: 'document_completed' }))).after()
      expect(store.listEngagements).toHaveBeenCalledWith({ clientId: 'client-9' })
      expect(store.signEngagement, status).not.toHaveBeenCalled()
      expect(signwell.getCompletedPdf).toHaveBeenCalledTimes(1)
      expect(store.state.stored).toHaveLength(1)
      expect(store.state.request.lastError).toBe('Choose which amendments to keep - finish by hand')
      expect(messages(notifyOwners)).toEqual([
        'Acme Books signed their engagement letter electronically. Choose which amendments to keep - finish by hand',
      ])
    }
  })

  it('a superseding letter whose amendments are all void or superseded (or are not amendments) is signed', async () => {
    const { run, store } = setup({
      document: DONE,
      store: fakeStore({
        engagement: { kind: 'superseding', clientId: 'client-9' },
        amendments: [
          { id: 'a', kind: 'amendment', status: 'void' },
          { id: 'b', kind: 'amendment', status: 'superseded' },
          { id: 'c', kind: 'original', status: 'signed' },
        ],
      }),
    })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
  })

  it('a superseding letter whose amendments cannot be read is left for a person (retry works), not signed blind', async () => {
    const store = fakeStore({ engagement: { kind: 'superseding', clientId: 'client-9' } })
    store.listEngagements.mockRejectedValue(new Error('db down'))
    const { run } = setup({ document: DONE, store })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(store.state.request.lastError).toBe(
      "It could not be marked signed: the client's open amendments could not be checked - press Finish e-signature to retry",
    )
  })

  it('signs as the owner who sent it, or - if they are no longer an owner - the first active owner', async () => {
    const gone = setup({ document: DONE, store: fakeStore({ request: { createdBy: 'emp-left' } }) })
    await (await gone.run(delivery({ type: 'document_completed' }))).after()
    expect(gone.store.state.signCalls[0].options.userId).toBe('emp-patrice')
    const staff = setup({ document: DONE, store: fakeStore({ request: { createdBy: 'emp-staff' } }) })
    await (await staff.run(delivery({ type: 'document_completed' }))).after()
    expect(staff.store.state.signCalls[0].options.userId).toBe('emp-patrice')
    const second = setup({ document: DONE, store: fakeStore({ request: { createdBy: 'emp-two' } }) })
    await (await second.run(delivery({ type: 'document_completed' }))).after()
    expect(second.store.state.signCalls[0].options.userId).toBe('emp-two')
    expect(second.afterSigned.mock.calls[0][2]).toBe('emp-two')
  })

  it('never signs on a day after today', async () => {
    const future = setup({ document: DONE, store: fakeStore({ request: { completedAt: '2027-03-01T15:00:00.000Z' } }) })
    await (await future.run(delivery({ type: 'document_completed' }))).after()
    expect(future.store.state.signCalls[0].options.signedOn).toBe('2026-10-21')
  })

  it('a refused signing records last_error with the plain reason (finish by hand) and tells the owners', async () => {
    const refusal = Object.assign(new Error('Acme Books is retired, so the letter cannot bring plans to them.'), { name: 'EngagementStateError', reason: 'client_retired' })
    const { run, store, notifyOwners, afterSigned } = setup({ document: DONE, store: fakeStore({ signRefusal: refusal }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.state.stored).toHaveLength(1)
    expect(afterSigned).not.toHaveBeenCalled()
    expect(store.state.request.lastError).toBe(
      'It could not be marked signed: Acme Books is retired, so the letter cannot bring plans to them. - finish it by hand',
    )
    expect(messages(notifyOwners)).toEqual([
      'Acme Books signed their engagement letter electronically. It could not be marked signed: Acme Books is retired, so the letter cannot bring plans to them. - finish it by hand',
    ])
  })

  it('an unexpected error while signing says to press Finish e-signature to retry, without its text', async () => {
    const boom = Object.assign(new Error('relation "x" does not exist at pat@example.invalid'), { name: 'Error' })
    const { run, store, notifyOwners, log } = setup({ document: DONE, store: fakeStore({ signRefusal: boom }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.state.request.lastError).toBe(
      'It could not be marked signed: an unexpected error stopped it - see the server log - press Finish e-signature to retry',
    )
    expect(store.state.request.lastError).not.toContain('relation')
    expect(messages(notifyOwners)[0]).toContain('press Finish e-signature to retry')
    expect(logged(log)).not.toContain('pat@example.invalid')
  })

  it('a failed PDF download still marks the engagement signed and says to retry or download it from SignWell', async () => {
    const { run, store, signwell, notifyOwners } = setup({ document: DONE })
    signwell.getCompletedPdf.mockRejectedValue(new Error('SignWell answered 400'))
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.state.stored).toHaveLength(0)
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
    expect(store.state.request.lastError).toBe('The signed PDF could not be saved - press Finish e-signature to retry, or download it from SignWell')
    expect(messages(notifyOwners)).toEqual([
      'Acme Books signed their engagement letter electronically. The signed PDF could not be saved - press Finish e-signature to retry, or download it from SignWell',
    ])
  })

  it('an engagement already marked signed by hand is not signed again, and still gets its PDF and a notice', async () => {
    const { run, store, notifyOwners } = setup({ document: DONE, store: fakeStore({ engagement: { status: 'signed' } }) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(store.state.stored).toHaveLength(1)
    expect(store.state.request.lastError).toBeNull()
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('a second completed delivery while the first is still finishing, or after it, does no second job', async () => {
    const { run, store, state } = setup({ document: DONE })
    const first = await run(delivery({ type: 'document_completed' }))
    const during = await run(delivery({ type: 'document_completed', time: TIME + 1 }))
    expect(during.after).toBeUndefined()
    await first.after()
    const after = await run(delivery({ type: 'document_completed', time: TIME + 2 }))
    expect(after.after).toBeUndefined()
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
    expect(store.state.stored).toHaveLength(1)
    expect(state.completing.size).toBe(0)
  })

  it('never throws out of the after-response work, and frees the in-flight mark', async () => {
    const store = fakeStore()
    store.getEngagement.mockRejectedValue(new Error('db down'))
    const { run, state, log, notifyOwners } = setup({ document: DONE, store })
    const answer = await run(delivery({ type: 'document_completed' }))
    await expect(answer.after()).resolves.toBeUndefined()
    expect(state.completing.size).toBe(0)
    expect(log.error).toHaveBeenCalled()
    expect(notifyOwners).toHaveBeenCalled()
    expect(store.state.request.finishingAt).toBeNull()
  })

  it('logs ids and event types only: no address, no key, no document bytes', async () => {
    const { run, log } = setup({ document: DONE, pdf: Buffer.from(`%PDF-1.4 ${'A'.repeat(500)}`) })
    await (await run(delivery({ type: 'document_completed' }))).after()
    await run(delivery({ type: 'document_viewed', time: TIME + 9 }))
    const text = logged(log)
    expect(text).not.toContain('example.invalid')
    expect(text).not.toContain(WEBHOOK_ID)
    expect(text).not.toContain('AAAAAAAAAA')
  })
})

describe('finishSignatureRequest ("Check SignWell" / "Finish e-signature")', () => {
  /** A request that completed, then the server died mid-finish: marked finishing, no PDF, engagement unsigned. */
  const crashed = (extra = {}) => ({ status: 'completed', completedAt: new Date(TIME * 1000).toISOString(), finishingAt: new Date(TIME * 1000).toISOString(), ...extra })

  it('re-runs the work after a crash: the PDF is fetched and kept once, the engagement signed, finishing cleared, no notice', async () => {
    const { deps, store, signwell, notifyOwners } = setup({ document: DONE, store: fakeStore({ request: crashed() }) })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.ok).toBe(true)
    expect(result.signed).toBe(true)
    expect(signwell.getCompletedPdf).toHaveBeenCalledTimes(1)
    expect(store.state.stored).toHaveLength(1)
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
    expect(result.request.finishingAt).toBeNull()
    expect(result.request.signedDocumentId).toBe('sigdoc-1')
    expect(result.request.lastError).toBeNull()
    expect(notifyOwners).not.toHaveBeenCalled()
    expect(deps.state.completing.size).toBe(0)
  })

  it('on a request that is not finished (viewed) whose document reads Completed, it completes it', async () => {
    const { deps, store, signwell, notifyOwners } = setup({ document: DONE, store: fakeStore({ request: { status: 'viewed' } }) })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.ok).toBe(true)
    expect(result.request.status).toBe('completed')
    expect(result.request.completedAt).toBe(NOW.toISOString())
    expect(signwell.getCompletedPdf).toHaveBeenCalledTimes(1)
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
    // It was the first completion the app learned of: the owners hear it.
    expect(messages(notifyOwners)).toEqual(['Acme Books signed their engagement letter electronically'])
  })

  it('on a request whose document still reads Viewed it just re-syncs the status and runs nothing', async () => {
    const { deps, store, signwell } = setup({ document: { status: 'Viewed' }, store: fakeStore({ request: { status: 'sent' } }) })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result).toMatchObject({ ok: true, signed: false, issues: [] })
    expect(result.request.status).toBe('viewed')
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    expect(store.signEngagement).not.toHaveBeenCalled()
  })

  it('recovers a bounced request whose document reads Sent again', async () => {
    const { deps } = setup({ document: { status: 'Sent' }, store: fakeStore({ request: { status: 'bounced' } }) })
    expect((await finishSignatureRequest('sigreq-1', deps)).request.status).toBe('sent')
  })

  it('on an already finished request it is a no-op: no second PDF, no second signing, no notice', async () => {
    const { deps, store, signwell, notifyOwners } = setup({
      document: DONE,
      store: fakeStore({ request: crashed({ finishingAt: null, signedDocumentId: 'sigdoc-1' }), engagement: { status: 'signed' } }),
    })
    store.state.stored.push({ id: 'sigdoc-1', signatureRequestId: 'sigreq-1', fileName: 'x.pdf', bytes: Buffer.from('%PDF') })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.ok).toBe(true)
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(store.state.stored).toHaveLength(1)
    expect(notifyOwners).not.toHaveBeenCalled()
  })

  it('never stores a second PDF even when asked to fetch again', async () => {
    const { deps, store } = setup({ document: DONE, store: fakeStore({ request: crashed() }) })
    store.state.stored.push({ id: 'sigdoc-1', signatureRequestId: 'sigreq-1', fileName: 'x.pdf', bytes: Buffer.from('%PDF-old') })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.ok).toBe(true)
    expect(store.state.stored).toHaveLength(1)
    expect(result.request.signedDocumentId).toBe('sigdoc-1')
  })

  it('still refuses a changed letter, says so once, and does not say it again when pressed again', async () => {
    const { deps, store, notifyOwners } = setup({ document: DONE, store: fakeStore({ request: crashed({ esignHash: 'f'.repeat(64) }) }) })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.ok).toBe(true)
    expect(result.signed).toBe(false)
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(result.request.lastError).toBe(SIGNWELL_ISSUES.changed)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    await finishSignatureRequest('sigreq-1', deps)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown request, one that ended, one being finished, a request marked completed whose document is not, and a document it cannot read', async () => {
    expect((await finishSignatureRequest('sigreq-nope', setup().deps)).refused).toMatchObject({ status: 404 })

    for (const status of ['declined', 'expired', 'canceled']) {
      const ended = setup({ document: DONE, store: fakeStore({ request: { status } }) })
      expect((await finishSignatureRequest('sigreq-1', ended.deps)).refused).toMatchObject({ status: 409, error: 'ended' })
    }

    const busy = setup({ document: DONE, store: fakeStore({ request: crashed() }) })
    busy.state.completing.add('sigreq-1')
    expect((await finishSignatureRequest('sigreq-1', busy.deps)).refused).toMatchObject({ status: 409, error: 'finishing' })

    const viewed = setup({ document: { status: 'Viewed' }, store: fakeStore({ request: crashed() }) })
    expect((await finishSignatureRequest('sigreq-1', viewed.deps)).refused).toMatchObject({ status: 409, error: 'not_completed' })

    const unknown = setup({ document: { status: 'Draft' }, store: fakeStore({ request: crashed() }) })
    expect((await finishSignatureRequest('sigreq-1', unknown.deps)).refused).toMatchObject({ status: 409, error: 'not_completed' })
  })

  it('a manually completed document is recorded as such (stamped completed now) and nothing is signed', async () => {
    const { deps, store, signwell, notifyOwners } = setup({ document: { status: 'Manually completed' }, store: fakeStore({ request: { status: 'viewed' } }) })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result).toMatchObject({ ok: true, signed: false, issues: [SIGNWELL_ISSUES.manual] })
    expect(result.request.status).toBe('completed')
    expect(result.request.completedAt).toBe(NOW.toISOString())
    expect(store.state.updates.find((patch) => patch.status === 'completed')).toMatchObject({ lastError: SIGNWELL_ISSUES.manual })
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    expect(messages(notifyOwners)).toEqual([`Acme Books: ${SIGNWELL_ISSUES.manual}`])
    await finishSignatureRequest('sigreq-1', deps)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('answers 502 when SignWell cannot be read, and changes nothing', async () => {
    const errors = vi.fn()
    const { deps, store } = setup({ getDocument: vi.fn(async () => { throw new Error('down for pat@example.invalid') }), store: fakeStore({ request: crashed() }) })
    deps.log = { info: vi.fn(), warn: vi.fn(), error: errors }
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.refused).toMatchObject({ status: 502, error: 'esign_failed' })
    expect(store.signEngagement).not.toHaveBeenCalled()
    // Changes nothing: not even a write.
    expect(store.updateSignatureRequest).not.toHaveBeenCalled()
    expect(JSON.stringify(errors.mock.calls)).not.toContain('pat@example.invalid')
    expect(deps.state.completing.size).toBe(0)
  })

  it('a webhook completion that landed while Finish was reading the document is not swallowed: Finish completes it, once', async () => {
    const { deps, store, signwell, run, notifyOwners } = setup({ store: fakeStore({ request: { status: 'sent' } }) })
    const meta = { app: 'pbjbillingapp', engagement_id: 'eng-1' }
    let releaseFirst
    let reads = 0
    signwell.getDocument.mockImplementation(() => {
      reads += 1
      // Finish's read is slow and sees Viewed; the webhook's own read (while Finish holds the lock) sees Completed.
      if (reads === 1) return new Promise((resolve) => { releaseFirst = () => resolve({ id: DOC, status: 'Viewed', metadata: meta }) })
      return Promise.resolve({ id: DOC, status: 'Completed', metadata: meta, recipients: [] })
    })
    const finishing = finishSignatureRequest('sigreq-1', deps)
    await vi.waitFor(() => expect(reads).toBe(1))
    // The completed webhook runs now: the request becomes completed, but Finish holds the lock, so no job starts.
    const hook = await run(delivery({ type: 'document_completed' }))
    expect(hook.status).toBe(200)
    expect(hook.after).toBeUndefined()
    expect(store.state.request.status).toBe('completed')
    expect(store.signEngagement).not.toHaveBeenCalled()
    releaseFirst()
    const result = await finishing
    expect(result.ok).toBe(true)
    expect(result.signed).toBe(true)
    expect(result.request.status).toBe('completed')
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
    expect(signwell.getCompletedPdf).toHaveBeenCalledTimes(1)
    expect(store.state.stored).toHaveLength(1)
    expect(store.state.request.finishingAt).toBeNull()
    // First completion semantics: the owners hear it once.
    expect(messages(notifyOwners)).toEqual(['Acme Books signed their engagement letter electronically'])
    expect(deps.state.completing.size).toBe(0)
  })

  it('two presses at once run it ONCE: the second is refused as finishing, with no false "someone else" error from signing', async () => {
    const { deps, store, signwell } = setup({ document: DONE, store: fakeStore({ request: crashed() }) })
    let release
    const real = signwell.getDocument.getMockImplementation()
    signwell.getDocument.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(real()) }))
    const first = finishSignatureRequest('sigreq-1', deps)
    const second = await finishSignatureRequest('sigreq-1', deps)
    expect(second.refused).toMatchObject({ status: 409, error: 'finishing' })
    release()
    const done = await first
    expect(done.ok).toBe(true)
    expect(done.signed).toBe(true)
    expect(store.signEngagement).toHaveBeenCalledTimes(1)
    expect(signwell.getCompletedPdf).toHaveBeenCalledTimes(1)
    expect(store.state.request.lastError).toBeNull()
    expect(deps.state.completing.size).toBe(0)
    // Released afterwards, on every way out.
    expect((await finishSignatureRequest('sigreq-1', deps)).ok).toBe(true)
  })
})

describe('eventTimeIso', () => {
  it('reads epoch seconds, epoch milliseconds, numeric text and date strings; falls back to now', () => {
    const now = new Date('2026-10-21T12:00:00.000Z')
    expect(eventTimeIso(1760990000)).toBe('2025-10-20T19:53:20.000Z')
    expect(eventTimeIso(1760990000000)).toBe('2025-10-20T19:53:20.000Z')
    expect(eventTimeIso('1760990000')).toBe('2025-10-20T19:53:20.000Z')
    expect(eventTimeIso('2026-10-21T10:00:00Z')).toBe('2026-10-21T10:00:00.000Z')
    expect(eventTimeIso('garbage', now)).toBe('2026-10-21T12:00:00.000Z')
    expect(eventTimeIso(undefined, now)).toBe('2026-10-21T12:00:00.000Z')
  })
})

/**
 * featreq-60118b28 item 12: Finish racing a MANUAL completion. Finish reads the document (Viewed) while the
 * webhook records "Manually completed" (completed, nothing signed); the store keeps the request completed, and
 * Finish's fall-through - meant for a REAL completion that landed meanwhile - must not sign the letter.
 */
describe('finishSignatureRequest racing a manual completion (featreq-60118b28)', () => {
  it('a MANUAL completion that landed while Finish was reading is never signed by Finish', async () => {
    const { deps, store, signwell, run, notifyOwners } = setup({ store: fakeStore({ request: { status: 'sent' } }) })
    const meta = { app: 'pbjbillingapp', engagement_id: 'eng-1' }
    let releaseFirst
    let reads = 0
    signwell.getDocument.mockImplementation(() => {
      reads += 1
      if (reads === 1) return new Promise((resolve) => { releaseFirst = () => resolve({ id: DOC, status: 'Viewed', metadata: meta }) })
      return Promise.resolve({ id: DOC, status: 'Manually completed', metadata: meta, recipients: [] })
    })
    const finishing = finishSignatureRequest('sigreq-1', deps)
    await vi.waitFor(() => expect(reads).toBe(1))
    const hook = await run(delivery({ type: 'document_completed' }))
    expect(hook.status).toBe(200)
    expect(store.state.request.status).toBe('completed')
    expect(store.state.request.lastError).toBe(SIGNWELL_ISSUES.manual)
    await hook.after?.()
    releaseFirst()
    const result = await finishing
    expect(result).toMatchObject({ ok: true, signed: false, issues: [SIGNWELL_ISSUES.manual] })
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    expect(store.state.stored).toHaveLength(0)
    expect(store.state.request.finishingAt).toBeNull()
    expect(store.state.request.lastError).toBe(SIGNWELL_ISSUES.manual)
    // Told once, by the webhook: Finish adds no "signed electronically" notice.
    expect(messages(notifyOwners)).toEqual([`Acme Books: ${SIGNWELL_ISSUES.manual}`])
    expect(deps.state.completing.size).toBe(0)
  })

  it('a later completed delivery for a request already manually completed starts no completion', async () => {
    const store = fakeStore({ request: { status: 'completed', completedAt: '2026-10-21T15:00:00.000Z', lastError: SIGNWELL_ISSUES.manual } })
    const { run } = setup({ store, document: DONE })
    const answer = await run(delivery({ type: 'document_completed', time: TIME + 5 }))
    expect(answer.status).toBe(200)
    expect(answer.after).toBeUndefined()
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(store.state.request.finishingAt).toBeNull()
  })
})

describe('a request the app withdrew, and the re-sync note (featreq-60118b28)', () => {
  it('Check SignWell refuses a withdrawn request as ended, without reading SignWell', async () => {
    const { deps, signwell } = setup({ store: fakeStore({ request: { status: 'withdrawn' } }) })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'ended' })
    expect(signwell.getDocument).not.toHaveBeenCalled()
  })

  it('a completed delivery for a withdrawn request changes nothing and signs nothing', async () => {
    const store = fakeStore({ request: { status: 'withdrawn' } })
    const { run } = setup({ store, document: DONE })
    const answer = await run(delivery({ type: 'document_completed' }))
    expect(answer.status).toBe(200)
    expect(answer.after).toBeUndefined()
    expect(store.state.request.status).toBe('withdrawn')
    expect(store.signEngagement).not.toHaveBeenCalled()
  })

  it('Finish racing a withdrawal (the letter voided while the document is read as Completed): refused, nothing signed', async () => {
    const store = fakeStore({ request: { status: 'viewed' } })
    const getDocument = vi.fn(async () => {
      store.state.request.status = 'withdrawn'
      return { id: DOC, status: 'Completed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' }, recipients: [] }
    })
    const { deps, signwell } = setup({ store, getDocument })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'ended' })
    expect(store.signEngagement).not.toHaveBeenCalled()
    expect(signwell.getCompletedPdf).not.toHaveBeenCalled()
    expect(store.state.request.finishingAt).toBeNull()
  })

  it('Check SignWell reading a non-completed status clears the "reported it signed" note (item 13), keeping the rest', async () => {
    const note = SIGNWELL_ISSUES.notCompleted('Sent')
    const { deps, store } = setup({ store: fakeStore({ request: { status: 'sent', lastError: `${note}; other` } }), document: { status: 'Viewed' } })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result).toMatchObject({ ok: true, signed: false, issues: [] })
    expect(store.state.request.status).toBe('viewed')
    expect(store.state.request.lastError).toBe('other')
    expect(result.request.lastError).toBe('other')
    expect(withoutNotCompletedNote(note)).toBeNull()
    expect(withoutNotCompletedNote('a; b')).toBe('a; b')
  })
})

describe('Check SignWell on a manual completion that lost a race to a withdrawal (featreq-60118b28 round 2)', () => {
  it('the request turned withdrawn while the document was read: no manual-completion notice, nothing signed', async () => {
    const store = fakeStore({ request: { status: 'viewed' } })
    const getDocument = vi.fn(async () => {
      store.state.request.status = 'withdrawn'
      return { id: DOC, status: 'Manually completed', metadata: { app: 'pbjbillingapp', engagement_id: 'eng-1' }, recipients: [] }
    })
    const { deps, notifyOwners } = setup({ store, getDocument })
    const result = await finishSignatureRequest('sigreq-1', deps)
    expect(result).toMatchObject({ ok: true, signed: false, issues: [] })
    expect(store.state.request.status).toBe('withdrawn')
    expect(notifyOwners).not.toHaveBeenCalled()
    expect(store.signEngagement).not.toHaveBeenCalled()
  })
})
