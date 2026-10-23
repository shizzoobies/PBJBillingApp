/**
 * Previewing and sending ONE engagement letter (docs/plans/engagements-2026-10.md,
 * stage 2B), as plain functions so every rule below is tested by running it, not
 * by reading server.js: the server loads the context (the workspace, the firm, who
 * is sending, which addresses belong to team members) and hands over the store and
 * the mail sender it wants used. Mirrors lib/letter-send.js.
 *
 * The Letters rule binds here too (Alex, 2026-10-08): the letter goes to the party
 * and nowhere else - no owner notification, no copy of the document, replies to the
 * invoice mailbox (Brittany's). Nothing in this file notifies anyone; the only mail
 * call is `deps.sendMail` (and its one 429 retry), addressed to `preview.to`.
 */

import { buildEngagementDocuments } from './engagement-documents.js'
import { engagementValues } from './engagement-values.js'
import { engagementHash } from './engagement-hash.js'
import { esignTagProblem, fillTemplate, placeholdersFor, retiredSentence } from './letter-template.js'
import { addressesIn, withoutTeamAddresses } from './recipient-addresses.js'
import { invoiceEmailAddressee, resolveInvoiceRecipients, resolveSendRecipients } from './invoice-recipients.js'
import { ENGAGEMENT_SENDING_MS } from './engagement-sending.js'

export { ENGAGEMENT_SENDING_MS }

export const ENGAGEMENT_RATE_LIMIT_WAIT_MS = 1500
/** A second Send this soon after one that left is a double click, not a re-send. */
export const ENGAGEMENT_JUST_SENT_MS = 15000
/** The statuses a letter can still be sent in (a sent one can be sent again after an edit). */
export const ENGAGEMENT_SENDABLE_STATUSES = Object.freeze(['draft', 'sent'])

const tokens = (keys) => keys.map((key) => `{{${key}}}`)
const listOf = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '')

/** Who the letter is to, for a sentence: the company, the contact, or "this party". */
function partyName(engagement) {
  const party = engagement?.party ?? {}
  return String(party.company || party.contactName || '').trim() || 'this party'
}

/**
 * What the engagement letter's recipient picker lists and ticks (featreq-34627da1),
 * WITHOUT building the letter: the addresses on file (engagementRecipientDetails,
 * team addresses dropped) and the party's own, ticked. The preview and the send
 * build the same list.
 *
 * @returns {{details: Array<{email: string, source: string}>, defaultTo: string[]}}
 */
export function engagementRecipientList(context, engagement) {
  const clients = context.data?.clients ?? []
  const client = engagement?.clientId ? (clients.find((entry) => entry.id === engagement.clientId) ?? null) : null
  const { details } = engagementRecipientDetails(context, engagement, client)
  const partyKey = String(engagement?.party?.email ?? '').trim().toLowerCase()
  return {
    details,
    defaultTo: details.filter((detail) => detail.email.toLowerCase() === partyKey).map((detail) => detail.email),
  }
}

/**
 * The unknown and the retired placeholders in an engagement's three boxes, against
 * the ENGAGEMENT placeholder list (every Letters key plus the engagement-only ones).
 * Warns on the editor; Send refuses either.
 *
 * @returns {{unknown: string[], retired: string[]}}
 */
export function engagementWarnings(engagement) {
  const placeholders = placeholdersFor('engagement')
  const unknown = []
  const retired = []
  // E-sign field tags only in the letter body; in the subject or the email they are unknown.
  const boxes = [
    [engagement?.subject, false],
    [engagement?.emailBody, false],
    [engagement?.letterBody, true],
  ]
  for (const [text, tagsAllowed] of boxes) {
    const found = fillTemplate(text, {}, placeholders, { esignTags: tagsAllowed })
    for (const key of found.unknown) if (!unknown.includes(key)) unknown.push(key)
    for (const key of found.retired) if (!retired.includes(key)) retired.push(key)
  }
  return { unknown, retired }
}

/**
 * The snapshot key Send compares: the three boxes AND the retainer and the party (the
 * party is the recipient), see lib/engagement-hash.js.
 */
