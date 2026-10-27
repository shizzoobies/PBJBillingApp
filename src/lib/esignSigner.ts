import { cleanSignerName, esignSignerName, isReplyToSigner, isSignerEmail } from '../../lib/esign-signer.js'
import type { InvoiceRecipientDetail } from './utils'
import type { SignatureRequest } from './types'

/**
 * The page's half of "who signs" at Send for signature (Alex, 2026-10-27; components/engagements/SignerPicker.tsx).
 * The server decides with lib/esign-signer.js, and the page uses the SAME helpers (`esignSignerName`,
 * `isSignerEmail`, `cleanSignerName`), so the confirm names the signer exactly as the provider will get it.
 */

/** What she has chosen: an address on file, or one typed for this send only; `name` is what she typed (if asked). */
export type SignerSelection =
  | { mode: 'onFile'; email: string; name: string }
  | { mode: 'oneTime'; email: string; name: string }
  | null

/** The signer as Send for signature posts it (lib/esign-signer.js reads it). */
export type EsignSignerPost = { email: string; name?: string; oneTime?: true }

/** Who the letter is for, to name a signer the way the server will. */
export type SignerParty = { email?: string | null; contactName?: string | null; company?: string | null }

/** The address a request went to (its one signer), for "Sent to ..."; '' when it has none recorded. */
export const esignSignerEmail = (request: Pick<SignatureRequest, 'recipients'> | null | undefined): string =>
  String(request?.recipients?.[0]?.email ?? '').trim()

/** The choice the confirm opens with: the party's address when it is on file (and one plain address), else a typed one when nothing is on file. */
export function initialSignerSelection(details: InvoiceRecipientDetail[], defaultTo: string[] | null | undefined): SignerSelection {
  const preferred = (defaultTo ?? [])[0]
  const onFile = preferred ? details.find((detail) => detail.email.toLowerCase() === preferred.toLowerCase()) : undefined
  if (onFile && isSignerEmail(onFile.email)) return { mode: 'onFile', email: onFile.email, name: '' }
  if (details.length === 0) return { mode: 'oneTime', email: '', name: '' }
  return null
}

/** Whether the chosen address needs a typed name: a one-time one always; on file, when it signs under no name of its own. */
export function selectionNeedsName(selection: SignerSelection, details: InvoiceRecipientDetail[], party: SignerParty): boolean {
  if (!selection) return false
  if (selection.mode === 'oneTime') return true
  return !esignSignerName({ email: selection.email, details, party })
}

/**
 * The signer the choice names - the name the provider will get and what the send posts - or null while there is
 * none to send to (nothing chosen, an address that is not one plain address, the firm's reply-to mailbox as anyone
 * but the party, or a name still to be typed).
 */
export function chosenSigner(
  selection: SignerSelection,
  details: InvoiceRecipientDetail[],
  party: SignerParty,
  replyTo = '',
): { email: string; name: string; post: EsignSignerPost } | null {
  if (!selection) return null
  const email = selection.email.trim()
  if (!isSignerEmail(email) || isReplyToSigner({ email, party, replyTo })) return null
  const typed = cleanSignerName(selection.name)
  if (selection.mode === 'onFile') {
    if (!details.some((detail) => detail.email === email)) return null
    const derived = esignSignerName({ email, details, party })
    if (derived) return { email, name: derived, post: { email } }
    return typed ? { email, name: typed, post: { email, name: typed } } : null
  }
  return typed ? { email, name: typed, post: { email, oneTime: true, name: typed } } : null
}
