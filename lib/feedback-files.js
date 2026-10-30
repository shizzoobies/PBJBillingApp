import path from 'node:path'
import { createHash } from 'node:crypto'
import Busboy from 'busboy'
import sharp from 'sharp'
import yauzl from 'yauzl'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
export class AttachmentError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad = (message) => new AttachmentError(400, message)
const types = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export function safeFilename(name) {
  if (typeof name !== 'string' || /[\x00-\x1f\x7f]/.test(name)) throw bad('Invalid filename.')
  const clean = name.replaceAll('\\', '/').split('/').at(-1).trim()
  if (!clean || clean.length > 200 || Buffer.byteLength(clean) > 600) throw bad('Use a filename of 200 characters or fewer.')
  return clean
}

// The parser owns the stream only after authorization. Reject excessive overhead,
// duplicate fields and unknown parts as well as files over the advertised limit.
export function readAttachment(request) {
  return new Promise((resolve, reject) => {
    let parser
    try {
      parser = Busboy({ headers: request.headers, defParamCharset: 'utf8', preservePath: true, limits: {
        fileSize: MAX_FILE_BYTES + 1, files: 1, fields: 1, parts: 3, fieldSize: 64, fieldNameSize: 32,
      } })
    } catch { reject(new AttachmentError(415, 'A multipart file upload is required.')); return }
    let settled = false
    let bytes = 0
    let fileCount = 0
    let filename
    let uploadId
    const chunks = []
    const done = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.off('data', count)
      request.off('aborted', aborted)
      request.off('error', aborted)
      if (error) { request.unpipe(parser); queueMicrotask(() => parser.destroy()); request.resume(); reject(error) }
      else resolve({ filename, uploadId, bytes: Buffer.concat(chunks) })
    }
    const count = (chunk) => { bytes += chunk.length; if (bytes > MAX_FILE_BYTES + 65536) done(new AttachmentError(413, 'File must be 10 MB or smaller.')) }
    const aborted = () => done(bad('Upload interrupted. Please retry.'))
    const timer = setTimeout(() => done(new AttachmentError(408, 'Upload timed out. Please retry.')), 30000)
    request.on('data', count).once('aborted', aborted).once('error', aborted)
    parser.on('file', (name, stream, info) => {
      fileCount++
      stream.on('error', aborted)
      if (name !== 'file') { stream.resume(); done(bad('Upload exactly one file.')); return }
      filename = info.filename
      stream.on('data', (chunk) => { if (!settled) chunks.push(chunk) })
      stream.once('limit', () => done(new AttachmentError(413, 'File must be smaller than or equal to 10 MB.')))
    })
    parser.on('field', (name, value, info) => {
      if (name !== 'upload_id' || uploadId || info.valueTruncated || info.nameTruncated) { done(bad('Invalid upload ID.')); return }
      uploadId = value
    })
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => done(bad('Upload exactly one file and upload ID.')))
    parser.on('error', () => done(bad('Malformed file upload.')))
    parser.on('close', () => {
      if (fileCount !== 1 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(uploadId ?? '')) done(bad('Upload a file with a valid upload ID.'))
      else done()
    })
    request.pipe(parser)
  })
}

