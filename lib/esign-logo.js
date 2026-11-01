/**
 * The firm logo as a PUBLIC PNG for eSignatures.io (e-sign honest preview, 2026-11-01).
 *
 * eSignatures.io draws a logo at the top of the contract when `custom_branding.logo_url` is a public
 * HTTPS address of a PNG (about 400 px wide). The firm's logo is not a file anywhere public: it is the
 * data-URL the owner uploaded in Settings (`firm_settings.logo_url`, read by `getFirmSettings()` on both
 * store backends - the same source the letterhead and invoice PDFs draw from, lib/invoice-pdf.js
 * `decodeSvgLogo`). So the app serves it itself:
 *
 *  - `GET /esign-logo/<hash>.png` (server.js -> `esignLogoResponse`; public, no session): `<hash>` is the
 *    first 32 hex characters of the SHA-256 of the stored logo data-URL. The hash is compared FIRST, before
 *    anything is converted (the current logo's hash is remembered, so a request does not even decode it
 *    again): only the CURRENT logo's hash answers, so the address cannot be enumerated or confused with an
 *    older logo (a replaced logo's address answers 404). Cached a year.
 *  - SVG, PNG, JPEG, WebP and GIF data-URLs are converted with sharp (already a dependency; its librsvg
 *    draws SVG) to a PNG at most 400 px wide (a smaller raster is never stretched). An SVG is rasterized at a
 *    density chosen from its own width - px, or an absolute unit (in, cm, mm, pt, pc) - else its viewBox, so
 *    it is drawn about 800 px wide whatever its size; if that fails or comes out under 400 px it is tried
 *    again at density 300, then 72. A remote URL, anything else, or a logo that will not convert is "no
 *    logo": the send carries no logo_url.
 *  - `esignBranding` is the ONE decision whether a logo goes with a contract; the preview and the send both
 *    ask it, so they always agree.
 *
 * The converted PNG is kept in memory per hash (a handful of entries); a failure is remembered for 10
 * minutes, so a logo that will not convert is not tried again on every request, preview and send.
 */

import { createHash } from 'node:crypto'

import sharp from 'sharp'

/** The path prefix of the public logo route. */
export const ESIGN_LOGO_PATH_PREFIX = '/esign-logo/'
/** The route's path pattern: the hash, then `.png`. */
export const ESIGN_LOGO_PATH = /^\/esign-logo\/([0-9a-f]{32})\.png$/
/** eSignatures.io's suggested logo width: the PNG is at most this wide. */
export const ESIGN_LOGO_WIDTH = 400
/** An SVG is drawn about this wide before it is scaled down to the PNG. */
const SVG_DRAW_WIDTH = 800
/** The density range an SVG is drawn at (72 = one SVG unit per pixel). */
const MIN_DENSITY = 4
const MAX_DENSITY = 2400
/** The largest stored logo converted (a data-URL's decoded bytes). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const DATA_URL = /^data:image\/(svg\+xml|png|jpeg|jpg|webp|gif)(;[^,]*)?,/i

const cache = new Map()
const CACHE_LIMIT = 8
/** How long a failed conversion is remembered before it is tried again. */
export const ESIGN_LOGO_FAILURE_TTL_MS = 10 * 60 * 1000
/** The last stored logo text and its hash: a public request does not decode the logo to know its hash. */
let lastHashed = { value: null, hash: null }

const clean = (value) => String(value ?? '').trim()

/** The stored logo's kind and bytes, or null when it is not a data-URL of an image kind this converts. */
function logoSource(logoUrl) {
  const value = clean(logoUrl)
  const match = DATA_URL.exec(value)
  if (!match) return null
  const payload = value.slice(match[0].length)
  try {
    const bytes = /;base64/i.test(match[2] ?? '') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
    if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null
    return { svg: match[1].toLowerCase() === 'svg+xml', bytes }
  } catch {
    return null
  }
}

/** Inches per absolute CSS unit (an SVG drawn at density d is d pixels per inch). */
const INCHES_PER = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72, pc: 1 / 6 }

/**
 * An SVG width: `{ px }` for user units / px, `{ inches }` for an absolute unit; null for %, em and the like.
 */
function svgWidth(value) {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px|in|cm|mm|pt|pc)?\s*$/i.exec(String(value ?? ''))
  const number = match ? Number(match[1]) : NaN
  if (!Number.isFinite(number) || number <= 0) return null
  const unit = (match[2] ?? 'px').toLowerCase()
  return unit === 'px' ? { px: number } : { inches: number * INCHES_PER[unit] }
}

/**
 * The density to rasterize an SVG at so it comes out about 800 px wide: from its `width` (px or an
 * absolute unit), else its viewBox's width (librsvg sizes it by the viewBox then, in px), clamped. 72 when
 * neither can be read. A px width scales with the density (px x d / 72); an absolute width scales with its
 * SQUARE (sharp and librsvg both apply it: inches x d x d / 72), so it takes the square root.
 */
