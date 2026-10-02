import { describe, expect, it } from 'vitest'
import {
  EXTRA_RECIPIENT_REFUSALS,
  MAX_EXTRA_INVOICE_RECIPIENTS,
  NO_CHOSEN_RECIPIENT_REASON,
  NO_INVOICE_RECIPIENT_REASON,
  RECIPIENTS_CHANGED_REASON,
  cleanExtraRecipients,
  isPlausibleEmail,
  resolveSendRecipients,
} from './invoice-recipients.js'

/**
 * A one-time extra address on a send (owner's answer 3, featreq-21d0bba8).
 *
 * `to` stays a FILTER over the client's own addresses - that boundary is
 * `chooseInvoiceRecipients` and is pinned in invoice-recipient-choice.test.mjs.
 * `extra` is the separate list, and this is where its rules live: valid single
 * addresses, at most three, no repeats, and the invoice still reaches the
 * client unless the client has no address at all.
 */

const allowed = ['anthony@cooper.com', 'charlean@cooper.com']

describe('isPlausibleEmail', () => {
  it('accepts an ordinary address, trimmed', () => {
    expect(isPlausibleEmail('ap@other.com')).toBe(true)
    expect(isPlausibleEmail('  ap@other.com  ')).toBe(true)
    expect(isPlausibleEmail('first.last+tag@sub.other.co.uk')).toBe(true)
  })

  it('refuses the characters that turn one address into a name, a list or a comment', () => {
    for (const bad of [
      'Ann <ap@other.com>',
      '<ap@other.com>',
      'ap@other.com>',
      'a,b@other.com',
      'ap@other.com,',
      'a;b@other.com',
      'ap@other.com;',
      '"ann"@other.com',
      'ap@other.com"',
      'a(b)@other.com',
      'ap@other.com(work)',
      'ap@(x)other.com',
    ]) {
      expect(isPlausibleEmail(bad), bad).toBe(false)
    }
  })

  it('refuses any control character, anywhere', () => {
    for (const code of [0, 1, 7, 8, 11, 12, 14, 27, 31, 127]) {
      const control = String.fromCharCode(code)
      for (const bad of [
        'a' + control + 'b@other.com',
        'ap@oth' + control + 'er.com',
        'ap@other.com' + control + 'x',
      ]) {
        expect(isPlausibleEmail(bad), 'code ' + code).toBe(false)
      }
    }
  })

  it('keeps accepting everything else an address may hold', () => {
    for (const good of [
      "o'brien@other.com",
      'first+tag@other.com',
      'a_b-c.d@sub-domain.other.co',
      'ap@xn--bcher-kva.example',
      'UPPER@OTHER.COM',
      'a!b#c$d%e&f*g/h=i?j^k{l|m}n~o@other.com',
    ]) {
      expect(isPlausibleEmail(good), good).toBe(true)
    }
  })

  it('refuses what cannot be one single address', () => {
    for (const bad of [
      '',
      '   ',
      'plain',
      'no-at.com',
      '@other.com',
      'ap@',
      'ap@other',
      'two words@other.com',
      'a@b.com, c@d.com',
      'a@b.com c@d.com',
      'ap@other.com\nbcc: x@y.com',
      `${'a'.repeat(320)}@other.com`,
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isPlausibleEmail(bad)).toBe(false)
    }
  })
})

describe('cleanExtraRecipients', () => {
  it('treats absent as none', () => {
    expect(cleanExtraRecipients(undefined)).toEqual({ extra: [], reason: null })
    expect(cleanExtraRecipients(null)).toEqual({ extra: [], reason: null })
    expect(cleanExtraRecipients([])).toEqual({ extra: [], reason: null })
  })

  it('trims each address and keeps the spelling it was typed in', () => {
    expect(cleanExtraRecipients(['  Ap@Other.com ']).extra).toEqual(['Ap@Other.com'])
  })

  it('collapses a repeat, compared case-insensitively, first spelling wins', () => {
    const result = cleanExtraRecipients(['ap@other.com', 'AP@OTHER.COM', ' ap@other.com'])

    expect(result).toEqual({ extra: ['ap@other.com'], reason: null })
  })

  it('refuses anything that is not a list', () => {
    for (const bad of ['ap@other.com', { 0: 'ap@other.com' }, 7, true]) {
      expect(cleanExtraRecipients(bad)).toEqual({
        extra: [],
        reason: EXTRA_RECIPIENT_REFUSALS.shape,
      })
    }
  })

  it('refuses the whole list when one entry is not a valid address', () => {
    expect(cleanExtraRecipients(['ap@other.com', 'nope'])).toEqual({
      extra: [],
      reason: EXTRA_RECIPIENT_REFUSALS.invalid,
    })
    expect(cleanExtraRecipients(['ap@other.com', 42]).reason).toBe(EXTRA_RECIPIENT_REFUSALS.invalid)
  })

  it('allows three and refuses a fourth', () => {
    expect(MAX_EXTRA_INVOICE_RECIPIENTS).toBe(3)
    const three = ['a@x.com', 'b@x.com', 'c@x.com']

    expect(cleanExtraRecipients(three).extra).toEqual(three)
    expect(cleanExtraRecipients([...three, 'd@x.com'])).toEqual({
      extra: [],
      reason: EXTRA_RECIPIENT_REFUSALS.tooMany,
    })
    // Repeats do not count toward the cap: they are one address.
    expect(cleanExtraRecipients([...three, 'A@X.com']).extra).toEqual(three)
  })

  it('says each refusal as a sentence that ends in "nothing was sent"', () => {
    for (const sentence of Object.values(EXTRA_RECIPIENT_REFUSALS)) {
      expect(sentence).toMatch(/nothing was sent\.$/)
    }
  })
})

