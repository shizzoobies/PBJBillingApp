import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { AppDataStore } from './db/store.js'
import { notify, sendLoginLinkEmail } from './lib/notify.js'
import { normalizeTimeEntryMethod } from './lib/time-entry.js'
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

  // Billing rates are between the owner and the client. Never expose what
  // PB&J charges to non-owners: strip the hourly rate and plan link from
  // every client object the server sends them.
  const clients = (data.clients ?? [])
    .filter((client) => allowedClientIds.has(client.id))
    .map((client) => ({ ...client, hourlyRate: 0, planId: null }))
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
  // Subscription plans carry monthly fees — billing data the owner keeps
  // private. Non-owners receive no plans at all.
  const plans = []
  // A bookkeeper only needs to know about locks on their own timesheet.
  const timesheetLocks = (data.timesheetLocks ?? []).filter((lock) => lock.userId === me)
  // Same for weekly submissions — bookkeepers see their own queue;
  // owners see everyone's via the unscoped return below.
  const weeklySubmissions = (data.weeklySubmissions ?? []).filter(
    (submission) => submission.userId === me,
  )
  // Reimbursements are owner-managed but bookkeepers see them on the
  // invoice / client page for any client they have visibility into.
  // The data is read-only for them client-side; the server-side endpoints
  // already gate writes on role.
  const reimbursements = (data.reimbursements ?? []).filter((reimbursement) =>
    allowedClientIds.has(reimbursement.clientId),
  )
  const recurringReimbursements = (data.recurringReimbursements ?? []).filter((recurring) =>
    allowedClientIds.has(recurring.clientId),
  )

  return {
    ...data,
    clients,
    checklists,
    checklistTemplates,
    timeEntries,
    plans,
    timesheetLocks,
    weeklySubmissions,
    reimbursements,
    recurringReimbursements,
    // Soft-deleted team members are owner-only — bookkeepers never see
    // historical analytics data, so they don't need the inactive list.
    inactiveEmployees: [],
    // Recycle bin is owner-only — bookkeepers never see it. Empty array
    // (rather than undefined) so the client code can iterate without a
    // null check, and old front-ends still receive a present field.
    recycledChecklists: [],
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

/**
 * True when a checklist node — or any of its nested sub-steps — carries real
 * text. Mirrors the client's `pruneEmptyOutlineItems`: a blank top-level row is
 * kept only when it still has a labelled descendant, so a user's typed
 * sub-steps are never silently dropped just because the parent row was left
 * blank. Recurses all three levels (item `label` → sub/sub-sub `title`).
 */
function checklistItemHasText(node) {
  const text =
    typeof node?.label === 'string'
      ? node.label
      : typeof node?.title === 'string'
        ? node.title
        : ''
  if (text.trim()) return true
  const children = Array.isArray(node?.subItems) ? node.subItems : []
  return children.some(checklistItemHasText)
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

    // Preview mode is strictly read-only. The client tags every request with
    // `X-Preview-Mode: 1` while an owner is previewing another user; any
    // write verb carrying that header is rejected before it can mutate
    // anything. This is the server-side belt to the client-side suspenders.
    const method = request.method || 'GET'
    if (
      request.headers['x-preview-mode'] === '1' &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      method !== 'OPTIONS'
    ) {
      sendJson(response, 403, { error: 'Preview mode is read-only' })
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

      // Rate limit per email regardless of validity (silent — same response).
      if (email && isRateLimited(email)) {
        sendJson(response, 200, genericOk)
        return
      }

      if (email) {
        try {
          const user = await appDataStore.findUserByEmail(email)
          // Unified sign-in: the role is already on the user row, so the
          // request-link endpoint no longer cares which URL the form came
          // from. Anyone with a real account gets a link; everyone else
          // gets the same silent "ok" so the response doesn't leak
          // whether the address exists.
          if (user) {
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

    // Password sign-in — the bulletproof path that doesn't depend on email
    // delivery (Resend down, address typo, rate-limited, etc.). Mirrors the
    // /verify/:token TOTP branching so a 2FA-enabled user still gets the
    // challenge, and an owner without 2FA still hits the forced-setup flow.
    // Returns JSON with a `next` directive (the React sign-in form acts on
    // it) plus the appropriate Set-Cookie header.
    if (normalizedPath === '/api/auth/sign-in-with-password' && request.method === 'POST') {
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }

      // Origin guard mirrors /api/auth/request-link.
      const origin = request.headers.origin
      const expectedOrigin = process.env.APP_PUBLIC_URL
        ? process.env.APP_PUBLIC_URL.replace(/\/$/, '')
        : null
      if (expectedOrigin && origin && origin.replace(/\/$/, '') !== expectedOrigin) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      let payload
      try {
        payload = await readJsonBody(request)
      } catch {
        sendJson(response, 400, { error: 'Invalid request body' })
        return
      }
      const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : ''
      const password = typeof payload?.password === 'string' ? payload.password : ''
      if (!email || !password) {
        sendJson(response, 400, { error: 'Email and password are required' })
        return
      }

      // Share the request-link rate limiter so a bad actor can't bypass the
      // 3-attempts-per-5-min window by mixing the two endpoints.
      if (isRateLimited(email)) {
        sendJson(response, 429, {
          error: 'Too many attempts. Wait a few minutes and try again.',
        })
        return
      }

      const ip = getClientIp(request)
      const ua = getUserAgent(request)
      const session = await appDataStore.signInWithPassword(email, password, ua, ip)
      if (!session) {
        // Common error so we don't leak whether the email exists.
        sendJson(response, 401, { error: 'Invalid email or password' })
        return
      }

      // Same TOTP gate as /verify/:token: 2FA-enabled users challenge first,
      // owners without 2FA are routed to forced setup, everyone else gets a
      // full session immediately.
      const totpState = await appDataStore.getUserTotpState(session.user.id)
      const isOwner = totpState?.role === 'owner'
      if (totpState?.totpEnabled) {
        // Discard the session we just created — TOTP challenge requires the
        // user to clear 2FA before a full session is issued. We re-issue
        // the pending cookie below; the unused session row will expire on
        // its own and isn't a security concern (cookie was never sent).
        await appDataStore.revokeUserSession(session.sessionId)
        const pending = await appDataStore.createPendingTwoFactor(session.user.id, false)
        await appDataStore.recordActivity(session.user.id, 'login_via_password', '')
        appendSetCookie(response, buildPendingTwoFactorCookie(pending.token))
        sendJson(response, 200, { next: 'two-factor' })
        return
      }
      if (isOwner && !totpState?.totpEnabled) {
        await appDataStore.revokeUserSession(session.sessionId)
        const pending = await appDataStore.createPendingTwoFactor(session.user.id, true)
        await appDataStore.recordActivity(session.user.id, 'login_via_password', '')
        appendSetCookie(response, buildPendingTwoFactorCookie(pending.token))
        sendJson(response, 200, { next: 'two-factor-setup' })
        return
      }

      await appDataStore.recordActivity(session.user.id, 'login_via_password', '')
      appendSetCookie(response, buildSessionCookie(session.sessionId))
      sendJson(response, 200, { next: 'home' })
      return
    }

    // Set or change the caller's own password. The session cookie IS the
    // authorization — anyone who can sign in (magic-link or password) gets
    // to set their own password. Matches the standard "password reset via
    // email" pattern other apps use: prove you can read the inbox, then set
    // a new credential. No current-password check, so a user who signed in
    // via magic link can establish their first password without already
    // knowing one. Minimum 8 chars.
    if (normalizedPath === '/api/auth/change-password' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      let payload
      try {
        payload = await readJsonBody(request)
      } catch {
        sendJson(response, 400, { error: 'Invalid request body' })
        return
      }
      const newPassword = typeof payload?.newPassword === 'string' ? payload.newPassword : ''
      if (newPassword.length < 8) {
        sendJson(response, 400, { error: 'Password must be at least 8 characters' })
        return
      }
      const ok = await appDataStore.setUserPassword(session.user.id, newPassword)
      if (!ok) {
        sendJson(response, 500, { error: 'Could not update password' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'password_changed', '')
      sendJson(response, 200, { ok: true })
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
        // Both sidebar colors are part of the public surface so the
        // pre-sign-in screens (login, magic-link confirmation, etc.)
        // render the same branding as the authenticated app.
        sidebarTextColor: settings.sidebarTextColor ?? '#ffffff',
        sidebarActiveTextColor: settings.sidebarActiveTextColor ?? '#ffffff',
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
        // Preview-as: an owner may request the dataset another user would see
        // by passing `?previewAs=<userId>`. The param is honored ONLY when the
        // real session user is an owner and the target user exists; otherwise
        // it is silently ignored and the caller gets their own scoped data.
        let scopingSession = session
        const previewAs = requestUrl.searchParams.get('previewAs')
        if (previewAs && session.user.role === 'owner') {
          const target = (data.employees ?? []).find(
            (employee) => employee.id === previewAs,
          )
          if (target) {
            // scopeAppDataForSession only reads user.id and user.role, so a
            // minimal synthetic user is enough to scope the dataset as the
            // previewed person.
            scopingSession = {
              ...session,
              user: {
                ...session.user,
                id: target.id,
                role: target.role === 'Owner' ? 'owner' : 'employee',
              },
            }
          }
        }
        sendJson(response, 200, scopeAppDataForSession(scopingSession, data))
        return
      }

      if (request.method === 'PUT') {
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can update workspace configuration' })
          return
        }

        const data = await readJsonBody(request)
        try {
          await appDataStore.write(data)
        } catch (error) {
          // Surface the real SQL/JS error so the client can show / log it
          // instead of falling through to the generic 500. Without this the
          // autosave failure mode is "Latest changes could not be saved"
          // with no clue what's actually wrong.
          console.error('[bulk-save] write() failed:', error)
          sendJson(response, 500, {
            error: 'bulk_save_failed',
            message: error?.message || String(error),
            code: error?.code,
            constraint: error?.constraint,
            detail: error?.detail,
          })
          return
        }
        sendJson(response, 200, { ok: true })
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    // One-shot maintenance: hard-delete orphan rows whose `client_id`
    // points to a client that no longer exists. Built to unstick the
    // "delete never works" symptom that appears after a client deletion
    // leaves dangling checklists/templates/etc. in the DB. Owner-only.
    // One-shot maintenance: set a user's email by id. Built to undo the
    // bulk-save bug that overwrote real email addresses with the
    // synthetic `${id}@pbj.local` placeholder, locking the owner out
    // of magic-link sign-in. Owner-only. Touches only the email column
    // — 2FA, password, sessions all preserved.
    if (normalizedPath === '/api/maintenance/set-user-emails') {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can update emails' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const updates = Array.isArray(body?.updates) ? body.updates : []
        if (updates.length === 0) {
          sendJson(response, 400, { error: 'Body must include a non-empty `updates` array of {userId, email}' })
          return
        }
        const results = []
        for (const update of updates) {
          if (!update || typeof update.userId !== 'string' || typeof update.email !== 'string') {
            results.push({ userId: update?.userId, ok: false, reason: 'invalid_shape' })
            continue
          }
          const updated = await appDataStore.setUserEmail(update.userId, update.email)
          results.push({ userId: update.userId, ok: !!updated, email: update.email })
        }
        sendJson(response, 200, { ok: true, results })
      } catch (error) {
        console.error('[set-user-emails] failed:', error)
        sendJson(response, 500, {
          error: 'set_user_emails_failed',
          message: error?.message || String(error),
          code: error?.code,
          constraint: error?.constraint,
        })
      }
      return
    }

    if (normalizedPath === '/api/maintenance/cleanup-orphans') {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can run cleanup' })
        return
      }
      try {
        const counts = await appDataStore.cleanupOrphanedClientData()
        sendJson(response, 200, { ok: true, removed: counts })
      } catch (error) {
        console.error('[cleanup-orphans] failed:', error)
        sendJson(response, 500, {
          error: 'cleanup_failed',
          message: error?.message || String(error),
          code: error?.code,
          constraint: error?.constraint,
          detail: error?.detail,
        })
      }
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
        // Legacy "work type" — the UI no longer surfaces it. We keep the DB
        // column populated so the not-null constraint is satisfied.
        const category =
          typeof payload?.category === 'string' && payload.category.trim()
            ? payload.category
            : 'General'
        const description = typeof payload?.description === 'string' ? payload.description : ''
        const billable = Boolean(payload?.billable)
        const taskIdRaw = payload?.taskId
        const taskId =
          typeof taskIdRaw === 'string' && taskIdRaw.trim() ? taskIdRaw.trim() : null
        // Capture method: anything other than an explicit 'manual' is a timer
        // entry. A manual entry must carry a non-empty reason; timer-stop and
        // any non-manual creation ignore manualReason entirely.
        const { entryMethod, manualReason, error: methodError } =
          normalizeTimeEntryMethod(payload)

        if (!employeeId || !clientId || !date || Number.isNaN(minutes) || minutes <= 0) {
          sendJson(response, 400, { error: 'Invalid time entry payload' })
          return
        }

        if (methodError) {
          sendJson(response, 400, { error: methodError })
          return
        }

        // Month-end lock enforcement: a bookkeeper cannot log time dated within
        // a locked period. Owners are exempt (they're the approver/adjuster).
        if (session.user.role !== 'owner') {
          const period = String(date).slice(0, 7)
          if (await appDataStore.isTimesheetLocked(employeeId, period)) {
            sendJson(response, 423, {
              error: 'This timesheet month is locked. Contact an owner to make changes.',
            })
            return
          }
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
          entryMethod,
          manualReason: entryMethod === 'manual' ? manualReason : undefined,
        })

        // Manual entries are deliberately gated: log the submission and ping
        // every owner so they know a non-timer entry is waiting for approval.
        // Timer-stopped entries enter the approval queue silently, as before.
        if (entryMethod === 'manual') {
          const client = (allData.clients ?? []).find((c) => c.id === clientId)
          const clientLabel = client?.name ?? 'a client'
          const employee = (allData.employees ?? []).find((e) => e.id === employeeId)
          const employeeLabel = employee?.name ?? 'An employee'
          const hoursLabel = (minutes / 60).toFixed(2).replace(/\.?0+$/, '')

          await appDataStore.recordActivity(
            employeeId,
            'time_entry_manual_submitted',
            `${employeeLabel} · ${clientLabel}`,
          )

          try {
            const members = await appDataStore.getTeamMembers()
            const owners = members.filter((member) => member.role === 'owner')
            for (const owner of owners) {
              // The submitter, if an owner, does not notify themselves — but
              // every other owner is still alerted.
              if (owner.id === session.user.id) continue
              await notify(appDataStore, owner.id, 'time_entry_manual', {
                timeEntryId: entry.id,
                employeeId,
                clientId,
                message: `Manual time entry from ${employeeLabel} needs approval — ${clientLabel}, ${hoursLabel}h on ${date}.`,
                link: '/time-approvals',
                appPublicUrl: getPublicAppUrl(request),
              })
            }
          } catch (err) {
            console.error('[notify] time_entry_manual dispatch failed:', err?.message || err)
          }
        }

        sendJson(response, 201, entry)
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    // Batch approve — owner only. Defined before the :id routes so the literal
    // path isn't shadowed by the parameterized matcher.
    if (normalizedPath === '/api/time-entries/approve-batch') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can approve time entries' })
        return
      }
      const payload = await readJsonBody(request)
      const entryIds = Array.isArray(payload?.entryIds)
        ? payload.entryIds.filter((id) => typeof id === 'string')
        : []
      if (entryIds.length === 0) {
        sendJson(response, 400, { error: 'entryIds is required' })
        return
      }
      const updated = await appDataStore.approveTimeEntries(entryIds, session.user.id)
      await appDataStore.recordActivity(
        session.user.id,
        'time_entries_batch_approved',
        `${updated} entr${updated === 1 ? 'y' : 'ies'}`,
      )
      sendJson(response, 200, { ok: true, approved: updated })
      return
    }

    // Approve / reject / edit / delete a single time entry.
    const timeEntryActionMatch = normalizedPath.match(
      /^\/api\/time-entries\/([^/]+)(?:\/(approve|reject))?$/,
    )
    if (timeEntryActionMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      const entryId = timeEntryActionMatch[1]
      const action = timeEntryActionMatch[2]
      const entry = await appDataStore.getTimeEntry(entryId)
      if (!entry) {
        sendJson(response, 404, { error: 'Time entry not found' })
        return
      }

      // ---- Approve ----
      if (action === 'approve') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed' })
          return
        }
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can approve time entries' })
          return
        }
        const updated = await appDataStore.updateTimeEntry(entryId, {
          approvalStatus: 'approved',
          approvedBy: session.user.id,
          approvedAt: new Date().toISOString(),
          approvalNote: null,
        })
        await appDataStore.recordActivity(session.user.id, 'time_entry_approved', entryId)
        sendJson(response, 200, updated)
        return
      }

      // ---- Reject ----
      if (action === 'reject') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed' })
          return
        }
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can reject time entries' })
          return
        }
        const payload = await readJsonBody(request)
        const note = typeof payload?.note === 'string' ? payload.note.trim() : ''
        if (!note) {
          sendJson(response, 400, { error: 'A rejection note is required' })
          return
        }
        const updated = await appDataStore.updateTimeEntry(entryId, {
          approvalStatus: 'rejected',
          approvalNote: note,
          approvedBy: session.user.id,
          approvedAt: new Date().toISOString(),
        })
        await appDataStore.recordActivity(session.user.id, 'time_entry_rejected', entryId)
        sendJson(response, 200, updated)
        return
      }

      // ---- Edit (PATCH) ----
      if (request.method === 'PATCH') {
        const isOwner = session.user.role === 'owner'
        if (!isOwner && entry.employeeId !== session.user.id) {
          sendJson(response, 403, { error: 'You can only edit your own time entries' })
          return
        }
        const payload = await readJsonBody(request)
        const patch = {}
        if (typeof payload?.minutes === 'number' || typeof payload?.minutes === 'string') {
          const m = Number(payload.minutes)
          if (Number.isNaN(m) || m <= 0) {
            sendJson(response, 400, { error: 'Invalid minutes' })
            return
          }
          patch.minutes = Math.round(m)
        }
        if (typeof payload?.description === 'string') patch.description = payload.description
        if (typeof payload?.billable === 'boolean') patch.billable = payload.billable
        if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'taskId')) {
          patch.taskId =
            typeof payload.taskId === 'string' && payload.taskId.trim()
              ? payload.taskId.trim()
              : null
        }
        if (typeof payload?.date === 'string' && payload.date) patch.date = payload.date

        // Lock enforcement: bookkeepers cannot edit entries in a locked month.
        // Owners are exempt. Check both the current and any new date.
        if (!isOwner) {
          const periods = new Set([String(entry.date).slice(0, 7)])
          if (patch.date) periods.add(String(patch.date).slice(0, 7))
          for (const period of periods) {
            if (await appDataStore.isTimesheetLocked(entry.employeeId, period)) {
              sendJson(response, 423, {
                error: 'This timesheet month is locked. Contact an owner to make changes.',
              })
              return
            }
          }
        }

        // Editing a rejected entry resubmits it: status flips back to pending.
        if (entry.approvalStatus === 'rejected') {
          patch.approvalStatus = 'pending'
          patch.approvalNote = null
          patch.approvedBy = null
          patch.approvedAt = null
        }

        const updated = await appDataStore.updateTimeEntry(entryId, patch)
        sendJson(response, 200, updated)
        return
      }

      // ---- Delete ----
      if (request.method === 'DELETE') {
        const isOwner = session.user.role === 'owner'
        if (!isOwner && entry.employeeId !== session.user.id) {
          sendJson(response, 403, { error: 'You can only delete your own time entries' })
          return
        }
        if (!isOwner) {
          const period = String(entry.date).slice(0, 7)
          if (await appDataStore.isTimesheetLocked(entry.employeeId, period)) {
            sendJson(response, 423, {
              error: 'This timesheet month is locked. Contact an owner to make changes.',
            })
            return
          }
        }
        const removed = await appDataStore.deleteTimeEntry(entryId)
        if (!removed) {
          sendJson(response, 404, { error: 'Time entry not found' })
          return
        }
        sendJson(response, 200, { ok: true })
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    // Month-end timesheet lock / unlock — owner only.
    if (normalizedPath === '/api/timesheets/lock' || normalizedPath === '/api/timesheets/unlock') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can manage timesheet locks' })
        return
      }
      const payload = await readJsonBody(request)
      const userId = typeof payload?.userId === 'string' ? payload.userId : ''
      const period = typeof payload?.period === 'string' ? payload.period.trim() : ''
      if (!userId || !/^\d{4}-\d{2}$/.test(period)) {
        sendJson(response, 400, { error: 'userId and a YYYY-MM period are required' })
        return
      }

      if (normalizedPath === '/api/timesheets/lock') {
        const lock = await appDataStore.lockTimesheet(userId, period, session.user.id)
        await appDataStore.recordActivity(
          session.user.id,
          'timesheet_locked',
          `${userId} · ${period}`,
        )
        sendJson(response, 200, { ok: true, lock })
        return
      }

      const removed = await appDataStore.unlockTimesheet(userId, period)
      await appDataStore.recordActivity(
        session.user.id,
        'timesheet_unlocked',
        `${userId} · ${period}`,
      )
      sendJson(response, 200, { ok: true, removed })
      return
    }

    // Weekly lock-for-review: the bookkeeper / accountant submits their
    // own Sun-Sat week. The userId always comes from the session — users
    // can never submit on behalf of someone else from this endpoint.
    if (normalizedPath === '/api/timesheets/weekly-submissions') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const weekStart = typeof payload?.weekStart === 'string' ? payload.weekStart.trim() : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
        sendJson(response, 400, { error: 'weekStart must be a YYYY-MM-DD date' })
        return
      }
      // Sanity: enforce that the date is actually a Sunday so a buggy
      // client can't anchor the row mid-week. JS getDay(): Sun = 0.
      const anchor = new Date(`${weekStart}T12:00:00`)
      if (anchor.getDay() !== 0) {
        sendJson(response, 400, { error: 'weekStart must be a Sunday' })
        return
      }
      const submission = await appDataStore.submitWeeklyTimesheet(session.user.id, weekStart)
      if (!submission) {
        sendJson(response, 404, { error: 'Unable to record submission' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'weekly_timesheet_submitted',
        `Week of ${weekStart}`,
      )
      sendJson(response, 200, submission)
      return
    }

    // Owner-only weekly approve / reject.
    const weeklyApproveMatch = normalizedPath.match(
      /^\/api\/timesheets\/weekly-submissions\/([^/]+)\/approve$/,
    )
    if (weeklyApproveMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can approve weekly timesheets' })
        return
      }
      const submission = await appDataStore.approveWeeklySubmission(
        weeklyApproveMatch[1],
        session.user.id,
      )
      if (!submission) {
        sendJson(response, 404, { error: 'No pending submission with that id' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'weekly_timesheet_approved',
        `${submission.userId} · ${submission.weekStart}`,
      )
      sendJson(response, 200, submission)
      return
    }

    const weeklyRejectMatch = normalizedPath.match(
      /^\/api\/timesheets\/weekly-submissions\/([^/]+)\/reject$/,
    )
    if (weeklyRejectMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can reject weekly timesheets' })
        return
      }
      const payload = await readJsonBody(request)
      const note = typeof payload?.note === 'string' ? payload.note : ''
      const submission = await appDataStore.rejectWeeklySubmission(
        weeklyRejectMatch[1],
        session.user.id,
        note,
      )
      if (!submission) {
        sendJson(response, 404, { error: 'No pending submission with that id' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'weekly_timesheet_rejected',
        `${submission.userId} · ${submission.weekStart}`,
      )
      sendJson(response, 200, submission)
      return
    }

    // Owner-only reimbursement create — body { clientId, date, description, amount }.
    // Owner-only subscription plan delete — DELETE /api/plans/:id.
    // The clients.plan_id FK has `on delete set null`, so unlinking is
    // automatic. Response carries the affected client ids so the client
    // can mirror the unlink on local state without a full refetch.
    const planDeleteMatch = normalizedPath.match(/^\/api\/plans\/([^/]+)$/)
    if (planDeleteMatch && request.method === 'DELETE') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can delete plans' })
        return
      }
      const result = await appDataStore.deletePlan(planDeleteMatch[1])
      if (!result) {
        sendJson(response, 404, { error: 'Plan not found' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'plan_deleted',
        `${result.removedPlanId} (unlinked ${result.unlinkedClientIds.length} client${
          result.unlinkedClientIds.length === 1 ? '' : 's'
        })`,
      )
      sendJson(response, 200, result)
      return
    }

    if (normalizedPath === '/api/reimbursements' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can add reimbursements' })
        return
      }
      const payload = await readJsonBody(request)
      const created = await appDataStore.addReimbursement({
        clientId: typeof payload?.clientId === 'string' ? payload.clientId : '',
        date: typeof payload?.date === 'string' ? payload.date.trim() : '',
        description: typeof payload?.description === 'string' ? payload.description : '',
        amount: payload?.amount,
      })
      if (!created) {
        sendJson(response, 400, {
          error:
            'Invalid reimbursement. Need clientId, YYYY-MM-DD date, description, and positive amount.',
        })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'reimbursement_added',
        `${created.description} ($${created.amount})`,
      )
      sendJson(response, 201, created)
      return
    }

    // Owner-only recurring reimbursement create.
    if (normalizedPath === '/api/recurring-reimbursements' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can add recurring reimbursements' })
        return
      }
      const payload = await readJsonBody(request)
      const created = await appDataStore.addRecurringReimbursement({
        clientId: typeof payload?.clientId === 'string' ? payload.clientId : '',
        description: typeof payload?.description === 'string' ? payload.description : '',
        amount: payload?.amount,
        frequency: payload?.frequency,
        startDate: typeof payload?.startDate === 'string' ? payload.startDate.trim() : '',
      })
      if (!created) {
        sendJson(response, 400, {
          error:
            'Invalid recurring reimbursement. Need clientId, description, positive amount, frequency (monthly/quarterly/annually), and YYYY-MM-DD startDate.',
        })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'recurring_reimbursement_added',
        `${created.description} ($${created.amount} ${created.frequency})`,
      )
      sendJson(response, 201, created)
      return
    }

    // Owner-only recurring reimbursement update / delete.
    const recurringReimbMatch = normalizedPath.match(
      /^\/api\/recurring-reimbursements\/([^/]+)$/,
    )
    if (recurringReimbMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can change recurring reimbursements' })
        return
      }
      const id = recurringReimbMatch[1]
      if (request.method === 'PATCH') {
        const payload = await readJsonBody(request)
        const patch = {}
        if (typeof payload?.description === 'string') patch.description = payload.description
        if (payload?.amount !== undefined) patch.amount = payload.amount
        if (typeof payload?.frequency === 'string') patch.frequency = payload.frequency
        if (typeof payload?.startDate === 'string') patch.startDate = payload.startDate.trim()
        const updated = await appDataStore.updateRecurringReimbursement(id, patch)
        if (!updated) {
          sendJson(response, 400, { error: 'Recurring reimbursement not found or update invalid.' })
          return
        }
        await appDataStore.recordActivity(
          session.user.id,
          'recurring_reimbursement_updated',
          updated.id,
        )
        sendJson(response, 200, updated)
        return
      }
      if (request.method === 'DELETE') {
        const removed = await appDataStore.deleteRecurringReimbursement(id)
        if (!removed) {
          sendJson(response, 404, { error: 'Recurring reimbursement not found' })
          return
        }
        await appDataStore.recordActivity(
          session.user.id,
          'recurring_reimbursement_deleted',
          id,
        )
        sendEmpty(response, 204)
        return
      }
      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    // Owner-only reimbursement update / delete — /api/reimbursements/:id.
    const reimbursementMatch = normalizedPath.match(/^\/api\/reimbursements\/([^/]+)$/)
    if (reimbursementMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can change reimbursements' })
        return
      }
      const id = reimbursementMatch[1]
      if (request.method === 'PATCH') {
        const payload = await readJsonBody(request)
        const patch = {}
        if (typeof payload?.date === 'string') patch.date = payload.date.trim()
        if (typeof payload?.description === 'string') patch.description = payload.description
        if (payload?.amount !== undefined) patch.amount = payload.amount
        const updated = await appDataStore.updateReimbursement(id, patch)
        if (!updated) {
          sendJson(response, 400, { error: 'Reimbursement not found or update invalid.' })
          return
        }
        await appDataStore.recordActivity(session.user.id, 'reimbursement_updated', updated.id)
        sendJson(response, 200, updated)
        return
      }
      if (request.method === 'DELETE') {
        const removed = await appDataStore.deleteReimbursement(id)
        if (!removed) {
          sendJson(response, 404, { error: 'Reimbursement not found' })
          return
        }
        await appDataStore.recordActivity(session.user.id, 'reimbursement_deleted', id)
        sendEmpty(response, 204)
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
                // Nested sub-steps / sub-sub-steps from the outliner-style
                // create form. `appDataStore.createChecklist` normalizes these
                // (fresh ids, roll-up done) — we just pass the raw tree through.
                ...(Array.isArray(item?.subItems) ? { subItems: item.subItems } : {}),
              }))
              // Keep a blank-label item when it still has labelled sub-steps —
              // matches the client's prune so typed sub-steps are never dropped
              // just because the parent row was left blank.
              .filter(checklistItemHasText)
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

    // DELETE /api/checklists/recycle-bin — owner-only "empty the bin".
    // Must be checked BEFORE the generic `:id` matcher below, otherwise the
    // `:id` regex would treat "recycle-bin" as a checklist id and 404.
    if (normalizedPath === '/api/checklists/recycle-bin') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method !== 'DELETE') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can empty the recycle bin' })
        return
      }

      const removed = await appDataStore.emptyChecklistRecycleBin()
      if (removed > 0) {
        await appDataStore.recordActivity(
          session.user.id,
          'checklist_bin_emptied',
          `${removed} task${removed === 1 ? '' : 's'}`,
        )
      }
      sendJson(response, 200, { ok: true, removed })
      return
    }

    // POST /api/checklists/:id/restore — owner-only restore from the bin.
    const checklistRestoreMatch = normalizedPath.match(
      /^\/api\/checklists\/([^/]+)\/restore$/,
    )
    if (checklistRestoreMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can restore a checklist' })
        return
      }

      const checklistId = checklistRestoreMatch[1]
      const restored = await appDataStore.restoreChecklist(checklistId)
      if (!restored) {
        sendJson(response, 404, { error: 'Recycled checklist not found' })
        return
      }

      await appDataStore.recordActivity(session.user.id, 'checklist_restored', restored.title)
      sendJson(response, 200, restored)
      return
    }

    // DELETE /api/checklists/:id — owner-only soft delete (move to bin).
    // The matcher's trailing `$` keeps it from poaching the more-specific
    // /items/... routes below; those still resolve to their own handlers.
    const checklistDeleteMatch = normalizedPath.match(/^\/api\/checklists\/([^/]+)$/)
    if (checklistDeleteMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method !== 'DELETE') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can delete checklists' })
        return
      }

      const checklistId = checklistDeleteMatch[1]
      // Capture the title for the activity log before the row is gone.
      const existing = await appDataStore.read()
      const target = existing.checklists.find((entry) => entry.id === checklistId)
      if (!target) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      const removed = await appDataStore.deleteChecklist(checklistId)
      if (!removed) {
        // Raced with another deleter — same UX as 404 from the client's view.
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      await appDataStore.recordActivity(session.user.id, 'checklist_deleted', target.title)
      sendJson(response, 200, { ok: true, removed: checklistId })
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

      // Optional `subItemId` / `subSubItemId`: when present, toggle that
      // sub-item or sub-sub-item and let the store recompute the parent
      // roll-ups. Nested items inherit the parent item's permission context
      // (checked above), so no extra auth is needed.
      let toggleSubItemId
      let toggleSubSubItemId
      try {
        const body = await readJsonBody(request)
        if (body && typeof body.subItemId === 'string' && body.subItemId.trim()) {
          toggleSubItemId = body.subItemId.trim()
        }
        if (body && typeof body.subSubItemId === 'string' && body.subSubItemId.trim()) {
          toggleSubSubItemId = body.subSubItemId.trim()
        }
      } catch {
        // No body — plain item toggle.
      }
      let targetSub
      if (toggleSubItemId) {
        targetSub = Array.isArray(targetItem.subItems)
          ? targetItem.subItems.find((sub) => sub.id === toggleSubItemId)
          : undefined
        if (!targetSub) {
          sendJson(response, 404, { error: 'Sub-item not found' })
          return
        }
      }
      if (toggleSubSubItemId) {
        // A sub-sub-item can only be toggled within a known sub-item.
        if (!toggleSubItemId) {
          sendJson(response, 400, { error: 'subItemId is required to toggle a sub-sub-item' })
          return
        }
        const targetSubSub = Array.isArray(targetSub?.subItems)
          ? targetSub.subItems.find((subSub) => subSub.id === toggleSubSubItemId)
          : undefined
        if (!targetSubSub) {
          sendJson(response, 404, { error: 'Sub-sub-item not found' })
          return
        }
      }

      const toggleResult = await appDataStore.toggleChecklistItem(
        checklistId,
        itemId,
        toggleSubItemId,
        toggleSubSubItemId,
      )
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

    // POST   /api/checklists/:id/items/:itemId/sub-items/:subItemId/sub-items                — add a sub-sub-item
    // DELETE /api/checklists/:id/items/:itemId/sub-items/:subItemId/sub-items/:subSubItemId  — remove a sub-sub-item
    // Sub-sub-items inherit the parent item's permission context (owner /
    // primary assignee / editor / per-item assignee), exactly like sub-items.
    // Matched BEFORE the sub-item route below since this is the deeper path.
    const checklistSubSubItemMatch = normalizedPath.match(
      /^\/api\/checklists\/([^/]+)\/items\/([^/]+)\/sub-items\/([^/]+)\/sub-items(?:\/([^/]+))?$/,
    )
    if (checklistSubSubItemMatch) {
      const session = await requireSession(request, response)
      if (!session) return

      const checklistId = checklistSubSubItemMatch[1]
      const itemId = checklistSubSubItemMatch[2]
      const subItemId = checklistSubSubItemMatch[3]
      const subSubItemId = checklistSubSubItemMatch[4] // undefined for the collection route

      const data = await appDataStore.read()
      const checklist = data.checklists.find((entry) => entry.id === checklistId)
      if (!checklist) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }
      const targetItem = checklist.items.find((item) => item.id === itemId)
      if (!targetItem) {
        sendJson(response, 404, { error: 'Checklist item not found' })
        return
      }
      const targetSub = Array.isArray(targetItem.subItems)
        ? targetItem.subItems.find((sub) => sub.id === subItemId)
        : undefined
      if (!targetSub) {
        sendJson(response, 404, { error: 'Sub-item not found' })
        return
      }

      const editorIds = Array.isArray(checklist.editorIds) ? checklist.editorIds : []
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

      // --- POST: add a sub-sub-item ---
      if (!subSubItemId && request.method === 'POST') {
        const payload = await readJsonBody(request)
        const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
        if (!title) {
          sendJson(response, 400, { error: 'Sub-sub-item title is required' })
          return
        }
        const updated = await appDataStore.addChecklistSubSubItem(
          checklistId,
          itemId,
          subItemId,
          title,
        )
        if (!updated) {
          sendJson(response, 404, { error: 'Sub-item not found' })
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

      // --- DELETE: remove a sub-sub-item ---
      if (subSubItemId && request.method === 'DELETE') {
        const updated = await appDataStore.removeChecklistSubSubItem(
          checklistId,
          itemId,
          subItemId,
          subSubItemId,
        )
        if (!updated) {
          sendJson(response, 404, { error: 'Sub-sub-item not found' })
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

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    // POST   /api/checklists/:id/items/:itemId/sub-items            — add a sub-item
    // DELETE /api/checklists/:id/items/:itemId/sub-items/:subItemId  — remove a sub-item
    // Sub-items inherit the parent item's permission context (owner / primary
    // assignee / editor / per-item assignee), exactly like toggling.
    const checklistSubItemMatch = normalizedPath.match(
      /^\/api\/checklists\/([^/]+)\/items\/([^/]+)\/sub-items(?:\/([^/]+))?$/,
    )
    if (checklistSubItemMatch) {
      const session = await requireSession(request, response)
      if (!session) return

      const checklistId = checklistSubItemMatch[1]
      const itemId = checklistSubItemMatch[2]
      const subItemId = checklistSubItemMatch[3] // undefined for the collection route

      const data = await appDataStore.read()
      const checklist = data.checklists.find((entry) => entry.id === checklistId)
      if (!checklist) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }
      const targetItem = checklist.items.find((item) => item.id === itemId)
      if (!targetItem) {
        sendJson(response, 404, { error: 'Checklist item not found' })
        return
      }

      const editorIds = Array.isArray(checklist.editorIds) ? checklist.editorIds : []
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

      // --- POST: add a sub-item ---
      if (!subItemId && request.method === 'POST') {
        const payload = await readJsonBody(request)
        const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
        if (!title) {
          sendJson(response, 400, { error: 'Sub-item title is required' })
          return
        }
        const updated = await appDataStore.addChecklistSubItem(checklistId, itemId, title)
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

      // --- DELETE: remove a sub-item ---
      if (subItemId && request.method === 'DELETE') {
        const updated = await appDataStore.removeChecklistSubItem(checklistId, itemId, subItemId)
        if (!updated) {
          sendJson(response, 404, { error: 'Sub-item not found' })
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

      sendJson(response, 405, { error: 'Method not allowed' })
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

    if (normalizedPath === '/api/team/reorder' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can reorder the team' })
        return
      }
      const payload = await readJsonBody(request)
      const userIds = Array.isArray(payload?.userIds)
        ? payload.userIds.filter((id) => typeof id === 'string')
        : []
      if (userIds.length === 0) {
        sendJson(response, 400, { error: 'userIds (a non-empty array) is required' })
        return
      }
      const members = await appDataStore.reorderTeamMembers(userIds)
      if (!members) {
        sendJson(response, 404, { error: 'No matching team members to reorder' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'team_reordered', '')
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
      // Safety net: removing the owner's own record would orphan the firm
      // and break the auth flow. Block it server-side regardless of UI gates.
      if (userId === session.user.id) {
        sendJson(response, 400, { error: 'You cannot remove your own account' })
        return
      }

      // Pass the calling owner's id so the store can reassign FK-blocking
      // references (checklists, templates, time entries) onto them in the
      // same transaction as the user-row delete. No more "has_checklists"
      // rejection — the cleanup happens inline.
      const result = await appDataStore.deleteTeamMember(userId, session.user.id)
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

    // ---- Wave 2: standard templates, apply/copy to client, on-demand generate ----

    // POST /api/checklist-templates/standard — create a standard (client-agnostic)
    // reusable blueprint template. Owner only. Declared before the parameterized
    // routes below so the literal `standard` segment isn't read as a template id.
    if (normalizedPath === '/api/checklist-templates/standard' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can create standard templates' })
        return
      }
      const payload = await readJsonBody(request)
      const template = await appDataStore.createStandardTemplate(payload ?? {})
      await appDataStore.recordActivity(
        session.user.id,
        'standard_template_created',
        template.title,
      )
      sendJson(response, 201, template)
      return
    }

    // POST /api/checklist-templates/:id/apply-to-client — copy a standard OR
    // regular template onto a client, producing a NEW regular client-bound
    // template. Owner only. Body: { clientId, firstDueDate?, frequency? }.
    const applyToClientMatch = normalizedPath.match(
      /^\/api\/checklist-templates\/([^/]+)\/apply-to-client$/,
    )
    if (applyToClientMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can apply templates to clients' })
        return
      }
      const sourceId = applyToClientMatch[1]
      const payload = await readJsonBody(request)
      const clientId = typeof payload?.clientId === 'string' ? payload.clientId : ''
      const firstDueDate =
        typeof payload?.firstDueDate === 'string' ? payload.firstDueDate : undefined
      const frequency = typeof payload?.frequency === 'string' ? payload.frequency : undefined
      if (!clientId) {
        sendJson(response, 400, { error: 'A target client is required' })
        return
      }
      const data = await appDataStore.read()
      const source = (data.checklistTemplates ?? []).find((t) => t.id === sourceId)
      if (!source) {
        sendJson(response, 404, { error: 'Template not found' })
        return
      }
      if (!data.clients.some((client) => client.id === clientId)) {
        sendJson(response, 400, { error: 'Invalid target client' })
        return
      }
      const copy = await appDataStore.copyTemplateToClient(sourceId, {
        clientId,
        firstDueDate,
        frequency,
      })
      if (!copy) {
        sendJson(response, 404, { error: 'Template not found' })
        return
      }
      // Auto-grant: the copied template's assignee(s) gain client visibility.
      if (copy.assigneeId) {
        await appDataStore.grantClientVisibility(copy.clientId, copy.assigneeId)
      }
      for (const stage of copy.stages ?? []) {
        if (stage.assigneeId) {
          await appDataStore.grantClientVisibility(copy.clientId, stage.assigneeId)
        }
      }
      // A standard source is "applied"; a client-bound source is "copied".
      await appDataStore.recordActivity(
        session.user.id,
        source.isStandard ? 'template_applied_to_client' : 'template_copied_to_client',
        copy.title,
      )
      sendJson(response, 201, copy)
      return
    }

    // POST /api/checklist-templates/:id/generate — materialize a Stage-1
    // checklist instance from a template on demand ("Generate a task now" /
    // "Start the first one now"). Owner only. Body: { dueDate? }.
    const templateGenerateMatch = normalizedPath.match(
      /^\/api\/checklist-templates\/([^/]+)\/generate$/,
    )
    if (templateGenerateMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can generate tasks' })
        return
      }
      const templateId = templateGenerateMatch[1]
      const payload = await readJsonBody(request)
      const dueDate = typeof payload?.dueDate === 'string' ? payload.dueDate : undefined
      const data = await appDataStore.read()
      const template = (data.checklistTemplates ?? []).find((t) => t.id === templateId)
      if (!template) {
        sendJson(response, 404, { error: 'Template not found' })
        return
      }
      if (template.isStandard) {
        sendJson(response, 400, {
          error: 'Standard templates cannot generate tasks — apply to a client first',
        })
        return
      }
      const checklist = await appDataStore.generateChecklistFromTemplate(templateId, { dueDate })
      if (!checklist) {
        sendJson(response, 400, {
          error: 'This template has no checklist items in its first step yet',
        })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'checklist_created',
        checklist.title,
      )
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
// Bulletproof owner recovery: if `OWNER_BOOTSTRAP_PASSWORD` is set on the
// environment, ensure the first owner's password hash matches it. Lets an
// owner ALWAYS sign in via /owner → "Password" tab, even when email/Resend
// is broken. Idempotent — same value across reboots is a no-op.
await appDataStore.applyOwnerBootstrapPassword()

server.listen(port, '0.0.0.0', () => {
  console.log(`PBJ Strategic Accounting app listening on ${port}`)
})
