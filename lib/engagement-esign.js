/**
 * Sending ONE engagement letter for electronic signature, and reminding about it
 * (featreq-56d39567; docs/signwell.md), as plain functions over the store and the SignWell
 * module so every rule is tested by running it, not by reading server.js. Mirrors
 * lib/engagement-send.js, whose preview and refusals it reuses: what the signer is shown
 * is what `Send` would have emailed, built by the same builder, so the two can never drift.
 *
 * The signer is the engagement's party - one client signer, no countersignature. The firm
 * does NOT email the letter itself: SignWell emails the signer a link to sign. Nothing here
 * notifies an owner or copies the letter to anyone (Alex, 2026-10-08).
 *
 * The PDF is the letter we render ourselves, with SignWell's text tags written in white at
 * its "Signature:" and "Date:" lines (lib/letter-pdf.js `signatureTags`). If the tags prove
 * unreliable in a test run, ESIGN_FIELD_MODE switches to coordinate fields - their units are
 * NOT documented, so that path is a best guess until it has been tried.
 *
 * eSignatures.io (task 18; docs/esignatures.md) is the default provider when its token is set
 * (lib/esign-provider.js): it takes no PDF, so the same filled letter goes to it as a Markdown
 * template (lib/letter-markdown.js), then one contract is made from it. The refusals are shared.
 */

import { engagementEsignHash, engagementHash } from './engagement-hash.js'
import { assembleEngagementPreview, ENGAGEMENT_SENDABLE_STATUSES, placeholderSentence } from './engagement-send.js'
import { esignProvider, esignProviderLabel, esignaturesTestMode, requestProvider } from './esign-provider.js'
import { EsignaturesError, redact as redactEsignatures } from './esignatures.js'
import { contractStatus, esignaturesEventKey } from './esignatures-webhook.js'
import { dateOnlyInZone, firmToday } from './firm-time.js'
import { letterMarkdown } from './letter-markdown.js'
import { buildLetterPdf } from './letter-pdf.js'
import { isOneEmailAddress } from './send-recipients.js'
import { FINISHED_SIGNATURE_STATUSES } from './signature-statuses.js'
import { SignwellError, isTestMode, redact } from './signwell.js'

export const ESIGN_EXPIRES_IN_DAYS = 30
/** eSignatures.io's final email to the signer (after they sign): its subject. */
export const ESIGNATURES_FINAL_SUBJECT = 'Your signed engagement letter'
/** 'text_tags' (the PDF carries the tags) or 'coordinates' (explicit field positions: units undocumented). */
export const ESIGN_FIELD_MODE = 'text_tags'
export const ESIGN_METADATA_APP = 'pbjbillingapp'

/** What the provider's email says (SignWell and eSignatures.io): fixed, because the letter's own email asks for a signed copy by reply. */
export const ESIGN_MESSAGE = 'Please review and sign your engagement letter electronically where indicated.'

// The seeded closing asks for a signed copy by reply; on the e-signature PDF it says to sign where indicated.
// A closing she has rewritten is left exactly as she wrote it. Send's own wording is untouched.
const CLOSING_BY_REPLY = /please sign below and return a copy to us by replying to the email it came with/i
const CLOSING_ELECTRONIC = 'please sign electronically where indicated'
const esignClosing = (text) => String(text ?? '').replace(CLOSING_BY_REPLY, CLOSING_ELECTRONIC)

/** The letter's builder arguments with the closing reworded for an electronic signature. */
function withEsignClosing(args) {
  return {
    ...args,
    bodyText: esignClosing(args.bodyText),
    paragraphs: Array.isArray(args.paragraphs)
      ? args.paragraphs.map((runs) => (Array.isArray(runs) ? runs.map((run) => ({ ...run, text: esignClosing(run.text) })) : runs))
      : args.paragraphs,
  }
}

/** The PDF builder a send for signature uses: the letter, with SignWell's signature and date tags in it. */
export function esignPdfBuilder(args) {
  return buildLetterPdf({ ...withEsignClosing(args), signatureTags: ESIGN_FIELD_MODE === 'text_tags' })
}

