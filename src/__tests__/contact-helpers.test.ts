import { describe, expect, it } from 'vitest'
import {
  distinctGroupNames,
  emailForClient,
  groupContacts,
  unlinkedContacts,
} from '../lib/utils'
import type { Client, Contact } from '../lib/types'

/**
 * Minimal Contact / Client factories — only the fields the helpers read are
 * required, so the tests stay focused on the pure logic.
 */
function makeContact(over: Partial<Contact> & { id: string }): Contact {
  return { name: over.id, ...over }
}
function makeClient(over: Partial<Client> & { id: string }): Client {
  return {
    name: over.id,
    contact: '',
    billingMode: 'subscription',
    contactIds: [],
    ...over,
  } as Client
}

describe('emailForClient', () => {
  it('returns the base email when there is no per-company override', () => {
    const contact = makeContact({ id: 'c1', email: 'base@example.com' })
    expect(emailForClient(contact, 'client-1')).toBe('base@example.com')
  })

  it('uses the per-company override for the matching client', () => {
    const contact = makeContact({
      id: 'c1',
      email: 'base@example.com',
      companyEmails: [{ clientId: 'client-1', email: 'override@acme.com' }],
    })
    expect(emailForClient(contact, 'client-1')).toBe('override@acme.com')
    // A different client with no override falls back to the base email.
    expect(emailForClient(contact, 'client-2')).toBe('base@example.com')
  })

  it('ignores a blank override and falls back to the base email', () => {
    const contact = makeContact({
      id: 'c1',
      email: 'base@example.com',
      companyEmails: [{ clientId: 'client-1', email: '   ' }],
    })
    expect(emailForClient(contact, 'client-1')).toBe('base@example.com')
  })

  it('returns an empty string when neither override nor base email exists', () => {
    const contact = makeContact({ id: 'c1' })
    expect(emailForClient(contact, 'client-1')).toBe('')
  })
})

describe('unlinkedContacts', () => {
  it('flags contacts not referenced by any client', () => {
    const contacts = [
      makeContact({ id: 'c1' }),
      makeContact({ id: 'c2' }),
      makeContact({ id: 'c3' }),
    ]
    const clients = [makeClient({ id: 'client-1', contactIds: ['c1'] })]
    expect(unlinkedContacts(contacts, clients).map((c) => c.id)).toEqual(['c2', 'c3'])
  })

  it('never flags an archived contact (it is intentionally off the list)', () => {
    const contacts = [
      makeContact({ id: 'c1' }),
      makeContact({ id: 'c2', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const clients: Client[] = []
    // c2 is archived, so only c1 is reported as unlinked.
    expect(unlinkedContacts(contacts, clients).map((c) => c.id)).toEqual(['c1'])
  })

  it('returns an empty list when every active contact is linked', () => {
    const contacts = [makeContact({ id: 'c1' }), makeContact({ id: 'c2' })]
    const clients = [
      makeClient({ id: 'client-1', contactIds: ['c1'] }),
      makeClient({ id: 'client-2', contactIds: ['c2'] }),
    ]
    expect(unlinkedContacts(contacts, clients)).toEqual([])
  })
})

describe('distinctGroupNames', () => {
  it('returns the trimmed distinct groups, sorted case-insensitively', () => {
    const contacts = [
      makeContact({ id: 'c1', group: 'Smith Family' }),
      makeContact({ id: 'c2', group: 'Acme stakeholders' }),
      makeContact({ id: 'c3', group: '  Smith Family  ' }),
      makeContact({ id: 'c4', group: '' }),
      makeContact({ id: 'c5' }),
    ]
    expect(distinctGroupNames(contacts)).toEqual(['Acme stakeholders', 'Smith Family'])
  })

  it('dedupes case-insensitively, keeping the first-seen spelling', () => {
    const contacts = [
      makeContact({ id: 'c1', group: 'Acme' }),
      makeContact({ id: 'c2', group: 'acme' }),
    ]
    expect(distinctGroupNames(contacts)).toEqual(['Acme'])
  })
})

describe('groupContacts', () => {
  it('partitions into alphabetical sections with members sorted by name', () => {
    const contacts = [
      makeContact({ id: 'c1', name: 'Bob', group: 'Smith Family' }),
      makeContact({ id: 'c2', name: 'Alice', group: 'Smith Family' }),
      makeContact({ id: 'c3', name: 'Zoe', group: 'Acme' }),
    ]
    const sections = groupContacts(contacts)
    expect(sections.map((s) => s.group)).toEqual(['Acme', 'Smith Family'])
    expect(sections[1].contacts.map((c) => c.name)).toEqual(['Alice', 'Bob'])
  })

  it('puts ungrouped contacts in an "Ungrouped" section last', () => {
    const contacts = [
      makeContact({ id: 'c1', name: 'Solo' }),
      makeContact({ id: 'c2', name: 'Grouped', group: 'Team' }),
    ]
    const sections = groupContacts(contacts)
    expect(sections.map((s) => s.group)).toEqual(['Team', 'Ungrouped'])
    expect(sections[1].ungrouped).toBe(true)
    expect(sections[1].contacts.map((c) => c.id)).toEqual(['c1'])
  })

  it('omits the Ungrouped section when every contact has a group', () => {
    const contacts = [makeContact({ id: 'c1', group: 'A' })]
    const sections = groupContacts(contacts)
    expect(sections.map((s) => s.group)).toEqual(['A'])
  })

  it('merges case-variant group names into one section', () => {
    const contacts = [
      makeContact({ id: 'c1', name: 'X', group: 'Acme' }),
      makeContact({ id: 'c2', name: 'Y', group: 'acme' }),
    ]
    const sections = groupContacts(contacts)
    expect(sections).toHaveLength(1)
    expect(sections[0].contacts.map((c) => c.id)).toEqual(['c1', 'c2'])
  })
})
