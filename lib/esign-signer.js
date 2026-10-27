/**
 * Who signs an engagement letter sent for e-signature (Alex, 2026-10-27: "confirm or specify the email
 * before sending"). Send for signature opens a confirm that names ONE signer: the party's address chosen,
 * the client's other addresses on file offered, or one address typed for this send only. The server decides
 * with the same list the page showed (engagementRecipientList in lib/engagement-send.js: the party's address,
 * then the linked client's contacts and record, team addresses dropped), so what she picked is what goes to
 * the provider - or it is refused.
 *
 * The signer's NAME goes on a binding document, so it is never borrowed from someone else: the party's own
 * address signs under the party's contact name (else its company), a named contact under that contact's
 * name; any other address - the client record's, an unnamed contact's, a one-time one, or a party with no
 * name at all - needs a name typed at the confirm (`signer_name_required`).
 *
 * Pure: the page imports `esignSignerName` / `esignSignerNeedsName` too (lib/esign-signer.d.ts), so the name
 * the confirm shows is the name the provider is given.
 */

import { CLIENT_RECORD_SOURCE, isPlausibleEmail } from './invoice-recipients.js'
import { withoutTeamAddresses } from './recipient-addresses.js'
import { isOneEmailAddress } from './send-recipients.js'

/** The longest signer name kept (the request row caps a recipient's name at 200 too). */
export const MAX_ESIGN_SIGNER_NAME = 200

/** The generic source a contact with no name is listed under (lib/invoice-recipients.js). */
const UNNAMED_CONTACT_SOURCE = 'Contact'

const clean = (value) => String(value ?? '').trim()
const lower = (value) => clean(value).toLowerCase()

/** A typed name made safe to hand to the provider: no control or invisible format characters, one space between words, capped. */
export function cleanSignerName(value) {
  return String(value ?? '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ESIGN_SIGNER_NAME)
}

/** One plain address a signer can be sent to: one address, plausible, no control or invisible characters. */
export function isSignerEmail(value) {
  const email = clean(value)
  return isOneEmailAddress(email) && isPlausibleEmail(email) && !/\p{C}/u.test(email)
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
 * The name an address signs under WITHOUT anything typed: the party's own address -> the party's contact name,
 * else its company; a contact listed by name -> that name. Anything else (the client record's address, an
 * unnamed contact, an address not on file, a party with no name) -> '' : a name must be typed.
 *
 * @param {{email: string, details?: Array<{email: string, source: string}>, party?: {email?: string|null, contactName?: string|null, company?: string|null}|null}} args
 */
export function esignSignerName({ email, details = [], party = null }) {
  const key = lower(email)
  if (!key) return ''
  if (key === lower(party?.email)) return cleanSignerName(party?.contactName) || cleanSignerName(party?.company)
  const source = clean((details ?? []).find((detail) => lower(detail?.email) === key)?.source)
  if (!source || source.toLowerCase() === CLIENT_RECORD_SOURCE || source === UNNAMED_CONTACT_SOURCE) return ''
  return cleanSignerName(source)
}

/** Whether a name must be typed for this address (one-time addresses always need one). */
export function esignSignerNeedsName({ email, details = [], party = null, oneTime = false }) {
  return oneTime === true || !esignSignerName({ email, details, party })
}

/**
 * The decision for a posted signer (a choice `esignSignerChoiceOf` read): exactly one plain address, never a
 * team member's - for e-signature not even the firm's reply-to mailbox - and on file for this letter
 * (`details`, case-insensitive) unless she marked it `oneTime`. An address on file keeps its stored spelling. A
 * one-time address is used for this send only - the party record is never changed. The name is the derived one
 * (`esignSignerName`) when there is one, else the typed one, else refused.
 *
 * @returns {{ok: true, email: string, name: string, oneTime: boolean} |
 *           {ok: false, status: number, error: string, message: string, recipients?: Array<{email: string, source: string}>}}
 */
export function chooseEsignSigner({ choice, details = [], party = null, teamEmails }) {
  const email = clean(choice?.email)
  if (!isSignerEmail(email)) {
    return {
      ok: false,
      status: 409,
      error: 'invalid_recipient',
      message: 'The signer needs one plain email address (one address, no name or list). Nothing was sent.',
    }
  }
  // No reply-to exemption here: an engagement letter is never signed from the firm's own mailbox.
  if (withoutTeamAddresses([{ email }], teamEmails, '').length === 0) {
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
  const name = (onFile ? esignSignerName({ email: chosen, details, party }) : '') || cleanSignerName(choice?.name)
  if (!name) {
    return {
      ok: false,
      status: 409,
      error: 'signer_name_required',
      message: `Type the name of the person who signs at ${chosen}: it goes on the signed letter. Nothing was sent.`,
    }
  }
  return { ok: true, email: chosen, name, oneTime: !onFile }
}
