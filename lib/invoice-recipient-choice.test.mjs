import { describe, expect, it } from 'vitest'

import {
  NO_CHOSEN_RECIPIENT_REASON,
  chooseInvoiceRecipients,
  resolveInvoiceRecipients,
} from './invoice-recipients.js'

/**
 * The trust boundary on `POST /api/invoices/:id/send`.
 *
 * The send dialog lets the owner untick addresses, so the request body may now
 * carry a `to` list. That list is a FILTER over the addresses this invoice's
 * own client resolves to — never a list of addresses to email. These pin that,
 * because the failure mode is not a wrong recipient, it is an authenticated
 * owner session working as an open relay.
 */

const allowed = ['anthony@coopercooperpa.com', 'acooper@gmail.com', 'billing@acme.com']

describe('chooseInvoiceRecipients', () => {
  it('sends to everyone when no list is submitted', () => {
    expect(chooseInvoiceRecipients(allowed, undefined).to).toEqual(allowed)
    expect(chooseInvoiceRecipients(allowed, null).to).toEqual(allowed)
  })

  it('keeps only what she ticked', () => {
    const result = chooseInvoiceRecipients(allowed, ['acooper@gmail.com'])
    expect(result.to).toEqual(['acooper@gmail.com'])
    expect(result.reason).toBeNull()
  })

  // Casing is a spelling difference, not a different mailbox.
  it('matches case-insensitively and sends the stored spelling', () => {
    const result = chooseInvoiceRecipients(allowed, ['  ACOOPER@Gmail.com '])
    expect(result.to).toEqual(['acooper@gmail.com'])
  })

  /** The open-relay case. Nothing outside the client's own set may be added. */
  it('refuses an address this client does not have', () => {
    const result = chooseInvoiceRecipients(allowed, ['attacker@evil.com'])
    expect(result.to).toEqual([])
    expect(result.reason).toBe(NO_CHOSEN_RECIPIENT_REASON)
  })

  it('drops a forged address smuggled in beside a real one', () => {
    const result = chooseInvoiceRecipients(allowed, [
      'attacker@evil.com',
      'billing@acme.com',
    ])
    expect(result.to).toEqual(['billing@acme.com'])
  })

  it('never sends the same person two copies', () => {
    const result = chooseInvoiceRecipients(allowed, [
      'billing@acme.com',
      'BILLING@acme.com',
    ])
    expect(result.to).toEqual(['billing@acme.com'])
  })

  it('answers with a reason when she unticks everything', () => {
    const result = chooseInvoiceRecipients(allowed, [])
    expect(result.to).toEqual([])
    expect(result.reason).toBe(NO_CHOSEN_RECIPIENT_REASON)
  })

  // Coercion cannot WIDEN the set — whatever a value stringifies to still has
  // to be one of the client's own addresses — so junk simply falls out.
  it('is not fooled by non-strings in the list', () => {
    const result = chooseInvoiceRecipients(allowed, [null, 42, {}, ['attacker@evil.com']])
    expect(result.to).toEqual([])
  })

  /**
   * End to end with the resolver: an address belonging to ANOTHER client is
   * still refused, which is the scoping rule the whole feature rests on.
   */
  it('cannot be used to reach another client’s contact', () => {
    const resolved = resolveInvoiceRecipients({
      client: { id: 'c1', contactIds: ['k1'], email: '' },
      contacts: [
        { id: 'k1', name: 'Ann', email: 'ann@acme.com' },
        { id: 'k2', name: 'Other', email: 'someone@othercompany.com' },
      ],
    })
    const result = chooseInvoiceRecipients(resolved.to, ['someone@othercompany.com'])
    expect(result.to).toEqual([])
  })
})
