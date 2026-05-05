import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { AppDataStore } from './db/store.js'
import { notify, sendLoginLinkEmail } from './lib/notify.js'
import {
  generateBackupCodes,
  generateSecret,
  verifyBackupCode,
  verifyCode,
} from './lib/totp.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')
const indexFile = path.join(distDir, 'index.html')
const port = Number(process.env.PORT || 4173)
const appDataStore = new AppDataStore()
const sessionCookieName = 'pbj_session'
const pendingTwoFactorCookieName = 'pbj_2fa_pending'
// 5-minute pending cookie for the 2FA challenge / forced-setup flow.
const PENDING_2FA_COOKIE_MAX_AGE = 60 * 5

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

// 30 days in seconds — used for Max-Age on the persistent session cookie. The
// server slides the expiry forward on every authenticated request by re-emitting
// this header.
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

function buildSessionCookie(sessionId) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}${secureFlag}`
}

function clearSessionCookie() {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`
}

function buildPendingTwoFactorCookie(token) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${pendingTwoFactorCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PENDING_2FA_COOKIE_MAX_AGE}${secureFlag}`
}

function clearPendingTwoFactorCookie() {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${pendingTwoFactorCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`
}

/** Best-effort client IP extraction. Railway puts the real client in
 *  x-forwarded-for; we take the first hop. Falls back to the socket address. */
function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return request.socket?.remoteAddress || ''
}

function getUserAgent(request) {
  const ua = request.headers['user-agent']
  return typeof ua === 'string' ? ua.slice(0, 200) : ''
}

// In-process rate limiter for /api/auth/request-link. A single Map keyed by
// lowercase email -> array of recent request timestamps (epoch ms). 3 per 5
// minutes. NOTE: per-process state — multiple server instances would each
// allow 3, so a horizontally-scaled deployment should swap this for a Redis-
// backed limiter (e.g., sliding window on `requestlink:{email}`).
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT_MAX = 3
const requestLinkAttempts = new Map()

function isRateLimited(emailKey) {
  if (!emailKey) return false
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const list = (requestLinkAttempts.get(emailKey) || []).filter((ts) => ts > cutoff)
  if (list.length >= RATE_LIMIT_MAX) {
    requestLinkAttempts.set(emailKey, list)
    return true
  }
  list.push(now)
  requestLinkAttempts.set(emailKey, list)
  return false
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
  const sessionId = cookies[sessionCookieName]
  const session = await appDataStore.getUserSession(sessionId)
  if (!session) {
    sendJson(response, 401, { error: 'Authentication required' })
    return null
  }
  // Slide the cookie expiry forward on every authenticated request.
  appendSetCookie(response, buildSessionCookie(session.sessionId))
  return session
}

/**
 * Look up the pending-2fa cookie. Returns the token + pending record on
 * success; sends a 401 and returns null otherwise. The caller decides what
 * to do based on `pending.requiresSetup`.
 */
async function requirePendingTwoFactor(request, response) {
  const cookies = parseCookies(request.headers.cookie)
  const token = cookies[pendingTwoFactorCookieName]
  if (!token) {
    sendJson(response, 401, { error: 'No pending two-factor session' })
    return null
  }
  const pending = await appDataStore.getPendingTwoFactor(token)
  if (!pending) {
    sendJson(response, 401, { error: 'Two-factor session expired or invalid' })
    return null
  }
  return { ...pending, token }
}

/**
 * Append a Set-Cookie header without clobbering any cookie that another
 * handler may have already set (Node's `setHeader` would overwrite). Falls
 * back to setting it directly when no prior cookie exists.
 */
