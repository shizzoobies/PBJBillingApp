/**
 * Resolving a new client's PRIMARY CONTACT to a real contact record.
 *
 * Background (featreq-47424696). The Add-client form used to take the primary
 * contact as free text. That text was stored on the client and nothing else
 * happened — until the next time app data was read, when a backfill silently
 * created a bare contact (no email, no phone) and linked it. So right after
 * saving there was genuinely nothing in the Contacts directory to find, which
 * is what "not sure where that info goes" meant.
 *
 * Two things follow, and this module is the shared rule for both:
 *
 *   1. The primary contact is just the FIRST of the client's linked contacts —
 *      not a third parallel notion of "contact". `client.contact` stays as the
 *      display name because the client table renders it.
 *   2. Picking an existing contact must be the easy path. Free text deduped on
 *      an EXACT name+email match, so "Britt" alongside an existing "Brittany
 *      Ferguson" made a second, emptier record instead of linking the real one.
 *
 * The matching rule below is deliberately the same one the legacy backfill uses
 * (case-insensitive name + email), so a client created through the form and one
 * repaired by the backfill land on the same contact rather than two.
 */

const norm = (value) => String(value ?? '').trim()
const lower = (value) => norm(value).toLowerCase()

/** Dedupe key: case-insensitive name + email, matching the legacy backfill. */
export function contactMatchKey(name, email) {
  return `${lower(name)}|${lower(email)}`
}

/** An existing contact with the same name+email, or null. Archived ones are skipped. */
export function findMatchingContact(contacts, { name, email } = {}) {
  if (!norm(name)) return null
  const wanted = contactMatchKey(name, email)
  return (
    (Array.isArray(contacts) ? contacts : []).find(
      (contact) =>
        contact && !contact.archivedAt && contactMatchKey(contact.name, contact.email) === wanted,
    ) ?? null
  )
}

/** Primary first, then the rest; blanks dropped and duplicates collapsed. */
export function mergeContactIds(primaryId, otherIds) {
  const rest = (Array.isArray(otherIds) ? otherIds : []).filter(
    (id) => typeof id === 'string' && id,
  )
  return [...new Set([...(primaryId ? [primaryId] : []), ...rest])]
}

/**
 * Decide what the primary contact should be, without touching storage — the
 * caller inserts the contact when `create` is set, because that part differs
 * per backend (and on Postgres has to happen inside the client's transaction).
 *
 * @param {object} args
 * @param {Array} args.contacts every existing contact
 * @param {string} [args.primaryContactId] an existing contact chosen in the picker
 * @param {{name?: string, email?: string, phone?: string}} [args.newPrimaryContact]
 *        a name typed into "add a new contact"
 * @param {string[]} [args.contactIds] the other contacts selected on the form
 * @returns {{
 *   primaryContactId: string|null,
 *   create: {name: string, email: string, phone: string}|null,
 *   otherContactIds: string[],
 *   contactName: string,
 * }}
 */
export function planPrimaryContact({
  contacts = [],
  primaryContactId = '',
  newPrimaryContact = null,
  contactIds = [],
} = {}) {
  const known = Array.isArray(contacts) ? contacts : []
  const selected = (Array.isArray(contactIds) ? contactIds : []).filter(
    (id) => typeof id === 'string' && id,
  )
  const without = (id) => selected.filter((entry) => entry !== id)

  // 1. An existing contact chosen in the picker wins outright.
  if (norm(primaryContactId)) {
    const hit = known.find((contact) => contact && contact.id === primaryContactId)
    if (hit) {
      return {
        primaryContactId: hit.id,
        create: null,
        otherContactIds: without(hit.id),
        contactName: norm(hit.name),
      }
    }
    // An id we do not recognize is not a silent no-op: fall through so a typed
    // name can still resolve, and so the caller never links a dangling id.
  }

  // 2. A typed name — reuse an exact match rather than making a near-duplicate.
  const typedName = norm(newPrimaryContact?.name)
  if (typedName) {
    const match = findMatchingContact(known, newPrimaryContact)
    if (match) {
      return {
        primaryContactId: match.id,
        create: null,
        otherContactIds: without(match.id),
        contactName: norm(match.name),
      }
    }
    return {
      primaryContactId: null,
      create: {
        name: typedName,
        email: norm(newPrimaryContact?.email),
        phone: norm(newPrimaryContact?.phone),
      },
      otherContactIds: selected,
      contactName: typedName,
    }
  }

  // 3. Nothing named: the first selected contact is the primary, if any.
  const first = selected[0] ?? null
  const firstContact = first ? known.find((contact) => contact && contact.id === first) : null
  return {
    primaryContactId: first,
    create: null,
    otherContactIds: without(first),
    contactName: firstContact ? norm(firstContact.name) : '',
  }
}
