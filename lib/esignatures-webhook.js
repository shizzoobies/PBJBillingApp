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
 *     The re-read waits at most 8 s (eSignatures.io gives up on us at 15 s). A re-read with no PDF link falls
 *     back to the link in the (verified) event; a contract signed after the app already ended the request
 *     (its own 30-day expiry ran first) signs nothing but logs an [esign] line and tells the owners once.
 * eSignatures.io sends no expiry event: `expireEsignaturesRequests` (an hourly job) expires a request still
 * sent or viewed 30 days after it went out, when its link lapses. The same job runs
 * `retryPendingEsignaturesPdfs`: a signed PDF that could not be kept is fetched again for up to 3 days.
 *
 * Logs carry ids and event names only: never the token, an address, a PDF link or the document.
 */

import { createHash } from 'node:crypto'

import { redact, verifyWebhookSignature } from './esignatures.js'
import { ENDED_SIGNATURE_STATUSES, FINISHED_SIGNATURE_STATUSES } from './signature-statuses.js'
import { completeRequest, signedPdfFileName } from './signwell-webhook.js'

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
/** The webhook's re-read must answer well inside eSignatures.io's own 15 second timeout. */
export const ESIGNATURES_REREAD_TIMEOUT_MS = 8000
/** A signed PDF that could not be kept is retried hourly this long after signing (its link lives 3 days). */
export const ESIGNATURES_PDF_RETRY_MS = 3 * 24 * 60 * 60 * 1000
const LABEL = 'eSignatures.io'
/** Ended without a signature here; `withdrawn` = the app withdrew it (the letter voided, signed by hand or superseded). */
const ENDED_STATUSES = ENDED_SIGNATURE_STATUSES
/** Statuses a request never leaves (lib/signature-statuses.js, as the store applies them). */
const FINISHED_STATUSES = FINISHED_SIGNATURE_STATUSES
/** A `finishing_at` older than this is a completion that died part-way (listStuckSignatureRequestIds' grace). */
export const ESIGNATURES_STALE_FINISHING_MS = 10 * 60 * 1000

export const ESIGNATURES_ISSUES = Object.freeze({
  notSigned: (status) => `eSignatures.io reported it signed but the contract reads ${status || 'unknown'} - press Check eSignatures.io to retry`,
  unreadable: 'eSignatures.io reports a signed engagement letter, but the app could not read it - press Check eSignatures.io to retry, or mark it signed by hand',
  /** Names the address the request went to (its stored signer), never the party's: the two can differ. */
  delivery: (email) =>
    `eSignatures.io could not deliver the signing email${email ? ` to ${email}` : ''} - check the address, then send again`,
  problem: 'eSignatures.io reported a problem with this contract - press Check eSignatures.io',
  /** What the shared completion records when the PDF could not be kept (SIGNWELL_ISSUES.pdf, named for eSignatures.io). */
  pdf: 'The signed PDF could not be saved - press Finish e-signature to retry, or download it from eSignatures.io',
  pdfGaveUp: 'The signed PDF could not be fetched from eSignatures.io for 3 days - download it from eSignatures.io and keep it by hand',
  signedAfterEnd: (status) =>
    status === 'withdrawn'
      ? 'eSignatures.io reports the letter signed after the app withdrew the request (the letter was voided, marked signed or superseded) - nothing was changed here; check the signed copy in eSignatures.io'
      : `eSignatures.io reports the letter signed, but the app had already marked the request ${status} - check it in eSignatures.io and mark the letter signed by hand if that is right`,
})

/**
 * Process-wide state: the once-per-boot warning, the requests being finished right now, and the signed-PDF link a
 * contract-signed event carried (by request id; kept in memory only - it is a short-lived credential), the hourly
 * retry's second choice after a fresh re-read.
 */
const sharedState = { warnedUnconfigured: false, completing: new Set(), payloadPdfUrls: new Map() }

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