export { engagementHash }

/**
 * True when the newest log entry is a claim (`sending`) under ENGAGEMENT_SENDING_MS old with no send logged
 * after it: a Send of this letter is still running, as opposed to one that left a moment ago.
 */
export function sendUnderWay(engagement, now = new Date()) {
  const log = Array.isArray(engagement?.emailLog) ? engagement.emailLog : []
  const last = [...log].reverse().find((entry) => entry?.kind === 'send' || entry?.kind === 'sending')
  if (last?.kind !== 'sending') return false
  const elapsed = new Date(now).getTime() - Date.parse(last.at)
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < ENGAGEMENT_SENDING_MS
}

/**
 * True when the newest send in the log left less than ENGAGEMENT_JUST_SENT_MS before `now`, or
 * when a Send claimed the letter (a `sending` entry the claim appends) less than ENGAGEMENT_SENDING_MS ago
 * and no send was logged after it. The second case is a Send still running; it ages out, so a
 * crash between the claim and the log never blocks the letter for good.
 */
export function sentJustNow(engagement, now = new Date()) {
  const log = Array.isArray(engagement?.emailLog) ? engagement.emailLog : []
  const last = [...log].reverse().find((entry) => entry?.kind === 'send' || entry?.kind === 'sending')
  if (!last) return false
  const at = Date.parse(last.at)
  const elapsed = new Date(now).getTime() - at
  if (last.kind === 'sending') return Number.isFinite(at) && elapsed >= 0 && elapsed < ENGAGEMENT_SENDING_MS
  if (last.ok !== true) return false
  return Number.isFinite(at) && elapsed >= 0 && elapsed < ENGAGEMENT_JUST_SENT_MS
}

/** The sentence for required placeholders with no value in this letter. */
export function engagementMissingSentence(name, missing) {
  const names = tokens(missing)
  if (names.length === 0) return null
  return names.length > 1
    ? `${listOf(names)} have no value for ${name} - fill them in on the engagement, or take the placeholders out of the letter.`
    : `${names[0]} has no value for ${name} - fill it in on the engagement, or take the placeholder out of the letter.`
}

/**
 * The refusal sentence for unknown and retired placeholders. An unknown key that reads as a
 * SignWell field tag (`{{initial:2:y}}` - a second signer; one in the subject or the email) gets
 * its own sentence saying why, each sentence once.
 */
export function placeholderSentence(unknown, retired) {
  const sentences = []
  const tagProblems = [...new Set(unknown.map(esignTagProblem).filter(Boolean))]
  const plain = unknown.filter((key) => !esignTagProblem(key))
  if (plain.length > 0) {
    const names = tokens(plain)
    sentences.push(
      names.length > 1
        ? `${names.join(', ')} are not placeholders the app fills in`
        : `${names[0]} is not a placeholder the app fills in`,
    )
  }
  sentences.push(...tagProblems)
  if (retired.length > 0) sentences.push(retiredSentence(retired))
  return `${sentences.join('. ')}. Nothing was sent.`
}

const union = (a, b) => [...a, ...b.filter((key) => !a.includes(key))]

/**
 * The addresses on file for an engagement letter, each named - what the recipient
 * picker lists (featreq-34627da1): the party's own address first, then, when the
 * letter is linked to a client, that client's addresses by the invoice addressee
 * rule (its contacts and the client record; a billing master's receiving company).
 * Duplicates collapse case-insensitively, first mention wins. `details` has every
 * team member's address dropped (the reply-to mailbox excepted), as in Letters;
 * `raw` is the list before that, each entry flagged `party` when it is the party's.
 *
 * @returns {{details: Array<{email: string, source: string}>, raw: Array<{email: string, source: string, party?: boolean}>}}
 */