/**
 * The builder an eSignatures.io send uses in the PDF's place: the same filled letter, as Markdown
 * (lib/letter-markdown.js) - eSignatures.io takes a Markdown template, never a PDF.
 */
export async function esignMarkdownBuilder(args) {
  return letterMarkdown(withEsignClosing(args))
}

/** Engagement ids with a send for signature in flight in THIS process: a double click makes one document. */
const sendsInFlight = new Set()
const remindersInFlight = new Set()

const refuse = (status, error, message, extra = {}) => ({ refused: { status, error, message, ...extra } })
const clean = (value) => String(value ?? '').trim()
const dayWords = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })

/** Fixed field positions for the coordinate path: the last page, near the foot. Units unverified. */
function coordinateFields(pdf, recipientId) {
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length || 1
  return [
    [
      { type: 'signature', required: true, page: pages, x: 130, y: 600, recipient_id: recipientId, api_id: 'signature' },
      { type: 'date', required: true, page: pages, x: 130, y: 640, recipient_id: recipientId, api_id: 'date' },
    ],
  ]
}

/** The signature-request refusals for a client that signing would refuse anyway (the client already signed by then). */
function clientRefusal(context, engagement, isPureRecord) {
  if (!engagement.clientId) return null
  const client = (context.data?.clients ?? []).find((entry) => entry.id === engagement.clientId)
  if (!client) return 'The client on this letter no longer exists, so it cannot be sent for signature.'
  if (isPureRecord?.(engagement)) return null
  if (client.isBillingMaster === true) {
    return `${client.name || 'That client'} is a billing master - it holds no fee, plans, checklists or software of its own. Use one of its sub clients instead.`
  }
  if ((client.lifecycleStage ?? 'active') === 'inactive') {
    return `${client.name || 'That client'} is retired, so the letter can't bring plans, checklists, software or a retainer to them. Reactivate them first.`
  }
  return null
}

/** What SignWell's failure means to an owner, in plain words (no key, no address, no document). */
function failureSentence(error) {
  if (!(error instanceof SignwellError)) return 'SignWell could not be asked. Nothing was sent.'
  if (error.status === 401) return 'SignWell rejected the API key, so nothing was sent. Check SIGNWELL_API_KEY.'
  if (error.status === 429) return 'SignWell is busy right now. Nothing was sent - try again in a minute.'
  if (error.status === 400 || error.status === 422) {
    return `SignWell refused the document: ${redact(error.signwellMessage ?? 'no reason given')}. Nothing was sent.`
  }
  return 'SignWell could not be reached. Nothing was sent.'
}

/** What eSignatures.io's failure means to an owner, in plain words (no token, no address, no letter). */
function esignaturesFailureSentence(error) {
  if (!(error instanceof EsignaturesError)) return 'eSignatures.io could not be asked. Nothing was sent.'
  if (error.status === 401 || error.status === 403) {
    return 'eSignatures.io rejected the token, so nothing was sent. Check ESIGNATURES_SECRET_TOKEN.'
  }
  if (error.status === 429) return 'eSignatures.io is busy right now. Nothing was sent - try again in a minute.'
  if (error.status >= 400 && error.status < 500) {
    return `eSignatures.io refused the letter: ${redactEsignatures(error.providerMessage ?? 'no reason given')}. Nothing was sent.`
  }
  return 'eSignatures.io could not be reached. Nothing was sent.'
}

