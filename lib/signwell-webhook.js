/**
 * The SignWell webhook handler (featreq-56d39567; docs/signwell.md). With lib/signwell.js the
 * only SignWell-specific code in the app: server.js hands it the raw body and the store, the
 * SignWell module and the owner notifier, and sends back what it answers. Written as a plain
 * function over those so every rule below is tested by running it.
 *
 * What the docs let us trust. The hash covers ONLY the event's type and time
 * (`HMAC-SHA256(webhook id, type@time)`), so a valid hash proves SignWell sent that type at that
 * time - not which document, nor what its body says. So, in this order:
 *  1. 503 without SIGNWELL_WEBHOOK_ID (logged once per boot); 400 for a body that is not JSON or an
 *     event older than 45 days; 401 on a bad, missing or malformed hash (it must be 64 hex characters);
 *  2. the document id in the body must be one of OUR requests (else 200 `ignored`);
 *  3. the event is ledgered once on sha256(type | time | hash | document id) - the canonical
 *     (trimmed, lower-case) hash, what the HMAC covers plus the document; a replay is 200 `duplicate`,
 *     no second write, no address stored. A second row on the SIGNED TRIPLE sha256(type | time | hash)
 *     notices the same signed event arriving for ANOTHER of our documents: that delivery is processed
 *     as a plain re-sync (the event type is ignored, the document alone decides), so a captured event
 *     replayed against another document can do nothing the document's own state does not, while a
 *     genuine event for a second document in the same second still lands. From here on a failure
 *     RELEASES the keys this delivery took and answers 500, so SignWell's retry is processed;
 *  4. the document is RE-FETCHED (`getDocument`) and its metadata must name this request's
 *     engagement. The status recorded comes ONLY from that document; the event type just tells
 *     "viewed" from "sent" while the document is not finished, and never sets a status the
 *     document does not show;
 *  5. the status moves (the store refuses to move a finished request) and the answer is sent.
 * A COMPLETED document is then finished AFTER the 200 goes out (`completeRequest`): the signed PDF
 * is fetched and kept, the engagement is marked signed through the same `signEngagement` Mark as
 * signed uses (client created, fees on billing, onboarding opened) and the owners are told - names
 * only. It signs only the letter the client was sent - text AND signing details unchanged - and, in
 * test mode, only the `Test` client; a changed letter, a superseding letter with open amendments, or
 * a test-mode signature on a real client is left for a person, with the reason. `finishing_at` marks
 * the work as under way until it ends, and `finishSignatureRequest` ("Check SignWell" / "Finish
 * e-signature") re-reads the document of any request that is not finished and runs it idempotently.
 * The signed document is never mailed to anyone.
 *
 * Logs carry ids and event types only: never the key, an address, or the document.
 */

import { createHash } from 'node:crypto'

import { engagementEsignHash } from './engagement-hash.js'
import { dateOnlyInZone, firmToday } from './firm-time.js'
import { ENDED_SIGNATURE_STATUSES } from './signature-statuses.js'
import { redact, verifyEventHash } from './signwell.js'

/** What each SignWell event type is about. Only `document_viewed` is read for a status; see `documentStatus`. */
export const SIGNWELL_EVENT_STATUS = Object.freeze({
  document_created: null,
  document_recipients_updated: null,
  document_sent: 'sent',
  document_viewed: 'viewed',
  document_in_progress: 'signed_partial',
  document_signed: 'signed_partial',
  document_completed: 'completed',
  document_declined: 'declined',
  document_expired: 'expired',
  document_canceled: 'canceled',
  document_bounced: 'bounced',
  document_error: 'error',
})

/** The documented Get Document `status` strings (lower-cased) and what they mean to us. Unknown or Draft: no change. */
const DOCUMENT_STATUS = Object.freeze({
  created: 'sent',
  sending: 'sent',
  sent: 'sent',
  viewed: 'viewed',
  pending: 'signed_partial',
  completed: 'completed',
  'manually completed': 'completed',
  declined: 'declined',
  canceled: 'canceled',
  cancelled: 'canceled',
  expired: 'expired',
  bounced: 'bounced',
  blocked: 'error',
  error: 'error',
})

