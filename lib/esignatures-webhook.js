/**
 * The eSignatures.io webhook handler, the "Check eSignatures.io" / "Finish e-signature" re-read, and the
 * expiry sweep (featreq-56d39567, task 18; docs/esignatures.md). With lib/esignatures.js the only
 * eSignatures.io-specific code: server.js hands it the raw body, the `X-Signature-SHA256` header, the
 * token, the store, the eSignatures module and the owner notifier, and sends back what it answers.
 *
 * What the docs let us trust: the signature is an HMAC-SHA256 of the WHOLE raw body keyed with our secret
 * token, so a valid one vouches for everything in the body (unlike SignWell's, which covers the type and
 * time only). So, in this order:
 *  1. 503 without ESIGNATURES_SECRET_TOKEN (warned once per boot); 401 on a bad or missing signature -
 *     checked on the raw bytes BEFORE the body is parsed; 400 for a body that is not JSON or has no status;
 *  2. an event the app does not act on, a contract whose metadata is not ours (the app marker and an
 *     engagement id), or one no request of ours holds: 200 `ignored`, nothing written;
 *  3. the event is ledgered once (the `signwell_events` table, keys prefixed `es:` - no new table): a
 *     one-time event by contract and status, a repeatable one (a reminder, an error) by contract, status
 *     and the body's hash. A replay is 200 `duplicate`. From here on a failure RELEASES the key and answers
 *     500, so eSignatures.io's hourly retry (up to 6) is processed;
 *  4. sent / viewed / withdrawn (also a decline) / a delivery error move the status (the store keeps a
 *     finished request finished and in-progress statuses moving forward only);
 *  5. contract-signed: the contract is RE-READ (`GET /contracts/<id>`) - it must read `signed` and its
 *     metadata must name this request's engagement and the signed details' hash - the request is marked
 *     completed and the answer sent; THEN the signed PDF is downloaded from the RE-READ link (it lives 3
 *     days, so at once) and the SAME completion SignWell uses runs (lib/signwell-webhook.js
 *     `completeRequest`): the PDF kept once, the letter signed only if unchanged and, in test mode, only for
 *     the client named exactly Test; the owners told by name only.
 * eSignatures.io sends no expiry event: `expireEsignaturesRequests` (an hourly job) expires a request still
 * sent or viewed 30 days after it went out, when its link lapses.
 *
 * Logs carry ids and event names only: never the token, an address, a PDF link or the document.
 */

import { createHash } from 'node:crypto'

import { redact, verifyWebhookSignature } from './esignatures.js'
import { completeRequest } from './signwell-webhook.js'

/** The events the app acts on, and the status each means. `null`: logged, no status change. */
export const ESIGNATURES_EVENT_STATUS = Object.freeze({
  'contract-sent-to-signer': 'sent',
  'signer-viewed-the-contract': 'viewed',
  'contract-reminder-sent-to-signer': null,
  'contract-withdrawn': 'declined',
  'contract-signed': 'completed',
  error: 'bounced',
})
/** Events that can arrive more than once for one contract: their ledger key includes the body's hash. */
const REPEATABLE_EVENTS = new Set(['contract-reminder-sent-to-signer', 'error'])
/** The contract statuses GET /contracts/<id> documents, and what each means to us (draft: no change). */
const CONTRACT_STATUS = Object.freeze({ sent: 'sent', signed: 'completed', withdrawn: 'declined' })

export const ESIGNATURES_METADATA_APP = 'pbjbillingapp'
/** A contract's link lapses after this many days (the send asks for 30 * 24 hours); then it is expired here. */
export const ESIGNATURES_EXPIRY_DAYS = 30
const LABEL = 'eSignatures.io'
const ENDED_STATUSES = ['declined', 'expired', 'canceled']

export const ESIGNATURES_ISSUES = Object.freeze({
  notSigned: (status) => `eSignatures.io reported it signed but the contract reads ${status || 'unknown'} - press Check eSignatures.io to retry`,
  unreadable: 'eSignatures.io reports a signed engagement letter, but the app could not read it - press Check eSignatures.io to retry, or mark it signed by hand',
  delivery: 'eSignatures.io could not deliver the signing email - check the address, then send again',
  problem: 'eSignatures.io reported a problem with this contract - press Check eSignatures.io',
})

