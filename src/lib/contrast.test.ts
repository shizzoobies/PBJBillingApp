import { describe, expect, it } from 'vitest'
import { contrastRatio, legibleSidebarText } from './utils'

describe('contrastRatio', () => {
  it('scores black on white as maximum contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
  })

  it('scores a color against itself as 1', () => {
    expect(contrastRatio('#3c2044', '#3c2044')).toBeCloseTo(1, 5)
  })

  it('supports shorthand hex', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 0)
  })

  it('returns null for non-hex values', () => {
    expect(contrastRatio('rebeccapurple', '#ffffff')).toBeNull()
    expect(contrastRatio('#ffffff', 'rgb(0, 0, 0)')).toBeNull()
    expect(contrastRatio('', '#ffffff')).toBeNull()
  })
})

describe('legibleSidebarText', () => {
  it('keeps a readable configured color', () => {
    // White on dark plum — high contrast, honored as-is.
    expect(legibleSidebarText('#ffffff', '#3c2044')).toBe('#ffffff')
    // Dark navy on the pale-blue default brand — the designed pairing.
    expect(legibleSidebarText('#13344a', '#e8f4fb')).toBe('#13344a')
  })

  it('replaces an illegible color with a light tone on dark backgrounds', () => {
    // The bug this guards against: navy default text on a stored plum
    // sidebar rendered the whole nav invisible.
    expect(legibleSidebarText('#13344a', '#3c2044')).toBe('#fffaf3')
  })

  it('replaces an illegible color with a dark tone on light backgrounds', () => {
    expect(legibleSidebarText('#fffaf3', '#e8f4fb')).toBe('#25131e')
  })

  it('passes through colors it cannot score', () => {
    expect(legibleSidebarText('rebeccapurple', '#3c2044')).toBe('rebeccapurple')
    expect(legibleSidebarText('#ffffff', 'not-a-color')).toBe('#ffffff')
  })
})