export function svgDensity(svgText) {
  const root = /<svg\b[^>]*>/i.exec(String(svgText ?? ''))?.[0] ?? ''
  const attribute = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]
  const viewBox = String(attribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const width = svgWidth(attribute('width')) ?? (viewBox.length === 4 && viewBox[2] > 0 ? { px: viewBox[2] } : null)
  if (!width) return 72
  const density = width.px ? (72 * SVG_DRAW_WIDTH) / width.px : Math.sqrt((72 * SVG_DRAW_WIDTH) / width.inches)
  return Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, density))
}

/** The content hash in the logo's public address, or null when there is no logo this can serve. */
export function firmLogoHash(firmSettings) {
  const value = clean(firmSettings?.logoUrl)
  if (value === lastHashed.value) return lastHashed.hash
  const hash = logoSource(value) ? createHash('sha256').update(value).digest('hex').slice(0, 32) : null
  lastHashed = { value, hash }
  return hash
}

/** One conversion to a PNG at most 400 px wide (an SVG at `density`). */
async function convert(source, density) {
  const input = source.svg
    ? sharp(source.bytes, { density, limitInputPixels: 25_000_000 })
    : sharp(source.bytes, { limitInputPixels: 25_000_000 })
  const png = await input.timeout({ seconds: 10 }).resize({ width: ESIGN_LOGO_WIDTH, withoutEnlargement: true }).png().toBuffer()
  return { png, width: (await sharp(png).metadata()).width ?? 0 }
}

/** The logo's public path (relative): `/esign-logo/<hash>.png`. */
export function esignLogoPath(hash) {
  return `${ESIGN_LOGO_PATH_PREFIX}${hash}.png`
}

/**
 * The firm logo as PNG bytes, or null (no logo, a kind this cannot convert, or a conversion failure -
 * logged, never thrown, and remembered for ESIGN_LOGO_FAILURE_TTL_MS). An SVG is tried at its computed
 * density, then 300, then 72, until one converts at the full 400 px; else the widest that converted.
 * @returns {Promise<{hash: string, png: Buffer} | null>}
 */
export async function firmLogoPng(firmSettings, { log = console, now = Date.now } = {}) {
  const hash = firmLogoHash(firmSettings)
  if (!hash) return null
  const known = cache.get(hash)
  if (known && (known.entry || now() - known.failedAt < ESIGN_LOGO_FAILURE_TTL_MS)) return known.entry
  const source = logoSource(firmSettings.logoUrl)
  const densities = source.svg ? [...new Set([svgDensity(source.bytes.toString('utf8')), 300, 72])] : [null]
  let best = null
  let lastError = null
  for (const density of densities) {
    try {
      const made = await convert(source, density)
      if (!best || made.width > best.width) best = made
      if (made.width >= ESIGN_LOGO_WIDTH) break
    } catch (error) {
      lastError = error
    }
  }
  const entry = best ? { hash, png: best.png } : null
  if (!entry) log.warn('[esign-logo] the firm logo could not be converted to PNG:', lastError?.message || lastError)
  cache.delete(hash)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(hash, { entry, failedAt: entry ? null : now() })
  return entry
}

/**
 * THE decision whether a logo goes with an eSignatures.io contract (the send and its preview both ask):
 * the firm name always (as since task 18), and the logo when one converts AND the app's public URL is
 * https (eSignatures.io fetches it; a plain-http or local address would only break the image).
 * `logoUrl` is the absolute address the contract carries; `logoPath` the same file, relative, for the
 * in-app preview.
 * @returns {Promise<{companyName: string, logoUrl: string | null, logoPath: string | null}>}
 */
export async function esignBranding(firmSettings, publicUrl, options = {}) {
  const companyName = clean(firmSettings?.name) || 'PB&J Strategic Accounting'
  const origin = clean(publicUrl).replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+$/i.test(origin)) return { companyName, logoUrl: null, logoPath: null }
  const logo = await firmLogoPng(firmSettings, options)
  if (!logo) return { companyName, logoUrl: null, logoPath: null }
  const logoPath = esignLogoPath(logo.hash)
  return { companyName, logoUrl: `${origin}${logoPath}`, logoPath }
}

/**
 * The public logo route's answer, decided here so it is tested by running it. The requested hash is
 * compared with the CURRENT logo's (remembered, so not decoded again) before anything is converted: a
 * mismatch is 404 at once.
 * HEAD answers the headers (with Content-Length) and no body.
 * @param {{hash: string, method: string, firmSettings: object|null}} request
 * @returns {Promise<{status: number, headers: Record<string, string|number>, body: Buffer|string|undefined}>}
 */
export async function esignLogoResponse({ hash, method, firmSettings }, options = {}) {
  const notFound = { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: 'Not found' }
  if (!hash || firmLogoHash(firmSettings) !== hash) return notFound
  const logo = await firmLogoPng(firmSettings, options)
  if (!logo) return notFound
  return {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': logo.png.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
    body: String(method).toUpperCase() === 'HEAD' ? undefined : logo.png,
  }
}
