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

function getPublicAppUrl(request) {
  const configured = process.env.APP_PUBLIC_URL
  if (configured) {
    return configured.replace(/\/$/, '')
  }

  const host = request.headers.host || `localhost:${port}`
  const proto =
    request.headers['x-forwarded-proto'] ||
    (process.env.NODE_ENV === 'production' ? 'https' : 'http')
  return `${proto}://${host}`
}

function buildMagicUrl(request, token) {
  if (!token) {
    return null
  }
  return `${getPublicAppUrl(request)}/login/${encodeURIComponent(token)}`
}

function decorateTeamMember(member, request) {
  if (!member) {
    return member
  }
  return {
    ...member,
    magicUrl: member.tokenRevokedAt ? null : buildMagicUrl(request, member.magicToken),
  }
}

function renderMagicLinkErrorPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Link no longer valid - PB&amp;J Strategic Accounting</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f6f5f1; color: #1f1d1a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; padding: 32px 36px; border-radius: 14px; box-shadow: 0 12px 40px rgba(31, 29, 26, 0.08); max-width: 420px; }
  h1 { margin: 0 0 12px 0; font-size: 22px; }
  p { line-height: 1.5; margin: 0 0 8px 0; color: #555049; }
</style>
</head>
<body>
  <div class="card">
    <h1>This link is no longer valid</h1>
    <p>Contact your owner to request a new sign-in link.</p>
  </div>
</body>
</html>`
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const normalizedPath = decodeURIComponent(requestUrl.pathname)

    if (normalizedPath === '/health') {
      sendJson(response, 200, { ok: true, mode: appDataStore.mode })
      return
    }

    const magicLinkMatch = normalizedPath.match(/^\/login\/([^/]+)$/)
    if (magicLinkMatch && request.method === 'GET') {
      const token = decodeURIComponent(magicLinkMatch[1])
      const user = await appDataStore.findUserByMagicToken(token)
      if (!user || user.tokenRevokedAt) {
        response.writeHead(401, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        response.end(renderMagicLinkErrorPage())
        return
      }

      const session = await appDataStore.createSessionForUser(user.id)
      if (!session) {
        response.writeHead(401, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        response.end(renderMagicLinkErrorPage())
        return
      }

      await appDataStore.recordActivity(user.id, 'login_via_magic_link', '')
      response.writeHead(302, {
        'Set-Cookie': buildSessionCookie(session.sessionId, session.expiresAt),
        Location: '/',
        'Cache-Control': 'no-cache',
      })
      response.end()
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

      await appDataStore.touchUserActivity(session.user.id)
      await appDataStore.recordActivity(session.user.id, 'login_password', '')
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

        await appDataStore.recordActivity(session.user.id, 'checklist_created', checklist.title)
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

      const editorIds = Array.isArray(checklist.editorIds) ? checklist.editorIds : []
      const targetItem = checklist.items.find((item) => item.id === itemId)
      if (!targetItem) {
        sendJson(response, 404, { error: 'Checklist item not found' })
        return
      }

      const itemAssigneeId = typeof targetItem.assigneeId === 'string' ? targetItem.assigneeId : ''
      const canEdit = itemAssigneeId
        ? session.user.role === 'owner' ||
          itemAssigneeId === session.user.id ||
          editorIds.includes(session.user.id)
        : session.user.role === 'owner' ||
          checklist.assigneeId === session.user.id ||
          editorIds.includes(session.user.id)

      if (!canEdit) {
        sendJson(response, 403, { error: 'You can only update your assigned checklists' })
        return
      }

      const toggleResult = await appDataStore.toggleChecklistItem(checklistId, itemId)
      if (!toggleResult || !toggleResult.checklist) {
        sendJson(response, 404, { error: 'Checklist item not found' })
        return
      }

      const updatedChecklist = toggleResult.checklist
      const toggledItem = updatedChecklist.items.find((entry) => entry.id === itemId)
      const action = toggledItem?.done ? 'checklist_item_checked' : 'checklist_item_unchecked'
      await appDataStore.recordActivity(
        session.user.id,
        action,
        `${updatedChecklist.title}: ${toggledItem?.label ?? ''}`.trim(),
      )

      // Phase 3 stage progression activity logging.
      if (toggleResult.spawned) {
        const fromIdx = (updatedChecklist.stageIndex ?? 0) + 1
        const toIdx = fromIdx + 1
        const caseId = updatedChecklist.caseId || updatedChecklist.id
        await appDataStore.recordActivity(
          session.user.id,
          'case_advanced',
          `${updatedChecklist.title} · case ${caseId} · stage ${fromIdx} -> stage ${toIdx}`,
        )
      } else if (
        toggledItem?.done &&
        updatedChecklist.items.every((item) => item.done) &&
        typeof updatedChecklist.stageIndex === 'number' &&
        typeof updatedChecklist.stageCount === 'number' &&
        updatedChecklist.stageIndex + 1 >= updatedChecklist.stageCount
      ) {
        const caseId = updatedChecklist.caseId || updatedChecklist.id
        await appDataStore.recordActivity(
          session.user.id,
          'case_completed',
          `${updatedChecklist.title} · case ${caseId}`,
        )
      }

      sendJson(response, 200, updatedChecklist)
      return
    }

    // POST /api/checklists/:id/items/reorder  — reorder items (owner / assignee / editor)
    const checklistItemsReorderMatch = normalizedPath.match(/^\/api\/checklists\/([^/]+)\/items\/reorder$/)
    if (checklistItemsReorderMatch) {
      const session = await requireSession(request, response)
      if (!session) return

      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      const checklistId = checklistItemsReorderMatch[1]
      const data = await appDataStore.read()
      const checklist = data.checklists.find((c) => c.id === checklistId)
      if (!checklist) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      const editorIds = Array.isArray(checklist.editorIds) ? checklist.editorIds : []
      const canEdit =
        session.user.role === 'owner' ||
        checklist.assigneeId === session.user.id ||
        editorIds.includes(session.user.id)
      if (!canEdit) {
        sendJson(response, 403, { error: 'You do not have permission to reorder items' })
        return
      }

      const payload = await readJsonBody(request)
      const itemIds = Array.isArray(payload?.itemIds)
        ? payload.itemIds.filter((id) => typeof id === 'string')
        : []

      const updated = await appDataStore.reorderChecklistItems(checklistId, itemIds)
      if (!updated) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      await appDataStore.recordActivity(session.user.id, 'checklist_items_reordered', checklist.title)
      sendJson(response, 200, updated)
      return
    }

    // POST /api/checklists/:id/items  — append items (owner / assignee / editor)
    // PATCH /api/checklists/:id/items/:itemId  — edit item (owner / assignee / editor / per-item assignee)
    // DELETE /api/checklists/:id/items/:itemId  — delete item (owner / assignee / editor)
    const checklistItemMatch = normalizedPath.match(/^\/api\/checklists\/([^/]+)\/items(?:\/([^/]+))?$/)
    if (checklistItemMatch) {
      const session = await requireSession(request, response)
      if (!session) return

      const checklistId = checklistItemMatch[1]
      const itemId = checklistItemMatch[2] // undefined for the collection route

      const data = await appDataStore.read()
      const checklist = data.checklists.find((c) => c.id === checklistId)
      if (!checklist) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      const editorIds = Array.isArray(checklist.editorIds) ? checklist.editorIds : []

      // --- POST /api/checklists/:id/items (bulk append) ---
      if (!itemId && request.method === 'POST') {
        const canEdit =
          session.user.role === 'owner' ||
          checklist.assigneeId === session.user.id ||
          editorIds.includes(session.user.id)
        if (!canEdit) {
          sendJson(response, 403, { error: 'You do not have permission to add items' })
          return
        }

        const payload = await readJsonBody(request)
        const titles = Array.isArray(payload?.titles)
          ? payload.titles.filter((t) => typeof t === 'string' && t.trim())
          : []
        if (titles.length === 0) {
          sendJson(response, 400, { error: 'titles must be a non-empty array of strings' })
          return
        }

        const updated = await appDataStore.appendChecklistItems(checklistId, titles)
        if (!updated) {
          sendJson(response, 404, { error: 'Checklist not found' })
          return
        }

        for (const title of titles) {
          await appDataStore.recordActivity(
            session.user.id,
            'checklist_item_added',
            `${checklist.title}: ${title}`,
          )
        }
        sendJson(response, 200, updated)
        return
      }

      // --- PATCH /api/checklists/:id/items/:itemId ---
      if (itemId && request.method === 'PATCH') {
        const targetItem = checklist.items.find((item) => item.id === itemId)
        if (!targetItem) {
          sendJson(response, 404, { error: 'Checklist item not found' })
          return
        }

        // Per-item assignee also gets edit access
        const itemAssigneeId = typeof targetItem.assigneeId === 'string' ? targetItem.assigneeId : ''
        const canEdit = itemAssigneeId
          ? session.user.role === 'owner' ||
            itemAssigneeId === session.user.id ||
            editorIds.includes(session.user.id)
          : session.user.role === 'owner' ||
            checklist.assigneeId === session.user.id ||
            editorIds.includes(session.user.id)
        if (!canEdit) {
          sendJson(response, 403, { error: 'You do not have permission to edit this item' })
          return
        }

        const payload = await readJsonBody(request)
        const patch = {}

        if ('title' in payload && typeof payload.title === 'string') {
          const trimmed = payload.title.trim()
          if (!trimmed) {
            sendJson(response, 400, { error: 'title cannot be blank' })
            return
          }
          patch.title = trimmed
        }

        if ('dueDate' in payload) {
          // null or empty string clears the field
          patch.dueDate = payload.dueDate === null ? '' : String(payload.dueDate ?? '')
        }

        if ('assigneeId' in payload) {
          const incoming = payload.assigneeId === null ? '' : String(payload.assigneeId ?? '')
          if (incoming) {
            // Validate it is a real employee
            const allData = await appDataStore.read()
            const validIds = new Set(allData.employees.map((e) => e.id))
            if (!validIds.has(incoming)) {
              sendJson(response, 400, { error: 'Invalid assigneeId' })
              return
            }
          }
          patch.assigneeId = incoming
        }

        const updated = await appDataStore.updateChecklistItem(checklistId, itemId, patch)
        if (!updated) {
          sendJson(response, 404, { error: 'Checklist item not found' })
          return
        }

        await appDataStore.recordActivity(
          session.user.id,
          'checklist_item_edited',
          `${checklist.title}: ${targetItem.label}`,
        )
        sendJson(response, 200, updated)
        return
      }

      // --- DELETE /api/checklists/:id/items/:itemId ---
      if (itemId && request.method === 'DELETE') {
        const targetItem = checklist.items.find((item) => item.id === itemId)
        if (!targetItem) {
          sendJson(response, 404, { error: 'Checklist item not found' })
          return
        }

        const canEdit =
          session.user.role === 'owner' ||
          checklist.assigneeId === session.user.id ||
          editorIds.includes(session.user.id)
        if (!canEdit) {
          sendJson(response, 403, { error: 'You do not have permission to delete this item' })
          return
        }

        const updated = await appDataStore.deleteChecklistItem(checklistId, itemId)
        if (!updated) {
          sendJson(response, 404, { error: 'Checklist item not found' })
          return
        }

        await appDataStore.recordActivity(
          session.user.id,
          'checklist_item_removed',
          `${checklist.title}: ${targetItem.label}`,
        )
        sendJson(response, 200, updated)
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    const checklistViewersMatch = normalizedPath.match(/^\/api\/checklists\/([^/]+)\/viewers$/)
    if (checklistViewersMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method !== 'PUT') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can update checklist viewers' })
        return
      }

      const checklistId = checklistViewersMatch[1]
      const payload = await readJsonBody(request)
      const viewerIds = Array.isArray(payload?.viewerIds)
        ? payload.viewerIds.filter((id) => typeof id === 'string')
        : []
      const editorIds = Array.isArray(payload?.editorIds)
        ? payload.editorIds.filter((id) => typeof id === 'string')
        : []

      const updated = await appDataStore.setChecklistViewers(checklistId, viewerIds, editorIds)
      if (!updated) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      sendJson(response, 200, updated)
      return
    }

    const checklistTemplateViewersMatch = normalizedPath.match(/^\/api\/checklist-templates\/([^/]+)\/viewers$/)
    if (checklistTemplateViewersMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method !== 'PUT') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can update template viewers' })
        return
      }

      const templateId = checklistTemplateViewersMatch[1]
      const payload = await readJsonBody(request)
      const viewerIds = Array.isArray(payload?.viewerIds)
        ? payload.viewerIds.filter((id) => typeof id === 'string')
        : []
      const editorIds = Array.isArray(payload?.editorIds)
        ? payload.editorIds.filter((id) => typeof id === 'string')
        : []

      const updated = await appDataStore.setChecklistTemplateViewers(templateId, viewerIds, editorIds)
      if (!updated) {
        sendJson(response, 404, { error: 'Checklist template not found' })
        return
      }

      await appDataStore.recordActivity(
        session.user.id,
        'template_viewers_updated',
        updated.title ?? templateId,
      )
      sendJson(response, 200, updated)
      return
    }

    const clientActivityMatch = normalizedPath.match(/^\/api\/clients\/([^/]+)\/activity$/)
    if (clientActivityMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can record client activity' })
        return
      }
      const clientId = clientActivityMatch[1]
      const data = await appDataStore.read()
      const clientRecord = data.clients.find((c) => c.id === clientId)
      if (!clientRecord) {
        sendJson(response, 404, { error: 'Client not found' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'client_profile_updated',
        clientRecord.name,
      )
      sendEmpty(response, 204)
      return
    }

    if (normalizedPath === '/api/team' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can view the team' })
        return
      }
      const members = await appDataStore.getTeamMembers()
      sendJson(response, 200, {
        users: members.map((member) => decorateTeamMember(member, request)),
      })
      return
    }

    if (normalizedPath === '/api/team/invite' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can invite team members' })
        return
      }

      const payload = await readJsonBody(request)
      const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
      const email = typeof payload?.email === 'string' ? payload.email.trim() : ''
      const role = typeof payload?.role === 'string' ? payload.role : 'Bookkeeper'

      if (!name || !email) {
        sendJson(response, 400, { error: 'Name and email are required' })
        return
      }

      try {
        const member = await appDataStore.createTeamMember({
          name,
          email,
          staffRole: role,
        })
        await appDataStore.recordActivity(session.user.id, 'team_invited', member.email ?? member.name)
        sendJson(response, 201, { user: decorateTeamMember(member, request) })
      } catch (error) {
        sendJson(response, 400, { error: error?.message || 'Failed to create team member' })
      }
      return
    }

    const teamRevokeMatch = normalizedPath.match(/^\/api\/team\/([^/]+)\/revoke$/)
    if (teamRevokeMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can revoke team links' })
        return
      }

      const userId = teamRevokeMatch[1]
      const member = await appDataStore.revokeMagicToken(userId)
      if (!member) {
        sendJson(response, 404, { error: 'Team member not found' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'team_revoked', member.name)
      sendJson(response, 200, { user: decorateTeamMember(member, request) })
      return
    }

    const teamRegenerateMatch = normalizedPath.match(/^\/api\/team\/([^/]+)\/regenerate$/)
    if (teamRegenerateMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can regenerate team links' })
        return
      }

      const userId = teamRegenerateMatch[1]
      const member = await appDataStore.regenerateMagicToken(userId)
      if (!member) {
        sendJson(response, 404, { error: 'Team member not found' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'team_link_regenerated', member.name)
      sendJson(response, 200, { user: decorateTeamMember(member, request) })
      return
    }

    const teamRestoreMatch = normalizedPath.match(/^\/api\/team\/([^/]+)\/restore$/)
    if (teamRestoreMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can restore team links' })
        return
      }

      const userId = teamRestoreMatch[1]
      const member = await appDataStore.restoreMagicToken(userId)
      if (!member) {
        sendJson(response, 404, { error: 'Team member not found' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'team_link_restored', member.name)
      sendJson(response, 200, { user: decorateTeamMember(member, request) })
      return
    }

    const teamDeleteMatch = normalizedPath.match(/^\/api\/team\/([^/]+)$/)
    if (teamDeleteMatch && request.method === 'DELETE') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can remove team members' })
        return
      }

      const userId = teamDeleteMatch[1]
      const result = await appDataStore.deleteTeamMember(userId)
      if (!result.ok && result.reason === 'has_checklists') {
        sendJson(response, 409, { error: 'Reassign their work first' })
        return
      }
      if (!result.ok) {
        sendJson(response, 404, { error: 'Team member not found' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'team_removed', userId)
      sendEmpty(response, 204)
      return
    }

    const teamActivityMatch = normalizedPath.match(/^\/api\/team\/([^/]+)\/activity$/)
    if (teamActivityMatch && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can view activity' })
        return
      }

      const userId = teamActivityMatch[1]
      const limit = Number(requestUrl.searchParams.get('limit')) || 20
      const entries = await appDataStore.getRecentActivity(userId, limit)
      sendJson(response, 200, { entries })
      return
    }

    // ---- Phase 3: case timeline ----
    const caseDetailMatch = normalizedPath.match(/^\/api\/cases\/([^/]+)$/)
    if (caseDetailMatch && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can view cases' })
        return
      }
      const caseRecord = await appDataStore.getCase(decodeURIComponent(caseDetailMatch[1]))
      if (!caseRecord) {
        sendJson(response, 404, { error: 'Case not found' })
        return
      }
      sendJson(response, 200, caseRecord)
      return
    }

    // ---- Phase 3: template stage CRUD (owner only) ----
    const templateStageReorderMatch = normalizedPath.match(
      /^\/api\/checklist-templates\/([^/]+)\/stages\/reorder$/,
    )
    if (templateStageReorderMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can reorder stages' })
        return
      }
      const templateId = templateStageReorderMatch[1]
      const payload = await readJsonBody(request)
      const stageIds = Array.isArray(payload?.stageIds)
        ? payload.stageIds.filter((id) => typeof id === 'string')
        : []
      const updated = await appDataStore.reorderTemplateStages(templateId, stageIds)
      if (!updated) {
        sendJson(response, 404, { error: 'Template not found' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'template_stages_reordered', updated.title)
      sendJson(response, 200, updated)
      return
    }

    const templateStageItemMatch = normalizedPath.match(
      /^\/api\/checklist-templates\/([^/]+)\/stages(?:\/([^/]+))?$/,
    )
    if (templateStageItemMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can update template stages' })
        return
      }
      const templateId = templateStageItemMatch[1]
      const stageId = templateStageItemMatch[2]

      if (!stageId && request.method === 'POST') {
        const payload = await readJsonBody(request)
        const result = await appDataStore.addTemplateStage(templateId, payload ?? {})
        if (!result) {
          sendJson(response, 404, { error: 'Template not found' })
          return
        }
        await appDataStore.recordActivity(
          session.user.id,
          'template_stage_added',
          `${result.template.title}: ${result.stage.name}`,
        )
        sendJson(response, 201, result.template)
        return
      }

      if (stageId && request.method === 'PATCH') {
        const payload = await readJsonBody(request)
        const updated = await appDataStore.patchTemplateStage(templateId, stageId, payload ?? {})
        if (!updated) {
          sendJson(response, 404, { error: 'Stage not found' })
          return
        }
        const stage = (updated.stages ?? []).find((s) => s.id === stageId)
        await appDataStore.recordActivity(
          session.user.id,
          'template_stage_edited',
          `${updated.title}: ${stage?.name ?? stageId}`,
        )
        sendJson(response, 200, updated)
        return
      }

      if (stageId && request.method === 'DELETE') {
        const updated = await appDataStore.removeTemplateStage(templateId, stageId)
        if (!updated) {
          sendJson(response, 404, { error: 'Stage not found' })
          return
        }
        await appDataStore.recordActivity(
          session.user.id,
          'template_stage_removed',
          `${updated.title}: ${stageId}`,
        )
        sendJson(response, 200, updated)
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
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
