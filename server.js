import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { AppDataStore, coerceEntryMinutes, TimeEntrySplitError } from './db/store.js'
import {
  allocateGroupMinutes,
  classifySplitTarget,
  formatDurationLabel,
  minutesAfterEntryEdit,
  minutesToSeconds,
} from './lib/group-allocation.js'
import {
  buildActionProposal,
  confirmOwnerFeedback,
  executeAssistantAction,
  refineFeatureRequest,
  planSpitballCompaction,
  runAssistantChat,
  sanitizeReport,
  spitballChat,
  summarizeSpitballSession,
  validateAssistantAction,
  SPITBALL_CONTEXT_CAPS,
} from './lib/assistant.js'
import { createPendingActionStore } from './lib/pending-actions.js'
import { capacity, clientProfitability, deadlines, timeSummary } from './lib/firm-analytics.js'
import { buildMemoryDigest, safeEqual, verifyElevenLabsSignature } from './lib/voice.js'
import { buildClientRecap } from './lib/client-recap.js'
import { currentPeriod, isValidPeriod, isValidPeriodType } from './lib/periods.js'
import { detectUsagePatterns } from './lib/usage-patterns.js'
import {
  notify,
  sendDigestEmail,
  sendFeatureRequestEmail,
  sendInvoiceEmail,
  sendLoginLinkEmail,
  sendReportEmail,
} from './lib/notify.js'
import {
  buildInvoiceEmail,
  paymentEmailKindFor,
  resolveInvoiceRecipients,
  sendInvoicePaymentEmail,
} from './lib/invoice-email.js'
import { chooseInvoiceRecipients } from './lib/invoice-recipients.js'
import { buildInvoicePdf, invoicePdfFilename } from './lib/invoice-pdf.js'
import { cardProcessingFeeLine } from './lib/invoice-lines.js'
import { EMAIL_PREF_TYPES, sanitizeEmailPrefs } from './lib/notification-prefs.js'
import {
  listBlockingWeeks,
  normalizeTimeEntryMethod,
  normalizeWorkSessions,
  validateTimeEntryEdit,
  validateTimeEntryRequiredFields,
  weekStartOf,
} from './lib/time-entry.js'
import {
  diagnoseRecurringChecklists,
  diagnoseTimeLogging,
  summarizeRecentChanges,
} from './lib/diagnostics.js'
import {
  isClientVisibleToUser,
  isTemplateVisibleToScope,
  isTimeEntryVisibleToScope,
} from './lib/data-scope.js'
import { StaleWorkspaceError } from './lib/workspace-version.js'
import {
  templateApplyRoleDenial,
  templateApplyScopeDenial,
} from './lib/template-apply-permission.js'
import { checklistWriteDenial } from './lib/checklist-write-permission.js'
import { buildQboCsv } from './lib/qbo-export.js'
import {
  createInvoiceCardCheckoutSession,
  createInvoiceCheckoutSession,
  expireCheckoutSession,
  isStripeConfigured,
  isStripeWebhookConfigured,
  resolveWebhookChannel,
  stripeClient,
  verifyStripeEvent,
} from './lib/stripe-rail.js'
import {
  canMarkWaitingOnDone,
  canVerifyWaitingOn,
  isClientWait,
  waitingOnStage,
} from './lib/waiting-on-state.js'
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

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...extraHeaders,
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

/**
 * Carries the workspace staleness fingerprint: served on `GET /api/app-data`,
 * echoed by the tab on `PUT`, and returned again on a successful PUT (the write
 * moves the fingerprint, so the tab needs the new one). Lowercase because Node
 * lowercases inbound header names and HTTP/2 requires it outbound.
 */
const WORKSPACE_VERSION_HEADER = 'x-workspace-version'

// Generous cap for the bulk /api/app-data save while still bounding memory so
// an oversized (multi-GB) body can't OOM the process. Throws past the limit;
// the global request handler catch turns it into a 500.
const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024 // 10 MB

// True when the request declares a JSON body. Used to return a clean 415
// instead of letting a non-JSON body blow up inside JSON.parse → generic 500.
function isJsonContentType(request) {
  return String(request.headers['content-type'] || '')
    .toLowerCase()
    .includes('application/json')
}

async function readJsonBody(request) {
  const chunks = []
  let total = 0

  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_JSON_BODY_BYTES) {
      request.destroy()
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 })
    }
    chunks.push(chunk)
  }

  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : null
}

// Raw-body variant for webhook endpoints that must verify an HMAC signature
// computed over the exact bytes sent (parse AFTER verification).
async function readRawBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_JSON_BODY_BYTES) {
      request.destroy()
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
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
 * CSRF guard for auth POSTs. Rejects only when the browser sends an `Origin`
 * header whose host doesn't match the host this request was actually served on
 * (or the configured APP_PUBLIC_URL). A genuine same-origin sign-in always
 * passes, so the check no longer hard-depends on APP_PUBLIC_URL being set
 * exactly right — while a cross-site (CSRF) POST from another domain is still
 * blocked. A request with no Origin header (direct API / tooling) is allowed,
 * matching the prior behavior.
 */
// Action proposals filed by the VOICE agent, awaiting the owner's tap on a
// confirm card. The voice surface can only ever ADD here — execution lives
// solely behind the owner-session /api/assistant/action endpoint.
const pendingVoiceActions = createPendingActionStore()
// Reports the VOICE agent generated, awaiting the panel to pop them in a modal.
const pendingVoiceReports = createPendingActionStore()
// Feature-request drafts the VOICE agent created, awaiting the owner's tap.
const pendingVoiceFeatureRequests = createPendingActionStore()

// Assistant rate limit: in-memory sliding window per user (20 messages per
// 5 minutes). A runaway client (or a stuck retry loop) can't burn API spend.
const assistantRateWindows = new Map()
function consumeAssistantRateSlot(userId) {
  const now = Date.now()
  const windowMs = 5 * 60 * 1000
  const recent = (assistantRateWindows.get(userId) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= 20) {
    assistantRateWindows.set(userId, recent)
    return false
  }
  recent.push(now)
  assistantRateWindows.set(userId, recent)
  return true
}

// Compact, token-cheap snapshot of the firm's setup for the assistant's
// get_workspace_snapshot tool. Names and config only — no time-entry or
// billing line detail.
function buildWorkspaceSnapshot(data) {
  return {
    // Retired clients are deliberately still listed: the assistant is asked
    // "why did X stop generating?" and "what did we bill X last year?", and it
    // can only answer those if it can still find them. The flag is only
    // emitted when true, so the common case costs no tokens.
    clients: (data.clients ?? []).map((client) => ({
      name: client.name,
      ...(client.lifecycleStage === 'inactive' ? { inactive: true } : {}),
      billing: client.billingMode,
      plan: client.planId
        ? ((data.plans ?? []).find((plan) => plan.id === client.planId)?.name ?? null)
        : null,
      assignedTeam: (client.assignedBookkeeperIds ?? [])
        .map((id) => (data.employees ?? []).find((emp) => emp.id === id)?.name)
        .filter(Boolean),
    })),
    recurringTemplates: (data.checklistTemplates ?? []).map((template) => ({
      title: template.title,
      frequency: template.frequency,
      client: (data.clients ?? []).find((client) => client.id === template.clientId)?.name ?? null,
      active: template.active !== false,
    })),
    plans: (data.plans ?? []).map((plan) => ({ name: plan.name, monthlyFee: plan.monthlyFee })),
    team: (data.employees ?? []).map((emp) => ({ name: emp.name, role: emp.role })),
    openTaskCount: (data.checklists ?? []).filter(
      (checklist) => !checklist.deletedAt && (checklist.items ?? []).some((item) => !item.done),
    ).length,
  }
}

// Default weekly hours target for the assistant's capacity analytics; the
// model can override per-call. Configurable via env.
const CAPACITY_TARGET_HOURS =
  Number(process.env.ASSISTANT_CAPACITY_TARGET) > 0
    ? Number(process.env.ASSISTANT_CAPACITY_TARGET)
    : 40

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

// Cost rates live on the user record (owner-only, informational). Analytics
// keys them by employee id, which matches user id in both backends.
async function buildCostRateMap() {
  const members = await appDataStore.getTeamMembers()
  const map = {}
  for (const member of members) {
    map[member.id] = typeof member.costRate === 'number' ? member.costRate : null
  }
  return map
}

// Read-only analytics tools handed to the assistant loop (Phase 4, Track A).
// Each fills sensible date defaults the model omitted, then calls a pure
// aggregator in lib/firm-analytics.js. All owner-only via the chat endpoint.
function assistantReadTools() {
  return {
    get_client_profitability: async (input) => {
      const data = await appDataStore.read()
      const month = /^\d{4}-\d{2}$/.test(String(input.month || ''))
        ? input.month
        : todayIso().slice(0, 7)
      return clientProfitability(data, { month, costRates: await buildCostRateMap() })
    },
    get_time_summary: async (input) => {
      const data = await appDataStore.read()
      const today = todayIso()
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(input.from || ''))
        ? input.from
        : `${today.slice(0, 7)}-01`
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(input.to || '')) ? input.to : today
      const groupBy = ['client', 'staff', 'both'].includes(input.groupBy) ? input.groupBy : 'both'
      return timeSummary(data, { from, to, groupBy })
    },
    get_deadlines: async (input) => {
      const data = await appDataStore.read()
      const horizonDays = Number(input.horizonDays) > 0 ? Number(input.horizonDays) : 7
      return deadlines(data, { asOf: todayIso(), horizonDays })
    },
    get_capacity: async (input) => {
      const data = await appDataStore.read()
      const targetHours = Number(input.targetHours) > 0 ? Number(input.targetHours) : CAPACITY_TARGET_HOURS
      return capacity(data, { weekStart: weekStartOf(todayIso()), targetHours })
    },
    // ---- Tier 0 diagnostics: "why isn't X working?" ----
    // Read-only explanations of the two config traps this firm has actually
    // hit (a locked timesheet month, a recurring recipe missing an
    // ingredient), plus the activity log as plain English. The rules live in
    // lib/diagnostics.js and are the SAME ones the timer gate and the
    // materializer apply, so an answer here can't contradict the app.
    diagnose_time_logging: async (input) => {
      const data = await appDataStore.read()
      return diagnoseTimeLogging(data, {
        person: String(input.person ?? ''),
        today: todayIso(),
      })
    },
    diagnose_recurring_checklist: async (input) => {
      const data = await appDataStore.read()
      return diagnoseRecurringChecklists(data, {
        subject: typeof input.subject === 'string' ? input.subject : '',
        today: todayIso(),
      })
    },
    recent_changes: async (input) => {
      const days = Number(input.days) > 0 ? Math.min(Math.floor(Number(input.days)), 90) : 7
      const now = new Date()
      const nowStamp = now.toISOString()
      const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
      const [entries, members] = await Promise.all([
        appDataStore.getActivityRange(since, nowStamp, 2000),
        appDataStore.getTeamMembers(),
      ])
      return summarizeRecentChanges(entries, {
        subject: typeof input.subject === 'string' ? input.subject : '',
        days,
        now: nowStamp,
        nameById: Object.fromEntries(members.map((member) => [member.id, member.name])),
      })
    },
  }
}

function isCrossSiteOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return false
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return true // unparseable Origin → treat as cross-site
  }
  const allowedHosts = new Set()
  if (request.headers.host) allowedHosts.add(request.headers.host)
  // Behind a reverse proxy / CDN (the app is fronted by a custom domain), the
  // browser-facing host arrives in x-forwarded-host while `Host` may be the
  // internal origin. Trust it for the same-origin comparison so a legitimate
  // proxied request isn't wrongly flagged cross-site (it only ever ADDS an
  // allowed host — it can't loosen the check for a genuinely cross-site Origin).
  const forwardedHost = request.headers['x-forwarded-host']
  if (forwardedHost) {
    // x-forwarded-host can be a comma-separated list; take the first hop.
    allowedHosts.add(String(forwardedHost).split(',')[0].trim())
  }
  if (process.env.APP_PUBLIC_URL) {
    try {
      allowedHosts.add(new URL(process.env.APP_PUBLIC_URL).host)
    } catch {
      // ignore a malformed APP_PUBLIC_URL
    }
  }
  return !allowedHosts.has(originHost)
}

/**
 * Compute the set of client ids visible to a session. Owners always see
 * everything. Non-owners see only clients whose assigned team includes their
 * user id — `assignedTeamIds` in lib/data-scope.js is the one definition of
 * that team, shared with the frontend so the two cannot drift.
 */
// `weekStartOf` (the Sun–Sat week anchor) now lives in lib/time-entry.js beside
// the weekly gate that consumes it — imported above.

function visibleClientIdSet(session, clients) {
  if (session.user.role === 'owner') {
    return new Set(clients.map((client) => client.id))
  }
  const me = session.user.id
  return new Set(
    clients.filter((client) => isClientVisibleToUser(client, me)).map((client) => client.id),
  )
}

/**
 * Non-owner item-deletion flow (item / sub-item / sub-sub-item). Files a
 * deletion REQUEST (capturing the path + a label snapshot) instead of deleting,
 * skipping duplicates, and notifies every owner. Mirrors the whole-checklist
 * deletion-request flow. Returns the created (or existing) request so the
 * handler can 200 it back. The caller must have already confirmed the client is
 * in the user's visible set.
 */
async function fileItemDeletionRequest(
  request,
  session,
  data,
  checklist,
  { itemId, subItemId, subSubItemId, label },
) {
  const existing = await appDataStore.listItemDeletionRequests()
  const duplicate = existing.find(
    (req) =>
      req.checklistId === checklist.id &&
      req.itemId === itemId &&
      (req.subItemId ?? null) === (subItemId ?? null) &&
      (req.subSubItemId ?? null) === (subSubItemId ?? null),
  )
  if (duplicate) return duplicate

  const requesterName =
    (data.employees ?? []).find((e) => e.id === session.user.id)?.name ??
    session.user.name ??
    'A team member'
  const created = await appDataStore.createItemDeletionRequest({
    clientId: checklist.clientId,
    checklistId: checklist.id,
    itemId,
    subItemId: subItemId ?? null,
    subSubItemId: subSubItemId ?? null,
    label,
    requestedBy: session.user.id,
    requestedByName: requesterName,
  })
  await appDataStore.recordActivity(
    session.user.id,
    'checklist_item_deletion_requested',
    `${checklist.title}: ${label}`,
  )
  try {
    const members = await appDataStore.getTeamMembers()
    const owners = members.filter((member) => member.role === 'owner')
    for (const owner of owners) {
      await notify(appDataStore, owner.id, 'checklist_item_deletion_requested', {
        checklistId: checklist.id,
        message: `${requesterName} requested deletion of "${label}" in "${checklist.title}".`,
        link: '/checklists',
        appPublicUrl: getPublicAppUrl(request),
      })
    }
  } catch (err) {
    console.error(
      '[notify] checklist_item_deletion_requested dispatch failed:',
      err?.message || err,
    )
  }
  return created
}

/**
 * Human labels for Updates-tracker statuses, so a notification reads
 * "Shipped → Planned" rather than "shipped → planned". Mirrors the status
 * union in src/lib/types.ts (FeatureRequestStatus).
 */
const UPDATE_STATUS_LABELS = {
  new: 'New',
  planned: 'Planned',
  planned_not_eom: 'Planned (not near EOM)',
  in_progress: 'In progress',
  needs_input: 'Needs your answer',
  brainstorm: "Britt's Brain",
  shipped: 'Shipped',
  done: 'Done',
  wont_do: "Won't do",
}
const updateStatusLabel = (status) => UPDATE_STATUS_LABELS[status] ?? String(status ?? 'unknown')

/**
 * The context that makes "Just spitballing" feel continuous: the summaries of
 * her archived brainstorm sessions, and the titles of the ideas already parked
 * in Britt's Brain. Both are hard-capped in `buildSpitballContext` too; the
 * caps here keep the reads small as well.
 *
 * Best-effort by design — a brainstorm must never fail because the recall
 * lookup did, so a failure degrades to "no memory" rather than an error.
 */
async function loadSpitballMemory(userId) {
  try {
    const [pastSummaries, requests] = await Promise.all([
      appDataStore.listSpitballSummaries(userId, SPITBALL_CONTEXT_CAPS.pastSummaries),
      appDataStore.listFeatureRequests(),
    ])
    const brainstormTitles = requests
      .filter((item) => item.status === 'brainstorm')
      .slice(0, SPITBALL_CONTEXT_CAPS.draftTitles)
      .map((item) => item.title)
    return { pastSummaries, brainstormTitles }
  } catch (error) {
    console.error('[updates] spitball memory lookup failed:', error?.message || error)
    return { pastSummaries: [], brainstormTitles: [] }
  }
}

/** The session shape the SpitballModal consumes — turns only, no user ids. */
function serializeSpitballSession(session) {
  if (!session) return null
  return {
    id: session.id,
    messages: session.messages.map((message) => ({ role: message.role, text: message.text })),
  }
}

/**
 * Tell the OTHER owners about Updates-tracker activity — a new item logged, or
 * one moving status (shipped, sent back to planned, picked up…). The tracker is
 * owner-only and both owners work the queue, so this is how each stays aware of
 * what the other did without watching the page.
 *
 * Never notifies whoever made the change (they already know), and is
 * best-effort: a failure is logged and never breaks the write that triggered it.
 * Email delivery is gated by the 'updatesTracker' preference; the bell is not.
 */
