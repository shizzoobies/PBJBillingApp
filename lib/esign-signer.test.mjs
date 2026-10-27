import { describe, expect, it } from 'vitest'

import {
  chooseEsignSigner,
  cleanSignerName,
  esignSignerChoiceOf,
  esignSignerName,
  esignSignerNeedsName,
  isReplyToSigner,
  isSignerEmail,
} from './esign-signer.js'

/**
 * Who signs an engagement letter sent for e-signature (Alex, 2026-10-27): the confirm's choice as the
 * route reads it, and the decision - the party's address, a client contact's, or one typed for this
 * send only; never a team mailbox (not even the firm's reply-to), never two addresses, a name that is
 * never borrowed from someone else, and nothing posted means the party as before.
 */
const PARTY = { company: 'Acme Books', contactName: 'Pat Doe', email: 'pat@acme.test' }
const DETAILS = [
  { email: 'pat@acme.test', source: 'Pat Doe' },
  { email: 'CFO@Acme.test', source: 'Casey Fox' },
  { email: 'books@acme.test', source: 'client record' },
  { email: 'nameless@acme.test', source: 'Contact' },
]
const TEAM = new Set(['alex@ka-performancefl.example', 'brittany@pbjsa.example'])
const REPLY_TO = 'brittany@pbjsa.example'
const choose = (choice, over = {}) =>
  chooseEsignSigner({ choice: { name: '', oneTime: false, ...choice }, details: DETAILS, party: PARTY, teamEmails: TEAM, replyTo: REPLY_TO, ...over })

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

  it('caps a long name and drops invisible format characters', () => {
    expect(cleanSignerName('x'.repeat(500))).toHaveLength(200)
    expect(cleanSignerName('Jo​ O‮wner­')).toBe('Jo Owner')
  })
})

