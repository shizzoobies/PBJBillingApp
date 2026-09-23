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
})