/**
 * Send the engagement for signature, or say why not. Every refusal is decided before SignWell is
 * called: signwell_not_configured, engagement_changed (the page's hash is not the stored letter's),
 * engagement_refused (signed, superseded or void), client_refused (a billing master or retired
 * client signing would refuse), signature_active (a request is already out - carries its id, so
 * the page offers Send reminder), unknown_placeholder, missing_placeholder, engagement_empty,
 * team_address, no_recipient / invalid_recipient, pdf_failed. Then ONE SignWell call, the request
 * row, and the engagement's email log - the last two in their own try, so a bookkeeping failure
 * never turns a document that left into a failure. The engagement is held "in flight" from the
 * moment the quick refusals pass until the request row is written (the PDF build and the SignWell call
 * both take seconds), so a double click cannot make a second document in either window.
 *
 * The provider is lib/esign-provider.js's choice: eSignatures.io when its token is set (unless
 * ESIGN_PROVIDER=signwell), else SignWell. The refusals are the same for both; only the call differs
 * (`sendLockedEsignatures`: a Markdown template, then a contract). With neither set up the refusal keeps
 * its old code, signwell_not_configured, for the page.
 *
 * `deps`: { store, signwell: {createDocumentFromFile}, esignatures?: {createTemplate, createContract},
 * env, publicUrl, isPureRecord?, buildPdf? }.
 *
 * @returns {Promise<{refused: {status: number, error: string, message: string}} | {ok: true, request: object, engagement: object|null}>}
 */
export async function sendEngagementForSignature(context, engagement, { templateHash, userId }, deps) {
  const { store } = deps
  const env = deps.env ?? process.env
  const provider = esignProvider(env)
  if (!provider) {
    return refuse(409, 'signwell_not_configured', 'E-signature is not set up yet (no eSignatures.io token or SignWell key on the server). Nothing was sent.')
  }
  if (templateHash !== engagementHash(engagement)) {
    return refuse(409, 'engagement_changed', 'The engagement changed since this page loaded. Nothing was sent. Reload and send again.')
  }
  if (!ENGAGEMENT_SENDABLE_STATUSES.includes(engagement.status)) {
    return refuse(409, 'engagement_refused', `This engagement is ${engagement.status}, so it cannot be sent for signature.`)
  }
  const clientProblem = clientRefusal(context, engagement, deps.isPureRecord)
  if (clientProblem) return refuse(409, 'client_refused', clientProblem)
  // Held BEFORE the first await below (the check and the add are one synchronous step), until the request
  // row is written: the "is one already out?" question is asked inside the hold, so two clicks cannot both
  // pass it.
  if (sendsInFlight.has(engagement.id)) {
    return refuse(
      409,
      'signature_active',
      'A send of this letter for signature is already under way - wait a minute, then check the page. Nothing more was sent.',
    )
  }
  sendsInFlight.add(engagement.id)
  try {
    const active = await store.activeSignatureRequestForEngagement(engagement.id)
    if (active) {
      return refuse(
        409,
        'signature_active',
        `This letter is already out for signature${active.sentAt ? ` (sent ${dayWords(active.sentAt)})` : ''}. Send a reminder instead.`,
        { requestId: active.id },
      )
    }
    return provider === 'esignatures'
      ? await sendLockedEsignatures(context, engagement, { userId }, deps)
      : await sendLocked(context, engagement, { userId }, deps)
  } finally {
    sendsInFlight.delete(engagement.id)
  }
}

/**
 * The letter as the signer will see it (Send's own builder, with `buildPdf` in the PDF's place) and
 * every refusal that does not depend on the provider, in Send's order. Returns `{ refused }` or
 * `{ preview, email }`.
 */
async function prepareSend(context, engagement, buildPdf) {
  const preview = await assembleEngagementPreview({ ...context, buildPdf }, engagement, {})
  if (preview.unknown.length > 0 || preview.retired.length > 0) {
    return refuse(409, 'unknown_placeholder', placeholderSentence(preview.unknown, preview.retired), {
      unknown: preview.unknown,
      retired: preview.retired,
    })
  }
  if (preview.missing.length > 0) return refuse(409, 'missing_placeholder', preview.missingNote, { missing: preview.missing })
  if (![engagement.subject, engagement.emailBody, engagement.letterBody].every((text) => clean(text))) {
    return refuse(409, 'engagement_empty', 'Write the subject, the email and the letter before sending.')
  }
  // Never to a team mailbox: the party's address must not be an app user's.
  if (preview.teamOnly) return refuse(409, 'team_address', preview.recipientNote)
  if (preview.to.length === 0) return refuse(409, 'no_recipient', preview.recipientNote)
  const email = clean(engagement.party?.email)
  if (preview.to.length !== 1 || !isOneEmailAddress(email) || preview.to[0].toLowerCase() !== email.toLowerCase()) {
    return refuse(409, 'invalid_recipient', 'The party needs one plain email address to sign with (one address, no name or list). Fix it on the engagement, then send again.')
  }
  if (!preview.docs.pdf) {
    console.error('[esign] could not build the letter for', engagement.id, preview.docs.pdfError?.message)
    return refuse(502, 'pdf_failed', 'The PDF could not be built, so nothing was sent.')
  }
  return { preview, email }
}