/** What a request's metadata must say for an event to be ours. */
export const SIGNWELL_METADATA_APP = 'pbjbillingapp'
/** An event older than this is refused (no ledger): a replayed capture is not news. */
export const SIGNWELL_STALE_EVENT_MS = 45 * 24 * 60 * 60 * 1000
/** The client test-mode signatures are allowed to sign for. */
export const SIGNWELL_TEST_CLIENT_NAME = 'Test'
/** Statuses an owner's "Check SignWell" has nothing to check (the request ended; withdrawn = by the app). */
const ENDED_STATUSES = ENDED_SIGNATURE_STATUSES

/** The sentences a request's `last_error` and the owners' notice carry (no address, no document). */
export const SIGNWELL_ISSUES = Object.freeze({
  pdf: 'The signed PDF could not be saved - press Finish e-signature to retry, or download it from SignWell',
  changed:
    'The letter or its signing details changed after it went to SignWell - the client signed the earlier version; finish by hand',
  amendments: 'Choose which amendments to keep - finish by hand',
  manual: 'Marked complete in SignWell, not signed by the client - mark it signed by hand if that is right',
  testMode: 'Test mode - not marked signed; use Mark as signed if this was a real signature',
  notCompleted: (status) =>
    `SignWell reported it signed but the document reads ${status || 'unknown'} - press Check SignWell to retry`,
  unreadable: 'SignWell reports a signed engagement letter, but the app could not read it - press Check SignWell to retry, or mark it signed by hand',
  couldNotSign: (reason, retry = false) =>
    `It could not be marked signed: ${reason} - ${retry ? 'press Finish e-signature to retry' : 'finish it by hand'}`,
})

/** Process-wide handler state: the once-per-boot warning, and the requests being finished right now. */
const sharedState = { warnedUnconfigured: false, completing: new Set() }

/** Which store errors carry a sentence written for the owners' screen (the rest read as "unexpected"). */
const PLAIN_REFUSALS = new Set(['EngagementStateError', 'BillingMasterError', 'PackageApplyError'])

/** The amendments a superseding letter would replace unless kept in force: these statuses make one "open". */
const OPEN_AMENDMENT_STATUSES = ['draft', 'sent', 'signed']

const clean = (value) => String(value ?? '').trim()

/** `event.time` as an ISO instant: epoch seconds or milliseconds (number or numeric text), else a date string. */
export function eventTimeIso(time, now = new Date()) {
  const numeric = typeof time === 'number' ? time : /^\d+(\.\d+)?$/.test(clean(time)) ? Number(time) : null
  const instant = numeric !== null ? new Date(numeric < 1e11 ? numeric * 1000 : numeric) : new Date(clean(time))
  return Number.isNaN(instant.getTime()) ? new Date(now).toISOString() : instant.toISOString()
}

/** The hash as the ledger keys use it: trimmed and lower-case, so "the same hash" is one value. */
export const canonicalHash = (hash) => clean(hash).toLowerCase()

/**
 * The ledger key of an event: sha256(type | time | hash | document id) - exactly what the HMAC covers
 * plus the document, so no address is involved and a hash is all that is stored.
 */
export function eventKey({ documentId, type, time, hash }) {
  return createHash('sha256').update(`${type}|${time}|${canonicalHash(hash)}|${documentId}`).digest('hex')
}

/** The signed triple sha256(type | time | hash): the same event delivered for a different document shares it. */
export function signedTripleKey({ type, time, hash }) {
  return createHash('sha256').update(`${type}|${time}|${canonicalHash(hash)}`).digest('hex')
}

