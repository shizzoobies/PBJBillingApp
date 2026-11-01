import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

// Every sharp call is counted (and passed on), so a test can show nothing was converted.
const sharpCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('sharp', async (importOriginal) => {
  const actual = (await importOriginal()).default
  const counted = (...args) => {
    sharpCalls.count += 1
    return actual(...args)
  }
  return { default: Object.assign(counted, actual) }
})

import {
  ESIGN_LOGO_FAILURE_TTL_MS,
  ESIGN_LOGO_PATH,
  ESIGN_LOGO_WIDTH,
  esignBranding,
  esignLogoPath,
  esignLogoResponse,
  firmLogoHash,
  firmLogoPng,
  svgDensity,
} from './esign-logo.js'

/**
 * The firm logo as a public PNG for eSignatures.io's custom_branding.logo_url: read from the stored
 * firm settings (the data-URL the owner uploaded), converted with sharp, addressed by a content hash.
 */
// A full-size fill plus a 100 x 30 mark, so an SVG sized only by its content still has some.
const svgOf = (attributes, fill = '#e5487b') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect x="0" y="0" width="100%" height="100%" fill="${fill}"/><rect width="100" height="30" fill="#222"/></svg>`
const dataUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const SVG = svgOf('width="300" height="92"')
const svgLogo = dataUrl(SVG)
const svgLogoPlain = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`
const quiet = () => ({ log: { warn: vi.fn() } })

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

describe('svgDensity', () => {
  it('draws an SVG about 800 px wide from its width, else its viewBox; 72 when neither reads', () => {
    expect(svgDensity(svgOf('width="300" height="92"'))).toBeCloseTo(192)
    expect(svgDensity(svgOf('width="3000px" height="1000px"'))).toBeCloseTo(19.2)
    expect(svgDensity(svgOf('viewBox="0 0 1600 400"'))).toBeCloseTo(36)
    expect(svgDensity(svgOf('width="100%" viewBox="0,0,400,100"'))).toBeCloseTo(144)
    expect(svgDensity(svgOf(''))).toBe(72)
    // An absolute width scales with the density SQUARED (sharp and librsvg both apply it): the square root.
    expect(svgDensity(svgOf('width="2in"'))).toBeCloseTo(Math.sqrt(72 * 800 / 2))
    expect(svgDensity(svgOf('width="50mm" viewBox="0 0 50 15"'))).toBeCloseTo(Math.sqrt((72 * 800 * 25.4) / 50))
    expect(svgDensity(svgOf('width="200pt"'))).toBeCloseTo(Math.sqrt((72 * 800 * 72) / 200))
    // Clamped: a tiny or a huge drawing still gets a sane density.
    expect(svgDensity(svgOf('width="1" height="1"'))).toBe(2400)
    expect(svgDensity(svgOf('width="1000000" height="1"'))).toBe(4)
  })
})

describe('firmLogoPng', () => {
  it.each([
    ['300 x 92', 'width="300" height="92"', '#e5487b'],
    ['1500 x 500', 'width="1500" height="500"', '#e5487c'],
    ['3000 x 1000', 'width="3000" height="1000"', '#e5487d'],
    ['viewBox only', 'viewBox="0 0 2400 800"', '#e5487e'],
    ['50mm wide', 'width="50mm" viewBox="0 0 50 15"', '#e5487f'],
    ['200pt wide', 'width="200pt" viewBox="0 0 2000 600"', '#e54880'],
    ['2in wide, no viewBox (sized by its content: the density 300 retry)', 'width="2in"', '#e54881'],
  ])('converts an SVG of %s to a PNG 400 px wide', async (_, attributes, fill) => {
    const logoUrl = dataUrl(svgOf(attributes, fill))
    const logo = await firmLogoPng({ logoUrl }, quiet())
    expect(logo?.hash).toBe(firmLogoHash({ logoUrl }))
    const meta = await sharp(logo.png).metadata()
    expect([meta.format, meta.width]).toEqual(['png', ESIGN_LOGO_WIDTH])
  })

  it('reads a URL-encoded SVG too', async () => {
    const logo = await firmLogoPng({ logoUrl: svgLogoPlain }, quiet())
    expect((await sharp(logo.png).metadata()).width).toBe(ESIGN_LOGO_WIDTH)
  })

  it('a raster upload is scaled down to 400 px, never stretched up', async () => {
    const small = await sharp({ create: { width: 120, height: 40, channels: 3, background: '#336699' } }).jpeg().toBuffer()
    const smallLogo = await firmLogoPng({ logoUrl: `data:image/jpeg;base64,${small.toString('base64')}` }, quiet())
    expect(await sharp(smallLogo.png).metadata()).toMatchObject({ format: 'png', width: 120 })
    const large = await sharp({ create: { width: 1600, height: 400, channels: 4, background: '#336699ff' } }).png().toBuffer()
    const largeLogo = await firmLogoPng({ logoUrl: `data:image/png;base64,${large.toString('base64')}` }, quiet())
    expect(await sharp(largeLogo.png).metadata()).toMatchObject({ format: 'png', width: ESIGN_LOGO_WIDTH })
  })

  it('a logo that will not convert is no logo - logged once, not tried again for 10 minutes, then tried again', async () => {
    let clock = 1_000_000
    const options = { ...quiet(), now: () => clock }
    const broken = { logoUrl: `data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}` }
    expect(await firmLogoPng(broken, options)).toBeNull()
    const calls = sharpCalls.count
    clock += ESIGN_LOGO_FAILURE_TTL_MS - 1
    expect(await firmLogoPng(broken, options)).toBeNull()
    expect(sharpCalls.count).toBe(calls)
    expect(options.log.warn).toHaveBeenCalledTimes(1)
    clock += 2
    expect(await firmLogoPng(broken, options)).toBeNull()
    expect(sharpCalls.count).toBeGreaterThan(calls)
    expect(options.log.warn).toHaveBeenCalledTimes(2)
    expect(await firmLogoPng({ logoUrl: '' }, options)).toBeNull()
  })

  it('a converted logo stays cached by its hash', async () => {
    const logoUrl = dataUrl(svgOf('width="300" height="92"', '#0a0b0c'))
    const first = await firmLogoPng({ logoUrl }, quiet())
    const calls = sharpCalls.count
    expect(await firmLogoPng({ logoUrl }, { ...quiet(), now: () => Date.now() + 24 * 60 * 60 * 1000 })).toBe(first)
    expect(sharpCalls.count).toBe(calls)
  })
})