export function engagementRecipientDetails(context, engagement, client) {
  const raw = []
  const seen = new Set()
  const add = (email, source, party = false) => {
    const value = String(email ?? '').trim()
    if (!value || seen.has(value.toLowerCase())) return
    seen.add(value.toLowerCase())
    raw.push(party ? { email: value, source, party: true } : { email: value, source })
  }
  const party = engagement?.party ?? {}
  add(party.email, String(party.contactName || party.company || '').trim() || 'Engagement party', true)
  if (client) {
    const addressee = invoiceEmailAddressee(client, context.data?.clients ?? [])
    if (!addressee.refusal) {
      const resolved = resolveInvoiceRecipients({ client: addressee.addressee, contacts: context.data?.contacts ?? [] })
      for (const detail of resolved.details) add(detail.email, detail.source)
    }
  }
  const details = withoutTeamAddresses(raw, context.teamEmails, context.replyTo).map(({ email, source }) => ({
    email,
    source,
  }))
  return { details, raw }
}

/**
 * Exactly what the party would receive if the letter were sent now: the STORED
 * engagement filled by the same builder as Send, who it would go to, and what
 * would stop it. Read-only: it sends, records and notifies nothing, so what she
 * previews is what Send builds by construction.
 *
 * `context`: { data, firmSettings, senderName, now, teamEmails?, replyTo?, buildPdf? }.
 * `teamEmails` (lower-case) are the addresses of app user accounts; none of them is
 * ever a recipient, except the reply-to mailbox itself.
 * `options.to` / `options.extra`: the recipient picker's choice (featreq-34627da1) - the
 * on-file addresses ticked (an array; one string is read as a list of one) and the ones
 * added for this send only. Both absent: the party's own address, as before.
 *
 * @returns {Promise<{docs: object, values: object, to: string[], details: object[], teamOnly: boolean, recipientNote: string|null, missing: string[], missingNote: string|null, unknown: string[], retired: string[], refusal: string|null}>}
 */
export async function assembleEngagementPreview(context, engagement, options = {}) {
  const { data, firmSettings, senderName, now } = context
  const clients = data?.clients ?? []
  const client = engagement.clientId ? (clients.find((entry) => entry.id === engagement.clientId) ?? null) : null
  const values = engagementValues({
    engagement,
    snapshot: engagement.figures ?? null,
    party: engagement.party,
    client,
    contacts: data?.contacts ?? [],
    firmSettings,
    now,
    senderName,
  })
  const docs = await buildEngagementDocuments({
    engagement,
    values,
    firmSettings,
    ...(context.buildPdf ? { buildPdf: context.buildPdf } : {}),
  })

  // The recipients (featreq-34627da1). On file: the party's address, then the linked
  // client's contacts and record (team addresses dropped - see engagementRecipientDetails).
  // With nothing posted the letter goes to the party, as it always has. A posted
  // `to` / `extra` (the recipient picker) is decided by the invoice Send's own
  // resolveSendRecipients: `to` filters the on-file list, `extra` adds at most three
  // valid one-time addresses, and at least one address on file must be among them
  // (unless nothing is on file at all). A one-time address that is a team member's is
  // refused: the tax-document rule binds what she types too.
  const name = partyName(engagement)
  const { details, raw } = engagementRecipientDetails(context, engagement, client)
  const partyKey = String(engagement.party?.email ?? '').trim().toLowerCase()
  const defaultTo = details.filter((detail) => detail.email.toLowerCase() === partyKey).map((detail) => detail.email)
  const postedTo =
    options.to === undefined || options.to === null || options.to === ''
      ? undefined
      : typeof options.to === 'string'
        ? [options.to.trim()]
        : options.to
  const chosen =
    postedTo === undefined && options.extra === undefined
      ? null
      : resolveSendRecipients({
          allowed: details.map((detail) => detail.email),
          to: postedTo ?? defaultTo,
          extra: options.extra,
          // An address she ticked that is no longer on file refuses (409 recipients_changed).
          strict: true,
        })
  let to = chosen ? [] : defaultTo
  let recipientRefusal = null
  let recipientNote = null
  if (chosen && !chosen.ok) {
    recipientRefusal = { status: chosen.status, error: chosen.error }
    recipientNote = chosen.message
  } else if (chosen) {
    const typed = chosen.oneTime.map((email) => ({ email }))
    const team = typed.filter((entry) => !withoutTeamAddresses([entry], context.teamEmails, context.replyTo).length)
    if (team.length > 0) {
      recipientRefusal = { status: 409, error: 'team_address' }
      recipientNote = `${team[0].email} belongs to a team member. An engagement letter goes to the client only.`
    } else {
      to = chosen.to
    }
  }
  // The party's own address (with nothing chosen) being a team member's says so.
  const teamOnly =
    !chosen && to.length === 0 && raw.some((detail) => detail.party && addressesIn(detail.email).length > 0)
  if (!recipientNote) {
    recipientNote = teamOnly
      ? `${String(engagement.party?.email ?? '').trim()} belongs to a team member. An engagement letter goes to the client only.`
      : to.length === 0
        ? `There is no email address for ${name}. Add one to the party, or choose who it goes to at Send.`
        : null
  }

  const warnings = engagementWarnings(engagement)
  const unknown = union(warnings.unknown, docs.fill?.unknown ?? [])
  const retired = union(warnings.retired, docs.fill?.retired ?? [])
  const missing = docs.fill?.missing ?? []
  const missingNote = engagementMissingSentence(name, missing)
  const status = ENGAGEMENT_SENDABLE_STATUSES.includes(engagement.status)
    ? null
    : `This engagement is ${engagement.status}, so it cannot be sent.`
  const empty = [engagement.subject, engagement.emailBody, engagement.letterBody].every((text) =>
    String(text ?? '').trim(),
  )
    ? null
    : 'Write the subject, the email and the letter before sending.'

  return {
    docs,
    values,
    to,
    details,
    defaultTo,
    recipientRefusal,
    teamOnly,
    recipientNote,
    missing,
    missingNote,
    unknown,
    retired,
    // The first thing that would stop Send now (the page-hash check aside), in Send's order.
    refusal:
      (unknown.length > 0 || retired.length > 0 ? placeholderSentence(unknown, retired) : null) ??
      missingNote ??
      empty ??
      status ??
      recipientNote ??
      (docs.pdf ? null : 'The PDF could not be built, so Send would not send it.'),
  }
}