/** The signers with SignWell's own per-recipient status written over ours; its strings are never interpreted. */
function mergeRecipients(stored, fetched) {
  const fresh = new Map((Array.isArray(fetched) ? fetched : []).map((entry) => [String(entry?.id ?? ''), entry]))
  return stored.map((recipient) => {
    const status = clean(fresh.get(recipient.id)?.status)
    return status ? { ...recipient, status } : recipient
  })
}

/** The name an owner knows this letter by: the company, else the contact. Names only. */
function engagementName(engagement) {
  const party = engagement?.party ?? {}
  return clean(party.company) || clean(party.contactName) || 'A client'
}

export function signedPdfFileName(engagement) {
  const slug = engagementName(engagement)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return `Signed-Engagement-Letter-${slug || 'client'}.pdf`
}

/** The name for a notice about a request, best effort: the engagement's party, else "A client". */
async function nameOf(store, request) {
  try {
    return engagementName(await store.getEngagement(request.engagementId))
  } catch {
    return 'A client'
  }
}

/**
 * The status a re-fetched document means to us, with the event type only telling "viewed" from "sent"
 * while it is not finished (pass null to ignore it). Never a status the document does not show; null =
 * leave the status alone.
 */
export function documentStatus(document, eventType) {
  const mapped = DOCUMENT_STATUS[clean(document?.status).toLowerCase()] ?? null
  return mapped === 'sent' && eventType === 'document_viewed' ? 'viewed' : mapped
}

/** The owner who signs for the request: the one who sent it if still an active owner, else the first active owner. */
async function signingUser(store, request) {
  let owners = []
  try {
    owners = (await store.getTeamMembers()).filter((member) => member.role === 'owner')
  } catch {
    owners = []
  }
  return owners.find((owner) => owner.id === request.createdBy)?.id ?? owners[0]?.id ?? request.createdBy ?? 'system'
}

/** Tell the owners, never throwing: a notice that cannot go must not undo what was recorded. */
async function tell(deps, request, message, signed = false) {
  try {
    await deps.notifyOwners({ message, link: `/engagements/${request.engagementId}`, engagementId: request.engagementId, signed })
  } catch (error) {
    ;(deps.log ?? console).error(`[signwell] could not notify the owners for ${request.id}:`, redact(error?.message))
  }
}

/**
 * Whether this letter belongs to the existing `Test` client (test-mode signatures are only ever applied
 * to it). A letter with no client yet is NOT: signing it would create a second Test client.
 */
async function isTestClientLetter(store, engagement) {
  if (!engagement.clientId) return false
  try {
    return clean((await store.getClientById(engagement.clientId))?.name) === SIGNWELL_TEST_CLIENT_NAME
  } catch {
    return false
  }
}

/**
 * Finish a completed request: keep the signed PDF (once), mark the engagement signed (once, and only
 * the letter - and signing details - the client was sent; in test mode only the Test client's), tell
 * the owners. Safe to run again: the PDF is stored on conflict do nothing, a signed engagement is left
 * alone, and an owner is told again only when the problem is not the one already on the request.
 * Never throws (it runs after the response). A problem is recorded as the request's `last_error` AND
 * said to the owners in plain words; `finishing_at` is cleared however it ends.
 *
 * Shared with eSignatures.io (lib/esignatures-webhook.js, task 18): `deps.fetchSignedPdf(request)` replaces
 * SignWell's completed-PDF call and `deps.providerLabel` names the provider in the note and the sentences
 * (SignWell when absent, so SignWell's own path is unchanged).
 */
