/**
 * Who signs an engagement letter sent for e-signature (Alex, 2026-10-27: "confirm or specify the
 * email before sending"). Send for signature opens a confirm that names ONE signer: the party's
 * address ticked, the client's other addresses on file offered, or one address typed for this
 * send only. The server decides with the same list the page showed (engagementRecipientList in
 * lib/engagement-send.js: the party's address, then the linked client's contacts and record,
 * team addresses dropped), so what she picked is what goes to the provider - or it is refused.
 *
 * Pure: the page imports `esignSignerName` too (lib/esign-signer.d.ts), so the name the confirm
 * shows is the name the provider is given.
 */

import { CLIENT_RECORD_SOURCE } from './invoice-recipients.js'
import { withoutTeamAddresses } from './recipient-addresses.js'
import { isOneEmailAddress } from './send-recipients.js'

/** The longest signer name kept (the request row caps a recipient's name at 200 too). */
export const MAX_ESIGN_SIGNER_NAME = 200

const clean = (value) => String(value ?? '').trim()
const lower = (value) => clean(value).toLowerCase()

/** A typed name made safe to hand to the provider: no control characters, one space between words, capped. */
export function cleanSignerName(value) {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ESIGN_SIGNER_NAME)
}

/**
 * The posted signer's SHAPE (`{ email, name?, oneTime? }`), nothing more:
 *   undefined - none posted: the party's own address, as before (an older tab);
 *   null      - a shape that cannot be read (the route answers 400);
 *   else      - `{ email, name, oneTime }`, the email trimmed and the name cleaned ('' when none).
 */
export function esignSignerChoiceOf(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.email !== 'string') return null
  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') return null
  if (raw.oneTime !== undefined && raw.oneTime !== null && typeof raw.oneTime !== 'boolean') return null
  return { email: raw.email.trim(), name: cleanSignerName(raw.name), oneTime: raw.oneTime === true }
}

/**
 * The name a signer is given when none was typed: the matching contact's name; for the party's own
 * address, the client record's address, an unnamed contact or a one-time address, the party's contact
 * name, else its company (else "Client").
 *
 * @param {{email: string, details?: Array<{email: string, source: string}>, party?: {email?: string, contactName?: string, company?: string}|null}} args
 */
export function esignSignerName({ email, details = [], party = null }) {
  const fallback = clean(party?.contactName) || clean(party?.company) || 'Client'
  const key = lower(email)
  if (!key || key === lower(party?.email)) return fallback
  const source = clean((details ?? []).find((detail) => lower(detail?.email) === key)?.source)
  if (!source || source.toLowerCase() === CLIENT_RECORD_SOURCE || source === 'Contact') return fallback
  return cleanSignerName(source) || fallback
}

/**
 * The decision for a posted signer (a choice `esignSignerChoiceOf` read): exactly one plain address,
 * never a team member's (the reply-to mailbox excepted, as for every engagement send), and on file for
 * this letter (`details`, case-insensitive) unless she marked it `oneTime`. An address on file keeps its
 * stored spelling. A one-time address is used for this send only - the party record is never changed.
 *
 * @returns {{ok: true, email: string, name: string, oneTime: boolean} |
 *           {ok: false, status: number, error: string, message: string, recipients?: Array<{email: string, source: string}>}}
 */
export function chooseEsignSigner({ choice, details = [], party = null, teamEmails, replyTo = '' }) {
  const email = clean(choice?.email)
  if (!isOneEmailAddress(email)) {
    return {
      ok: false,
      status: 409,
      error: 'invalid_recipient',
      message: 'The signer needs one plain email address (one address, no name or list). Nothing was sent.',
    }
  }
  if (withoutTeamAddresses([{ email }], teamEmails, replyTo).length === 0) {
    return {
      ok: false,
      status: 409,
      error: 'team_address',
      message: `${email} belongs to a team member. An engagement letter goes to the client only.`,
    }
  }
  const onFile = (details ?? []).find((detail) => lower(detail?.email) === email.toLowerCase()) ?? null
  if (!onFile && choice?.oneTime !== true) {
    return {
      ok: false,
      status: 409,
      error: 'recipients_changed',
      message: `${email} is no longer on file for this letter. Choose who signs again. Nothing was sent.`,
      // The list as it is now, so the page can offer it again.
      recipients: details ?? [],
    }
  }
  const chosen = onFile ? onFile.email : email
  return {
    ok: true,
    email: chosen,
    name: cleanSignerName(choice?.name) || esignSignerName({ email: chosen, details, party }),
    oneTime: !onFile,
  }
}
