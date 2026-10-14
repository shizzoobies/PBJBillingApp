import { describe, expect, it } from 'vitest'

import { addressesIn, withoutTeamAddresses } from './recipient-addresses.js'

const TEAM = new Set(['alex@ka-performancefl.com', 'brittany@pbjsa.com'])
const entry = (email) => ({ email, source: 'client record' })
const kept = (email, replyTo = 'brittany@pbjsa.com') =>
  withoutTeamAddresses([entry(email)], TEAM, replyTo).length === 1

describe('addressesIn', () => {
  it('reads the bare, bracketed, quoted and joined forms, lower-cased', () => {
    expect(addressesIn('Pat@Acme.test')).toEqual(['pat@acme.test'])
    expect(addressesIn('Alex Anderson <Alex@KA-Performancefl.com>')).toEqual(['alex@ka-performancefl.com'])
    expect(addressesIn('"Anderson, Alex" <alex@ka-performancefl.com>')).toEqual(['alex@ka-performancefl.com'])
    expect(addressesIn('pat@acme.test, alex@ka-performancefl.com')).toEqual(['pat@acme.test', 'alex@ka-performancefl.com'])
    expect(addressesIn('pat@acme.test; lee@beta.test')).toEqual(['pat@acme.test', 'lee@beta.test'])
    expect(addressesIn('(pat@acme.test).')).toEqual(['pat@acme.test'])
  })

  it('ignores zero-width characters, a soft hyphen and a mailto: prefix glued to an address', () => {
    expect(addressesIn('al\u200Bex@ka-performancefl.com')).toEqual(['alex@ka-performancefl.com'])
    expect(addressesIn('\u2060alex@ka-per\u00ADformancefl.com\u200D')).toEqual(['alex@ka-performancefl.com'])
    expect(addressesIn('mailto:Alex@KA-Performancefl.com')).toEqual(['alex@ka-performancefl.com'])
    // A full-width at sign reads as the ordinary one.
    expect(addressesIn('alex\uFF20ka-performancefl.com')).toEqual(['alex@ka-performancefl.com'])
  })

  it('reads nothing from a value with no address', () => {
    expect(addressesIn('')).toEqual([])
    expect(addressesIn(null)).toEqual([])
    expect(addressesIn('no email here')).toEqual([])
  })
})

describe('withoutTeamAddresses', () => {
  it('keeps an ordinary address and drops a team one, whatever its case', () => {
    expect(kept('pat@acme.test')).toBe(true)
    expect(kept('alex@ka-performancefl.com')).toBe(false)
    expect(kept('ALEX@KA-Performancefl.com')).toBe(false)
  })

  it('catches a team address in a display-name form', () => {
    expect(kept('Alex Anderson <alex@ka-performancefl.com>')).toBe(false)
    expect(kept('"Anderson, Alex" <Alex@ka-performancefl.com>')).toBe(false)
  })

  it('drops an entry that carries a team address next to a real one, whole', () => {
    expect(kept('pat@acme.test, alex@ka-performancefl.com')).toBe(false)
    expect(kept('pat@acme.test;alex@ka-performancefl.com')).toBe(false)
    expect(kept('alex@ka-performancefl.com pat@acme.test')).toBe(false)
  })

  it('keeps the reply-to mailbox in any form, but not when it rides with another team address', () => {
    expect(kept('Brittany@pbjsa.com')).toBe(true)
    expect(kept('Brittany Ferguson <brittany@pbjsa.com>')).toBe(true)
    expect(kept('brittany@pbjsa.com, alex@ka-performancefl.com')).toBe(false)
    expect(kept('brittany@pbjsa.com', '')).toBe(false)
  })

  it('catches a team address hidden behind an invisible character or a mailto: prefix', () => {
    expect(kept('al\u200Bex@ka-performancefl.com')).toBe(false)
    expect(kept('\uFEFFAlex <alex@ka-performancefl.com\u200C>')).toBe(false)
    expect(kept('mailto:alex@ka-performancefl.com')).toBe(false)
    expect(kept('pat@acme.test, mailto:alex@ka-performancefl.com')).toBe(false)
    expect(kept('mailto:pat@acme.test')).toBe(true)
  })

  it('DROPS an entry from which no address can be read, never keeps it', () => {
    for (const unreadable of ['"alex"@ka-performancefl.com', '@', 'alex @', '<>@<>', 'mailto:', '\u200B@\u200B']) {
      expect(addressesIn(unreadable), unreadable).toEqual([])
      expect(kept(unreadable), unreadable).toBe(false)
    }
  })

  // Engagements leftovers 7: the same mailbox under another spelling is still the team's.
  it('catches a +tag variant of a team address', () => {
    expect(kept('alex+tax@ka-performancefl.com')).toBe(false)
    expect(kept('Alex <ALEX+x+y@ka-performancefl.com>')).toBe(false)
    expect(kept('pat@acme.test, alex+x@ka-performancefl.com')).toBe(false)
    // Only the local part is tagged: another domain, or another person, is not the team.
    expect(kept('alex+x@acme.test')).toBe(true)
    expect(kept('alexa+x@ka-performancefl.com')).toBe(true)
  })

  it('catches the Gmail dot variants of a team address (and googlemail.com), but dots elsewhere count', () => {
    const gmailTeam = new Set(['alex.anderson@gmail.com', 'alex@ka-performancefl.com'])
    const keptWith = (email) => withoutTeamAddresses([entry(email)], gmailTeam, 'brittany@pbjsa.com').length === 1
    expect(keptWith('alex.anderson@gmail.com')).toBe(false)
    expect(keptWith('alexanderson@gmail.com')).toBe(false)
    expect(keptWith('a.l.e.x.a.n.d.e.r.s.o.n@gmail.com')).toBe(false)
    expect(keptWith('Alex.Anderson@GoogleMail.com')).toBe(false)
    expect(keptWith('alex.anderson+tax@gmail.com')).toBe(false)
    // Dots are not ignored outside Gmail: a.lex@ is a different mailbox at the firm's domain.
    expect(keptWith('a.lex@ka-performancefl.com')).toBe(true)
    expect(keptWith('alex.andersen@gmail.com')).toBe(true)
  })

  it('keeps an unrelated address, and the reply-to mailbox only in its exact form', () => {
    expect(kept('pat@acme.test')).toBe(true)
    expect(kept('pat+billing@acme.test')).toBe(true)
    expect(kept('p.at@gmail.com')).toBe(true)
    expect(kept('brittany@pbjsa.com')).toBe(true)
    // A tagged spelling of the reply-to mailbox is not the exact address the exception names.
    expect(kept('brittany+x@pbjsa.com')).toBe(false)
  })

  it('leaves everything alone when no team address is known', () => {
    expect(withoutTeamAddresses([entry('alex@ka-performancefl.com')], undefined)).toHaveLength(1)
    expect(withoutTeamAddresses([entry('alex@ka-performancefl.com')], new Set())).toHaveLength(1)
    // ...but an entry with no readable address is dropped even then.
    expect(withoutTeamAddresses([entry('@')], new Set())).toHaveLength(0)
  })

  it('keeps entry order and the other entries untouched', () => {
    const result = withoutTeamAddresses(
      [entry('a@x.test'), entry('Alex <alex@ka-performancefl.com>'), entry('b@x.test')],
      TEAM,
    )
    expect(result.map((d) => d.email)).toEqual(['a@x.test', 'b@x.test'])
  })
})