export async function completeRequest({ request, firstCompletion, deps }) {
  const { store, signwell } = deps
  const log = deps.log ?? console
  const label = deps.providerLabel ?? 'SignWell'
  const say = (text) => (label === 'SignWell' ? text : text.split('SignWell').join(label))
  const fetchSignedPdf = deps.fetchSignedPdf ?? ((row) => signwell.getCompletedPdf(row.signwellDocumentId))
  const issues = []
  let engagement = null
  try {
    engagement = await store.getEngagement(request.engagementId)
  } catch (error) {
    log.error(`[signwell] could not read engagement ${request.engagementId}:`, redact(error?.message))
  }

  // 1. The signed PDF (downloaded in the app; never mailed).
  let pdfKept = Boolean(request.signedDocumentId)
  if (!request.signedDocumentId) {
    try {
      const bytes = await fetchSignedPdf(request)
      const meta = await store.storeSignedDocument({
        signatureRequestId: request.id,
        fileName: signedPdfFileName(engagement),
        bytes,
      })
      await store.updateSignatureRequest(request.id, { signedDocumentId: meta.id })
      pdfKept = true
      log.info(`[signwell] kept the signed PDF for ${request.id} (${meta.byteSize} bytes)`)
    } catch (error) {
      log.error(`[signwell] could not keep the signed PDF for ${request.id}:`, redact(error?.message))
      issues.push(SIGNWELL_ISSUES.pdf)
    }
  }

  // 2. Mark the engagement signed, through the path the button uses - but only what the client signed.
  let signed = false
  if (!engagement) {
    issues.push(SIGNWELL_ISSUES.couldNotSign('the engagement could not be read', true))
  } else if (engagement.status === 'signed') {
    signed = true // marked by hand in the meantime: nothing left to do
  } else if (!request.esignHash || engagementEsignHash(engagement) !== request.esignHash) {
    issues.push(SIGNWELL_ISSUES.changed)
  } else if (request.testMode && !(await isTestClientLetter(store, engagement))) {
    // A test-mode document is not binding: it never signs a real client's letter.
    issues.push(SIGNWELL_ISSUES.testMode)
  } else {
    let openAmendments = false
    let checked = true
    if (engagement.kind === 'superseding' && engagement.clientId) {
      try {
        const rows = await store.listEngagements({ clientId: engagement.clientId })
        openAmendments = rows.some((row) => row.kind === 'amendment' && OPEN_AMENDMENT_STATUSES.includes(row.status))
      } catch (error) {
        checked = false
        log.error(`[signwell] could not check the open amendments for ${request.engagementId}:`, redact(error?.message))
      }
    }
    if (!checked) {
      issues.push(SIGNWELL_ISSUES.couldNotSign("the client's open amendments could not be checked", true))
    } else if (openAmendments) {
      issues.push(SIGNWELL_ISSUES.amendments)
    } else {
      const userId = await signingUser(store, request)
      const today = (deps.today ?? firmToday)()
      const day = dateOnlyInZone(new Date(request.completedAt ?? deps.now ?? new Date()))
      try {
        const result = await store.signEngagement(engagement.id, {
          signedOn: day && day <= today ? day : today,
          note: `Signed electronically through ${label}`,
          // An active owner: the onboarding checklist of a new client is assigned to this id.
          userId,
          confirmChanged: false,
        })
        if (!result) issues.push(SIGNWELL_ISSUES.couldNotSign('the engagement could not be found'))
        else {
          signed = true
          await deps.afterSigned?.(result, request, userId)
        }
      } catch (error) {
        const plain = PLAIN_REFUSALS.has(error?.name)
        issues.push(
          SIGNWELL_ISSUES.couldNotSign(plain ? clean(error.message) : 'an unexpected error stopped it - see the server log', !plain),
        )
        log.error(`[signwell] could not mark engagement ${request.engagementId} signed (${error?.name}):`, redact(error?.message))
      }
    }
  }

  // 3. Record the outcome and say what happened. Names only; the first completion, or a problem that is
  // not the one already on the request (a re-run that hits the same wall says nothing new).
  const said = issues.map(say)
  // A marker the provider keeps FIRST while the PDF is still not kept (eSignatures.io's 3-day give-up), so a
  // re-run cannot wipe it and the 500-character cap cannot cut it. SignWell passes none.
  const prefix = pdfKept ? null : (deps.lastErrorPrefix?.(request) ?? null)
  const lastError = [prefix, ...said].filter(Boolean).join('; ') || null
  try {
    await store.updateSignatureRequest(request.id, { lastError, finishingAt: null })
  } catch (error) {
    log.error(`[signwell] could not record the outcome for ${request.id}:`, redact(error?.message))
  }
  if (firstCompletion || (lastError !== null && lastError !== request.lastError)) {
    const test = request.testMode ? ' (test mode)' : ''
    await tell(
      deps,
      request,
      `${engagementName(engagement)} signed their engagement letter electronically${test}${said.length > 0 ? `. ${said.join('. ')}` : ''}`,
      signed,
    )
  }
  return { signed, issues: said }
}

