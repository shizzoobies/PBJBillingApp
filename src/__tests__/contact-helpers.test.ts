import { describe, expect, it } from 'vitest'
import { emailForClient, unlinkedContacts } from '../lib/utils'
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
