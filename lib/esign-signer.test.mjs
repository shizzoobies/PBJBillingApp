import { describe, expect, it } from 'vitest'

import { chooseEsignSigner, cleanSignerName, esignSignerChoiceOf, esignSignerName } from './esign-signer.js'

/**
 * Who signs an engagement letter sent for e-signature (Alex, 2026-10-27): the confirm's choice as the
 * route reads it, and the decision - the party's address, a client contact's, or one typed for this
 * send only; never a team mailbox, never two addresses, and nothing missing means the party as before.
 */
const PARTY = { company: 'Acme Books', contactName: 'Pat Doe', email: 'pat@acme.test' }
const DETAILS = [
  { email: 'pat@acme.test', source: 'Pat Doe' },
  { email: 'CFO@Acme.test', source: 'Casey Fox' },
  { email: 'books@acme.test', source: 'client record' },
  { email: 'nameless@acme.test', source: 'Contact' },
]
const TEAM = new Set(['alex@ka-performancefl.example', 'brittany@pbjsa.example'])
const choose = (choice, over = {}) =>
  chooseEsignSigner({ choice, details: DETAILS, party: PARTY, teamEmails: TEAM, replyTo: 'brittany@pbjsa.example', ...over })

describe('esignSignerChoiceOf: the posted shape', () => {
  it('a missing signer is undefined: the party, as before (an older tab)', () => {
    expect(esignSignerChoiceOf(undefined)).toBeUndefined()
    expect(esignSignerChoiceOf(null)).toBeUndefined()
  })

  it('reads { email, name?, oneTime? }, trimming the email and cleaning the name', () => {
    expect(esignSignerChoiceOf({ email: '  cfo@acme.test ' })).toEqual({ email: 'cfo@acme.test', name: '', oneTime: false })
    expect(esignSignerChoiceOf({ email: 'x@y.test', name: '  Casey\n  Fox\u0007 ', oneTime: true })).toEqual({
      email: 'x@y.test',
      name: 'Casey Fox',
      oneTime: true,
    })
  })

  it('a shape it cannot read is null (the route answers 400)', () => {
    for (const raw of ['pat@acme.test', ['pat@acme.test'], {}, { email: 5 }, { email: 'a@b.test', name: 7 }, { email: 'a@b.test', oneTime: 'yes' }]) {
      expect(esignSignerChoiceOf(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('caps a long name', () => {
    expect(cleanSignerName('x'.repeat(500))).toHaveLength(200)
  })
})

describe('chooseEsignSigner: the decision', () => {
  it("the party's own address, named as before (contact name, else company)", () => {
    expect(choose({ email: 'PAT@acme.test', name: '', oneTime: false })).toEqual({ ok: true, email: 'pat@acme.test', name: 'Pat Doe', oneTime: false })
    expect(
      choose({ email: 'pat@acme.test', name: '', oneTime: false }, { party: { ...PARTY, contactName: '' } }),
    ).toMatchObject({ ok: true, name: 'Acme Books' })
  })

  it("one of the client's contacts, case-insensitively, keeping the stored spelling and the contact's name", () => {
    expect(choose({ email: 'cfo@acme.test', name: '', oneTime: false })).toEqual({ ok: true, email: 'CFO@Acme.test', name: 'Casey Fox', oneTime: false })
  })

  it('the client record or an unnamed contact signs under the party contact name', () => {
    expect(choose({ email: 'books@acme.test', name: '', oneTime: false })).toMatchObject({ ok: true, name: 'Pat Doe' })
    expect(choose({ email: 'nameless@acme.test', name: '', oneTime: false })).toMatchObject({ ok: true, name: 'Pat Doe' })
  })

  it('a one-time address is allowed only when marked oneTime, named by the party contact unless a name was typed', () => {
    expect(choose({ email: 'owner@elsewhere.test', name: '', oneTime: true })).toEqual({
      ok: true,
      email: 'owner@elsewhere.test',
      name: 'Pat Doe',
      oneTime: true,
    })
    expect(choose({ email: 'owner@elsewhere.test', name: 'Jo Owner', oneTime: true })).toMatchObject({ ok: true, name: 'Jo Owner' })
    // Marked one-time but on file after all: it is on file.
    expect(choose({ email: 'cfo@acme.test', name: '', oneTime: true })).toMatchObject({ ok: true, oneTime: false, name: 'Casey Fox' })
  })

  it('an address not on file and not marked one-time is refused with the list as it is now', () => {
    const result = choose({ email: 'gone@acme.test', name: '', oneTime: false })
    expect(result).toMatchObject({ ok: false, status: 409, error: 'recipients_changed', recipients: DETAILS })
    expect(result.message).toMatch(/Nothing was sent/)
  })

  it('a team mailbox is refused in any spelling, on file or typed', () => {
    for (const email of ['alex@ka-performancefl.example', 'ALEX+esign@ka-performancefl.example']) {
      for (const oneTime of [true, false]) {
        expect(choose({ email, name: '', oneTime }), email).toMatchObject({ ok: false, status: 409, error: 'team_address' })
      }
    }
  })

  it('two addresses, a named address or no address is refused: exactly one plain address', () => {
    for (const email of ['pat@acme.test, cfo@acme.test', 'pat@acme.test; cfo@acme.test', 'Pat <pat@acme.test>', '', 'not-an-address']) {
      expect(choose({ email, name: '', oneTime: true }), email).toMatchObject({ ok: false, status: 409, error: 'invalid_recipient' })
    }
  })
})

describe('esignSignerName', () => {
  it('falls back to "Client" with no party names at all', () => {
    expect(esignSignerName({ email: 'x@y.test', details: [], party: { email: '' } })).toBe('Client')
  })
})