/** True for a request SignWell completed MANUALLY (a person, not the client): its note says so. */
const isManualCompletion = (request) => String(request?.lastError ?? '').startsWith(SIGNWELL_ISSUES.manual)

/** The "reported it signed but the document reads ..." note's fixed start (SIGNWELL_ISSUES.notCompleted). */
const NOT_COMPLETED_NOTE = SIGNWELL_ISSUES.notCompleted('').split(' unknown')[0]

/** A request's `last_error` without the not-completed note (the other sentences kept); null when nothing is left. */
export function withoutNotCompletedNote(lastError) {
  const left = String(lastError ?? '')
    .split('; ')
    .filter((part) => part && !part.startsWith(NOT_COMPLETED_NOTE))
  return left.length > 0 ? left.join('; ') : null
}

/** A manually completed document: completed, nothing signed for the client, the owners told once. */
async function noteManualCompletion(request, deps) {
  const lastError = SIGNWELL_ISSUES.manual
  await deps.store.updateSignatureRequest(request.id, { lastError })
  if (request.lastError !== lastError) {
    await tell(deps, request, `${await nameOf(deps.store, request)}: ${lastError}`)
  }
  return { signed: false, issues: [lastError] }
}

/**
 * "Check SignWell" / "Finish e-signature": for any request that has not ended, re-read its document and
 * apply what it says (the event type is not involved), and run the completion when it reads Completed -
 * idempotently, the same work the webhook runs after its 200. Safe on a request that is already
 * finished. Refusals carry an HTTP status for the route.
 *
 * @returns {Promise<{refused: {status: number, error: string, message: string}} | {ok: true, request: object, signed: boolean, issues: string[]}>}
 */