async function notifyOwnersOfUpdateActivity(request, session, event, message) {
  try {
    const members = await appDataStore.getTeamMembers()
    const owners = members.filter(
      (member) => member.role === 'owner' && member.id !== session.user.id,
    )
    for (const owner of owners) {
      await notify(appDataStore, owner.id, event, {
        message,
        link: '/updates',
        appPublicUrl: getPublicAppUrl(request),
      })
    }
  } catch (err) {
    console.error(`[notify] ${event} dispatch failed:`, err?.message || err)
  }
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
    .map((client) => ({
      ...client,
      hourlyRate: 0,
      monthlyRate: undefined,
      customMonthlyFee: null,
      planId: null,
      planIds: [],
      annualRate: undefined,
      annualBillingMonth: undefined,
      monthlyServiceTier: undefined,
    }))
  // A team member sees every task for a client they're assigned to — not
  // only tasks assigned to them personally — so a shared client's whole
  // workload (including get-ahead/upcoming tasks generated by anyone) is
  // visible and time can be logged against it. Edit/complete rights stay
  // gated to the assignee/editor in the write endpoints; this is read scope.
  const checklists = (data.checklists ?? []).filter((checklist) =>
    allowedClientIds.has(checklist.clientId),
  )
  // Client-agnostic "standard" blueprints (no billing data) are visible to
  // every team member; client-bound recurring templates stay scoped to the
  // clients this member is assigned to. See `isTemplateVisibleToScope`.
  const checklistTemplates = (data.checklistTemplates ?? []).filter((template) =>
    isTemplateVisibleToScope(template, allowedClientIds),
  )
  const timeEntries = (data.timeEntries ?? []).filter((entry) =>
    isTimeEntryVisibleToScope(entry, me, allowedClientIds),
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

/**
 * Escape a string for safe interpolation into HTML attribute / text content.
 * Used for the verify token in the confirm-sign-in interstitial below. The
 * token is a base64url string (so already safe), but we escape defensively
 * so a malformed/crafted path segment can never break out of the attribute.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * SECURITY (H6): click-to-consume interstitial served by GET /verify/:token.
 * The GET no longer consumes the token — an email scanner's GET prefetch (or
 * an intercepted link opened by a bot) would otherwise silently burn the link
 * or auto-sign-in. Instead we render this minimal, self-contained page (inline
 * styles, no SPA dependency) with a single button inside a POST form. Only a
 * real click POSTs back and consumes the token. No auto-submit — the explicit
 * click is the whole point. The token is escaped into the form action.
 */
function renderVerifyConfirmPage(token) {
  const safeToken = escapeHtml(token)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Confirm sign-in - PB&amp;J Strategic Accounting</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f6f5f1; color: #1f1d1a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; padding: 32px 36px; border-radius: 14px; box-shadow: 0 12px 40px rgba(31, 29, 26, 0.08); max-width: 420px; text-align: center; }
  h1 { margin: 0 0 12px 0; font-size: 22px; }
  p { line-height: 1.5; margin: 0 0 20px 0; color: #555049; }
  button { font: inherit; font-weight: 600; color: #fff; background: #7d2a4d; border: none; border-radius: 10px; padding: 12px 24px; cursor: pointer; }
  button:hover { background: #6a2342; }
</style>
</head>
<body>
  <div class="card">
    <h1>Confirm sign-in</h1>
    <p>Click the button below to finish signing in to PB&amp;J Strategic Accounting.</p>
    <form method="POST" action="/verify/${safeToken}">
      <button type="submit">Confirm sign-in</button>
    </form>
  </div>
</body>
</html>`
}

// ---- Real-time sync: SSE fan-out ------------------------------------------
// Every authenticated client holds an open /api/events stream. After ANY
// successful data mutation we ping all of them so each session refetches the
// shared workspace — so two owners (e.g. Alex + Brittany) see each other's
// edits within a moment instead of working off stale snapshots.
const sseClients = new Set()
function broadcastDataChanged() {
  const payload = 'event: data-changed\ndata: {}\n\n'
  for (const client of [...sseClients]) {
    try {
      client.write(payload)
    } catch {
      sseClients.delete(client)
    }
  }
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

    // Central real-time hook: after any successful API write, ping every open
    // SSE client. Wrapping response.end once here avoids instrumenting every
    // individual mutation handler.
    const isDataMutation =
      method !== 'GET' &&
      method !== 'HEAD' &&
      method !== 'OPTIONS' &&
      normalizedPath.startsWith('/api/') &&
      !normalizedPath.startsWith('/api/auth') &&
      normalizedPath !== '/api/events'
    if (isDataMutation) {
      const originalEnd = response.end.bind(response)
      response.end = (...args) => {
        const result = originalEnd(...args)
        if (response.statusCode >= 200 && response.statusCode < 300) {
          broadcastDataChanged()
        }
        return result
      }
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

    // ---- AI assistant (owner only) ----
    // Chat proxy: validates and caps the client-held history, runs the
    // tool-use loop in lib/assistant.js, and returns the final text plus any
    // feature-request draft awaiting the owner's confirmation. The Anthropic
    // API key lives server-side only — the browser never sees it.
    if (normalizedPath === '/api/assistant/chat' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!consumeAssistantRateSlot(session.user.id)) {
        sendJson(response, 429, {
          error: 'Slow down a moment — too many assistant messages at once.',
        })
        return
      }

      const payload = await readJsonBody(request)
      const rawMessages = Array.isArray(payload?.messages) ? payload.messages : []
      const history = rawMessages
        .filter(
          (entry) =>
            entry &&
            (entry.role === 'user' || entry.role === 'assistant') &&
            typeof entry.text === 'string' &&
            entry.text.trim() !== '',
        )
        .slice(-24)
        .map((entry) => ({ role: entry.role, text: String(entry.text).slice(0, 4000) }))
      if (history.length === 0 || history[history.length - 1].role !== 'user') {
        sendJson(response, 400, { error: 'messages must end with a user message' })
        return
      }

      // Stream the reply as Server-Sent Events over this POST response: the
      // client reads the body incrementally (delta events) and applies the
      // final structured payload (done event). All auth/CSRF/rate-limit
      // checks above run before we commit to a 200 stream head; after that,
      // failures can only be reported in-band as an `error` event.
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const sendEvent = (obj) => {
        try {
          response.write(`data: ${JSON.stringify(obj)}\n\n`)
        } catch {
          // Client hung up mid-stream — nothing more to do.
        }
      }

      try {
        const result = await runAssistantChat(
          history,
          {
            getSnapshot: async () => buildWorkspaceSnapshot(await appDataStore.read()),
            getUsagePatterns: async () => detectUsagePatterns(await appDataStore.read()),
            readTools: assistantReadTools(),
          },
          (delta) => sendEvent({ type: 'delta', text: delta }),
        )
        sendEvent({ type: 'done', ...result })
        response.end()
        // Persist only the new turn (the client already holds prior history).
        try {
          const turns = [history[history.length - 1]]
          if (result.reply) turns.push({ role: 'assistant', text: result.reply })
          await appDataStore.appendAssistantMessages(session.user.id, turns)
        } catch (persistError) {
          console.error('[assistant] persist failed:', persistError?.message || persistError)
        }
      } catch (error) {
        const configMissing = error?.statusCode === 503
        console.error('[assistant] chat failed:', error?.message || error)
        sendEvent({
          type: 'error',
          error: configMissing
            ? 'The assistant is not configured yet (missing ANTHROPIC_API_KEY).'
            : 'The assistant had trouble answering — try again in a moment.',
        })
        response.end()
      }
      return
    }

    // Persisted conversation (Phase 3): load saved turns on panel open, or
    // clear the whole thread. Owner-only, same guards as the chat endpoint.
    if (normalizedPath === '/api/assistant/history' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const messages = await appDataStore.getAssistantMessages(session.user.id, 100)
      sendJson(response, 200, { messages })
      return
    }

    if (normalizedPath === '/api/assistant/history' && request.method === 'DELETE') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      await appDataStore.clearAssistantMessages(session.user.id)
      sendJson(response, 200, { ok: true })
      return
    }

    // Pending voice-action proposals: the panel polls this during a live
    // voice call and renders each as a confirm card. Listing is read-only;
    // executing still goes through /api/assistant/action below.
    if (normalizedPath === '/api/assistant/pending-actions' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      sendJson(response, 200, { proposals: pendingVoiceActions.list(session.user.id) })
      return
    }

    // Remove one pending proposal (after the owner ran or dismissed its card).
    if (normalizedPath === '/api/assistant/pending-actions/resolve' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const removed = pendingVoiceActions.resolve(session.user.id, String(payload?.id ?? ''))
      sendJson(response, 200, { ok: true, removed })
      return
    }

    // Reports the voice agent generated, awaiting display. The panel polls
    // this during a live call and pops each into the report modal.
    if (normalizedPath === '/api/assistant/pending-reports' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const reports = pendingVoiceReports
        .list(session.user.id)
        .map((entry) => ({ id: entry.id, report: entry.params }))
      sendJson(response, 200, { reports })
      return
    }

    if (normalizedPath === '/api/assistant/pending-reports/resolve' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const removed = pendingVoiceReports.resolve(session.user.id, String(payload?.id ?? ''))
      sendJson(response, 200, { ok: true, removed })
      return
    }

    // Feature-request drafts the voice agent created, awaiting the owner's tap.
    // The panel polls this during a call and shows each as a confirm card;
    // sending still goes through POST /api/assistant/feature-request.
    if (normalizedPath === '/api/assistant/pending-feature-requests' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const drafts = pendingVoiceFeatureRequests
        .list(session.user.id)
        .map((entry) => ({ id: entry.id, draft: entry.params }))
      sendJson(response, 200, { drafts })
      return
    }

    if (
      normalizedPath === '/api/assistant/pending-feature-requests/resolve' &&
      request.method === 'POST'
    ) {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const removed = pendingVoiceFeatureRequests.resolve(session.user.id, String(payload?.id ?? ''))
      sendJson(response, 200, { ok: true, removed })
      return
    }

    // Action confirm (Phase 3): runs a workspace change the assistant
    // proposed, only after the owner clicked Run on the confirmation card.
    // The model can only ever PROPOSE — execution lives here behind the
    // owner gate + CSRF + an explicit server-side tool allowlist.
    if (normalizedPath === '/api/assistant/action' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const ALLOWED_ACTIONS = new Set([
        'make_template_recurring',
        'assign_client',
        'generate_tasks_now',
        'reenable_recurring_template',
      ])
      const body = await readJsonBody(request)
      const tool = String(body?.tool ?? '')
      const params = body?.params && typeof body.params === 'object' ? body.params : {}
      if (!ALLOWED_ACTIONS.has(tool)) {
        sendJson(response, 400, { error: 'Unknown action' })
        return
      }
      try {
        const data = await appDataStore.read()
        const result = await executeAssistantAction(tool, params, appDataStore, data)
        if (result.ok) {
          await appDataStore.recordActivity(session.user.id, `assistant_action:${tool}`, result.message)
          broadcastDataChanged()
        }
        sendJson(response, 200, result)
      } catch (error) {
        console.error('[assistant] action failed:', error?.message || error)
        sendJson(response, 502, { ok: false, message: 'That action could not be completed.' })
      }
      return
    }

    // Watch-and-learn insights: deterministic pattern detection over the
    // workspace (no model call — lib/usage-patterns.js), minus anything the
    // owner already dismissed. The panel fetches this when it opens.
    if (normalizedPath === '/api/assistant/insights' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const data = await appDataStore.read()
      const dismissed = new Set(await appDataStore.listDismissedSuggestions(session.user.id))
      const suggestions = detectUsagePatterns(data)
        .filter((suggestion) => !dismissed.has(suggestion.key))
        .slice(0, 3)
      sendJson(response, 200, { suggestions })
      return
    }

    // Dismiss one insight permanently (per user, by stable pattern key).
    if (normalizedPath === '/api/assistant/insights/dismiss' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const key = String(payload?.key ?? '').trim()
      if (!key) {
        sendJson(response, 400, { error: 'key is required' })
        return
      }
      await appDataStore.dismissSuggestion(session.user.id, key)
      sendJson(response, 200, { ok: true })
      return
    }

    // "To 100%" setup-issue ignore list (owner-only, per-user). Reuses the
    // dismissed-suggestions store with `setup:`-prefixed keys, so ignoring a
    // setup item never collides with assistant insights.
    if (normalizedPath === '/api/setup/dismissed') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The setup checklist is owner-only' })
        return
      }
      if (request.method === 'GET') {
        const all = await appDataStore.listDismissedSuggestions(session.user.id)
        const ids = all
          .filter((key) => typeof key === 'string' && key.startsWith('setup:'))
          .map((key) => key.slice('setup:'.length))
        sendJson(response, 200, { ids })
        return
      }
      if (request.method === 'POST') {
        const contentType = String(request.headers['content-type'] || '')
        if (!contentType.toLowerCase().includes('application/json')) {
          sendJson(response, 415, { error: 'application/json required' })
          return
        }
        if (isCrossSiteOrigin(request)) {
          sendJson(response, 403, { error: 'Origin not allowed' })
          return
        }
        const payload = await readJsonBody(request)
        const issueId = String(payload?.issueId ?? '').trim()
        if (!issueId) {
          sendJson(response, 400, { error: 'issueId is required' })
          return
        }
        await appDataStore.dismissSuggestion(session.user.id, `setup:${issueId}`)
        sendJson(response, 200, { ok: true })
        return
      }
      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }
    // Restore (un-ignore) one setup issue.
    const setupRestoreMatch = normalizedPath.match(/^\/api\/setup\/dismissed\/(.+)$/)
    if (setupRestoreMatch && request.method === 'DELETE') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The setup checklist is owner-only' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const issueId = decodeURIComponent(setupRestoreMatch[1])
      await appDataStore.removeDismissedSuggestion(session.user.id, `setup:${issueId}`)
      sendJson(response, 200, { ok: true })
      return
    }

    // Feature-request confirm: records + emails the draft the owner approved
    // in the UI. A separate endpoint so sending is always an explicit human
    // action — the model can only draft, never send.
    if (normalizedPath === '/api/assistant/feature-request' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const payload = await readJsonBody(request)
      const title = String(payload?.title ?? '')
        .trim()
        .slice(0, 120)
      const description = String(payload?.description ?? '')
        .trim()
        .slice(0, 2000)
      if (!title || !description) {
        sendJson(response, 400, { error: 'title and description are required' })
        return
      }

      const record = await appDataStore.createFeatureRequest(session.user.id, title, description)
      let emailSent = false
      try {
        emailSent = await sendFeatureRequestEmail({
          fromName: session.user.name,
          title,
          description,
        })
      } catch (error) {
        console.error('[assistant] feature-request email failed:', error?.message || error)
      }
      await appDataStore.recordActivity(session.user.id, 'feature_request_sent', title)
      sendJson(response, 200, { ok: true, id: record.id, emailSent })
      return
    }

    // Email-report confirm: emails an assistant-generated report to the firm
    // owner (OWNER_EMAIL), only after the owner approved the draft on a card.
    // Outward-facing ⇒ explicit human confirm, like feature requests.
    if (normalizedPath === '/api/assistant/email-report' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const ownerEmail = process.env.OWNER_EMAIL?.trim()
      if (!ownerEmail) {
        sendJson(response, 200, {
          ok: false,
          emailSent: false,
          message: 'No owner email is configured (OWNER_EMAIL), so I can’t email it.',
        })
        return
      }
      const payload = await readJsonBody(request)
      const subject = String(payload?.subject ?? '').trim().slice(0, 150)
      const body = String(payload?.body ?? '').trim().slice(0, 8000)
      if (!subject || !body) {
        sendJson(response, 400, { error: 'subject and body are required' })
        return
      }
      let emailSent = false
      try {
        const firm = await appDataStore.getFirmSettings().catch(() => null)
        emailSent = await sendReportEmail({
          to: ownerEmail,
          firmName: firm?.firmName,
          subject,
          body,
          appBaseUrl: process.env.APP_PUBLIC_URL,
        })
      } catch (error) {
        console.error('[assistant] report email failed:', error?.message || error)
      }
      if (emailSent) {
        await appDataStore.recordActivity(session.user.id, 'assistant_report_emailed', subject)
      }
      sendJson(response, 200, {
        ok: true,
        emailSent,
        message: emailSent
          ? `Emailed to ${ownerEmail}.`
          : 'I couldn’t get that email to send — the report is still here in chat.',
      })
      return
    }

    // Voice (ElevenLabs Conversational AI): mint a short-lived signed URL so
    // the owner's browser can open a realtime voice session to our agent. The
    // API key stays server-side — the browser only ever sees the signed URL.
    if (normalizedPath === '/api/assistant/voice/signed-url' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The assistant is owner-only' })
        return
      }
      const apiKey = process.env.ELEVENLABS_API_KEY
      const agentId = process.env.ELEVENLABS_AGENT_ID
      if (!apiKey || !agentId) {
        sendJson(response, 503, { error: 'Voice is not configured yet.' })
        return
      }
      try {
        const elResp = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
          { headers: { 'xi-api-key': apiKey } },
        )
        if (!elResp.ok) {
          const body = await elResp.text().catch(() => '')
          console.error(`[voice] signed-url ${elResp.status}: ${body}`)
          sendJson(response, 502, { error: 'Could not start a voice session right now.' })
          return
        }
        const data = await elResp.json()
        // Per-session context the agent's prompt references as {{owner_name}},
        // {{today}}, {{memory_digest}} — this is how memory follows her into
        // each new call without a tool round-trip.
        const memories = await appDataStore.listVoiceMemories(session.user.id, 50)
        sendJson(response, 200, {
          signedUrl: data.signed_url,
          dynamicVariables: {
            // First name only — the agent addresses the owner casually.
            owner_name: String(session.user.name || 'Brittany').trim().split(/\s+/)[0],
            today: todayIso(),
            memory_digest: buildMemoryDigest(memories),
            // The signed-in user's id, relayed back by each tool as caller_id
            // so the webhook parks memory/actions/reports under THIS user —
            // not just "the first owner" (the firm can have more than one).
            user_id: session.user.id,
          },
        })
      } catch (error) {
        console.error('[voice] signed-url failed:', error?.message || error)
        sendJson(response, 502, { error: 'Could not start a voice session right now.' })
      }
      return
    }

    // Voice tool webhooks (V2): ElevenLabs calls these mid-conversation when
    // the agent needs live data. No session cookie (the caller is ElevenLabs,
    // not a browser) — authenticated by a shared secret header configured on
    // each tool at provisioning time. Read-only + memory writes only.
    if (normalizedPath.startsWith('/api/voice/tools/') && request.method === 'POST') {
      const secret = process.env.VOICE_TOOL_SECRET
      const presented = String(request.headers['x-voice-secret'] || '')
      if (!secret || !safeEqual(presented, secret)) {
        sendJson(response, 401, { error: 'Unauthorized' })
        return
      }
      const toolName = normalizedPath.slice('/api/voice/tools/'.length)
      let input = {}
      try {
        input = (await readJsonBody(request)) ?? {}
      } catch {
        input = {}
      }
      try {
        // Route memory/actions/reports to the ACTUAL signed-in user (relayed
        // as caller_id from the user_id dynamic variable), not just "the first
        // owner" — the firm can have more than one owner-role account, and the
        // panel polls under the logged-in user. If caller_id is missing or not
        // a known owner we DO NOT fall back to owners[0] — that would park one
        // owner's memory/action/report card under another owner's panel. The
        // write-ish branches below already refuse cleanly when `owner` is null;
        // read-only tools don't need it. Only owner-role ids are honored.
        const members = await appDataStore.getTeamMembers()
        const owners = members.filter((member) => member.role === 'owner')
        const callerId = String(input.caller_id ?? '')
        const owner = owners.find((member) => member.id === callerId) || null
        const readTools = assistantReadTools()
        const analyticsMap = {
          client_profitability: 'get_client_profitability',
          time_summary: 'get_time_summary',
          deadlines: 'get_deadlines',
          capacity: 'get_capacity',
          // Tier 0 diagnostics — same handlers as the text assistant, so a
          // spoken "why can't Lisa log time?" gets the identical answer.
          diagnose_time_logging: 'diagnose_time_logging',
          diagnose_recurring_checklist: 'diagnose_recurring_checklist',
          recent_changes: 'recent_changes',
        }

        let result
        if (analyticsMap[toolName]) {
          result = await readTools[analyticsMap[toolName]](input)
        } else if (toolName === 'workspace_snapshot') {
          result = buildWorkspaceSnapshot(await appDataStore.read())
        } else if (toolName === 'remember_fact') {
          const fact = String(input.fact ?? '').trim()
          if (!fact) {
            sendJson(response, 400, { error: 'fact is required' })
            return
          }
          const saved = owner ? await appDataStore.addVoiceMemory(owner.id, fact, 'voice') : null
          result = saved
            ? { saved: true, fact: saved.fact }
            : { saved: false, note: 'Could not save right now.' }
        } else if (toolName === 'recall_memory') {
          const topic = String(input.topic ?? '').trim().toLowerCase()
          const memories = owner ? await appDataStore.listVoiceMemories(owner.id, 100) : []
          const matched = topic
            ? memories.filter((m) => m.fact.toLowerCase().includes(topic))
            : memories.slice(0, 25)
          result = {
            count: matched.length,
            memories: matched.map((m) => ({ fact: m.fact, noted: m.createdAt.slice(0, 10) })),
          }
        } else if (
          toolName === 'make_template_recurring' ||
          toolName === 'assign_client' ||
          toolName === 'generate_tasks_now' ||
          toolName === 'reenable_recurring_template'
        ) {
          // PROPOSE-ONLY, by design. This branch validates and parks a card
          // for the owner; it must never call executeAssistantAction. The
          // voice surface has no execute path — approval is her tap in the
          // panel, not anything the model says or hears.
          const proposal = buildActionProposal(toolName, input)
          if (!proposal) {
            result = {
              proposed: false,
              note: 'A required detail (name or frequency) was missing — ask the owner to clarify.',
            }
          } else {
            const data = await appDataStore.read()
            const check = validateAssistantAction(toolName, proposal.params, data)
            if (!check.ok) {
              result = { proposed: false, note: check.message }
            } else if (!owner) {
              result = { proposed: false, note: 'Could not find the owner account.' }
            } else {
              pendingVoiceActions.add(owner.id, proposal)
              result = {
                proposed: true,
                summary: proposal.summary,
                note:
                  'Proposal filed. A confirmation card just appeared in the assistant ' +
                  'panel; NOTHING runs unless the owner taps "Run it" there. Tell her ' +
                  'to check the card — never claim the change is done.',
              }
            }
          }
        } else if (toolName === 'build_report') {
          const built = sanitizeReport(input)
          if (!built) {
            result = { built: false, note: 'Need a title and at least one section.' }
          } else if (!owner) {
            result = { built: false, note: 'Could not find the owner account.' }
          } else {
            pendingVoiceReports.add(owner.id, { tool: 'report', label: built.title, params: built })
            result = {
              built: true,
              title: built.title,
              note:
                'Report built. It just opened in a modal in the assistant panel on ' +
                'her screen, where she can read it and save a PDF. Tell her it is ' +
                'ready — do not read the whole report aloud.',
            }
          }
        } else if (toolName === 'send_feature_request') {
          // PROPOSE-ONLY: parks a draft card the owner taps to actually send.
          const title = String(input.title ?? '').trim().slice(0, 120)
          const description = String(input.description ?? '').trim().slice(0, 2000)
          if (!title || !description) {
            result = { drafted: false, note: 'Need a short title and a description.' }
          } else if (!owner) {
            result = { drafted: false, note: 'Could not find the owner account.' }
          } else {
            pendingVoiceFeatureRequests.add(owner.id, {
              tool: 'feature_request',
              label: title,
              params: { title, description },
            })
            result = {
              drafted: true,
              note:
                'A feature-request card just appeared in the assistant panel. She ' +
                'taps "Send to Alex" to send it — do not claim it was sent until she ' +
                'has.',
            }
          }
        } else {
          sendJson(response, 404, { error: `Unknown tool: ${toolName}` })
          return
        }
        sendJson(response, 200, result)
      } catch (error) {
        console.error(`[voice] tool ${toolName} failed:`, error?.message || error)
        sendJson(response, 500, { error: 'Tool failed' })
      }
      return
    }

    // Post-call webhook (V2): ElevenLabs delivers the transcript + summary
    // after each call. HMAC-verified against ELEVENLABS_WEBHOOK_SECRET (set
    // when the webhook is created in the ElevenLabs dashboard); 503 until
    // configured so misconfiguration is loud, not silent.
    if (normalizedPath === '/api/voice/post-call' && request.method === 'POST') {
      const secret = process.env.ELEVENLABS_WEBHOOK_SECRET
      if (!secret) {
        sendJson(response, 503, { error: 'Post-call webhook not configured' })
        return
      }
      const rawBody = await readRawBody(request)
      const signature = String(request.headers['elevenlabs-signature'] || '')
      if (!verifyElevenLabsSignature(rawBody, signature, secret)) {
        sendJson(response, 401, { error: 'Invalid signature' })
        return
      }
      try {
        const payload = JSON.parse(rawBody)
        if (payload?.type === 'post_call_transcription') {
          const turns = (payload.data?.transcript ?? []).map((turn) => ({
            role: turn?.role === 'user' ? 'user' : 'agent',
            message: turn?.message ?? '',
          }))
          await appDataStore.saveVoiceTranscript({
            conversationId: payload.data?.conversation_id || payload.conversation_id || 'unknown',
            summary: payload.data?.analysis?.transcript_summary || '',
            transcript: turns,
          })
        }
        sendJson(response, 200, { ok: true })
      } catch (error) {
        console.error('[voice] post-call failed:', error?.message || error)
        sendJson(response, 500, { error: 'Post-call processing failed' })
      }
      return
    }

    // Server-Sent Events stream: the client subscribes here and refetches the
    // workspace whenever a "data-changed" ping arrives (see broadcastDataChanged).
    if (normalizedPath === '/api/events' && request.method === 'GET') {
      const cookies = parseCookies(request.headers.cookie)
      const session = await appDataStore.getUserSession(cookies[sessionCookieName])
      if (!session) {
        sendJson(response, 401, { error: 'Not authenticated' })
        return
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable proxy buffering (nginx/Railway) so events flush immediately.
        'X-Accel-Buffering': 'no',
      })
      response.write('retry: 5000\n\n')
      sseClients.add(response)
      // Heartbeat keeps the connection alive through idle proxy timeouts.
      const heartbeat = setInterval(() => {
        try {
          response.write(': ping\n\n')
        } catch {
          clearInterval(heartbeat)
          sseClients.delete(response)
        }
      }, 25000)
      request.on('close', () => {
        clearInterval(heartbeat)
        sseClients.delete(response)
      })
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

      // CSRF guard: block cross-site POSTs, but let any genuine same-origin
      // sign-in through regardless of how APP_PUBLIC_URL is configured.
      if (isCrossSiteOrigin(request)) {
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
      if (isCrossSiteOrigin(request)) {
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
      // SECURITY (M4): forward the supplied current password. The store gates
      // on it — required once the user has set their own password, ignored on
      // a first-time set (magic-link user who's still on the random default).
      const currentPassword =
        typeof payload?.currentPassword === 'string' ? payload.currentPassword : ''
      const result = await appDataStore.setUserPassword(
        session.user.id,
        newPassword,
        currentPassword,
      )
      if (!result.ok) {
        sendJson(response, result.status ?? 500, {
          error: result.error ?? 'Could not update password',
        })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'password_changed', '')
      sendJson(response, 200, { ok: true })
      return
    }

    // Email-gated sign-in. SECURITY (H6): split into GET (click-to-consume
    // interstitial, does NOT consume) and POST (consumes + signs in). An email
    // scanner's GET prefetch would otherwise burn the one-time link or
    // auto-sign-in; requiring a real button click (POST) prevents that.
    const verifyMatch = normalizedPath.match(/^\/verify\/([^/]+)$/)
    if (verifyMatch && request.method === 'GET') {
      // Do NOT consume. Render a minimal confirm-sign-in page whose single
      // button POSTs the token back. The token is validated/consumed only on
      // that POST below.
      const token = decodeURIComponent(verifyMatch[1])
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // Defense-in-depth: keep this page out of any framing context.
        'X-Frame-Options': 'DENY',
      })
      response.end(renderVerifyConfirmPage(token))
      return
    }

    // POST /verify/:token — the real consume + sign-in. This is EXACTLY what
    // the old GET handler did (every branch, including the TOTP ones); only
    // the HTTP method changed.
    if (verifyMatch && request.method === 'POST') {
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
        // Full firm settings (address, EIN, contact details) are owner-only.
        // Non-owners read display branding from /api/firm-settings/public.
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can view firm settings' })
          return
        }
        const settings = await appDataStore.getFirmSettings()
        sendJson(response, 200, settings)
        return
      }

      if (request.method === 'PUT') {
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can update firm settings' })
          return
        }
        if (!isJsonContentType(request)) {
          sendJson(response, 415, { error: 'application/json required' })
          return
        }

        // The store already whitelists firm-settings keys (FIRM_SETTINGS_FIELDS
        // + clientDefaults) and validates colors, so unknown fields are ignored.
        const payload = await readJsonBody(request)
        const updated = await appDataStore.updateFirmSettings(payload || {})
        await appDataStore.recordActivity(session.user.id, 'firm_settings_updated', 'branding')
        sendJson(response, 200, updated)
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    // ---- Client Recap (per-client monthly/quarterly review) ----
    // Access is scoped server-side: a user can only recap a client in their
    // visible set (403 otherwise). Financials (billing, profitability, sales-
    // tax dollar figures) are owner-only and omitted from the payload entirely
    // for staff — not just hidden in the UI.
    if (normalizedPath === '/api/client-recap' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const clientId = requestUrl.searchParams.get('clientId') || ''
      const periodType = requestUrl.searchParams.get('periodType') || 'month'
      const periodParam = requestUrl.searchParams.get('period') || ''
      if (!isValidPeriodType(periodType)) {
        sendJson(response, 400, { error: 'Invalid periodType' })
        return
      }
      const data = await appDataStore.read()
      const allowed = visibleClientIdSet(session, data.clients ?? [])
      if (!clientId || !allowed.has(clientId)) {
        sendJson(response, 403, { error: 'No access to that client' })
        return
      }
      const period = isValidPeriod(periodType, periodParam)
        ? periodParam
        : currentPeriod(periodType, todayIso())
      const includeFinancials = session.user.role === 'owner'
      const costRates = includeFinancials ? await buildCostRateMap() : {}
      const salesTaxRecord = includeFinancials
        ? await appDataStore.getSalesTaxRecord(clientId, period)
        : null
      const recap = buildClientRecap(data, {
        clientId,
        periodType,
        period,
        today: todayIso(),
        includeFinancials,
        costRates,
        salesTaxRecord,
      })
      if (!recap) {
        sendJson(response, 404, { error: 'Client not found' })
        return
      }
      sendJson(response, 200, recap)
      return
    }

    // Owner-only: record/upsert sales-tax figures for a client + period.
    if (normalizedPath === '/api/client-recap/sales-tax' && request.method === 'PUT') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can record sales tax' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const clientId = String(payload?.clientId ?? '')
      const periodType = String(payload?.periodType ?? 'month')
      const period = String(payload?.period ?? '')
      if (!isValidPeriodType(periodType) || !isValidPeriod(periodType, period)) {
        sendJson(response, 400, { error: 'Invalid period' })
        return
      }
      const data = await appDataStore.read()
      const allowed = visibleClientIdSet(session, data.clients ?? [])
      if (!clientId || !allowed.has(clientId)) {
        sendJson(response, 403, { error: 'No access to that client' })
        return
      }
      const record = await appDataStore.upsertSalesTaxRecord({
        clientId,
        period,
        taxableSales: payload?.taxableSales,
        taxCollected: payload?.taxCollected,
        taxOwed: payload?.taxOwed,
        notes: payload?.notes,
        updatedBy: session.user.id,
      })
      await appDataStore.recordActivity(session.user.id, 'sales_tax_recorded', `${clientId} · ${period}`)
      sendJson(response, 200, { ok: true, record })
      return
    }

    // Active Checklists board: the service categories that make up the board's
    // columns. Read is open to any signed-in user (staff need them to render
    // the board); create/rename/reorder/delete are owner-only + CSRF-guarded.
    if (normalizedPath === '/api/service-categories' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const categories = await appDataStore.listServiceCategories()
      sendJson(response, 200, { categories })
      return
    }

    // Create ONE client, durably, instead of waiting for the debounced bulk
    // save. Before this, a new client lived only in the creating tab until that
    // save landed — so logging time against it raised a raw foreign-key error,
    // assigning it a team wrote nothing, and staff could not see it. If the save
    // was then overwritten by another tab, the client was simply gone with no
    // error shown. Cardinal rule 4: anything that must actually persist gets its
    // own endpoint.
    // GET /api/invoices?period=YYYY-MM — the month's invoices (owner only).
    // Invoices deliberately do NOT ride on /api/app-data: they are money, and
    // keeping them off the bulk-save payload is what stops a stale owner tab
    // from ever rewriting one.
    if (normalizedPath === '/api/invoices' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can see invoices' })
        return
      }
      const period = requestUrl.searchParams.get('period')
      if (period && !/^\d{4}-\d{2}$/.test(period)) {
        sendJson(response, 400, { error: 'period must look like 2026-08' })
        return
      }
      const invoices = await appDataStore.listInvoices({ period: period || null })
      sendJson(response, 200, { invoices })
      return
    }

    // POST /api/stripe/webhook — Stripe tells us money moved.
    //
    // UNAUTHENTICATED BY NECESSITY (Stripe cannot hold a session), so the
    // signature check is the entire security boundary. It runs on the RAW bytes
    // before anything is parsed, and an event that fails it is discarded
    // without touching an invoice.
    if (normalizedPath === '/api/stripe/webhook' && request.method === 'POST') {
      if (!isStripeWebhookConfigured()) {
        // No secret means we cannot tell Stripe from anyone else. Refuse rather
        // than trust the body.
        sendJson(response, 503, { error: 'Stripe webhooks are not configured' })
        return
      }
      let rawBody
      try {
        rawBody = await readRawBody(request)
      } catch {
        sendJson(response, 400, { error: 'Could not read body' })
        return
      }
      const event = verifyStripeEvent(rawBody, request.headers['stripe-signature'])
      if (!event) {
        console.warn('[stripe] rejected a webhook with an invalid signature')
        sendJson(response, 400, { error: 'Invalid signature' })
        return
      }

      // Retries and out-of-order delivery are normal. Returning 200 for an
      // event we have already handled stops Stripe retrying forever WITHOUT
      // applying it twice.
      const isNewEvent = await appDataStore.recordStripeEventOnce(event.id, event.type)
      if (!isNewEvent) {
        sendJson(response, 200, { received: true, duplicate: true })
        return
      }

      // The invoice AS IT NOW STANDS, once the payment has been applied, plus
      // which channel paid it. Both are read after the try below, by the
      // client-email step — which is deliberately outside it, because an email
      // problem must never turn a payment we have already recorded into a 500
      // that makes Stripe replay it.
      let settledInvoice = null
      let settledByCard = false

      try {
        const object = event.data?.object ?? {}
        const metaInvoiceId = object.metadata?.invoiceId ?? null
        const invoice = await appDataStore.findInvoiceByStripeRef({
          invoiceId: metaInvoiceId,
          checkoutSessionId: event.type === 'checkout.session.completed' ? object.id : null,
          paymentIntentId:
            typeof object.payment_intent === 'string' ? object.payment_intent : object.id ?? null,
        })
        if (!invoice) {
          // Acknowledge anyway: an event for an invoice we cannot find is not
          // something Stripe can fix by retrying.
          console.warn('[stripe] event for an unknown invoice', event.type, metaInvoiceId)
          sendJson(response, 200, { received: true, matched: false })
          return
        }

        // Which channel paid, and which link that leaves stale. A card-enabled
        // client holds two live sessions for one invoice and the two are treated
        // differently — only the card one adds a fee line.
        const { isCard: isCardChannel, siblingSessionId } = resolveWebhookChannel({
          eventType: event.type,
          object,
          invoice,
        })
        // Appended by the store only if the invoice does not already carry one,
        // so the two events a single card payment fires cannot add it twice.
        const cardFeeLines = isCardChannel ? [cardProcessingFeeLine(invoice)] : []
        settledByCard = isCardChannel

        if (event.type === 'checkout.session.completed') {
          // ACH does not settle here — it clears in about 4 business days, so
          // this is 'processing', not 'paid'. A card payment passes through the
          // same state, just far more briefly.
          settledInvoice = await appDataStore.applyInvoicePayment(invoice.id, {
            status: 'processing',
            // The card session must NOT overwrite the ACH column: both ids are
            // needed, and losing one means the sibling below can never be
            // expired.
            ...(isCardChannel
              ? { cardCheckoutSessionId: object.id }
              : { checkoutSessionId: object.id }),
            paymentIntentId:
              typeof object.payment_intent === 'string' ? object.payment_intent : undefined,
            appendLines: cardFeeLines,
          })
          // One of the two links has now been used. Retire the OTHER one: a
          // client holding both emails could otherwise pay the same invoice
          // twice, once per channel. Best effort — an already-expired or
          // already-completed sibling is not a reason to fail the webhook.
          if (siblingSessionId) await expireCheckoutSession(siblingSessionId)
        } else if (event.type === 'payment_intent.succeeded') {
          settledInvoice = await appDataStore.applyInvoicePayment(invoice.id, {
            status: 'paid',
            paidAt: new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
            paymentIntentId: object.id,
            paymentMethod: object.payment_method_types?.[0] ?? 'us_bank_account',
            appendLines: cardFeeLines,
          })
        } else if (event.type === 'payment_intent.payment_failed') {
          // Back to 'sent': it was invoiced and is still owed. Owners are told,
          // because a failed ACH debit is something a person has to chase.
          await appDataStore.applyInvoicePayment(invoice.id, {
            status: 'sent',
            paymentIntentId: object.id,
          })
          const failureMessage = object.last_payment_error?.message ?? 'the payment was declined'
          const members = await appDataStore.getTeamMembers()
          for (const owner of members.filter((member) => member.role === 'owner')) {
            await notify(appDataStore, owner.id, 'invoice_payment_failed', {
              message: `Payment failed on invoice ${invoice.number ?? invoice.id} — ${failureMessage}`,
              link: '/invoices',
              appPublicUrl: getPublicAppUrl(request),
            })
          }
        }
      } catch (error) {
        // A 500 makes Stripe retry, which is what we want for a transient
        // failure — the dedup ledger means the retry cannot double-apply.
        console.error('[stripe] webhook handling failed:', error)
        sendJson(response, 500, { error: 'webhook_failed' })
        return
      }

      // Tell the CLIENT their money arrived: an acknowledgment when a bank
      // payment is authorized, a receipt — with the PAID invoice attached —
      // when it settles. Card settles at once, so it gets the receipt only.
      //
      // Everything here is best-effort. The payment is already recorded; a mail
      // provider having a bad afternoon is not a reason to make Stripe replay
      // the event, so this cannot fail the webhook.
      if (
        settledInvoice &&
        settledInvoice.statusChanged &&
        paymentEmailKindFor(settledInvoice.status, { isCard: settledByCard })
      ) {
        try {
          const paidData = await appDataStore.read()
          const paidClient = (paidData.clients ?? []).find(
            (entry) => entry.id === settledInvoice.clientId,
          )
          if (paidClient) {
            const paidFirmSettings = await appDataStore.getFirmSettings().catch(() => null)
            await sendInvoicePaymentEmail({
              invoice: settledInvoice,
              client: paidClient,
              contacts: paidData.contacts ?? [],
              firmName: paidFirmSettings?.name || undefined,
              statusChanged: settledInvoice.statusChanged,
              isCard: settledByCard,
              // Rebuilt AFTER the payment landed, so it carries the PAID stamp
              // and — for a card payment — the fee line the store just appended.
              buildPdf: async () => [
                {
                  filename: invoicePdfFilename(settledInvoice),
                  content: await buildInvoicePdf({
                    invoice: settledInvoice,
                    client: paidClient,
                    firmSettings: paidFirmSettings,
                  }),
                },
              ],
              sendEmail: sendInvoiceEmail,
              recordSent: (id, entry) => appDataStore.recordInvoiceSent(id, entry),
            })
          }
        } catch (error) {
          console.error('[stripe] payment email failed after the payment landed:', error)
        }
      }

      sendJson(response, 200, { received: true })
      return
    }

    // POST /api/invoices/:id/payment-link — create the ACH Checkout Session.
    // Owner-only. Does NOT email anything: that is I4.
    //
    // Deliberately ACH-ONLY, even for a client with card payments switched on.
    // The card option is a promise made in words — "includes a $X card
    // processing fee, bank transfer has no fee" — and this route hands back a
    // bare URL to paste into some other message, where that sentence would not
    // travel with it. A client pasted a card link would open Checkout showing a
    // total that does not match their invoice, with nothing explaining why. Card
    // is offered through Send, where the email carries the explanation.
    const invoicePaymentLinkMatch = normalizedPath.match(
      /^\/api\/invoices\/([^/]+)\/payment-link$/,
    )
    if (invoicePaymentLinkMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can take payment on an invoice' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isStripeConfigured()) {
        sendJson(response, 503, {
          error: 'stripe_not_configured',
          message: 'Stripe is not connected yet, so a payment link cannot be created.',
        })
        return
      }

      const invoiceId = decodeURIComponent(invoicePaymentLinkMatch[1])
      const invoice = (await appDataStore.listInvoices()).find((entry) => entry.id === invoiceId)
      if (!invoice) {
        sendJson(response, 404, { error: 'Invoice not found' })
        return
      }
      if (invoice.status === 'void') {
        sendJson(response, 409, { error: 'This invoice is voided, so it cannot be paid.' })
        return
      }
      const appData = await appDataStore.read()
      const invoiceClient = (appData.clients ?? []).find((entry) => entry.id === invoice.clientId)
      if (!invoiceClient) {
        sendJson(response, 409, { error: 'This invoice has no client on file.' })
        return
      }

      // Reuse the client's Stripe customer so a repeat payer is one customer in
      // Stripe rather than one per invoice.
      let customerId = invoiceClient.stripeCustomerId ?? null
      try {
        if (!customerId) {
          const customer = await stripeClient().customers.create({
            name: invoiceClient.name,
            ...(invoiceClient.email ? { email: invoiceClient.email } : {}),
            metadata: { clientId: invoiceClient.id },
          })
          customerId = customer.id
          await appDataStore.setClientStripeCustomerId(invoiceClient.id, customerId)
        }
      } catch (error) {
        console.error('[stripe] customer create failed:', error?.message || error)
        sendJson(response, 502, {
          error: 'stripe_customer_failed',
          message: 'Stripe would not create a customer for this client.',
        })
        return
      }

      const result = await createInvoiceCheckoutSession({
        invoice,
        client: invoiceClient,
        customerId,
        appUrl: getPublicAppUrl(request),
      })
      if (!result.ok) {
        sendJson(response, 502, { error: 'stripe_session_failed', message: result.reason })
        return
      }

      const updated = await appDataStore.applyInvoicePayment(invoice.id, {
        status: invoice.status === 'paid' ? 'paid' : 'sent',
        checkoutSessionId: result.session.id,
        sentAt: invoice.sentAt ?? new Date().toISOString(),
      })
      // Refused means the invoice was voided while we were talking to Stripe —
      // the check at the top of this route passed two round-trips ago. The
      // session exists but has not been handed to anyone, so abandoning it is
      // free, and handing back a pay link for a voided invoice is not.
      if (!updated) {
        sendJson(response, 409, {
          error: 'This invoice was voided while the payment link was being created.',
        })
        return
      }
      // Retire the link this invoice used to point at — but only AFTER the new
      // one is safely persisted, so the invoice never names an expired session.
      // Two live links for one invoice is two ways to pay it, and a client who
      // still has the earlier email can do exactly that.
      if (
        invoice.stripeCheckoutSessionId &&
        invoice.stripeCheckoutSessionId !== result.session.id
      ) {
        await expireCheckoutSession(invoice.stripeCheckoutSessionId)
      }
      await appDataStore.recordActivity(
        session.user.id,
        'invoice_payment_link_created',
        `${invoice.number ?? invoice.id}`,
      )
      sendJson(response, 200, { url: result.session.url, invoice: updated })
      return
    }

    // POST /api/invoices/:id/send — email the invoice to the client (I4).
    // Owner-only. An email cannot be unsent, so everything that can fail is made
    // to fail BEFORE the send: no recipient, no client, or a Stripe that is
    // connected but refusing all stop the request with nothing delivered.
    const invoiceSendMatch = normalizedPath.match(/^\/api\/invoices\/([^/]+)\/send$/)
    if (invoiceSendMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can send an invoice' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const sendContentType = String(request.headers['content-type'] || '')
      if (!sendContentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }

      // Read before anything slow happens. The only field it may carry is
      // `to` — the addresses the owner left ticked in the send dialog.
      let sendPayload = null
      try {
        sendPayload = await readJsonBody(request)
      } catch {
        sendJson(response, 400, { error: 'Could not read the request body.' })
        return
      }

      const invoiceId = decodeURIComponent(invoiceSendMatch[1])
      const invoice = (await appDataStore.listInvoices()).find((entry) => entry.id === invoiceId)
      if (!invoice) {
        sendJson(response, 404, { error: 'Invoice not found' })
        return
      }
      if (invoice.status === 'void') {
        sendJson(response, 409, { error: 'This invoice is voided, so it cannot be sent.' })
        return
      }

      const sendAppData = await appDataStore.read()
      const sendClient = (sendAppData.clients ?? []).find((entry) => entry.id === invoice.clientId)
      if (!sendClient) {
        sendJson(response, 409, { error: 'This invoice has no client on file.' })
        return
      }

      const recipients = resolveInvoiceRecipients({
        client: sendClient,
        contacts: sendAppData.contacts ?? [],
      })
      if (recipients.to.length === 0) {
        // Carry the reason through: "no email on file for this client" is
        // something she can act on, "could not send" is not.
        sendJson(response, 409, { error: 'invoice_no_recipient', message: recipients.reason })
        return
      }

      // A submitted `to` is a FILTER over the addresses this invoice's own
      // client resolves to — never a list of addresses to email. Anything else
      // is dropped by `chooseInvoiceRecipients`, so a forged body cannot turn
      // an authenticated owner session into an open relay. Omitting the field
      // means "everyone", which is what every caller predating the send dialog
      // does, the webhook's payment emails included.
      const chosen = chooseInvoiceRecipients(recipients.to, sendPayload?.to)
      if (chosen.to.length === 0) {
        sendJson(response, 400, {
          error: 'invoice_no_chosen_recipient',
          message: chosen.reason,
        })
        return
      }
      const sendTo = chosen.to

      // A fresh Checkout session on EVERY send — hosted Checkout URLs expire in
      // about a day, so reusing the one from an earlier send would email a dead
      // button. A zero-total invoice gets no link because there is nothing to pay,
      // and with Stripe not connected the email stands on its own by design.
      //
      // Money already in flight gets NO pay button either: a re-send of a 'paid'
      // invoice, or a 'processing' one whose ACH is still the ~4 days it takes to
      // clear, would otherwise invite the client to pay a second time. Those
      // re-sends go out as a statement.
      const settled = invoice.status === 'paid' || invoice.status === 'processing'
      let payUrl = ''
      let cardPayUrl = ''
      if (isStripeConfigured() && invoice.total > 0 && !settled) {
        // Reuse the client's Stripe customer so a repeat payer is one customer
        // in Stripe rather than one per invoice.
        let customerId = sendClient.stripeCustomerId ?? null
        try {
          if (!customerId) {
            const customer = await stripeClient().customers.create({
              name: sendClient.name,
              ...(sendClient.email ? { email: sendClient.email } : {}),
              metadata: { clientId: sendClient.id },
            })
            customerId = customer.id
            await appDataStore.setClientStripeCustomerId(sendClient.id, customerId)
          }
        } catch (error) {
          console.error('[stripe] customer create failed:', error?.message || error)
          sendJson(response, 502, {
            error: 'stripe_customer_failed',
            message: 'Stripe would not create a customer for this client, so nothing was sent.',
          })
          return
        }

        const linkResult = await createInvoiceCheckoutSession({
          invoice,
          client: sendClient,
          customerId,
          appUrl: getPublicAppUrl(request),
        })
        if (!linkResult.ok) {
          // Stripe is connected but refused. Sending a link-less email here would
          // quietly downgrade the invoice, so stop instead and let her retry.
          sendJson(response, 502, { error: 'stripe_session_failed', message: linkResult.reason })
          return
        }
        payUrl = linkResult.session.url
        // Persist the session id only. The status flip belongs to
        // recordInvoiceSent, which refuses to claim "sent" if the email fails.
        await appDataStore.applyInvoicePayment(invoice.id, {
          checkoutSessionId: linkResult.session.id,
        })
        // The link the PREVIOUS send emailed is now superseded. Expiring it
        // only after the new id is persisted keeps the invoice from ever
        // pointing at a dead session; leaving it live would put two working
        // pay buttons in the client's inbox for one invoice, and both of them
        // charge.
        if (
          invoice.stripeCheckoutSessionId &&
          invoice.stripeCheckoutSessionId !== linkResult.session.id
        ) {
          await expireCheckoutSession(invoice.stripeCheckoutSessionId)
        }

        // The SECOND session, for a client who has card payments switched on.
        // Same rules as the ACH one above, one channel later: minted fresh every
        // send, persisted before the old one is expired, and never minted at all
        // for a settled invoice (the `settled` guard wraps both). It carries the
        // grossed-up processing fee as an extra line so the firm nets the same
        // amount either way.
        if (sendClient.cardPaymentsEnabled) {
          const cardResult = await createInvoiceCardCheckoutSession({
            invoice,
            client: sendClient,
            customerId,
            appUrl: getPublicAppUrl(request),
          })
          if (!cardResult.ok) {
            // Stop rather than send. Nothing has left yet, and quietly dropping
            // the card option from a client who was promised it is exactly the
            // kind of silent downgrade the ACH branch above refuses to make.
            sendJson(response, 502, {
              error: 'stripe_session_failed',
              message: cardResult.reason,
            })
            return
          }
          cardPayUrl = cardResult.session.url
          await appDataStore.applyInvoicePayment(invoice.id, {
            cardCheckoutSessionId: cardResult.session.id,
          })
          if (
            invoice.stripeCardSessionId &&
            invoice.stripeCardSessionId !== cardResult.session.id
          ) {
            await expireCheckoutSession(invoice.stripeCardSessionId)
          }
        }
      }

      // The firm's own name, so the client sees who is billing them rather than
      // the builder's default. A settings read that fails is not worth failing a
      // send over — buildInvoiceEmail's default is the fallback.
      const firmSettings = await appDataStore.getFirmSettings().catch(() => null)
      const email = buildInvoiceEmail({
        invoice,
        client: sendClient,
        payUrl,
        cardPayUrl,
        firmName: firmSettings?.name || undefined,
      })
      // The invoice as a document, built from the invoice as it stands right
      // now. Best-effort on purpose: the email is the payment vehicle and the
      // PDF is a nicety, so a rendering failure sends the email without it
      // rather than holding back the thing the client is waiting for.
      let sendAttachments = []
      try {
        const pdf = await buildInvoicePdf({
          invoice,
          client: sendClient,
          firmSettings,
        })
        sendAttachments = [{ filename: invoicePdfFilename(invoice), content: pdf }]
      } catch (error) {
        console.error('[invoice] PDF attachment failed, sending without it:', error?.message || error)
      }

      const sendResult = await sendInvoiceEmail({
        to: sendTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: sendAttachments,
      })

      if (!sendResult.ok) {
        // The failed attempt is still logged — it is the evidence that answers
        // "she says she sent it, the client says it never arrived" — and
        // recordInvoiceSent refuses to mark a failed send as sent.
        await appDataStore.recordInvoiceSent(invoice.id, {
          to: sendTo,
          subject: email.subject,
          ok: false,
          error: sendResult.error,
        })
        sendJson(response, 502, { error: 'invoice_send_failed', message: sendResult.error })
        return
      }

      // Past this point the email HAS been delivered, and no bookkeeping failure
      // may make the response say otherwise — telling her the send failed when it
      // did not is how a client ends up billed twice.
      let sentInvoice = invoice
      try {
        sentInvoice =
          (await appDataStore.recordInvoiceSent(invoice.id, {
            to: sendTo,
            subject: email.subject,
            ok: true,
            error: null,
          })) ?? invoice
        await appDataStore.recordActivity(
          session.user.id,
          'invoice_sent',
          `${invoice.number ?? invoice.id}`,
        )
      } catch (error) {
        console.error('[invoice] send bookkeeping failed after delivery:', error)
      }
      sendJson(response, 200, { invoice: sentInvoice })
      return
    }

    // GET /api/invoices/export.csv?period=YYYY-MM — the month's invoices as a
    // QBO import file (owner only). Declared BEFORE the /:id routes so the
    // literal path is never mistaken for an invoice id.
    if (normalizedPath === '/api/invoices/export.csv' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can export invoices' })
        return
      }
      const period = requestUrl.searchParams.get('period') || ''
      if (!/^\d{4}-\d{2}$/.test(period)) {
        sendJson(response, 400, { error: 'period must look like 2026-08' })
        return
      }
      const invoices = await appDataStore.listInvoices({ period })
      const data = await appDataStore.read()
      const clientsById = new Map((data.clients ?? []).map((client) => [client.id, client]))
      const csv = buildQboCsv(invoices, clientsById)
      response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="invoices-${period}.csv"`,
        'Cache-Control': 'no-store',
      })
      // A BOM so Excel opens it as UTF-8 — client names carry accents and the
      // em dash in our descriptions would otherwise render as mojibake.
      response.end(`\uFEFF${csv}`)
      return
    }

    // PATCH /api/invoices/:id — edit a draft (owner only).
    // The page sends lines, blurb, due date and review status; the SERVER
    // recomputes subtotal and total from those lines, so a total can never
    // disagree with the lines it is printed next to.
    const invoicePatchMatch = normalizedPath.match(/^\/api\/invoices\/([^/]+)$/)
    if (invoicePatchMatch && request.method === 'PATCH') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can edit invoices' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const invoiceId = decodeURIComponent(invoicePatchMatch[1])

      let updated
      try {
        updated = await appDataStore.updateInvoice(invoiceId, payload ?? {})
      } catch (error) {
        console.error('[invoices] update failed:', error)
        sendJson(response, 500, {
          error: 'invoice_update_failed',
          message: 'Could not save that change — please try again.',
        })
        return
      }
      if (!updated) {
        sendJson(response, 404, { error: 'Invoice not found' })
        return
      }
      sendJson(response, 200, { invoice: updated })
      return
    }

    // POST /api/invoices/generate — build the month's drafts (owner only).
    // Idempotent: a client that already has a live invoice for the period is
    // skipped, never rewritten, so re-running cannot revert an edited draft.
    if (normalizedPath === '/api/invoices/generate' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can generate invoices' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const period = typeof payload?.period === 'string' ? payload.period : ''
      if (!/^\d{4}-\d{2}$/.test(period)) {
        sendJson(response, 400, { error: 'period must look like 2026-08' })
        return
      }
      // Optional: build just ONE client's invoice. That is how the per-client
      // "Email invoice" button offers to create a missing invoice on the spot
      // without generating the whole month behind her.
      const onlyClientId = typeof payload?.clientId === 'string' ? payload.clientId : null
      let result
      try {
        result = await appDataStore.generateInvoicesForPeriod(period, {
          ...(onlyClientId ? { clientId: onlyClientId } : {}),
        })
      } catch (error) {
        console.error('[invoices] generate failed:', error)
        sendJson(response, 500, {
          error: 'invoice_generate_failed',
          message: 'Could not build this month’s invoices — please try again.',
        })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'invoices_generated',
        `${period}: ${result.created.length} created${onlyClientId ? ' (one client)' : ''}`,
      )
      sendJson(response, 200, result)
      return
    }

    // POST /api/invoices/regenerate — throw away the month's unsent drafts and
    // build them again from current data (owner only).
    //
    // Generate alone cannot do this: it skips a client that already has a live
    // invoice, which is exactly right for "I logged one more hour" and exactly
    // wrong for "this month was built two weeks ago and everything has moved".
    // Voiding first is what frees each client to be generated again.
    //
    // Sent, processing, paid and overdue invoices are never touched — see the
    // store method. Edits on the voided drafts are discarded on purpose.
    if (normalizedPath === '/api/invoices/regenerate' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can generate invoices' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const regenContentType = String(request.headers['content-type'] || '')
      if (!regenContentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const regenPayload = await readJsonBody(request)
      const regenPeriod =
        typeof regenPayload?.period === 'string' ? regenPayload.period : ''
      if (!/^\d{4}-\d{2}$/.test(regenPeriod)) {
        sendJson(response, 400, { error: 'period must look like 2026-08' })
        return
      }

      let voided
      try {
        voided = await appDataStore.voidUnsentInvoicesForPeriod(regenPeriod)
      } catch (error) {
        console.error('[invoices] regenerate void failed:', error)
        sendJson(response, 500, {
          error: 'invoice_regenerate_failed',
          message: 'Could not void this month’s drafts — nothing was changed.',
        })
        return
      }

      let rebuilt
      try {
        rebuilt = await appDataStore.generateInvoicesForPeriod(regenPeriod)
      } catch (error) {
        // The voids have already landed. There is no transaction spanning both
        // halves and inventing one here would mean restructuring generation, so
        // say plainly what state the month is in and what fixes it.
        console.error('[invoices] regenerate rebuild failed:', error)
        sendJson(response, 500, {
          error: 'invoice_regenerate_rebuild_failed',
          message: `Voided ${voided.voided} invoice${voided.voided === 1 ? '' : 's'}, but rebuilding them failed. Nothing sent or paid was touched — press Generate to build the month again.`,
        })
        return
      }

      await appDataStore.recordActivity(
        session.user.id,
        'invoices_regenerated',
        `${regenPeriod}: ${voided.voided} voided, ${rebuilt.created.length} rebuilt`,
      )
      sendJson(response, 200, {
        period: regenPeriod,
        voided: voided.voided,
        created: rebuilt.created,
        skipped: rebuilt.skipped,
      })
      return
    }

    if (normalizedPath === '/api/clients' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can add clients' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      let created
      try {
        created = await appDataStore.createClient(payload ?? {})
      } catch (error) {
        console.error('[clients] createClient failed:', error)
        sendJson(response, 500, {
          error: 'client_create_failed',
          message: 'Could not add the client — please try again.',
        })
        return
      }
      if (!created) {
        sendJson(response, 400, { error: 'A client name is required' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'client_created', created.name)
      sendJson(response, 201, { client: created })
      return
    }

    if (normalizedPath === '/api/service-categories' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can manage board columns' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const category = await appDataStore.createServiceCategory(payload?.name)
      if (!category) {
        sendJson(response, 400, { error: 'A column name is required' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'service_category_created', category.name)
      sendJson(response, 201, { category })
      return
    }

    const serviceCategoryMatch = normalizedPath.match(/^\/api\/service-categories\/([^/]+)$/)
    if (serviceCategoryMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can manage board columns' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const categoryId = decodeURIComponent(serviceCategoryMatch[1])
      if (request.method === 'DELETE') {
        const removed = await appDataStore.deleteServiceCategory(categoryId)
        sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: 'Column not found' })
        return
      }
      if (!isJsonContentType(request)) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      const updated = await appDataStore.updateServiceCategory(categoryId, {
        name: payload?.name,
        sortOrder: payload?.sortOrder,
      })
      if (!updated) {
        sendJson(response, 400, { error: 'Nothing to update' })
        return
      }
      sendJson(response, 200, { category: updated })
      return
    }

    // Owner-only "Updates" tracker (Feature D). The same `feature_requests`
    // table backs the assistant's "send to Alex" flow; here the owner can list,
    // rank (drag), flag urgent, move through statuses, refine wording via the
    // AI, and copy a paste-ready block for Claude Code. All endpoints are
    // owner-only; writes are CSRF + content-type guarded (mirrors service
    // categories). Endpoint-managed (NOT the bulk /api/app-data write).
    if (normalizedPath === '/api/feature-requests' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const requests = await appDataStore.listFeatureRequests()
      sendJson(response, 200, { requests })
      return
    }

    if (normalizedPath === '/api/feature-requests' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const title = String(payload?.title ?? '').trim().slice(0, 120)
      const description = String(payload?.description ?? '').trim().slice(0, 2000)
      if (!title || !description) {
        sendJson(response, 400, { error: 'A title and description are required' })
        return
      }
      const record = await appDataStore.createFeatureRequest(session.user.id, title, description, {
        type: payload?.type,
        priority: payload?.priority,
        brainstorm: payload?.brainstorm === true,
      })
      await appDataStore.recordActivity(session.user.id, 'feature_request_created', title)
      const creatorName =
        (await appDataStore.getTeamMember(session.user.id))?.name ?? 'Someone'
      await notifyOwnersOfUpdateActivity(
        request,
        session,
        'update_created',
        `${creatorName} logged a new update: "${title}" (${updateStatusLabel(record?.status)}).`,
      )
      sendJson(response, 201, { request: record })
      return
    }

    const featureRequestReorderMatch = normalizedPath === '/api/feature-requests/reorder'
    if (featureRequestReorderMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const orderedIds = Array.isArray(payload?.orderedIds)
        ? payload.orderedIds.map((id) => String(id))
        : null
      if (!orderedIds) {
        sendJson(response, 400, { error: 'orderedIds must be an array' })
        return
      }
      await appDataStore.reorderFeatureRequests(orderedIds)
      const requests = await appDataStore.listFeatureRequests()
      sendJson(response, 200, { requests })
      return
    }

    const featureRequestRefineMatch = normalizedPath.match(
      /^\/api\/feature-requests\/([^/]+)\/refine$/,
    )
    if (featureRequestRefineMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const id = decodeURIComponent(featureRequestRefineMatch[1])
      const item = await appDataStore.getFeatureRequest(id)
      if (!item) {
        sendJson(response, 404, { error: 'Update not found' })
        return
      }
      try {
        const suggestion = await refineFeatureRequest(item)
        sendJson(response, 200, { suggestion })
      } catch (error) {
        const status = error?.statusCode ?? error?.status ?? 502
        console.error('[updates] refine failed:', error?.message || error)
        sendJson(response, status === 503 ? 503 : 502, {
          error: error?.message || 'The AI could not refine this right now. Please try again.',
        })
      }
      return
    }

    // GET /api/feature-requests/spitball/session — the owner's ACTIVE
    // brainstorm, so the modal shows the conversation exactly where she left it
    // no matter which window or device closed it. Creates nothing: `session` is
    // null until she actually says something. `pastSummaries` is what lets the
    // UI say the assistant remembers her earlier brainstorms. Declared before
    // the parameterized routes so the literal segment isn't read as an id.
    if (
      normalizedPath === '/api/feature-requests/spitball/session' &&
      request.method === 'GET'
    ) {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const active = await appDataStore.getActiveSpitballSession(session.user.id)
      const pastSummaries = await appDataStore.listSpitballSummaries(
        session.user.id,
        SPITBALL_CONTEXT_CAPS.pastSummaries,
      )
      sendJson(response, 200, {
        session: serializeSpitballSession(active),
        pastSummaries: pastSummaries.map((entry) => ({ id: entry.id, at: entry.at })),
      })
      return
    }

    // POST /api/feature-requests/spitball — ONE turn of the "Just spitballing"
    // thought-partner chat. Body { text }. The session is server-side, so this
    // takes her message, appends it, answers with the model, persists the
    // reply, and returns { reply, draft|null, sessionId }.
    //
    // Back-compat: a cached bundle may still POST the whole { messages } array.
    // Treat its last user message as the turn rather than 400-ing at her.
    if (normalizedPath === '/api/feature-requests/spitball' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const legacyTurn = Array.isArray(payload?.messages)
        ? [...payload.messages].reverse().find((m) => m?.role === 'user' && m?.text)?.text
        : ''
      const text = String(payload?.text ?? legacyTurn ?? '').trim().slice(0, 2000)
      if (!text) {
        sendJson(response, 400, { error: 'The conversation needs a user message to respond to.' })
        return
      }
      try {
        const active = await appDataStore.ensureActiveSpitballSession(session.user.id)
        const memory = await loadSpitballMemory(session.user.id)
        const history = [...active.messages, { role: 'user', text }]

        const result = await spitballChat(history, {
          summary: active.summary,
          pastSummaries: memory.pastSummaries,
          brainstormTitles: memory.brainstormTitles,
        })

        // Persist BOTH turns together, so the stored conversation can never end
        // on a user message the AI already answered.
        const updated = await appDataStore.appendSpitballTurn(active.id, [
          { role: 'user', text },
          { role: 'assistant', text: result.reply },
        ])

        // Compaction, not truncation: past the threshold the older turns are
        // folded into the session's running summary (which rides along in the
        // system prompt above) instead of being silently dropped.
        const plan = planSpitballCompaction(updated?.messages)
        if (plan.needed) {
          const summary = await summarizeSpitballSession(plan.older, {
            priorSummary: active.summary,
          })
          await appDataStore.compactSpitballSession(active.id, {
            summary,
            keepRecent: plan.keepRecent,
          })
        }

        sendJson(response, 200, { ...result, sessionId: active.id })
      } catch (error) {
        const status = error?.statusCode ?? error?.status ?? 502
        console.error('[updates] spitball failed:', error?.message || error)
        sendJson(response, status === 400 ? 400 : status === 503 ? 503 : 502, {
          error:
            error?.message ||
            'The AI is unavailable right now — your notes can still be saved as-is.',
        })
      }
      return
    }

    // POST /api/feature-requests/spitball/new — "Start fresh". Archives the
    // active session under a summary (so the next one can recall it) and hands
    // back an empty session. The summary call NEVER blocks: on a model failure
    // `summarizeSpitballSession` falls back to a truncated first message.
    if (normalizedPath === '/api/feature-requests/spitball/new' && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const active = await appDataStore.getActiveSpitballSession(session.user.id)
      if (active && active.messages.length > 0) {
        const summary = await summarizeSpitballSession(active.messages, {
          priorSummary: active.summary,
        })
        await appDataStore.archiveSpitballSession(active.id, summary)
      } else if (active) {
        // An untouched session has nothing to remember — reuse it as-is rather
        // than piling up empty archived rows.
        sendJson(response, 200, {
          session: serializeSpitballSession(active),
          pastSummaries: (
            await appDataStore.listSpitballSummaries(
              session.user.id,
              SPITBALL_CONTEXT_CAPS.pastSummaries,
            )
          ).map((entry) => ({ id: entry.id, at: entry.at })),
        })
        return
      }
      const fresh = await appDataStore.ensureActiveSpitballSession(session.user.id)
      const pastSummaries = await appDataStore.listSpitballSummaries(
        session.user.id,
        SPITBALL_CONTEXT_CAPS.pastSummaries,
      )
      sendJson(response, 200, {
        session: serializeSpitballSession(fresh),
        pastSummaries: pastSummaries.map((entry) => ({ id: entry.id, at: entry.at })),
      })
      return
    }

    // POST /api/feature-requests/:id/confirm-feedback — the owner's "Not
    // approved" reason is restated by the AI for HER confirmation before it's
    // filed (same guards + error contract as /refine). Body: { note }.
    const featureRequestConfirmMatch = normalizedPath.match(
      /^\/api\/feature-requests\/([^/]+)\/confirm-feedback$/,
    )
    if (featureRequestConfirmMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const id = decodeURIComponent(featureRequestConfirmMatch[1])
      const item = await appDataStore.getFeatureRequest(id)
      if (!item) {
        sendJson(response, 404, { error: 'Update not found' })
        return
      }
      const payload = await readJsonBody(request)
      const note = typeof payload?.note === 'string' ? payload.note.trim().slice(0, 2000) : ''
      if (!note) {
        sendJson(response, 400, { error: 'A rejection reason is required' })
        return
      }
      try {
        const result = await confirmOwnerFeedback(item, note)
        sendJson(response, 200, result)
      } catch (error) {
        const status = error?.statusCode ?? error?.status ?? 502
        console.error('[updates] confirm-feedback failed:', error?.message || error)
        sendJson(response, status === 503 ? 503 : 502, {
          error:
            error?.message || 'The AI could not review this feedback right now. Please try again.',
        })
      }
      return
    }

    const featureRequestMatch = normalizedPath.match(/^\/api\/feature-requests\/([^/]+)$/)
    if (featureRequestMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'The Updates tracker is owner-only' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const id = decodeURIComponent(featureRequestMatch[1])
      if (request.method === 'DELETE') {
        const removed = await appDataStore.deleteFeatureRequest(id)
        sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: 'Update not found' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const payload = await readJsonBody(request)
      // Snapshot the status BEFORE the write so we only notify on a real move
      // (a title tweak or a drag-reorder shouldn't email anyone).
      const priorStatus = (await appDataStore.getFeatureRequest(id))?.status ?? null
      const updated = await appDataStore.updateFeatureRequest(
        id,
        {
          title: payload?.title,
          description: payload?.description,
          type: payload?.type,
          status: payload?.status,
          priority: payload?.priority,
          priorityRank: payload?.priorityRank,
          devNotes: payload?.devNotes,
          reviewNote:
            typeof payload?.reviewNote === 'string'
              ? payload.reviewNote.trim().slice(0, 2000)
              : undefined,
          clarificationQuestion: payload?.clarificationQuestion,
          clarificationAnswer: payload?.clarificationAnswer,
        },
        session.user.id,
      )
      if (!updated) {
        sendJson(response, 400, { error: 'Nothing to update' })
        return
      }
      if (updated.status && priorStatus && updated.status !== priorStatus) {
        const actorName = (await appDataStore.getTeamMember(session.user.id))?.name ?? 'Someone'
        const note =
          typeof updated.reviewNote === 'string' && updated.reviewNote.trim()
            ? ` — "${updated.reviewNote.trim().slice(0, 160)}"`
            : ''
        await notifyOwnersOfUpdateActivity(
          request,
          session,
          'update_status_changed',
          `${actorName} moved "${updated.title}" from ${updateStatusLabel(priorStatus)} to ${updateStatusLabel(updated.status)}${note}.`,
        )
      }
      sendJson(response, 200, { request: updated })
      return
    }

    // Client notes: a timestamped, attributed, append-only log per client.
    // Visible to (and addable by) the owner AND a client's assigned staff —
    // endpoint-managed (NOT the owner-only bulk /api/app-data) so staff can
    // write notes. Access is gated by visibleClientIdSet, same as client recap.
    const clientNotesMatch = normalizedPath.match(/^\/api\/clients\/([^/]+)\/notes$/)
    if (clientNotesMatch && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const clientId = decodeURIComponent(clientNotesMatch[1])
      const data = await appDataStore.read()
      const allowed = visibleClientIdSet(session, data.clients ?? [])
      if (!allowed.has(clientId)) {
        sendJson(response, 403, { error: 'No access to that client' })
        return
      }
      const notes = await appDataStore.listClientNotes(clientId)
      sendJson(response, 200, { notes })
      return
    }

    if (clientNotesMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const clientId = decodeURIComponent(clientNotesMatch[1])
      const data = await appDataStore.read()
      const allowed = visibleClientIdSet(session, data.clients ?? [])
      if (!allowed.has(clientId)) {
        sendJson(response, 403, { error: 'No access to that client' })
        return
      }
      const payload = await readJsonBody(request)
      const body = String(payload?.body ?? '').trim()
      if (!body) {
        sendJson(response, 400, { error: 'A note body is required' })
        return
      }
      // Author name from the team roster (same lookup other handlers use), so
      // the note keeps a readable byline even if the user is later renamed.
      const member = await appDataStore.getTeamMember(session.user.id)
      const authorName = member?.name ?? session.user.name ?? null
      const note = await appDataStore.addClientNote(clientId, {
        authorId: session.user.id,
        authorName,
        body,
      })
      if (!note) {
        sendJson(response, 400, { error: 'A note body is required' })
        return
      }
      await appDataStore.recordActivity(session.user.id, 'client_note_added', clientId)
      sendJson(response, 201, { note })
      return
    }

    const clientNoteDeleteMatch = normalizedPath.match(
      /^\/api\/clients\/([^/]+)\/notes\/([^/]+)$/,
    )
    if (clientNoteDeleteMatch && request.method === 'DELETE') {
      const session = await requireSession(request, response)
      if (!session) return
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const noteId = decodeURIComponent(clientNoteDeleteMatch[2])
      const note = await appDataStore.getClientNote(noteId)
      if (!note) {
        sendJson(response, 404, { error: 'Note not found' })
        return
      }
      // Owner can delete any note; everyone else only their own.
      if (session.user.role !== 'owner' && note.authorId !== session.user.id) {
        sendJson(response, 403, { error: 'You can only delete your own notes' })
        return
      }
      const removed = await appDataStore.deleteClientNote(noteId)
      sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: 'Note not found' })
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
                // Case-insensitive: employee roles are display-cased
                // ('Owner'), but a stored 'owner' must map the same way or the
                // preview scopes an owner as staff (or vice-versa).
                role: String(target.role).toLowerCase() === 'owner' ? 'owner' : 'employee',
              },
            }
          }
        }
        // Staleness guard token. Computed AFTER read() so it reflects any
        // materializer write-back that read() just performed, and from the FULL
        // workspace rather than the scoped view — the fingerprint describes the
        // persisted state, not what this particular user is allowed to see.
        // Staff receive it too and simply never use it (PUT is owner-only).
        const workspaceVersion = await appDataStore.computeWorkspaceVersion()
        sendJson(response, 200, scopeAppDataForSession(scopingSession, data), {
          [WORKSPACE_VERSION_HEADER]: workspaceVersion,
        })
        return
      }

      if (request.method === 'PUT') {
        if (session.user.role !== 'owner') {
          sendJson(response, 403, { error: 'Only owners can update workspace configuration' })
          return
        }

        const data = await readJsonBody(request)

        // Wipe guard: write() wipes-and-reinserts every table from this
        // payload, so a structurally-empty body (a client glitch, or an
        // autosave that raced an unfinished load) would erase the whole
        // workspace. Refuse a payload that is missing `clients`, or that would
        // drop a populated workspace to zero clients. A brand-new firm (0
        // clients in the DB) can still legitimately save an empty list.
        if (!data || typeof data !== 'object' || !Array.isArray(data.clients)) {
          sendJson(response, 400, {
            error: 'bad_payload',
            message: 'Workspace update was malformed — nothing was saved.',
          })
          return
        }
        if (data.clients.length === 0 && (await appDataStore.clientCount()) > 0) {
          console.error(
            '[bulk-save] REFUSED empty-clients payload that would have wiped a populated workspace',
          )
          sendJson(response, 409, {
            error: 'refused_empty',
            message:
              'That update looked empty and would have erased your data, so it was not saved. Nothing changed — please reload and try again.',
          })
          return
        }

        // STALENESS GUARD. The bulk save wipes and re-inserts fifteen tables
        // from this payload, so a tab holding a snapshot from BEFORE some other
        // change erases everything that landed since — exactly how the Jan-May
        // historical import was wiped hours after it ran (HANDOFF §5).
        //
        // The tab echoes the fingerprint it was served on GET; `write()`
        // re-checks it inside its own transaction and refuses on mismatch.
        //
        // A MISSING token is refused too (fail closed). Tabs left open across
        // this deploy don't send one; they take a single 409 and reload, which
        // is the whole point — an old tab is precisely the dangerous case.
        const expectedVersion = String(request.headers[WORKSPACE_VERSION_HEADER] || '').trim()
        if (!expectedVersion) {
          console.warn('[bulk-save] REFUSED save with no workspace version (tab predates the guard)')
          sendJson(response, 409, {
            error: 'stale_workspace',
            message:
              'This tab has been open since before the last update, so it could not be saved safely. Please reload the page.',
          })
          return
        }

        try {
          await appDataStore.write(data, { expectedVersion })
        } catch (error) {
          if (error instanceof StaleWorkspaceError) {
            // Nothing was written — the transaction rolled back.
            console.warn(
              `[bulk-save] REFUSED stale save from ${session.user.id}: expected ${expectedVersion}, current ${error.currentVersion}`,
            )
            await appDataStore
              .recordActivity(
                session.user.id,
                'bulk_save_refused_stale',
                `expected ${expectedVersion}, current ${error.currentVersion}`,
              )
              .catch(() => {})
            sendJson(
              response,
              409,
              {
                error: 'stale_workspace',
                message:
                  'Someone else changed something while this tab was open, so your last change was not saved. Please reload to get the current data.',
              },
              { [WORKSPACE_VERSION_HEADER]: error.currentVersion },
            )
            return
          }
          // Log the full SQL/JS error server-side (visible in Railway logs);
          // return only a generic message so Postgres internals (schema,
          // constraint names, row data in `detail`) aren't leaked to clients.
          console.error('[bulk-save] write() failed:', error)
          sendJson(response, 500, {
            error: 'bulk_save_failed',
            message: 'Could not save changes — please try again.',
          })
          return
        }

        // The write changed the workspace, so the fingerprint moved. Hand the
        // new one back or the tab's very next save would 409 against itself.
        const nextVersion = await appDataStore.computeWorkspaceVersion()
        // Forensics for accepted saves goes to the SERVER LOG, deliberately not
        // to activity_log: that table is trimmed to the last 200 rows per user,
        // and the autosave fires on every debounced edit — logging each one
        // would evict a working session's real activity (and break the
        // productivity stats, which count `checklist_item_checked` from the
        // same table). Refusals DO go to activity_log below: they are rare and
        // always worth keeping.
        console.log(
          `[bulk-save] ${session.user.id} saved ${data.clients.length} clients, ${Array.isArray(data.timeEntries) ? data.timeEntries.length : 0} time entries (${expectedVersion} -> ${nextVersion})`,
        )
        sendJson(response, 200, { ok: true }, { [WORKSPACE_VERSION_HEADER]: nextVersion })
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
        sendJson(response, 500, { error: 'set_user_emails_failed' })
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
        sendJson(response, 500, { error: 'cleanup_failed' })
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

        // Administrative / internal time (company meetings, training, etc.) is
        // not tied to a client: no clientId, no task, never billable — the
        // employee just records hours + notes.
        const isAdministrative = Boolean(payload?.isAdministrative)
        const clientId = isAdministrative
          ? ''
          : typeof payload?.clientId === 'string'
            ? payload.clientId
            : ''
        const date = typeof payload?.date === 'string' ? payload.date : ''
        const minutes = typeof payload?.minutes === 'number' ? payload.minutes : Number(payload?.minutes)
        // Legacy "work type" — the UI no longer surfaces it. We keep the DB
        // column populated so the not-null constraint is satisfied.
        const category =
          typeof payload?.category === 'string' && payload.category.trim()
            ? payload.category
            : 'General'
        const description = typeof payload?.description === 'string' ? payload.description : ''
        const billable = isAdministrative ? false : Boolean(payload?.billable)
        const taskIdRaw = payload?.taskId
        const taskId = isAdministrative
          ? null
          : typeof taskIdRaw === 'string' && taskIdRaw.trim()
            ? taskIdRaw.trim()
            : null
        // Free-text task name — only kept when there's no checklist task and the
        // entry is client-bound (not admin). Length-capped.
        const taskLabel =
          !isAdministrative && !taskId && typeof payload?.taskLabel === 'string' && payload.taskLabel.trim()
            ? payload.taskLabel.trim().slice(0, 200)
            : undefined
        // Group-time tag: shared across the per-client entries created from one
        // "group" submission. Only meaningful for client-bound (non-admin) time.
        const groupId =
          !isAdministrative && typeof payload?.groupId === 'string' && payload.groupId.trim()
            ? payload.groupId.trim().slice(0, 64)
            : null
        // Unsplit group holding entry: the member clients were chosen up front
        // on the timer; the block is split across them for billing later. Such
        // an entry has NO single client (clientId empty) and is not billable
        // until split. `isGroupPending` relaxes the "client required" rule below.
        const groupClientIds =
          !isAdministrative && Array.isArray(payload?.groupClientIds)
            ? [...new Set(payload.groupClientIds.filter((id) => typeof id === 'string' && id))].slice(
                0,
                50,
              )
            : []
        const isGroupPending = !isAdministrative && !clientId && groupClientIds.length > 0
        // Audit timestamps: exact start/stop of the work, normalized to ISO.
        // Optional — invalid/absent values are simply dropped.
        const toIsoTimestamp = (value) => {
          if (typeof value !== 'string' || !value.trim()) return undefined
          const parsed = new Date(value)
          return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
        }
        const startAt = toIsoTimestamp(payload?.startAt)
        const endAt = toIsoTimestamp(payload?.endAt)

        // Capture method: anything other than an explicit 'manual' is a timer
        // entry. A manual entry must carry a non-empty reason; timer-stop and
        // any non-manual creation ignore manualReason entirely.
        const { entryMethod, manualReason, error: methodError } =
          normalizeTimeEntryMethod(payload)

        // Admin time needs no client; an unsplit group holding entry needs no
        // single client (it has members instead); every other entry does.
        if (
          !employeeId ||
          (!isAdministrative && !isGroupPending && !clientId) ||
          !date ||
          Number.isNaN(minutes) ||
          minutes <= 0
        ) {
          sendJson(response, 400, { error: 'Invalid time entry payload' })
          return
        }

        // Client + task + detail are MANDATORY to log time (the firm owner's
        // rule). One shared check with the Time page's inline prompts, so the
        // 400 and the field-level nudge can never disagree; group blocks and
        // administrative time carve out what they genuinely don't have. See
        // `validateTimeEntryRequiredFields`. This is a clean rejection — the UI
        // shows it under the field, not as a data-loss alarm.
        const requiredFields = validateTimeEntryRequiredFields({
          isAdministrative,
          clientId,
          groupClientIds,
          groupId,
          taskId,
          taskLabel,
          description,
        })
        if (requiredFields.error) {
          sendJson(response, 400, { error: requiredFields.error })
          return
        }

        if (methodError) {
          sendJson(response, 400, { error: methodError })
          return
        }

        if (startAt && endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
          sendJson(response, 400, { error: 'Stop time must be after the start time.' })
          return
        }

        // Work sessions. When the client sends them, they're authoritative for
        // minutes + the start/stop envelope. Otherwise, synthesize a single
        // session from the start/stop pair so every timed entry has one.
        const sessionsResult = normalizeWorkSessions(payload?.sessions)
        if (sessionsResult.error) {
          sendJson(response, 400, { error: sessionsResult.error })
          return
        }
        let finalSessions = sessionsResult.sessions
        let finalMinutes = minutes
        let finalStartAt = startAt
        let finalEndAt = endAt
        if (finalSessions && finalSessions.length > 0) {
          finalMinutes = sessionsResult.minutes
          finalStartAt = sessionsResult.startAt
          finalEndAt = sessionsResult.endAt
        } else if (startAt && endAt) {
          finalSessions = [{ startAt, endAt }]
        } else {
          finalSessions = []
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
        // they have visibility on. Administrative time has no client, so this
        // check is skipped for it.
        const allData = await appDataStore.read()

        // Weekly-submission gate: a non-owner must SUBMIT (or resubmit) a PRIOR
        // week that has logged time before logging time in a LATER week. A prior
        // week blocks when it's UN-SUBMITTED (no submission) or REJECTED (sent
        // back). A submitted/pending/approved week does NOT block — once it's
        // submitted it's out of staff's hands, so an awaiting-approval week never
        // locks them out of the timer. Backfilling a week that has already ended
        // never gates — only the current week or later. See `listBlockingWeeks`.
        if (session.user.role !== 'owner') {
          const entryWeekStart = weekStartOf(date)
          const priorWeeksWithTime = (allData.timeEntries ?? [])
            .filter((entry) => entry.employeeId === employeeId)
            .map((entry) => weekStartOf(entry.date))
          // Months the owner has LOCKED for this user: weeks inside a sealed
          // month never gate (locking auto-approves entries but leaves no weekly
          // submission row, which would otherwise look "un-submitted" forever).
          const lockedPeriods = new Set(
            (allData.timesheetLocks ?? [])
              .filter((lock) => lock.userId === employeeId)
              .map((lock) => lock.period),
          )
          const blockingWeeks = listBlockingWeeks(
            entryWeekStart,
            priorWeeksWithTime,
            (allData.weeklySubmissions ?? []).filter((entry) => entry.userId === employeeId),
            lockedPeriods,
            weekStartOf(todayIso()),
          )
          if (blockingWeeks.length > 0) {
            // Name EVERY blocking week so the bookkeeper submits them all in one
            // pass instead of hitting this gate once per skipped week. Single-
            // week wording is preserved for the common case; multi-week lists
            // them explicitly.
            const weeks = blockingWeeks.map((b) => b.weekStart)
            const joinWeeks = (arr) =>
              arr.length <= 1
                ? arr[0] ?? ''
                : arr.length === 2
                  ? `${arr[0]} and ${arr[1]}`
                  : `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`
            let error
            if (weeks.length === 1) {
              error =
                blockingWeeks[0].reason === 'rejected'
                  ? `Your timesheet for the week of ${weeks[0]} was sent back for changes. Fix and resubmit it before logging more time.`
                  : `You have an unsubmitted timesheet for the week of ${weeks[0]}. Submit that week before logging time for a later week.`
            } else {
              const anyRejected = blockingWeeks.some((b) => b.reason === 'rejected')
              error = `Before logging more time you need to submit ${anyRejected ? '(or resubmit) ' : ''}${weeks.length} earlier weeks that have logged time: ${joinWeeks(weeks)}. Open the Timesheet page, pick each week, and submit it.`
            }
            sendJson(response, 423, { error })
            return
          }
        }

        if (isGroupPending) {
          // Every member of a group holding entry must be visible to the user.
          const allowed = visibleClientIdSet(session, allData.clients ?? [])
          if (!groupClientIds.every((id) => allowed.has(id))) {
            sendJson(response, 403, { error: 'A group client is not visible to this user' })
            return
          }
        } else if (!isAdministrative) {
          const allowed = visibleClientIdSet(session, allData.clients ?? [])
          if (!allowed.has(clientId)) {
            sendJson(response, 403, { error: 'Client not visible to this user' })
            return
          }
        }

        // Validate taskId if provided: it must reference an existing
        // checklist for the same client. Client visibility was already
        // enforced above, so anyone who can log time for this client can log
        // against any of its tasks — matching the shared-client model where a
        // team member assigned to a client works the client's whole board.
        if (taskId) {
          const checklist = (allData.checklists ?? []).find((c) => c.id === taskId)
          if (!checklist || checklist.clientId !== clientId) {
            sendJson(response, 400, { error: 'Invalid taskId for this client' })
            return
          }
        }

        const entry = await appDataStore.createTimeEntry({
          employeeId,
          clientId,
          isAdministrative,
          date,
          minutes: finalMinutes,
          category,
          description,
          billable,
          taskId,
          entryMethod,
          manualReason: entryMethod === 'manual' ? manualReason : undefined,
          startAt: finalStartAt,
          endAt: finalEndAt,
          sessions: finalSessions,
          groupId,
          groupClientIds,
          taskLabel,
        })

        // Manual entries are deliberately gated: log the submission and ping
        // every owner so they know a non-timer entry is waiting for approval.
        // Timer-stopped entries enter the approval queue silently, as before.
        if (entryMethod === 'manual') {
          const client = (allData.clients ?? []).find((c) => c.id === clientId)
          const clientLabel = isAdministrative ? 'Administrative' : client?.name ?? 'a client'
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

    // Split a time entry into one billable entry per client. Defined before the
    // :id routes so the literal `/split` suffix isn't shadowed by the
    // parameterized matcher.
    //
    // TWO shapes of source entry land here:
    //   - an unsplit GROUP holding block — its `groupClientIds` ARE the allowed
    //     targets (chosen up front on the timer), and the body may not name
    //     others;
    //   - a REGULAR client-billed entry (a slice from an earlier split counts:
    //     its minutes are just minutes) — the body names the target clients in
    //     `clientIds`, and each one is checked against what this actor may bill
    //     with the same `visibleClientIdSet` rule the create endpoint uses.
    //
    // This replaces a client-side loop (N creates, then a delete) that was not
    // transactional: a failure part-way left the slices AND the holding entry
    // both counting toward totals, and the slices were built from scratch so
    // the block's clock-in/out was lost. The store now does the whole thing in
    // one unit of work and copies the sessions across.
    const splitMatch = normalizedPath.match(/^\/api\/time-entries\/([^/]+)\/split$/)
    if (splitMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      const entryId = splitMatch[1]
      const holding = await appDataStore.getTimeEntry(entryId)
      if (!holding) {
        sendJson(response, 404, { error: 'Time entry not found' })
        return
      }
      const memberIds = Array.isArray(holding.groupClientIds)
        ? holding.groupClientIds.filter((id) => typeof id === 'string' && id)
        : []
      const targetKind = classifySplitTarget(holding)
      if (targetKind === 'administrative') {
        sendJson(response, 400, {
          error: 'Administrative time has no client to split — assign a client first.',
        })
        return
      }
      if (targetKind === 'unsplittable') {
        sendJson(response, 409, {
          error: 'That entry is not an unsplit group time block — it may have been split already.',
        })
        return
      }
      const isHolding = targetKind === 'holding'

      const isOwner = session.user.role === 'owner'
      if (!isOwner && holding.employeeId !== session.user.id) {
        sendJson(response, 403, { error: 'You can only split your own time entries' })
        return
      }

      const payload = await readJsonBody(request)
      const mode =
        payload?.mode === 'even' || payload?.mode === 'full' || payload?.mode === 'custom'
          ? payload.mode
          : null
      if (!mode) {
        sendJson(response, 400, { error: 'mode must be one of: even, custom, full' })
        return
      }
      const rawCustom =
        payload?.customMinutes && typeof payload.customMinutes === 'object'
          ? payload.customMinutes
          : {}
      // Where the target clients come from: a holding block's members are fixed
      // (they were chosen on the timer), a regular entry's are named by the
      // caller. Same 50-client cap and de-duplication the create endpoint uses
      // for `groupClientIds`.
      const requestedClientIds = Array.isArray(payload?.clientIds)
        ? [...new Set(payload.clientIds.filter((id) => typeof id === 'string' && id))].slice(0, 50)
        : []
      const targetClientIds = isHolding ? memberIds : requestedClientIds

      // Splitting to ONE client is not this feature — that's just re-billing the
      // entry, which the edit form's client dropdown already does.
      if (!isHolding && targetClientIds.length < 2) {
        sendJson(response, 400, {
          error: "To move this time to one other client, just edit the entry's client.",
        })
        return
      }

      // Allocation clients must be EXACTLY the targets — a custom map may not
      // smuggle in a client that was never picked.
      const targetIdSet = new Set(targetClientIds)
      const strayClientId = Object.keys(rawCustom).find((id) => !targetIdSet.has(id))
      if (strayClientId) {
        sendJson(response, 400, {
          error: isHolding
            ? 'A client in this split is not part of the group block.'
            : 'A client in this split was not selected.',
        })
        return
      }

      const allData = await appDataStore.read()

      // Same visibility rule the group-CREATE path enforces: every target client
      // has to be one this user may bill (owners see them all). This is also
      // what keeps an unknown client id out — it can't be in the allowed set.
      const allowed = visibleClientIdSet(session, allData.clients ?? [])
      if (!targetClientIds.every((id) => allowed.has(id))) {
        sendJson(response, 403, {
          error: isHolding
            ? 'A group client is not visible to this user'
            : 'Client not visible to this user',
        })
        return
      }

      // Month-end lock + weekly-submission gate, mirroring the create endpoint
      // (owners are exempt from both there, so they are here too).
      if (!isOwner) {
        const period = String(holding.date).slice(0, 7)
        if (await appDataStore.isTimesheetLocked(holding.employeeId, period)) {
          sendJson(response, 423, {
            error: 'This timesheet month is locked. Contact an owner to make changes.',
          })
          return
        }
        const lockedPeriods = new Set(
          (allData.timesheetLocks ?? [])
            .filter((lock) => lock.userId === holding.employeeId)
            .map((lock) => lock.period),
        )
        const blockingWeeks = listBlockingWeeks(
          weekStartOf(holding.date),
          (allData.timeEntries ?? [])
            .filter((entry) => entry.employeeId === holding.employeeId)
            .map((entry) => weekStartOf(entry.date)),
          (allData.weeklySubmissions ?? []).filter(
            (entry) => entry.userId === holding.employeeId,
          ),
          lockedPeriods,
          weekStartOf(todayIso()),
        )
        if (blockingWeeks.length > 0) {
          sendJson(response, 423, {
            error: `You have an unsubmitted or sent-back timesheet for the week of ${blockingWeeks[0].weekStart}. Submit that week before splitting this block.`,
          })
          return
        }
      }

      // Allocate SERVER-side from the shared lib, so what the modal previewed
      // and what gets saved come out of the same function.
      const custom = {}
      for (const id of targetClientIds) custom[id] = Number(rawCustom[id])
      const allocation = allocateGroupMinutes(holding.minutes, targetClientIds, mode, custom)

      // Zero-minute clients are simply dropped (nobody is billed 0), but the
      // sum rule below still measures against the FULL block.
      const allocations = targetClientIds
        .map((clientId) => ({ clientId, minutes: allocation[clientId] ?? 0 }))
        .filter((row) => minutesToSeconds(row.minutes) > 0)

      if (allocations.length === 0) {
        sendJson(response, 400, {
          error:
            mode === 'custom'
              ? 'Enter minutes greater than 0 for at least one client.'
              : 'The tracked time is too short to split.',
        })
        return
      }

      // Re-check after the zero-minute drop: a custom split that gives one
      // selected client everything and the other 0 sums correctly but is still
      // a re-bill, not a split.
      if (!isHolding && allocations.length < 2) {
        sendJson(response, 400, {
          error: "To move this time to one other client, just edit the entry's client.",
        })
        return
      }

      // 'even' and 'custom' divide the block, so they must account for every
      // second of it. 'full' deliberately bills each client the whole block, so
      // its parts are meant to exceed the total.
      if (mode !== 'full') {
        const blockSeconds = minutesToSeconds(holding.minutes)
        const allocatedSeconds = allocations.reduce(
          (sum, row) => sum + minutesToSeconds(row.minutes),
          0,
        )
        if (allocatedSeconds !== blockSeconds) {
          const gap = blockSeconds - allocatedSeconds
          sendJson(response, 400, {
            error: `Allocations add up to ${formatDurationLabel(allocatedSeconds / 60)} but the block is ${formatDurationLabel(
              blockSeconds / 60,
            )} — ${formatDurationLabel(Math.abs(gap) / 60)} ${gap > 0 ? 'unassigned' : 'over'}.`,
          })
          return
        }
      }

      const groupId = `grp-${Math.random().toString(36).slice(2, 9)}`
      try {
        const result = await appDataStore.splitTimeEntry(
          entryId,
          allocations,
          session.user.id,
          groupId,
          mode,
        )
        sendJson(response, 200, result)
      } catch (error) {
        if (error instanceof TimeEntrySplitError) {
          // 404 gone · 400 the caller asked for something invalid · 409 the
          // entry changed kind under us (someone else split it first).
          const status =
            error.code === 'not_found'
              ? 404
              : error.code === 'not_splittable' || error.code === 'single_allocation'
                ? 400
                : 409
          sendJson(response, status, { error: error.message })
          return
        }
        console.error('[time-entry-split] failed:', error)
        sendJson(response, 500, { error: 'Could not split this time entry — please try again.' })
      }
      return
    }

    // Adjust an EXISTING split: replace the whole group with a new distribution,
    // keeping the same `groupId`. This is the way back into a split — before it,
    // a division was permanent unless every slice was deleted and re-entered
    // ("will not let me adjust my time entry without losing the client split I
    // chose"). The group is addressed by its group id rather than one slice
    // because the unit of work is the group: all of its rows go, all of the new
    // ones arrive, in one transaction.
    //
    // Same gates as splitting: your own time (or an owner's), only clients you
    // may bill, and the month lock + weekly-submission gate for non-owners. The
    // one rule that differs on purpose is the client count — see
    // `adjustSplitGroup` for why one client is legitimate here.
    const splitAdjustMatch = normalizedPath.match(
      /^\/api\/time-entries\/split-groups\/([^/]+)\/adjust$/,
    )
    if (splitAdjustMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      const groupId = decodeURIComponent(splitAdjustMatch[1])
      const allData = await appDataStore.read()
      // Every slice of a group belongs to one person, one date — the split
      // built them that way — so the first one answers every gate below.
      const slices = (allData.timeEntries ?? []).filter((entry) => entry.groupId === groupId)
      if (slices.length === 0) {
        sendJson(response, 404, { error: 'That split no longer exists.' })
        return
      }
      const first = slices[0]

      const isOwner = session.user.role === 'owner'
      if (!isOwner && first.employeeId !== session.user.id) {
        sendJson(response, 403, { error: 'You can only adjust your own time entries' })
        return
      }

      const payload = await readJsonBody(request)
      const mode =
        payload?.mode === 'even' || payload?.mode === 'full' || payload?.mode === 'custom'
          ? payload.mode
          : null
      if (!mode) {
        sendJson(response, 400, { error: 'mode must be one of: even, custom, full' })
        return
      }

      // The new distribution, as explicit per-client minutes. Unlike creating a
      // split there is no fixed block to check the parts against: the total is
      // allowed to change, because an adjustment is a correction of what gets
      // billed. `sessions` stay as the record of the clock time.
      const seen = new Set()
      const allocations = []
      for (const row of Array.isArray(payload?.allocations) ? payload.allocations : []) {
        const clientId = typeof row?.clientId === 'string' ? row.clientId.trim() : ''
        if (!clientId || seen.has(clientId)) continue
        const minutes = Number(row?.minutes)
        if (!Number.isFinite(minutes) || minutesToSeconds(minutes) <= 0) continue
        seen.add(clientId)
        allocations.push({ clientId, minutes })
        if (allocations.length >= 50) break
      }
      if (allocations.length === 0) {
        sendJson(response, 400, {
          error: 'Give at least one client more than 0 minutes.',
        })
        return
      }

      // Same visibility rule as splitting — an unknown client id can't be in the
      // allowed set, so this covers that too.
      const allowed = visibleClientIdSet(session, allData.clients ?? [])
      if (!allocations.every((row) => allowed.has(row.clientId))) {
        sendJson(response, 403, { error: 'Client not visible to this user' })
        return
      }

      // Month-end lock + weekly-submission gate, mirroring the split endpoint
      // (owners are exempt from both there, so they are here too).
      if (!isOwner) {
        const period = String(first.date).slice(0, 7)
        if (await appDataStore.isTimesheetLocked(first.employeeId, period)) {
          sendJson(response, 423, {
            error: 'This timesheet month is locked. Contact an owner to make changes.',
          })
          return
        }
        const lockedPeriods = new Set(
          (allData.timesheetLocks ?? [])
            .filter((lock) => lock.userId === first.employeeId)
            .map((lock) => lock.period),
        )
        const blockingWeeks = listBlockingWeeks(
          weekStartOf(first.date),
          (allData.timeEntries ?? [])
            .filter((entry) => entry.employeeId === first.employeeId)
            .map((entry) => weekStartOf(entry.date)),
          (allData.weeklySubmissions ?? []).filter((entry) => entry.userId === first.employeeId),
          lockedPeriods,
          weekStartOf(todayIso()),
        )
        if (blockingWeeks.length > 0) {
          sendJson(response, 423, {
            error: `You have an unsubmitted or sent-back timesheet for the week of ${blockingWeeks[0].weekStart}. Submit that week before adjusting this split.`,
          })
          return
        }
      }

      try {
        const result = await appDataStore.adjustSplitGroup(
          groupId,
          allocations,
          session.user.id,
          mode,
        )
        sendJson(response, 200, result)
      } catch (error) {
        if (error instanceof TimeEntrySplitError) {
          sendJson(response, error.code === 'not_found' ? 404 : 400, { error: error.message })
          return
        }
        console.error('[time-entry-split-adjust] failed:', error)
        sendJson(response, 500, { error: 'Could not adjust this split — please try again.' })
      }
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
        // Tell the bookkeeper their time was sent back. Without this the
        // rejection is SILENT — the only trace is a red note partway down their
        // Recent time list, and the weekly submission still reads "pending", so
        // they have no idea anything needs redoing.
        try {
          if (entry.employeeId && entry.employeeId !== session.user.id) {
            const reviewerName =
              (await appDataStore.getTeamMember(session.user.id))?.name ?? 'An owner'
            const hours = (Number(entry.minutes) / 60).toFixed(2)
            const scope = entry.isAdministrative || !entry.clientId ? 'Administrative' : null
            await notify(appDataStore, entry.employeeId, 'time_entry_rejected', {
              timeEntryId: entryId,
              clientId: entry.clientId || '',
              message: `${reviewerName} sent back your ${hours}h entry on ${entry.date}${
                scope ? ` (${scope})` : ''
              } — "${note}". Edit and resubmit it from the Time page.`,
              link: '/time',
              appPublicUrl: getPublicAppUrl(request),
            })
          }
        } catch (err) {
          console.error('[notify] time_entry_rejected dispatch failed:', err?.message || err)
        }
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
        // Non-owners may only edit entries for a client they currently have
        // visibility on (parity with the create path) — being un-assigned from
        // a client also removes the ability to mutate its time entries.
        // Administrative entries have no client, so the check is skipped.
        let scopeData = null
        if (!isOwner && entry.clientId) {
          scopeData = await appDataStore.read()
          if (!visibleClientIdSet(session, scopeData.clients ?? []).has(entry.clientId)) {
            sendJson(response, 403, { error: 'That client is not in your assigned list.' })
            return
          }
        }
        const payload = await readJsonBody(request)
        // An edit may not empty a required field that was filled in: blanking
        // the detail on an entry that had one is refused with the same message
        // the create path uses. Legacy rows saved before the rule (blank
        // description) stay fully editable — see `validateTimeEntryEdit`.
        const editFields = validateTimeEntryEdit(entry, payload)
        if (editFields.error) {
          sendJson(response, 400, { error: editFields.error })
          return
        }
        const patch = {}
        // A duration the user actually TYPED, as opposed to one derived from
        // the clock spans. Held separately because the sessions block below has
        // to know which of the two the caller meant — a typed duration is the
        // billed time and wins; see `minutesAfterEntryEdit`.
        let typedMinutes = null
        if (typeof payload?.minutes === 'number' || typeof payload?.minutes === 'string') {
          const m = Number(payload.minutes)
          if (Number.isNaN(m) || m <= 0) {
            sendJson(response, 400, { error: 'Invalid minutes' })
            return
          }
          // Snap to the nearest whole SECOND, not the nearest minute — an
          // entry's minutes can legitimately be fractional (seconds-exact
          // timer stops), and the column is numeric. Same rule the bulk save
          // applies, so a later autosave can't rewrite what we store here.
          patch.minutes = coerceEntryMinutes(m)
          typedMinutes = patch.minutes
        }
        if (typeof payload?.description === 'string') patch.description = payload.description
        if (typeof payload?.billable === 'boolean') patch.billable = payload.billable
        // Re-target the entry to a DIFFERENT client (or to administrative time).
        // Mirrors the create path: admin time carries no client/task and is never
        // billable; a non-owner may only move an entry onto a client they can see.
        let effectiveClientId = entry.clientId
        let effectiveIsAdmin = Boolean(entry.isAdministrative)
        const wantsAdmin = Object.prototype.hasOwnProperty.call(payload ?? {}, 'isAdministrative')
        const wantsClient = Object.prototype.hasOwnProperty.call(payload ?? {}, 'clientId')
        if (wantsAdmin || wantsClient) {
          effectiveIsAdmin = wantsAdmin ? Boolean(payload.isAdministrative) : effectiveIsAdmin
          if (effectiveIsAdmin) {
            patch.isAdministrative = true
            patch.clientId = ''
            patch.taskId = null
            patch.billable = false
            effectiveClientId = ''
          } else {
            const nextClientId =
              wantsClient && typeof payload.clientId === 'string'
                ? payload.clientId.trim()
                : entry.clientId
            if (!nextClientId) {
              sendJson(response, 400, {
                error: 'Pick a client, or mark the entry as administrative.',
              })
              return
            }
            scopeData = scopeData ?? (await appDataStore.read())
            if (!(scopeData.clients ?? []).some((c) => c.id === nextClientId)) {
              sendJson(response, 400, { error: 'Unknown client.' })
              return
            }
            if (!isOwner && !visibleClientIdSet(session, scopeData.clients ?? []).has(nextClientId)) {
              sendJson(response, 403, { error: 'That client is not in your assigned list.' })
              return
            }
            patch.clientId = nextClientId
            patch.isAdministrative = false
            effectiveClientId = nextClientId
          }
        }
        if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'taskId')) {
          patch.taskId =
            effectiveIsAdmin || !(typeof payload.taskId === 'string' && payload.taskId.trim())
              ? null
              : payload.taskId.trim()
          // A re-targeted task must belong to the entry's client AFTER this patch
          // (parity with the create path, which validates taskId->client). Without
          // this a caller could attach an entry to any checklist id firm-wide.
          if (patch.taskId) {
            scopeData = scopeData ?? (await appDataStore.read())
            const checklist = (scopeData.checklists ?? []).find((c) => c.id === patch.taskId)
            if (!checklist || checklist.clientId !== effectiveClientId) {
              sendJson(response, 400, {
                error: 'That task does not belong to this entry’s client.',
              })
              return
            }
          }
        } else if (patch.clientId !== undefined && patch.clientId !== entry.clientId) {
          // Client changed without an explicit task: whatever task was attached
          // belongs to the OLD client, so drop it rather than leave it mismatched.
          patch.taskId = null
        }
        if (typeof payload?.date === 'string' && payload.date) patch.date = payload.date
        // Reassign to another team member — owner only. Validate the target is
        // an active user so the user_id FK can never break.
        if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'employeeId')) {
          if (!isOwner) {
            sendJson(response, 403, { error: 'Only owners can reassign time entries.' })
            return
          }
          const targetId = typeof payload.employeeId === 'string' ? payload.employeeId.trim() : ''
          const reassignData = await appDataStore.read()
          const validTarget = (reassignData.employees ?? []).some((e) => e.id === targetId)
          if (!validTarget) {
            sendJson(response, 400, { error: 'Invalid employee for reassignment.' })
            return
          }
          patch.employeeId = targetId
        }
        // Audit timestamps — accept exact start/stop edits (normalized to ISO).
        const toIsoTimestamp = (value) => {
          if (typeof value !== 'string' || !value.trim()) return null
          const parsed = new Date(value)
          return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
        }
        if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'startAt')) {
          patch.startAt = toIsoTimestamp(payload.startAt)
        }
        if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'endAt')) {
          patch.endAt = toIsoTimestamp(payload.endAt)
        }
        if (
          patch.startAt &&
          patch.endAt &&
          new Date(patch.endAt).getTime() <= new Date(patch.startAt).getTime()
        ) {
          sendJson(response, 400, { error: 'Stop time must be after the start time.' })
          return
        }
        // Sessions carry WHEN the work happened; `minutes` is what gets BILLED.
        // Sending sessions rewrites the spans and the start/stop envelope, and
        // — unless the caller also typed a duration — the billed minutes follow
        // them. A typed duration is the deliberate statement of what to bill, so
        // it wins and the spans stay verbatim as the audit trail. See
        // `minutesAfterEntryEdit` for the full rule (including why a split slice
        // moves by the session DELTA rather than being recomputed outright).
        // Keeping the entry pending for re-approval is handled below.
        if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'sessions')) {
          const sessionsResult = normalizeWorkSessions(payload.sessions)
          if (sessionsResult.error) {
            sendJson(response, 400, { error: sessionsResult.error })
            return
          }
          patch.sessions = sessionsResult.sessions
          patch.startAt = sessionsResult.startAt ?? null
          patch.endAt = sessionsResult.endAt ?? null
          patch.minutes = coerceEntryMinutes(
            minutesAfterEntryEdit({
              typedMinutes,
              sessionsMinutes: sessionsResult.minutes,
              isSlice: Boolean(entry.groupId),
              currentMinutes: entry.minutes,
              previousSessions: entry.sessions?.length
                ? entry.sessions
                : entry.startAt && entry.endAt
                  ? [{ startAt: entry.startAt, endAt: entry.endAt }]
                  : [],
              nextSessions: sessionsResult.sessions,
            }),
          )
        }

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

        // Editing resubmits the entry for approval: a rejected entry flips back
        // to pending, and so does an already-APPROVED one — an approved entry
        // that gets changed (different client, time, date…) has to be re-approved
        // rather than silently keeping its old sign-off. No-op patches are left
        // alone so a save with nothing changed can't churn the approval queue.
        if (
          (entry.approvalStatus === 'rejected' || entry.approvalStatus === 'approved') &&
          Object.keys(patch).length > 0
        ) {
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
        // Same client-visibility gate as edit: a non-owner can't delete an
        // entry for a client they're no longer assigned to (admin entries have
        // no client and are exempt).
        if (!isOwner && entry.clientId) {
          const delScopeData = await appDataStore.read()
          if (!visibleClientIdSet(session, delScopeData.clients ?? []).has(entry.clientId)) {
            sendJson(response, 403, { error: 'That client is not in your assigned list.' })
            return
          }
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
        // Month-end sign-off is only for a month that has ALREADY ENDED. Locking
        // the current (in-progress) or a future month would seal it and block
        // everyone from tracking time in it — the outage this guards against.
        const currentMonth = new Date().toISOString().slice(0, 7)
        if (period >= currentMonth) {
          sendJson(response, 400, {
            error:
              'You can only lock a month that has already ended. The current (or a future) month can’t be locked — that would block everyone from tracking time in it.',
          })
          return
        }
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

    // Owner-only REOPEN of an approved weekly submission — the reverse of
    // approve. Un-seals the week (submission → pending, entries → pending) so it
    // can be edited and re-reviewed.
    const weeklyReopenMatch = normalizedPath.match(
      /^\/api\/timesheets\/weekly-submissions\/([^/]+)\/reopen$/,
    )
    if (weeklyReopenMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can reopen weekly timesheets' })
        return
      }
      const submission = await appDataStore.reopenWeeklySubmission(weeklyReopenMatch[1])
      if (!submission) {
        sendJson(response, 404, { error: 'No approved submission with that id' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'weekly_timesheet_reopened',
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
        const payload = await readJsonBody(request)
        const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
        const clientId = typeof payload?.clientId === 'string' ? payload.clientId : ''
        const assigneeId = typeof payload?.assigneeId === 'string' ? payload.assigneeId : ''
        const dueDate = typeof payload?.dueDate === 'string' ? payload.dueDate : ''
        const categoryId =
          typeof payload?.categoryId === 'string' && payload.categoryId ? payload.categoryId : null
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

        // Non-owners may create checklists only for clients they're assigned to
        // (owners can create for anyone). Mirrors the item-edit scoping.
        if (
          session.user.role !== 'owner' &&
          !visibleClientIdSet(session, data.clients ?? []).has(clientId)
        ) {
          sendJson(response, 403, {
            error: 'You can only create checklists for your assigned clients',
          })
          return
        }

        const checklist = await appDataStore.createChecklist({
          title,
          clientId,
          assigneeId,
          dueDate,
          categoryId,
          items,
          // Stamp the creator for task-edit approval routing. System-created
          // instances (recurring / template / onboarding) go through other
          // paths and leave this null, routing their edits to the owner.
          createdBy: session.user.id,
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

    // POST /api/checklists/:id/deletion/(approve|reject) — owner-only.
    // Approve = soft-delete to the bin; reject = clear the staff request.
    // Checked BEFORE the generic `:id` matcher below so the more-specific
    // path isn't poached by the DELETE handler.
    const checklistDeletionDecisionMatch = normalizedPath.match(
      /^\/api\/checklists\/([^/]+)\/deletion\/(approve|reject)$/,
    )
    if (checklistDeletionDecisionMatch) {
      const session = await requireSession(request, response)
      if (!session) {
        return
      }

      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }

      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can resolve deletion requests' })
        return
      }

      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const checklistId = checklistDeletionDecisionMatch[1]
      const decision = checklistDeletionDecisionMatch[2]
      const existing = await appDataStore.read()
      const target = existing.checklists.find((entry) => entry.id === checklistId)
      if (!target) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      if (decision === 'approve') {
        const removed = await appDataStore.deleteChecklist(checklistId)
        if (!removed) {
          sendJson(response, 404, { error: 'Checklist not found' })
          return
        }
        await appDataStore.recordActivity(session.user.id, 'checklist_deleted', target.title)
        sendJson(response, 200, { ok: true, removed: checklistId })
        return
      }

      // reject
      const cleared = await appDataStore.clearChecklistDeletionRequest(checklistId)
      if (!cleared) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'checklist_deletion_rejected',
        target.title,
      )
      sendJson(response, 200, cleared)
      return
    }

    // GET /api/checklists/item-deletions — list pending item-deletion requests.
    // Owners see all; a non-owner sees only requests for clients in their
    // visible set (so they can show "Deletion requested" badges). Checked
    // BEFORE the generic `:id` matcher so it isn't poached.
    if (normalizedPath === '/api/checklists/item-deletions' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const all = await appDataStore.listItemDeletionRequests()
      if (session.user.role === 'owner') {
        sendJson(response, 200, { requests: all })
        return
      }
      const data = await appDataStore.read()
      const visible = visibleClientIdSet(session, data.clients ?? [])
      sendJson(response, 200, {
        requests: all.filter((req) => visible.has(req.clientId)),
      })
      return
    }

    // GET /api/waiting-on-me — every pending structured blocker where the caller
    // is the person being waited on. Any authed user; returns just the minimal
    // step context so a blocker sees what they're holding up (even across client
    // scope). Its own path, checked before the generic `:id` matcher.
    if (normalizedPath === '/api/waiting-on-me' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const items = await appDataStore.listWaitingOnMe(session.user.id)
      sendJson(response, 200, { items })
      return
    }

    // POST /api/checklists/item-deletions/:requestId/(approve|reject) — owner-only.
    // approve = execute the real delete by the stored path, then drop the
    // request; reject = drop the request only. Returns the updated checklist
    // (approve) or { ok } (reject).
    const itemDeletionDecisionMatch = normalizedPath.match(
      /^\/api\/checklists\/item-deletions\/([^/]+)\/(approve|reject)$/,
    )
    if (itemDeletionDecisionMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can resolve deletion requests' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const requestId = decodeURIComponent(itemDeletionDecisionMatch[1])
      const decision = itemDeletionDecisionMatch[2]
      const req = await appDataStore.getItemDeletionRequest(requestId)
      if (!req) {
        sendJson(response, 404, { error: 'Deletion request not found' })
        return
      }

      if (decision === 'reject') {
        await appDataStore.deleteItemDeletionRequest(requestId)
        sendJson(response, 200, { ok: true, removed: requestId })
        return
      }

      // approve → execute the real delete by the stored path.
      let updated = null
      if (req.subSubItemId) {
        updated = await appDataStore.removeChecklistSubSubItem(
          req.checklistId,
          req.itemId,
          req.subItemId,
          req.subSubItemId,
        )
      } else if (req.subItemId) {
        updated = await appDataStore.removeChecklistSubItem(
          req.checklistId,
          req.itemId,
          req.subItemId,
        )
      } else {
        updated = await appDataStore.deleteChecklistItem(req.checklistId, req.itemId)
      }
      // Drop the request regardless — if the target is already gone the request
      // is stale and should not linger.
      await appDataStore.deleteItemDeletionRequest(requestId)
      if (!updated) {
        sendJson(response, 404, { error: 'Target item no longer exists' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'checklist_item_removed',
        `${updated.title}: ${req.label}`,
      )
      sendJson(response, 200, updated)
      return
    }

    // GET /api/checklists/pending-edits — the approver queue. Owners see all
    // pending edits; a non-owner sees only edits routed to them. Checked BEFORE
    // the generic `:id` matcher so "pending-edits" isn't treated as an id.
    if (normalizedPath === '/api/checklists/pending-edits' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const edits = await appDataStore.listPendingTaskEdits(session)
      sendJson(response, 200, { edits })
      return
    }

    // POST /api/checklists/pending-edits/:id/(approve|reject) — allowed for the
    // request's approver OR the owner. Approve applies `proposed` to the task /
    // item / appends a step, drops the request, records activity, and notifies
    // the editor. Reject drops the request and notifies the editor. Returns the
    // updated checklist (approve) or { ok } (reject).
    const pendingEditDecisionMatch = normalizedPath.match(
      /^\/api\/checklists\/pending-edits\/([^/]+)\/(approve|reject)$/,
    )
    if (pendingEditDecisionMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const editId = decodeURIComponent(pendingEditDecisionMatch[1])
      const decision = pendingEditDecisionMatch[2]
      const edit = await appDataStore.getPendingTaskEdit(editId)
      if (!edit) {
        sendJson(response, 404, { error: 'Pending edit not found' })
        return
      }
      // Only the routed approver or the owner may resolve it.
      if (session.user.role !== 'owner' && edit.approverId !== session.user.id) {
        sendJson(response, 403, { error: 'You cannot resolve this edit' })
        return
      }

      const data = await appDataStore.read()
      const checklist = data.checklists.find((c) => c.id === edit.checklistId)
      const editorName =
        (data.employees ?? []).find((e) => e.id === edit.requestedBy)?.name ??
        edit.requestedByName ??
        'A team member'
      const checklistTitle = checklist?.title ?? 'a task'

      if (decision === 'reject') {
        await appDataStore.deletePendingTaskEdit(editId)
        await appDataStore.recordActivity(
          session.user.id,
          'task_edit_rejected',
          `${checklistTitle}: ${edit.summary}`,
        )
        try {
          if (edit.requestedBy && edit.requestedBy !== session.user.id) {
            await notify(appDataStore, edit.requestedBy, 'task_edit_rejected', {
              checklistId: edit.checklistId,
              message: `Your edit to "${checklistTitle}" was declined (${edit.summary}).`,
              link: '/checklists',
              appPublicUrl: getPublicAppUrl(request),
            })
          }
        } catch (err) {
          console.error('[notify] task_edit_rejected dispatch failed:', err?.message || err)
        }
        sendJson(response, 200, { ok: true, removed: editId })
        return
      }

      // approve → apply the proposed edit by scope.
      if (!checklist) {
        // Target task is gone; drop the stale request.
        await appDataStore.deletePendingTaskEdit(editId)
        sendJson(response, 404, { error: 'Target task no longer exists' })
        return
      }
      const proposed = edit.proposed ?? {}
      let updated = null
      if (edit.scope === 'details') {
        updated = await appDataStore.updateChecklistMeta(edit.checklistId, {
          ...('title' in proposed ? { title: proposed.title } : {}),
          ...('dueDate' in proposed ? { dueDate: proposed.dueDate } : {}),
          ...('assigneeId' in proposed ? { assigneeId: proposed.assigneeId } : {}),
          ...('categoryId' in proposed ? { categoryId: proposed.categoryId } : {}),
        })
      } else if (edit.scope === 'add_item') {
        const label = String(proposed.title ?? proposed.label ?? '').trim()
        if (label) {
          updated = await appDataStore.appendChecklistItems(edit.checklistId, [label])
        }
      } else if (edit.scope === 'item' && edit.itemId) {
        const patch = {}
        if ('title' in proposed) patch.title = proposed.title
        if ('dueDate' in proposed) patch.dueDate = proposed.dueDate
        if ('assigneeId' in proposed) patch.assigneeId = proposed.assigneeId
        updated = await appDataStore.updateChecklistItem(edit.checklistId, edit.itemId, patch)
      }
      // Drop the request regardless — applied or not, it's resolved.
      await appDataStore.deletePendingTaskEdit(editId)
      if (!updated) {
        sendJson(response, 404, { error: 'Could not apply the edit' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'task_edit_approved',
        `${updated.title}: ${edit.summary}`,
      )
      try {
        if (edit.requestedBy && edit.requestedBy !== session.user.id) {
          await notify(appDataStore, edit.requestedBy, 'task_edit_approved', {
            checklistId: edit.checklistId,
            message: `Your edit to "${updated.title}" was approved (${edit.summary}).`,
            link: '/checklists',
            appPublicUrl: getPublicAppUrl(request),
          })
        }
      } catch (err) {
        console.error('[notify] task_edit_approved dispatch failed:', err?.message || err)
      }
      sendJson(response, 200, updated)
      return
    }

    // PATCH /api/checklists/:id — edit task DETAILS (title / due date /
    // assignee). Authorized like the item endpoints (owner / assignee / editor /
    // client-visible). Owner + the task's own creator apply directly; every
    // other authorized editor's change is ROUTED as a pending edit to the
    // approver. Handled before the DELETE `:id` block below (same matcher).
    const checklistMetaPatchMatch = normalizedPath.match(/^\/api\/checklists\/([^/]+)$/)
    if (checklistMetaPatchMatch && request.method === 'PATCH') {
      const session = await requireSession(request, response)
      if (!session) return
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const checklistId = checklistMetaPatchMatch[1]
      const data = await appDataStore.read()
      const checklist = data.checklists.find((c) => c.id === checklistId)
      if (!checklist) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      // Authorization mirrors the item endpoints: owner / assignee / editor.
      // Sharing the client is READ scope only — see checklist-write-permission.
      const metaDenial = checklistWriteDenial({
        user: session.user,
        checklist,
        visibleClientIds: visibleClientIdSet(session, data.clients ?? []),
        error: 'You do not have permission to edit this task',
      })
      if (metaDenial) {
        sendJson(response, metaDenial.status, { error: metaDenial.error })
        return
      }

      const payload = await readJsonBody(request)
      const proposed = {}
      const prev = {}
      if ('title' in payload && typeof payload.title === 'string') {
        const trimmed = payload.title.trim()
        if (!trimmed) {
          sendJson(response, 400, { error: 'title cannot be blank' })
          return
        }
        proposed.title = trimmed
        prev.title = checklist.title
      }
      if ('dueDate' in payload) {
        proposed.dueDate = payload.dueDate === null ? '' : String(payload.dueDate ?? '')
        prev.dueDate = checklist.dueDate
      }
      if ('assigneeId' in payload) {
        const incoming = payload.assigneeId === null ? '' : String(payload.assigneeId ?? '')
        if (incoming && !data.employees.some((e) => e.id === incoming)) {
          sendJson(response, 400, { error: 'Invalid assigneeId' })
          return
        }
        proposed.assigneeId = incoming
        prev.assigneeId = checklist.assigneeId
      }
      // Board column (service category). Empty/null = Uncategorized, which is a
      // valid target (this is how an uncategorized checklist is re-tagged so it
      // moves to the right column). A non-empty id must be a real category.
      if ('categoryId' in payload) {
        const incoming =
          payload.categoryId === null || payload.categoryId === ''
            ? null
            : String(payload.categoryId)
        if (incoming) {
          const categories = await appDataStore.listServiceCategories()
          if (!categories.some((c) => c.id === incoming)) {
            sendJson(response, 400, { error: 'Invalid categoryId' })
            return
          }
        }
        proposed.categoryId = incoming
        prev.categoryId = checklist.categoryId ?? null
      }
      if (Object.keys(proposed).length === 0) {
        sendJson(response, 400, { error: 'No editable fields provided' })
        return
      }

      // Edits apply directly for anyone authorized to edit this task — only
      // DELETES route to the owner for approval. (The permission gate above
      // still decides who may edit at all.)
      const updated = await appDataStore.updateChecklistMeta(checklistId, proposed)
      if (!updated) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }
      // A non-owner assignee change should keep client visibility coherent.
      if (proposed.assigneeId) {
        await appDataStore.grantClientVisibility(updated.clientId, proposed.assigneeId)
      }
      await appDataStore.recordActivity(session.user.id, 'checklist_edited', updated.title)
      sendJson(response, 200, { checklist: updated })
      return
    }

    // DELETE /api/checklists/:id — soft delete (move to bin) for owners, or a
    // deletion REQUEST for an authorized non-owner. The matcher's trailing `$`
    // keeps it from poaching the more-specific /items/... routes below; those
    // still resolve to their own handlers.
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

      const checklistId = checklistDeleteMatch[1]
      // Capture the title for the activity log before the row is gone.
      const existing = await appDataStore.read()
      const target = existing.checklists.find((entry) => entry.id === checklistId)
      if (!target) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      // Non-owner path: only a user who can EDIT the checklist (its client is
      // in their visible set AND they're the assignee or an editor) may request
      // deletion. Mirror the PATCH-item authorization. Everyone else → 403.
      if (session.user.role !== 'owner') {
        const visible = visibleClientIdSet(session, existing.clients ?? [])
        const editorIds = Array.isArray(target.editorIds) ? target.editorIds : []
        const canRequest =
          visible.has(target.clientId) &&
          (target.assigneeId === session.user.id || editorIds.includes(session.user.id))
        if (!canRequest) {
          sendJson(response, 403, { error: 'You can only request deletion of your assigned checklists' })
          return
        }

        const requested = await appDataStore.requestChecklistDeletion(checklistId, session.user.id)
        if (!requested) {
          sendJson(response, 404, { error: 'Checklist not found' })
          return
        }

        await appDataStore.recordActivity(
          session.user.id,
          'checklist_deletion_requested',
          target.title,
        )

        // Notify every owner that a deletion was requested.
        try {
          const requesterName =
            (existing.employees ?? []).find((e) => e.id === session.user.id)?.name ??
            session.user.name ??
            'A team member'
          const members = await appDataStore.getTeamMembers()
          const owners = members.filter((member) => member.role === 'owner')
          for (const owner of owners) {
            await notify(appDataStore, owner.id, 'checklist_deletion_requested', {
              checklistId,
              message: `${requesterName} requested deletion of "${target.title}".`,
              link: '/checklists',
              appPublicUrl: getPublicAppUrl(request),
            })
          }
        } catch (err) {
          console.error('[notify] checklist_deletion_requested dispatch failed:', err?.message || err)
        }

        sendJson(response, 200, requested)
        return
      }

      // Owner path: immediate soft-delete to the bin (existing behavior).
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

      const targetItem = checklist.items.find((item) => item.id === itemId)
      if (!targetItem) {
        sendJson(response, 404, { error: 'Checklist item not found' })
        return
      }

      // Completing work is PERSONAL: only the person a step is assigned to may
      // check it off — its own assignee when set, otherwise the checklist's
      // assignee — plus the owner as an override. Being assigned to the client
      // is enough to see and edit the checklist, but NOT to tick off someone
      // else's task (sub-steps inherit their parent item's responsible person).
      const responsibleId =
        (typeof targetItem.assigneeId === 'string' && targetItem.assigneeId) ||
        checklist.assigneeId ||
        ''
      const canEdit =
        session.user.role === 'owner' || (!!responsibleId && responsibleId === session.user.id)

      if (!canEdit) {
        sendJson(response, 403, {
          error: 'Only the person this step is assigned to can check it off.',
        })
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

      // "Waiting on a task" notifications: if this toggle just COMPLETED the
      // whole checklist, notify the assignee of any step elsewhere that was
      // flagged waiting on it (so they know they're unblocked).
      const justCompleted =
        updatedChecklist.items.length > 0 && updatedChecklist.items.every((entry) => entry.done)
      if (justCompleted) {
        const allData = await appDataStore.read()
        const notified = new Set()
        for (const other of allData.checklists ?? []) {
          if (other.id === updatedChecklist.id || other.deletedAt) continue
          const fallbackAssignee = other.assigneeId
          const waiters = []
          for (const item of other.items ?? []) {
            if (item.waiting && !item.done && item.waitingForChecklistId === updatedChecklist.id) {
              waiters.push({ label: item.label, assigneeId: item.assigneeId || fallbackAssignee })
            }
            for (const sub of item.subItems ?? []) {
              if (
                sub.waiting &&
                !sub.done &&
                sub.waitingForChecklistId === updatedChecklist.id
              ) {
                waiters.push({
                  label: `${item.label} › ${sub.title}`,
                  assigneeId: item.assigneeId || fallbackAssignee,
                })
              }
            }
          }
          for (const waiter of waiters) {
            if (!waiter.assigneeId || waiter.assigneeId === session.user.id) continue
            const key = `${waiter.assigneeId}:${other.id}:${waiter.label}`
            if (notified.has(key)) continue
            notified.add(key)
            await notify(appDataStore, waiter.assigneeId, 'waiting_cleared', {
              checklistId: other.id,
              message: `Ready to continue: “${waiter.label}” was waiting on “${updatedChecklist.title}”, now done.`,
              link: `/checklists?focus=${other.id}`,
              appPublicUrl: getPublicAppUrl(request),
            })
          }
        }
      }

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

      // Owner / the task's assignee / an editor / the step's own assignee.
      // Sharing the client is NOT enough — that's read scope.
      const nestedDenial = checklistWriteDenial({
        user: session.user,
        checklist,
        item: targetItem,
        visibleClientIds: visibleClientIdSet(session, data.clients ?? []),
        error: 'You can only update your assigned checklists',
      })
      if (nestedDenial) {
        sendJson(response, nestedDenial.status, { error: nestedDenial.error })
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
      // Owner deletes immediately; an authorized non-owner files a deletion
      // REQUEST (nothing removed until an owner approves).
      if (subSubItemId && request.method === 'DELETE') {
        const targetSubSub = Array.isArray(targetSub?.subItems)
          ? targetSub.subItems.find((s) => s.id === subSubItemId)
          : undefined
        if (!targetSubSub) {
          sendJson(response, 404, { error: 'Sub-sub-item not found' })
          return
        }

        if (session.user.role !== 'owner') {
          const filed = await fileItemDeletionRequest(request, session, data, checklist, {
            itemId,
            subItemId,
            subSubItemId,
            label: targetSubSub.title ?? '',
          })
          sendJson(response, 200, { request: filed, checklist })
          return
        }

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

      // Owner / the task's assignee / an editor / the step's own assignee.
      // Sharing the client is NOT enough — that's read scope.
      const nestedDenial = checklistWriteDenial({
        user: session.user,
        checklist,
        item: targetItem,
        visibleClientIds: visibleClientIdSet(session, data.clients ?? []),
        error: 'You can only update your assigned checklists',
      })
      if (nestedDenial) {
        sendJson(response, nestedDenial.status, { error: nestedDenial.error })
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
      // Owner deletes immediately; an authorized non-owner files a deletion
      // REQUEST (nothing removed until an owner approves).
      if (subItemId && request.method === 'DELETE') {
        const targetSub = Array.isArray(targetItem.subItems)
          ? targetItem.subItems.find((sub) => sub.id === subItemId)
          : undefined
        if (!targetSub) {
          sendJson(response, 404, { error: 'Sub-item not found' })
          return
        }

        if (session.user.role !== 'owner') {
          const filed = await fileItemDeletionRequest(request, session, data, checklist, {
            itemId,
            subItemId,
            subSubItemId: null,
            label: targetSub.title ?? '',
          })
          sendJson(response, 200, { request: filed, checklist })
          return
        }

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

      // --- PATCH: update a sub-item's "waiting on" flag + note ---
      if (subItemId && request.method === 'PATCH') {
        const payload = await readJsonBody(request)
        const patch = {}
        if ('waiting' in (payload ?? {})) patch.waiting = Boolean(payload.waiting)
        if ('waitingOn' in (payload ?? {})) {
          patch.waitingOn = payload.waitingOn === null ? '' : String(payload.waitingOn ?? '')
        }
        if ('waitingForChecklistId' in (payload ?? {})) {
          patch.waitingForChecklistId =
            payload.waitingForChecklistId === null
              ? ''
              : String(payload.waitingForChecklistId ?? '')
        }
        const updated = await appDataStore.updateChecklistSubItem(
          checklistId,
          itemId,
          subItemId,
          patch,
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

      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    // --- Structured "waiting on a person" blockers ---
    // These routes MUST be matched BEFORE the generic
    // `/api/checklists/:id/items/...` matchers below so they aren't shadowed.

    // POST /api/checklists/:id/waiting-ons/:waitingOnId/(done|cancel|verify)
    //
    // The two-stage hand-off (see lib/waiting-on-state.js):
    //   done   — the blocker reports their part finished. Marks the record
    //            resolved; does NOT delete it, because the record is what keeps
    //            the name of whoever did the check.
    //   verify — the requester confirms and retires the wait. Also keeps it.
    //   cancel — unchanged: removes the row outright.
    const waitingOnActionMatch = normalizedPath.match(
      /^\/api\/checklists\/([^/]+)\/waiting-ons\/([^/]+)\/(done|cancel|verify)$/,
    )
    if (waitingOnActionMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const checklistId = waitingOnActionMatch[1]
      const waitingOnId = decodeURIComponent(waitingOnActionMatch[2])
      const action = waitingOnActionMatch[3]

      const existing = await appDataStore.getWaitingOn(checklistId, waitingOnId)
      if (!existing) {
        sendJson(response, 404, { error: 'Waiting-on request not found' })
        return
      }
      const entry = existing.entry
      const isOwner = session.user.role === 'owner'

      const permissionArgs = {
        entry,
        userId: session.user.id,
        isOwner,
        assigneeId: existing.assigneeId ?? null,
      }
      // A client wait has no second party to hand back to, so its Done goes
      // straight through both stages in one click.
      const clientWait = isClientWait(entry)

      if (action === 'done') {
        if (!canMarkWaitingOnDone(permissionArgs)) {
          sendJson(response, waitingOnStage(entry) === 'waiting' ? 403 : 409, {
            error:
              waitingOnStage(entry) === 'waiting'
                ? clientWait
                  ? 'Only the person who flagged this (or the step owner) can clear a client wait'
                  : 'Only the person being waited on can mark this done'
                : 'This wait has already been marked done',
          })
          return
        }
      } else if (action === 'verify') {
        if (!canVerifyWaitingOn(permissionArgs)) {
          sendJson(response, waitingOnStage(entry) === 'resolved' ? 403 : 409, {
            error:
              waitingOnStage(entry) === 'waiting'
                ? // You cannot confirm work the other person has not reported
                  // finished. Cancel is still available if you want out.
                  'Nobody has marked this done yet — cancel it instead if you no longer need it'
                : waitingOnStage(entry) === 'verified'
                  ? 'This wait is already closed out'
                  : 'You cannot confirm this waiting-on request',
          })
          return
        }
      } else {
        // Cancel: the flagger, the step assignee, or an owner.
        const isAssignee = existing.assigneeId && existing.assigneeId === session.user.id
        if (entry.requestedBy !== session.user.id && !isAssignee && !isOwner) {
          sendJson(response, 403, { error: 'You cannot cancel this waiting-on request' })
          return
        }
      }

      const resolved =
        action === 'done'
          ? await appDataStore.markWaitingOnDone(checklistId, waitingOnId, {
              userId: session.user.id,
              alsoVerify: clientWait,
            })
          : action === 'verify'
            ? await appDataStore.markWaitingOnVerified(checklistId, waitingOnId, {
                userId: session.user.id,
              })
            : await appDataStore.resolveWaitingOn(checklistId, waitingOnId)
      if (!resolved) {
        sendJson(response, 404, { error: 'Waiting-on request not found' })
        return
      }

      const data = await appDataStore.read()
      const checklist = data.checklists.find((c) => c.id === checklistId)
      const checklistTitle = checklist?.title ?? 'a task'
      const employees = data.employees ?? []
      const nameOf = (id) => employees.find((e) => e.id === id)?.name ?? 'A team member'

      try {
        if (action === 'done') {
          // A client wait names the CLIENT, not a teammate — blockerId points at
          // the checklist's client, so resolving it against employees would
          // print "A team member" for the very thing she wants named.
          const blockerName = isClientWait(resolved.entry)
            ? (data.clients ?? []).find((c) => c.id === resolved.entry.blockerId)?.name ??
              'The client'
            : nameOf(resolved.entry.blockerId)
          const message = `${blockerName} finished what you needed on "${resolved.label}" — you can continue`
          // Notify BOTH the step assignee AND the flagger; dedupe; skip the actor.
          // On a client wait the actor is usually the flagger, so this often
          // ends up notifying nobody — correct, there is no one to tell.
          const recipients = new Set()
          if (resolved.assigneeId) recipients.add(resolved.assigneeId)
          if (resolved.entry.requestedBy) recipients.add(resolved.entry.requestedBy)
          recipients.delete(session.user.id)
          for (const recipientId of recipients) {
            await notify(appDataStore, recipientId, 'waiting_on_done', {
              checklistId,
              message,
              link: `/checklists?focus=${encodeURIComponent(checklistId)}`,
              appPublicUrl: getPublicAppUrl(request),
            })
          }
          await appDataStore.recordActivity(
            session.user.id,
            'waiting_on_done',
            `${checklistTitle}: ${resolved.label}`,
          )
        } else if (action === 'verify') {
          // No notification: the person confirming is the one who was waiting,
          // and her step 4 asks only that it check off and leave the list.
          await appDataStore.recordActivity(
            session.user.id,
            'waiting_on_verified',
            `${checklistTitle}: ${resolved.label}`,
          )
        } else {
          const cancellerName = nameOf(session.user.id)
          await notify(appDataStore, resolved.entry.blockerId, 'waiting_on_cancelled', {
            checklistId,
            message: `${cancellerName} no longer needs you on "${resolved.label}" in "${checklistTitle}"`,
            link: `/checklists?focus=${encodeURIComponent(checklistId)}`,
            appPublicUrl: getPublicAppUrl(request),
          })
          await appDataStore.recordActivity(
            session.user.id,
            'waiting_on_cancelled',
            `${checklistTitle}: ${resolved.label}`,
          )
        }
      } catch (err) {
        console.error(`[notify] waiting_on_${action} dispatch failed:`, err?.message || err)
      }

      sendJson(response, 200, { checklist: resolved.checklist })
      return
    }

    // POST /api/checklists/:id/waiting-ons — flag a step as waiting on a person.
    const waitingOnCollectionMatch = normalizedPath.match(
      /^\/api\/checklists\/([^/]+)\/waiting-ons$/,
    )
    if (waitingOnCollectionMatch) {
      const session = await requireSession(request, response)
      if (!session) return
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }

      const checklistId = waitingOnCollectionMatch[1]
      const data = await appDataStore.read()
      const checklist = data.checklists.find((c) => c.id === checklistId)
      if (!checklist) {
        sendJson(response, 404, { error: 'Checklist not found' })
        return
      }

      // Auth mirrors the item PATCH: owner / assignee / editor.
      const waitDenial = checklistWriteDenial({
        user: session.user,
        checklist,
        visibleClientIds: visibleClientIdSet(session, data.clients ?? []),
        error: 'You do not have permission to flag this step',
      })
      if (waitDenial) {
        sendJson(response, waitDenial.status, { error: waitDenial.error })
        return
      }

      const payload = await readJsonBody(request)
      const itemId = typeof payload?.itemId === 'string' ? payload.itemId : ''
      const subItemId = typeof payload?.subItemId === 'string' ? payload.subItemId : null
      const subSubItemId =
        typeof payload?.subSubItemId === 'string' ? payload.subSubItemId : null
      const blockerId = typeof payload?.blockerId === 'string' ? payload.blockerId : ''
      const note = typeof payload?.note === 'string' ? payload.note : undefined
      if (!itemId) {
        sendJson(response, 400, { error: 'itemId is required' })
        return
      }
      // Waiting on THE CLIENT rather than a teammate. Which client is never
      // asked for — the checklist already belongs to one, so it is filled in
      // here. That keeps `blockerId` populated (the normalizer drops entries
      // without one) and leaves nothing for the caller to get wrong.
      const isClientRequest = payload?.blockerType === 'client'
      const employees = data.employees ?? []
      const effectiveBlockerId = isClientRequest ? checklist.clientId : blockerId
      if (isClientRequest) {
        if (!checklist.clientId) {
          sendJson(response, 400, {
            error: 'This task has no client, so it cannot be marked as waiting on one',
          })
          return
        }
      } else if (!blockerId || !employees.some((e) => e.id === blockerId)) {
        sendJson(response, 400, { error: 'blockerId must be a valid employee' })
        return
      }

      const result = await appDataStore.addWaitingOn(
        checklistId,
        { itemId, subItemId, subSubItemId },
        {
          blockerId: effectiveBlockerId,
          requestedBy: session.user.id,
          note,
          blockerType: isClientRequest ? 'client' : 'employee',
        },
      )
      if (!result) {
        sendJson(response, 404, { error: 'Step not found' })
        return
      }

      const flaggerName =
        employees.find((e) => e.id === session.user.id)?.name ?? session.user.name ?? 'A team member'
      // A client has no login, so there is nobody to notify — the wait simply
      // sits with whoever flagged it until they clear it.
      if (!isClientRequest) {
        try {
          await notify(appDataStore, blockerId, 'waiting_on_requested', {
            checklistId,
            message: `${flaggerName} is waiting on you: "${result.node.label}" in "${checklist.title}"`,
            link: `/checklists?focus=${encodeURIComponent(checklistId)}`,
            appPublicUrl: getPublicAppUrl(request),
          })
        } catch (err) {
          console.error('[notify] waiting_on_requested dispatch failed:', err?.message || err)
        }
      }
      await appDataStore.recordActivity(
        session.user.id,
        'waiting_on_requested',
        `${checklist.title}: ${result.node.label}`,
      )

      sendJson(response, 200, { checklist: result.checklist })
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

      const reorderDenial = checklistWriteDenial({
        user: session.user,
        checklist,
        visibleClientIds: visibleClientIdSet(session, data.clients ?? []),
        error: 'You do not have permission to reorder items',
      })
      if (reorderDenial) {
        sendJson(response, reorderDenial.status, { error: reorderDenial.error })
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

      // Owner / the task's assignee / an editor. Sharing the client is read
      // scope, not write access — see lib/checklist-write-permission.js.
      const visibleClientIds = visibleClientIdSet(session, data.clients ?? [])

      // --- POST /api/checklists/:id/items (bulk append) ---
      if (!itemId && request.method === 'POST') {
        const appendDenial = checklistWriteDenial({
          user: session.user,
          checklist,
          visibleClientIds,
          error: 'You do not have permission to add items',
        })
        if (appendDenial) {
          sendJson(response, appendDenial.status, { error: appendDenial.error })
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

        // Adding a step never needs approval — anyone authorized to edit this
        // task appends directly. Only DELETES route to the owner.
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

        // The step's own assignee also gets edit access on that step.
        const itemDenial = checklistWriteDenial({
          user: session.user,
          checklist,
          item: targetItem,
          visibleClientIds,
          error: 'You do not have permission to edit this item',
        })
        if (itemDenial) {
          sendJson(response, itemDenial.status, { error: itemDenial.error })
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

        if ('waitingOn' in payload) {
          // null or empty string clears the "waiting on" note.
          patch.waitingOn = payload.waitingOn === null ? '' : String(payload.waitingOn ?? '')
        }

        if ('waiting' in payload) {
          // The "waiting on" toggle — flags the item as blocked/delayed.
          patch.waiting = Boolean(payload.waiting)
        }

        if ('waitingForChecklistId' in payload) {
          // The checklist this step is waiting on (null/empty clears it).
          patch.waitingForChecklistId =
            payload.waitingForChecklistId === null
              ? ''
              : String(payload.waitingForChecklistId ?? '')
        }

        // Step edits (rename / due date / assignee) apply directly for anyone
        // authorized to edit this task — approval is reserved for DELETES. The
        // "waiting" flag + note were always direct (they're work, like
        // completing a step) and stay that way.

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
      // Owner deletes immediately; an authorized non-owner files a deletion
      // REQUEST (nothing removed until an owner approves). Anyone without
      // access to the client → 403.
      if (itemId && request.method === 'DELETE') {
        const targetItem = checklist.items.find((item) => item.id === itemId)
        if (!targetItem) {
          sendJson(response, 404, { error: 'Checklist item not found' })
          return
        }

        const deleteDenial = checklistWriteDenial({
          user: session.user,
          checklist,
          item: targetItem,
          visibleClientIds,
          error: 'You do not have permission to delete this item',
        })
        if (deleteDenial) {
          sendJson(response, deleteDenial.status, { error: deleteDenial.error })
          return
        }

        if (session.user.role !== 'owner') {
          const filed = await fileItemDeletionRequest(request, session, data, checklist, {
            itemId,
            subItemId: null,
            subSubItemId: null,
            label: targetItem.label ?? '',
          })
          sendJson(response, 200, { request: filed, checklist })
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
    // assigned-team list. Validates each id is a real employee; owners may be
    // on the list (it grants them nothing — they see every client already).
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

    // Owner-only: set/clear a team member's cost rate (assistant Phase 4
    // analytics). Informational — never affects invoices. costRate null clears.
    if (normalizedPath === '/api/team/cost-rate' && request.method === 'PUT') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can set cost rates' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const userId = String(payload?.userId ?? '')
      if (!userId) {
        sendJson(response, 400, { error: 'userId is required' })
        return
      }
      const raw = payload?.costRate
      if (raw !== null && raw !== '' && !(Number.isFinite(Number(raw)) && Number(raw) >= 0)) {
        sendJson(response, 400, { error: 'costRate must be a non-negative number or null' })
        return
      }
      const costRate = await appDataStore.setEmployeeCostRate(userId, raw === '' ? null : raw)
      sendJson(response, 200, { ok: true, userId, costRate })
      return
    }

    // Owner-only: set/clear a team member's BILL rate ($/hour charged to
    // clients for this person's time). Unlike cost rate this DOES feed
    // invoices. billRate null clears.
    if (normalizedPath === '/api/team/bill-rate' && request.method === 'PUT') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can set bill rates' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const userId = String(payload?.userId ?? '')
      if (!userId) {
        sendJson(response, 400, { error: 'userId is required' })
        return
      }
      const raw = payload?.billRate
      if (raw !== null && raw !== '' && !(Number.isFinite(Number(raw)) && Number(raw) >= 0)) {
        sendJson(response, 400, { error: 'billRate must be a non-negative number or null' })
        return
      }
      const billRate = await appDataStore.setEmployeeBillRate(userId, raw === '' ? null : raw)
      sendJson(response, 200, { ok: true, userId, billRate })
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
      const limit = Math.min(Math.max(1, Number(requestUrl.searchParams.get('limit')) || 15), 500)
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
      const limit = Math.min(Math.max(1, Number(requestUrl.searchParams.get('limit')) || 2000), 5000)
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
      const limit = Math.min(Math.max(1, Number(requestUrl.searchParams.get('limit')) || 20), 500)
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
          // Return 404 (not 403) so a non-owner can't distinguish "no such
          // case" from "exists but not yours" and enumerate firm-wide case ids.
          sendJson(response, 404, { error: 'Case not found' })
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

    // Append steps to a recurring template's stage — the "add to all future"
    // half of adding a task to a live recurring checklist. Deliberately NOT
    // owner-only: a team member assigned to the template's client may append
    // (never edit/remove) steps, so the person doing the work can keep the
    // recipe current. Standard (client-agnostic) blueprints stay owner-only.
    const templateStageAppendMatch = normalizedPath.match(
      /^\/api\/checklist-templates\/([^/]+)\/stages\/([^/]+)\/items$/,
    )
    if (templateStageAppendMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      const templateId = templateStageAppendMatch[1]
      const stageId = templateStageAppendMatch[2]
      const data = await appDataStore.read()
      const template = (data.checklistTemplates ?? []).find((item) => item.id === templateId)
      if (!template) {
        sendJson(response, 404, { error: 'Template not found' })
        return
      }
      if (session.user.role !== 'owner') {
        if (template.isStandard || !template.clientId) {
          sendJson(response, 403, { error: 'Only owners can edit standard templates' })
          return
        }
        if (!visibleClientIdSet(session, data.clients ?? []).has(template.clientId)) {
          sendJson(response, 403, { error: 'That client is not in your assigned list.' })
          return
        }
      }
      const payload = await readJsonBody(request)
      const titles = Array.isArray(payload?.titles)
        ? payload.titles.filter((t) => typeof t === 'string' && t.trim())
        : []
      if (titles.length === 0) {
        sendJson(response, 400, { error: 'titles must be a non-empty array of strings' })
        return
      }
      const created = await appDataStore.appendChecklistTemplateStageItems(
        templateId,
        stageId,
        titles,
      )
      if (created === null) {
        sendJson(response, 404, { error: 'Template stage not found' })
        return
      }
      for (const item of created) {
        await appDataStore.recordActivity(
          session.user.id,
          'template_item_added',
          `${template.title}: ${item.label}`,
        )
      }
      sendJson(response, 200, { items: created })
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
    // template. Body: { clientId, firstDueDate?, frequency? }.
    //
    // Owners may apply ANY template to ANY client. ACCOUNTANTS
    // (`senior_bookkeeper`) may apply a STANDARD blueprint to a client they are
    // assigned to — they could already see the blueprint library read-only and
    // were told to "ask an owner"; this lets them do it themselves. Bookkeepers
    // are unchanged and still ask.
    //
    // The two extra restrictions on non-owners are deliberate and enforced HERE,
    // not in the UI: a standard blueprint carries no other client's data, and the
    // target must be a client they are actually assigned to — otherwise this
    // endpoint would be a way to write into a client they cannot even see.
    const applyToClientMatch = normalizedPath.match(
      /^\/api\/checklist-templates\/([^/]+)\/apply-to-client$/,
    )
    if (applyToClientMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      const roleDenial = templateApplyRoleDenial(session.user)
      if (roleDenial) {
        sendJson(response, roleDenial.status, { error: roleDenial.error })
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
      // Standard blueprints only, and only onto a client they are assigned to.
      // Scoped with the same visibility rule the rest of the app uses, so this
      // endpoint cannot become a side door into a client they cannot see.
      const scopeDenial = templateApplyScopeDenial({
        user: session.user,
        template: source,
        clientId,
        visibleClientIds: visibleClientIdSet(session, data.clients ?? []),
      })
      if (scopeDenial) {
        sendJson(response, scopeDenial.status, { error: scopeDenial.error })
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
      // Owners can generate any template; a non-owner can generate a recurring
      // task for a client they're assigned to — so staff can "get ahead" and
      // log time against an upcoming task before its instance exists.
      if (session.user.role !== 'owner') {
        const allowedClients = visibleClientIdSet(session, data.clients ?? [])
        if (!template.clientId || !allowedClients.has(template.clientId)) {
          sendJson(response, 403, {
            error: 'You can only generate tasks for your assigned clients',
          })
          return
        }
      }
      const checklist = await appDataStore.generateChecklistFromTemplate(templateId, { dueDate })
      if (!checklist) {
        sendJson(response, 400, {
          error: 'This template has no stages to generate from',
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

    // POST /api/clients/:id/start-onboarding — owner-only: open a client's
    // 3-stage onboarding case (Proposal → Onboarding → Client) and move the
    // client to 'proposal'. Mirrors the checklist-create endpoints' guards
    // (owner gate + CSRF + content-type). Idempotent: a 409 if the client
    // already has an onboarding case.
    const startOnboardingMatch = normalizedPath.match(
      /^\/api\/clients\/([^/]+)\/start-onboarding$/,
    )
    if (startOnboardingMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can start onboarding' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      // Body is unused (the action is parameterless), but read+discard it so
      // the request stream is drained consistently with other POSTs.
      await readJsonBody(request)
      const clientId = decodeURIComponent(startOnboardingMatch[1])
      const result = await appDataStore.startOnboarding(clientId)
      if (!result) {
        sendJson(response, 409, {
          error: 'Client not found, or onboarding already started',
        })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        'onboarding_started',
        result.client?.name ?? clientId,
      )
      if (result.checklist?.assigneeId && result.checklist.assigneeId !== session.user.id) {
        await notify(appDataStore, result.checklist.assigneeId, 'task_assigned', {
          checklistId: result.checklist.id,
          message: `New task: ${result.checklist.title}`,
          link: `/checklists?focus=${result.checklist.id}`,
          appPublicUrl: getPublicAppUrl(request),
        })
      }
      sendJson(response, 201, result)
      return
    }

    // POST /api/clients/:id/lifecycle-stage — owner-only: retire a client
    // ("Mark inactive") or bring them back ("Reactivate"). Body: { stage }.
    //
    // A dedicated endpoint rather than the bulk app-data save because this is
    // an ACTION, not an edit: it has to land in the activity log so "who
    // retired this client, and when?" is answerable, and the bulk autosave is
    // a whole-workspace overwrite with no notion of individual intent.
    // Deliberately narrow — it sets the one flag and touches nothing else, so
    // Reactivate restores the client exactly as they were.
    const lifecycleStageMatch = normalizedPath.match(
      /^\/api\/clients\/([^/]+)\/lifecycle-stage$/,
    )
    if (lifecycleStageMatch && request.method === 'POST') {
      const session = await requireSession(request, response)
      if (!session) return
      if (session.user.role !== 'owner') {
        sendJson(response, 403, { error: 'Only owners can change a client’s stage' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      const body = (await readJsonBody(request)) ?? {}
      const stage = String(body.stage ?? '')
      // Only the two retirement transitions go through here. Proposal /
      // onboarding stages belong to the onboarding case and its dropdown, and
      // letting this endpoint set them would give the sync two masters.
      if (stage !== 'inactive' && stage !== 'active') {
        sendJson(response, 400, { error: 'stage must be "inactive" or "active"' })
        return
      }
      const clientId = decodeURIComponent(lifecycleStageMatch[1])
      const updated = await appDataStore.setClientLifecycleStage(clientId, stage)
      if (!updated) {
        sendJson(response, 404, { error: 'Client not found' })
        return
      }
      await appDataStore.recordActivity(
        session.user.id,
        stage === 'inactive' ? 'client_marked_inactive' : 'client_reactivated',
        updated.name ?? clientId,
      )
      sendJson(response, 200, { client: updated })
      return
    }

    // ---- Phase 5: notifications API ----
    if (normalizedPath === '/api/notifications' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const unreadOnly = requestUrl.searchParams.get('unreadOnly') === 'true'
      const limit = Math.min(Math.max(1, Number(requestUrl.searchParams.get('limit')) || 50), 500)
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

    // Per-user EMAIL notification preferences. Any signed-in user manages
    // their own; the catalog of toggle types is served alongside so the UI
    // and the notify() gate share one source of truth (lib/notification-prefs.js).
    if (normalizedPath === '/api/me/notification-prefs' && request.method === 'GET') {
      const session = await requireSession(request, response)
      if (!session) return
      const member = await appDataStore.getTeamMember(session.user.id)
      sendJson(response, 200, {
        types: EMAIL_PREF_TYPES.map(({ key, label, description }) => ({ key, label, description })),
        prefs: sanitizeEmailPrefs(member?.emailNotificationPrefs),
      })
      return
    }

    if (normalizedPath === '/api/me/notification-prefs' && request.method === 'PUT') {
      const session = await requireSession(request, response)
      if (!session) return
      const contentType = String(request.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'application/json required' })
        return
      }
      if (isCrossSiteOrigin(request)) {
        sendJson(response, 403, { error: 'Origin not allowed' })
        return
      }
      const payload = await readJsonBody(request)
      const clean = sanitizeEmailPrefs(payload?.prefs)
      const stored = await appDataStore.setEmailNotificationPrefs(session.user.id, clean)
      if (stored === null) {
        sendJson(response, 404, { error: 'User not found' })
        return
      }
      sendJson(response, 200, { prefs: stored })
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
      let qrDataUrl = ''
      try {
        qrSvg = await QRCode.toString(otpauthUri, { type: 'svg', margin: 1, width: 220 })
        qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 220 })
      } catch (error) {
        console.error('[totp] QR render failed:', error?.message || error)
      }
      sendJson(response, 200, {
        secret: secret.base32,
        otpauthUri,
        qrSvg,
        qrDataUrl,
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

// ---- Weekly digest scheduler (assistant Phase 3) ----
// Deterministic (no model call): on the configured weekday, email the owner
// the top automation opportunities from detectUsagePatterns, once per ISO
// week. A per-user marker (assistant_digest_state) prevents a second send if
// the process restarts. No-op unless Resend is configured; opt out with
// ASSISTANT_DIGEST=off. The weekday is ASSISTANT_DIGEST_DOW (0=Sun..6=Sat,
// default 1=Mon).
const DIGEST_WEEKDAY = Number.isFinite(Number(process.env.ASSISTANT_DIGEST_DOW))
  ? Math.max(0, Math.min(6, Number(process.env.ASSISTANT_DIGEST_DOW)))
  : 1
async function maybeSendWeeklyDigest() {
  try {
    if (String(process.env.ASSISTANT_DIGEST || '').toLowerCase() === 'off') return
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return
    const now = new Date()
    if (now.getDay() !== DIGEST_WEEKDAY) return
    const weekKey = weekStartOf(now.toISOString().slice(0, 10))
    const members = await appDataStore.getTeamMembers()
    const owner = members.find((member) => member.role === 'owner')
    if (!owner?.email) return
    if ((await appDataStore.getLastDigestWeek(owner.id)) === weekKey) return
    const suggestions = detectUsagePatterns(await appDataStore.read()).slice(0, 3)
    if (suggestions.length === 0) return // retry next tick; only mark once actually sent
    const firm = await appDataStore.getFirmSettings().catch(() => null)
    const sent = await sendDigestEmail({
      to: owner.email,
      firmName: firm?.firmName,
      suggestions,
      appBaseUrl: process.env.APP_PUBLIC_URL,
    })
    if (sent) {
      await appDataStore.markDigestSent(owner.id, weekKey)
      console.log(`[assistant] weekly digest sent to owner (${suggestions.length} items)`)
    }
  } catch (error) {
    console.error('[assistant] weekly digest error:', error?.message || error)
  }
}
// Check hourly; the per-week marker keeps it to one send. First check shortly
// after boot so a restart on digest day still delivers.
const digestTimer = setInterval(maybeSendWeeklyDigest, 60 * 60 * 1000)
digestTimer.unref?.()
setTimeout(() => void maybeSendWeeklyDigest(), 30 * 1000).unref?.()
