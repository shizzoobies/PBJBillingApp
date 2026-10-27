import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { engagementEsignHash } from './engagement-hash.js'
import {
  ESIGNATURES_EVENT_STATUS,
  ESIGNATURES_EXPIRY_DAYS,
  ESIGNATURES_ISSUES,
  ESIGNATURES_PDF_RETRY_MS,
  contractStatus,
  esignaturesEventKey,
  expireEsignaturesRequests,
  finishEsignaturesRequest,
  handleEsignaturesWebhook,
  retryPendingEsignaturesPdfs,
  withoutNotSignedNote,
} from './esignatures-webhook.js'
import { SIGNWELL_ISSUES } from './signwell-webhook.js'

/**
 * The eSignatures.io webhook (task 18; docs/esignatures.md), run for real against an in-memory store and a
 * stub eSignatures module: the signature check, the ledger, each event's status, and a signed contract
 * re-read, its PDF downloaded and kept, and the letter signed through the SAME completion SignWell uses.
 */
const TOKEN = 'es_fake_token_1234567890'
const CONTRACT = 'ctr-abc'
const NOW = new Date('2026-10-23T16:00:00.000Z')
const PDF_URL = 'https://files.example.invalid/signed.pdf?X-Amz-Signature=secret'
/** The link the (HMAC-verified) contract-signed event itself carries: the fallback when the re-read has none. */
const PAYLOAD_PDF_URL = 'https://files.example.invalid/from-the-event.pdf?X-Amz-Signature=other'