export async function finishSignatureRequest(requestId, deps) {
  const { store, signwell } = deps
  const log = deps.log ?? console
  const state = deps.state ?? sharedState
  const refuse = (status, error, message) => ({ refused: { status, error, message } })
  const request = await store.getSignatureRequest(requestId)
  if (!request) return refuse(404, 'not_found', 'No such signature request.')
  if (ENDED_STATUSES.includes(request.status)) {
    return refuse(409, 'ended', `SignWell ended this request (${request.status}), so there is nothing to check.`)
  }
  // Held before anything is awaited: two presses at once cannot both run it.
  if (state.completing.has(request.id)) {
    return refuse(409, 'finishing', 'This signature is already being finished. Wait a minute, then check the page.')
  }
  state.completing.add(request.id)
  try {
    let document
    try {
      document = await signwell.getDocument(request.signwellDocumentId)
    } catch (error) {
      log.error(`[signwell] could not read the document to check ${request.id}:`, redact(error?.message))
      return refuse(502, 'esign_failed', 'SignWell could not be reached, so nothing was checked. Try again in a minute.')
    }
    const reads = clean(document?.status)
    const next = documentStatus(document, null)
    const recipients = mergeRecipients(request.recipients, document?.recipients)
    if (!next) {
      return refuse(409, 'not_completed', `SignWell shows this document as ${reads || 'unknown'}, which the app cannot read.`)
    }
    const now = (deps.now ?? new Date()).toISOString()
    if (next === 'completed' && reads.toLowerCase() === 'manually completed') {
      await store.updateSignatureRequest(request.id, {
        status: 'completed',
        recipients,
        lastError: SIGNWELL_ISSUES.manual,
        ...(request.completedAt ? {} : { completedAt: now }),
      })
      const outcome = await noteManualCompletion(request, deps)
      return { ok: true, request: (await store.getSignatureRequest(request.id)) ?? request, ...outcome }
    }
    let current = request
    if (next !== 'completed') {
      if (request.status === 'completed') {
        return refuse(409, 'not_completed', `SignWell shows this document as ${reads || 'unknown'}, not completed.`)
      }
      let updated = await store.updateSignatureRequest(request.id, { status: next, recipients })
      // The document answered: an older "reported it signed but the document reads ..." note is settled. Read off
      // the row just written (a completion meanwhile keeps its own note), and only while it is not completed.
      const note = withoutNotCompletedNote(updated?.lastError)
      if (updated && updated.status !== 'completed' && note !== (updated.lastError ?? null)) {
        updated = (await store.updateSignatureRequest(request.id, { lastError: note })) ?? updated
      }
      // A completion can have landed while the document was being read (the webhook found this press holding
      // the lock and left the work to it): the store keeps a finished request finished, so finish it here -
      // unless it was a MANUAL completion (marked complete at SignWell, not signed by the client), which
      // signs nothing.
      if (!(updated?.status === 'completed' && !updated.signedDocumentId) || isManualCompletion(updated)) {
        return {
          ok: true,
          request: updated ?? request,
          signed: false,
          issues: isManualCompletion(updated) ? [SIGNWELL_ISSUES.manual] : [],
        }
      }
      current = updated
    }
    const updated =
      (await store.updateSignatureRequest(request.id, {
        status: 'completed',
        recipients,
        finishingAt: now,
        ...(current.completedAt ? {} : { completedAt: now }),
      })) ?? current
    // Withdrawn (the letter voided or signed by hand) while the document was being read: nothing to finish.
    if (updated.status !== 'completed') {
      await store.updateSignatureRequest(request.id, { finishingAt: null })
      return refuse(409, 'ended', `This request ended (${updated.status}), so there is nothing to finish.`)
    }
    const outcome = await completeRequest({
      request: updated,
      firstCompletion: request.status !== 'completed',
      deps: { ...deps, log },
    })
    return { ok: true, request: (await store.getSignatureRequest(request.id)) ?? updated, ...outcome }
  } finally {
    state.completing.delete(request.id)
  }
}

/**
 * Handle one webhook delivery.
 *
 * @param {object} args
 * @param {string} args.rawBody
 * @param {string|undefined} args.webhookId   SIGNWELL_WEBHOOK_ID
 * @param {object} args.deps
 *   store: {getSignatureRequestByDocumentId, recordSignwellEventOnce, forgetSignwellEvent,
 *           updateSignatureRequest, getEngagement, getClientById, listEngagements, getTeamMembers,
 *           storeSignedDocument, signEngagement}
 *   signwell: {getDocument, getCompletedPdf}
 *   notifyOwners({message, link}): tells every owner (names only)
 *   afterSigned?(signResult, request, userId): the route's bookkeeping after signing (activity, broadcast)
 *   log?: console-like; today?: () => 'YYYY-MM-DD'; state?: the once-per-boot flag and in-flight set; now?: Date
 * @returns {Promise<{status: number, body: object, after?: () => Promise<void>}>} `after` runs once the
 *   answer has been sent.
 */
