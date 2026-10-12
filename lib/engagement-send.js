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
import { fillTemplate, placeholdersFor, retiredSentence } from './letter-template.js'
import { addressesIn, withoutTeamAddresses } from './recipient-addresses.js'

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
  for (const text of [engagement?.subject, engagement?.emailBody, engagement?.letterBody]) {
    const found = fillTemplate(text, {}, placeholders)
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

/** True when the newest send in the log left less than ENGAGEMENT_JUST_SENT_MS before `now`. */
export function sentJustNow(engagement, now = new Date()) {
  const log = Array.isArray(engagement?.emailLog) ? engagement.emailLog : []
  const last = [...log].reverse().find((entry) => entry?.kind === 'send')
  if (!last || last.ok !== true) return false
  const at = Date.parse(last.at)
  const elapsed = new Date(now).getTime() - at
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

/** The refusal sentence for unknown and retired placeholders. */
function placeholderSentence(unknown, retired) {
  const sentences = []
  if (unknown.length > 0) {
    const names = tokens(unknown)
    sentences.push(
      names.length > 1
        ? `${names.join(', ')} are not placeholders the app fills in`
        : `${names[0]} is not a placeholder the app fills in`,
    )
  }
  if (retired.length > 0) sentences.push(retiredSentence(retired))
  return `${sentences.join('. ')}. Nothing was sent.`
}

const union = (a, b) => [...a, ...b.filter((key) => !a.includes(key))]

/**
 * Exactly what the party would receive if the letter were sent now: the STORED
 * engagement filled by the same builder as Send, who it would go to, and what
 * would stop it. Read-only: it sends, records and notifies nothing, so what she
 * previews is what Send builds by construction.
 *
 * `context`: { data, firmSettings, senderName, now, teamEmails?, replyTo?, buildPdf? }.
 * `teamEmails` (lower-case) are the addresses of app user accounts; none of them is
 * ever a recipient, except the reply-to mailbox itself.
 * `options.to`: one address typed at Send, used instead of the party's.
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

  // The recipient: the address typed at Send, else the party's own. The tax-document
  // rule at the address, as in Letters: an entry naming a team member's account address
  // in ANY form is dropped, unless it is the reply-to mailbox the replies are meant for.
  const typed = typeof options.to === 'string' ? options.to.trim() : ''
  const raw = typed || String(engagement.party?.email ?? '').trim()
  const resolved = raw ? [{ email: raw, source: typed ? 'typed' : 'party' }] : []
  const details = withoutTeamAddresses(resolved, context.teamEmails, context.replyTo)
  const to = details.map((detail) => detail.email)
  const teamOnly = to.length === 0 && resolved.some((detail) => addressesIn(detail.email).length > 0)
  const name = partyName(engagement)
  const recipientNote = teamOnly
    ? `${raw} belongs to a team member. An engagement letter goes to the client only.`
    : to.length === 0
      ? `There is no email address for ${name}. Add one to the party, or type the address at Send.`
      : null

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
 * engagement_empty, engagement_refused (signed, superseded or void; or reason
 * 'just_sent' when a send left under 15 seconds ago - a double click), team_address,
 * no_recipient, pdf_failed, engagement_send_failed (email not configured). Then ONE
 * provider call (a 429 waits and retries once), then the send is logged on the
 * engagement - in its own try/catch, so bookkeeping can never turn a letter that left
 * into a failure.
 *
 * `deps`: { store, sendMail, pause, configured } - the store's `markEngagementSent`,
 * the mail sender, a delay, and whether email is configured at all.
 *
 * @returns {Promise<{refused: {status: number, error: string, message: string}} | {ok: boolean, error: string|null, to: string[], engagement: object}>}
 */
export async function sendEngagement(context, engagement, { to, templateHash, userId }, deps) {
  void userId // who sent it is the route's activity entry
  if (templateHash !== engagementHash(engagement)) {
    return refuse(
      409,
      'engagement_changed',
      'The engagement changed since this page loaded. Nothing was sent. Reload and send again.',
    )
  }
  const preview = await assembleEngagementPreview(context, engagement, { to })
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
  if (sentJustNow(engagement, context.now ?? new Date())) {
    return refuse(409, 'engagement_refused', 'This letter was sent a moment ago. Nothing more was sent.', {
      reason: 'just_sent',
    })
  }
  if (preview.teamOnly) return refuse(409, 'team_address', preview.recipientNote)
  if (preview.to.length === 0) return refuse(409, 'no_recipient', preview.recipientNote)
  if (!preview.docs.pdf) {
    console.error('[engagements] could not build the PDF for', engagement.id, preview.docs.pdfError?.message)
    return refuse(502, 'pdf_failed', 'The PDF could not be built, so nothing was sent.')
  }
  if (!deps.configured) {
    return refuse(502, 'engagement_send_failed', 'Email is not configured yet (no sending address set).')
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
