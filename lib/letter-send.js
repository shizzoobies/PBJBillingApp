/**
 * Previewing and sending the engagement letter (featreq-5e195707), as plain
 * functions so every rule below is tested by running it, not by reading
 * server.js: the server loads the context (the stored letter, the workspace,
 * the firm, who is sending, which addresses belong to team members) and hands
 * over the store and the mail sender it wants used.
 *
 * Alex's rule (2026-10-08): a letter goes to the client's addressees and nowhere
 * else - no owner notification, no copy of the document. Nothing in this file
 * notifies anyone; the only mail call is `deps.sendMail` (and its one 429 retry),
 * addressed to `preview.to`.
 */

import { firmTimeZone } from './firm-time.js'
import { invoiceEmailAddressee, resolveInvoiceRecipients } from './invoice-recipients.js'
import { buildLetterDocuments } from './letter-documents.js'

export const LETTER_ID = 'default'
/** Resend allows about two requests a second and takes no attachments in a batch: one at a time, spaced. */
export const LETTER_SEND_GAP_MS = 600
export const LETTER_RATE_LIMIT_WAIT_MS = 1500
export const LETTER_MAX_CLIENTS_PER_SEND = 50

/** The placeholders that carry a fee, for the hourly-client sentence. */
const FEE_KEYS = ['fee', 'hourly_rate', 'monthly_fee', 'annual_fee']

const tokens = (keys) => keys.map((key) => `{{${key}}}`)
const listOf = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '')

/** The sentence for required placeholders with no value for this client. */
export function letterMissingSentence(clientName, missing, billingMode) {
  const sentences = []
  // An hourly client has no fee of its own (it is billed at each team member's rate),
  // so "set it on the client page" would point at a field that does not exist.
  const feeKeys = billingMode === 'hourly' ? missing.filter((key) => FEE_KEYS.includes(key)) : []
  if (feeKeys.length > 0) {
    sentences.push(
      `${clientName} is billed hourly, so there is no single fee to fill in - take ${listOf(tokens(feeKeys))} out of the letter, or write their rates by hand.`,
    )
  }
  const rest = missing.filter((key) => !feeKeys.includes(key))
  if (rest.length > 0) {
    const names = tokens(rest)
    sentences.push(
      names.length > 1
        ? `${listOf(names)} have no value for ${clientName} - set them on the client page, or take the placeholders out of the letter.`
        : `${names[0]} has no value for ${clientName} - set it on the client page, or take the placeholder out of the letter.`,
    )
  }
  return sentences.join(' ')
}

/** "Oct 8, 2:05 PM" on the firm's clock. */
function startedLabel(createdAt) {
  const at = new Date(createdAt)
  if (Number.isNaN(at.getTime())) return 'an earlier time'
  return at.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: firmTimeZone(),
  })
}

/**
 * Exactly what one client would receive if the letter were sent now: the
 * STORED template filled for that client by the same builder as Send, who it
 * would go to under the invoice addressee rule, and what would stop it.
 * Read-only: it claims, sends, records and notifies nothing, so what she previews
 * is what Send builds by construction.
 *
 * `context`: { template, data, firmSettings, senderName, now, teamEmails?, replyTo? }.
 * `teamEmails` (lower-case) are the addresses of app user accounts; one of them is
 * never a recipient, except the reply-to mailbox itself.
 *
 * @returns {Promise<{notFound: true} | {client: object, docs: object, to: string[], details: object[], recipientNote: string|null, teamOnly: boolean, refusal: string|null, missing: string[], missingNote: string|null, unknown: string[], flags: object}>}
 */
