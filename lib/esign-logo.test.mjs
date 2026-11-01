import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import { ESIGN_LOGO_PATH, ESIGN_LOGO_WIDTH, esignBranding, esignLogoPath, firmLogoHash, firmLogoPng } from './esign-logo.js'

/**
 * The firm logo as a public PNG for eSignatures.io's custom_branding.logo_url: read from the stored
 * firm settings (the data-URL the owner uploaded), converted with sharp, addressed by a content hash.
 */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="92"><rect width="300" height="92" fill="#e5487b"/></svg>'
const svgLogo = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`
const svgLogoPlain = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`
const quiet = { log: { warn: vi.fn() } }

describe('firmLogoHash', () => {
  it('is a 32-hex content hash of the stored logo, the same for the same logo and different for another', () => {
    const hash = firmLogoHash({ logoUrl: svgLogo })
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    expect(firmLogoHash({ logoUrl: ` ${svgLogo} ` })).toBe(hash)
    expect(firmLogoHash({ logoUrl: svgLogoPlain })).not.toBe(hash)
    expect(ESIGN_LOGO_PATH.exec(esignLogoPath(hash))?.[1]).toBe(hash)
  })

  it('is null for no logo, a remote URL, or a kind it cannot convert', () => {
    for (const logoUrl of ['', null, 'https://cdn.example.invalid/logo.png', 'data:text/html;base64,PGI+', 'data:image/png;base64,']) {
      expect(firmLogoHash({ logoUrl }), String(logoUrl)).toBeNull()
    }
    expect(firmLogoHash(null)).toBeNull()
  })

  it('the route pattern takes only 32 lowercase hex characters and .png', () => {
    expect(ESIGN_LOGO_PATH.test(`/esign-logo/${'a'.repeat(32)}.png`)).toBe(true)
    for (const path of [`/esign-logo/${'a'.repeat(31)}.png`, `/esign-logo/${'g'.repeat(32)}.png`, `/esign-logo/${'a'.repeat(32)}.svg`, `/esign-logo/../${'a'.repeat(32)}.png`]) {
      expect(ESIGN_LOGO_PATH.test(path), path).toBe(false)
    }
  })
})

describe('firmLogoPng', () => {
  it('converts an SVG logo (base64 or URL-encoded) to a PNG 400 px wide', async () => {
    for (const logoUrl of [svgLogo, svgLogoPlain]) {
      const logo = await firmLogoPng({ logoUrl }, quiet)
      expect(logo.hash).toBe(firmLogoHash({ logoUrl }))
      const meta = await sharp(logo.png).metadata()
      expect(meta.format).toBe('png')
      expect(meta.width).toBe(ESIGN_LOGO_WIDTH)
    }
  })

  it('converts a PNG or JPEG upload too', async () => {
    const jpeg = await sharp({ create: { width: 120, height: 40, channels: 3, background: '#336699' } }).jpeg().toBuffer()
    const logo = await firmLogoPng({ logoUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` }, quiet)
    const meta = await sharp(logo.png).metadata()
    expect([meta.format, meta.width]).toEqual(['png', ESIGN_LOGO_WIDTH])
  })

  it('a logo that will not convert is no logo (logged, never thrown)', async () => {
    const log = { warn: vi.fn() }
    expect(await firmLogoPng({ logoUrl: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` }, { log })).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(await firmLogoPng({ logoUrl: '' }, { log })).toBeNull()
  })
})

describe('esignBranding', () => {
  it('the firm name always; the logo as an ABSOLUTE https address under the public URL', async () => {
    const branding = await esignBranding({ name: 'PB&J Strategic Accounting', logoUrl: svgLogo }, 'https://app.example.invalid/', quiet)
    expect(branding).toEqual({
      companyName: 'PB&J Strategic Accounting',
      logoUrl: `https://app.example.invalid/esign-logo/${firmLogoHash({ logoUrl: svgLogo })}.png`,
    })
  })

  it('no logo, or a public URL that is not https: no logo address', async () => {
    expect(await esignBranding({ name: 'Firm' }, 'https://app.example.invalid', quiet)).toEqual({ companyName: 'Firm', logoUrl: null })
    expect(await esignBranding({ logoUrl: svgLogo }, 'http://localhost:4173', quiet)).toEqual({ companyName: 'PB&J Strategic Accounting', logoUrl: null })
    expect(await esignBranding({ logoUrl: svgLogo }, '', quiet)).toEqual({ companyName: 'PB&J Strategic Accounting', logoUrl: null })
  })
})