/** Record a request that left and log it on the engagement - the bookkeeping both providers share. */
async function recordSent(engagement, { request: row, email, subject, testMode, sentAt, recordFailed }, store) {
  let request
  try {
    request = await store.createSignatureRequest(row)
  } catch (error) {
    console.error('[esign] eSignatures.io has contract', row.providerDocumentId, 'but it could not be recorded:', redactEsignatures(error?.message))
    return recordFailed
  }
  let logged = null
  try {
    logged = await store.markEngagementEsigned(engagement.id, {
      to: [email],
      signatureRequestId: request.id,
      testMode,
      subject,
      // What went out, so signing can tell the letter changed after it was sent.
      hash: engagementHash(engagement),
      at: sentAt,
    })
  } catch (error) {
    console.error('[esign] could not log the send for', engagement.id, error)
  }
  return { ok: true, request, engagement: logged ?? engagement }
}

/**
 * The rest of an eSignatures.io send, with the engagement held in flight by the caller: the FILLED letter
 * as a Markdown template (no placeholders left for eSignatures to fill), then ONE contract from it for
 * the party. eSignatures.io emails the signer (a fixed subject naming the firm and ESIGN_MESSAGE), reminds
 * them on its own schedule, and the contract expires with the app's 30 days.
 */
async function sendLockedEsignatures(context, engagement, { userId }, deps) {
  const { store, esignatures } = deps
  const env = deps.env ?? process.env
  const prepared = await prepareSend(context, engagement, esignMarkdownBuilder)
  if (prepared.refused) return prepared
  const { preview, email } = prepared

  const partyName = clean(engagement.party?.company) || clean(engagement.party?.contactName) || 'Client'
  const signerName = clean(engagement.party?.contactName) || partyName
  const firmName = clean(context.firmSettings?.name) || 'PB&J Strategic Accounting'
  const dateLabel = clean(preview.values?.today) || dayWords(new Date().toISOString())
  const title = `${partyName} - Engagement letter ${dateLabel}`.slice(0, 200)
  const testMode = esignaturesTestMode(env)
  const esignHash = engagementEsignHash(engagement)
  const replyTo = clean(context.replyTo)
  let templateId
  let contract
  try {
    templateId = await esignatures.createTemplate({ title, markdown: String(preview.docs.pdf) }, { env })
    contract = await esignatures.createContract(
      {
        templateId,
        title,
        signers: [{ name: signerName, email }],
        testMode,
        expiresInHours: ESIGN_EXPIRES_IN_DAYS * 24,
        // A string (their API): it comes back on every event, which is how the webhook knows the contract is ours.
        metadata: JSON.stringify({
          engagement_id: engagement.id,
          ...(engagement.clientId ? { client_id: engagement.clientId } : {}),
          app: ESIGN_METADATA_APP,
          esign_hash: esignHash,
        }),
        // Fixed wording, as for SignWell: the letter's own email asks for a signed copy by reply, which is wrong here.
        emails: {
          signatureRequestSubject: `Please sign your engagement letter - ${firmName}`,
          signatureRequestText: ESIGN_MESSAGE,
          finalContractSubject: ESIGNATURES_FINAL_SUBJECT,
          finalContractText: `Thank you for signing your engagement letter with ${firmName}.`,
          ...(isOneEmailAddress(replyTo) ? { replyTo } : {}),
        },
        companyName: firmName,
      },
      { env },
    )
  } catch (error) {
    console.error('[esign] eSignatures.io refused the letter for', engagement.id, error?.status, redactEsignatures(error?.message))
    return refuse(502, 'esign_failed', esignaturesFailureSentence(error))
  }

  const signerId = clean(Array.isArray(contract.signers) ? contract.signers[0]?.id : '') || null
  const sentAt = new Date().toISOString()
  return recordSent(
    engagement,
    {
      email,
      subject: preview.docs.email.subject,
      testMode,
      sentAt,
      request: {
        engagementId: engagement.id,
        clientId: engagement.clientId ?? null,
        provider: 'esignatures',
        providerDocumentId: contract.id,
        providerTemplateId: templateId,
        providerSignerId: signerId,
        status: 'sent',
        recipients: [{ id: signerId ?? '1', name: signerName, email }],
        testMode,
        // The letter AND its signing details as they went out: when the client signs, only this is signed for them.
        esignHash,
        sentAt,
        createdBy: userId ?? null,
      },
      recordFailed: refuse(
        500,
        'esign_record_failed',
        `eSignatures.io has the contract (${contract.id}) but the app could not record it. Withdraw it in eSignatures.io before sending again.`,
      ),
    },
    store,
  )
}

