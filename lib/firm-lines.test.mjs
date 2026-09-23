import { describe, expect, it } from 'vitest'
import { firmDetailLines } from './firm-lines.js'

describe('firmDetailLines', () => {
  it('is address, city line, phone, email — in that order, blanks dropped', () => {
    expect(
      firmDetailLines({
        tagline: 'Never printed',
        addressLine1: '12 Main St',
        addressLine2: '',
        city: 'Nashville',
        state: 'TN',
        postalCode: '37201',
        phone: '615-555-0100',
        email: 'hello@pbjsa.com',
      }),
    ).toEqual(['12 Main St', 'Nashville, TN, 37201', '615-555-0100', 'hello@pbjsa.com'])
  })

  it('is empty for an unconfigured firm', () => {
    expect(firmDetailLines(null)).toEqual([])
    expect(firmDetailLines({ name: 'PB&J' })).toEqual([])
  })

  it('drops a whitespace-only field like a blank one (review M8)', () => {
    expect(
      firmDetailLines({
        addressLine1: '   ',
        addressLine2: '\t',
        city: '',
        state: '',
        postalCode: '',
        phone: '  ',
        email: 'hello@pbjsa.com',
      }),
    ).toEqual(['hello@pbjsa.com'])
  })

  it('joins state and ZIP alone when there is no city (review M8)', () => {
    expect(firmDetailLines({ state: 'TN', postalCode: '37201' })).toEqual(['TN, 37201'])
  })

  it('accepts a numeric postalCode (review M8)', () => {
    expect(firmDetailLines({ city: 'Nashville', state: 'TN', postalCode: 37201 })).toEqual([
      'Nashville, TN, 37201',
    ])
  })

  it('keeps the email when there is no phone (review M8)', () => {
    expect(firmDetailLines({ addressLine1: '12 Main St', email: 'hello@pbjsa.com' })).toEqual([
      '12 Main St',
      'hello@pbjsa.com',
    ])
  })
})
