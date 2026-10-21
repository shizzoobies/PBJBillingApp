import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  SIGNWELL_BASE_URL,
  SignwellError,
  createDocumentFromFile,
  createWebhook,
  deleteWebhook,
  getCompletedPdf,
  getDocument,
  isTestMode,
  listWebhooks,
  redact,
  sendReminder,
  signwellConfigured,
  verifyEventHash,
} from './signwell.js'

const KEY = 'sw_fake_key_1234567890'
const env = { SIGNWELL_API_KEY: KEY }
const noSleep = () => Promise.resolve()

/** A stub `fetch` answering the given responses in order; records every call. */
function stubFetch(...answers) {
  const calls = []
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url, init })
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (next instanceof Error) throw next
    return next
  })
  return { fetch, calls }
}

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status, headers })
const pdf = () => new Response(Buffer.from('%PDF-1.4 fake bytes'), { status: 200 })

describe('isTestMode and signwellConfigured', () => {
  it('a missing, empty or any other value is TEST mode; only the literal false (any case) is live', () => {
    expect(isTestMode({})).toBe(true)
    expect(isTestMode({ SIGNWELL_TEST_MODE: '' })).toBe(true)
    expect(isTestMode({ SIGNWELL_TEST_MODE: 'true' })).toBe(true)
    expect(isTestMode({ SIGNWELL_TEST_MODE: 'no' })).toBe(true)
    expect(isTestMode({ SIGNWELL_TEST_MODE: '0' })).toBe(true)
    expect(isTestMode({ SIGNWELL_TEST_MODE: 'false' })).toBe(false)
    expect(isTestMode({ SIGNWELL_TEST_MODE: ' FALSE ' })).toBe(false)
    expect(isTestMode({ SIGNWELL_TEST_MODE: 'False' })).toBe(false)
  })

  it('is configured only with a non-blank API key', () => {
    expect(signwellConfigured({})).toBe(false)
    expect(signwellConfigured({ SIGNWELL_API_KEY: '  ' })).toBe(false)
    expect(signwellConfigured({ SIGNWELL_API_KEY: KEY })).toBe(true)
  })
})