/** The rest of a send, with the engagement held in flight by the caller. */
async function sendLocked(context, engagement, { userId }, deps) {
  const { store, signwell } = deps
  const env = deps.env ?? process.env
  // The letter as the signer will see it: Send's own builder, with the signature tags in the PDF.
  const prepared = await prepareSend(context, engagement, deps.buildPdf ?? esignPdfBuilder)
  if (prepared.refused) return prepared
  const { preview, email } = prepared

  const partyName = clean(engagement.party?.company) || clean(engagement.party?.contactName) || 'Client'
  const signer = { id: '1', name: clean(engagement.party?.contactName) || partyName, email }
  const testMode = isTestMode(env)
  let created
  try {
    created = await signwell.createDocumentFromFile(
      {
        fileBase64: preview.docs.pdf.toString('base64'),
        fileName: preview.docs.pdfFilename,
        name: `${partyName} - Engagement letter`,
        subject: preview.docs.email.subject,
        message: ESIGN_MESSAGE,
        recipients: [signer],
        ...(ESIGN_FIELD_MODE === 'text_tags'
          ? { textTags: true }
          : { fields: coordinateFields(preview.docs.pdf, signer.id) }),
        metadata: {
          engagement_id: engagement.id,
          ...(engagement.clientId ? { client_id: engagement.clientId } : {}),
          app: ESIGN_METADATA_APP,
        },
        expiresIn: ESIGN_EXPIRES_IN_DAYS,
        redirectUrl: `${clean(deps.publicUrl).replace(/\/$/, '')}/signed-thank-you`,
        testMode,
      },
      { env },
    )
  } catch (error) {
    console.error('[esign] SignWell refused the document for', engagement.id, error?.status, redact(error?.message))
    return refuse(502, 'esign_failed', failureSentence(error))
  }

  const sentAt = new Date().toISOString()
  let request
  try {
    request = await store.createSignatureRequest({
      engagementId: engagement.id,
      clientId: engagement.clientId ?? null,
      signwellDocumentId: created.id,
      status: 'sent',
      recipients: [signer],
      testMode,
      // The letter AND its signing details as they went to SignWell: when the client signs, only this is signed for them.
      esignHash: engagementEsignHash(engagement),
      sentAt,
      createdBy: userId ?? null,
    })
  } catch (error) {
    console.error('[esign] SignWell has document', created?.id, 'but it could not be recorded:', redact(error?.message))
    return refuse(
      500,
      'esign_record_failed',
      `SignWell has the document (${created?.id}) but the app could not record it. Cancel it in SignWell before sending again.`,
    )
  }
  let logged = null
  try {
    logged = await store.markEngagementEsigned(engagement.id, {
      to: [email],
      signatureRequestId: request.id,
      testMode,
      subject: preview.docs.email.subject,
      // What went out, so signing can tell the letter changed after it was sent.
      hash: engagementHash(engagement),
      at: sentAt,
    })
  } catch (error) {
    console.error('[esign] could not log the send for', engagement.id, error)
  }
  return { ok: true, request, engagement: logged ?? engagement }
}

