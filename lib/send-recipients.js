/**
 * Who a manual client email may go to, per route (featreq-34627da1) - the server's
 * half of the recipient picker, as plain functions so each route's rule is tested by
 * running it rather than by reading server.js.
 *
 * Every route does the same three things:
 *   1. `recipientChoiceOf(body)` reads the picker's choice - only its SHAPE.
 *   2. `<route>AllowedDetails(...)` builds the addresses on file for that send, named
 *      (the same list the picker showed).
 *   3. `chooseSendRecipients({ details, to, extra })` decides, with the invoice Send's
 *      own `resolveSendRecipients` in STRICT mode: every `to` must still be on file
 *      (else 409 recipients_changed, carrying the fresh list), at most three valid
 *      one-time `extra` addresses, and never one-time alone while anything is on file.
 */

import {
  invoiceEmailAddressee,
  partyRecipientDetails,
  questionnaireLastRecipients,
  questionnaireRecipientDetails,
  resolveInvoiceRecipients,
  resolveSendRecipients,
} from './invoice-recipients.js'

/** The most on-file addresses one posted `to` may name. */
export const MAX_POSTED_RECIPIENTS = 50

/** A single address: the shape check the engagement and proposal sends have always used. */
export function isOneEmailAddress(value) {
  return (
    typeof value === 'string' &&
    value.trim().length <= 320 &&
    /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value.trim())
  )
}

/**
 * The recipient picker's choice as a send's body carries it: `to`, the on-file
 * addresses she left ticked (a list; one address as a string is read as a list of
 * one), and `extra`, the ones added for this send only. Absent fields mean the
 * send's own default. Only the SHAPE is checked - a shape it cannot read answers
 * null, and the route refuses before anything happens.
 *
 * @returns {{to: string[]|undefined, extra: unknown[]|undefined} | null}
 */
export function recipientChoiceOf(payload) {
  const rawTo = payload?.to
  const rawExtra = payload?.extra
  let to
  if (rawTo === undefined || rawTo === null || rawTo === '') to = undefined
  else if (typeof rawTo === 'string') to = isOneEmailAddress(rawTo) ? [rawTo.trim()] : null
  else if (
    Array.isArray(rawTo) &&
    rawTo.length <= MAX_POSTED_RECIPIENTS &&
    rawTo.every((address) => typeof address === 'string')
  ) {
    to = rawTo
  } else to = null
  if (to === null) return null
  if (rawExtra !== undefined && rawExtra !== null && !Array.isArray(rawExtra)) return null
  return { to, extra: rawExtra ?? undefined }
}

/**
 * The decision, for any route: `details` is the on-file list (named), `to`/`extra` the
 * choice. A refusal carries `recipients` - the list as it is NOW - so the page can
 * reopen the picker on it.
 *
 * @returns {{ok: true, to: string[], oneTime: string[]} |
 *           {ok: false, status: number, error: string, message: string, recipients: object[]}}
 */
export function chooseSendRecipients({ details, to, extra }) {
  const decided = resolveSendRecipients({
    allowed: details.map((detail) => detail.email),
    to,
    extra,
    strict: true,
  })
  return decided.ok ? decided : { ...decided, recipients: details }
}

/**
 * A proposal's addresses on file: the prospect's own, then - when it was written for
 * a client - that client's by the invoice addressee rule. Team addresses are not
 * filtered (a proposal is not a tax document; the send never filtered them).
 */
export function proposalAllowedDetails({ proposal, clients = [], contacts = [] }) {
  const prospect = proposal?.prospect ?? {}
  const client = proposal?.clientId ? ((clients ?? []).find((entry) => entry?.id === proposal.clientId) ?? null) : null
  return partyRecipientDetails({
    email: prospect.email,
    source: prospect.contactName || prospect.company || 'Prospect',
    client,
    clients,
    contacts,
  })
}

/**
 * A questionnaire link's addresses on file: every address its last email went to
 * (from the log, else `sentTo`), then the prospect (and client) of the proposal its
 * answers started. None for a brand-new link (`questionnaire` null).
 */
export function questionnaireAllowedDetails({ questionnaire = null, proposal = null, clients = [], contacts = [] }) {
  return questionnaireRecipientDetails({
    previous: questionnaire ? questionnaireLastRecipients(questionnaire) : [],
    proposal,
    clients,
    contacts,
  })
}

/**
 * An autopay invitation's addresses on file: the invoice addressee's (a billing
 * master's receiving company), exactly as an invoice is addressed; `refusal` when a
 * master names none.
 */
export function autopayAllowedDetails({ client, clients = [], contacts = [] }) {
  const addressee = invoiceEmailAddressee(client, clients)
  if (addressee.refusal) return { details: [], refusal: addressee.refusal, addressee: null }
  return {
    details: resolveInvoiceRecipients({ client: addressee.addressee, contacts }).details,
    refusal: null,
    addressee: addressee.addressee,
  }
}
