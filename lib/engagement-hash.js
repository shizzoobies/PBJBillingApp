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
