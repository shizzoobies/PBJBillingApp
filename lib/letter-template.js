/**
 * The engagement letter's placeholders (featreq-5e195707).
 *
 * The owner writes one email and one letter with `{{placeholder}}` tokens; this
 * module is the whole contract between those tokens and a client record. Pure on
 * purpose - no store, no env, no node built-ins - so the Letters page can import
 * the placeholder list and the server can fill the very same text with the very
 * same code, and what she previews is what leaves.
 *
 * Syntax: `{{name}}`, inner spaces allowed, case-insensitive, `[a-z0-9_]+`.
 *
 *  - A REQUIRED placeholder that resolves to blank is reported in `missing` and
 *    the text keeps it blank: a client is never shown a raw `{{fee}}`.
 *  - An UNKNOWN placeholder (a typo such as `{{clientname}}`) is reported in
 *    `unknown` and left in the text as typed, so the preview shows the typo.
 *    Send refuses a template that has one.
 *  - A RETIRED placeholder (one the app used to fill in and no longer can, such as
 *    `{{hourly_rate}}`) is reported in `retired`, not `unknown`, so the message can say
 *    why; it is left in the text as typed and Send refuses it the same way. It is
 *    recognized ONLY so that message can name it - it is not in the placeholder list,
 *    has no chip and is never filled in.
 */

import { firmToday } from './firm-time.js'
import { currency } from './invoice-lines.js'
import { mailingAddressLines } from './mailing-address.js'

/**
 * Every placeholder the app fills in, in the order the page lists them.
 * `required`: a blank value stops the letter going to that client.
 *
 * @type {ReadonlyArray<{key: string, label: string, description: string, required: boolean}>}
 */
export const letterPlaceholders = Object.freeze(
  [
    { key: 'client_name', label: 'Client name', description: "The client's name.", required: true },
    {
      key: 'contact_first_name',
      label: 'Contact first name',
      description: "The first name of the client's primary contact.",
      required: true,
    },
    {
      key: 'contact_name',
      label: 'Contact name',
      description: "The full name of the client's primary contact.",
      required: true,
    },
    {
      key: 'fee',
      label: 'Fee',
      description:
        "The client's fee by how they are billed: a monthly rate or an annual fee, with its unit. Blank for an hourly client, who has no single fee.",
      required: true,
    },
    {
      key: 'monthly_fee',
      label: 'Monthly fee',
      description: "The monthly rate, for a client billed monthly. Blank for any other client.",
      required: true,
    },
    {
      key: 'annual_fee',
      label: 'Annual fee',
      description: "The yearly fee, for a client billed annually. Blank for any other client.",
      required: true,
    },
    {
      key: 'client_address',
      label: 'Client address',
      description: "The client's mailing address, one line per row.",
      required: false,
    },
    { key: 'year', label: 'Year', description: 'The current year.', required: false },
    { key: 'next_year', label: 'Next year', description: 'The coming year.', required: false },
    { key: 'today', label: 'Today', description: "Today's date.", required: false },
    { key: 'firm_name', label: 'Firm name', description: "The firm's name.", required: false },
    { key: 'firm_email', label: 'Firm email', description: "The firm's email address.", required: false },
    { key: 'firm_phone', label: 'Firm phone', description: "The firm's phone number.", required: false },
    {
      key: 'sender_name',
      label: 'Your name',
      description: 'The name of the person sending the letter.',
      required: false,
    },
  ].map((entry) => Object.freeze(entry)),
)

const KNOWN = new Map(letterPlaceholders.map((entry) => [entry.key, entry]))

/**
 * Placeholders the app no longer fills in, with the reason a letter that still names one is
 * told. An hourly client is billed at each team member's own rate, so there is no single
 * hourly rate to print (the stored `hourlyRate` is only the legacy firm default).
 */
export const retiredPlaceholders = Object.freeze({
  hourly_rate: 'hourly clients have no single rate',
})

/** "{{hourly_rate}} is no longer filled in - hourly clients have no single rate; take it out" */
export function retiredSentence(keys) {
  return keys
    .map((key) => `{{${key}}} is no longer filled in - ${retiredPlaceholders[key] ?? 'it has no value to print'}; take it out`)
    .join('. ')
}

/** `{{ name }}` - anything between the braces, so a malformed token is caught, not skipped. */
const TOKEN = /\{\{([^{}]*)\}\}/g
const KEY_SHAPE = /^[a-z0-9_]+$/

const clean = (value) => String(value ?? '').trim()

/** "2026-10-08" -> "October 8, 2026". The same wording as `longDate` in lib/invoice-email.js, which this module cannot import (it reads process.env). */
function longDateOf(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ''
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(
    new Date(`${iso}T12:00:00`),
  )
}

/** A positive rate formatted as dollars, or '' (a $0 or missing rate is "not set", not "free"). */
function money(amount) {
  const value = Number(amount)
  return Number.isFinite(value) && value > 0 ? currency.format(value) : ''
}

/**
 * The primary contact: the FIRST active linked contact with a name (the rule in
 * lib/primary-contact.js), else the name typed on the client record.
 */