export async function assembleLetterPreview(context, clientId) {
  const { template, data, firmSettings, senderName, now } = context
  const clients = data.clients ?? []
  const client = clients.find((entry) => entry.id === clientId)
  if (!client) return { notFound: true }

  const addressee = invoiceEmailAddressee(client, clients)
  const resolved = addressee.refusal
    ? { to: [], details: [], reason: null }
    : resolveInvoiceRecipients({ client: addressee.addressee, contacts: data.contacts ?? [] })

  // The tax-document rule, at the address: an address that belongs to a team member's
  // account is dropped, unless it is the reply-to mailbox the replies are meant for.
  const teamEmails = context.teamEmails ?? new Set()
  const replyTo = String(context.replyTo ?? '').trim().toLowerCase()
  const details = resolved.details.filter((detail) => {
    const key = String(detail.email).trim().toLowerCase()
    return !teamEmails.has(key) || key === replyTo
  })
  const to = details.map((detail) => detail.email)
  const teamOnly = resolved.to.length > 0 && to.length === 0

  const recipientNote = addressee.refusal
    ? (addressee.refusal.message ?? null)
    : teamOnly
      ? `The only address on file for ${client.name} belongs to a team member.`
      : null

  // The letter's own name, contacts and address are the receiving company's under the
  // master's name; its FIGURES (billing mode, fee) are the master's own.
  const receiving = addressee.addressee ?? client
  const fillClient =
    client.isBillingMaster === true && addressee.addressee
      ? {
          ...receiving,
          billingMode: client.billingMode,
          monthlyRate: client.monthlyRate,
          hourlyRate: client.hourlyRate,
          annualRate: client.annualRate,
        }
      : receiving
  const docs = await buildLetterDocuments({
    template,
    client: fillClient,
    contacts: data.contacts ?? [],
    firmSettings,
    now,
    senderName,
  })
  const master = client.billToClientId ? clients.find((entry) => entry.id === client.billToClientId) : null
  const missing = docs.fill.missing
  return {
    client,
    docs,
    to,
    details,
    recipientNote,
    teamOnly,
    refusal: recipientNote ?? resolved.reason,
    missing,
    missingNote: missing.length > 0 ? letterMissingSentence(client.name, missing, fillClient.billingMode) : null,
    unknown: docs.fill.unknown,
    flags: {
      neverEmailed: Boolean(client.invoiceNoEmail),
      billedOutside: Boolean(client.platformInvoicingOptOut),
      inactive: (client.lifecycleStage ?? 'active') === 'inactive',
      billingMasterSub: master ? (master.name ?? null) : null,
    },
  }
}

/**
 * Send the letter to ONE client, or say why not. Every refusal is decided
 * before anything is claimed; the claim row is taken BEFORE the provider is
 * called (it is the double-send guard) and always closed after, sent or failed.
 * A 429 waits and retries once. A claim that is still `sending` is never read as
 * "sent" and never auto-failed: it is reported as unfinished, to be checked by hand.
 *
 * `deps`: { store, sendMail, pause } - the store's three letter-send methods, the
 * mail sender and a delay. Never throws for a provider or bookkeeping problem: an
 * email that left is never reported as failed.
 */