function appendSetCookie(response, cookie) {
  const existing = response.getHeader('Set-Cookie')
  if (!existing) {
    response.setHeader('Set-Cookie', cookie)
    return
  }
  if (Array.isArray(existing)) {
    response.setHeader('Set-Cookie', [...existing, cookie])
    return
  }
  response.setHeader('Set-Cookie', [String(existing), cookie])
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

/**
 * Compute the set of client ids visible to a session. Owners always see
 * everything. Non-owners see only clients where their user id appears in the
 * client's `assignedBookkeeperIds` array.
 */
function visibleClientIdSet(session, clients) {
  if (session.user.role === 'owner') {
    return new Set(clients.map((client) => client.id))
  }
  const me = session.user.id
  return new Set(
    clients
      .filter((client) =>
        Array.isArray(client.assignedBookkeeperIds) &&
        client.assignedBookkeeperIds.includes(me),
      )
      .map((client) => client.id),
  )
}

/**
 * Strip data so a non-owner only sees clients they're scoped to and
 * derivative records (checklists, templates, time entries, plans) that
 * reference those clients. Owners get the data unchanged.
 */
function scopeAppDataForSession(session, data) {
  if (session.user.role === 'owner') return data
  const allowedClientIds = visibleClientIdSet(session, data.clients ?? [])
  const me = session.user.id

  const clients = (data.clients ?? []).filter((client) => allowedClientIds.has(client.id))
  const checklists = (data.checklists ?? []).filter((checklist) => {
    if (!allowedClientIds.has(checklist.clientId)) return false
    // Existing assignee/viewer/editor filtering is still applied.
    const viewerIds = Array.isArray(checklist.viewerIds) ? checklist.viewerIds : []
    return checklist.assigneeId === me || viewerIds.includes(me)
  })
  const checklistTemplates = (data.checklistTemplates ?? []).filter((template) =>
    allowedClientIds.has(template.clientId),
  )
  const timeEntries = (data.timeEntries ?? []).filter(
    (entry) => entry.employeeId === me && allowedClientIds.has(entry.clientId),
  )
  const plans = (data.plans ?? []).filter((plan) => {
    if (!plan.clientId) return true // global plans are not gated
    return allowedClientIds.has(plan.clientId)
  })

  return {
    ...data,
    clients,
    checklists,
    checklistTemplates,
    timeEntries,
    plans,
  }
}

/**
 * Scrub activity entries when they reference a client name the session
 * cannot see. Best-effort substring match — we'd rather hide than leak.
 */
function scopeActivityEntriesForSession(session, entries, allClients) {
  if (session.user.role === 'owner') return entries
  const visible = visibleClientIdSet(session, allClients)
  const hiddenClientNames = (allClients ?? [])
    .filter((client) => !visible.has(client.id))
    .map((client) => (client.name ?? '').toLowerCase())
    .filter(Boolean)
  if (hiddenClientNames.length === 0) return entries
  return entries.filter((entry) => {
    const target = String(entry.target ?? '').toLowerCase()
    return !hiddenClientNames.some((name) => target.includes(name))
  })
}

/**
 * Strip server-internal fields from a TeamMember row before sending it to the
 * client. The legacy `magicToken`/`magicUrl` fields are intentionally omitted —
 * sign-in is now email-gated and tokens are never surfaced to the owner.
 */
function decorateTeamMember(member) {
  if (!member) {
    return member
  }
  // Strip magicToken (server-only, legacy column we no longer rely on) but
  // keep all of the existing display fields the Team UI uses.
  const { magicToken: _magicToken, ...rest } = member
  return rest
}

function renderVerifyErrorPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign-in link no longer valid - PB&amp;J Strategic Accounting</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f6f5f1; color: #1f1d1a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; padding: 32px 36px; border-radius: 14px; box-shadow: 0 12px 40px rgba(31, 29, 26, 0.08); max-width: 420px; }
  h1 { margin: 0 0 12px 0; font-size: 22px; }
  p { line-height: 1.5; margin: 0 0 12px 0; color: #555049; }
  a { color: #7d2a4d; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>This link is no longer valid</h1>
    <p>Sign-in links expire after 15 minutes and can only be used once.</p>
    <p><a href="/staff">Request a new sign-in link</a></p>
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

    // Legacy persistent magic-link route — replaced by /api/auth/request-link
    // and /verify/:token. Bookkeepers may have bookmarked the old URL; bounce
    // them to the staff sign-in entry page so the owner URL stays unadvertised.
    if (/^\/login(?:\/.*)?$/.test(normalizedPath) && request.method === 'GET') {
      response.writeHead(302, { Location: '/staff', 'Cache-Control': 'no-cache' })
      response.end()
      return
    }

    if (normalizedPath === '/api/session' && request.method === 'GET') {
      const cookies = parseCookies(request.headers.cookie)
      const session = await appDataStore.getUserSession(cookies[sessionCookieName])
      if (session) {
        // Slide cookie expiry forward on session reads too.
        appendSetCookie(response, buildSessionCookie(session.sessionId))
      }
      sendJson(response, 200, { user: session?.user ?? null })
      return
    }

    // Email-gated sign-in: request a link. ALWAYS returns the same generic
    // ok response so the endpoint can't be used to enumerate registered
    // emails or distinguish staff vs owner addresses.
    if (normalizedPath === '/api/auth/request-link' && request.method === 'POST') {
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }

      // Loose Origin check — when APP_PUBLIC_URL is configured we require
      // matches; otherwise any same-origin request (including direct API
      // testing without an Origin header) is permitted.
      const origin = request.headers.origin
      const expectedOrigin = process.env.APP_PUBLIC_URL
        ? process.env.APP_PUBLIC_URL.replace(/\/$/, '')
        : null
      if (expectedOrigin && origin && origin.replace(/\/$/, '') !== expectedOrigin) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const genericOk = {
        ok: true,
        message: "If that email is registered, we've sent a sign-in link.",
      }

      let payload
      try {
        payload = await readJsonBody(request)
      } catch {
        // Invalid JSON: still return the generic ok to avoid leaking shape
        // information. Don't burn a rate-limit slot for malformed payloads.
        sendJson(response, 200, genericOk)
        return
      }
      const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : ''
      const requestedRole = payload?.role === 'owner' ? 'owner' : 'staff'

      // Rate limit per email regardless of validity (silent — same response).
      if (email && isRateLimited(email)) {
        sendJson(response, 200, genericOk)
        return
      }

      if (email) {
        try {
          const user = await appDataStore.findUserByEmail(email)
          // Gate by role hint: owner endpoint must match an Owner user;
          // staff endpoint must NOT match an Owner. Mismatches are silently
          // ignored (same generic response).
          const dbRoleOwner = user?.role === 'owner'
          const roleMatches =
            (requestedRole === 'owner' && dbRoleOwner) ||
            (requestedRole === 'staff' && user && !dbRoleOwner)
          if (user && roleMatches) {
            const ip = getClientIp(request)
            const { token } = await appDataStore.createLoginToken(user.id, ip)
            const baseUrl = getPublicAppUrl(request)
            const signInUrl = `${baseUrl}/verify/${encodeURIComponent(token)}`
            const firmSettings = await appDataStore.getFirmSettings()
            // Activity log (only when email is real & role-matched, to keep
            // the audit log free of injection noise).
            await appDataStore.recordActivity(user.id, 'login_link_requested', email)
            // Best-effort send. Failures are logged inside notify.js and
            // never surfaced (same response either way).
            await sendLoginLinkEmail({
              to: user.email,
              firmName: firmSettings?.name,
              signInUrl,
            })
          }
        } catch (error) {
          console.error('[auth] request-link error:', error?.message || error)
        }
      }

      sendJson(response, 200, genericOk)
      return
    }

    // Email-gated sign-in: consume a link, set the session cookie, redirect.
    const verifyMatch = normalizedPath.match(/^\/verify\/([^/]+)$/)
    if (verifyMatch && request.method === 'GET') {
      const token = decodeURIComponent(verifyMatch[1])
      const consumed = await appDataStore.consumeLoginToken(token)
      if (!consumed) {
        response.writeHead(401, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        response.end(renderVerifyErrorPage())
        return
      }

      // TOTP gate: between consuming the email link and issuing the full
      // session, branch on whether the user has 2FA configured / required.
      //   - 2FA enabled  -> /two-factor (challenge for code)
      //   - 2FA disabled, owner role -> /two-factor/setup (forced setup)
      //   - 2FA disabled, non-owner -> issue full session as today
      const totpState = await appDataStore.getUserTotpState(consumed.userId)
      const isOwner = totpState?.role === 'owner'
      if (totpState?.totpEnabled) {
        const pending = await appDataStore.createPendingTwoFactor(consumed.userId, false)
        await appDataStore.recordActivity(consumed.userId, 'login_via_email_link', '')
        response.writeHead(302, {
          'Set-Cookie': buildPendingTwoFactorCookie(pending.token),
          Location: '/two-factor',
          'Cache-Control': 'no-cache',
        })
        response.end()
        return
      }
      if (isOwner) {
        // Owner without 2FA configured — force setup before issuing session.
        const pending = await appDataStore.createPendingTwoFactor(consumed.userId, true)
        await appDataStore.recordActivity(consumed.userId, 'login_via_email_link', '')
        response.writeHead(302, {
          'Set-Cookie': buildPendingTwoFactorCookie(pending.token),
          Location: '/two-factor/setup',
          'Cache-Control': 'no-cache',
        })
        response.end()
        return
      }

      const ip = getClientIp(request)
      const ua = getUserAgent(request)
      const session = await appDataStore.createUserSession(consumed.userId, ua, ip)
      if (!session) {
        response.writeHead(401, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        response.end(renderVerifyErrorPage())
        return
      }

      await appDataStore.recordActivity(consumed.userId, 'login_via_email_link', '')
      response.writeHead(302, {
        'Set-Cookie': buildSessionCookie(session.sessionId),
        Location: '/',
        'Cache-Control': 'no-cache',
      })
      response.end()
      return
    }

    if (normalizedPath === '/api/logout' && request.method === 'POST') {
      const cookies = parseCookies(request.headers.cookie)
      const sessionId = cookies[sessionCookieName]
      if (sessionId) {
        // Look up before revoking so we can tag the activity entry.
        const sessionBefore = await appDataStore.getUserSession(sessionId)
        await appDataStore.revokeUserSession(sessionId)
        if (sessionBefore?.user?.id) {
          await appDataStore.recordActivity(sessionBefore.user.id, 'signed_out', '')
        }
      }
      response.setHeader('Set-Cookie', clearSessionCookie())
      sendEmpty(response, 204)
      return
    }

    if (normalizedPath === '/api/auth/status' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Forbidden' })
        return
      }
      const ownerEmailConfigured = Boolean(process.env.OWNER_EMAIL?.trim())
      const adminEmailConfigured = Boolean(process.env.ADMIN_EMAIL?.trim())
      const emailFrom = process.env.EMAIL_FROM?.trim() ?? null
      let sendingDomain = null
      if (emailFrom && emailFrom.includes('@')) {
        sendingDomain = emailFrom.split('@')[1] ?? null
      }
      sendJson(response, 200, {
        ownerEmailConfigured,
        adminEmailConfigured,
        sendingDomain,
        appUrl: getPublicAppUrl(request),
      })
      return
    }

    if (normalizedPath === '/api/firm-settings/public' && request.method === 'GET') {
      const settings = await appDataStore.getFirmSettings()
      sendJson(response, 200, {
        name: settings.name,
        tagline: settings.tagline ?? '',
        logoUrl: settings.logoUrl ?? '',
        brandColor: settings.brandColor ?? '#3c2044',
      })
      return
    }

    if (normalizedPath === '/api/firm-settings') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method === 'GET') {
        const settings = await appDataStore.getFirmSettings()
        sendJson(response, 200, settings)
        return
      }

      if (request.method === 'PUT') {
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can update firm settings' })
          return
        }

        const payload = await readJsonBody(request)
        const updated = await appDataStore.updateFirmSettings(payload || {})
        await appDataStore.recordActivity(session.user.id, 'firm_settings_updated', 'branding')
        sendJson(response, 200, updated)
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    if (normalizedPath === '/api/app-data') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method === 'GET') {
        const data = await appDataStore.read()
        sendJson(response, 200, scopeAppDataForSession(session, data))
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
        const taskIdRaw = payload?.taskId
        const taskId =
          typeof taskIdRaw === 'string' && taskIdRaw.trim() ? taskIdRaw.trim() : null

        if (!employeeId || !clientId || !date || Number.isNaN(minutes) || minutes <= 0 || !category) {
          sendJson(response, 400, { error: 'Invalid time entry payload' })
          return
        }

        // Visibility scoping: a non-owner can only log time against clients
        // they have visibility on.
        const allData = await appDataStore.read()
        const allowed = visibleClientIdSet(session, allData.clients ?? [])
        if (!allowed.has(clientId)) {
          sendJson(response, 403, { error: 'Client not visible to this user' })
          return
        }

        // Validate taskId if provided: must reference an existing checklist
        // for the same client and the user must be allowed to log against it.
        if (taskId) {
          const checklist = (allData.checklists ?? []).find((c) => c.id === taskId)
          if (!checklist || checklist.clientId !== clientId) {
            sendJson(response, 400, { error: 'Invalid taskId for this client' })
            return
          }
          const editorIds = Array.isArray(checklist.editorIds) ? checklist.editorIds : []
          const allowedToLog =
            session.user.role === 'owner' ||
            checklist.assigneeId === employeeId ||
            editorIds.includes(employeeId)
          if (!allowedToLog) {
            sendJson(response, 403, { error: 'You cannot log time against this task' })
            return
          }
        }

        const entry = await appDataStore.createTimeEntry({
          employeeId,
          clientId,
          date,
          minutes,
          category,
          description,
          billable,
          taskId,
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
        // Any employee (any role, including Owner) can be assigned to a checklist —
        // the owner needs to be able to assign tasks to themselves.
        const assigneeExists = data.employees.some((employee) => employee.id === assigneeId)

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

        // Auto-grant: a non-owner being assigned a task on this client gains
        // visibility into the client (idempotent; owners are skipped).
        await appDataStore.grantClientVisibility(checklist.clientId, checklist.assigneeId)

        await appDataStore.recordActivity(session.user.id, 'checklist_created', checklist.title)

        // Phase 5: notify the assignee if it's not the creator (no self-notify).
        if (checklist.assigneeId && checklist.assigneeId !== session.user.id) {
          await notify(appDataStore, checklist.assigneeId, 'task_assigned', {
            checklistId: checklist.id,
            message: `New task: ${checklist.title}`,
            link: `/checklists?focus=${checklist.id}`,
            appPublicUrl: getPublicAppUrl(request),
          })
        }

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

        // Phase 5: notify the next stage's primary assignee (skip self).
        // v1: primary assignee only — viewerIds intentionally not notified to
        // avoid noise; revisit if owners ask for stage-watcher notifications.
        const spawned = toggleResult.spawned
        const nextAssigneeId = spawned?.assigneeId
        if (nextAssigneeId && nextAssigneeId !== session.user.id) {
          await notify(appDataStore, nextAssigneeId, 'task_assigned', {
            checklistId: spawned.id,
            caseId,
            stageIndex: spawned.stageIndex,
            stageCount: spawned.stageCount,
            message: `New task: ${spawned.title} (Stage ${(spawned.stageIndex ?? 0) + 1} of ${spawned.stageCount ?? 1})`,
            link: `/checklists?focus=${spawned.id}`,
            appPublicUrl: getPublicAppUrl(request),
          })
        }
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

        // Phase 5: notify the case opener (template's stage-1 assignee).
        // Skip if they're the one who just completed it.
        try {
          const data = await appDataStore.read()
          const template = (data.checklistTemplates ?? []).find(
            (t) => t.id === updatedChecklist.templateId,
          )
          const openerId = template?.stages?.[0]?.assigneeId || template?.assigneeId
          if (openerId && openerId !== session.user.id) {
            await notify(appDataStore, openerId, 'case_completed', {
              checklistId: updatedChecklist.id,
              caseId,
              message: `Workflow completed: ${updatedChecklist.title}`,
              link: `/cases/${caseId}`,
              appPublicUrl: getPublicAppUrl(request),
            })
          }
        } catch (err) {
          console.error('[notify] case_completed dispatch failed:', err?.message || err)
        }
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

    // PUT /api/clients/:id/assigned-team — owner-only. Replaces the per-client
    // assigned-team list. Validates each id is a real non-owner employee.
    const clientAssignedTeamMatch = normalizedPath.match(/^\/api\/clients\/([^/]+)\/assigned-team$/)
    if (clientAssignedTeamMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'PUT') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can update client assigned team' })
        return
      }
      const clientId = clientAssignedTeamMatch[1]
      const payload = await readJsonBody(request)
      const bookkeeperIds = Array.isArray(payload?.bookkeeperIds)
        ? payload.bookkeeperIds.filter((id) => typeof id === 'string')
        : []
      const updated = await appDataStore.setClientAssignedTeam(clientId, bookkeeperIds)
      if (!updated) {
        sendJson(response, 404, { error: 'Client not found' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'client_team_updated',
        updated.name ?? clientId,
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
        users: members.map((member) => decorateTeamMember(member)),
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

        // Email-driven onboarding: generate a sign-in link for the new
        // member and email it directly. The owner never sees the token.
        try {
          const ip = getClientIp(request)
          const { token } = await appDataStore.createLoginToken(member.id, ip)
          const baseUrl = getPublicAppUrl(request)
          const signInUrl = `${baseUrl}/verify/${encodeURIComponent(token)}`
          const firmSettings = await appDataStore.getFirmSettings()
          await sendLoginLinkEmail({
            to: member.email,
            firmName: firmSettings?.name,
            signInUrl,
          })
        } catch (mailError) {
          console.error('[auth] invite email failed:', mailError?.message || mailError)
        }

        sendJson(response, 201, { user: decorateTeamMember(member) })
      } catch (error) {
        sendJson(response, 400, { error: error?.message || 'Failed to create team member' })
      }
      return
    }

    // Owner-only: resend a sign-in link to a team member by email.
    const teamResendMatch = normalizedPath.match(/^\/api\/team\/([^/]+)\/resend-link$/)
    if (teamResendMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can resend sign-in links' })
        return
      }
      const userId = teamResendMatch[1]
      const member = await appDataStore.getTeamMember(userId)
      if (!member || !member.email) {
        sendJson(response, 404, { error: 'Team member not found' })
        return
      }
      try {
        const ip = getClientIp(request)
        const { token } = await appDataStore.createLoginToken(member.id, ip)
        const baseUrl = getPublicAppUrl(request)
        const signInUrl = `${baseUrl}/verify/${encodeURIComponent(token)}`
        const firmSettings = await appDataStore.getFirmSettings()
        await sendLoginLinkEmail({
          to: member.email,
          firmName: firmSettings?.name,
          signInUrl,
        })
      } catch (mailError) {
        console.error('[auth] resend-link email failed:', mailError?.message || mailError)
      }
      await appDataStore.recordActivity(session.user.id, 'team_link_resent', member.email ?? member.name)
      sendJson(response, 200, { ok: true })
      return
    }

    // Owner-only: list a team member's active (non-revoked) sessions.
    const teamSessionsListMatch = normalizedPath.match(/^\/api\/team\/([^/]+)\/sessions$/)
    if (teamSessionsListMatch && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can view team sessions' })
        return
      }
      const userId = teamSessionsListMatch[1]
      const sessions = await appDataStore.listActiveSessions(userId)
      sendJson(response, 200, { sessions })
      return
    }

    // Owner-only: revoke every active session for a team member.
    const teamSessionsAllRevokeMatch = normalizedPath.match(
      /^\/api\/team\/([^/]+)\/sessions\/revoke-all$/,
    )
    if (teamSessionsAllRevokeMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can sign out team members' })
        return
      }
      const userId = teamSessionsAllRevokeMatch[1]
      const member = await appDataStore.getTeamMember(userId)
      if (!member) {
        sendJson(response, 404, { error: 'Team member not found' })
        return
      }
      const count = await appDataStore.revokeAllUserSessions(userId)
      await appDataStore.recordActivity(
        session.user.id,
        'session_revoked',
        `${member.name} (all devices, ${count})`,
      )
      sendJson(response, 200, { revoked: count })
      return
    }

    // Owner-only: revoke a single session for a team member.
    const teamSessionRevokeMatch = normalizedPath.match(
      /^\/api\/team\/([^/]+)\/sessions\/([^/]+)\/revoke$/,
    )
    if (teamSessionRevokeMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can sign out team devices' })
        return
      }
      const userId = teamSessionRevokeMatch[1]
      const sessionId = teamSessionRevokeMatch[2]
      // Confirm the session belongs to this user before revoking.
      const all = await appDataStore.listActiveSessions(userId)
      const target = all.find((s) => s.id === sessionId)
      if (!target) {
        sendJson(response, 404, { error: 'Session not found' })
        return
      }
      await appDataStore.revokeUserSession(sessionId)
      const member = await appDataStore.getTeamMember(userId)
      const summary = `${member?.name ?? userId} (${target.userAgent || 'unknown device'})`
      await appDataStore.recordActivity(session.user.id, 'session_revoked', summary)
      sendJson(response, 200, { ok: true })
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

    if (normalizedPath === '/api/activity' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can view global activity' })
        return
      }
      const limit = Number(requestUrl.searchParams.get('limit')) || 15
      const entries = await appDataStore.getGlobalActivity(limit)
      sendJson(response, 200, { entries })
      return
    }

    if (normalizedPath === '/api/activity/range' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can view activity' })
        return
      }
      const from = requestUrl.searchParams.get('from') || ''
      const to = requestUrl.searchParams.get('to') || ''
      const limit = Number(requestUrl.searchParams.get('limit')) || 2000
      const entries = await appDataStore.getActivityRange(from, to, limit)
      sendJson(response, 200, { entries })
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
      const caseRecord = await appDataStore.getCase(decodeURIComponent(caseDetailMatch[1]))
      if (!caseRecord) {
        sendJson(response, 404, { error: 'Case not found' })
        return
      }
      if (session.user.role !== 'owner') {
        const allData = await appDataStore.read()
        const allowed = visibleClientIdSet(session, allData.clients ?? [])
        if (!caseRecord.client || !allowed.has(caseRecord.client.id)) {
          sendJson(response, 403, { error: 'Case not visible to this user' })
          return
        }
        // Scrub activity entries that mention clients the user can't see.
        caseRecord.activity = scopeActivityEntriesForSession(
          session,
          caseRecord.activity ?? [],
          allData.clients ?? [],
        )
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
        // Auto-grant: a freshly-added stage may have a non-owner assignee.
        if (result.stage?.assigneeId) {
          await appDataStore.grantClientVisibility(
            result.template.clientId,
            result.stage.assigneeId,
          )
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
        // Auto-grant: if the stage's assigneeId was set to a non-owner, give
        // them visibility into the parent client.
        if (stage?.assigneeId) {
          await appDataStore.grantClientVisibility(updated.clientId, stage.assigneeId)
        }
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

    // ---- Phase 5: notifications API ----
    if (normalizedPath === '/api/notifications' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const unreadOnly = requestUrl.searchParams.get('unreadOnly') === 'true'
      const limit = Number(requestUrl.searchParams.get('limit')) || 50
      const entries = await appDataStore.listNotifications(session.user.id, {
        limit,
        unreadOnly,
      })
      sendJson(response, 200, { entries })
      return
    }

    if (normalizedPath === '/api/notifications/unread-count' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const count = await appDataStore.unreadNotificationCount(session.user.id)
      sendJson(response, 200, { count })
      return
    }

    if (normalizedPath === '/api/notifications/read-all' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      const updated = await appDataStore.markAllNotificationsRead(session.user.id)
      sendJson(response, 200, { updated })
      return
    }

    const notificationReadMatch = normalizedPath.match(/^\/api\/notifications\/([^/]+)\/read$/)
    if (notificationReadMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      const notificationId = notificationReadMatch[1]
      const updated = await appDataStore.markNotificationRead(notificationId, session.user.id)
      if (!updated) {
        sendJson(response, 404, { error: 'Notification not found' })
        return
      }
      sendJson(response, 200, updated)
      return
    }

    // ---- TOTP two-factor authentication ----

    const issuerForTotp = async () => {
      const firm = await appDataStore.getFirmSettings()
      return firm?.name || 'PB&J Strategic Accounting'
    }

    // Step 1: generate a candidate secret + QR. Caller must already hold
    // either an authenticated session (Settings -> "Enable two-factor") OR
    // the pending-2fa cookie (forced-setup flow on first login).
    if (normalizedPath === '/api/auth/totp/setup-init' && request.method === 'POST') {
      const cookies = parseCookies(request.headers.cookie)
      let userId = null
      const sessionId = cookies[sessionCookieName]
      if (sessionId) {
        const session = await appDataStore.getUserSession(sessionId)
        if (session) {
          userId = session.user.id
          appendSetCookie(response, buildSessionCookie(session.sessionId))
        }
      }
      if (!userId) {
        const pendingToken = cookies[pendingTwoFactorCookieName]
        if (pendingToken) {
          const pending = await appDataStore.getPendingTwoFactor(pendingToken)
          if (pending) userId = pending.userId
        }
      }
      if (!userId) {
        sendJson(response, 401, { error: 'Authentication required' })
        return
      }
      const totpState = await appDataStore.getUserTotpState(userId)
      if (!totpState) {
        sendJson(response, 404, { error: 'User not found' })
        return
      }
      const secret = generateSecret()
      await appDataStore.savePendingTotpSecret(userId, secret.base32)
      const issuer = await issuerForTotp()
      const otpauthUri = secret.otpauthUri(totpState.email || totpState.name, issuer)
      let qrSvg = ''
      try {
        qrSvg = await QRCode.toString(otpauthUri, { type: 'svg', margin: 1, width: 220 })
      } catch (error) {
        console.error('[totp] QR render failed:', error?.message || error)
      }
      sendJson(response, 200, {
        secret: secret.base32,
        otpauthUri,
        qrSvg,
      })
      return
    }

    // Step 2: verify the user's first 6-digit code against the candidate
    // secret. On success: commit the secret, generate backup codes, return
    // them once. The pending-2fa cookie (if any) stays in place; the
    // /setup-complete endpoint clears it and issues the full session.
    if (normalizedPath === '/api/auth/totp/setup-verify' && request.method === 'POST') {
      const cookies = parseCookies(request.headers.cookie)
      let userId = null
      let viaSession = false
      const sessionId = cookies[sessionCookieName]
      if (sessionId) {
        const session = await appDataStore.getUserSession(sessionId)
        if (session) {
          userId = session.user.id
          viaSession = true
          appendSetCookie(response, buildSessionCookie(session.sessionId))
        }
      }
      if (!userId) {
        const pendingToken = cookies[pendingTwoFactorCookieName]
        if (pendingToken) {
          const pending = await appDataStore.getPendingTwoFactor(pendingToken)
          if (pending) userId = pending.userId
        }
      }
      if (!userId) {
        sendJson(response, 401, { error: 'Authentication required' })
        return
      }
      const payload = await readJsonBody(request)
      const code = typeof payload?.code === 'string' ? payload.code : ''
      const totpState = await appDataStore.getUserTotpState(userId)
      if (!totpState?.pendingTotpSecret) {
        sendJson(response, 400, { error: 'No setup in progress — start over.' })
        return
      }
      if (!verifyCode(totpState.pendingTotpSecret, code)) {
        sendJson(response, 400, { error: 'That code is not valid. Try the next one.' })
        return
      }
      const backup = generateBackupCodes(8)
      await appDataStore.commitTotp(userId, totpState.pendingTotpSecret, backup.hashed)
      await appDataStore.recordActivity(userId, 'totp_enabled', 'two-factor authentication')
      sendJson(response, 200, {
        ok: true,
        backupCodes: backup.plain,
        // Tell the client whether they still need /setup-complete (forced
        // flow) or can just close the modal (already-signed-in user).
        needsSessionFinalize: !viaSession,
      })
      return
    }

    // Step 3 (forced-setup flow only): clear the pending-2fa cookie and
    // issue the full session. Required so the client can't accidentally
    // skip the backup-codes screen.
    if (normalizedPath === '/api/auth/totp/setup-complete' && request.method === 'POST') {
      const pending = await requirePendingTwoFactor(request, response)
      if (!pending) return
      const consumed = await appDataStore.consumePendingTwoFactor(pending.token)
      if (!consumed) {
        sendJson(response, 401, { error: 'Two-factor session expired' })
        return
      }
      const ip = getClientIp(request)
      const ua = getUserAgent(request)
      const session = await appDataStore.createUserSession(consumed.userId, ua, ip)
      if (!session) {
        sendJson(response, 500, { error: 'Failed to create session' })
        return
      }
      appendSetCookie(response, clearPendingTwoFactorCookie())
      appendSetCookie(response, buildSessionCookie(session.sessionId))
      sendJson(response, 200, { ok: true, redirectTo: '/dashboard' })
      return
    }

    // Login challenge: the user enters the 6-digit code from their app.
    // Identifies the user via the pending-2fa cookie. Five failed attempts
    // lock the token (force them to request a fresh email link).
    if (normalizedPath === '/api/auth/totp/verify' && request.method === 'POST') {
      const pending = await requirePendingTwoFactor(request, response)
      if (!pending) return
      const payload = await readJsonBody(request)
      const code = typeof payload?.code === 'string' ? payload.code : ''
      const totpState = await appDataStore.getUserTotpState(pending.userId)
      if (!totpState?.totpEnabled || !totpState.totpSecret) {
        sendJson(response, 400, { error: 'Two-factor not enabled for this account' })
        return
      }
      if (!verifyCode(totpState.totpSecret, code)) {
        const attempts = await appDataStore.recordPendingTwoFactorAttempt(pending.token)
        const remaining = Math.max(0, 5 - attempts)
        if (attempts >= 5) {
          appendSetCookie(response, clearPendingTwoFactorCookie())
          sendJson(response, 423, {
            error: 'Too many attempts. Request a new sign-in link.',
          })
          return
        }
        sendJson(response, 400, {
          error: `That code is not valid. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
        })
        return
      }
      const consumed = await appDataStore.consumePendingTwoFactor(pending.token)
      if (!consumed) {
        sendJson(response, 401, { error: 'Two-factor session expired' })
        return
      }
      const ip = getClientIp(request)
      const ua = getUserAgent(request)
      const session = await appDataStore.createUserSession(consumed.userId, ua, ip)
      if (!session) {
        sendJson(response, 500, { error: 'Failed to create session' })
        return
      }
      appendSetCookie(response, clearPendingTwoFactorCookie())
      appendSetCookie(response, buildSessionCookie(session.sessionId))
      sendJson(response, 200, { ok: true, redirectTo: '/' })
      return
    }

    // Login challenge fallback: the user uses one of their backup codes.
    if (normalizedPath === '/api/auth/totp/verify-backup' && request.method === 'POST') {
      const pending = await requirePendingTwoFactor(request, response)
      if (!pending) return
      const payload = await readJsonBody(request)
      const code = typeof payload?.code === 'string' ? payload.code : ''
      const totpState = await appDataStore.getUserTotpState(pending.userId)
      if (!totpState?.totpEnabled) {
        sendJson(response, 400, { error: 'Two-factor not enabled for this account' })
        return
      }
      const result = verifyBackupCode(code, totpState.totpBackupCodes ?? [])
      if (!result.ok) {
        const attempts = await appDataStore.recordPendingTwoFactorAttempt(pending.token)
        const remaining = Math.max(0, 5 - attempts)
        if (attempts >= 5) {
          appendSetCookie(response, clearPendingTwoFactorCookie())
          sendJson(response, 423, {
            error: 'Too many attempts. Request a new sign-in link.',
          })
          return
        }
        sendJson(response, 400, {
          error: `Backup code not recognized. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
        })
        return
      }
      // Persist the shortened code list before issuing the session.
      await appDataStore.setTotpBackupCodes(pending.userId, result.updatedHashedList)
      await appDataStore.recordActivity(
        pending.userId,
        'totp_used_backup_code',
        `${result.updatedHashedList.length} codes left`,
      )
      const consumed = await appDataStore.consumePendingTwoFactor(pending.token)
      if (!consumed) {
        sendJson(response, 401, { error: 'Two-factor session expired' })
        return
      }
      const ip = getClientIp(request)
      const ua = getUserAgent(request)
      const session = await appDataStore.createUserSession(consumed.userId, ua, ip)
      if (!session) {
        sendJson(response, 500, { error: 'Failed to create session' })
        return
      }
      appendSetCookie(response, clearPendingTwoFactorCookie())
      appendSetCookie(response, buildSessionCookie(session.sessionId))
      sendJson(response, 200, {
        ok: true,
        redirectTo: '/',
        remainingBackupCodes: result.updatedHashedList.length,
      })
      return
    }

    // Status read for the Settings + Team pages.
    if (normalizedPath === '/api/auth/totp/status' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const state = await appDataStore.getUserTotpState(session.user.id)
      sendJson(response, 200, {
        enabled: Boolean(state?.totpEnabled),
        remainingBackupCodes: Array.isArray(state?.totpBackupCodes)
          ? state.totpBackupCodes.length
          : 0,
        requiredForRole: session.user.role === 'owner',
      })
      return
    }

    // Disable: bookkeepers only. Owners are required to keep 2FA on.
    if (normalizedPath === '/api/auth/totp/disable' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role === 'owner') {
        sendJson(response, 403, { error: 'Owners are required to keep two-factor enabled.' })
        return
      }
      const payload = await readJsonBody(request)
      const code = typeof payload?.code === 'string' ? payload.code : ''
      const state = await appDataStore.getUserTotpState(session.user.id)
      if (!state?.totpEnabled || !state.totpSecret) {
        sendJson(response, 400, { error: 'Two-factor is not enabled.' })
        return
      }
      if (!verifyCode(state.totpSecret, code)) {
        sendJson(response, 400, { error: 'That code is not valid.' })
        return
      }
      await appDataStore.clearTotp(session.user.id)
      await appDataStore.recordActivity(session.user.id, 'totp_disabled', 'two-factor authentication')
      sendJson(response, 200, { ok: true })
      return
    }

    // Regenerate backup codes — current code required.
    if (normalizedPath === '/api/auth/totp/regenerate-backups' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      const payload = await readJsonBody(request)
      const code = typeof payload?.code === 'string' ? payload.code : ''
      const state = await appDataStore.getUserTotpState(session.user.id)
      if (!state?.totpEnabled || !state.totpSecret) {
        sendJson(response, 400, { error: 'Two-factor is not enabled.' })
        return
      }
      if (!verifyCode(state.totpSecret, code)) {
        sendJson(response, 400, { error: 'That code is not valid.' })
        return
      }
      const backup = generateBackupCodes(8)
      await appDataStore.replaceTotpBackupCodes(session.user.id, backup.hashed)
      await appDataStore.recordActivity(
        session.user.id,
        'totp_backup_codes_regenerated',
        'two-factor authentication',
      )
      sendJson(response, 200, { ok: true, backupCodes: backup.plain })
      return
    }

    // Owner-only admin override: wipe a user's 2FA so they can re-enroll.
    const teamTotpResetMatch = normalizedPath.match(/^\/api\/team\/([^/]+)\/totp\/reset$/)
    if (teamTotpResetMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can reset two-factor for team members' })
        return
      }
      const userId = teamTotpResetMatch[1]
      const target = await appDataStore.getTeamMember(userId)
      if (!target) {
        sendJson(response, 404, { error: 'Team member not found' })
        return
      }
      await appDataStore.clearTotp(userId)
      await appDataStore.recordActivity(
        session.user.id,
        'totp_reset_by_admin',
        target.name ?? userId,
      )
      sendJson(response, 200, { ok: true })
      return
    }

    // TODO Phase 6: monthly invoice cron
    // Each month on the 1st (or per-client schedule), iterate clients,
    // generate invoice draft, mark "ready_to_send", and call:
    //   notify(appDataStore, ownerUserId, 'invoice_ready', {
    //     clientId,
    //     message: 'Invoice ready to send for <client>',
    //     link: '/invoices?focus=<draftId>',
    //     appPublicUrl: getPublicAppUrl(request),
    //   })
    // The notify() abstraction + Resend wiring handle email delivery once
    // RESEND_API_KEY and EMAIL_FROM are set in Railway. No cron implementation
    // yet — leave this hook visible for the next milestone.

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