function primaryContactName(client, contacts) {
  const byId = new Map((Array.isArray(contacts) ? contacts : []).map((contact) => [contact?.id, contact]))
  for (const contactId of Array.isArray(client?.contactIds) ? client.contactIds : []) {
    const contact = byId.get(contactId)
    if (!contact || contact.archivedAt) continue
    const name = clean(contact.name)
    if (name) return name
  }
  return clean(client?.contactName) || clean(client?.contact)
}

/**
 * Every placeholder's value for one client. Always a string; blank means "no value".
 *
 * @param {object} args
 * @param {object} args.client
 * @param {object[]} [args.contacts]      every contact (the client's are found by `contactIds`)
 * @param {object|null} [args.firmSettings]
 * @param {Date} [args.now]               injectable for tests
 * @param {string} [args.senderName]      the session user's name
 * @returns {Record<string, string>}
 */
export function letterValues({ client, contacts = [], firmSettings = null, now = new Date(), senderName = '' }) {
  const mode = client?.billingMode
  const monthly = mode === 'subscription' ? money(client?.monthlyRate) : ''
  // An hourly client has no fee of its own: it is billed at each team member's bill
  // rate, and `client.hourlyRate` is only the legacy firm default kept for back-compat
  // (most hourly clients still carry the old default). Quoting it would tell a client
  // a figure nobody set for them, so for an hourly client `fee` and `monthly_fee`
  // stay blank and the client is skipped by the missing-value rule.
  const annual = mode === 'annual' ? money(client?.annualRate) : ''
  let fee = ''
  if (monthly) fee = `${monthly} per month`
  else if (annual) fee = `${annual} per year`

  const day = firmToday(now)
  const contactName = primaryContactName(client, contacts)
  return {
    client_name: clean(client?.name),
    contact_first_name: contactName.split(/\s+/)[0] ?? '',
    contact_name: contactName,
    fee,
    monthly_fee: monthly,
    annual_fee: annual,
    client_address: mailingAddressLines(client).join('\n'),
    year: day.slice(0, 4),
    next_year: String(Number(day.slice(0, 4)) + 1),
    today: longDateOf(day),
    firm_name: clean(firmSettings?.name),
    firm_email: clean(firmSettings?.email),
    firm_phone: clean(firmSettings?.phone),
    sender_name: clean(senderName),
  }
}

/**
 * Fill a text with a client's values.
 *
 * @param {string} text
 * @param {Record<string, string>} values  from `letterValues`
 * @returns {{text: string, missing: string[], unknown: string[], retired: string[]}}
 *   `missing`: required keys that were blank where the text used them; `unknown`:
 *   tokens the app does not fill in. Both are in order of first use, no repeats.
 */
export function fillTemplate(text, values) {
  const missing = []
  const unknown = []
  const retired = []
  const filled = String(text ?? '').replace(TOKEN, (token, inner) => {
    const key = clean(inner).toLowerCase()
    const entry = KEY_SHAPE.test(key) ? KNOWN.get(key) : undefined
    if (!entry) {
      const list = Object.hasOwn(retiredPlaceholders, key) ? retired : unknown
      if (!list.includes(key)) list.push(key)
      return token
    }
    const value = String(values?.[key] ?? '')
    if (entry.required && !value.trim() && !missing.includes(key)) missing.push(key)
    return value
  })
  return { text: filled, missing, unknown, retired }
}

/**
 * Warnings for a template as typed: the unknown and the retired placeholders, across
 * all three boxes. Warns on save and preview; Send refuses either.
 *
 * @param {{subject?: string, emailBody?: string, letterBody?: string}} template
 * @returns {{unknown: string[], retired: string[]}}
 */
export function templateWarnings(template) {
  const unknown = []
  const retired = []
  for (const text of [template?.subject, template?.emailBody, template?.letterBody]) {
    const found = fillTemplate(text, {})
    for (const key of found.unknown) if (!unknown.includes(key)) unknown.push(key)
    for (const key of found.retired) if (!retired.includes(key)) retired.push(key)
  }
  return { unknown, retired }
}

/* ---- the snapshot key ---------------------------------------------------- */

// SHA-256 in plain JS rather than node:crypto: this module is imported by the
// browser bundle, where a node built-in is a build error. The test pins it
// against node's own.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function sha256Hex(message) {
  const bytes = new TextEncoder().encode(message)
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 0x100000000))
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  return [...h].map((word) => word.toString(16).padStart(8, '0')).join('')
}

/**
 * The snapshot key of a template: sha256 of `[subject, emailBody, letterBody]`.
 * The Send route compares the page's hash with the stored template's, so a letter
 * edited in another tab is never sent from a stale screen.
 *
 * @param {{subject?: string, emailBody?: string, letterBody?: string}} template
 * @returns {string} 64 hex characters
 */
export function letterTemplateHash(template) {
  return sha256Hex(
    JSON.stringify([
      String(template?.subject ?? ''),
      String(template?.emailBody ?? ''),
      String(template?.letterBody ?? ''),
    ]),
  )
}