describe('createDocumentFromFile', () => {
  const args = {
    fileBase64: 'QUJD',
    fileName: 'letter.pdf',
    name: 'Acme - Engagement letter',
    subject: 'Your engagement letter',
    message: 'Please sign.',
    recipients: [{ id: '1', name: 'Pat Example', email: 'pat@example.invalid' }],
    textTags: true,
    metadata: { engagement_id: 'eng-1', app: 'pbjbillingapp' },
    expiresIn: 30,
    redirectUrl: 'https://app.example.invalid/signed-thank-you',
  }

  it('POSTs the body SignWell documents, with the key header, to the verified base URL', async () => {
    const { fetch, calls } = stubFetch(json(201, { id: 'doc-1', status: 'Created', recipients: [{ id: '1' }] }))
    const created = await createDocumentFromFile(args, { env, fetch })

    expect(created.id).toBe('doc-1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${SIGNWELL_BASE_URL}/documents`)
    expect(SIGNWELL_BASE_URL).toBe('https://www.signwell.com/api/v1')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['X-Api-Key']).toBe(KEY)
    expect(calls[0].init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(calls[0].init.body)
    expect(body).toEqual({
      test_mode: true,
      name: 'Acme - Engagement letter',
      subject: 'Your engagement letter',
      message: 'Please sign.',
      files: [{ name: 'letter.pdf', file_base64: 'QUJD' }],
      recipients: [{ id: '1', name: 'Pat Example', email: 'pat@example.invalid' }],
      text_tags: true,
      metadata: { engagement_id: 'eng-1', app: 'pbjbillingapp' },
      expires_in: 30,
      redirect_url: 'https://app.example.invalid/signed-thank-you',
    })
    expect(calls[0].init.signal).toBeDefined()
  })

  it('passes test_mode TRUE when the variable is missing, and false only for the literal false', async () => {
    const missing = stubFetch(json(201, { id: 'd' }))
    await createDocumentFromFile(args, { env, fetch: missing.fetch })
    expect(JSON.parse(missing.calls[0].init.body).test_mode).toBe(true)

    const live = stubFetch(json(201, { id: 'd' }))
    await createDocumentFromFile(args, { env: { ...env, SIGNWELL_TEST_MODE: 'false' }, fetch: live.fetch })
    expect(JSON.parse(live.calls[0].init.body).test_mode).toBe(false)

    // A caller can force test ON, never live: the variable decides.
    const forced = stubFetch(json(201, { id: 'd' }))
    await createDocumentFromFile({ ...args, testMode: false }, { env, fetch: forced.fetch })
    expect(JSON.parse(forced.calls[0].init.body).test_mode).toBe(true)
  })

  it('sends coordinate fields instead of text_tags when asked, and caps the subject at 255 characters', async () => {
    const { fetch, calls } = stubFetch(json(201, { id: 'd' }))
    const fields = [[{ type: 'signature', required: true, page: 1, x: 10, y: 20, recipient_id: '1' }]]
    await createDocumentFromFile({ ...args, textTags: false, fields, subject: 'x'.repeat(400) }, { env, fetch })
    const body = JSON.parse(calls[0].init.body)
    expect(body.fields).toEqual(fields)
    expect(body.text_tags).toBeUndefined()
    expect(body.subject).toHaveLength(255)
  })

  it('answers a 400 with SignWell\'s message and invalid_keys, never the request body', async () => {
    const { fetch } = stubFetch(json(400, { errors: { message: 'Bad recipients', invalid_keys: ['recipients'] } }))
    const failure = await createDocumentFromFile(args, { env, fetch }).catch((error) => error)
    expect(failure).toBeInstanceOf(SignwellError)
    expect(failure.status).toBe(400)
    expect(failure.signwellMessage).toBe('Bad recipients')
    expect(failure.invalidKeys).toEqual(['recipients'])
    expect(failure.message).toContain('400')
    expect(failure.message).toContain('Bad recipients')
    expect(failure.message).toContain('recipients')
    expect(failure.message).not.toContain('pat@example.invalid')
    expect(failure.message).not.toContain('QUJD')
  })

  it('answers a 401 and a 422 with their status and message', async () => {
    const unauthorized = await createDocumentFromFile(args, {
      env,
      fetch: stubFetch(json(401, { error: 'api_key_unauthorized_error' })).fetch,
    }).catch((error) => error)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.message).toContain('api_key_unauthorized_error')

    const invalid = await createDocumentFromFile(args, {
      env,
      fetch: stubFetch(json(422, { errors: { fields: 'must have a signature' } })).fetch,
    }).catch((error) => error)
    expect(invalid.status).toBe(422)
    expect(invalid.message).toContain('must have a signature')
  })

  it('refuses before any network call when there is no key', async () => {
    const { fetch } = stubFetch(json(201, {}))
    const failure = await createDocumentFromFile(args, { env: {}, fetch }).catch((error) => error)
    expect(failure.code).toBe('signwell_not_configured')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('rate limits and failures', () => {
  it('retries a 429 once after a backoff, and answers the second try', async () => {
    const { fetch, calls } = stubFetch(json(429, { error: 'slow down' }), json(200, { id: 'doc-1', status: 'Sent' }))
    const sleep = vi.fn(noSleep)
    const document = await getDocument('doc-1', { env, fetch, sleep })
    expect(document.status).toBe('Sent')
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0][0]).toBe(2000)
  })

  it('honors a Retry-After, capped, and gives up after the one retry', async () => {
    const { fetch, calls } = stubFetch(
      json(429, { error: 'slow' }, { 'retry-after': '60' }),
      json(429, { error: 'still slow' }),
    )
    const sleep = vi.fn(noSleep)
    const failure = await getDocument('doc-1', { env, fetch, sleep }).catch((error) => error)
    expect(failure.status).toBe(429)
    expect(failure.code).toBe('rate_limited')
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(10000)
  })

  it('turns a network failure and a timeout into SignwellErrors with no URL in the message', async () => {
    const down = await getDocument('d', { env, fetch: stubFetch(new TypeError('fetch failed')).fetch }).catch((e) => e)
    expect(down).toBeInstanceOf(SignwellError)
    expect(down.code).toBe('network')
    expect(down.message).not.toContain('http')

    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const slow = await getDocument('d', { env, fetch: stubFetch(aborted).fetch }).catch((e) => e)
    expect(slow.code).toBe('timeout')
  })

  it('never carries the API key in an error', async () => {
    const failure = await getDocument('d', { env, fetch: stubFetch(json(500, { error: 'boom' })).fetch }).catch((e) => e)
    expect(JSON.stringify({ message: failure.message, status: failure.status })).not.toContain(KEY)
  })
})

describe('getDocument, sendReminder and the webhook calls', () => {
  it('GETs /documents/{id}, url-encoding the id', async () => {
    const { fetch, calls } = stubFetch(json(200, { id: 'a/b', status: 'Completed' }))
    await getDocument('a/b', { env, fetch })
    expect(calls[0].url).toBe(`${SIGNWELL_BASE_URL}/documents/a%2Fb`)
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()
    expect(calls[0].init.headers['X-Api-Key']).toBe(KEY)
  })

  it('POSTs /documents/{id}/remind and tolerates an empty 201', async () => {
    const { fetch, calls } = stubFetch(new Response('', { status: 201 }))
    expect(await sendReminder('doc-1', { env, fetch })).toBeNull()
    expect(calls[0].url).toBe(`${SIGNWELL_BASE_URL}/documents/doc-1/remind`)
    expect(calls[0].init.method).toBe('POST')
  })

  it('a 422 reminder is an error with its status', async () => {
    const { fetch } = stubFetch(json(422, { errors: { message: 'cannot remind' } }))
    const failure = await sendReminder('doc-1', { env, fetch }).catch((e) => e)
    expect(failure.status).toBe(422)
  })

  it('lists, creates and deletes webhooks', async () => {
    const list = stubFetch(json(200, [{ id: 'h1', callback_url: 'https://x.invalid/hook' }]))
    expect(await listWebhooks({ env, fetch: list.fetch })).toEqual([{ id: 'h1', callback_url: 'https://x.invalid/hook' }])
    expect(list.calls[0].url).toBe(`${SIGNWELL_BASE_URL}/hooks`)
    expect(list.calls[0].init.method).toBe('GET')

    const create = stubFetch(json(201, { id: 'h2', callback_url: 'https://x.invalid/hook' }))
    const hook = await createWebhook('https://x.invalid/hook', { env, fetch: create.fetch })
    expect(hook.id).toBe('h2')
    expect(create.calls[0].init.method).toBe('POST')
    expect(JSON.parse(create.calls[0].init.body)).toEqual({ callback_url: 'https://x.invalid/hook' })

    const removed = stubFetch(new Response('', { status: 204 }))
    await deleteWebhook('h2', { env, fetch: removed.fetch })
    expect(removed.calls[0].url).toBe(`${SIGNWELL_BASE_URL}/hooks/h2`)
    expect(removed.calls[0].init.method).toBe('DELETE')
  })
})

describe('getCompletedPdf', () => {
  it('returns the PDF bytes as a Buffer, asking for a PDF with the longer timeout', async () => {
    const { fetch, calls } = stubFetch(pdf())
    const bytes = await getCompletedPdf('doc-1', { env, fetch })
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
    expect(calls[0].url).toBe(`${SIGNWELL_BASE_URL}/documents/doc-1/completed_pdf`)
    expect(calls[0].url).not.toContain('url_only')
    expect(calls[0].init.headers.Accept).toBe('application/pdf')
  })

  it('retries a too-early 400 after 2, 5 and 10 seconds, then succeeds', async () => {
    const early = json(400, { errors: { message: 'not ready' } })
    const { fetch, calls } = stubFetch(early, json(400, { error: 'not ready' }), pdf())
    const sleep = vi.fn(noSleep)
    const bytes = await getCompletedPdf('doc-1', { env, fetch, sleep })
    expect(bytes.length).toBeGreaterThan(4)
    expect(calls).toHaveLength(3)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 5000])
  })

  it('gives up with the 400 after the last wait', async () => {
    const { fetch, calls } = stubFetch(json(400, { error: 'not ready' }))
    const sleep = vi.fn(noSleep)
    const failure = await getCompletedPdf('doc-1', { env, fetch, sleep }).catch((e) => e)
    expect(failure.status).toBe(400)
    expect(calls).toHaveLength(4)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 5000, 10000])
  })

  it('does not retry any other failure, and refuses bytes that are not a PDF', async () => {
    const missing = stubFetch(json(404, { error: 'nope' }))
    const sleep = vi.fn(noSleep)
    const failure = await getCompletedPdf('doc-1', { env, fetch: missing.fetch, sleep }).catch((e) => e)
    expect(failure.status).toBe(404)
    expect(missing.calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()

    const notPdf = await getCompletedPdf('doc-1', {
      env,
      fetch: stubFetch(new Response('{"file_url":"https://x.invalid"}', { status: 200 })).fetch,
      sleep,
    }).catch((e) => e)
    expect(notPdf.code).toBe('not_a_pdf')
  })
})

