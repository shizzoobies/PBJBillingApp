/**
 * The addresses inside a stored recipient value, for the team-address guard of the
 * engagement letter (featreq-5e195707).
 *
 * A contact's or client's email is free text that is not validated on save, and the
 * mail provider delivers to what it can read in it: `Alex Owner <alex@firm.test>`,
 * `pat@acme.test, alex@firm.test` and `pat@acme.test; alex@firm.test` each name an
 * address a whole-string comparison would never see. So the guard looks at every
 * address that can be read out of the value. Pure (the Letters page imports it too).
 */

const ADDRESS = /[^\s<>,;"'()[\]]+@[^\s<>,;"'()[\]]+/g

/** Zero-width and soft-hyphen characters: invisible in a stored value, ignored by a reader of it. */
const INVISIBLE = /[\u200B-\u200D\u2060\u00AD\uFEFF]/g

/** Every address in a value, lower-cased, trailing dots trimmed; none for a value with no `@`. */
export function addressesIn(value) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\bmailto:/gi, ' ')
  return (text.match(ADDRESS) ?? []).map((address) => address.toLowerCase().replace(/\.+$/, ''))
}

/**
 * The recipient entries ({ email, source }) minus any that names an app user's address in
 * ANY form - except the reply-to mailbox itself, which may stay. An entry that names a team
 * address alongside a real one is dropped whole: it cannot be mailed without mailing the team.
 * An entry from which NO address can be read is dropped too, never kept: what cannot be read
 * cannot be shown to be safe (every entry reaching here was stored with an "@" in it).
 *
 * @param {Array<{email: string}>} details
 * @param {Set<string>|undefined} teamEmails lower-case addresses of app user accounts
 * @param {string} [replyTo]
 */
export function withoutTeamAddresses(details, teamEmails, replyTo = '') {
  const team = teamEmails ?? new Set()
  const reply = String(replyTo ?? '').trim().toLowerCase()
  return details.filter((detail) => {
    const found = addressesIn(detail.email)
    return found.length > 0 && found.every((address) => !team.has(address) || address === reply)
  })
}