export async function sendOneLetter(context, clientId, { templateHash, firmDay, resend, userId }, deps) {
  const preview = await assembleLetterPreview(context, clientId)
  if (preview.notFound) {
    return {
      clientId,
      clientName: null,
      status: 'skipped',
      code: 'not_found',
      message: 'This client is no longer on file.',
    }
  }
  const base = { clientId, clientName: preview.client.name }
  if (preview.teamOnly) return { ...base, status: 'skipped', code: 'team_address', message: preview.recipientNote }
  if (preview.recipientNote) return { ...base, status: 'skipped', code: 'no_addressee', message: preview.recipientNote }
  if (preview.to.length === 0) return { ...base, status: 'skipped', code: 'no_recipients', message: preview.refusal }
  if (preview.missing.length > 0) {
    return { ...base, status: 'skipped', code: 'missing_placeholder', message: preview.missingNote }
  }
  if (!preview.docs.pdf) {
    console.error('[letters] could not build the PDF for', clientId, preview.docs.pdfError?.message)
    return {
      ...base,
      status: 'skipped',
      code: 'pdf_failed',
      message: `The PDF for ${preview.client.name} could not be built, so nothing was sent to them.`,
    }
  }

  const attempt = resend
    ? await deps.store.nextEngagementLetterAttempt({ letterId: LETTER_ID, clientId, templateHash, firmDay })
    : 1
  const claim = await deps.store.claimEngagementLetterSend({
    letterId: LETTER_ID,
    clientId,
    templateHash,
    firmDay,
    attempt,
    subject: preview.docs.email.subject,
    recipients: preview.to,
    createdBy: userId,
  })
  if (!claim.claimed) {
    // The row holding the claim may be one that never finished (the process stopped between
    // the claim and the close). It may or may not have reached the provider, so it is not
    // "already sent" and it is not failed either: say so and leave it to be checked by hand.
    if (claim.send?.status === 'sending') {
      return {
        ...base,
        status: 'skipped',
        code: 'unfinished',
        message: `A send to ${preview.client.name} started at ${startedLabel(claim.send.createdAt)} and never finished - check with them, then use Send again anyway.`,
      }
    }
    return {
      ...base,
      status: 'skipped',
      code: 'already_sent',
      message: `${preview.client.name} was already sent this letter today. Use Send again to send it a second time.`,
    }
  }

  try {
    const mail = {
      to: preview.to,
      subject: preview.docs.email.subject,
      html: preview.docs.email.html,
      text: preview.docs.email.text,
      attachments: [{ filename: preview.docs.pdfFilename, content: preview.docs.pdf }],
      fromName: context.firmSettings?.name || undefined,
      letterSendId: claim.send.id,
      kind: 'letter',
    }
    let sendResult = await deps.sendMail(mail)
    if (!sendResult.ok && sendResult.status === 429) {
      await deps.pause(LETTER_RATE_LIMIT_WAIT_MS)
      sendResult = await deps.sendMail(mail)
    }
    // Past this point the email has either gone out or been refused; no
    // bookkeeping failure may change what the answer says.
    try {
      await deps.store.completeEngagementLetterSend(claim.send.id, {
        ok: sendResult.ok,
        providerId: sendResult.providerId ?? null,
        error: sendResult.error ?? null,
      })
    } catch (error) {
      console.error('[letters] could not close the send log row:', error)
    }
    if (!sendResult.ok) {
      return { ...base, status: 'failed', code: 'provider', message: sendResult.error, to: preview.to, sendId: claim.send.id }
    }
    return { ...base, status: 'sent', to: preview.to, sendId: claim.send.id }
  } catch (error) {
    console.error('[letters] send failed unexpectedly:', error)
    await deps.store
      .completeEngagementLetterSend(claim.send.id, { ok: false, error: 'The send did not finish.' })
      .catch(() => {})
    return {
      ...base,
      status: 'failed',
      code: 'unexpected',
      message: `The letter for ${preview.client.name} did not finish sending. Check with them before sending again.`,
      sendId: claim.send.id,
    }
  }
}

/**
 * The send loop: the clients one at a time, a result for each. A throw while
 * handling one client (a database error between the claim steps, say) is that
 * client's failure, never the whole run's: the others still go, the results of
 * the ones already mailed are kept, and the caller can answer 200.
 */
export async function sendLetterBatch(context, clientIds, options, deps) {
  const results = []
  for (const [index, clientId] of clientIds.entries()) {
    let result
    try {
      result = await sendOneLetter(context, clientId, options, deps)
    } catch (error) {
      console.error('[letters] could not handle a client in the send loop:', clientId, error)
      const name = (context.data.clients ?? []).find((entry) => entry.id === clientId)?.name ?? null
      result = {
        clientId,
        clientName: name,
        status: 'failed',
        code: 'unexpected',
        message: `Something went wrong sending the letter to ${name ?? 'this client'}. Check with them before sending again.`,
      }
    }
    results.push(result)
    // Only a provider call needs the gap that keeps under the rate limit.
    const calledProvider = result.status === 'sent' || result.code === 'provider'
    if (calledProvider && index < clientIds.length - 1) await deps.pause(LETTER_SEND_GAP_MS)
  }
  return results
}
