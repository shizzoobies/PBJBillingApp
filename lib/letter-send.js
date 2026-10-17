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
 * addressed to the recipients `sendOneLetter` settles (`preview.to`, or the ones she chose).
 */

import { firmTimeZone } from './firm-time.js'
import { invoiceEmailAddressee, resolveInvoiceRecipients, resolveSendRecipients } from './invoice-recipients.js'
import { buildLetterDocuments } from './letter-documents.js'
import { LETTER_IN_FLIGHT_MS } from './letter-in-flight.js'
import { coveredByMasterSentence, reconcileCoveredResults } from './letter-batch-cover.js'
import { withoutTeamAddresses } from './recipient-addresses.js'

/** Resend allows about two requests a second and takes no attachments in a batch: one at a time, spaced. */
export const LETTER_SEND_GAP_MS = 600
export const LETTER_RATE_LIMIT_WAIT_MS = 1500
export const LETTER_MAX_CLIENTS_PER_SEND = 50
export { LETTER_IN_FLIGHT_MS }

/** The placeholders that carry a fee, for the hourly-client sentence. */
const FEE_KEYS = ['fee', 'monthly_fee', 'annual_fee']

const LETTER_DELETED_MESSAGE = 'This letter was deleted before the send started.'

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

/**
 * The billing master of `client` when that master is in the same batch, else null.
 * A sub-company's invoices go to the master's mailbox, so ticking both would send
 * two letters with two different figures to one mailbox: the master's letter covers it.
 */
function masterInBatch(clients, client, batchIds) {
  if (!client?.billToClientId || !batchIds?.has(client.billToClientId)) return null
  return clients.find((entry) => entry.id === client.billToClientId) ?? null
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
 * `context`: { template, data, firmSettings, senderName, now, teamEmails?, replyTo?, batchClientIds? }.
 * `batchClientIds` (optional) are the clients ticked together with this one: when this
 * client's billing master is among them the result carries `batchNote`, the sentence Send
 * would skip it with.
 * `teamEmails` (lower-case) are the addresses of app user accounts; one of them is
 * never a recipient, except the reply-to mailbox itself.
 *
 * @returns {Promise<{notFound: true} | {client: object, docs: object, to: string[], details: object[], recipientNote: string|null, teamOnly: boolean, refusal: string|null, missing: string[], missingNote: string|null, unknown: string[], retired: string[], flags: object}>}
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

  // The tax-document rule, at the address: an entry that names a team member's account
  // address in ANY form (bare, `Name <addr>`, several in one field) is dropped, unless it
  // is the reply-to mailbox the replies are meant for.
  const details = withoutTeamAddresses(resolved.details, context.teamEmails, context.replyTo)
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
  const coveredBy = masterInBatch(clients, client, new Set(context.batchClientIds ?? []))
  const missing = docs.fill.missing
  // Who the letter is to, as an engagement party (a sent letter is recorded as an
  // amendment on the client, engagements stage 4): the company and address the letter
  // names, its contact, and the first address it goes to.
  const party = {
    company: receiving.name ?? '',
    contactName: docs.values?.contact_name ?? '',
    email: to[0] ?? '',
    phone: receiving.phone ?? '',
    addressLine1: receiving.addressLine1 ?? '',
    addressLine2: receiving.addressLine2 ?? '',
    city: receiving.city ?? '',
    state: receiving.state ?? '',
    postalCode: receiving.postalCode ?? '',
  }
  return {
    client,
    docs,
    party,
    to,
    details,
    recipientNote,
    teamOnly,
    refusal: recipientNote ?? resolved.reason,
    batchNote: coveredBy ? coveredByMasterSentence(client.name, coveredBy.name) : null,
    missing,
    missingNote: missing.length > 0 ? letterMissingSentence(client.name, missing, fillClient.billingMode) : null,
    unknown: docs.fill.unknown,
    retired: docs.fill.retired,
    flags: {
      neverEmailed: Boolean(client.invoiceNoEmail),
      billedOutside: Boolean(client.platformInvoicingOptOut),
      inactive: (client.lifecycleStage ?? 'active') === 'inactive',
      billingMasterSub: master ? (master.name ?? null) : null,
    },
  }
}

