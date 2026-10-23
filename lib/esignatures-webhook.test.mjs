import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { engagementEsignHash } from './engagement-hash.js'
import {
  ESIGNATURES_EVENT_STATUS,
  ESIGNATURES_EXPIRY_DAYS,
  contractStatus,
  esignaturesEventKey,
  expireEsignaturesRequests,
  finishEsignaturesRequest,
  handleEsignaturesWebhook,
} from './esignatures-webhook.js'

/**
 * The eSignatures.io webhook (task 18; docs/esignatures.md), run for real against an in-memory store and a
 * stub eSignatures module: the signature check, the ledger, each event's status, and a signed contract
 * re-read, its PDF downloaded and kept, and the letter signed through the SAME completion SignWell uses.
 */
const TOKEN = 'es_fake_token_1234567890'
const CONTRACT = 'ctr-abc'
const NOW = new Date('2026-10-23T16:00:00.000Z')
const PDF_URL = 'https://files.example.invalid/signed.pdf?X-Amz-Signature=secret'

const FINISHED = ['completed', 'declined', 'expired', 'canceled']
const PROGRESS = ['draft', 'sent', 'viewed', 'signed_partial']
const RECOVERABLE = ['bounced', 'error']

function baseEngagement(over = {}) {
  return {
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
    ...over,
  }
}

function fakeStore({ request = {}, engagement = {}, clientName = 'Acme Books', signRefusal = null } = {}) {
  const eng = baseEngagement(engagement)
  const state = {
    request: {
      id: 'sigreq-1',
      engagementId: 'eng-1',
      clientId: null,
      provider: 'esignatures',
      signwellDocumentId: CONTRACT,
      providerDocumentId: CONTRACT,
      providerSignerId: 'signer-1',
      status: 'sent',
      recipients: [{ id: 'signer-1', name: 'Pat Example', email: 'pat@example.invalid' }],
      testMode: false,
      esignHash: engagementEsignHash(eng),
      signedDocumentId: null,
      sentAt: '2026-10-21T15:00:00.000Z',
      completedAt: null,
      finishingAt: null,
      lastEventAt: null,
      lastError: null,
      createdBy: 'emp-patrice',
      ...request,
    },
    engagement: eng,
    events: new Set(),
    updates: [],
    stored: [],
    signCalls: [],
  }
  const store = {
    state,
    getSignatureRequest: vi.fn(async (id) => (id === state.request.id ? { ...state.request } : null)),
    getSignatureRequestByDocumentId: vi.fn(async (id, provider) =>
      id === state.request.signwellDocumentId && provider === 'esignatures' ? { ...state.request } : null,
    ),
    recordSignwellEventOnce: vi.fn(async (key) => {
      if (state.events.has(key)) return false
      state.events.add(key)
      return true
    }),
    forgetSignwellEvent: vi.fn(async (key) => state.events.delete(key)),
    updateSignatureRequest: vi.fn(async (id, patch) => {
      state.updates.push(patch)
      const row = state.request
      if (patch.status) {
        const movable =
          !FINISHED.includes(row.status) &&
          (!PROGRESS.includes(patch.status) || RECOVERABLE.includes(row.status) || PROGRESS.indexOf(patch.status) >= PROGRESS.indexOf(row.status))
        if (movable) row.status = patch.status
      }
      for (const key of ['recipients', 'signedDocumentId', 'completedAt']) if (patch[key]) row[key] = patch[key]
      if (patch.lastEventAt && (!row.lastEventAt || patch.lastEventAt > row.lastEventAt)) row.lastEventAt = patch.lastEventAt
      if (patch.lastError !== undefined) row.lastError = patch.lastError
      if (patch.finishingAt !== undefined) row.finishingAt = patch.finishingAt
      return { ...row }
    }),
    getEngagement: vi.fn(async () => ({ ...state.engagement })),
    getClientById: vi.fn(async (id) => ({ id, name: clientName })),
    listEngagements: vi.fn(async () => []),
    getTeamMembers: vi.fn(async () => [{ id: 'emp-patrice', role: 'owner' }]),
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
      return { engagement: { ...state.engagement, status: 'signed' }, clientId: 'client-1' }
    }),
    expireSignatureRequestsSentBefore: vi.fn(async () => ['sigreq-old']),
  }
  return store
}

