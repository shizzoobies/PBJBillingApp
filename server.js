import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')
const indexFile = path.join(distDir, 'index.html')
const port = Number(process.env.PORT || 4173)

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  response.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(filePath).pipe(response)
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const normalizedPath = decodeURIComponent(requestUrl.pathname)
    const requestedFile = path.join(distDir, normalizedPath)
    const safePath = path.normalize(requestedFile)

    if (!safePath.startsWith(distDir)) {
      response.writeHead(403)
      response.end('Forbidden')
      return
    }

    if (existsSync(safePath)) {
      const fileStats = await stat(safePath)
      if (fileStats.isFile()) {
        sendFile(response, safePath)
        return
      }
    }

    sendFile(response, indexFile)
  } catch {
    response.writeHead(500)
    response.end('Server error')
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`PBJ Strategic Accounting app listening on ${port}`)
})