/**
 * The recipients for one client's letter: everyone the preview would mail (on
 * file, team addresses already dropped), or - when the page posted a choice for
 * this client from its recipient picker (featreq-34627da1) - that choice, decided
 * by the invoice Send's own `resolveSendRecipients`: `to` filters the on-file set,
 * `extra` adds at most three valid one-time addresses, and at least one address
 * on file must be among them. A one-time address that is a team member's is
 * refused (the tax-document rule binds what she types too); nothing is claimed
 * or sent for a refused choice.
 *
 * @returns {{ok: true, to: string[], oneTime: string[]} | {ok: false, code: string, message: string}}
 */
export function letterRecipients(context, preview, choice) {
  if (choice === undefined || choice === null) return { ok: true, to: preview.to, oneTime: [] }
  // Strict: an address she ticked that is no longer on file skips this client
  // (`recipients_changed`) rather than being quietly dropped.
  const resolved = resolveSendRecipients({ allowed: preview.to, to: choice.to, extra: choice.extra, strict: true })
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.error === 'recipients_changed' ? 'recipients_changed' : 'bad_recipients',
      message: `${resolved.message} Nothing was sent to ${preview.client.name}.`,
    }
  }
  const typed = resolved.oneTime.map((email) => ({ email }))
  const safe = withoutTeamAddresses(typed, context.teamEmails, context.replyTo)
  if (safe.length !== typed.length) {
    const team = typed.find((entry) => !safe.includes(entry))
    return {
      ok: false,
      code: 'team_address',
      message: `${team.email} belongs to a team member. A letter goes to the client only.`,
    }
  }
  return resolved
}

/** The choice the page posted for one client, read only from the object's own keys. */
const choiceFor = (recipients, clientId) =>
  recipients && typeof recipients === 'object' && Object.hasOwn(recipients, clientId)
    ? recipients[clientId]
    : undefined

/**
 * Send the letter to ONE client, or say why not. Every refusal is decided
 * before anything is claimed; the claim row is taken BEFORE the provider is
 * called (it is the double-send guard) and always closed after, sent or failed.
 * A 429 waits and retries once. A claim that is still `sending` is never read as
 * "sent" and never auto-failed: under two minutes old it is another send still
 * running (`sending_now`), older it is reported as unfinished, to be checked by hand.
 *
 * `deps`: { store, sendMail, pause } - the store's three letter-send methods, the
 * mail sender and a delay. Never throws for a provider or bookkeeping problem: an
 * email that left is never reported as failed.
 */
