import { isPlausibleEmail } from '../../lib/invoice-recipients.js'
import { esignSignerName } from '../../lib/esign-signer.js'
import type { InvoiceRecipientDetail } from './utils'
import type { SignatureRequest } from './types'

/**
 * The page's half of "who signs" at Send for signature (Alex, 2026-10-27; components/engagements/SignerPicker.tsx).
 * The server decides with lib/esign-signer.js; the name shown here is its `esignSignerName`, so the confirm names
 * the signer exactly as the provider will.
 */

/** What she has chosen: an address on file, or one typed for this send only. */
export type SignerSelection =
  | { mode: 'onFile'; email: string }
  | { mode: 'oneTime'; email: string; name: string }
  | null

/** The signer as Send for signature posts it (lib/esign-signer.js reads it). */
export type EsignSignerPost = { email: string; name?: string; oneTime?: true }

/** Who the letter is for, to name a signer the way the server will. */
export type SignerParty = { email?: string | null; contactName?: string | null; company?: string | null }

/** The address a request went to (its one signer), for "Sent to ..."; '' when it has none recorded. */
export const esignSignerEmail = (request: Pick<SignatureRequest, 'recipients'> | null | undefined): string =>
  String(request?.recipients?.[0]?.email ?? '').trim()

/** The choice the confirm opens with: the party's address when it is on file, else a typed one when nothing is. */
export function initialSignerSelection(details: InvoiceRecipientDetail[], defaultTo: string[] | null | undefined): SignerSelection {
  const preferred = (defaultTo ?? [])[0]
  const onFile = preferred ? details.find((detail) => detail.email.toLowerCase() === preferred.toLowerCase()) : undefined
  if (onFile) return { mode: 'onFile', email: onFile.email }
  if (details.length === 0) return { mode: 'oneTime', email: '', name: '' }
  return null
}

/**
 * The signer the choice names, as the send will post it - or null while there is none to send to (nothing
 * chosen, or a typed address that is not one valid address).
 */
export function chosenSigner(
  selection: SignerSelection,
  details: InvoiceRecipientDetail[],
  party: SignerParty,
): { email: string; name: string; oneTime: boolean; typedName: string } | null {
  if (!selection) return null
  const email = selection.email.trim()
  if (selection.mode === 'onFile') {
    if (!details.some((detail) => detail.email === email)) return null
    return { email, name: esignSignerName({ email, details, party }), oneTime: false, typedName: '' }
  }
  if (!isPlausibleEmail(email)) return null
  const typedName = selection.name.trim()
  return { email, name: typedName || esignSignerName({ email, details: [], party }), oneTime: true, typedName }
}
