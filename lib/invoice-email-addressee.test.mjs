import { describe, expect, it } from 'vitest'

import { MASTER_RECIPIENT_UNSET, invoiceEmailAddressee } from './invoice-recipients.js'

/**
 * WHOSE contacts an invoice (or an engagement letter) is addressed to - moved
 * out of server.js so the Letters code and the server share ONE rule. The
 * behavior is unchanged; src/__tests__/klc-billing-routes.test.ts still pins its
 * source.
 */
const master = { id: 'master-1', name: 'KLC Holdings', isBillingMaster: true, invoiceRecipientClientId: 'sub-2' }
const subs = [
  { id: 'sub-1', name: 'KLC North', billToClientId: 'master-1', contactIds: ['c1'] },
  { id: 'sub-2', name: 'KLC South', billToClientId: 'master-1', contactIds: ['c2'], city: 'Austin' },
]

describe('invoiceEmailAddressee', () => {
  it('answers an ordinary client with itself, untouched', () => {
    const client = { id: 'c-9', name: 'Acme' }
    const result = invoiceEmailAddressee(client, [client, ...subs])
    expect(result.addressee).toBe(client)
    expect(result.refusal).toBeNull()
  })

  it('answers a missing client with null and no refusal', () => {
    expect(invoiceEmailAddressee(undefined, [])).toEqual({ addressee: null, refusal: null })
  })

  it('resolves a master to the one sub it names, under the master’s name', () => {
    const { addressee, refusal } = invoiceEmailAddressee(master, [master, ...subs])
    expect(refusal).toBeNull()
    expect(addressee).toEqual({ ...subs[1], name: 'KLC Holdings' })
    expect(addressee.contactIds).toEqual(['c2'])
  })

  it('refuses a master with no receiving company set, never falling back to the subs', () => {
    const result = invoiceEmailAddressee({ ...master, invoiceRecipientClientId: '' }, [master, ...subs])
    expect(result).toEqual({ addressee: null, refusal: MASTER_RECIPIENT_UNSET })
    expect(MASTER_RECIPIENT_UNSET.error).toBe('master_recipient_unset')
  })

  it('refuses when the named company no longer bills through this master', () => {
    const moved = [subs[0], { ...subs[1], billToClientId: 'master-other' }]
    expect(invoiceEmailAddressee(master, moved).refusal).toBe(MASTER_RECIPIENT_UNSET)
    expect(invoiceEmailAddressee(master, null).refusal).toBe(MASTER_RECIPIENT_UNSET)
  })
})
