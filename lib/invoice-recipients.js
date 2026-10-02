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

/**
 * An address plausible enough to try: one `@`, no whitespace, a dot in the
 * domain, no longer than the RFC's 320. The base pattern is the one the
 * proposal-send route already applies to its `to`, tightened for an address that
 * goes into an email's To line: it also refuses `<`, `>`, `,`, `;`, `"`, `(`, `)`
 * (what turns one address into a display name, a list or a comment) and any
 * control character. It is a guard against typos and header injection, not a
 * verdict on whether the mailbox exists - Resend rejects what is truly malformed.
 */
export function isPlausibleEmail(value) {
  const email = typeof value === 'string' ? value.trim() : ''
  if (email.length === 0 || email.length > 320) return false
  if (/[<>,;"()]/.test(email)) return false
  for (const character of email) {
    const code = character.codePointAt(0)
    if (code < 32 || code === 127) return false
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** The most addresses one send may carry beyond the ones on file. */
export const MAX_EXTRA_INVOICE_RECIPIENTS = 3

/** What the 409 says when the browser chose from addresses the server no longer has. */
export const RECIPIENTS_CHANGED_REASON =
  'The addresses on file for this client have changed. Reload and choose again.'

/** Said out loud in the UI and in the 400, so each is written once. */
export const EXTRA_RECIPIENT_REFUSALS = Object.freeze({
  shape: 'The extra addresses were not in a shape this invoice can read, so nothing was sent.',
  invalid: 'One of the extra addresses is not a valid email address, so nothing was sent.',
  tooMany: `An invoice can go to at most ${MAX_EXTRA_INVOICE_RECIPIENTS} extra addresses, so nothing was sent.`,
})

/**
 * The extra addresses a send carries, cleaned - or the sentence that refuses them.
 *
 * Each is trimmed and must be a plausible single address; a repeat (compared
 * case-insensitively, first spelling wins) collapses to one. Absent means none.
 * Anything that is not an array, an entry that is not a valid address, or more
 * than {@link MAX_EXTRA_INVOICE_RECIPIENTS} distinct ones refuses the whole
 * request: an email cannot be unsent, so a half-understood list is not guessed at.
 *
 * @param {unknown} requested
 * @returns {{extra: string[], reason: string|null}}
 */
export function cleanExtraRecipients(requested) {
  if (requested === undefined || requested === null) return { extra: [], reason: null }
  if (!Array.isArray(requested)) return { extra: [], reason: EXTRA_RECIPIENT_REFUSALS.shape }

  const extra = []
  const taken = new Set()
  for (const raw of requested) {
    if (!isPlausibleEmail(raw)) return { extra: [], reason: EXTRA_RECIPIENT_REFUSALS.invalid }
    const email = raw.trim()
    const key = email.toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    extra.push(email)
  }
  if (extra.length > MAX_EXTRA_INVOICE_RECIPIENTS) {
    return { extra: [], reason: EXTRA_RECIPIENT_REFUSALS.tooMany }
  }
  return { extra, reason: null }
}

/**
 * Who a send goes to, from what the request asked for - the send route's whole
 * decision, in one place so it can be proved without booting the server.
 *
 *  - `to` is a FILTER over `allowed`, the client's own addresses, exactly as
 *    {@link chooseInvoiceRecipients} applies it. That check is the trust
 *    boundary and is unchanged.
 *  - `extra` is a SEPARATE list of addresses for this one send only. They are
 *    validated by {@link cleanExtraRecipients}, de-duplicated against the
 *    chosen on-file addresses (case-insensitively), and never saved anywhere.
 *  - At least one ON-FILE address must be among the recipients, so the invoice
 *    still reaches the client - unless the client has NO address on file at all,
 *    in which case `extra` alone may be used (a client whose contact has no
 *    email yet). A browser that names addresses in `to` for a client the server
 *    now finds none for chose from a list that no longer exists: that is refused
 *    (409 `recipients_changed`), not quietly sent to the extras only.
 *  - An `extra` that IS an on-file address of the client (even one she left
 *    unticked) is that on-file address: sent under its stored spelling and not
 *    marked one-time, because it is not.
 *
 * `oneTime` is the subset of `to` that came from `extra` and is NOT on file;
 * the send is logged with it.
 *
 * @param {{allowed: string[], to?: unknown, extra?: unknown}} args
 * @returns {{ok: true, to: string[], oneTime: string[]} |
 *           {ok: false, status: number, error: string, message: string}}
 */
export function resolveSendRecipients({ allowed, to, extra }) {
  const cleaned = cleanExtraRecipients(extra)
  if (cleaned.reason) {
    return {
      ok: false,
      status: 400,
      error: 'invoice_bad_extra_recipient',
      message: cleaned.reason,
    }
  }

  if (allowed.length === 0) {
    if (Array.isArray(to) && to.length > 0) {
      return {
        ok: false,
        status: 409,
        error: 'recipients_changed',
        message: RECIPIENTS_CHANGED_REASON,
      }
    }
    if (cleaned.extra.length === 0) {
      return {
        ok: false,
        status: 409,
        error: 'invoice_no_recipient',
        message: NO_INVOICE_RECIPIENT_REASON,
      }
    }
    return { ok: true, to: cleaned.extra, oneTime: cleaned.extra }
  }

  const chosen = chooseInvoiceRecipients(allowed, to)
  if (chosen.to.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'invoice_no_chosen_recipient',
      message: chosen.reason ?? NO_CHOSEN_RECIPIENT_REASON,
    }
  }
  const onFileSpelling = new Map(allowed.map((email) => [email.toLowerCase(), email]))
  const taken = new Set(chosen.to.map((email) => email.toLowerCase()))
  const recipients = [...chosen.to]
  const oneTime = []
  for (const email of cleaned.extra) {
    const key = email.toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    const stored = onFileSpelling.get(key)
    if (stored) {
      recipients.push(stored)
    } else {
      recipients.push(email)
      oneTime.push(email)
    }
  }
  return { ok: true, to: recipients, oneTime }
}
