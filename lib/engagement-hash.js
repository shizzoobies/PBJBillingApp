/**
 * The snapshot key of an engagement letter (docs/plans/engagements-2026-10.md, stage 2B):
 * what Send compares with the page's copy, so a letter edited in another tab is never
 * sent from a stale screen. Unlike a Letters template, an engagement's party IS its
 * recipient and its retainer is printed in the letter, so both are part of the key, not
 * just the three text boxes. Server-side only (the page echoes the `hash` it was given).
 *
 * Input, in this order: a version tag, subject, emailBody, letterBody, retainerAmount
 * (a number, or null for none), then the ten party fields in a fixed order.
 */

import { createHash } from 'node:crypto'

/** The party fields, in the order they are hashed. */
export const ENGAGEMENT_HASH_PARTY_KEYS = Object.freeze([
  'company',
  'contactName',
  'title',
  'email',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
])

/** The retainer as hashed: a finite positive number, else null (blank, 0, junk = none). */
function retainerKey(value) {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

/**
 * @param {{subject?: string, emailBody?: string, letterBody?: string, retainerAmount?: number|null, party?: object}} engagement
 * @returns {string} 64 hex characters
 */
export function engagementHash(engagement) {
  const party = engagement?.party && typeof engagement.party === 'object' ? engagement.party : {}
  return createHash('sha256')
    .update(
      JSON.stringify([
        'engagement-v1',
        String(engagement?.subject ?? ''),
        String(engagement?.emailBody ?? ''),
        String(engagement?.letterBody ?? ''),
        retainerKey(engagement?.retainerAmount),
        ENGAGEMENT_HASH_PARTY_KEYS.map((key) => String(party[key] ?? '')),
      ]),
    )
    .digest('hex')
}

/**
 * Whether a SENT letter changed after it last went out (engagements stage 3, the
 * sent-hash guard): the newest successful send in the email log carries the hash of
 * the letter it sent (`hash`), and this compares it with the letter as stored now.
 * A send logged before sends carried a hash cannot be compared, so it reads as
 * unchanged; a letter never sent successfully has nothing to differ from.
 *
 * @param {{emailLog?: object[], subject?: string, emailBody?: string, letterBody?: string, retainerAmount?: number|null, party?: object}} engagement
 * @returns {boolean}
 */
export function engagementChangedSinceSent(engagement) {
  const log = Array.isArray(engagement?.emailLog) ? engagement.emailLog : []
  // A send for e-signature (kind 'esign') carries the hash of the letter it sent, like an emailed send.
  const lastSent = [...log].reverse().find((entry) => (entry?.kind === 'send' || entry?.kind === 'esign') && entry.ok === true)
  if (!lastSent || typeof lastSent.hash !== 'string' || !lastSent.hash) return false
  return lastSent.hash !== engagementHash(engagement)
}

/** JSON with every object's keys in sorted order, so the same value always hashes the same. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * What an e-signature request pins (featreq-56d39567): the letter (`engagementHash`) AND the signing
 * details signing would apply to the client - package, plans (order-free), fee choice, the proposal's
 * figures and the retainer. The client signs the document SignWell holds; if any of these changed after
 * it went out, signing it for them would apply something they never saw, so it is left for a person.
 */
export function engagementEsignHash(engagement) {
  const details = {
    package_id: engagement?.packageId ?? null,
    plan_ids: [...(Array.isArray(engagement?.planIds) ? engagement.planIds : [])].map(String).sort(),
    fee_mode: engagement?.feeMode ?? 'replace',
    figures: engagement?.figures && typeof engagement.figures === 'object' ? engagement.figures : {},
    retainer_amount: retainerKey(engagement?.retainerAmount),
  }
  return createHash('sha256').update(`${engagementHash(engagement)}|${stableJson(details)}`).digest('hex')
}
