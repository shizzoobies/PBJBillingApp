import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  ESIGNATURES_BASE_URL,
  ESIGNATURES_PDF_MAX_BYTES,
  EsignaturesError,
  createContract,
  createTemplate,
  downloadSignedPdf,
  esignaturesConfigured,
  getContract,
  redact,
  resendToSigner,
  verifyWebhookSignature,
  withdrawContract,
} from './esignatures.js'

/**
 * The eSignatures.io client (task 18): every call's method, path, auth and body against a stub
 * `fetch` (the live API is never called), the error mapping, the webhook signature in hex and in
 * base64, and the signed-PDF download's guards.
 */
const TOKEN = 'es_fake_token_1234567890'
const env = { ESIGNATURES_SECRET_TOKEN: TOKEN }
const noSleep = () => Promise.resolve()

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
const json = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers })
const basic = `Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`

describe('esignaturesConfigured', () => {
  it('needs a non-blank token', () => {
    expect(esignaturesConfigured({})).toBe(false)
    expect(esignaturesConfigured({ ESIGNATURES_SECRET_TOKEN: '  ' })).toBe(false)
    expect(esignaturesConfigured(env)).toBe(true)
  })
})

describe('createTemplate', () => {
  it('POSTs {title, markdown} to /api/templates with HTTP Basic (token, empty password) and answers the template id', async () => {
    const { fetch, calls } = stubFetch(json(200, { data: [{ template_id: 'tpl-1' }] }))
    const id = await createTemplate({ title: 'Acme Books - Engagement letter Oct 23, 2026', markdown: '## PB&J\n\nDear Pat,' }, { env, fetch })
    expect(id).toBe('tpl-1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${ESIGNATURES_BASE_URL}/templates`)
    expect(ESIGNATURES_BASE_URL).toBe('https://esignatures.com/api')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe(basic)
    expect(calls[0].init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'Acme Books - Engagement letter Oct 23, 2026', markdown: '## PB&J\n\nDear Pat,' })
    // The token never rides in the URL.
    expect(calls[0].url).not.toContain(TOKEN)
  })

  it('reads the id from an object-shaped data too, and refuses an answer with no id', async () => {
    expect(await createTemplate({ title: 't', markdown: 'm' }, { env, fetch: stubFetch(json(200, { data: { template_id: 'tpl-2' } })).fetch })).toBe('tpl-2')
    await expect(createTemplate({ title: 't', markdown: 'm' }, { env, fetch: stubFetch(json(200, { data: [] })).fetch })).rejects.toMatchObject({
      name: 'EsignaturesError',
      code: 'bad_response',
    })
  })

  it('refuses without a token, before any call', async () => {
    const { fetch } = stubFetch(json(200, {}))
    await expect(createTemplate({ title: 't', markdown: 'm' }, { env: {}, fetch })).rejects.toMatchObject({ code: 'esignatures_not_configured' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('createContract', () => {
  const input = {
    templateId: 'tpl-1',
    title: 'Acme Books - Engagement letter Oct 23, 2026',
    signers: [{ name: 'Pat Doe', email: 'pat@example.invalid' }],
    testMode: false,
    expiresInHours: 720,
    metadata: '{"engagement_id":"eng-1","app":"pbjbillingapp"}',
    emails: {
      signatureRequestSubject: 'Engagement letter - Acme Books',
      signatureRequestText: 'Hi Pat,\n\nPlease sign.',
      finalContractSubject: 'Your signed engagement letter',
      finalContractText: 'Thank you.',
      replyTo: 'brittany@pbjsa.example',
    },
    companyName: 'PB&J Strategic Accounting',
  }

  it('POSTs the exact contract body to /api/contracts and answers the contract', async () => {
    const answer = { status: 'queued', data: { contract: { id: 'ctr-1', status: 'sent', signers: [{ id: 's-1', sign_page_url: 'https://esignatures.com/sign/secret' }] } } }
    const { fetch, calls } = stubFetch(json(200, answer))
    const contract = await createContract(input, { env: { ...env, ESIGNATURES_TEST_MODE: 'false' }, fetch })
    expect(contract.id).toBe('ctr-1')
    expect(calls[0].url).toBe(`${ESIGNATURES_BASE_URL}/contracts`)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe(basic)
    expect(JSON.parse(calls[0].init.body)).toEqual({
      template_id: 'tpl-1',
      title: 'Acme Books - Engagement letter Oct 23, 2026',
      signers: [{ name: 'Pat Doe', email: 'pat@example.invalid' }],
      test: 'no',
      expires_in_hours: 720,
      metadata: '{"engagement_id":"eng-1","app":"pbjbillingapp"}',
      emails: {
        signature_request_subject: 'Engagement letter - Acme Books',
        signature_request_text: 'Hi Pat,\n\nPlease sign.',
        final_contract_subject: 'Your signed engagement letter',
        final_contract_text: 'Thank you.',
        reply_to: 'brittany@pbjsa.example',
      },
      custom_branding: { company_name: 'PB&J Strategic Accounting' },
    })
  })

  it('test is forced ON by the environment (missing ESIGNATURES_TEST_MODE = test), or by the caller; never forced live', async () => {
    const unset = stubFetch(json(200, { data: { contract: { id: 'ctr-1' } } }))
    await createContract({ ...input, testMode: false }, { env, fetch: unset.fetch })
    expect(JSON.parse(unset.calls[0].init.body).test).toBe('yes')
    const asked = stubFetch(json(200, { data: { contract: { id: 'ctr-1' } } }))
    await createContract({ ...input, testMode: true }, { env: { ...env, ESIGNATURES_TEST_MODE: 'false' }, fetch: asked.fetch })
    expect(JSON.parse(asked.calls[0].init.body).test).toBe('yes')
  })

  it('leaves out what is not given (no reply-to, no branding name, no webhook override)', async () => {
    const { fetch, calls } = stubFetch(json(200, { data: { contract: { id: 'ctr-1' } } }))
    await createContract({ templateId: 'tpl-1', title: 't', signers: [{ name: 'P', email: 'p@example.invalid' }], metadata: '{}' }, { env, fetch })
    const body = JSON.parse(calls[0].init.body)
    expect(body).toEqual({ template_id: 'tpl-1', title: 't', signers: [{ name: 'P', email: 'p@example.invalid' }], test: 'yes', metadata: '{}' })
  })

  it('refuses an answer with no contract id', async () => {
    await expect(createContract(input, { env, fetch: stubFetch(json(200, { status: 'queued' })).fetch })).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('getContract and withdrawContract', () => {
  it('GETs /api/contracts/<id> (id encoded) and answers the contract from data.contract', async () => {
    const { fetch, calls } = stubFetch(json(200, { data: { contract: { id: 'ctr/1', status: 'signed', contract_pdf_url: 'https://files.example.invalid/x.pdf' } } }))
    const contract = await getContract('ctr/1', { env, fetch })
    expect(contract).toMatchObject({ id: 'ctr/1', status: 'signed' })
    expect(calls[0].url).toBe(`${ESIGNATURES_BASE_URL}/contracts/ctr%2F1`)
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()
  })

  it('reads a contract given at the top level of data too', async () => {
    const contract = await getContract('ctr-1', { env, fetch: stubFetch(json(200, { data: { id: 'ctr-1', status: 'sent' } })).fetch })
    expect(contract).toMatchObject({ id: 'ctr-1', status: 'sent' })
  })

  it('resends to one signer: POST /api/contracts/<id>/signers/<signer id>/send_contract (both ids encoded)', async () => {
    const { fetch, calls } = stubFetch(json(200, { status: 'queued' }))
    await resendToSigner('ctr-1', 'sig/1', { env, fetch })
    expect(calls[0].url).toBe(`${ESIGNATURES_BASE_URL}/contracts/ctr-1/signers/sig%2F1/send_contract`)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe(basic)
  })

  it('POSTs /api/contracts/<id>/withdraw', async () => {
    const { fetch, calls } = stubFetch(json(200, { status: 'withdrawn' }))
    expect(await withdrawContract('ctr-1', { env, fetch })).toEqual({ status: 'withdrawn' })
    expect(calls[0].url).toBe(`${ESIGNATURES_BASE_URL}/contracts/ctr-1/withdraw`)
    expect(calls[0].init.method).toBe('POST')
  })
})

describe('errors', () => {
  it('a non-2xx answer is an EsignaturesError with the status and the provider message (no token, no address)', async () => {
    const { fetch } = stubFetch(json(400, { status: 'error', message: `Signer email pat@example.invalid invalid for ${TOKEN}` }))
    const error = await getContract('ctr-1', { env, fetch }).catch((caught) => caught)
    expect(error).toBeInstanceOf(EsignaturesError)
    expect(error.status).toBe(400)
    expect(error.code).toBe('http')
    expect(error.message).toContain('eSignatures.io answered 400')
    expect(error.message).not.toContain(TOKEN)
    expect(redact(error.message, [], env)).not.toContain('pat@example.invalid')
  })

  it('a 401 is "unauthorized"; a 429 waits once and retries; a second 429 is "rate_limited"', async () => {
    expect(await getContract('c', { env, fetch: stubFetch(json(401, {})).fetch }).catch((e) => e.code)).toBe('unauthorized')
    const sleep = vi.fn(noSleep)
    const retried = stubFetch(json(429, {}), json(200, { data: { contract: { id: 'c' } } }))
    expect((await getContract('c', { env, fetch: retried.fetch, sleep })).id).toBe('c')
    expect(sleep).toHaveBeenCalledTimes(1)
    const twice = stubFetch(json(429, {}), json(429, {}))
    expect(await getContract('c', { env, fetch: twice.fetch, sleep }).catch((e) => [e.status, e.code])).toEqual([429, 'rate_limited'])
  })

  it('no answer at all is status 0: "network", or "timeout" on an abort', async () => {
    expect(await getContract('c', { env, fetch: stubFetch(new TypeError('fetch failed')).fetch }).catch((e) => [e.status, e.code])).toEqual([0, 'network'])
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(await getContract('c', { env, fetch: stubFetch(abort).fetch }).catch((e) => e.code)).toBe('timeout')
  })
})

describe('verifyWebhookSignature', () => {
  const body = '{"status":"contract-signed","data":{"contract":{"id":"ctr-1"}}}'
  const mac = (key = TOKEN, text = body) => createHmac('sha256', key).update(text)

  it('accepts the HMAC-SHA256 of the raw body keyed with the token, in hex (any case) or base64', () => {
    expect(verifyWebhookSignature(body, mac().digest('hex'), TOKEN)).toBe(true)
    expect(verifyWebhookSignature(body, mac().digest('hex').toUpperCase(), TOKEN)).toBe(true)
    expect(verifyWebhookSignature(body, ` ${mac().digest('hex')} `, TOKEN)).toBe(true)
    expect(verifyWebhookSignature(body, mac().digest('base64'), TOKEN)).toBe(true)
    expect(verifyWebhookSignature(body, mac().digest('base64url'), TOKEN)).toBe(true)
    expect(verifyWebhookSignature(Buffer.from(body), `sha256=${mac().digest('hex')}`, TOKEN)).toBe(true)
  })

  it('refuses a wrong key, a changed body, a missing or malformed header, and no token', () => {
    expect(verifyWebhookSignature(body, mac('wrong-key').digest('hex'), TOKEN)).toBe(false)
    expect(verifyWebhookSignature(`${body} `, mac().digest('hex'), TOKEN)).toBe(false)
    expect(verifyWebhookSignature(body, mac().digest('base64'), `${TOKEN}x`)).toBe(false)
    expect(verifyWebhookSignature(body, '', TOKEN)).toBe(false)
    expect(verifyWebhookSignature(body, undefined, TOKEN)).toBe(false)
    expect(verifyWebhookSignature(body, 'not a signature', TOKEN)).toBe(false)
    expect(verifyWebhookSignature(body, mac().digest('hex').slice(0, 63), TOKEN)).toBe(false)
    expect(verifyWebhookSignature(body, mac('').digest('hex'), '')).toBe(false)
    expect(verifyWebhookSignature(body, mac().digest('hex'), '  ')).toBe(false)
  })
})

describe('downloadSignedPdf', () => {
  const PDF = Buffer.from('%PDF-1.7 signed letter bytes')
  const pdfAnswer = (bytes = PDF, type = 'application/pdf', headers = {}) =>
    new Response(bytes, { status: 200, headers: { 'content-type': type, ...headers } })

  it('GETs the URL with NO credentials and answers the bytes', async () => {
    const { fetch, calls } = stubFetch(pdfAnswer())
    const bytes = await downloadSignedPdf('https://files.example.invalid/signed.pdf?sig=abc', { env, fetch })
    expect(bytes.equals(PDF)).toBe(true)
    expect(calls[0].url).toBe('https://files.example.invalid/signed.pdf?sig=abc')
    expect(calls[0].init.method).toBe('GET')
    expect(JSON.stringify(calls[0].init.headers ?? {})).not.toContain('Basic')
    expect(JSON.stringify(calls[0].init)).not.toContain(TOKEN)
  })

  it('refuses a URL that is not https, before any call', async () => {
    for (const url of ['http://files.example.invalid/x.pdf', 'file:///etc/passwd', '', 'not a url', undefined]) {
      const { fetch } = stubFetch(pdfAnswer())
      await expect(downloadSignedPdf(url, { env, fetch }), String(url)).rejects.toMatchObject({ code: 'bad_pdf_url' })
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('enforces a PDF: the content type, and the %PDF bytes even when the type says pdf', async () => {
    await expect(downloadSignedPdf('https://f.example.invalid/x', { env, fetch: stubFetch(pdfAnswer(PDF, 'text/html')).fetch })).rejects.toMatchObject({ code: 'not_a_pdf' })
    await expect(
      downloadSignedPdf('https://f.example.invalid/x', { env, fetch: stubFetch(pdfAnswer(Buffer.from('<html>expired</html>'))).fetch }),
    ).rejects.toMatchObject({ code: 'not_a_pdf' })
    // A storage host's generic binary type is accepted only for real PDF bytes.
    const octet = await downloadSignedPdf('https://f.example.invalid/x', { env, fetch: stubFetch(pdfAnswer(PDF, 'application/octet-stream')).fetch })
    expect(octet.equals(PDF)).toBe(true)
  })

  it('caps the size: a declared length over the cap, or more bytes than the cap, is refused', async () => {
    expect(ESIGNATURES_PDF_MAX_BYTES).toBe(25 * 1024 * 1024)
    const declared = stubFetch(pdfAnswer(PDF, 'application/pdf', { 'content-length': String(ESIGNATURES_PDF_MAX_BYTES + 1) }))
    await expect(downloadSignedPdf('https://f.example.invalid/x', { env, fetch: declared.fetch })).rejects.toMatchObject({ code: 'too_large' })
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(64)])
    await expect(
      downloadSignedPdf('https://f.example.invalid/x', { env, fetch: stubFetch(pdfAnswer(big)).fetch, maxBytes: 32 }),
    ).rejects.toMatchObject({ code: 'too_large' })
  })

  it('a non-2xx answer (an expired link) is an error with its status', async () => {
    const error = await downloadSignedPdf('https://f.example.invalid/x', { env, fetch: stubFetch(new Response('gone', { status: 403 })).fetch }).catch((e) => e)
    expect(error).toMatchObject({ name: 'EsignaturesError', status: 403 })
  })
})

describe('redact', () => {
  it('takes out the token, addresses, long blobs and a URL\'s query string', () => {
    const text = `token ${TOKEN} for pat@example.invalid at https://files.example.invalid/x.pdf?X-Amz-Signature=abcdef and ${'A'.repeat(220)}`
    const out = redact(text, [], env)
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain('pat@example.invalid')
    expect(out).not.toContain('X-Amz-Signature')
    expect(out).toContain('https://files.example.invalid/x.pdf?[query]')
    expect(out).not.toContain('A'.repeat(220))
  })
})
