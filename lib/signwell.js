/**
 * The ONLY file that knows SignWell's URLs and request/response shapes (featreq-56d39567).
 * Everything else in the app talks to these functions and to the webhook handler in
 * lib/signwell-webhook.js, so swapping providers touches those two files.
 *
 * Plain `fetch` (no SDK, no dependency). Facts below were verified 2026-10-21 against
 * https://developers.signwell.com/llms.txt and the reference pages it lists; each
 * function cites the page it relies on.
 *
 *  - Base URL `https://www.signwell.com/api/v1/` (the `api.signwell.com` host one
 *    tutorial shows does not resolve). Auth is one header, `X-Api-Key`.
 *  - Test mode: `SIGNWELL_TEST_MODE` MISSING means TEST; only the literal `false`
 *    (any case) means live, so a misconfigured deploy can never send a live document.
 *    `createDocumentFromFile` can only ever force test mode ON, never live.
 *  - NEVER logged or put in an error: the API key, a signer's email, document bytes.
 *    `redact` is the helper for any log line that might carry them.
 *
 * Every exported call takes an optional trailing `{ env, fetch, sleep }` so tests stub
 * the network and the clock; production passes nothing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNWELL_BASE_URL = 'https://www.signwell.com/api/v1'
const DEFAULT_TIMEOUT_MS = 20000
const PDF_TIMEOUT_MS = 60000
/** One backoff before the single retry of a 429, unless SignWell's Retry-After says otherwise. */
const RATE_LIMIT_WAIT_MS = 2000
const RATE_LIMIT_WAIT_MAX_MS = 10000
/**
 * The completed PDF takes "a few seconds" after completion and a too-early call is a
 * 400 (docs: Completed PDF): three retries after the first try, waiting this long before each.
 */
const PDF_RETRY_WAITS_MS = [2000, 5000, 10000]

/** An error from SignWell (or from reaching it): `status` 0 means no HTTP answer at all. */
export class SignwellError extends Error {
  constructor(message, { status = 0, code = null, signwellMessage = null, invalidKeys = null } = {}) {
    super(message)
    this.name = 'SignwellError'
    this.status = status
    this.code = code
    this.signwellMessage = signwellMessage
    this.invalidKeys = invalidKeys
  }
}

/** SIGNWELL_TEST_MODE: missing (or anything but the literal `false`) is TEST mode. */
export function isTestMode(env = process.env) {
  return String(env?.SIGNWELL_TEST_MODE ?? '').trim().toLowerCase() !== 'false'
}