export async function handleSignwellWebhook({ rawBody, webhookId, deps }) {
  const { store } = deps
  const log = deps.log ?? console
  const state = deps.state ?? sharedState
  if (!clean(webhookId)) {
    if (!state.warnedUnconfigured) {
      state.warnedUnconfigured = true
      log.warn('[signwell] webhook received but SIGNWELL_WEBHOOK_ID is not set - answering 503')
    }
    return { status: 503, body: { error: 'SignWell webhooks are not configured' } }
  }
  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { error: 'Could not read body' } }
  }
  const event = payload && typeof payload === 'object' ? payload.event : null
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    return { status: 400, body: { error: 'Could not read body' } }
  }
  // A hash is 64 hex characters: anything else is refused before any lookup, so the ledger only ever
  // sees one spelling of a given hash.
  const hash = canonicalHash(event.hash)
  if (!/^[0-9a-f]{64}$/.test(hash) || !verifyEventHash(event, webhookId)) {
    log.warn('[signwell] rejected a webhook with an invalid hash')
    return { status: 401, body: { error: 'Invalid signature' } }
  }
  const now = deps.now ?? new Date()
  const eventAt = eventTimeIso(event.time, now)
  if (now.getTime() - Date.parse(eventAt) > SIGNWELL_STALE_EVENT_MS) {
    log.warn(`[signwell] rejected a ${event.type} event older than 45 days`)
    return { status: 400, body: { error: 'Event too old' } }
  }

  const documentId = typeof payload?.data?.object?.id === 'string' ? payload.data.object.id : ''
  // Only a SignWell request: an eSignatures.io contract with the same id is not this event's.
  const request = documentId ? await store.getSignatureRequestByDocumentId(documentId, 'signwell') : null
  if (!request) {
    log.info(`[signwell] ignored a ${event.type} event for a document that is not ours`)
    return { status: 200, body: { received: true, ignored: true } }
  }

  const key = eventKey({ documentId, type: event.type, time: event.time, hash })
  const triple = signedTripleKey({ type: event.type, time: event.time, hash })
  if (!(await store.recordSignwellEventOnce(key, event.type))) {
    return { status: 200, body: { received: true, duplicate: true } }
  }

  // Past the first ledger row: a failure releases the keys THIS delivery took and answers 500, so
  // SignWell's retry is processed. (The triple is released only if this delivery was the one to take it.)
  let ownsTriple = false
  const retry = async (reason) => {
    log.error(`[signwell] could not process ${event.type} for ${request.id}:`, reason)
    for (const held of ownsTriple ? [key, triple] : [key]) await Promise.resolve(store.forgetSignwellEvent(held)).catch(() => {})
    return { status: 500, body: { error: 'Could not process the event' } }
  }
  try {
    ownsTriple = await store.recordSignwellEventOnce(triple, event.type)
    // The same signed event already used for another document: re-sync from the document, nothing else.
    if (!ownsTriple) log.warn(`[signwell] a ${event.type} event's signature was already used for another document - re-syncing from the document only`)
    return await processEvent({ event, eventAt, documentId, request, deps, log, state, retry, resync: !ownsTriple })
  } catch (error) {
    return retry(redact(error?.message))
  }
}

