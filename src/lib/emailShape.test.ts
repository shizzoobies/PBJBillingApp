import { describe, expect, it } from 'vitest'
import { emailShapeProblem } from './emailShape'

describe('emailShapeProblem', () => {
  it('accepts an empty value and one plain address, trimmed', () => {
    expect(emailShapeProblem('')).toBeNull()
    expect(emailShapeProblem('   ')).toBeNull()
    expect(emailShapeProblem('pat@acme.com')).toBeNull()
    expect(emailShapeProblem('  pat@acme.com  ')).toBeNull()
  })

  it('accepts plus-addressing, dots and subdomains', () => {
    expect(emailShapeProblem('pat+taxes@acme.com')).toBeNull()
    expect(emailShapeProblem('pat.doe@mail.acme.co.uk')).toBeNull()
    expect(emailShapeProblem("o'brien@sub.domain.example.org")).toBeNull()
  })

  it('accepts an internationalized domain, in Unicode or punycode, and a Unicode local part', () => {
    expect(emailShapeProblem('pat@bücher.example')).toBeNull()
    expect(emailShapeProblem('pat@例え.jp')).toBeNull()
    expect(emailShapeProblem('pat@xn--bcher-kva.example')).toBeNull()
    expect(emailShapeProblem('pat@example.xn--p1ai')).toBeNull()
    expect(emailShapeProblem('josé@acme.com')).toBeNull()
    // Combining marks (Devanagari) are part of a label.
    expect(emailShapeProblem('pat@उदाहरण.परीक्षा')).toBeNull()
    expect(emailShapeProblem('pat@भारत.भारत')).toBeNull()
  })

  it('does not care about case, and accepts a long TLD and an uppercase punycode label', () => {
    expect(emailShapeProblem('PAT@ACME.COM')).toBeNull()
    expect(emailShapeProblem('a@b.photography')).toBeNull()
    expect(emailShapeProblem('pat@example.XN--P1AI')).toBeNull()
    expect(emailShapeProblem('pat@XN--BCHER-KVA.EXAMPLE')).toBeNull()
  })

  it('asks for one address when two are typed, whatever separates them', () => {
    expect(emailShapeProblem('a@x.com, b@y.com')).toBe('Enter one email address')
    expect(emailShapeProblem('a@x.com; b@y.com')).toBe('Enter one email address')
    expect(emailShapeProblem('a@x.com b@y.com')).toBe('Enter one email address')
    expect(emailShapeProblem('Jane <a@x.com>, Bob <b@y.com>')).toBe('Enter one email address')
  })

  it('asks for just the address when a name comes with it', () => {
    expect(emailShapeProblem('Jane <a@x.com>')).toBe('Enter just the address, no name')
    expect(emailShapeProblem('<a@x.com>')).toBe('Enter just the address, no name')
  })

  it('says it does not look like an address for anything else', () => {
    expect(emailShapeProblem('pat')).toBe('That does not look like an email address')
    expect(emailShapeProblem('pat@')).toBe('That does not look like an email address')
    expect(emailShapeProblem('@acme.com')).toBe('That does not look like an email address')
    expect(emailShapeProblem('pat@acme')).toBe('That does not look like an email address')
    expect(emailShapeProblem('Jane Doe a@x.com')).toBe('That does not look like an email address')
  })
})