/** The first of `urls` that downloads (each tried once, in order); throws the last failure. */
async function downloadFirst(esignatures, urls) {
  const tries = [...new Set(urls.map(clean).filter(Boolean))]
  if (tries.length === 0) throw new Error('eSignatures.io gave no signed PDF link')
  let failure = null
  for (const url of tries) {
    try {
      return await esignatures.downloadSignedPdf(url)
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/**
 * The deps the shared completion is given: the PDF from THIS contract's (re-read) link, else the link the
 * HMAC-verified event carried; the provider named.
 */
function completionDeps(deps, contract, payloadUrl = null) {
  return {
    ...deps,
    providerLabel: LABEL,
    fetchSignedPdf: () => downloadFirst(deps.esignatures, [contract?.contract_pdf_url, payloadUrl]),
    // The 3-day give-up stays first in last_error while the PDF is still missing (a Finish press keeps it).
    lastErrorPrefix: (request) => (pdfGaveUp(request) ? ESIGNATURES_ISSUES.pdfGaveUp : null),
  }
}

const payloadUrlsOf = (state) => {
  if (!(state.payloadPdfUrls instanceof Map)) state.payloadPdfUrls = new Map()
  return state.payloadPdfUrls
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
    if (status === 'contract-signed') {
      // The body is HMAC-verified, so its link is genuine: the fallback when the re-read carries none.
      const payloadUrl = typeof contract.contract_pdf_url === 'string' ? contract.contract_pdf_url : null
      return await processSigned({ request, contractId, payloadUrl, deps, log, state, retry })
    }
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
    lastError = delivery ? ESIGNATURES_ISSUES.delivery(clean(request.recipients?.[0]?.email)) : ESIGNATURES_ISSUES.problem
  }
  // A request that already ended (signed, declined, expired, canceled) keeps its own sentence: a late delivery
  // error must not overwrite the completion's outcome or the PDF give-up marker. (The store keeps its status.)
  const ended = FINISHED_STATUSES.includes(request.status)
  const updated = await deps.store.updateSignatureRequest(request.id, {
    ...(next ? { status: next } : {}),
    lastEventAt: now,
    ...(lastError && !ended ? { lastError } : {}),
  })
  log.info(`[esignatures] ${status} for ${request.id}: ${request.status} -> ${updated?.status ?? '?'}`)
  return { status: 200, body: { received: true } }
}

/** contract-signed: re-read, check, mark completed, answer; the PDF and the signing run after the answer. */
async function processSigned({ request, contractId, payloadUrl, deps, log, state, retry }) {
  const { store, esignatures } = deps
  if (payloadUrl) payloadUrlsOf(state).set(request.id, payloadUrl)
  let contract
  try {
    contract = await esignatures.getContract(contractId, { timeoutMs: ESIGNATURES_REREAD_TIMEOUT_MS })
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

  // Signed after the app ended the request (its own 30-day expiry ran first, it was declined, or the app withdrew
  // it): a finished request never changes, so nothing is signed - but a real signature is never dropped silently.
  const signedAfterEnd = async (ended) => {
    const lastError = ESIGNATURES_ISSUES.signedAfterEnd(ended.status)
    ;(deps.log ?? console).warn(`[esign] a signed eSignatures.io contract arrived for ${request.id}, already ${ended.status} - the owners are told`)
    await store.updateSignatureRequest(request.id, { lastError })
    if (ended.lastError !== lastError) await tell(deps, request, `${await nameOf(store, request)}: ${lastError}`)
    return { status: 200, body: { received: true } }
  }
  if (ENDED_STATUSES.includes(request.status)) return signedAfterEnd(request)

  const now = (deps.now ?? new Date()).toISOString()
  const updated = await store.updateSignatureRequest(request.id, {
    status: 'completed',
    lastEventAt: now,
    ...(request.completedAt ? {} : { completedAt: now }),
  })
  log.info(`[esignatures] contract-signed for ${request.id}: ${request.status} -> ${updated?.status ?? '?'}`)
  // Ended between the read above and this update (the letter voided or signed by hand withdrew it): the store
  // kept it ended, so nothing is signed or kept - the owners are told, as for any signature after the end.
  if (updated && ENDED_STATUSES.includes(updated.status)) return signedAfterEnd(updated)
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
        await completeRequest({
          request: updated,
          firstCompletion: request.status !== 'completed',
          deps: completionDeps({ ...deps, log }, contract, payloadUrl),
        })
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
      // Still out, but its letter no longer stands (an earlier withdrawal failed and left it open): withdraw it
      // now, so a voided, superseded or signed letter does not stay signable.
      if (next === 'sent' && typeof deps.withdrawSignatureRequest === 'function') {
        const engagement = await Promise.resolve(store.getEngagement(request.engagementId)).catch(() => null)
        const reason = LETTER_CLOSED_REASONS[engagement?.status] ?? null
        if (reason) {
          const withdrawn = await deps.withdrawSignatureRequest(request, { ...deps, reason, log })
          if (withdrawn?.withdrawn) return { ok: true, request: withdrawn.request, signed: false, issues: [] }
        }
      }
      let updated = await store.updateSignatureRequest(request.id, { status: next })
      // The contract answered: an older "reported it signed but the contract reads ..." note is settled. Read off
      // the row just written (never the one read before the call), and only while the request is not completed.
      const note = withoutNotSignedNote(updated?.lastError)
      if (updated && updated.status !== 'completed' && note !== (updated.lastError ?? null)) {
        updated = (await store.updateSignatureRequest(request.id, { lastError: note })) ?? updated
      }
      return { ok: true, request: updated ?? request, signed: false, issues: [] }
    }
    const updated =
      (await store.updateSignatureRequest(request.id, {
        status: 'completed',
        finishingAt: now,
        ...(request.completedAt ? {} : { completedAt: now }),
      })) ?? request
    // Withdrawn (the letter voided or signed by hand) while the contract was being read: the store kept it
    // ended, so nothing is kept or signed here.
    if (updated.status !== 'completed') {
      await store.updateSignatureRequest(request.id, { finishingAt: null })
      return refuse(409, 'ended', `This request ended (${updated.status}), so there is nothing to finish.`)
    }
    const outcome = await completeRequest({
      request: updated,
      firstCompletion: request.status !== 'completed',
      deps: completionDeps({ ...deps, log }, contract, payloadUrlsOf(state).get(request.id)),
    })
    return { ok: true, request: (await store.getSignatureRequest(request.id)) ?? updated, ...outcome }
  } finally {
    state.completing.delete(request.id)
  }
}

/** A letter that no longer stands, by status -> the withdrawal reason (lib/engagement-esign.js ESIGN_WITHDRAW_REASONS). */
const LETTER_CLOSED_REASONS = Object.freeze({ void: 'void', superseded: 'superseded', signed: 'signed' })

/** The "reported it signed but the contract reads ..." note's fixed start (ESIGNATURES_ISSUES.notSigned). */
const NOT_SIGNED_NOTE = ESIGNATURES_ISSUES.notSigned('').split(' unknown')[0]

/** A request's `last_error` without the not-signed note (the other sentences kept); null when nothing is left. */
export function withoutNotSignedNote(lastError) {
  const left = String(lastError ?? '')
    .split('; ')
    .filter((part) => part && !part.startsWith(NOT_SIGNED_NOTE))
  return left.length > 0 ? left.join('; ') : null
}

/** A request's `last_error` with one sentence taken out (the issues are joined with "; "); null when none is left. */
function withoutIssue(lastError, issue) {
  const left = String(lastError ?? '')
    .split('; ')
    .filter((part) => part && part !== issue)
  return left.length > 0 ? left.join('; ') : null
}

/** True when a request's `last_error` carries the give-up marker - always placed FIRST, so it survives the cap. */
export const pdfGaveUp = (request) => String(request?.lastError ?? '').startsWith(ESIGNATURES_ISSUES.pdfGaveUp)

/**
 * The hourly retry of signed PDFs that could not be kept (`documentPending`): for each eSignatures.io request
 * completed without one, within `ESIGNATURES_PDF_RETRY_MS` of signing, re-read the contract for a FRESH link
 * (then the link its contract-signed event carried, if this process heard it), download, keep it and take the
 * PDF sentence off `last_error`. A request whose completion died part-way (`finishing_at` older than
 * `ESIGNATURES_STALE_FINISHING_MS`) gets the whole completion run again (idempotent: PDF, signing). One being
 * finished right now (the in-process lock, or a fresh `finishing_at`) is left alone, and the lock is held while
 * a row is worked on, so a Finish press cannot run alongside. Past 3 days it gives up ONCE: the give-up marker
 * goes FIRST in `last_error` (a later Finish press keeps it while the PDF is still missing) and the owners are
 * told (names only). Never throws.
 *
 * @returns {Promise<{kept: string[], gaveUp: string[]}>}
 */
export async function retryPendingEsignaturesPdfs(deps) {
  const { store, esignatures } = deps
  const log = deps.log ?? console
  const state = deps.state ?? sharedState
  const now = new Date(deps.now ?? new Date())
  const result = { kept: [], gaveUp: [] }
  let rows = []
  try {
    rows = await store.listSignatureRequestsAwaitingDocument('esignatures')
  } catch (error) {
    log.error('[esignatures] could not list the signed PDFs still to keep:', redact(error?.message))
    return result
  }
  for (const row of rows) {
    if (pdfGaveUp(row) || state.completing.has(row.id)) continue
    const stale = Boolean(row.finishingAt) && now.getTime() - Date.parse(row.finishingAt) > ESIGNATURES_STALE_FINISHING_MS
    if (row.finishingAt && !stale) continue
    state.completing.add(row.id)
    try {
      if (now.getTime() - Date.parse(row.completedAt) > ESIGNATURES_PDF_RETRY_MS) {
        const rest = withoutIssue(row.lastError, ESIGNATURES_ISSUES.pdf)
        await store.updateSignatureRequest(row.id, {
          lastError: [ESIGNATURES_ISSUES.pdfGaveUp, rest].filter(Boolean).join('; '),
          ...(row.finishingAt ? { finishingAt: null } : {}),
        })
        payloadUrlsOf(state).delete(row.id)
        log.warn(`[esignatures] gave up on the signed PDF for ${row.id} after 3 days`)
        await tell(deps, row, `${await nameOf(store, row)}: ${ESIGNATURES_ISSUES.pdfGaveUp}`)
        result.gaveUp.push(row.id)
        continue
      }
      let fresh = null
      try {
        fresh = await esignatures.getContract(row.providerDocumentId ?? row.signwellDocumentId)
      } catch (error) {
        log.warn(`[esignatures] could not re-read the contract for ${row.id}:`, redact(error?.message))
      }
      if (stale) {
        // A completion that died part-way: run all of it again (it clears finishing_at however it ends).
        log.warn(`[esignatures] finishing ${row.id} again: it was left finishing`)
        await completeRequest({ request: row, firstCompletion: false, deps: completionDeps({ ...deps, log }, fresh, payloadUrlsOf(state).get(row.id)) })
        if ((await store.getSignatureRequest(row.id))?.signedDocumentId) {
          payloadUrlsOf(state).delete(row.id)
          result.kept.push(row.id)
        }
        continue
      }
      const bytes = await downloadFirst(esignatures, [fresh?.contract_pdf_url, payloadUrlsOf(state).get(row.id)])
      const engagement = await store.getEngagement(row.engagementId).catch(() => null)
      const meta = await store.storeSignedDocument({ signatureRequestId: row.id, fileName: signedPdfFileName(engagement), bytes })
      await store.updateSignatureRequest(row.id, {
        signedDocumentId: meta.id,
        lastError: withoutIssue(row.lastError, ESIGNATURES_ISSUES.pdf),
      })
      payloadUrlsOf(state).delete(row.id)
      log.info(`[esignatures] kept the signed PDF for ${row.id} on a retry (${meta.byteSize} bytes)`)
      result.kept.push(row.id)
    } catch (error) {
      log.warn(`[esignatures] the signed PDF for ${row.id} is still not kept:`, redact(error?.message))
    } finally {
      state.completing.delete(row.id)
    }
  }
  return result
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