describe('esignBranding (the one logo decision)', () => {
  it('the firm name always; the logo as an ABSOLUTE https address under the public URL, and its relative path', async () => {
    const branding = await esignBranding({ name: 'PB&J Strategic Accounting', logoUrl: svgLogo }, 'https://app.example.invalid/', quiet())
    const path = `/esign-logo/${firmLogoHash({ logoUrl: svgLogo })}.png`
    expect(branding).toEqual({ companyName: 'PB&J Strategic Accounting', logoUrl: `https://app.example.invalid${path}`, logoPath: path })
  })

  it('no logo, or a public URL that is not https: no logo', async () => {
    const none = { logoUrl: null, logoPath: null }
    expect(await esignBranding({ name: 'Firm' }, 'https://app.example.invalid', quiet())).toEqual({ companyName: 'Firm', ...none })
    expect(await esignBranding({ logoUrl: svgLogo }, 'http://localhost:4173', quiet())).toEqual({ companyName: 'PB&J Strategic Accounting', ...none })
    expect(await esignBranding({ logoUrl: svgLogo }, '', quiet())).toEqual({ companyName: 'PB&J Strategic Accounting', ...none })
  })
})

describe('firmLogoHash remembers the last logo', () => {
  it('a repeated request for the same stored logo does not decode it again', () => {
    const logoUrl = dataUrl(svgOf('width="300" height="92"', '#0d0e0f'))
    const hash = firmLogoHash({ logoUrl })
    const decode = vi.spyOn(Buffer, 'from')
    expect(firmLogoHash({ logoUrl })).toBe(hash)
    expect(decode).not.toHaveBeenCalled()
    decode.mockRestore()
  })
})

describe('esignLogoResponse (the public route)', () => {
  const firmSettings = { logoUrl: svgLogo }
  const hash = firmLogoHash(firmSettings)

  it('answers the current logo as a cache-friendly PNG; HEAD has the headers and no body', async () => {
    const got = await esignLogoResponse({ hash, method: 'GET', firmSettings }, quiet())
    expect(got.status).toBe(200)
    expect(got.headers).toMatchObject({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
    expect(got.headers['Content-Length']).toBe(got.body.length)
    const head = await esignLogoResponse({ hash, method: 'HEAD', firmSettings }, quiet())
    expect(head.status).toBe(200)
    expect(head.headers['Content-Length']).toBe(got.body.length)
    expect(head.body).toBeUndefined()
  })

  it('a hash that is not the current logo\'s is 404 BEFORE anything is converted', async () => {
    const before = sharpCalls.count
    const got = await esignLogoResponse({ hash: 'f'.repeat(32), method: 'GET', firmSettings: { logoUrl: dataUrl(svgOf('width="10" height="10"', '#123456')) } }, quiet())
    expect(got).toMatchObject({ status: 404, body: 'Not found' })
    expect(sharpCalls.count).toBe(before)
    expect((await esignLogoResponse({ hash, method: 'GET', firmSettings: null }, quiet())).status).toBe(404)
    expect((await esignLogoResponse({ hash: '', method: 'GET', firmSettings }, quiet())).status).toBe(404)
  })

  it('a logo that will not convert is 404', async () => {
    const broken = { logoUrl: `data:image/png;base64,${Buffer.from('still not a png').toString('base64')}` }
    const got = await esignLogoResponse({ hash: firmLogoHash(broken), method: 'GET', firmSettings: broken }, quiet())
    expect(got.status).toBe(404)
  })
})