/**
 * Remind the signer about an active request: once per firm day, and only while one is out.
 * Refusals (all 409): no_active_signature, reminded_today, esign_cannot_remind (SignWell's 422 - the
 * document's status cannot be reminded). Other SignWell failures are 502.
 *
 * An eSignatures.io request (the provider it was SENT with, not today's setting) is reminded by sending
 * the request to its stored signer again (`resendToSigner`); its 4xx is esign_cannot_remind, and a
 * request with no signer id recorded cannot be reminded.
 *
 * `deps`: { store, signwell: {sendReminder}, esignatures?: {resendToSigner}, engagement?: the stored letter (a
 * void, superseded or signed one refuses 409 engagement_closed), env, now?: Date }.
 */
export async function remindEngagementSignature(engagementId, deps) {
  const { store, signwell } = deps
  const env = deps.env ?? process.env
  const now = deps.now ?? new Date()
  // A letter that no longer stands (void, superseded, signed) is never reminded, whatever request is still open.
  if (deps.engagement && !ENGAGEMENT_SENDABLE_STATUSES.includes(deps.engagement.status)) {
    return refuse(409, 'engagement_closed', `This letter is ${deps.engagement.status}, so no reminder was sent.`)
  }
  const active = await store.activeSignatureRequestForEngagement(engagementId)
  if (!active) return refuse(409, 'no_active_signature', 'This letter is not out for signature, so there is nobody to remind.')
  const provider = requestProvider(active)
  const label = esignProviderLabel(provider)
  const today = deps.today ?? (() => firmToday(now))
  if (active.lastRemindedAt && dateOnlyInZone(new Date(active.lastRemindedAt)) === today()) {
    return refuse(409, 'reminded_today', `A reminder already went out today. ${label} also reminds the signer on its own schedule.`, { requestId: active.id })
  }
  if (remindersInFlight.has(active.id)) {
    return refuse(409, 'reminded_today', 'A reminder is already going out. Nothing more was sent.', { requestId: active.id })
  }
  if (provider === 'esignatures') return remindEsignatures(active, { ...deps, env, now })
  remindersInFlight.add(active.id)
  try {
    try {
      await signwell.sendReminder(active.signwellDocumentId, { env })
    } catch (error) {
      console.error('[esign] reminder failed for', active.id, error?.status, redact(error?.message))
      if (error instanceof SignwellError && error.status === 422) {
        return refuse(409, 'esign_cannot_remind', "SignWell can't remind the signer about this document right now (it may already be finished).", { requestId: active.id })
      }
      return refuse(502, 'esign_failed', failureSentence(error).replace('Nothing was sent.', 'No reminder was sent.'))
    }
    const request = await store.updateSignatureRequest(active.id, { lastRemindedAt: now.toISOString() })
    return { ok: true, request: request ?? active }
  } finally {
    remindersInFlight.delete(active.id)
  }
}

/** Remind an eSignatures.io request: send it to its stored signer again (once per firm day, checked by the caller). */
async function remindEsignatures(active, { store, esignatures, env, now }) {
  const contractId = active.providerDocumentId ?? active.signwellDocumentId
  if (!active.providerSignerId || !contractId) {
    return refuse(409, 'esign_cannot_remind', "The app has no signer recorded for this eSignatures.io contract, so it can't send a reminder. eSignatures.io still reminds the signer on its own.", { requestId: active.id })
  }
  remindersInFlight.add(active.id)
  try {
    try {
      await esignatures.resendToSigner(contractId, active.providerSignerId, { env })
    } catch (error) {
      console.error('[esign] reminder failed for', active.id, error?.status, redactEsignatures(error?.message))
      if (error instanceof EsignaturesError && error.status >= 400 && error.status < 500 && ![401, 403, 429].includes(error.status)) {
        return refuse(409, 'esign_cannot_remind', "eSignatures.io can't send this contract again right now (it may already be signed or withdrawn).", { requestId: active.id })
      }
      return refuse(502, 'esign_failed', esignaturesFailureSentence(error).replace('Nothing was sent.', 'No reminder was sent.'))
    }
    const request = await store.updateSignatureRequest(active.id, { lastRemindedAt: now.toISOString() })
    return { ok: true, request: request ?? active }
  } finally {
    remindersInFlight.delete(active.id)
  }
}