export async function sendOneLetter(context, clientId, { templateHash, firmDay, resend, userId, recipients }, deps) {
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
  // Who she chose on the Letters page for THIS client (featreq-34627da1), or
  // everyone on file when she did not open its picker.
  const chosen = letterRecipients(context, preview, choiceFor(recipients, clientId))
  if (!chosen.ok) return { ...base, status: 'skipped', code: chosen.code, message: chosen.message }
  const sendTo = chosen.to
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

  // The send log is keyed by the letter that was SENT, so "already sent today" and "Last sent"
  // are per letter: sending the 1099 letter never blocks, or counts as, another letter.
  const letterId = context.template.id
  const attempt = resend
    ? await deps.store.nextEngagementLetterAttempt({ letterId, clientId, templateHash, firmDay })
    : 1
  const claim = await deps.store.claimEngagementLetterSend({
    letterId,
    clientId,
    templateHash,
    firmDay,
    attempt,
    subject: preview.docs.email.subject,
    recipients: sendTo,
    createdBy: userId,
  })
  if (!claim.claimed && claim.reason === 'letter_deleted') {
    // Deleted between Send loading the letter and this claim: nothing was written or sent.
    return { ...base, status: 'failed', code: 'letter_deleted', message: LETTER_DELETED_MESSAGE }
  }
  if (!claim.claimed) {
    // The row holding the claim may be one that never finished (the process stopped between
    // the claim and the close). It may or may not have reached the provider, so it is not
    // "already sent" and it is not failed either: say so and leave it to be checked by hand.
    if (claim.send?.status === 'sending') {
      // Younger than a couple of minutes: another owner's send to this client is simply still running.
      // Judged at the claim (the clock now), not at the request's start: a long batch has aged since.
      const startedMs = Date.parse(claim.send.createdAt ?? '')
      const nowMs = Date.now()
      if (Number.isFinite(startedMs) && Number.isFinite(nowMs) && nowMs - startedMs < LETTER_IN_FLIGHT_MS) {
        return {
          ...base,
          status: 'skipped',
          code: 'sending_now',
          message: `A send to ${preview.client.name} is running right now (started ${startedLabel(claim.send.createdAt)}) - it will show in the sends list when it finishes.`,
        }
      }
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
      to: sendTo,
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
      return { ...base, status: 'failed', code: 'provider', message: sendResult.error, to: sendTo, sendId: claim.send.id }
    }
    // The letter went out: record it as an amendment on the client's engagements
    // (engagements stage 4), with the filled text the client received. Its own
    // try/catch - a failure to record never turns a delivered letter into an error.
    let engagementId = null
    try {
      const amendment = await deps.store.recordAmendmentFromLetterSend({
        letterSendId: claim.send.id,
        letterId,
        clientId,
        party: { ...preview.party, email: sendTo[0] ?? '' },
        subject: preview.docs.filled.subject,
        emailBody: preview.docs.filled.emailBody,
        letterBody: preview.docs.filled.letterBody,
        providerId: sendResult.providerId ?? null,
        to: sendTo,
        at: new Date().toISOString(),
        createdBy: userId,
      })
      engagementId = amendment?.id ?? null
    } catch (error) {
      console.error('[letters] the letter was sent, but could not be recorded as an amendment for', clientId, error)
    }
    return { ...base, status: 'sent', to: sendTo, sendId: claim.send.id, engagementId }
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
  // `options.batch` is the whole send when the page splits it into several requests: a master
  // ticked with its sub is "in the batch" even when the two land in different requests.
  const batchIds = new Set([...clientIds, ...(options.batch ?? [])])
  const clients = context.data.clients ?? []
  for (const [index, clientId] of clientIds.entries()) {
    let result
    // A sub-company whose master is in the same batch is refused before anything is
    // claimed: the master's letter covers it, and two letters would reach one mailbox.
    const client = clients.find((entry) => entry.id === clientId)
    const coveredBy = masterInBatch(clients, client, batchIds)
    if (coveredBy) {
      results.push({
        clientId,
        clientName: client.name,
        status: 'skipped',
        code: 'master_in_batch',
        masterId: coveredBy.id,
        masterName: coveredBy.name,
        message: coveredByMasterSentence(client.name, coveredBy.name),
      })
      continue
    }
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
    // The letter itself is gone, so every client still to come fails the same way: stop here
    // rather than walk the rest of the list (each would find nothing to claim against).
    if (result.code === 'letter_deleted') {
      for (const rest of clientIds.slice(index + 1)) {
        const name = clients.find((entry) => entry.id === rest)?.name ?? null
        results.push({
          clientId: rest,
          clientName: name,
          status: 'failed',
          code: 'letter_deleted',
          message: LETTER_DELETED_MESSAGE,
        })
      }
      break
    }
    // Only a provider call needs the gap that keeps under the rate limit.
    const calledProvider = result.status === 'sent' || result.code === 'provider'
    if (calledProvider && index < clientIds.length - 1) await deps.pause(LETTER_SEND_GAP_MS)
  }
  // A sub skipped for its master's letter says so differently when that letter did not go.
  return reconcileCoveredResults(results)
}
