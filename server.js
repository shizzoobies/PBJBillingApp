import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppDataStore } from './db/store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')
const indexFile = path.join(distDir, 'index.html')
const port = Number(process.env.PORT || 4173)
const appDataStore = new AppDataStore()
const sessionCookieName = 'pbj_session'

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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  response.end(JSON.stringify(payload))
}

function sendEmpty(response, statusCode, headers = {}) {
  response.writeHead(statusCode, headers)
  response.end()
}

function parseCookies(headerValue) {
  if (!headerValue) {
    return {}
  }

  return Object.fromEntries(
    headerValue
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=')
        if (separatorIndex === -1) {
          return [part, '']
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))]
      }),
  )
}

function buildSessionCookie(sessionId, expiresAt) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secureFlag}`
}

function clearSessionCookie() {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`
}

async function readJsonBody(request) {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(chunk)
  }

  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : null
}

async function requireSession(request, response) {
  const cookies = parseCookies(request.headers.cookie)
  const session = await appDataStore.getSession(cookies[sessionCookieName])
  if (!session) {
    sendJson(response, 401, { error: 'Authentication required' })
    return null
  }

  return session
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const normalizedPath = decodeURIComponent(requestUrl.pathname)

    if (normalizedPath === '/health') {
      sendJson(response, 200, { ok: true, mode: appDataStore.mode })
      return
    }

    if (normalizedPath === '/api/login-options' && request.method === 'GET') {
      const users = await appDataStore.getLoginOptions()
      sendJson(response, 200, { users })
      return
    }

    if (normalizedPath === '/api/session' && request.method === 'GET') {
      const cookies = parseCookies(request.headers.cookie)
      const session = await appDataStore.getSession(cookies[sessionCookieName])
      sendJson(response, 200, { user: session?.user ?? null })
      return
    }

    if (normalizedPath === '/api/login' && request.method === 'POST') {
      const payload = await readJsonBody(request)
      const userId = typeof payload?.userId === 'string' ? payload.userId : ''
      const password = typeof payload?.password === 'string' ? payload.password : ''

      if (!userId || !password) {
        sendJson(response, 400, { error: 'User and password are required' })
        return
      }

      const session = await appDataStore.createSession(userId, password)
      if (!session) {
        sendJson(response, 401, { error: 'Invalid credentials' })
        return
      }

      response.setHeader('Set-Cookie', buildSessionCookie(session.sessionId, session.expiresAt))
      sendJson(response, 200, { user: session.user })
      return
    }

    if (normalizedPath === '/api/logout' && request.method === 'POST') {
      const cookies = parseCookies(request.headers.cookie)
      await appDataStore.deleteSession(cookies[sessionCookieName])
      response.setHeader('Set-Cookie', clearSessionCookie())
      sendEmpty(response, 204)
      return
    }

    if (normalizedPath === '/api/app-data') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method === 'GET') {
        const data = await appDataStore.read()
        sendJson(response, 200, data)
        return
      }

      if (request.method === 'PUT') {
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can update workspace configuration' })
          return
        }

        const data = await readJsonBody(request)
        await appDataStore.write(data)
        sendJson(response, 200, { ok: true })
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    if (normalizedPath === '/api/time-entries') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method === 'POST') {
        const payload = await readJsonBody(request)
        const employeeId =
          session.user.role === 'owner'
            ? typeof payload?.employeeId === 'string'
              ? payload.employeeId
              : ''
            : session.user.id

        const clientId = typeof payload?.clientId === 'string' ? payload.clientId : ''
        const date = typeof payload?.date === 'string' ? payload.date : ''
        const minutes = typeof payload?.minutes === 'number' ? payload.minutes : Number(payload?.minutes)
        const category = typeof payload?.category === 'string' ? payload.category : ''
        const description = typeof payload?.description === 'string' ? payload.description : ''
        const billable = Boolean(payload?.billable)

        if (!employeeId || !clientId || !date || Number.isNaN(minutes) || minutes <= 0 || !category) {
          sendJson(response, 400, { error: 'Invalid time entry payload' })
          return
        }

        const entry = await appDataStore.createTimeEntry({
          employeeId,
          clientId,
          date,
          minutes,
          category,
          description,
          billable,
        })

        sendJson(response, 201, entry)
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    if (normalizedPath === '/api/checklists') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method === 'POST') {
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can create checklists' })
          return
        }

        const payload = await readJsonBody(request)
        const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
        const clientId = typeof payload?.clientId === 'string' ? payload.clientId : ''
        const assigneeId = typeof payload?.assigneeId === 'string' ? payload.assigneeId : ''
        const dueDate = typeof payload?.dueDate === 'string' ? payload.dueDate : ''
        const items = Array.isArray(payload?.items)
          ? payload.items
              .map((item) => ({
                id: typeof item?.id === 'string' ? item.id : undefined,
                label: typeof item?.label === 'string' ? item.label.trim() : '',
                done: Boolean(item?.done),
              }))
              .filter((item) => item.label)
          : []

        if (!title || !clientId || !assigneeId || !dueDate || items.length === 0) {
          sendJson(response, 400, { error: 'Invalid checklist payload' })
          return
        }

        const data = await appDataStore.read()
        const clientExists = data.clients.some((client) => client.id === clientId)
        const assigneeExists = data.employees.some((employee) => employee.id === assigneeId && employee.role !== 'Owner')

        if (!clientExists || !assigneeExists) {
          sendJson(response, 400, { error: 'Checklist references an invalid client or assignee' })
          return
        }

        const checklist = await appDataStore.createChecklist({
          title,
          clientId,
          assigneeId,
          dueDate,
          items,
        })

        sendJson(response, 201, checklist)
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    const checklistToggleMatch = normalizedPath.match(/^\/api\/checklists\/([^/]+)\/items\/([^/]+)\/toggle$/)
    if (checklistToggleMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      const checklistId = checklistToggleMatch[1]
      const itemId = checklistToggleMatch[2]
      const data = await appDataStore.read()
      const checklist = data.checklists.find((entry) => entry.id === checklistId)

      if (!checklist) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      if (session.user.role !== 'owner' && checklist.assigneeId !== session.user.id) {
        sendJson(response, 403, { error: 'You can only update your assigned checklists' })
        return
      }

      const itemExists = checklist.items.some((item) => item.id === itemId)
      if (!itemExists) {
        sendJson(response, 404, { error: 'Checklist item not found' })
        return
      }

      const updatedChecklist = await appDataStore.toggleChecklistItem(checklistId, itemId)
      if (!updatedChecklist) {
        sendJson(response, 404, { error: 'Checklist item not found' })
        return
      }

      sendJson(response, 200, updatedChecklist)
      return
    }

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
  } catch (error) {
    console.error(error)
    sendJson(response, 500, { error: 'Server error' })
  }
})

await appDataStore.initialize()

server.listen(port, '0.0.0.0', () => {
  console.log(`PBJ Strategic Accounting app listening on ${port}`)
})
