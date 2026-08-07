import { describe, expect, it } from 'vitest'

import {
  contactMatchKey,
  findMatchingContact,
  mergeContactIds,
  planPrimaryContact,
} from './primary-contact.js'

/**
 * Resolving a new client's primary contact (featreq-47424696).
 *
 * The behavior these pin down, in Brittany's terms: the name she puts in the
 * Primary contact box must end up as a real, findable contact — reusing the
 * person already in the directory rather than quietly making a near-duplicate.
 */

const CONTACTS = [
  { id: 'contact-brit', name: 'Brittany Ferguson', email: 'brittany@pbj.local' },
  { id: 'contact-lisa', name: 'Lisa Moore', email: '' },
  { id: 'contact-old', name: 'Gone Away', email: '', archivedAt: '2026-01-01T00:00:00.000Z' },
]

describe('contactMatchKey', () => {
  it('ignores case and surrounding space on both halves', () => {
    expect(contactMatchKey('  Brittany Ferguson ', 'BRITTANY@pbj.local')).toBe(
      contactMatchKey('brittany ferguson', 'brittany@pbj.local'),
    )
  })

  it('treats a missing email as empty rather than as a wildcard', () => {
    expect(contactMatchKey('Lisa Moore', undefined)).toBe(contactMatchKey('Lisa Moore', ''))
    expect(contactMatchKey('Lisa Moore', undefined)).not.toBe(
      contactMatchKey('Lisa Moore', 'lisa@pbj.local'),
    )
  })
})

describe('findMatchingContact', () => {
  it('matches on name + email regardless of case', () => {
    expect(
      findMatchingContact(CONTACTS, { name: 'brittany ferguson', email: 'Brittany@PBJ.local' })?.id,
    ).toBe('contact-brit')
  })

  it('does NOT match a different email for the same name', () => {
    expect(
      findMatchingContact(CONTACTS, { name: 'Brittany Ferguson', email: 'other@x.com' }),
    ).toBeNull()
  })

  // The behavior she hit: "Brittany" is not "Brittany Ferguson", so it makes a
  // second record. Matching is exact by design — a fuzzy match that silently
  // attached a client to the wrong person would be far worse — which is why the
  // picker exists, so typing is the exception rather than the norm.
  it('does not treat a partial name as the same person', () => {
    expect(findMatchingContact(CONTACTS, { name: 'Brittany' })).toBeNull()
  })

  it('skips archived contacts', () => {
    expect(findMatchingContact(CONTACTS, { name: 'Gone Away' })).toBeNull()
  })

  it('returns null for a blank name', () => {
    expect(findMatchingContact(CONTACTS, { name: '   ' })).toBeNull()
    expect(findMatchingContact(CONTACTS, {})).toBeNull()
  })
})

describe('mergeContactIds', () => {
  it('puts the primary first and drops duplicates', () => {
    expect(mergeContactIds('c1', ['c2', 'c1', 'c3'])).toEqual(['c1', 'c2', 'c3'])
  })

  it('survives no primary and junk entries', () => {
    expect(mergeContactIds(null, ['c2', '', 'c2'])).toEqual(['c2'])
    expect(mergeContactIds('', [])).toEqual([])
  })
})

describe('planPrimaryContact', () => {
  it('uses an existing contact chosen in the picker', () => {
    const plan = planPrimaryContact({ contacts: CONTACTS, primaryContactId: 'contact-lisa' })
    expect(plan).toMatchObject({
      primaryContactId: 'contact-lisa',
      create: null,
      contactName: 'Lisa Moore',
    })
  })

  it('does not list the primary twice when it is also selected below', () => {
    const plan = planPrimaryContact({
      contacts: CONTACTS,
      primaryContactId: 'contact-lisa',
      contactIds: ['contact-lisa', 'contact-brit'],
    })
    expect(plan.otherContactIds).toEqual(['contact-brit'])
    expect(mergeContactIds(plan.primaryContactId, plan.otherContactIds)).toEqual([
      'contact-lisa',
      'contact-brit',
    ])
  })

  it('reuses an exact match instead of creating a second record', () => {
    const plan = planPrimaryContact({
      contacts: CONTACTS,
      newPrimaryContact: { name: '  brittany ferguson ', email: 'BRITTANY@pbj.local' },
    })
    expect(plan.create).toBeNull()
    expect(plan.primaryContactId).toBe('contact-brit')
    // The stored display name comes from the RECORD, not from what was typed,
    // so casing stays consistent across clients.
    expect(plan.contactName).toBe('Brittany Ferguson')
  })

  it('asks the caller to create a genuinely new contact', () => {
    const plan = planPrimaryContact({
      contacts: CONTACTS,
      newPrimaryContact: { name: 'New Person', email: 'new@x.com', phone: '555' },
    })
    expect(plan.primaryContactId).toBeNull()
    expect(plan.create).toEqual({ name: 'New Person', email: 'new@x.com', phone: '555' })
    expect(plan.contactName).toBe('New Person')
  })

  it('trims the typed name and tolerates missing email/phone', () => {
    const plan = planPrimaryContact({ contacts: [], newPrimaryContact: { name: '  Solo  ' } })
    expect(plan.create).toEqual({ name: 'Solo', email: '', phone: '' })
  })

  // A stale picker (contact archived or deleted in another tab) must not link a
  // dangling id — that is the shape of the outage a dangling plan id caused.
  it('never links an unrecognized contact id', () => {
    const plan = planPrimaryContact({ contacts: CONTACTS, primaryContactId: 'contact-nope' })
    expect(plan.primaryContactId).toBeNull()
    expect(plan.create).toBeNull()
  })

  it('falls back to an unknown id but still honors a typed name', () => {
    const plan = planPrimaryContact({
      contacts: CONTACTS,
      primaryContactId: 'contact-nope',
      newPrimaryContact: { name: 'Lisa Moore' },
    })
    expect(plan.primaryContactId).toBe('contact-lisa')
  })

  it('promotes the first selected contact when no primary was named', () => {
    const plan = planPrimaryContact({
      contacts: CONTACTS,
      contactIds: ['contact-brit', 'contact-lisa'],
    })
    expect(plan.primaryContactId).toBe('contact-brit')
    expect(plan.contactName).toBe('Brittany Ferguson')
    expect(plan.otherContactIds).toEqual(['contact-lisa'])
  })

  it('yields nothing at all for an empty form', () => {
    expect(planPrimaryContact({ contacts: CONTACTS })).toMatchObject({
      primaryContactId: null,
      create: null,
      contactName: '',
    })
    expect(planPrimaryContact()).toMatchObject({ primaryContactId: null, create: null })
  })
})
