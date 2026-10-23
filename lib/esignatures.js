/**
 * The ONLY file that knows eSignatures.io's URLs and request/response shapes (esignatures.com;
 * featreq-56d39567, task 18; docs/esignatures.md). Everything else talks to these functions and to
 * the webhook handler in lib/esignatures-webhook.js. Plain `fetch`, no SDK, like lib/signwell.js.
 *
 * Facts (researched 2026-10-23 from https://esignatures.com/docs/api, verified in part against the
 * account; the ones not stated by the docs are marked "not stated" and coded defensively):
 *  - Base URL `https://esignatures.com/api`; HTTP Basic auth, the secret token as the username and
 *    an EMPTY password. The token is never put in a URL (the docs also allow `?token=`; never used).
 *  - There is no PDF upload: a contract is made from a Markdown TEMPLATE (`POST /templates`
 *    {title, markdown} -> `{data:[{template_id}]}`), then `POST /contracts` {template_id, title,
 *    signers, test: "yes"|"no", expires_in_hours, metadata (a STRING), emails, custom_branding}
 *    -> `{status:"queued", data:{contract:{id, status, signers:[{sign_page_url}]}}}`.
 *  - `GET /contracts/<id>` -> the contract with `status` (draft, sent, signed, withdrawn),
 *    `metadata` and `contract_pdf_url` (a link that expires 3 days after it was asked for; the
 *    response shape around `contract` is not stated, so `data.contract`, `data` and the body are read).
 *    Do not poll it: rate limits are "adaptive" and repeated polling can be blocked.
 *  - `POST /contracts/<id>/withdraw` (unsigned contracts only). Reminders are automatic (days 2, 4,
 *    8, 16, ...); `POST /contracts/<id>/signers/<signer_id>/send_contract` sends one signer the
 *    request again (the signer id is `signers[].id` in the create-contract answer).
 *  - Webhooks: header `X-Signature-SHA256` = HMAC-SHA256 of the raw body keyed with the secret token;
 *    hex or base64 is not stated, so both are accepted.
 *  - Test mode: `ESIGNATURES_TEST_MODE` MISSING means TEST; only the literal `false` (any case) is
 *    live. `createContract` can only ever force test ON, never live.
 *  - NEVER logged or put in an error: the token, a signer's email, document bytes, a PDF link's
 *    query string. `redact` is the helper for any log line that might carry them.
 *
 * Every exported call takes an optional trailing `{ env, fetch, sleep }` so tests stub the network
 * and the clock; production passes nothing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { esignaturesTestMode } from './esign-provider.js'

export const ESIGNATURES_BASE_URL = 'https://esignatures.com/api'
/** The largest signed PDF kept (a letter is a few hundred KB; their audit pages add a little). */
export const ESIGNATURES_PDF_MAX_BYTES = 25 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20000
const PDF_TIMEOUT_MS = 60000
const RATE_LIMIT_WAIT_MS = 2000
const RATE_LIMIT_WAIT_MAX_MS = 10000

/** An error from eSignatures.io (or from reaching it): `status` 0 means no HTTP answer at all. */
export class EsignaturesError extends Error {
  constructor(message, { status = 0, code = null, providerMessage = null } = {}) {
    super(message)
    this.name = 'EsignaturesError'
    this.status = status
    this.code = code
    this.providerMessage = providerMessage
  }
}

