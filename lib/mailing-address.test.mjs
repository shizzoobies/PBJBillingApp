import { describe, expect, it } from 'vitest'
import { mailingAddressLines } from './mailing-address.js'

describe('mailingAddressLines', () => {
  it('is street, second line, then one city line', () => {
    expect(
      mailingAddressLines({
        addressLine1: '12 Main St',
        addressLine2: 'Suite 4',
        city: 'Nashville',
        state: 'TN',
        postalCode: '37201',
      }),
    ).toEqual(['12 Main St', 'Suite 4', 'Nashville, TN 37201'])
  })

  it('drops blank parts and trims what is left', () => {
    expect(
      mailingAddressLines({
        addressLine1: '  12 Main St ',
        addressLine2: '   ',
        city: 'Nashville',
        state: null,
        postalCode: ' 37201 ',
      }),
    ).toEqual(['12 Main St', 'Nashville 37201'])
  })

  // The usual US form: a comma between city and state, a single space before the
  // postal code, and whatever is missing simply drops out.
  it('forms the city line the way a US address is written', () => {
    const line = (parts) => mailingAddressLines(parts)[0]
    expect(line({ city: 'Austin', state: 'TX', postalCode: '78701' })).toBe('Austin, TX 78701')
    expect(line({ city: 'Austin', postalCode: '78701' })).toBe('Austin 78701')
    expect(line({ state: 'TX', postalCode: '78701' })).toBe('TX 78701')
    expect(line({ postalCode: '78701' })).toBe('78701')
    expect(line({ city: 'Austin' })).toBe('Austin')
    expect(line({ city: 'Austin', state: 'TX' })).toBe('Austin, TX')
    expect(line({ state: 'TX' })).toBe('TX')
  })

  it('is empty when there is no address', () => {
    expect(mailingAddressLines(null)).toEqual([])
    expect(mailingAddressLines(undefined)).toEqual([])
    expect(mailingAddressLines({ name: 'Acme' })).toEqual([])
    expect(mailingAddressLines({ addressLine1: '', city: '  ' })).toEqual([])
  })
})