describe('chooseEsignSigner: the decision', () => {
  it("the party's own address, named as before (contact name, else company)", () => {
    expect(choose({ email: 'PAT@acme.test' })).toEqual({ ok: true, email: 'pat@acme.test', name: 'Pat Doe', oneTime: false })
    expect(choose({ email: 'pat@acme.test' }, { party: { ...PARTY, contactName: '' } })).toMatchObject({ ok: true, name: 'Acme Books' })
  })

  it("one of the client's named contacts, case-insensitively, keeping the stored spelling and the contact's name (a typed one is ignored)", () => {
    expect(choose({ email: 'cfo@acme.test' })).toEqual({ ok: true, email: 'CFO@Acme.test', name: 'Casey Fox', oneTime: false })
    expect(choose({ email: 'cfo@acme.test', name: 'Someone Else' })).toMatchObject({ ok: true, name: 'Casey Fox' })
  })

  it("the client record, an unnamed contact, a one-time address or a nameless party never borrow the party contact's name: a name must be typed", () => {
    for (const [choice, over] of [
      [{ email: 'books@acme.test' }, {}],
      [{ email: 'nameless@acme.test' }, {}],
      [{ email: 'owner@elsewhere.test', oneTime: true }, {}],
      [{ email: 'pat@acme.test' }, { party: { email: 'pat@acme.test', contactName: '', company: '' } }],
    ]) {
      const refused = choose(choice, over)
      expect(refused, choice.email).toMatchObject({ ok: false, status: 409, error: 'signer_name_required' })
      expect(refused.message).toMatch(/Nothing was sent/)
      expect(choose({ ...choice, name: '  Jo   Owner ' }, over), choice.email).toMatchObject({ ok: true, name: 'Jo Owner' })
    }
    expect(choose({ email: 'owner@elsewhere.test', oneTime: true, name: 'Jo Owner' })).toEqual({
      ok: true,
      email: 'owner@elsewhere.test',
      name: 'Jo Owner',
      oneTime: true,
    })
  })

  it('marked one-time but on file after all: it is on file', () => {
    expect(choose({ email: 'cfo@acme.test', oneTime: true })).toMatchObject({ ok: true, oneTime: false, name: 'Casey Fox' })
  })

  it('an address not on file and not marked one-time is refused with the list as it is now', () => {
    const result = choose({ email: 'gone@acme.test', name: 'Gone' })
    expect(result).toMatchObject({ ok: false, status: 409, error: 'recipients_changed', recipients: DETAILS })
    expect(result.message).toMatch(/Nothing was sent/)
  })

  it('a team mailbox is refused in any spelling, on file or typed', () => {
    for (const email of ['alex@ka-performancefl.example', 'ALEX+esign@ka-performancefl.example', 'brittany+x@pbjsa.example']) {
      for (const oneTime of [true, false]) {
        expect(choose({ email, oneTime, name: 'X' }), email).toMatchObject({ ok: false, status: 409, error: 'team_address' })
      }
    }
  })

  it("the firm's reply-to mailbox signs only as the party's own address (the Test client's case), never as a contact, the client record or a typed address", () => {
    const testParty = { company: 'Test', contactName: 'Brittany Ferguson', email: 'Brittany@pbjsa.example' }
    const testDetails = [{ email: 'Brittany@pbjsa.example', source: 'Brittany Ferguson' }]
    expect(choose({ email: 'brittany@pbjsa.example' }, { party: testParty, details: testDetails })).toEqual({
      ok: true,
      email: 'Brittany@pbjsa.example',
      name: 'Brittany Ferguson',
      oneTime: false,
    })
    // Not the party's own address: refused however it was chosen.
    for (const details of [[...DETAILS, { email: REPLY_TO, source: 'Brittany' }], [...DETAILS, { email: REPLY_TO, source: 'client record' }], DETAILS]) {
      for (const oneTime of [true, false]) {
        expect(choose({ email: REPLY_TO, oneTime, name: 'B' }, { details }), JSON.stringify([details.at(-1), oneTime])).toMatchObject({ ok: false, status: 409, error: 'team_address' })
      }
    }
    // Even when the reply-to is not an app user's own login, it is still never a contact or one-time signer.
    expect(choose({ email: REPLY_TO, oneTime: true, name: 'B' }, { teamEmails: new Set() })).toMatchObject({ ok: false, error: 'team_address' })
    expect(isReplyToSigner({ email: 'BRITTANY@pbjsa.example', party: PARTY, replyTo: REPLY_TO })).toBe(true)
    expect(isReplyToSigner({ email: REPLY_TO, party: testParty, replyTo: REPLY_TO })).toBe(false)
    expect(isReplyToSigner({ email: 'cfo@acme.test', party: PARTY, replyTo: REPLY_TO })).toBe(false)
  })

  it('two addresses, a named address, control or invisible characters, or no address is refused: exactly one plain address', () => {
    for (const email of ['pat@acme.test, cfo@acme.test', 'pat@acme.test; cfo@acme.test', 'Pat <pat@acme.test>', '', 'not-an-address', 'pat​@acme.test', 'pat@acme\u0000.test', 'p"at@acme.test']) {
      expect(choose({ email, oneTime: true, name: 'X' }), JSON.stringify(email)).toMatchObject({ ok: false, status: 409, error: 'invalid_recipient' })
    }
    expect(isSignerEmail('pat@acme.test')).toBe(true)
  })
})

describe('esignSignerName / esignSignerNeedsName: one rule for the page and the server', () => {
  it('names the party and named contacts; nothing for the rest', () => {
    expect(esignSignerName({ email: 'pat@acme.test', details: DETAILS, party: PARTY })).toBe('Pat Doe')
    expect(esignSignerName({ email: 'cfo@acme.test', details: DETAILS, party: PARTY })).toBe('Casey Fox')
    for (const email of ['books@acme.test', 'nameless@acme.test', 'x@y.test', '']) {
      expect(esignSignerName({ email, details: DETAILS, party: PARTY }), email).toBe('')
    }
    expect(esignSignerNeedsName({ email: 'cfo@acme.test', details: DETAILS, party: PARTY })).toBe(false)
    expect(esignSignerNeedsName({ email: 'books@acme.test', details: DETAILS, party: PARTY })).toBe(true)
    expect(esignSignerNeedsName({ email: 'cfo@acme.test', details: DETAILS, party: PARTY, oneTime: true })).toBe(true)
  })
})