/** True when an API key is set. The webhook id is checked separately by its handler. */
export function signwellConfigured(env = process.env) {
  return String(env?.SIGNWELL_API_KEY ?? '').trim() !== ''
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const LONG_BLOB_PATTERN = /[A-Za-z0-9+/=_-]{200,}/g

/**
 * A string safe for a log line: the API key (and any other `secrets` given) and every
 * email address replaced, and any long base64-looking run (a document) cut out.
 */
export function redact(value, secrets = [], env = process.env) {
  let text = String(value ?? '')
  for (const secret of [env?.SIGNWELL_API_KEY, env?.SIGNWELL_WEBHOOK_ID, ...secrets]) {
    const needle = String(secret ?? '').trim()
    if (needle.length >= 4) text = text.split(needle).join('[redacted]')
  }
  return text.replace(EMAIL_PATTERN, '[email]').replace(LONG_BLOB_PATTERN, '[data]')
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function apiKeyOf(env) {
  const key = String(env?.SIGNWELL_API_KEY ?? '').trim()
  if (!key) {
    throw new SignwellError('SignWell is not configured (no SIGNWELL_API_KEY).', { code: 'signwell_not_configured' })
  }
  return key
}

/** SignWell's error body: `{errors:{message, invalid_keys}}`, `{error}` or `{message}`. */
function describeErrorBody(text) {
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const errors = parsed && typeof parsed === 'object' ? parsed.errors : null
  const pieces = []
  if (typeof errors === 'string') pieces.push(errors)
  else if (errors && typeof errors === 'object') {
    for (const [key, value] of Object.entries(errors)) {
      if (key === 'invalid_keys') continue
      pieces.push(typeof value === 'string' ? value : JSON.stringify(value))
    }
  }
  if (typeof parsed?.error === 'string') pieces.push(parsed.error)
  if (typeof parsed?.message === 'string') pieces.push(parsed.message)
  const invalid = errors && typeof errors === 'object' ? errors.invalid_keys : null
  const invalidKeys = Array.isArray(invalid) ? invalid.map(String) : null
  return { message: pieces.join('; ').slice(0, 500) || null, invalidKeys }
}

/**
 * One request, with the key header, a timeout, and one backoff retry of a 429.
 * `raw: true` returns the response bytes as a Buffer (the PDF); otherwise the parsed JSON
 * (or null for an empty body). A non-2xx answer throws a SignwellError carrying `status`
 * and SignWell's own message and `invalid_keys`; the request body is never put in it.
 */
async function call(method, requestPath, { body, query, raw = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}, options = {}) {
  const env = options.env ?? process.env
  const doFetch = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const key = apiKeyOf(env)
  const url = `${SIGNWELL_BASE_URL}${requestPath}${query ? `?${new URLSearchParams(query)}` : ''}`
  const headers = { 'X-Api-Key': key, Accept: raw ? 'application/pdf' : 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const timedOut = error?.name === 'AbortError'
      throw new SignwellError(
        timedOut ? `SignWell did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : 'SignWell could not be reached.',
        { code: timedOut ? 'timeout' : 'network' },
      )
    }
    try {
      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers?.get?.('retry-after'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, RATE_LIMIT_WAIT_MAX_MS)
          : RATE_LIMIT_WAIT_MS
        await sleep(wait)
        continue
      }
      if (!response.ok) {
        const { message, invalidKeys } = describeErrorBody(await response.text().catch(() => ''))
        const detail = [message, invalidKeys?.length ? `invalid: ${invalidKeys.join(', ')}` : null].filter(Boolean).join(' - ')
        throw new SignwellError(`SignWell answered ${response.status}${detail ? `: ${detail}` : ''}`, {
          status: response.status,
          code: response.status === 429 ? 'rate_limited' : 'http',
          signwellMessage: message,
          invalidKeys,
        })
      }
      if (raw) return Buffer.from(await response.arrayBuffer())
      const text = await response.text()
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        // A 2xx whose body is not JSON (an empty-ish acknowledgment) is not a failure.
        return null
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

const idPath = (id) => encodeURIComponent(String(id ?? ''))

/**
 * Create a document from a file we rendered. POST /documents
 * (https://developers.signwell.com/reference/post_api-v1-documents).
 *
 * Fields go in ONE of two ways: `textTags: true` (SignWell reads `{{signature:1:y}}` /
 * `{{date:1:y}}` tags written into the PDF), or `fields` (coordinates, units undocumented).
 * `metadata` comes back on every webhook's document, which is how an event finds its row.
 *
 * @returns {Promise<{id: string, status: string, recipients: object[]}>} the 201 body
 */
export async function createDocumentFromFile(
  { fileBase64, fileName, name, subject, message, recipients, fields, textTags = false, metadata, expiresIn, redirectUrl, testMode },
  options = {},
) {
  const env = options.env ?? process.env
  const body = {
    // Only ever forced ON here: the env var decides live vs test (missing = test).
    test_mode: isTestMode(env) || testMode === true,
    name,
    subject: subject === undefined ? undefined : String(subject).slice(0, 255),
    message: message === undefined ? undefined : String(message).slice(0, 4000),
    files: [{ name: fileName, file_base64: fileBase64 }],
    recipients,
    fields: textTags ? undefined : fields,
    text_tags: textTags ? true : undefined,
    metadata,
    expires_in: expiresIn,
    redirect_url: redirectUrl,
  }
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]
  return call('POST', '/documents', { body }, options)
}

/**
 * One document with its status and recipients. GET /documents/{id}.
 * `status` is exactly one of: Draft, Created, Sending, Sent, Pending, Viewed, Completed,
 * Manually completed, Declined, Canceled, Bounced, Blocked, Error, Expired (note the
 * capitalization and the space). A recipient's own status has no documented list: never
 * hard-code it.
 */
export function getDocument(id, options = {}) {
  return call('GET', `/documents/${idPath(id)}`, {}, options)
}

/**
 * The signed PDF's BYTES. GET /documents/{id}/completed_pdf. (With `?url_only=true` SignWell
 * answers a URL of unknown lifetime: never stored, so never asked for.) It takes "a few
 * seconds" after completion and a too-early call is a 400: retried after 2, 5 and 10 seconds.
 *
 * @returns {Promise<Buffer>}
 */
export async function getCompletedPdf(id, options = {}) {
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt += 1) {
    try {
      const bytes = await call('GET', `/documents/${idPath(id)}/completed_pdf`, { raw: true, timeoutMs: PDF_TIMEOUT_MS }, options)
      if (bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
        throw new SignwellError('SignWell answered something that is not a PDF.', { code: 'not_a_pdf' })
      }
      return bytes
    } catch (error) {
      const notReady = error instanceof SignwellError && error.status === 400
      if (!notReady || attempt >= PDF_RETRY_WAITS_MS.length) throw error
      await sleep(PDF_RETRY_WAITS_MS[attempt])
    }
  }
}

/** Remind the signers. POST /documents/{id}/remind (422 when the status cannot be reminded). */
export function sendReminder(id, options = {}) {
  return call('POST', `/documents/${idPath(id)}/remind`, {}, options)
}

/** Every registered webhook. GET /hooks (an array of `{ id, callback_url }`). */
export function listWebhooks(options = {}) {
  return call('GET', '/hooks', {}, options)
}

/** Register a callback URL. POST /hooks -> `{ id, callback_url }`. One URL receives ALL event types. */
export function createWebhook(callbackUrl, options = {}) {
  return call('POST', '/hooks', { body: { callback_url: callbackUrl } }, options)
}

/** Remove a webhook. DELETE /hooks/{id}. */
export function deleteWebhook(id, options = {}) {
  return call('DELETE', `/hooks/${idPath(id)}`, {}, options)
}

/**
 * Whether a webhook event is SignWell's. The docs give only code, and this is its formula:
 * `hash = HMAC-SHA256(key = the webhook's id, data = event.type + '@' + event.time)`, hex,
 * compared with `event.hash`; `time` exactly as received. The hash covers ONLY type and
 * time, so the handler re-fetches the document before acting on anything else.
 */
export function verifyEventHash({ type, time, hash } = {}, webhookId) {
  const key = String(webhookId ?? '').trim()
  if (!key || typeof hash !== 'string' || !hash || type === undefined || type === null || time === undefined || time === null) {
    return false
  }
  const expected = Buffer.from(createHmac('sha256', key).update(`${type}@${String(time)}`).digest('hex'), 'utf8')
  const given = Buffer.from(hash.trim().toLowerCase(), 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