/**
 * Each provider call of a withdrawal (the withdraw, then the re-read) waits at most this long per attempt. The
 * eSignatures.io client retries a 429 once after a wait of up to 10 s, so one request can take about 52 s.
 */
export const ESIGN_WITHDRAW_TIMEOUT_MS = 8000
/** Why a request is withdrawn, as the note on the letter says it. */
export const ESIGN_WITHDRAW_REASONS = Object.freeze({
  void: 'the letter was voided',
  signed: 'the letter is marked signed',
  superseded: 'the letter was superseded',
})
/** The withdrawal reason for a letter that no longer stands, from its status; null while it can still be signed. */
export function withdrawReasonFor(engagement) {
  return { void: 'void', superseded: 'superseded', signed: 'signed' }[engagement?.status] ?? null
}

/**
 * Withdraw ONE request that is still open (not completed, declined, expired, canceled or withdrawn) because
 * its letter was voided, marked signed by hand or superseded - so the client cannot sign a letter that no
 * longer stands, and the app does not later refuse to mark it signed. BEST-EFFORT and never throws.
 *
 * A signature the client already gave is never thrown away:
 *  - eSignatures.io (the provider the request WENT with): `withdrawContract`, then the contract is RE-READ
 *    whatever the withdraw answered (a 2xx could be a no-op on a signed contract). Only a contract that reads
 *    withdrawn, or still out (sent), ends the request `withdrawn`; then the `es:<contract>:contract-withdrawn`
 *    ledger row is written, so the provider's own withdrawn event that follows is answered duplicate. One that
 *    reads signed - or cannot be read - is LEFT OPEN with a note ("press Check eSignatures.io"), so the
 *    webhook or Check / Finish completes it (a letter signed by hand keeps the PDF; a voided one is not
 *    signed, its PDF is kept and the owners are told);
 *  - SignWell: the module has no cancel call, so the request is withdrawn in the app only (the note says so)
 *    - except when the letter was marked signed: then the request is left as it is, so a signature the
 *    client gave at SignWell can still be finished.
 * A request that finished meanwhile (a completion landed first) is left exactly as it is.
 *
 * @param {object} request  the request as the store gives it
 * @param {object} deps  { store, esignatures: {withdrawContract, getContract}, env?, reason?: keyof ESIGN_WITHDRAW_REASONS, log? }
 * @returns {Promise<{request: object|null, withdrawn: boolean, providerError: string|null, signedAtProvider?: boolean} | null>}
 *   null: nothing to do
 */