/** Process-wide state: the once-per-boot warning, and the requests being finished right now. */
const sharedState = { warnedUnconfigured: false, completing: new Set() }

const clean = (value) => String(value ?? '').trim()

/** The status a contract read from GET /contracts/<id> means to us, or null (draft, unknown: no change). */
export function contractStatus(contract) {
  return CONTRACT_STATUS[clean(contract?.status).toLowerCase()] ?? null
}

/** The ledger key: `es:<contract>:<event>`, plus the body's hash for an event that can repeat. No address. */
export function esignaturesEventKey({ contractId, status, rawBody }) {
  const base = `es:${String(contractId).slice(0, 120)}:${status}`
  if (!REPEATABLE_EVENTS.has(status)) return base
  return `${base}:${createHash('sha256').update(String(rawBody ?? '')).digest('hex').slice(0, 32)}`
}

/** A contract's metadata (a JSON string, or an object) as an object; anything unreadable is empty. */
function metadataOf(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw ?? ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The name an owner knows this letter by, best effort. */
async function nameOf(store, request) {
  try {
    const party = (await store.getEngagement(request.engagementId))?.party ?? {}
    return clean(party.company) || clean(party.contactName) || 'A client'
  } catch {
    return 'A client'
  }
}

async function tell(deps, request, message) {
  try {
    await deps.notifyOwners({ message, link: `/engagements/${request.engagementId}`, engagementId: request.engagementId, signed: false })
  } catch (error) {
    ;(deps.log ?? console).error(`[esignatures] could not notify the owners for ${request.id}:`, redact(error?.message))
  }
}

/** The deps the shared completion is given: the PDF from THIS contract's (re-read) link, the provider named. */
function completionDeps(deps, contract) {
  return {
    ...deps,
    providerLabel: LABEL,
    fetchSignedPdf: () => deps.esignatures.downloadSignedPdf(contract?.contract_pdf_url),
  }
}

/**
 * Handle one webhook delivery.
 *
 * @param {object} args
 * @param {string|Buffer} args.rawBody
 * @param {string|undefined} args.signature   the X-Signature-SHA256 header
 * @param {string|undefined} args.token       ESIGNATURES_SECRET_TOKEN
 * @param {object} args.deps  { store, esignatures: {getContract, downloadSignedPdf}, notifyOwners, afterSigned?,
 *   log?, today?, state?, now? }
 * @returns {Promise<{status: number, body: object, after?: () => Promise<void>}>} `after` runs once the answer is sent.
 */
export async function handleEsignaturesWebhook({ rawBody, signature, token, deps }) {
  const { store } = deps
  const log = deps.log ?? console
  const state = deps.state ?? sharedState
  if (!clean(token)) {
    if (!state.warnedUnconfigured) {
      state.warnedUnconfigured = true
      log.warn('[esignatures] webhook received but ESIGNATURES_SECRET_TOKEN is not set - answering 503')
    }
    return { status: 503, body: { error: 'eSignatures.io webhooks are not configured' } }
  }
  if (!verifyWebhookSignature(rawBody, signature, token)) {
    log.warn('[esignatures] rejected a webhook with an invalid signature')
    return { status: 401, body: { error: 'Invalid signature' } }
  }
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { status: 400, body: { error: 'Could not read body' } }
  }
  const status = typeof payload?.status === 'string' ? payload.status : ''
  if (!status) return { status: 400, body: { error: 'Could not read body' } }
  if (!Object.hasOwn(ESIGNATURES_EVENT_STATUS, status)) {
    log.info(`[esignatures] ignored a ${status.slice(0, 60)} event`)
    return { status: 200, body: { received: true, ignored: true } }
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
  const contract = data.contract && typeof data.contract === 'object' ? data.contract : {}
  const contractId = clean(contract.id ?? data.contract_id)
  const metadata = metadataOf(contract.metadata ?? data.metadata)
  if (!contractId || metadata.app !== ESIGNATURES_METADATA_APP || !clean(metadata.engagement_id)) {
    log.info(`[esignatures] ignored a ${status} event for a contract that is not ours`)
    return { status: 200, body: { received: true, ignored: true } }
  }
  const request = await store.getSignatureRequestByDocumentId(contractId, 'esignatures')
  if (!request || request.engagementId !== metadata.engagement_id) {
    log.info(`[esignatures] ignored a ${status} event for a contract no request holds`)
    return { status: 200, body: { received: true, ignored: true } }
  }

  const key = esignaturesEventKey({ contractId, status, rawBody: text })
  if (!(await store.recordSignwellEventOnce(key, `esignatures:${status}`))) {
    return { status: 200, body: { received: true, duplicate: true } }
  }
  const retry = async (reason) => {
    log.error(`[esignatures] could not process ${status} for ${request.id}:`, reason)
    await Promise.resolve(store.forgetSignwellEvent(key)).catch(() => {})
    return { status: 500, body: { error: 'Could not process the event' } }
  }
  try {
    if (status === 'contract-signed') return await processSigned({ request, contractId, deps, log, state, retry })
    return await processProgress({ request, status, data, deps, log })
  } catch (error) {
    return retry(redact(error?.message))
  }
}

/** sent / viewed / reminder / withdrawn / error: the signed body is trusted for these; nothing is re-read. */
async function processProgress({ request, status, data, deps, log }) {
  const now = (deps.now ?? new Date()).toISOString()
  let next = ESIGNATURES_EVENT_STATUS[status]
  let lastError
  if (status === 'error') {
    const code = clean(data.error_code)
    const delivery = code === 'email-delivery-failed' || code === 'sms-delivery-failed'
    next = delivery ? 'bounced' : 'error'
    lastError = delivery ? ESIGNATURES_ISSUES.delivery : ESIGNATURES_ISSUES.problem
  }
  const updated = await deps.store.updateSignatureRequest(request.id, {
    ...(next ? { status: next } : {}),
    lastEventAt: now,
    ...(lastError ? { lastError } : {}),
  })
  log.info(`[esignatures] ${status} for ${request.id}: ${request.status} -> ${updated?.status ?? '?'}`)
  return { status: 200, body: { received: true } }
}

/** contract-signed: re-read, check, mark completed, answer; the PDF and the signing run after the answer. */
async function processSigned({ request, contractId, deps, log, state, retry }) {
  const { store, esignatures } = deps
  let contract
  try {
    contract = await esignatures.getContract(contractId)
  } catch (error) {
    const reason = redact(error?.message)
    await Promise.resolve(store.updateSignatureRequest(request.id, { lastError: ESIGNATURES_ISSUES.unreadable })).catch(() => {})
    if (request.lastError !== ESIGNATURES_ISSUES.unreadable) await tell(deps, request, `${await nameOf(store, request)}: ${ESIGNATURES_ISSUES.unreadable}`)
    return retry(reason)
  }
  const metadata = metadataOf(contract?.metadata)
  if (
    metadata.app !== ESIGNATURES_METADATA_APP ||
    metadata.engagement_id !== request.engagementId ||
    (request.esignHash && metadata.esign_hash !== request.esignHash)
  ) {
    log.warn(`[esignatures] ignored a contract-signed event: the contract's metadata does not name ${request.id}`)
    return { status: 200, body: { received: true, ignored: true } }
  }
  const next = contractStatus(contract)
  if (next !== 'completed') {
    const reads = clean(contract?.status).slice(0, 40)
    const lastError = ESIGNATURES_ISSUES.notSigned(reads)
    log.warn(`[esignatures] a contract-signed event for ${request.id} but the contract reads ${reads || 'unknown'}`)
    await store.updateSignatureRequest(request.id, { ...(next ? { status: next } : {}), lastError })
    if (request.lastError !== lastError) await tell(deps, request, `${await nameOf(store, request)}: ${lastError}`)
    return retry('the contract is not signed')
  }

  const now = (deps.now ?? new Date()).toISOString()
  const updated = await store.updateSignatureRequest(request.id, {
    status: 'completed',
    lastEventAt: now,
    ...(request.completedAt ? {} : { completedAt: now }),
  })
  log.info(`[esignatures] contract-signed for ${request.id}: ${request.status} -> ${updated?.status ?? '?'}`)
  const body = { received: true }
  if (updated?.status !== 'completed' || updated.signedDocumentId || state.completing.has(request.id)) return { status: 200, body }
  state.completing.add(request.id)
  try {
    await store.updateSignatureRequest(request.id, { finishingAt: now })
  } catch (error) {
    state.completing.delete(request.id)
    throw error
  }
  return {
    status: 200,
    body,
    after: async () => {
      try {
        await completeRequest({ request: updated, firstCompletion: request.status !== 'completed', deps: completionDeps({ ...deps, log }, contract) })
      } catch (error) {
        log.error(`[esignatures] finishing ${request.id} failed:`, redact(error?.message))
      } finally {
        state.completing.delete(request.id)
      }
    },
  }
}

/**
 * "Check eSignatures.io" / "Finish e-signature" for an eSignatures.io request that has not ended: re-read
 * the contract and apply its status; when it reads signed, run the completion (idempotently) with a FRESH
 * PDF link - the one the webhook had may have lapsed. Refusals carry an HTTP status for the route.
 *
 * @returns {Promise<{refused: {status: number, error: string, message: string}} | {ok: true, request: object, signed: boolean, issues: string[]}>}
 */
export async function finishEsignaturesRequest(requestId, deps) {
  const { store, esignatures } = deps
  const log = deps.log ?? console
  const state = deps.state ?? sharedState
  const refuse = (status, error, message) => ({ refused: { status, error, message } })
  const request = await store.getSignatureRequest(requestId)
  if (!request) return refuse(404, 'not_found', 'No such signature request.')
  if (ENDED_STATUSES.includes(request.status)) {
    return refuse(409, 'ended', `This request ended (${request.status}), so there is nothing to check.`)
  }
  if (state.completing.has(request.id)) {
    return refuse(409, 'finishing', 'This signature is already being finished. Wait a minute, then check the page.')
  }
  state.completing.add(request.id)
  try {
    let contract
    try {
      contract = await esignatures.getContract(request.providerDocumentId ?? request.signwellDocumentId)
    } catch (error) {
      log.error(`[esignatures] could not read the contract to check ${request.id}:`, redact(error?.message))
      return refuse(502, 'esign_failed', 'eSignatures.io could not be reached, so nothing was checked. Try again in a minute.')
    }
    const reads = clean(contract?.status)
    const next = contractStatus(contract)
    if (!next) return refuse(409, 'not_completed', `eSignatures.io shows this contract as ${reads || 'unknown'}, which the app cannot read.`)
    const now = (deps.now ?? new Date()).toISOString()
    if (next !== 'completed') {
      if (request.status === 'completed') {
        return refuse(409, 'not_completed', `eSignatures.io shows this contract as ${reads}, not signed.`)
      }
      const updated = await store.updateSignatureRequest(request.id, { status: next })
      return { ok: true, request: updated ?? request, signed: false, issues: [] }
    }
    const updated =
      (await store.updateSignatureRequest(request.id, {
        status: 'completed',
        finishingAt: now,
        ...(request.completedAt ? {} : { completedAt: now }),
      })) ?? request
    const outcome = await completeRequest({
      request: updated,
      firstCompletion: request.status !== 'completed',
      deps: completionDeps({ ...deps, log }, contract),
    })
    return { ok: true, request: (await store.getSignatureRequest(request.id)) ?? updated, ...outcome }
  } finally {
    state.completing.delete(request.id)
  }
}

/**
 * Expire the eSignatures.io requests still sent or viewed `ESIGNATURES_EXPIRY_DAYS` after they went out
 * (no provider event says so). Never throws; logs the ids.
 * @returns {Promise<string[]>}
 */
export async function expireEsignaturesRequests({ store, now = new Date(), log = console }) {
  const cutoff = new Date(new Date(now).getTime() - ESIGNATURES_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
  try {
    const ids = await store.expireSignatureRequestsSentBefore('esignatures', cutoff)
    if (ids.length > 0) log.info(`[esignatures] expired ${ids.length} e-signature request(s) past their 30 days: ${ids.join(', ')}`)
    return ids
  } catch (error) {
    log.error('[esignatures] could not expire overdue e-signature requests:', redact(error?.message))
    return []
  }
}
