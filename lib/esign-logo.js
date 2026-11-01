/**
 * The firm logo as a PUBLIC PNG for eSignatures.io (featreq e-sign honest preview, 2026-11-01).
 *
 * eSignatures.io draws a logo at the top of the contract when `custom_branding.logo_url` is a public
 * HTTPS address of a PNG (about 400 px wide). The firm's logo is not a file anywhere public: it is the
 * data-URL the owner uploaded in Settings (`firm_settings.logo_url`, read by `getFirmSettings()` on both
 * store backends - the same source the letterhead and invoice PDFs draw from, lib/invoice-pdf.js
 * `decodeSvgLogo`). So the app serves it itself:
 *
 *  - `GET /esign-logo/<hash>.png` (server.js; public, no session): `<hash>` is the first 32 hex characters of
 *    the SHA-256 of the stored logo data-URL. The route answers the PNG only when the hash is the CURRENT
 *    logo's, so the address cannot be enumerated (nothing else is behind it) or confused with an older logo
 *    (a replaced logo's address answers 404). The bytes never change for one address: cached a year.
 *  - SVG, PNG, JPEG, WebP and GIF data-URLs are converted with sharp (already a dependency; its librsvg
 *    draws SVG) to a PNG 400 px wide. A remote URL, anything else, or a logo that will not convert is "no
 *    logo": the send then carries no logo_url.
 *
 * Pure apart from sharp; the converted PNG is kept in memory per hash (a handful of entries).
 */

import { createHash } from 'node:crypto'

import sharp from 'sharp'

/** The path prefix of the public logo route. */
export const ESIGN_LOGO_PATH_PREFIX = '/esign-logo/'
/** The route's path pattern: the hash, then `.png`. */
export const ESIGN_LOGO_PATH = /^\/esign-logo\/([0-9a-f]{32})\.png$/
/** eSignatures.io's suggested logo width. */
export const ESIGN_LOGO_WIDTH = 400
/** The largest stored logo converted (a data-URL's decoded bytes). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const DATA_URL = /^data:image\/(svg\+xml|png|jpeg|jpg|webp|gif)(;[^,]*)?,/i

const cache = new Map()
const CACHE_LIMIT = 4

const clean = (value) => String(value ?? '').trim()

/** The stored logo's bytes, or null when it is not a data-URL of an image kind this converts. */
function logoBytes(logoUrl) {
  const value = clean(logoUrl)
  const match = DATA_URL.exec(value)
  if (!match) return null
  const payload = value.slice(match[0].length)
  try {
    const bytes = /;base64/i.test(match[2] ?? '') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
    return bytes.length > 0 && bytes.length <= MAX_LOGO_BYTES ? bytes : null
  } catch {
    return null
  }
}

/** The content hash in the logo's public address, or null when there is no logo this can serve. */
export function firmLogoHash(firmSettings) {
  const value = clean(firmSettings?.logoUrl)
  if (!logoBytes(value)) return null
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/** The logo's public path (relative): `/esign-logo/<hash>.png`. */
export function esignLogoPath(hash) {
  return `${ESIGN_LOGO_PATH_PREFIX}${hash}.png`
}

/**
 * The firm logo as PNG bytes, or null (no logo, a kind this cannot convert, or a conversion failure -
 * logged, never thrown).
 * @returns {Promise<{hash: string, png: Buffer} | null>}
 */
export async function firmLogoPng(firmSettings, { log = console } = {}) {
  const hash = firmLogoHash(firmSettings)
  if (!hash) return null
  if (cache.has(hash)) return cache.get(hash)
  let png = null
  try {
    png = await sharp(logoBytes(firmSettings.logoUrl), { density: 300, limitInputPixels: 25_000_000 })
      .timeout({ seconds: 10 })
      .resize({ width: ESIGN_LOGO_WIDTH })
      .png()
      .toBuffer()
  } catch (error) {
    log.warn('[esign-logo] the firm logo could not be converted to PNG:', error?.message || error)
    return null
  }
  const entry = { hash, png }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(hash, entry)
  return entry
}

/**
 * The `custom_branding` an eSignatures.io contract carries: the firm name always (as since task 18), and
 * the logo's ABSOLUTE public address when a logo converts and the app's public URL is https (eSignatures.io
 * fetches it; a plain-http or local address would only break the image).
 * @returns {Promise<{companyName: string, logoUrl: string | null}>}
 */
export async function esignBranding(firmSettings, publicUrl, options = {}) {
  const companyName = clean(firmSettings?.name) || 'PB&J Strategic Accounting'
  const origin = clean(publicUrl).replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+$/i.test(origin)) return { companyName, logoUrl: null }
  const logo = await firmLogoPng(firmSettings, options)
  return { companyName, logoUrl: logo ? `${origin}${esignLogoPath(logo.hash)}` : null }
}
