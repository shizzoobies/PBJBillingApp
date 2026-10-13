import { describe, expect, it } from 'vitest'

import {
  SERVICE_CATEGORY_GROUP_MAX,
  cleanServiceCategoryGroup,
  serviceCategoryGroupRefusal,
} from './service-category-group.js'

/**
 * featreq-54bf39b6: a Board column's optional group name. The store cleans it
 * (both backends share this function); the routes refuse what the store would
 * otherwise have to silently cut or ignore.
 */
describe('cleanServiceCategoryGroup', () => {
  it('trims, and clears an empty string or null to null', () => {
    expect(cleanServiceCategoryGroup('  Year-End  ')).toBe('Year-End')
    expect(cleanServiceCategoryGroup('')).toBeNull()
    expect(cleanServiceCategoryGroup('   ')).toBeNull()
    expect(cleanServiceCategoryGroup(null)).toBeNull()
  })

  it('reads anything that is not a string or null as "leave it" (undefined)', () => {
    expect(cleanServiceCategoryGroup(undefined)).toBeUndefined()
    expect(cleanServiceCategoryGroup(42)).toBeUndefined()
    expect(cleanServiceCategoryGroup({ name: 'x' })).toBeUndefined()
  })

  it('cuts to the maximum length', () => {
    expect(SERVICE_CATEGORY_GROUP_MAX).toBe(80)
    expect(cleanServiceCategoryGroup('G'.repeat(81))).toBe('G'.repeat(80))
  })
})

describe('serviceCategoryGroupRefusal', () => {
  it('accepts an absent key, null, an empty string and a name up to 80 characters', () => {
    expect(serviceCategoryGroupRefusal(undefined)).toBeNull()
    expect(serviceCategoryGroupRefusal(null)).toBeNull()
    expect(serviceCategoryGroupRefusal('')).toBeNull()
    expect(serviceCategoryGroupRefusal('G'.repeat(80))).toBeNull()
    // Measured after trimming, the way it is stored.
    expect(serviceCategoryGroupRefusal(`  ${'G'.repeat(80)}  `)).toBeNull()
  })

  it('refuses a name longer than 80 characters, and anything that is not text', () => {
    expect(serviceCategoryGroupRefusal('G'.repeat(81))).toMatch(/80 characters/)
    expect(serviceCategoryGroupRefusal(7)).toMatch(/text/)
    expect(serviceCategoryGroupRefusal(['Year-End'])).toMatch(/text/)
  })
})