async function processEvent({ event, eventAt, documentId, request, deps, log, state, retry, resync }) {
  const { store, signwell } = deps
  // The hash vouches for the type and the time only: read the document itself before acting.
  let document
  try {
    document = await signwell.getDocument(documentId)
  } catch (error) {
    const reason = redact(error?.message)
    const lastError = `Could not read the document after a ${event.type} event: ${reason}`.slice(0, 500)
    await Promise.resolve(store.updateSignatureRequest(request.id, { lastError })).catch(() => {})
    if (event.type === 'document_completed' && !resync && request.lastError !== lastError) {
      await tell(deps, request, `${await nameOf(store, request)}: ${SIGNWELL_ISSUES.unreadable}`)
    }
    return retry(reason)
  }
  const metadata = document?.metadata && typeof document.metadata === 'object' ? document.metadata : {}
  if (metadata.app !== SIGNWELL_METADATA_APP || metadata.engagement_id !== request.engagementId) {
    log.info(`[signwell] ignored a ${event.type} event: the document's metadata is not ${request.id}'s`)
    return { status: 200, body: { received: true, ignored: true } }
  }

  const reads = clean(document.status)
  const manual = reads.toLowerCase() === 'manually completed'
  // A re-sync ignores the event type: the document alone decides.
  const next = documentStatus(document, resync ? null : event.type)
  const recipients = mergeRecipients(request.recipients, document.recipients)

  // A completed event the document does not bear out: record it, tell the owners once, and release the
  // ledger key so a retry (once SignWell has caught up) is processed. The event's time is NOT stamped:
  // nothing was learned from it.
  if (!resync && event.type === 'document_completed' && next !== 'completed') {
    const lastError = SIGNWELL_ISSUES.notCompleted(reads)
    log.warn(`[signwell] a completed event for ${request.id} but the document reads ${reads || 'unknown'}`)
    await store.updateSignatureRequest(request.id, { ...(next ? { status: next } : {}), recipients, lastError })
    if (request.lastError !== lastError) await tell(deps, request, `${await nameOf(store, request)}: ${lastError}`)
    return retry('the document is not completed')
  }

  const updated = await store.updateSignatureRequest(request.id, {
    ...(next ? { status: next } : {}),
    recipients,
    ...(resync ? {} : { lastEventAt: eventAt }),
    // A re-sync is not the event's moment: the completion is stamped when it was learned.
    ...(next === 'completed' && !request.completedAt
      ? { completedAt: resync ? (deps.now ?? new Date()).toISOString() : eventAt }
      : {}),
    // Manually completed: the note goes in the SAME update as the completed status, so a Finish press reading
    // the row in between never sees a completed request without it (only on a request that has not ended).
    ...(manual && next === 'completed' && !['completed', ...ENDED_STATUSES].includes(request.status) ? { lastError: SIGNWELL_ISSUES.manual } : {}),
    // A re-synced "completed" the document does not bear out is shown (no notice, no retry loop): Check SignWell can finish it.
    ...(resync && event.type === 'document_completed' && next !== 'completed'
      ? { lastError: SIGNWELL_ISSUES.notCompleted(reads) }
      : {}),
  })
  log.info(`[signwell] ${resync ? 'resync' : event.type} for ${request.id}: ${request.status} -> ${updated?.status ?? '?'}`)
  const body = { received: true }
  if (!(updated?.status === 'completed' && next === 'completed')) return { status: 200, body }

  // Marked complete by a person at SignWell, not signed by the client: nothing is signed for them.
  if (manual) {
    if (updated.lastError !== SIGNWELL_ISSUES.manual) await store.updateSignatureRequest(request.id, { lastError: SIGNWELL_ISSUES.manual })
    return {
      status: 200,
      body,
      after: async () => {
        if (request.lastError !== SIGNWELL_ISSUES.manual) {
          await tell(deps, request, `${await nameOf(store, request)}: ${SIGNWELL_ISSUES.manual}`)
        }
      },
    }
  }

  // A manual completion recorded meanwhile (by a Check SignWell press) never runs the completion either.
  if (updated.signedDocumentId || state.completing.has(request.id) || isManualCompletion(updated)) return { status: 200, body }
  state.completing.add(request.id)
  // Under way until completeRequest ends: a crash leaves this set, and "Finish e-signature" picks it up.
  try {
    await store.updateSignatureRequest(request.id, { finishingAt: (deps.now ?? new Date()).toISOString() })
  } catch (error) {
    state.completing.delete(request.id)
    throw error
  }
  return {
    status: 200,
    body,
    after: async () => {
      try {
        await completeRequest({ request: updated, firstCompletion: request.status !== 'completed', deps })
      } catch (error) {
        log.error(`[signwell] finishing ${request.id} failed:`, redact(error?.message))
      } finally {
        state.completing.delete(request.id)
      }
    },
  }
}