describe('verifyEventHash', () => {
  const webhookId = 'hook-id-1234'
  const hashOf = (type, time, id = webhookId) => createHmac('sha256', id).update(`${type}@${time}`).digest('hex')

  it('accepts HMAC-SHA256(webhook id, type@time) and nothing else', () => {
    const type = 'document_completed'
    const time = 1760990000
    expect(verifyEventHash({ type, time, hash: hashOf(type, time) }, webhookId)).toBe(true)
    // `time` as a string, exactly as received, hashes the same.
    expect(verifyEventHash({ type, time: String(time), hash: hashOf(type, time) }, webhookId)).toBe(true)
    expect(verifyEventHash({ type, time, hash: hashOf(type, time).toUpperCase() }, webhookId)).toBe(true)
  })

  it('rejects a different type, time or webhook id', () => {
    const good = hashOf('document_completed', 1760990000)
    expect(verifyEventHash({ type: 'document_viewed', time: 1760990000, hash: good }, webhookId)).toBe(false)
    expect(verifyEventHash({ type: 'document_completed', time: 1760990001, hash: good }, webhookId)).toBe(false)
    expect(verifyEventHash({ type: 'document_completed', time: 1760990000, hash: good }, 'other-id')).toBe(false)
  })

  it('rejects a wrong-length, empty, missing or non-string hash without throwing', () => {
    const type = 'document_completed'
    const time = 1760990000
    expect(verifyEventHash({ type, time, hash: hashOf(type, time).slice(0, 63) }, webhookId)).toBe(false)
    expect(verifyEventHash({ type, time, hash: `${hashOf(type, time)}0` }, webhookId)).toBe(false)
    expect(verifyEventHash({ type, time, hash: 'abc' }, webhookId)).toBe(false)
    expect(verifyEventHash({ type, time, hash: '' }, webhookId)).toBe(false)
    expect(verifyEventHash({ type, time }, webhookId)).toBe(false)
    expect(verifyEventHash({ type, time, hash: 12345 }, webhookId)).toBe(false)
    expect(verifyEventHash({ type, hash: hashOf(type, time) }, webhookId)).toBe(false)
    expect(verifyEventHash({ type, time, hash: hashOf(type, time) }, '')).toBe(false)
    expect(verifyEventHash(undefined, webhookId)).toBe(false)
  })
})

