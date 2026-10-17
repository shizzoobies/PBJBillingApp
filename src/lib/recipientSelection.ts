import type { InvoiceRecipientDetail } from './utils'

/**
 * The recipient picker's selection, as plain functions (featreq-34627da1), so the
 * dialog, Remind all's per-invoice lists and Letters' per-client lists all read
 * a choice the same way. See src/components/RecipientPicker.tsx.
 */

/** What is ticked: on-file addresses and added ones alike, keyed by the address itself. */
export type RecipientSelection = { chosen: string[]; extras: string[] }

/** The starting ticks: `defaultTo` (case-insensitively) when given, else everyone on file. */
export function initialRecipientSelection(
  details: InvoiceRecipientDetail[],
  defaultTo?: string[] | null,
): RecipientSelection {
  if (!defaultTo) return { chosen: details.map((detail) => detail.email), extras: [] }
  const wanted = new Set(defaultTo.map((email) => email.trim().toLowerCase()))
  return {
    chosen: details.filter((detail) => wanted.has(detail.email.toLowerCase())).map((detail) => detail.email),
    extras: [],
  }
}

/**
 * What a selection sends: `to` the ticked on-file addresses in the listed order
 * (so the To: line reads the way the list did), `extra` the ticked added ones,
 * and whether the server's rule is met - at least one address ON FILE, unless
 * nothing is on file at all, where the added ones alone may be used.
 */
export function recipientSelectionResult(details: InvoiceRecipientDetail[], selection: RecipientSelection) {
  const to = details.filter((detail) => selection.chosen.includes(detail.email)).map((detail) => detail.email)
  const extra = selection.extras.filter((email) => selection.chosen.includes(email))
  const canSend = details.length > 0 ? to.length > 0 : extra.length > 0
  return { to, extra, total: to.length + extra.length, canSend }
}

/** "a@x.com, b@y.com (this send only)" - the final list, in words. */
export function recipientListLabel(to: string[], extra: string[]) {
  return [...to, ...extra.map((email) => `${email} (this send only)`)].join(', ')
}

/** The sentence a picker shows (and its button's title carries) when the rule is not met. */
export const PICK_ONE_ON_FILE =
  'Pick at least one address on file - an email cannot go to nobody, or only to addresses added for this send.'
