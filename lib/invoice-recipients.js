/**
 * Who an invoice email goes to — the ONE resolver.
 *
 * Lives in its own module rather than inside `lib/invoice-email.js` so the
 * React side can import it without dragging the whole HTML builder (and its
 * `process.env` reads) into the browser bundle. `lib/invoice-email.js`
 * re-exports it, so every existing server caller and test keeps its import
 * path. One calculator, no forks — the confirmation the owner reads before she
 * presses Send is produced by exactly the code that addresses the email.
 *
 * The rules, in order:
 *   1. Every ACTIVE contact linked to the client contributes.
 *   2. That contact contributes EVERY `companyEmails` entry matching THIS
 *      client, AND its generic `email` — always, not one or the other. A
 *      per-client address is an ADDITION for that client, not a replacement:
 *      if a contact is attached to this client at all, every address on that
 *      contact is a legitimate way to reach them about this client's invoice,
 *      and a personal address is often how the smaller clients actually
 *      receive mail (Alex, 2026-08-13).
 *   3. The address on the client record is appended last.
 * Duplicates are dropped case-insensitively, first mention wins — so a contact
 * whose generic address IS their per-client address still gets one copy.
 */

/**
 * @typedef {{email: string, source: string}} InvoiceRecipientDetail
 *   `source` names WHO the address belongs to — the contact's own name, or the
 *   literal `'client record'` for the address stored on the client itself — so
 *   the UI can show "Anthony Cooper <anthony@…>" rather than a bare list.
 */

/** Said out loud in the UI and in the 409, so it is written once. */
export const NO_INVOICE_RECIPIENT_REASON =
  'No email address on file for this client — add one to the client or one of its contacts.'

/** What `details` calls the address that sits on the client record itself. */
export const CLIENT_RECORD_SOURCE = 'client record'

/**
 * @param {{client?: object, contacts?: object[]}} args
 * @returns {{to: string[], details: InvoiceRecipientDetail[], reason: string|null}}
 */
export function resolveInvoiceRecipients({ client, contacts = [] }) {
  const byId = new Map((contacts ?? []).map((contact) => [contact.id, contact]))
  const seen = new Set()
  const to = []
  const details = []

  const add = (raw, source) => {
    const email = String(raw ?? '').trim()
    // Deliberately loose: this is not a validator, it is a guard against
    // obviously-empty values. Resend rejects genuinely malformed addresses.
    if (!email || !email.includes('@')) return
    const key = email.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    to.push(email)
    details.push({ email, source })
  }

  for (const contactId of client?.contactIds ?? []) {
    const contact = byId.get(contactId)
    if (!contact || contact.archivedAt) continue
    const who = String(contact.name ?? '').trim() || 'Contact'
    // EVERY entry for this client, not just the first — a contact reachable at
    // two addresses for one company had the second silently dropped, which is
    // indistinguishable from "we emailed them" right up until they say they
    // never got it.
    for (const entry of contact.companyEmails ?? []) {
      if (entry?.clientId !== client?.id) continue
      add(entry?.email, who)
    }
    // ...and the generic address as well. Client-specific first because that is
    // the one this client is expected to answer from; the dedupe collapses the
    // two when they are the same address.
    add(contact.email, who)
  }

  add(client?.email, CLIENT_RECORD_SOURCE)

  return {
    to,
    details,
    reason: to.length > 0 ? null : NO_INVOICE_RECIPIENT_REASON,
  }
}

/** Said out loud when the chosen addresses do not overlap the allowed ones. */
export const NO_CHOSEN_RECIPIENT_REASON =
  'None of the chosen addresses belong to this client, so nothing was sent. Pick at least one of the addresses on file.'

/**
 * The send dialog's checkboxes, applied — the TRUST BOUNDARY.
 *
 * `requested` is whatever the request body carried, which is to say: untrusted.
 * It is treated as a FILTER over `allowed` (the addresses this invoice's own
 * client resolves to), never as a list of addresses to email. Anything not in
 * the allowed set is dropped, so a forged body cannot turn an authenticated
 * owner session into an open relay, and the canonical stored spelling of each
 * address is what goes out.
 *
 * `null`/absent `requested` means "everyone" — which is what every caller that
 * predates the dialog does, including the webhook's payment emails.
 *
 * @param {string[]} allowed
 * @param {unknown} requested
 * @returns {{to: string[], reason: string|null}}
 */
export function chooseInvoiceRecipients(allowed, requested) {
  if (!Array.isArray(requested)) return { to: allowed, reason: null }

  const byKey = new Map(allowed.map((email) => [email.toLowerCase(), email]))
  const to = []
  const taken = new Set()
  for (const raw of requested) {
    const key = String(raw ?? '').trim().toLowerCase()
    const match = byKey.get(key)
    if (!match || taken.has(key)) continue
    taken.add(key)
    to.push(match)
  }

  return { to, reason: to.length > 0 ? null : NO_CHOSEN_RECIPIENT_REASON }
}