describe('redact', () => {
  it('removes the key, the webhook id, email addresses and long base64 runs from a log line', () => {
    const blob = 'A'.repeat(300)
    const line = `failed for pat@example.invalid with ${KEY} and hook-secret-9 body ${blob}`
    const clean = redact(line, ['hook-secret-9'], { SIGNWELL_API_KEY: KEY })
    expect(clean).not.toContain('pat@example.invalid')
    expect(clean).not.toContain(KEY)
    expect(clean).not.toContain('hook-secret-9')
    expect(clean).not.toContain(blob)
    expect(clean).toContain('failed for')
  })

  it('is safe on nothing', () => {
    expect(redact(undefined, [], {})).toBe('')
    expect(redact(null, [undefined, ''], {})).toBe('')
  })
})

describe('2xx answers that are not JSON, and a pasted webhook id', () => {
  it('a 2xx whose body is not JSON is not an error: it answers null', async () => {
    const { fetch } = stubFetch(new Response('OK', { status: 201 }))
    expect(await sendReminder('doc-1', { env, fetch })).toBeNull()
    const html = stubFetch(new Response('<html>accepted</html>', { status: 200 }))
    expect(await getDocument('doc-1', { env, fetch: html.fetch })).toBeNull()
    // A real error is still an error, JSON or not.
    const failure = await getDocument('doc-1', { env, fetch: stubFetch(new Response('<html>oops</html>', { status: 502 })).fetch }).catch((e) => e)
    expect(failure.status).toBe(502)
  })

  it('verifyEventHash trims the webhook id, so a pasted trailing newline still verifies', () => {
    const hash = createHmac('sha256', 'hook-id').update('document_viewed@123').digest('hex')
    expect(verifyEventHash({ type: 'document_viewed', time: 123, hash }, 'hook-id')).toBe(true)
    expect(verifyEventHash({ type: 'document_viewed', time: 123, hash }, ' hook-id\r\n')).toBe(true)
    expect(verifyEventHash({ type: 'document_viewed', time: 123, hash }, ' \n')).toBe(false)
  })
})