export async function withdrawSignatureRequest(request, deps) {
  const { store, esignatures } = deps
  const log = deps.log ?? console
  if (!request?.id || FINISHED_SIGNATURE_STATUSES.includes(request.status)) return null
  const provider = requestProvider(request)
  const label = esignProviderLabel(provider)
  const reason = Object.hasOwn(ESIGN_WITHDRAW_REASONS, deps.reason) ? deps.reason : 'void'
  const why = ESIGN_WITHDRAW_REASONS[reason]
  // SignWell cannot be asked to cancel: a letter marked signed keeps its request, which may still finish.
  if (provider === 'signwell' && reason === 'signed') return null
  const env = deps.env ?? process.env
  const contractId = provider === 'esignatures' ? (request.providerDocumentId ?? request.signwellDocumentId) : null
  let providerError = null
  try {
    if (contractId) {
      try {
        await esignatures.withdrawContract(contractId, { env, timeoutMs: ESIGN_WITHDRAW_TIMEOUT_MS })
      } catch (error) {
        providerError = clean(redactEsignatures(error?.message)).slice(0, 200) || 'no answer'
      }
      // Whatever it answered: is it signed? Only a contract that reads withdrawn or still out lets it end here.
      let reads = null
      try {
        reads = contractStatus(await esignatures.getContract(contractId, { env, timeoutMs: ESIGN_WITHDRAW_TIMEOUT_MS }))
      } catch (error) {
        log.warn('[esign] could not re-read', request.id, 'after its withdrawal:', redactEsignatures(error?.message))
      }
      if (reads === 'declined') {
        providerError = null // it reads withdrawn: nothing is left to do at eSignatures.io
      } else if (reads !== 'sent') {
        // Signed (or unreadable): left OPEN, so the webhook or Check / Finish can still complete it - unless it
        // finished meanwhile, which keeps its own status and note.
        const now = await store.getSignatureRequest(request.id)
        if (!now || FINISHED_SIGNATURE_STATUSES.includes(now.status)) {
          return { request: now ?? request, withdrawn: false, providerError, signedAtProvider: reads === 'completed' }
        }
        const note = providerError
          ? `${label} did not withdraw it when ${why} (${providerError}) - press Check ${label}`
          : `${label} could not confirm the withdrawal when ${why} - press Check ${label}`
        const kept = (await store.updateSignatureRequest(request.id, { lastError: note })) ?? now
        log.warn(`[esign] left ${request.id} open: the contract reads ${reads ?? 'unreadable'} after the withdrawal`)
        return { request: kept, withdrawn: false, providerError, signedAtProvider: reads === 'completed' }
      }
    }
    const moved = await store.updateSignatureRequest(request.id, { status: 'withdrawn' })
    if (moved?.status !== 'withdrawn') {
      log.info(`[esign] ${request.id} was not withdrawn: it is ${moved?.status ?? 'gone'}`)
      return { request: moved, withdrawn: false, providerError }
    }
    if (contractId) {
      try {
        await store.recordSignwellEventOnce(esignaturesEventKey({ contractId, status: 'contract-withdrawn' }), 'esignatures:withdrawn-by-app')
      } catch (error) {
        log.warn('[esign] could not ledger the withdrawal of', request.id, redactEsignatures(error?.message))
      }
    }
    const lastError =
      provider === 'signwell'
        ? `Withdrawn here because ${why}; the app cannot cancel it at SignWell - cancel it there if the client could still sign`
        : providerError
          ? `Withdrawn here because ${why}, but ${label} did not withdraw it (${providerError}) - withdraw it in ${label}`
          : null
    const updated = (await store.updateSignatureRequest(request.id, { lastError })) ?? moved
    log.info(`[esign] withdrew ${request.id} (${reason})${providerError ? ` - ${label} refused: ${providerError}` : ''}`)
    return { request: updated, withdrawn: true, providerError }
  } catch (error) {
    log.error('[esign] could not withdraw', request.id, redactEsignatures(error?.message))
    return { request, withdrawn: false, providerError }
  }
}

/**
 * Withdraw every open request of the given letters (`[engagementId, reason]` pairs), never throwing: the void,
 * Mark as signed and the superseding flip call it AFTER they answered. The requests are read one letter at a
 * time, then withdrawn side by side (each provider call capped per attempt; see ESIGN_WITHDRAW_TIMEOUT_MS).
 * @returns {Promise<object[]>} what `withdrawSignatureRequest` answered for each request it acted on
 */
export async function withdrawOpenSignatureRequests(targets, deps) {
  const log = deps.log ?? console
  const work = []
  const seen = new Set()
  for (const [engagementId, reason] of Array.isArray(targets) ? targets : []) {
    if (!engagementId || seen.has(engagementId)) continue
    seen.add(engagementId)
    try {
      for (const row of await deps.store.listSignatureRequestsForEngagement(engagementId)) {
        if (!FINISHED_SIGNATURE_STATUSES.includes(row.status)) work.push([row, reason])
      }
    } catch (error) {
      log.error('[esign] could not read the requests to withdraw for', engagementId, redactEsignatures(error?.message))
    }
  }
  const settled = await Promise.allSettled(work.map(([row, reason]) => withdrawSignatureRequest(row, { ...deps, reason })))
  return settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : null)).filter(Boolean)
}