const FINISHED = ['completed', 'declined', 'expired', 'canceled', 'withdrawn']
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
    listSignatureRequestsAwaitingDocument: vi.fn(async () => {
      const row = state.request
      return row.status === 'completed' && !row.signedDocumentId && row.completedAt ? [{ ...row }] : []
    }),
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
      contract: { id: contractId, title: 'Acme Books - Engagement letter', metadata, test: 'no', contract_pdf_url: PAYLOAD_PDF_URL },
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
    // It names the address the request went to (its stored signer), never the provider's own message.
    expect(store.state.request.lastError).toBe('eSignatures.io could not deliver the signing email to pat@example.invalid - check the address, then send again')
    expect(store.state.request.lastError).not.toContain('mailbox')
  })

  it('a delivery error on a request that already ended never overwrites its sentence (the completion\'s, or the give-up marker)', async () => {
    const error = JSON.stringify({ status: 'error', data: { error_code: 'email-delivery-failed', contract_id: CONTRACT, metadata: metadataFor() } })
    for (const [status, lastError] of [
      ['completed', `${ESIGNATURES_ISSUES.pdfGaveUp}; Test mode - not marked signed`],
      ['completed', null],
      ['declined', null],
      ['expired', 'something'],
    ]) {
      const { run, store } = setup({ store: fakeStore({ request: { status, lastError } }) })
      expect((await run(error)).status).toBe(200)
      expect(store.state.request.status, status).toBe(status)
      expect(store.state.request.lastError, status).toBe(lastError)
    }
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
    // Re-read inside eSignatures.io's own 15 s timeout.
    expect(esignatures.getContract).toHaveBeenCalledWith(CONTRACT, { timeoutMs: 8000 })
    expect(store.state.request.status).toBe('completed')
    expect(store.state.request.completedAt).toBe(NOW.toISOString())
    expect(store.state.request.finishingAt).toBe(NOW.toISOString())
    // Nothing slow before the answer.
    expect(esignatures.downloadSignedPdf).not.toHaveBeenCalled()
    await result.after()
    // The link from GET /contracts first (the event's own is only the fallback).
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledTimes(1)
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

describe('contract-signed: the PDF link fallbacks and a request the app already ended', () => {
  it('the re-read carries no PDF link: the HMAC-verified event\'s own link is used', async () => {
    const { run, store, esignatures } = setup({ contract: { contract_pdf_url: undefined } })
    await (await run(event('contract-signed'))).after()
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledWith(PAYLOAD_PDF_URL)
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
  })

  it('the re-read link fails: the event\'s link is tried next', async () => {
    const { run, store, esignatures } = setup()
    esignatures.downloadSignedPdf.mockRejectedValueOnce(new Error('403'))
    await (await run(event('contract-signed'))).after()
    expect(esignatures.downloadSignedPdf.mock.calls.map((call) => call[0])).toEqual([PDF_URL, PAYLOAD_PDF_URL])
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
  })

  it('a signed contract for a request the app already EXPIRED is not dropped: an [esign] line, the owners told once, nothing signed', async () => {
    const { run, store, log, notifyOwners } = setup({ store: fakeStore({ request: { status: 'expired' } }) })
    const result = await run(event('contract-signed'))
    expect(result).toMatchObject({ status: 200, body: { received: true } })
    expect(result.after).toBeUndefined()
    expect(store.state.request.status).toBe('expired')
    expect(store.state.signCalls).toHaveLength(0)
    expect(store.state.request.lastError).toBe(
      'eSignatures.io reports the letter signed, but the app had already marked the request expired - check it in eSignatures.io and mark the letter signed by hand if that is right',
    )
    expect(log.warn.mock.calls.some((call) => String(call[0]).startsWith('[esign] '))).toBe(true)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    expect(notifyOwners.mock.calls[0][0].message).toMatch(/^Acme Books: eSignatures\.io reports the letter signed/)
  })
})

describe('retryPendingEsignaturesPdfs (the hourly retry of a signed PDF that could not be kept)', () => {
  const failedFirst = async (options = {}) => {
    const harness = setup(options)
    harness.esignatures.downloadSignedPdf.mockRejectedValue(new Error('403 expired link'))
    await (await harness.run(event('contract-signed'))).after()
    harness.esignatures.downloadSignedPdf.mockReset()
    harness.esignatures.downloadSignedPdf.mockResolvedValue(Buffer.from('%PDF-1.7 signed later'))
    harness.esignatures.getContract.mockClear()
    harness.notifyOwners.mockClear()
    return harness
  }

  it('the completion still signs and completes; the request says the PDF is pending, with the shared sentence', async () => {
    const { store } = await failedFirst()
    expect(store.state.request.status).toBe('completed')
    expect(store.state.signCalls).toHaveLength(1)
    expect(store.state.request.signedDocumentId).toBeNull()
    expect(store.state.request.lastError).toBe(ESIGNATURES_ISSUES.pdf)
  })

  it('re-reads the contract for a FRESH link, keeps the PDF and clears only the PDF sentence; a second run does nothing', async () => {
    const { store, esignatures, deps, notifyOwners } = await failedFirst()
    store.state.request.lastError = `Test mode - not marked signed; ${ESIGNATURES_ISSUES.pdf}`
    const outcome = await retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-24T16:00:00.000Z') })
    expect(outcome).toEqual({ kept: ['sigreq-1'], gaveUp: [] })
    expect(esignatures.getContract).toHaveBeenCalledWith(CONTRACT)
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledWith(PDF_URL)
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
    expect(store.state.request.lastError).toBe('Test mode - not marked signed')
    expect(notifyOwners).not.toHaveBeenCalled()
    expect(await retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-24T17:00:00.000Z') })).toEqual({ kept: [], gaveUp: [] })
  })

  it('a re-read that cannot be read, or carries no link, falls back to the event\'s link heard by this process', async () => {
    const { store, esignatures, deps } = await failedFirst()
    esignatures.getContract.mockRejectedValueOnce(new Error('down'))
    await retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-24T16:00:00.000Z') })
    expect(esignatures.downloadSignedPdf).toHaveBeenCalledWith(PAYLOAD_PDF_URL)
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
    expect(store.state.request.lastError).toBeNull()
  })

  it('still failing inside 3 days: nothing changes and nobody is told; past 3 days it gives up ONCE and tells the owners', async () => {
    const { store, esignatures, deps, notifyOwners } = await failedFirst()
    esignatures.downloadSignedPdf.mockRejectedValue(new Error('403'))
    await retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-25T16:00:00.000Z') })
    expect(store.state.request.lastError).toBe(ESIGNATURES_ISSUES.pdf)
    expect(notifyOwners).not.toHaveBeenCalled()
    const late = new Date(NOW.getTime() + ESIGNATURES_PDF_RETRY_MS + 60 * 60 * 1000)
    expect(await retryPendingEsignaturesPdfs({ ...deps, now: late })).toEqual({ kept: [], gaveUp: ['sigreq-1'] })
    expect(store.state.request.lastError).toBe(ESIGNATURES_ISSUES.pdfGaveUp)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    expect(notifyOwners.mock.calls[0][0].message).toBe(`Acme Books: ${ESIGNATURES_ISSUES.pdfGaveUp}`)
    expect(await retryPendingEsignaturesPdfs({ ...deps, now: late })).toEqual({ kept: [], gaveUp: [] })
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('leaves a request that is being finished right now, and never throws', async () => {
    const { deps, state, esignatures, store } = await failedFirst()
    state.completing.add('sigreq-1')
    expect(await retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-24T16:00:00.000Z') })).toEqual({ kept: [], gaveUp: [] })
    expect(esignatures.downloadSignedPdf).not.toHaveBeenCalled()
    state.completing.delete('sigreq-1')
    store.listSignatureRequestsAwaitingDocument.mockRejectedValueOnce(new Error('db down'))
    expect(await retryPendingEsignaturesPdfs({ ...deps })).toEqual({ kept: [], gaveUp: [] })
  })

  it('the give-up marker goes FIRST (so the 500-character cap cannot cut it), and a later Finish press that still fails keeps it: the owners hear of the give-up once', async () => {
    const { store, esignatures, deps, notifyOwners } = await failedFirst()
    const long = `Choose which amendments to keep - finish by hand; ${'x'.repeat(470)}`
    store.state.request.lastError = `${long}; ${ESIGNATURES_ISSUES.pdf}`
    esignatures.downloadSignedPdf.mockRejectedValue(new Error('403'))
    const late = new Date(NOW.getTime() + ESIGNATURES_PDF_RETRY_MS + 60 * 60 * 1000)
    await retryPendingEsignaturesPdfs({ ...deps, now: late })
    expect(store.state.request.lastError.startsWith(ESIGNATURES_ISSUES.pdfGaveUp)).toBe(true)
    expect(store.state.request.lastError).not.toContain(ESIGNATURES_ISSUES.pdf)
    // As the store would cap it: the marker survives.
    store.state.request.lastError = store.state.request.lastError.slice(0, 500)
    expect(notifyOwners).toHaveBeenCalledTimes(1)

    // A Finish press whose download still fails: the marker stays first.
    const pressed = await finishEsignaturesRequest('sigreq-1', { ...deps, now: late })
    expect(pressed.ok).toBe(true)
    expect(store.state.request.lastError.startsWith(`${ESIGNATURES_ISSUES.pdfGaveUp}; `)).toBe(true)
    const told = notifyOwners.mock.calls.length
    await retryPendingEsignaturesPdfs({ ...deps, now: new Date(late.getTime() + 60 * 60 * 1000) })
    expect(notifyOwners.mock.calls.length).toBe(told)
    expect(notifyOwners.mock.calls.filter((call) => call[0].message.endsWith(ESIGNATURES_ISSUES.pdfGaveUp))).toHaveLength(1)

    // A Finish press that keeps the PDF drops the marker.
    esignatures.downloadSignedPdf.mockResolvedValue(Buffer.from('%PDF-1.7 at last'))
    await finishEsignaturesRequest('sigreq-1', { ...deps, now: late })
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
    expect(String(store.state.request.lastError ?? '')).not.toContain(ESIGNATURES_ISSUES.pdfGaveUp)
  })

  it('a completion left finishing for over 10 minutes is run again whole (signed and kept); a fresher one is left alone', async () => {
    const store = fakeStore({ request: { status: 'completed', completedAt: '2026-10-23T15:00:00.000Z', finishingAt: '2026-10-23T15:55:00.000Z' } })
    const { deps, esignatures } = setup({ store })
    // 5 minutes after it started finishing: still under way somewhere.
    expect(await retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-23T16:00:00.000Z') })).toEqual({ kept: [], gaveUp: [] })
    expect(esignatures.downloadSignedPdf).not.toHaveBeenCalled()
    // 15 minutes: it died part-way. The whole completion runs: PDF kept, letter signed, finishing cleared.
    expect(await retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-23T16:10:00.000Z') })).toEqual({ kept: ['sigreq-1'], gaveUp: [] })
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
    expect(store.state.signCalls).toHaveLength(1)
    expect(store.state.request.finishingAt).toBeNull()
  })

  it('a stuck one can reach the 3-day give-up too (finishing cleared, owners told once)', async () => {
    const store = fakeStore({ request: { status: 'completed', completedAt: '2026-10-19T15:00:00.000Z', finishingAt: '2026-10-19T15:00:00.000Z' } })
    const { deps, notifyOwners } = setup({ store })
    expect(await retryPendingEsignaturesPdfs({ ...deps, now: NOW })).toEqual({ kept: [], gaveUp: ['sigreq-1'] })
    expect(store.state.request.finishingAt).toBeNull()
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('holds the in-process lock while it downloads: a Finish press meanwhile is refused as "finishing"', async () => {
    const { deps, esignatures, store } = await failedFirst()
    let release
    esignatures.downloadSignedPdf.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(Buffer.from('%PDF-1.7 slow'))
    }))
    const running = retryPendingEsignaturesPdfs({ ...deps, now: new Date('2026-10-24T16:00:00.000Z') })
    await vi.waitFor(() => expect(esignatures.downloadSignedPdf).toHaveBeenCalledTimes(1))
    expect((await finishEsignaturesRequest('sigreq-1', deps)).refused).toMatchObject({ status: 409, error: 'finishing' })
    release()
    expect((await running).kept).toEqual(['sigreq-1'])
    expect(deps.state.completing.has('sigreq-1')).toBe(false)
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
  })

  it('the PDF sentence it clears is the one the shared completion writes', () => {
    expect(ESIGNATURES_ISSUES.pdf).toBe(SIGNWELL_ISSUES.pdf.split('SignWell').join('eSignatures.io'))
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

/**
 * featreq-60118b28: a request the app WITHDREW (the letter voided, marked signed by hand or superseded) is ended
 * like an expired one, a withdrawal that lands while a contract is being read never runs the completion, and
 * Check eSignatures.io settles an older "reported it signed but the contract reads ..." note.
 */
describe('a withdrawn request (featreq-60118b28)', () => {
  it('a signed contract for a request the app WITHDREW signs nothing: the owners are told once to check it', async () => {
    const { run, store, notifyOwners } = setup({ store: fakeStore({ request: { status: 'withdrawn' } }) })
    const result = await run(event('contract-signed'))
    expect(result).toMatchObject({ status: 200, body: { received: true } })
    expect(result.after).toBeUndefined()
    expect(store.state.request.status).toBe('withdrawn')
    expect(store.state.signCalls).toHaveLength(0)
    // Never tells the owner to mark a voided (or already signed) letter signed by hand.
    expect(store.state.request.lastError).toBe(ESIGNATURES_ISSUES.signedAfterEnd('withdrawn'))
    expect(store.state.request.lastError).toMatch(/after the app withdrew the request/)
    expect(store.state.request.lastError).not.toMatch(/mark the letter signed/)
    // Other ended statuses keep their own advice.
    expect(ESIGNATURES_ISSUES.signedAfterEnd('expired')).toMatch(/mark the letter signed by hand if that is right$/)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('withdrawn WHILE the contract was being re-read: the store keeps it withdrawn, nothing is kept or signed, the owners told', async () => {
    const store = fakeStore()
    const getContract = vi.fn(async () => {
      store.state.request.status = 'withdrawn' // the void landed between the read and the update
      return { id: CONTRACT, status: 'signed', metadata: metadataFor(), contract_pdf_url: PDF_URL }
    })
    const { run, notifyOwners, esignatures } = setup({ store, getContract })
    const result = await run(event('contract-signed'))
    expect(result).toMatchObject({ status: 200, body: { received: true } })
    expect(result.after).toBeUndefined()
    expect(store.state.request.status).toBe('withdrawn')
    expect(store.state.request.finishingAt).toBeNull()
    expect(esignatures.downloadSignedPdf).not.toHaveBeenCalled()
    expect(store.state.signCalls).toHaveLength(0)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it("eSignatures.io's own withdrawn event after the app withdrew it changes nothing (the request stays withdrawn, its note kept)", async () => {
    const { run, store } = setup({ store: fakeStore({ request: { status: 'withdrawn', lastError: 'kept' } }) })
    expect((await run(event('contract-withdrawn'))).status).toBe(200)
    expect(store.state.request.status).toBe('withdrawn')
    expect(store.state.request.lastError).toBe('kept')
  })

  it('Check / Finish refuses a withdrawn request as ended', async () => {
    const { deps, esignatures } = setup({ store: fakeStore({ request: { status: 'withdrawn' } }) })
    const refused = await finishEsignaturesRequest('sigreq-1', deps)
    expect(refused.refused).toMatchObject({ status: 409, error: 'ended' })
    expect(refused.refused.message).toMatch(/withdrawn/)
    expect(esignatures.getContract).not.toHaveBeenCalled()
  })

  it('Finish racing a withdrawal (the void lands while the contract is read): refused as ended, the completion never runs', async () => {
    const store = fakeStore()
    const getContract = vi.fn(async () => {
      store.state.request.status = 'withdrawn'
      return { id: CONTRACT, status: 'signed', metadata: metadataFor(), contract_pdf_url: PDF_URL }
    })
    const { deps, esignatures, notifyOwners } = setup({ store, getContract })
    const result = await finishEsignaturesRequest('sigreq-1', deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'ended' })
    expect(store.state.request.status).toBe('withdrawn')
    expect(store.state.request.finishingAt).toBeNull()
    expect(esignatures.downloadSignedPdf).not.toHaveBeenCalled()
    expect(store.state.signCalls).toHaveLength(0)
    expect(notifyOwners).not.toHaveBeenCalled()
    expect(deps.state.completing.has('sigreq-1')).toBe(false)
  })
})

describe('the "reported it signed" note is settled by a check (featreq-60118b28 item 13)', () => {
  it('Check eSignatures.io reading the contract as still out clears that note and keeps any other sentence', async () => {
    const note = ESIGNATURES_ISSUES.notSigned('sent')
    const { deps, store } = setup({ contract: { status: 'sent' }, store: fakeStore({ request: { lastError: `${note}; something else` } }) })
    const result = await finishEsignaturesRequest('sigreq-1', deps)
    expect(result).toMatchObject({ ok: true, signed: false, issues: [] })
    expect(store.state.request.lastError).toBe('something else')
    expect(result.request.lastError).toBe('something else')

    const alone = setup({ contract: { status: 'sent' }, store: fakeStore({ request: { lastError: note } }) })
    await finishEsignaturesRequest('sigreq-1', alone.deps)
    expect(alone.store.state.request.lastError).toBeNull()
  })

  it('a check with no such note writes no note at all', async () => {
    const { deps, store } = setup({ contract: { status: 'sent' }, store: fakeStore({ request: { lastError: 'other' } }) })
    await finishEsignaturesRequest('sigreq-1', deps)
    expect(store.state.request.lastError).toBe('other')
    expect(store.updateSignatureRequest.mock.calls.every(([, patch]) => !('lastError' in patch))).toBe(true)
  })

  it('withoutNotSignedNote takes out only that sentence', () => {
    expect(withoutNotSignedNote(ESIGNATURES_ISSUES.notSigned('draft'))).toBeNull()
    expect(withoutNotSignedNote(`a; ${ESIGNATURES_ISSUES.notSigned('')}; b`)).toBe('a; b')
    expect(withoutNotSignedNote(null)).toBeNull()
    expect(withoutNotSignedNote(ESIGNATURES_ISSUES.unreadable)).toBe(ESIGNATURES_ISSUES.unreadable)
  })
})

/**
 * featreq-60118b28 round 2: a request the withdrawal LEFT OPEN (eSignatures.io refused; the contract may be signed)
 * is completed by the webhook as any other - the letter signed by hand keeps the PDF; a voided one is not signed.
 * And Check eSignatures.io withdraws a request still out whose letter no longer stands.
 */
describe('a request left open by a refused withdrawal (featreq-60118b28 round 2)', () => {
  const LEFT_OPEN = 'eSignatures.io did not withdraw it when the letter is marked signed (eSignatures.io answered 422) - press Check eSignatures.io'

  it('-> contract-signed on a letter already marked signed by hand: completed, the PDF kept, the note cleared, nothing signed twice', async () => {
    const store = fakeStore({ request: { status: 'viewed', lastError: LEFT_OPEN }, engagement: { status: 'signed' } })
    const { run, notifyOwners } = setup({ store })
    const result = await run(event('contract-signed'))
    expect(result.status).toBe(200)
    await result.after()
    expect(store.state.request.status).toBe('completed')
    expect(store.state.stored).toHaveLength(1)
    expect(store.state.request.signedDocumentId).toBe('sigdoc-1')
    expect(store.state.request.lastError).toBeNull()
    expect(store.state.signCalls).toHaveLength(0)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('-> contract-signed on a VOIDED letter: never signed, the PDF kept, the dedicated sentence (not "finish it by hand"), the owners told once', async () => {
    const store = fakeStore({ request: { status: 'viewed', lastError: LEFT_OPEN.replace('is marked signed', 'was voided') }, engagement: { status: 'void' } })
    const { run, notifyOwners } = setup({ store })
    const result = await run(event('contract-signed'))
    await result.after()
    expect(store.state.request.status).toBe('completed')
    expect(store.state.stored).toHaveLength(1)
    expect(store.state.signCalls).toHaveLength(0)
    expect(store.state.request.lastError).toBe('Signed after the letter was voided; the signed PDF is kept, nothing was changed here')
    expect(store.state.request.lastError).not.toMatch(/finish it by hand/)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    expect(notifyOwners.mock.calls[0][0].message).toBe(
      'Acme Books signed their engagement letter electronically. Signed after the letter was voided; the signed PDF is kept, nothing was changed here',
    )
    // A replay or a Finish press says nothing new.
    await finishEsignaturesRequest('sigreq-1', { ...setup({ store }).deps })
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })

  it('a superseded letter gets its own word in that sentence', () => {
    expect(SIGNWELL_ISSUES.letterClosed('superseded')).toBe('Signed after the letter was superseded; the signed PDF is kept, nothing was changed here')
  })
})

describe('Check eSignatures.io on a request still out whose letter no longer stands (featreq-60118b28 round 2)', () => {
  it('withdraws it now (the earlier withdrawal failed) with the letter\'s reason, and answers with the withdrawn request', async () => {
    for (const [status, reason] of [['void', 'void'], ['superseded', 'superseded'], ['signed', 'signed']]) {
      const store = fakeStore({ engagement: { status } })
      const { deps } = setup({ store, contract: { status: 'sent' } })
      const withdrawSignatureRequest = vi.fn(async (request) => ({ request: { ...request, status: 'withdrawn' }, withdrawn: true }))
      const result = await finishEsignaturesRequest('sigreq-1', { ...deps, withdrawSignatureRequest })
      expect(withdrawSignatureRequest, status).toHaveBeenCalledTimes(1)
      expect(withdrawSignatureRequest.mock.calls[0][0].id).toBe('sigreq-1')
      expect(withdrawSignatureRequest.mock.calls[0][1]).toMatchObject({ reason, store })
      expect(result).toMatchObject({ ok: true, signed: false, issues: [], request: { status: 'withdrawn' } })
    }
  })

  it('a letter still sent is only re-synced; a withdrawal that did not happen falls back to the plain re-sync', async () => {
    const live = setup({ contract: { status: 'sent' } })
    const withdrawSignatureRequest = vi.fn()
    await finishEsignaturesRequest('sigreq-1', { ...live.deps, withdrawSignatureRequest })
    expect(withdrawSignatureRequest).not.toHaveBeenCalled()

    const store = fakeStore({ engagement: { status: 'void' } })
    const failed = setup({ store, contract: { status: 'sent' } })
    const result = await finishEsignaturesRequest('sigreq-1', {
      ...failed.deps,
      withdrawSignatureRequest: vi.fn(async (request) => ({ request, withdrawn: false })),
    })
    expect(result).toMatchObject({ ok: true, signed: false })
    expect(store.state.request.status).toBe('sent')
  })
})