/** True when a secret token is set. */
export function esignaturesConfigured(env = process.env) {
  return String(env?.ESIGNATURES_SECRET_TOKEN ?? '').trim() !== ''
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const LONG_BLOB_PATTERN = /[A-Za-z0-9+/=_-]{200,}/g
const URL_QUERY_PATTERN = /(https?:\/\/[^\s?#"']+)\?[^\s"']*/g

/**
 * A string safe for a log line: the token (and any other `secrets` given) and every email address
 * replaced, a URL's query string cut (a signed PDF link carries its credential there), and any long
 * base64-looking run (a document) cut out.
 */
export function redact(value, secrets = [], env = process.env) {
  let text = String(value ?? '')
  for (const secret of [env?.ESIGNATURES_SECRET_TOKEN, ...secrets]) {
    const needle = String(secret ?? '').trim()
    if (needle.length >= 4) text = text.split(needle).join('[redacted]')
  }
  return text
    .replace(URL_QUERY_PATTERN, '$1?[query]')
    .replace(EMAIL_PATTERN, '[email]')
    .replace(LONG_BLOB_PATTERN, '[data]')
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tokenOf(env) {
  const token = String(env?.ESIGNATURES_SECRET_TOKEN ?? '').trim()
  if (!token) {
    throw new EsignaturesError('eSignatures.io is not configured (no ESIGNATURES_SECRET_TOKEN).', {
      code: 'esignatures_not_configured',
    })
  }
  return token
}

/** eSignatures.io's error body: `{status:"error", message}` or `{error}`; anything else is ignored. */
function describeErrorBody(text) {
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const pieces = []
  if (typeof parsed?.message === 'string') pieces.push(parsed.message)
  if (typeof parsed?.error === 'string') pieces.push(parsed.error)
  if (typeof parsed?.error?.message === 'string') pieces.push(parsed.error.message)
  return pieces.join('; ').slice(0, 500) || null
}

const codeFor = (status) => (status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'http')

/**
 * One request to the API, with Basic auth, a timeout and one backoff retry of a 429. Returns the
 * parsed JSON (or null for an empty or non-JSON 2xx body). A non-2xx answer throws an
 * EsignaturesError carrying `status` and the provider's message (redacted); never the request body.
 */
async function call(method, requestPath, { body, timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}, options = {}) {
  const env = options.env ?? process.env
  // A caller can shorten the wait (the webhook re-reads a contract inside eSignatures.io's own 15 s timeout).
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const doFetch = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const token = tokenOf(env)
  const headers = {
    Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await doFetch(`${ESIGNATURES_BASE_URL}${requestPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const timedOut = error?.name === 'AbortError'
      throw new EsignaturesError(
        timedOut ? `eSignatures.io did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : 'eSignatures.io could not be reached.',
        { code: timedOut ? 'timeout' : 'network' },
      )
    }
    try {
      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers?.get?.('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, RATE_LIMIT_WAIT_MAX_MS) : RATE_LIMIT_WAIT_MS)
        continue
      }
      if (!response.ok) {
        const message = describeErrorBody(await response.text().catch(() => ''))
        const safe = message ? redact(message, [token], env) : null
        throw new EsignaturesError(`eSignatures.io answered ${response.status}${safe ? `: ${safe}` : ''}`, {
          status: response.status,
          code: codeFor(response.status),
          providerMessage: safe,
        })
      }
      const text = await response.text()
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

const idPath = (id) => encodeURIComponent(String(id ?? ''))
const badResponse = (what) => new EsignaturesError(`eSignatures.io answered without ${what}.`, { code: 'bad_response' })

/** The contract object in an answer: `data.contract`, else `data`, else `contract`, else the body (shape not stated). */
function contractIn(body) {
  const candidates = [body?.data?.contract, body?.data, body?.contract, body]
  return candidates.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id !== undefined) ?? null
}

/** Create a Markdown template. POST /templates {title, markdown}. @returns {Promise<string>} the template id */
export async function createTemplate({ title, markdown }, options = {}) {
  const answer = await call('POST', '/templates', { body: { title: String(title ?? ''), markdown: String(markdown ?? '') } }, options)
  const data = answer?.data
  const id = (Array.isArray(data) ? data[0]?.template_id : data?.template_id) ?? answer?.template_id
  if (typeof id !== 'string' || !id) throw badResponse('a template id')
  return id
}

/**
 * Create (and send) a contract from a template for the given signers. POST /contracts.
 * `test` is "yes" unless the environment says live AND the caller did not ask for test.
 * `metadata` is a string (it comes back on every webhook). Only what is given is sent.
 *
 * @param {object} input
 * @param {string} input.templateId
 * @param {string} input.title
 * @param {Array<{name: string, email: string}>} input.signers
 * @param {boolean} [input.testMode]
 * @param {number} [input.expiresInHours]
 * @param {string} input.metadata
 * @param {{signatureRequestSubject?: string, signatureRequestText?: string, finalContractSubject?: string, finalContractText?: string, replyTo?: string}} [input.emails]
 * @param {string} [input.companyName]   custom_branding.company_name
 * @param {string} [input.webhookUrl]    custom_webhook_url (the dashboard's URL is used when absent)
 * @returns {Promise<object>} the contract: `{id, status, signers, ...}`
 */
export async function createContract(
  { templateId, title, signers, testMode, expiresInHours, metadata, emails, companyName, webhookUrl },
  options = {},
) {
  const env = options.env ?? process.env
  const mail = emails ?? {}
  const emailBody = {
    signature_request_subject: mail.signatureRequestSubject,
    signature_request_text: mail.signatureRequestText,
    final_contract_subject: mail.finalContractSubject,
    final_contract_text: mail.finalContractText,
    reply_to: mail.replyTo || undefined,
  }
  for (const key of Object.keys(emailBody)) if (emailBody[key] === undefined) delete emailBody[key]
  const body = {
    template_id: templateId,
    title,
    signers: (Array.isArray(signers) ? signers : []).map((signer) => ({ name: signer.name, email: signer.email })),
    // Only ever forced ON here: the environment decides live vs test (missing = test).
    test: esignaturesTestMode(env) || testMode === true ? 'yes' : 'no',
    expires_in_hours: Number.isFinite(expiresInHours) && expiresInHours > 0 ? Math.round(expiresInHours) : undefined,
    metadata: metadata === undefined ? undefined : String(metadata),
    emails: Object.keys(emailBody).length > 0 ? emailBody : undefined,
    custom_branding: companyName ? { company_name: String(companyName) } : undefined,
    custom_webhook_url: webhookUrl || undefined,
  }
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]
  const contract = contractIn(await call('POST', '/contracts', { body }, options))
  if (!contract || typeof contract.id !== 'string' || !contract.id) throw badResponse('a contract id')
  return contract
}

/** One contract: status, metadata, signers and (once signed) `contract_pdf_url`. GET /contracts/<id>. */
export async function getContract(id, options = {}) {
  const contract = contractIn(await call('GET', `/contracts/${idPath(id)}`, {}, options))
  if (!contract) throw badResponse('the contract')
  return contract
}

/**
 * Send the signature request to one signer again (the "Send reminder" button):
 * POST /contracts/<contract_id>/signers/<signer_id>/send_contract (confirmed in the API docs
 * 2026-10-23). A manual resend skips the next automatic reminder (days 2, 4, 8, 16, ...).
 */
export function resendToSigner(contractId, signerId, options = {}) {
  return call('POST', `/contracts/${idPath(contractId)}/signers/${idPath(signerId)}/send_contract`, {}, options)
}

/** Withdraw an unsigned contract. POST /contracts/<id>/withdraw. */
export function withdrawContract(id, options = {}) {
  return call('POST', `/contracts/${idPath(id)}/withdraw`, {}, options)
}

const PDF_TYPES = ['application/pdf', 'application/octet-stream', 'binary/octet-stream']
/** Redirects followed by hand (each hop must be https), at most this many. */
const PDF_MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * The signed PDF's BYTES from a `contract_pdf_url` (read from GET /contracts/<id>, never from a
 * webhook body). Sent with NO credentials (the link is its own credential and its host is not
 * stated). Refuses a URL that is not https, a content type that is not a PDF (a storage host's
 * generic binary type is allowed), bytes that do not start with `%PDF`, and more than `maxBytes`.
 *
 * @returns {Promise<Buffer>}
 */
export async function downloadSignedPdf(url, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch
  const maxBytes = options.maxBytes ?? ESIGNATURES_PDF_MAX_BYTES
  let parsed = null
  try {
    parsed = new URL(String(url ?? ''))
  } catch {
    parsed = null
  }
  if (!parsed || parsed.protocol !== 'https:') {
    throw new EsignaturesError('The signed PDF link is not an https address.', { code: 'bad_pdf_url' })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PDF_TIMEOUT_MS)
  try {
    let response
    let target = parsed
    for (let hops = 0; ; hops += 1) {
      try {
        // Redirects by hand: a storage host may redirect, but never to anything that is not https.
        response = await doFetch(target.href, { method: 'GET', headers: { Accept: 'application/pdf' }, signal: controller.signal, redirect: 'manual' })
      } catch (error) {
        throw new EsignaturesError(
          error?.name === 'AbortError' ? 'The signed PDF did not download in time.' : 'The signed PDF could not be reached.',
          { code: error?.name === 'AbortError' ? 'timeout' : 'network' },
        )
      }
      if (!REDIRECT_STATUSES.has(response.status)) break
      const location = String(response.headers?.get?.('location') ?? '').trim()
      let next = null
      try {
        next = location ? new URL(location, target) : null
      } catch {
        next = null
      }
      if (!next || next.protocol !== 'https:' || hops >= PDF_MAX_REDIRECTS) {
        throw new EsignaturesError('The signed PDF link redirected somewhere the app does not follow.', { status: response.status, code: 'bad_pdf_url' })
      }
      target = next
    }
    if (!response.ok) {
      throw new EsignaturesError(`The signed PDF link answered ${response.status}.`, { status: response.status, code: codeFor(response.status) })
    }
    const type = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!PDF_TYPES.includes(type)) {
      throw new EsignaturesError('The signed PDF link answered something that is not a PDF.', { code: 'not_a_pdf' })
    }
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new EsignaturesError('The signed PDF is larger than the app keeps.', { code: 'too_large' })
    }
    const bytes = await readCapped(response, maxBytes)
    if (bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new EsignaturesError('The signed PDF link answered something that is not a PDF.', { code: 'not_a_pdf' })
    }
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

/** The body as a Buffer, refused as soon as it passes `maxBytes`. */
async function readCapped(response, maxBytes) {
  const tooLarge = () => new EsignaturesError('The signed PDF is larger than the app keeps.', { code: 'too_large' })
  const reader = response.body?.getReader?.()
  if (!reader) {
    const whole = Buffer.from(await response.arrayBuffer())
    if (whole.length > maxBytes) throw tooLarge()
    return whole
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * Whether a webhook delivery is eSignatures.io's: `X-Signature-SHA256` must be the HMAC-SHA256 of the
 * RAW body keyed with the secret token. The encoding is not stated, so hex (any case) and base64
 * (standard or URL-safe) are both accepted, with an optional `sha256=` prefix; compared in constant time.
 */
export function verifyWebhookSignature(rawBody, header, token) {
  const key = String(token ?? '').trim()
  const given = String(header ?? '').trim().replace(/^sha256=/i, '')
  if (!key || !given) return false
  const expected = createHmac('sha256', key).update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody ?? '')).digest()
  let candidate = null
  if (/^[0-9a-f]{64}$/i.test(given)) candidate = Buffer.from(given, 'hex')
  else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(given)) {
    candidate = Buffer.from(given.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  }
  return Boolean(candidate && candidate.length === expected.length && timingSafeEqual(candidate, expected))
}
