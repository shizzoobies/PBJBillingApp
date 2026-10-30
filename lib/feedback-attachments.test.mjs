// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import PDFDocument from 'pdfkit'
import { fixtureZip, officeEntries } from './feedback-test-fixtures.mjs'
import { FeedbackAttachmentLedger } from '../db/feedback-attachments.js'
import { handleFeedbackAttachmentRoute } from './feedback-attachment-routes.js'
import { createAttachmentStorage } from './feedback-storage.js'
import { validateAttachment, MAX_FILE_BYTES } from './feedback-files.js'

let directory, ledger, server, base, objects, storage, parents, time, paused
const sendJson = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
const input = (bytes = Buffer.from('local fixture'), filename = 'notes.txt', uploadId = randomUUID()) => ({ bytes, filename, uploadId })
const file = async (...args) => validateAttachment(input(...args))
const multipart = (bytes = Buffer.from('local fixture'), filename = 'notes.txt', id = randomUUID()) => {
  const form = new FormData(); form.append('upload_id', id); form.append('file', new Blob([bytes]), filename); return form
}
const request = (suffix = '', init = {}) => fetch(`${base}/api/feature-requests/parent/attachments${suffix}`, { ...init, headers: { Cookie: 'owner', ...init.headers } })

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'pbj-feedback-'))
  time = Date.now(); paused = false; parents = new Set(['parent', 'other'])
  ledger = new FeedbackAttachmentLedger({ file: path.join(directory, 'ledger.json'), getParent: async (id) => parents.has(id),
    deleteFileParent: async (id) => parents.delete(id), now: () => time, paused: () => paused })
  objects = new Map()
  storage = { put: async (key, bytes) => { objects.set(key, bytes) }, get: async (key) => objects.get(key), delete: async (key) => { objects.delete(key) } }
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const handled = await handleFeedbackAttachmentRoute({ request: req, response: res, pathname: url.pathname, url, ledger, storage, sendJson,
      requireSession: async (r, response) => { if (!r.headers.cookie) { sendJson(response, 401, { error: 'Authentication required' }); return null }; return { user: { id: r.headers.cookie, role: r.headers.cookie === 'staff' ? 'bookkeeper' : 'owner' } } },
      isCrossSiteOrigin: (r) => r.headers.origin === 'https://evil.example',
    })
    if (!handled) sendJson(res, 404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })

describe('real HTTP attachment handler', () => {
  it('round-trips bytes, metadata, duplicate retries and safe headers', async () => {
    const id = randomUUID()
    const created = await request('', { method: 'POST', body: multipart(undefined, 'owner notes.txt', id) })
    expect(created.status).toBe(201)
    const { attachment } = await created.json()
    expect(attachment).not.toHaveProperty('objectKey')
    expect((await (await request()).json()).attachments).toHaveLength(1)
    expect((await request('', { method: 'POST', body: multipart(undefined, 'owner notes.txt', id) })).status).toBe(200)
    expect(objects.size).toBe(1)
    expect((await request('', { method: 'POST', body: multipart(Buffer.from('different'), 'owner notes.txt', id) })).status).toBe(409)
    const downloaded = await request(`/${attachment.id}?preview=1`)
    expect(await downloaded.text()).toBe('local fixture')
    expect(downloaded.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(downloaded.headers.get('cache-control')).toBe('private, no-store')
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff')
    expect(downloaded.headers.get('content-security-policy')).toContain('sandbox')
    expect((await fetch(`${base}/api/feature-requests/other/attachments/${attachment.id}`, { headers: { Cookie: 'owner' } })).status).toBe(404)
    expect((await request(`/${attachment.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(objects.size).toBe(1)
    await ledger.cleanup(storage)
    expect(objects.size).toBe(0)
    expect((await request(`/${attachment.id}`)).status).toBe(404)
  })
  it.each([{ Cookie: '' }, { Cookie: 'staff' }, { 'X-Preview-Mode': '1' }, { 'X-Preview-As': 'staff' }])('denies all operations for %j', async (headers) => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await request(method === 'DELETE' ? '/unknown' : '', { method, headers, ...(method === 'POST' ? { body: multipart() } : {}) })
      expect(response.status).toBe(headers.Cookie === '' ? 401 : 403)
    }
    expect(objects.size).toBe(0)
  })
  it('checks origin, parent, maintenance and strict multipart before storage', async () => {
    expect((await request('', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: multipart() })).status).toBe(403)
    expect((await request('', { method: 'POST', body: 'raw bytes' })).status).toBe(415)
    const extra = multipart(); extra.append('surprise', 'value')
    expect((await request('', { method: 'POST', body: extra })).status).toBe(400)
    const duplicate = multipart(); duplicate.append('file', new Blob(['second']), 'second.txt')
    expect((await request('', { method: 'POST', body: duplicate })).status).toBe(400)
    expect((await request('', { method: 'POST', body: multipart(Buffer.alloc(MAX_FILE_BYTES + 1, 65)) })).status).toBe(413)
    paused = true
    expect((await request('', { method: 'POST', body: multipart() })).status).toBe(503)
    paused = false; parents.delete('parent')
    expect((await request('', { method: 'POST', body: multipart() })).status).toBe(404)
    expect(objects.size).toBe(0)
  })
  it('permits exactly 10 MiB and previews only decoded images', async () => {
    expect((await request('', { method: 'POST', body: multipart(Buffer.alloc(MAX_FILE_BYTES, 65)) })).status).toBe(201)
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer()
    const response = await request('', { method: 'POST', body: multipart(png, 'picture.png') })
    expect(response.status).toBe(201)
    const { attachment } = await response.json()
    const preview = await request(`/${attachment.id}?preview=1`)
    expect(preview.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png)
  })
  it('does not duplicate an in-flight upload and recovers a failed PUT', async () => {
    let release
    let entered
    const started = new Promise((resolve) => { entered = resolve })
    storage.put = async () => { entered(); await new Promise((resolve) => { release = resolve }); throw new Error('private provider detail') }
    const id = randomUUID()
    const first = request('', { method: 'POST', body: multipart(undefined, 'notes.txt', id) })
    await started
    expect((await request('', { method: 'POST', body: multipart(undefined, 'notes.txt', id) })).status).toBe(409)
    release()
    const failed = await first
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('private provider')
    storage.put = async (key, bytes) => objects.set(key, bytes)
    expect((await request('', { method: 'POST', body: multipart(undefined, 'notes.txt', id) })).status).toBe(201)
  })
})

describe('durable lifecycle', () => {
  it('keeps a committed attachment after a lost finalization acknowledgement', async () => {
    const original = await file()
    const { row } = await ledger.reserve('parent', original, 'owner')
    const ready = await ledger.finish(row)
    await ledger.fail(row)
    expect(await ledger.finish(row)).toEqual(ready)
    expect((await ledger.reserve('parent', original, 'owner')).existing).toBe(true)
    expect(await ledger.list('parent')).toEqual([ready])
  })
  it('leaves in-flight intents untouched when maintenance starts', async () => {
    const { row } = await ledger.reserve('parent', await file(), 'owner')
    const before = await readFile(path.join(directory, 'ledger.json'), 'utf8')
    paused = true
    expect(await ledger.finish(row)).toBeNull()
    await ledger.fail(row)
    await ledger.cleanup(storage)
    expect(await readFile(path.join(directory, 'ledger.json'), 'utf8')).toBe(before)
  })
  it('enforces quota under concurrency and survives reload without workspace bytes', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, async () => ledger.reserve('parent', await file(), 'owner')))
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(2)
    const saved = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'))
    expect(saved.rows[0]).not.toHaveProperty('bytes')
    const reloaded = new FeedbackAttachmentLedger({ file: path.join(directory, 'ledger.json'), getParent: async () => true })
    expect(await reloaded.list('parent')).toEqual([])
  })
  it('recovers crashes before PUT and after PUT; prevents late publication', async () => {
    const before = await ledger.reserve('parent', await file(), 'owner')
    const after = await ledger.reserve('parent', await file(), 'owner')
    objects.set(after.row.objectKey, Buffer.from('orphan'))
    time += 120001
    await ledger.cleanup(storage)
    expect(objects.size).toBe(0)
    expect(await ledger.finish(before.row)).toBeNull()
    expect(await ledger.finish(after.row)).toBeNull()
    expect(await ledger.list('parent')).toEqual([])
  })
  it('queues parent deletion atomically and a stale auth write cannot resurrect it', async () => {
    const reservation = await ledger.reserve('parent', await file(), 'owner')
    objects.set(reservation.row.objectKey, Buffer.from('fixture'))
    await ledger.finish(reservation.row)
    expect(await ledger.removeParent('parent')).toBe(true)
    parents.add('parent')
    expect(await ledger.parentExists('parent')).toBe(false)
    await expect(ledger.reserve('parent', await file(), 'owner')).rejects.toMatchObject({ status: 404 })
    await ledger.cleanup(storage)
    expect(objects.size).toBe(0)
  })
  it('durably retries cleanup, pauses during maintenance and protects restored references', async () => {
    const { row } = await ledger.reserve('parent', await file(), 'owner')
    objects.set(row.objectKey, Buffer.from('fixture')); await ledger.finish(row)
    await ledger.remove('parent', row.id)
    storage.delete = async () => { throw new Error('offline') }
    await ledger.cleanup(storage)
    let state = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'))
    expect(state.jobs[0].attempts).toBe(1)
    time += 60001; paused = true
    storage.delete = async (key) => objects.delete(key)
    await ledger.cleanup(storage)
    expect(objects.size).toBe(1)
    await ledger.transaction(async (tx) => { await tx.put({ ...row, state: 'ready', leaseUntil: 0 }) })
    paused = false; await ledger.cleanup(storage)
    expect(objects.size).toBe(1)
    state = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'))
    expect(state.jobs).toEqual([])
  })
  it('holds the lifecycle lock across reference check and object deletion', async () => {
    const { row } = await ledger.reserve('parent', await file(), 'owner'); await ledger.finish(row); await ledger.remove('parent', row.id)
    let release, entered
    const started = new Promise((resolve) => { entered = resolve })
    storage.delete = async () => { entered(); await new Promise((resolve) => { release = resolve }) }
    const cleaning = ledger.cleanup(storage); await started
    let acquired = false
    const restore = ledger.transaction(async () => { acquired = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(acquired).toBe(false)
    release(); await cleaning; await restore
    expect(acquired).toBe(true)
  })
})

describe('file validation and fail-closed storage', () => {
  it.each(['docx', 'xlsx', 'pptx'])('validates %s structure and rejects fake, macro and unsafe packages', async (extension) => {
    const entries = officeEntries(extension)
    expect((await file(fixtureZip(entries), `document.${extension}`)).contentType).toContain('openxmlformats')
    await expect(file(fixtureZip(entries.map(([name]) => [name, ''])), `fake.${extension}`)).rejects.toThrow()
    await expect(file(fixtureZip([...entries, ['../escape', 'x']]), `unsafe.${extension}`)).rejects.toThrow()
    await expect(file(fixtureZip([...entries, ['word/vbaProject.bin', 'macro']]), `macro.${extension}`)).rejects.toThrow()
    await expect(file(fixtureZip([...entries, ['word/embeddings/file.bin', 'embedded']]), `embedded.${extension}`)).rejects.toThrow()
    await expect(file(fixtureZip([...entries, ...Array.from({ length: 501 }, (_, i) => [`part${i}`, 'x'])]), `many.${extension}`)).rejects.toThrow()
    await expect(file(fixtureZip(entries), extension === 'docx' ? 'wrong.xlsx' : 'wrong.docx')).rejects.toThrow()
  })
  it('accepts a real generated PDF', async () => {
    const bytes = await new Promise((resolve) => {
      const pdf = new PDFDocument(); const chunks = []
      pdf.on('data', (chunk) => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks)))
      pdf.text('Fictional feedback fixture'); pdf.end()
    })
    expect((await file(bytes, 'example.pdf')).contentType).toBe('application/pdf')
  })
  it.each(['jpeg', 'png', 'gif', 'webp'])('decodes %s and rejects type spoofing and truncation', async (format) => {
    const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } }).toFormat(format).toBuffer()
    expect((await file(bytes, `picture.${format}`)).contentType).toBe(`image/${format}`)
    await expect(file(bytes.subarray(0, 10), `picture.${format}`)).rejects.toThrow()
    await expect(file(Buffer.from('<svg/>'), `picture.${format}`)).rejects.toThrow()
  })
  it('validates UTF-8 and rejects empty, executable, control and active text files', async () => {
    expect((await file(Buffer.from('name,total\nfixture,5'), 'data.csv')).contentType).toBe('text/csv')
    expect((await file(undefined, '../../notes.txt')).filename).toBe('notes.txt')
    for (const [bytes, name] of [[Buffer.alloc(0), 'empty.txt'], [Buffer.from([0xff]), 'bad.txt'], [Buffer.from('a\0b'), 'bad.csv'], [Buffer.from('<script>alert(1)</script>'), 'bad.txt'], [Buffer.from('x'), 'bad.exe'], [Buffer.from('x'), 'bad\nname.txt']]) await expect(file(bytes, name)).rejects.toThrow()
  })
  it('rejects invalid PDFs and Office containers', async () => {
    await expect(file(Buffer.from('%PDF fake'), 'bad.pdf')).rejects.toThrow()
    for (const name of ['bad.docx', 'bad.xlsx', 'bad.pptx']) await expect(file(Buffer.from('not a zip'), name)).rejects.toThrow()
  })
  it('forbids production local storage and uses a separate local directory', async () => {
    await expect(createAttachmentStorage({ NODE_ENV: 'production', FEEDBACK_STORAGE: 'local', FEEDBACK_LOCAL_DIRECTORY: directory }).put('anything', Buffer.from('x'))).rejects.toMatchObject({ status: 503 })
    const local = createAttachmentStorage({ NODE_ENV: 'test', FEEDBACK_STORAGE: 'local', FEEDBACK_LOCAL_DIRECTORY: path.join(directory, 'objects') })
    const key = `feedback/${randomUUID()}/${randomUUID()}`
    await local.put(key, Buffer.from('fixture')); expect(await local.get(key)).toEqual(Buffer.from('fixture'))
    await expect(local.put('../escape', Buffer.from('x'))).rejects.toThrow()
    await local.delete(key); await local.delete(key)
    await expect(local.get(key)).rejects.toMatchObject({ status: 404 })
  })
})