/** A refusal Send answers before anything is sent: the HTTP status, the code and the sentence. */
const refuse = (status, error, message, extra = {}) => ({ refused: { status, error, message, ...extra } })

/**
 * Send the engagement to its party, or say why not. Every refusal is decided
 * before the provider is called, in this order: engagement_changed (the page's hash
 * is not the stored letter's), unknown_placeholder, missing_placeholder,
 * engagement_empty, engagement_refused (signed, superseded or void; or reason 'sending'
 * when a Send of the letter is still running; or reason 'just_sent' when a send left under
 * 15 seconds ago - a double click), team_address,
 * no_recipient, pdf_failed, engagement_send_failed (email not configured), and last the
 * 'sending' claim again (two Sends started together: only one takes the mark). Then ONE
 * provider call (a 429 waits and retries once), then the send is logged on the
 * engagement - in its own try/catch, so bookkeeping can never turn a letter that left
 * into a failure.
 *
 * `deps`: { store, sendMail, pause, configured } - the store's `markEngagementSent`,
 * the mail sender, a delay, and whether email is configured at all.
 *
 * @returns {Promise<{refused: {status: number, error: string, message: string}} | {ok: boolean, error: string|null, to: string[], engagement: object}>}
 */
export async function sendEngagement(context, engagement, { to, extra, templateHash, userId }, deps) {
  void userId // who sent it is the route's activity entry
  if (templateHash !== engagementHash(engagement)) {
    return refuse(
      409,
      'engagement_changed',
      'The engagement changed since this page loaded. Nothing was sent. Reload and send again.',
    )
  }
  const preview = await assembleEngagementPreview(context, engagement, { to, extra })
  if (preview.unknown.length > 0 || preview.retired.length > 0) {
    return refuse(409, 'unknown_placeholder', placeholderSentence(preview.unknown, preview.retired), {
      unknown: preview.unknown,
      retired: preview.retired,
    })
  }
  if (preview.missing.length > 0) {
    return refuse(409, 'missing_placeholder', preview.missingNote, { missing: preview.missing })
  }
  if (![engagement.subject, engagement.emailBody, engagement.letterBody].every((text) => String(text ?? '').trim())) {
    return refuse(409, 'engagement_empty', 'Write the subject, the email and the letter before sending.')
  }
  if (!ENGAGEMENT_SENDABLE_STATUSES.includes(engagement.status)) {
    return refuse(409, 'engagement_refused', `This engagement is ${engagement.status}, so it cannot be sent.`)
  }
  if (sendUnderWay(engagement, context.now ?? new Date())) {
    return refuse(409, 'engagement_refused', 'A send of this letter is already under way - wait a minute, then check Activity. Nothing more was sent.', { reason: 'sending' })
  }
  if (sentJustNow(engagement, context.now ?? new Date())) {
    return refuse(409, 'engagement_refused', 'This letter was sent a moment ago. Nothing more was sent.', {
      reason: 'just_sent',
    })
  }
  if (preview.teamOnly) return refuse(409, 'team_address', preview.recipientNote)
  // Her picker choice could not be honored (an address no longer on file, a bad or
  // fourth one-time address, one-time alone, a team member's): the resolver's answer.
  if (preview.recipientRefusal) {
    return refuse(
      preview.recipientRefusal.status,
      preview.recipientRefusal.error,
      preview.recipientNote,
      // The list as it is now, so the page can reopen the picker on it.
      preview.recipientRefusal.error === 'recipients_changed' ? { recipients: preview.details } : {},
    )
  }
  if (preview.to.length === 0) return refuse(409, 'no_recipient', preview.recipientNote)
  if (!preview.docs.pdf) {
    console.error('[engagements] could not build the PDF for', engagement.id, preview.docs.pdfError?.message)
    return refuse(502, 'pdf_failed', 'The PDF could not be built, so nothing was sent.')
  }
  if (!deps.configured) {
    return refuse(502, 'engagement_send_failed', 'Email is not configured yet (no sending address set).')
  }
  // The last gate: take the "sending" mark with one compare-and-set on the stamp this send
  // loaded. The 15-second check above reads the log, which two Sends started together both
  // see empty; only one of them can win this, so only one letter goes out.
  if (!(await deps.store.claimEngagementSend(engagement.id, engagement.updatedAt))) {
    return refuse(409, 'engagement_refused', 'A send of this letter is already under way - wait a minute, then check Activity. Nothing more was sent.', { reason: 'sending' })
  }

  const mail = {
    to: preview.to,
    subject: preview.docs.email.subject,
    html: preview.docs.email.html,
    text: preview.docs.email.text,
    attachments: [{ filename: preview.docs.pdfFilename, content: preview.docs.pdf }],
    fromName: context.firmSettings?.name || undefined,
    engagementId: engagement.id,
    kind: 'engagement',
  }
  let sendResult
  try {
    sendResult = await deps.sendMail(mail)
    if (!sendResult.ok && sendResult.status === 429) {
      await deps.pause(ENGAGEMENT_RATE_LIMIT_WAIT_MS)
      sendResult = await deps.sendMail(mail)
    }
  } catch (error) {
    console.error('[engagements] send failed unexpectedly:', error)
    sendResult = {
      ok: false,
      error: `The letter to ${partyName(engagement)} did not finish sending. Check with them before sending again.`,
      providerId: null,
    }
  }
  // Past this point the email has either gone out or been refused; no bookkeeping
  // failure may change what the answer says.
  let logged = null
  try {
    logged = await deps.store.markEngagementSent(engagement.id, {
      to: preview.to,
      providerId: sendResult.providerId ?? null,
      ok: sendResult.ok === true,
      error: sendResult.ok ? null : (sendResult.error ?? null),
      subject: preview.docs.email.subject,
      // What went out, so signing can tell the letter changed after it was sent.
      hash: engagementHash(engagement),
    })
  } catch (error) {
    console.error('[engagements] could not log the send:', error)
  }
  return {
    ok: sendResult.ok === true,
    error: sendResult.ok ? null : (sendResult.error ?? 'The email provider refused the message.'),
    to: preview.to,
    engagement: logged ?? engagement,
  }
}