const metadataFor = (over = {}) =>
  JSON.stringify({ engagement_id: 'eng-1', app: 'pbjbillingapp', esign_hash: engagementEsignHash(baseEngagement()), ...over })

function setup({ store = fakeStore(), contract = {}, getContract, pdf } = {}) {
  const esignatures = {
    getContract:
      getContract ??
      vi.fn(async () => ({ id: CONTRACT, status: 'signed', metadata: metadataFor(), contract_pdf_url: PDF_URL, ...contract })),
    downloadSignedPdf: vi.fn(async () => pdf ?? Buffer.from('%PDF-1.7 signed')),
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const notifyOwners = vi.fn(async () => {})
  const afterSigned = vi.fn(async () => {})
  const state = { warnedUnconfigured: false, completing: new Set() }
  const deps = { store, esignatures, log, notifyOwners, afterSigned, state, now: NOW, today: () => '2026-10-23' }
  const run = (rawBody, options = {}) =>
    handleEsignaturesWebhook({
      rawBody,
      signature: options.signature ?? sign(rawBody),
      token: 'token' in options ? options.token : TOKEN,
      deps,
    })
  return { store, esignatures, log, notifyOwners, afterSigned, state, deps, run }
}

const sign = (body, key = TOKEN) => createHmac('sha256', key).update(body).digest('hex')

function event(status, { contractId = CONTRACT, metadata = metadataFor(), extra = {} } = {}) {
  return JSON.stringify({
    status,
    data: {
      contract: { id: contractId, title: 'Acme Books - Engagement letter', metadata, test: 'no', contract_pdf_url: 'https://evil.example.invalid/x.pdf' },
      signer: { id: 'signer-1', name: 'Pat Example', email: 'pat@example.invalid' },
      ...extra,
    },
  })
}

describe('the gate: token, signature, body', () => {
  it('503 until the token is set (warned once), before anything is read', async () => {
    const { run, store, log } = setup()
    for (const token of [undefined, '', '  ']) {
      expect(await run(event('contract-sent-to-signer'), { token })).toMatchObject({ status: 503 })
    }
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(store.getSignatureRequestByDocumentId).not.toHaveBeenCalled()
  })

  it('401 on a bad, missing or wrong-key signature, before the body is parsed or anything looked up', async () => {
    const { run, store } = setup()
    const body = event('contract-signed')
    for (const signature of ['', 'nope', sign(body, 'other-key'), sign(`${body} `)]) {
      expect((await run(body, { signature })).status, signature).toBe(401)
    }
    expect((await run('not json', { signature: sign('not json', 'other') })).status).toBe(401)
    expect(store.getSignatureRequestByDocumentId).not.toHaveBeenCalled()
    expect(store.recordSignwellEventOnce).not.toHaveBeenCalled()
  })

  it('accepts a base64 signature too', async () => {
    const { run } = setup()
    const body = event('signer-viewed-the-contract')
    const result = await run(body, { signature: createHmac('sha256', TOKEN).update(body).digest('base64') })
    expect(result.status).toBe(200)
  })

  it('400 for a signed body that is not JSON or has no status', async () => {
    const { run } = setup()
    expect((await run('not json')).status).toBe(400)
    expect((await run(JSON.stringify({ data: {} }))).status).toBe(400)
  })

  it('200 and ignored for a contract that is not ours: no app marker, another engagement, or no such request', async () => {
    for (const body of [
      event('contract-signed', { metadata: '{"app":"someone-else"}' }),
      event('contract-signed', { metadata: 'not json' }),
      event('contract-signed', { metadata: metadataFor({ engagement_id: 'eng-other' }) }),
      event('contract-signed', { contractId: 'ctr-unknown' }),
    ]) {
      const { run, store, esignatures } = setup()
      const result = await run(body)
      expect(result).toMatchObject({ status: 200, body: { received: true, ignored: true } })
      expect(store.recordSignwellEventOnce).not.toHaveBeenCalled()
      expect(esignatures.getContract).not.toHaveBeenCalled()
    }
  })

  it('an event type the app does not act on is 200 and ignored, with no ledger row', async () => {
    const { run, store } = setup()
    expect(await run(event('signer-mobile-update-request'))).toMatchObject({ status: 200, body: { ignored: true } })
    expect(store.recordSignwellEventOnce).not.toHaveBeenCalled()
  })
})

describe('the in-progress events', () => {
  it('maps the documented statuses', () => {
    expect(ESIGNATURES_EVENT_STATUS).toEqual({
      'contract-sent-to-signer': 'sent',
      'signer-viewed-the-contract': 'viewed',
      'contract-reminder-sent-to-signer': null,
      'contract-withdrawn': 'declined',
      'contract-signed': 'completed',
      error: 'bounced',
    })
    expect(contractStatus({ status: 'signed' })).toBe('completed')
    expect(contractStatus({ status: 'Sent' })).toBe('sent')
    expect(contractStatus({ status: 'withdrawn' })).toBe('declined')
    expect(contractStatus({ status: 'draft' })).toBeNull()
    expect(contractStatus(null)).toBeNull()
  })

  it('viewed moves the request on, stamps the time, and a replay is a duplicate with no second write', async () => {
    const { run, store, esignatures } = setup()
    const body = event('signer-viewed-the-contract')
    expect(await run(body)).toMatchObject({ status: 200, body: { received: true } })
    expect(store.state.request.status).toBe('viewed')
    expect(store.state.request.lastEventAt).toBe(NOW.toISOString())
    // The in-progress events are trusted from the signed body: nothing is re-read.
    expect(esignatures.getContract).not.toHaveBeenCalled()
    const writes = store.updateSignatureRequest.mock.calls.length
    expect(await run(body)).toMatchObject({ status: 200, body: { duplicate: true } })
    expect(store.updateSignatureRequest.mock.calls.length).toBe(writes)
    // The ledger key is prefixed and names no address.
    const [key] = [...store.state.events]
    expect(key).toBe(`es:${CONTRACT}:signer-viewed-the-contract`)
    expect(key).not.toContain('@')
  })

  it('a reminder changes no status (it is logged); each reminder is its own event', async () => {
    const { run, store, log } = setup()
    expect((await run(event('contract-reminder-sent-to-signer'))).status).toBe(200)
    expect(store.state.request.status).toBe('sent')
    expect(log.info).toHaveBeenCalled()
    expect(await run(event('contract-reminder-sent-to-signer', { extra: { at: 'later' } }))).toMatchObject({ body: { received: true } })
    expect(store.state.events.size).toBe(2)
  })

  it('withdrawn (or declined by the signer) is declined, and a finished request never moves again', async () => {
    const { run, store } = setup()
    await run(event('contract-withdrawn'))
    expect(store.state.request.status).toBe('declined')
    await run(event('signer-viewed-the-contract'))
    expect(store.state.request.status).toBe('declined')
  })

  it('a delivery error is "bounced" with a plain reason; a later sent event recovers it', async () => {
    const { run, store } = setup()
    const error = JSON.stringify({ status: 'error', data: { error_code: 'email-delivery-failed', error_message: 'mailbox pat@example.invalid full', contract_id: CONTRACT, metadata: metadataFor() } })
    expect((await run(error)).status).toBe(200)
    expect(store.state.request.status).toBe('bounced')
    expect(store.state.request.lastError).toMatch(/could not deliver the signing email/)
    expect(store.state.request.lastError).not.toContain('pat@example.invalid')
  })

  it('a failure to record releases the ledger key and answers 500, so the hourly retry is processed', async () => {
    const store = fakeStore()
    store.updateSignatureRequest.mockRejectedValueOnce(new Error('db down'))
    const { run } = setup({ store })
    expect((await run(event('signer-viewed-the-contract'))).status).toBe(500)
    expect(store.forgetSignwellEvent).toHaveBeenCalledWith(`es:${CONTRACT}:signer-viewed-the-contract`)
    expect((await run(event('signer-viewed-the-contract'))).status).toBe(200)
    expect(store.state.request.status).toBe('viewed')
  })
})

describe('contract-signed', () => {
  it('re-reads the contract, marks it completed and answers; THEN downloads the PDF from the re-read link, keeps it and signs the letter', async () => {
    const { run, store, esignatures, notifyOwners, afterSigned } = setup()
    const result = await run(event('contract-signed'))
    expect(result).toMatchObject({ status: 200, body: { received: true } })
    expect(esignatures.getContract).toHaveBeenCalledWith(CONTRACT)
    expect(store.state.request.status).toBe('completed')
    expect(store.state.request.completedAt).toBe(NOW.toISOString())
    expect(store.state.request.finishingAt).toBe(NOW.toISOString())
    // Nothing slow before the answer.
    expect(esignatures.downloadSignedPdf).not.toHaveBeenCalled()
    await result.after()
    // The link from GET /contracts, never the one in the webhook body.
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledWith(PDF_URL)
    expect(store.state.stored).toHaveLength(1)
    expect(store.state.stored[0].fileName).toBe('Signed-Engagement-Letter-Acme-Books.pdf')
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
    expect(store.state.signCalls).toHaveLength(1)
    expect(store.state.signCalls[0].options).toMatchObject({ note: 'Signed electronically through eSignatures.io', userId: 'emp-patrice', signedOn: '2026-10-23' })
    expect(afterSigned).toHaveBeenCalledTimes(1)
    expect(store.state.request.finishingAt).toBeNull()
    expect(store.state.request.lastError).toBeNull()
    expect(notifyOwners.mock.calls[0][0].message).toBe('Acme Books signed their engagement letter electronically')
  })

  it('a retry of the same event (a fresh PDF link in its body) is a duplicate: nothing is downloaded or signed twice', async () => {
    const { run, store, esignatures } = setup()
    const first = await run(event('contract-signed'))
    await first.after()
    const again = await run(event('contract-signed', { extra: { contract_pdf_url_refreshed: true } }))
    expect(again).toMatchObject({ status: 200, body: { duplicate: true } })
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledTimes(1)
    expect(store.state.signCalls).toHaveLength(1)
  })

  it('a contract the re-read does not show as signed: recorded, the owners told once, the key released and 500 for a retry', async () => {
    const { run, store, notifyOwners } = setup({ contract: { status: 'sent' } })
    expect((await run(event('contract-signed'))).status).toBe(500)
    expect(store.state.request.status).toBe('sent')
    expect(store.state.request.lastError).toMatch(/eSignatures\.io reported it signed but the contract reads sent/)
    expect(store.state.events.size).toBe(0)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    expect((await run(event('contract-signed'))).status).toBe(500)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('a re-read whose metadata does not name this request and its hash is ignored (200), nothing signed', async () => {
    for (const metadata of [metadataFor({ esign_hash: 'f'.repeat(64) }), metadataFor({ engagement_id: 'eng-2' }), '{}']) {
      const { run, store } = setup({ contract: { metadata } })
      expect(await run(event('contract-signed'))).toMatchObject({ status: 200, body: { ignored: true } })
      expect(store.state.request.status).toBe('sent')
    }
  })

  it('the contract could not be re-read: the key is released and 500, so the retry is processed', async () => {
    const getContract = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ id: CONTRACT, status: 'signed', metadata: metadataFor(), contract_pdf_url: PDF_URL })
    const { run, store } = setup({ getContract })
    expect((await run(event('contract-signed'))).status).toBe(500)
    expect(store.state.events.size).toBe(0)
    const result = await run(event('contract-signed'))
    expect(result.status).toBe(200)
    await result.after()
    expect(store.state.signCalls).toHaveLength(1)
  })

  it('a PDF that cannot be downloaded is an issue on the request ("press Finish e-signature"), the letter is still signed', async () => {
    const { run, store, esignatures } = setup()
    esignatures.downloadSignedPdf.mockRejectedValue(new Error('403 expired link'))
    const result = await run(event('contract-signed'))
    await result.after()
    expect(store.state.request.signedDocumentId).toBeNull()
    expect(store.state.request.lastError).toMatch(/signed PDF could not be saved - press Finish e-signature to retry, or download it from eSignatures\.io/)
    expect(store.state.signCalls).toHaveLength(1)
  })

  it('test mode: only the client named exactly Test is signed; any other is completed with the reason', async () => {
    const real = setup({ store: fakeStore({ request: { testMode: true }, engagement: { clientId: 'c1' }, clientName: 'Acme Books' }) })
    await (await real.run(event('contract-signed'))).after()
    expect(real.store.state.signCalls).toHaveLength(0)
    expect(real.store.state.request.status).toBe('completed')
    expect(real.store.state.stored).toHaveLength(1)
    expect(real.store.state.request.lastError).toBe('Test mode - not marked signed; use Mark as signed if this was a real signature')

    const testClient = fakeStore({ request: { testMode: true }, engagement: { clientId: 'c1' }, clientName: 'Test' })
    const test = setup({ store: testClient })
    await (await test.run(event('contract-signed'))).after()
    expect(test.store.state.signCalls).toHaveLength(1)
  })

  it('a letter changed since it went out is not signed (the SAME rule as SignWell)', async () => {
    const store = fakeStore()
    store.state.engagement.letterBody = 'Edited after it went out'
    const { run } = setup({ store })
    await (await run(event('contract-signed'))).after()
    expect(store.state.signCalls).toHaveLength(0)
    expect(store.state.request.lastError).toMatch(/changed after it went to eSignatures\.io/)
  })
})

describe('finishEsignaturesRequest (Check eSignatures.io / Finish e-signature)', () => {
  it('re-reads the contract: still out -> the status, nothing signed', async () => {
    const { deps, store } = setup({ contract: { status: 'sent' } })
    const result = await finishEsignaturesRequest('sigreq-1', deps)
    expect(result).toMatchObject({ ok: true, signed: false, issues: [] })
    expect(store.state.request.status).toBe('sent')
  })

  it('signed -> downloads the PDF from a FRESH link, keeps it and signs, idempotently', async () => {
    const { deps, store, esignatures } = setup()
    const result = await finishEsignaturesRequest('sigreq-1', deps)
    expect(result).toMatchObject({ ok: true, signed: true })
    expect(esignatures.getContract).toHaveBeenCalledWith(CONTRACT)
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledWith(PDF_URL)
    expect(store.state.request.status).toBe('completed')
    expect(store.state.stored).toHaveLength(1)
    const again = await finishEsignaturesRequest('sigreq-1', deps)
    expect(again.ok).toBe(true)
    // The PDF is kept already: not downloaded again; the letter is signed already: not signed again.
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledTimes(1)
    expect(store.state.signCalls).toHaveLength(1)
  })

  it('refuses an unknown request, an ended one, one already being finished, and says when eSignatures.io cannot be reached', async () => {
    const { deps, state } = setup()
    expect((await finishEsignaturesRequest('nope', deps)).refused).toMatchObject({ status: 404 })
    state.completing.add('sigreq-1')
    expect((await finishEsignaturesRequest('sigreq-1', deps)).refused).toMatchObject({ status: 409, error: 'finishing' })
    state.completing.delete('sigreq-1')
    const ended = setup({ store: fakeStore({ request: { status: 'expired' } }) })
    expect((await finishEsignaturesRequest('sigreq-1', ended.deps)).refused).toMatchObject({ status: 409, error: 'ended' })
    const down = setup({ getContract: vi.fn(async () => Promise.reject(new Error('down'))) })
    const refused = await finishEsignaturesRequest('sigreq-1', down.deps)
    expect(refused.refused).toMatchObject({ status: 502, error: 'esign_failed' })
    expect(refused.refused.message).toMatch(/eSignatures\.io could not be reached/)
  })
})

describe('expiry (eSignatures.io sends no expiry event)', () => {
  it('expires the requests sent more than 30 days ago, through the store, and logs their ids', async () => {
    const store = fakeStore()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const ids = await expireEsignaturesRequests({ store, now: NOW, log })
    expect(ESIGNATURES_EXPIRY_DAYS).toBe(30)
    expect(ids).toEqual(['sigreq-old'])
    expect(store.expireSignatureRequestsSentBefore).toHaveBeenCalledWith('esignatures', '2026-09-23T16:00:00.000Z')
    expect(log.info.mock.calls[0].join(' ')).toContain('sigreq-old')
  })

  it('never throws', async () => {
    const store = fakeStore()
    store.expireSignatureRequestsSentBefore.mockRejectedValue(new Error('db down'))
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    expect(await expireEsignaturesRequests({ store, now: NOW, log })).toEqual([])
    expect(log.error).toHaveBeenCalled()
  })
})

describe('esignaturesEventKey', () => {
  it('one-time events are keyed by contract and status; repeatable ones (reminder, error) add the body\'s hash', () => {
    expect(esignaturesEventKey({ contractId: 'c1', status: 'contract-signed', rawBody: 'a' })).toBe('es:c1:contract-signed')
    const one = esignaturesEventKey({ contractId: 'c1', status: 'contract-reminder-sent-to-signer', rawBody: 'a' })
    const two = esignaturesEventKey({ contractId: 'c1', status: 'contract-reminder-sent-to-signer', rawBody: 'b' })
    expect(one).toMatch(/^es:c1:contract-reminder-sent-to-signer:[0-9a-f]{32}$/)
    expect(one).not.toBe(two)
  })
})