describe('resolveSendRecipients', () => {
  it('sends to everyone on file when nothing is chosen and nothing is added', () => {
    expect(resolveSendRecipients({ allowed })).toEqual({ ok: true, to: allowed, oneTime: [] })
  })

  it('adds the extras after the chosen on-file addresses, and names them one-time', () => {
    const result = resolveSendRecipients({
      allowed,
      to: ['charlean@cooper.com'],
      extra: ['ap@other.com', 'boss@other.com'],
    })

    expect(result).toEqual({
      ok: true,
      to: ['charlean@cooper.com', 'ap@other.com', 'boss@other.com'],
      oneTime: ['ap@other.com', 'boss@other.com'],
    })
  })

  it('does not email an extra twice: de-duplicated against the chosen addresses', () => {
    const result = resolveSendRecipients({
      allowed,
      to: ['anthony@cooper.com'],
      extra: ['ANTHONY@cooper.com', 'ap@other.com'],
    })

    expect(result).toEqual({
      ok: true,
      to: ['anthony@cooper.com', 'ap@other.com'],
      oneTime: ['ap@other.com'],
    })
  })

  it('still filters `to`: a forged address in `to` is dropped, an extra is the only way in', () => {
    const result = resolveSendRecipients({
      allowed,
      to: ['attacker@evil.com', 'anthony@cooper.com'],
      extra: ['ap@other.com'],
    })

    expect(result).toMatchObject({ ok: true, to: ['anthony@cooper.com', 'ap@other.com'] })
    expect(result.ok && result.to).not.toContain('attacker@evil.com')
  })

  it('requires at least one on-file address when the client has some', () => {
    // Everything on file unticked, one extra added: the invoice would not reach
    // the client at all.
    const result = resolveSendRecipients({ allowed, to: [], extra: ['ap@other.com'] })

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'invoice_no_chosen_recipient',
      message: NO_CHOSEN_RECIPIENT_REASON,
    })
    // `to` naming only addresses that are not the client's is the same refusal.
    expect(
      resolveSendRecipients({ allowed, to: ['x@evil.com'], extra: ['ap@other.com'] }),
    ).toMatchObject({ ok: false, status: 400, error: 'invoice_no_chosen_recipient' })
  })

  it('lets the extras stand alone when the client has NO address on file', () => {
    const result = resolveSendRecipients({ allowed: [], extra: ['ap@other.com'] })

    expect(result).toEqual({ ok: true, to: ['ap@other.com'], oneTime: ['ap@other.com'] })
    // The picker sends an empty `to` for such a client.
    expect(resolveSendRecipients({ allowed: [], to: [], extra: ['ap@other.com'] })).toEqual({
      ok: true,
      to: ['ap@other.com'],
      oneTime: ['ap@other.com'],
    })
  })

  it('refuses, rather than ignores, a non-empty `to` for a client the server has nothing on file for', () => {
    // The browser chose from a list that no longer exists (the contact lost its
    // address in another tab). Sending to the extras alone would be a send she
    // did not ask for.
    for (const extra of [undefined, [], ['ap@other.com']]) {
      for (const to of [['x@evil.com'], ['anthony@cooper.com', 'charlean@cooper.com']]) {
        expect(resolveSendRecipients({ allowed: [], to, extra })).toEqual({
          ok: false,
          status: 409,
          error: 'recipients_changed',
          message: RECIPIENTS_CHANGED_REASON,
        })
      }
    }
    expect(RECIPIENTS_CHANGED_REASON).toBe(
      'The addresses on file for this client have changed. Reload and choose again.',
    )
  })

  it('still reports a bad extra first, even for such a client', () => {
    expect(resolveSendRecipients({ allowed: [], to: ['x@evil.com'], extra: ['nope'] })).toMatchObject({
      status: 400,
      error: 'invoice_bad_extra_recipient',
    })
  })

  it('treats an extra that is an on-file address as that address, not as "this send only"', () => {
    // anthony is on file and was left unticked; she typed his address anyway.
    const result = resolveSendRecipients({
      allowed,
      to: ['charlean@cooper.com'],
      extra: ['ANTHONY@Cooper.com', 'ap@other.com'],
    })

    expect(result).toEqual({
      ok: true,
      // The stored spelling, in the order she gave it, after the chosen ones.
      to: ['charlean@cooper.com', 'anthony@cooper.com', 'ap@other.com'],
      oneTime: ['ap@other.com'],
    })
    // Only on-file addresses typed as extras: nothing is one-time.
    expect(
      resolveSendRecipients({ allowed, to: ['charlean@cooper.com'], extra: ['anthony@cooper.com'] }),
    ).toEqual({
      ok: true,
      to: ['charlean@cooper.com', 'anthony@cooper.com'],
      oneTime: [],
    })
  })

  it('keeps the 409 for a client with no address and nothing added', () => {
    expect(resolveSendRecipients({ allowed: [] })).toEqual({
      ok: false,
      status: 409,
      error: 'invoice_no_recipient',
      message: NO_INVOICE_RECIPIENT_REASON,
    })
    expect(resolveSendRecipients({ allowed: [], extra: [] })).toMatchObject({
      ok: false,
      status: 409,
    })
  })

  it('refuses invalid extras with a 400 before anything else is decided', () => {
    for (const extra of [['nope'], ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'], 'ap@other.com']) {
      for (const list of [allowed, []]) {
        const result = resolveSendRecipients({ allowed: list, to: list, extra })
        expect(result).toMatchObject({
          ok: false,
          status: 400,
          error: 'invoice_bad_extra_recipient',
        })
      }
    }
  })
})
