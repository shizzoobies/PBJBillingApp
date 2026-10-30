import { createHash } from 'node:crypto'
import { AttachmentError, readAttachment, validateAttachment } from './feedback-files.js'
import { attachmentMetadata } from '../db/feedback-attachments.js'

let activeUploads = 0
export async function handleFeedbackAttachmentRoute({ request, response, pathname, url, ledger, storage, requireSession, isCrossSiteOrigin, sendJson }) {
  const match = /^\/api\/feature-requests\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(pathname)
  if (!match) return false
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
  let reserved
  let uploading = false
  try {
    const session = await requireSession(request, response)
    if (!session) return true
    if (session.user.role !== 'owner' || request.headers['x-preview-mode'] || request.headers['x-preview-as'] || url.searchParams.has('previewAs')) throw new AttachmentError(403, 'Attachments are available only to owners outside preview mode.')
    const [, parentId, id] = match
    if (!await ledger.parentExists(parentId)) throw new AttachmentError(404, 'Update not found.')
    const method = request.method
    if (!['GET', 'POST', 'DELETE'].includes(method) || (method === 'POST' && id) || (method === 'DELETE' && !id)) throw new AttachmentError(405, 'Method not allowed.')
    if (method !== 'GET' && isCrossSiteOrigin(request)) throw new AttachmentError(403, 'Origin not allowed.')
    if (method === 'GET' && !id) sendJson(response, 200, { attachments: await ledger.list(parentId) })
    else if (method === 'GET') {
      const row = await ledger.get(parentId, id)
      const bytes = await storage.get(row.objectKey)
      if (bytes.length !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.digest) throw new AttachmentError(503, 'This attachment is unavailable. Please retry later.')
      const inline = url.searchParams.get('preview') === '1' && row.contentType.startsWith('image/')
      const fallback = row.filename.replace(/[^a-zA-Z0-9._ -]/g, '_')
      response.writeHead(200, { ...headers, 'Content-Type': row.contentType, 'Content-Length': bytes.length,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}` })
      response.end(bytes)
    } else if (method === 'DELETE') {
      await ledger.remove(parentId, id)
      sendJson(response, 200, { removed: true })
    } else {
      ledger.assertActive()
      if (activeUploads >= 2) throw new AttachmentError(429, 'Other files are uploading. Please retry shortly.')
      activeUploads++; uploading = true
      const file = await validateAttachment(await readAttachment(request))
      if (request.aborted || response.destroyed) return true
      const reservation = await ledger.reserve(parentId, file, session.user.id)
      if (reservation.existing) sendJson(response, 200, { attachment: attachmentMetadata(reservation.row) })
      else {
        reserved = reservation.row
        await storage.put(reserved.objectKey, file.bytes, file.contentType)
        const attachment = await ledger.finish(reserved)
        reserved = null
        if (!attachment) throw new AttachmentError(409, 'This upload expired or the update was removed. Please retry.')
        sendJson(response, 201, { attachment })
      }
    }
  } catch (error) {
    if (reserved) { try { await ledger.fail(reserved) } catch { /* Durable pending intent is recovered by the cleanup job. */ } }
    if (!response.headersSent && !response.destroyed) sendJson(response, error instanceof AttachmentError ? error.status : 503,
      { error: error instanceof AttachmentError ? error.message : 'Attachments are unavailable. Please retry later.' })
  } finally { if (uploading) activeUploads-- }
  return true
}