function validateOffice(bytes, extension) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) { reject(bad('This Office document is damaged.')); return }
      let count = 0
      let total = 0
      let actual = 0
      let finished = false
      const names = new Set()
      const critical = new Map()
      const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[extension]
      const finish = (failure) => { if (finished) return; finished = true; zip.close(); if (failure) reject(failure); else resolve() }
      zip.on('error', () => finish(bad('This Office document is damaged.')))
      zip.on('entry', (entry) => {
        const name = entry.fileName
        count++; total += entry.uncompressedSize
        if (count > 500 || total > 50 * 1024 * 1024 || names.has(name) || /(^\/|(^|\/)\.\.?\/|:|\\|[\x00-\x1f])/u.test(name)
          || /vbaproject|(?:^|\/)embeddings\/|activex\//i.test(name) || (entry.generalPurposeBitFlag & 1)) {
          finish(bad('This document contains unsupported or unsafe ZIP entries.')); return
        }
        names.add(name)
        if (name.endsWith('/')) { zip.readEntry(); return }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { finish(bad('This Office document is damaged.')); return }
          stream.on('error', () => finish(bad('This Office document is damaged.')))
          const chunks = []
          const inspect = ['[Content_Types].xml', '_rels/.rels', main].includes(name)
          if (inspect && entry.uncompressedSize > 5 * 1024 * 1024) { stream.destroy(); finish(bad('This document XML exceeds the supported size.')); return }
          stream.on('data', (chunk) => {
            actual += chunk.length
            if (inspect) chunks.push(chunk)
            if (actual > 50 * 1024 * 1024) { stream.destroy(); finish(bad('This document expands beyond the supported size.')) }
          })
          stream.on('end', () => {
            if (inspect) critical.set(name, Buffer.concat(chunks).toString('utf8'))
            if (!finished) zip.readEntry()
          })
        })
      })
      zip.on('end', () => {
        const contentTypes = critical.get('[Content_Types].xml') ?? ''
        const relationships = critical.get('_rels/.rels') ?? ''
        const document = critical.get(main) ?? ''
        const mime = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' }[extension]
        const root = { docx: 'document', xlsx: 'workbook', pptx: 'presentation' }[extension]
        const safe = [...critical.values()].every((xml) => !/<!DOCTYPE|<!ENTITY|macroEnabled|vbaProject|<\s*script\b/i.test(xml))
        const override = [...contentTypes.matchAll(/<(?:[\w-]+:)?Override\b[^>]*>/g)].some(([tag]) =>
          new RegExp(`\\bPartName\\s*=\\s*["']/${main.replaceAll('.', '\\.')}["']`).test(tag)
          && tag.includes(mime))
        finish(safe && override && /<(?:[\w-]+:)?Types\b/.test(contentTypes)
          && /<(?:[\w-]+:)?Relationships\b/.test(relationships) && relationships.includes(main)
          && new RegExp(`<(?:[\\w-]+:)?${root}\\b`).test(document)
          && new RegExp(`</(?:[\\w-]+:)?${root}\\s*>\\s*$`).test(document)
          ? null : bad('The file does not match its Office document type.'))
      })
      zip.readEntry()
    })
  })
}

export async function validateAttachment(input) {
  const filename = safeFilename(input.filename)
  const extension = path.extname(filename).slice(1).toLowerCase()
  const contentType = types[extension]
  const bytes = input.bytes
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw bad('Choose a nonempty file of 10 MB or smaller.')
  if (!contentType) throw bad('Choose a supported picture, PDF, Office document, TXT or CSV file.')
  if (contentType.startsWith('image/')) {
    try {
      const decoder = sharp(bytes, { limitInputPixels: 25000000, failOn: 'warning', animated: true }).timeout({ seconds: 10 })
      const metadata = await decoder.metadata()
      if (metadata.format !== (extension === 'jpg' ? 'jpeg' : extension) || (metadata.pages ?? 1) > 100) throw new Error('Format')
      await decoder.raw().toBuffer()
    } catch { throw bad('This picture is damaged, too large, or does not match its file type.') }
  } else if (['docx', 'xlsx', 'pptx'].includes(extension)) await validateOffice(bytes, extension)
  else if (extension === 'pdf') {
    const text = bytes.toString('latin1')
    if (!/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(text) || !/%%EOF\s*$/.test(text) || !/\b\d+\s+\d+\s+obj\b/.test(text) || !/startxref\s+\d+\s+%%EOF\s*$/.test(text)) throw bad('This PDF is damaged or does not match its file type.')
  } else {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw bad('Text and CSV files must use UTF-8 encoding.') }
    if (/\x00|<\s*(?:!doctype|html\b|script\b|svg\b|iframe\b|object\b|embed\b)/i.test(text)) throw bad('Active web content is not allowed in text attachments.')
  }
  return { filename, contentType, size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), uploadId: input.uploadId, bytes }
}
