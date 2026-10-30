import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { AttachmentError, MAX_FILE_BYTES } from './feedback-files.js'

export const isAttachmentKey = (key) => /^feedback\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)
function checkKey(key) { if (!isAttachmentKey(key)) throw new Error('Invalid attachment object key') }
const unavailable = () => new AttachmentError(503, 'Attachment storage is unavailable. Please retry later.')

export function createAttachmentStorage(env = process.env) {
  if (env.FEEDBACK_STORAGE === 'local' && ['development', 'test'].includes(env.NODE_ENV)) {
    const directory = env.FEEDBACK_LOCAL_DIRECTORY
    if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute local attachment directory is required')
    const location = (key) => { checkKey(key); return path.join(directory, key) }
    return {
      async put(key, bytes) { const file = location(key); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { flag: 'wx' }) },
      async get(key) { try { return await readFile(location(key)) } catch (error) { if (error.code === 'ENOENT') throw new AttachmentError(404, 'This attachment is no longer available.'); throw error } },
      async delete(key) { try { await unlink(location(key)) } catch (error) { if (error.code !== 'ENOENT') throw error } },
    }
  }
  if (env.FEEDBACK_STORAGE !== 'r2' || !env.FEEDBACK_R2_ENDPOINT || !env.FEEDBACK_R2_BUCKET
    || !env.FEEDBACK_R2_ACCESS_KEY_ID || !env.FEEDBACK_R2_SECRET_ACCESS_KEY
    || !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/.test(env.FEEDBACK_R2_ENDPOINT)) {
    return { put: async () => { throw unavailable() }, get: async () => { throw unavailable() }, delete: async () => { throw unavailable() } }
  }
  const client = new S3Client({ region: 'auto', endpoint: env.FEEDBACK_R2_ENDPOINT, maxAttempts: 2,
    credentials: { accessKeyId: env.FEEDBACK_R2_ACCESS_KEY_ID, secretAccessKey: env.FEEDBACK_R2_SECRET_ACCESS_KEY },
    requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
  })
  const send = (Command, key, extra = {}) => {
    checkKey(key)
    return client.send(new Command({ Bucket: env.FEEDBACK_R2_BUCKET, Key: key, ...extra }), { abortSignal: AbortSignal.timeout(25000) })
  }
  return {
    async put(key, bytes, contentType) { await send(PutObjectCommand, key, { Body: bytes, ContentType: contentType, ContentLength: bytes.length }) },
    async get(key) {
      let result
      try { result = await send(GetObjectCommand, key) } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) throw new AttachmentError(404, 'This attachment is no longer available.')
        throw unavailable()
      }
      if (!result.ContentLength || result.ContentLength > MAX_FILE_BYTES) { result.Body?.destroy(); throw unavailable() }
      const chunks = []
      let size = 0
      const timer = setTimeout(() => result.Body.destroy(new Error('Read timeout')), 25000)
      try {
        for await (const chunk of result.Body) {
          size += chunk.length
          if (size > MAX_FILE_BYTES) throw unavailable()
          chunks.push(chunk)
        }
        return Buffer.concat(chunks)
      } finally { clearTimeout(timer); result.Body?.destroy() }
    },
    async delete(key) { await send(DeleteObjectCommand, key) },
  }
}
